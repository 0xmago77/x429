// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {X429Queue} from "../src/X429Queue.sol";

// =====================================================================================================
//                                          helper contracts
// =====================================================================================================

/// @dev Owns tickets but rejects every plain native transfer (refunds and payouts to it fail).
contract EthRejecter {
    X429Queue internal immutable queue;

    constructor(X429Queue queue_) {
        queue = queue_;
    }

    receive() external payable {
        revert("EthRejecter: no native transfers");
    }

    function join(uint32 queueId, uint128 price) external returns (uint64) {
        return queue.join(queueId, price);
    }

    function joinAndOvertake(uint32 queueId, uint128 price, uint32 maxPositions)
        external
        payable
        returns (uint64, uint32, uint256)
    {
        return queue.joinAndOvertake{value: msg.value}(queueId, price, maxPositions);
    }

    function overtake(uint64 ticketId, uint32 maxPositions) external payable returns (uint32, uint256) {
        return queue.overtake{value: msg.value}(ticketId, maxPositions);
    }

    function withdraw() external returns (uint256) {
        return queue.withdraw();
    }
}

/// @dev Receiver that re-enters the queue from `receive()` (once) and either swallows or bubbles the
///      inner failure.
contract ReentrantReceiver {
    enum Attack {
        None,
        Withdraw,
        WithdrawFor,
        Overtake
    }

    X429Queue internal immutable queue;
    Attack public attack;
    bool public bubble;
    uint64 public ticketId;
    uint256 public receiveCount;
    bool public innerOk;
    bytes public innerRevertData;

    constructor(X429Queue queue_) {
        queue = queue_;
    }

    function configure(Attack attack_, bool bubble_) external {
        attack = attack_;
        bubble = bubble_;
    }

    function join(uint32 queueId, uint128 price) external returns (uint64 id) {
        id = queue.join(queueId, price);
        ticketId = id;
    }

    function overtake(uint64 id, uint32 maxPositions) external payable returns (uint32, uint256) {
        return queue.overtake{value: msg.value}(id, maxPositions);
    }

    function withdraw() external returns (uint256) {
        return queue.withdraw();
    }

    receive() external payable {
        ++receiveCount;
        if (attack == Attack.None || receiveCount > 1) return;
        bytes memory data;
        if (attack == Attack.Withdraw) data = abi.encodeCall(X429Queue.withdraw, ());
        else if (attack == Attack.WithdrawFor) data = abi.encodeCall(X429Queue.withdrawFor, (address(this)));
        else data = abi.encodeCall(X429Queue.overtake, (ticketId, 1));
        (bool ok, bytes memory ret) = address(queue).call(data);
        innerOk = ok;
        if (!ok) {
            innerRevertData = ret;
            if (bubble) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

// =====================================================================================================
//                                          shared test base
// =====================================================================================================

abstract contract X429QueueBase is Test {
    X429Queue internal q;
    uint32 internal qid;

    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");

    uint256 internal constant START_BALANCE = 1_000 ether;
    uint256 internal constant T0 = 1_700_000_000;
    string internal constant META = '{"name":"test","serviceIntervalMs":15000}';

    uint128 internal constant P1 = 1e15;
    uint128 internal constant P2 = 2e15;
    uint128 internal constant P3 = 3e15;
    uint128 internal constant P4 = 4e15;

    function _deployWithQueue(uint32 maxLength) internal {
        vm.warp(T0);
        q = new X429Queue();
        qid = q.createQueue(operator, maxLength, META);
        deal(alice, START_BALANCE);
        deal(bob, START_BALANCE);
        deal(carol, START_BALANCE);
        deal(dave, START_BALANCE);
        deal(erin, START_BALANCE);
        deal(address(this), START_BALANCE);
    }

    // ------------------------------------------------------------------ actions

    function _join(address who, uint32 queueId, uint128 price) internal returns (uint64 id) {
        vm.prank(who);
        id = q.join(queueId, price);
    }

    function _overtake(address who, uint64 id, uint32 maxPositions, uint256 value)
        internal
        returns (uint32 passed, uint256 paid)
    {
        vm.prank(who);
        (passed, paid) = q.overtake{value: value}(id, maxPositions);
    }

    function _joinAndOvertake(address who, uint32 queueId, uint128 price, uint32 maxPositions, uint256 value)
        internal
        returns (uint64 id, uint32 passed, uint256 paid)
    {
        vm.prank(who);
        (id, passed, paid) = q.joinAndOvertake{value: value}(queueId, price, maxPositions);
    }

    function _serve(uint32 queueId, uint32 count) internal returns (uint32 served) {
        vm.prank(q.queueInfo(queueId).operator);
        served = q.serve(queueId, count);
    }

    // ------------------------------------------------------------------ views

    /// @dev The public getter returns the 10 static Ticket fields, ABI-identical to a static struct.
    function _ticket(uint64 id) internal view returns (X429Queue.Ticket memory t) {
        (bool ok, bytes memory ret) = address(q).staticcall(abi.encodeWithSelector(q.tickets.selector, id));
        require(ok, "tickets() failed");
        t = abi.decode(ret, (X429Queue.Ticket));
    }

    function _ids(uint32 queueId) internal view returns (uint64[] memory ids) {
        X429Queue.TicketView[] memory list = q.getQueue(queueId, 0, type(uint32).max);
        ids = new uint64[](list.length);
        for (uint256 i; i < list.length; ++i) {
            ids[i] = list[i].id;
        }
    }

    /// @dev Checks getQueue order, head/tail, prev/next links in both directions and positionOf.
    function _assertOrder(uint32 queueId, uint64[] memory expected) internal view {
        uint64[] memory actual = _ids(queueId);
        assertEq(actual.length, expected.length, "queue length (getQueue)");
        for (uint256 i; i < expected.length; ++i) {
            assertEq(actual[i], expected[i], "queue order");
        }
        X429Queue.Queue memory info = q.queueInfo(queueId);
        assertEq(info.length, expected.length, "queue length (info)");
        if (expected.length == 0) {
            assertEq(info.head, 0, "empty head");
            assertEq(info.tail, 0, "empty tail");
            return;
        }
        assertEq(info.head, expected[0], "head");
        assertEq(info.tail, expected[expected.length - 1], "tail");
        for (uint256 i; i < expected.length; ++i) {
            X429Queue.Ticket memory t = _ticket(expected[i]);
            assertEq(t.prev, i == 0 ? uint64(0) : expected[i - 1], "prev link");
            assertEq(t.next, i == expected.length - 1 ? uint64(0) : expected[i + 1], "next link");
            assertEq(uint8(t.status), uint8(X429Queue.Status.Waiting), "status");
            assertEq(q.positionOf(expected[i]), i + 1, "positionOf");
        }
    }

    function _holders() internal view returns (address[] memory h) {
        h = new address[](7);
        h[0] = operator;
        h[1] = alice;
        h[2] = bob;
        h[3] = carol;
        h[4] = dave;
        h[5] = erin;
        h[6] = address(this);
    }

    function _sumClaimable(address[] memory who) internal view returns (uint256 sum) {
        for (uint256 i; i < who.length; ++i) {
            sum += q.claimable(who[i]);
        }
    }

    function _assertSolvent(address[] memory extra) internal view {
        uint256 sum = _sumClaimable(_holders()) + _sumClaimable(extra);
        assertEq(address(q).balance, sum, "balance == sum(claimable)");
    }

    function _assertSolvent() internal view {
        _assertSolvent(new address[](0));
    }

    function _owner(uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("x429.owner", i)))));
    }

    /// @dev Logs emitted by the queue contract only (other emitters, e.g. native-transfer logs, are ignored).
    function _queueLogs(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(q)) ++n;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(q)) out[n++] = logs[i];
        }
    }

    // ------------------------------------------------------------------ list literals

    function _l(uint64 a) internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
        r[0] = a;
    }

    function _l(uint64 a, uint64 b) internal pure returns (uint64[] memory r) {
        r = new uint64[](2);
        (r[0], r[1]) = (a, b);
    }

    function _l(uint64 a, uint64 b, uint64 c) internal pure returns (uint64[] memory r) {
        r = new uint64[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _l(uint64 a, uint64 b, uint64 c, uint64 d) internal pure returns (uint64[] memory r) {
        r = new uint64[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _l(uint64 a, uint64 b, uint64 c, uint64 d, uint64 e) internal pure returns (uint64[] memory r) {
        r = new uint64[](5);
        (r[0], r[1], r[2], r[3], r[4]) = (a, b, c, d, e);
    }
}

// =====================================================================================================
//                                       unit + fuzz tests
// =====================================================================================================

contract X429QueueTest is X429QueueBase {
    address internal fuzzMover = makeAddr("fuzzMover");
    uint256 internal constant MAX_FUZZ_PRICE = 1e16;

    function setUp() public {
        _deployWithQueue(16);
        deal(fuzzMover, START_BALANCE);
    }

    /// @dev alice P1 (head), bob P2, carol P3, dave P4 (tail).
    function _fixture() internal returns (uint64 a, uint64 b, uint64 c, uint64 d) {
        a = _join(alice, qid, P1);
        b = _join(bob, qid, P2);
        c = _join(carol, qid, P3);
        d = _join(dave, qid, P4);
    }

    // ------------------------------------------------------------------ createQueue

    function test_createQueue_revertsOnZeroOperator() public {
        vm.expectRevert(X429Queue.InvalidOperator.selector);
        q.createQueue(address(0), 10, "");
    }

    function test_createQueue_revertsOnInvalidMaxLength() public {
        vm.expectRevert(X429Queue.InvalidMaxLength.selector);
        q.createQueue(operator, 0, "");
        vm.expectRevert(X429Queue.InvalidMaxLength.selector);
        q.createQueue(operator, 1025, "");
    }

    function test_createQueue_acceptsMaxLength1024() public {
        assertEq(q.MAX_QUEUE_LENGTH(), 1024);
        uint32 id = q.createQueue(operator, 1024, "");
        assertEq(q.queueInfo(id).maxLength, 1024);
    }

    function test_createQueue_emitsEventAndIncrementsIds() public {
        assertEq(q.queueCount(), 1);
        vm.expectEmit(address(q));
        emit X429Queue.QueueCreated(2, bob, 5, "m2");
        vm.prank(alice); // anyone may open a queue
        assertEq(q.createQueue(bob, 5, "m2"), 2);
        vm.expectEmit(address(q));
        emit X429Queue.QueueCreated(3, carol, 1024, "");
        assertEq(q.createQueue(carol, 1024, ""), 3);
        assertEq(q.queueCount(), 3);
    }

    function test_queueInfo_fields() public {
        X429Queue.Queue memory info = q.queueInfo(qid);
        assertEq(info.operator, operator);
        assertEq(info.length, 0);
        assertEq(info.maxLength, 16);
        assertEq(info.overtakes, 0);
        assertEq(info.head, 0);
        assertEq(info.tail, 0);
        assertEq(info.joined, 0);
        assertEq(info.served, 0);
        assertEq(info.totalCompensation, 0);
        assertEq(info.meta, META);

        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        _overtake(dave, d, 1, P3); // a, b, d, c
        _serve(qid, 1); // a served
        info = q.queueInfo(qid);
        assertEq(uint8(_ticket(a).status), uint8(X429Queue.Status.Served));
        assertEq(info.length, 3);
        assertEq(info.overtakes, 1);
        assertEq(info.head, b);
        assertEq(info.tail, c);
        assertEq(info.joined, 4);
        assertEq(info.served, 1);
        assertEq(info.totalCompensation, P3);
    }

    function test_unknownQueue_reverts() public {
        uint32 unknown = 99;
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.join(unknown, 1);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.join(0, 1);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.joinAndOvertake{value: 1}(unknown, 1, 1);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        vm.prank(operator);
        q.serve(unknown, 1);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.getQueue(unknown, 0, 10);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.queueInfo(unknown);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.setOperator(unknown, alice);
        vm.expectRevert(X429Queue.UnknownQueue.selector);
        q.quote(unknown, 0, 1, 1 ether);
    }

    // ------------------------------------------------------------------ join

    function test_join_orderPositionsAndCounters() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(c, 3);
        assertEq(d, 4);
        assertEq(q.ticketCount(), 4);
        _assertOrder(qid, _l(a, b, c, d));
        X429Queue.Queue memory info = q.queueInfo(qid);
        assertEq(info.joined, 4);
        assertEq(info.length, 4);
    }

    function test_join_emitsJoinedWithPosition() public {
        _join(alice, qid, P1);
        vm.expectEmit(address(q));
        emit X429Queue.Joined(qid, 2, bob, 7, 2);
        _join(bob, qid, 7);
    }

    function test_join_ticketFields() public {
        vm.warp(T0 + 42);
        uint64 a = _join(alice, qid, P1);
        uint64 b = _join(bob, qid, 0);
        X429Queue.Ticket memory t = _ticket(b);
        assertEq(t.owner, bob);
        assertEq(t.queueId, qid);
        assertEq(uint8(t.status), uint8(X429Queue.Status.Waiting));
        assertEq(t.timesPassed, 0);
        assertEq(t.joinedAt, T0 + 42);
        assertEq(t.prev, a);
        assertEq(t.next, 0);
        assertEq(t.skipPrice, 0);
        assertEq(t.earned, 0);
        assertEq(t.paid, 0);
        assertEq(_ticket(a).next, b);
        assertEq(_ticket(a).skipPrice, P1);
    }

    function test_join_unknownTicketHasNoneStatus() public view {
        X429Queue.Ticket memory t = _ticket(12345);
        assertEq(uint8(t.status), uint8(X429Queue.Status.None));
        assertEq(t.owner, address(0));
    }

    // ------------------------------------------------------------------ overtake

    function test_overtake_partialBudget() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        uint256 budget = P3 + P2 + P1 / 2; // covers carol and bob, not alice
        uint256 daveBefore = dave.balance;

        (uint32 passed, uint256 paid) = _overtake(dave, d, 64, budget);

        assertEq(passed, 2);
        assertEq(paid, P3 + P2);
        _assertOrder(qid, _l(a, d, b, c));
        assertEq(dave.balance, daveBefore - paid, "refund");
        assertEq(q.claimable(carol), P3);
        assertEq(q.claimable(bob), P2);
        assertEq(q.claimable(alice), 0);
        assertEq(q.claimable(dave), 0);
        assertEq(_ticket(c).timesPassed, 1);
        assertEq(_ticket(c).earned, P3);
        assertEq(_ticket(b).timesPassed, 1);
        assertEq(_ticket(b).earned, P2);
        assertEq(_ticket(a).timesPassed, 0);
        assertEq(_ticket(a).earned, 0);
        assertEq(_ticket(d).paid, P3 + P2);
        X429Queue.Queue memory info = q.queueInfo(qid);
        assertEq(info.overtakes, 1);
        assertEq(info.totalCompensation, P3 + P2);
        assertEq(address(q).balance, P3 + P2);
        _assertSolvent();
    }

    function test_overtake_exactBudgetPassesAll() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        uint256 daveBefore = dave.balance;
        (uint32 passed, uint256 paid) = _overtake(dave, d, 64, P1 + P2 + P3);
        assertEq(passed, 3);
        assertEq(paid, P1 + P2 + P3);
        _assertOrder(qid, _l(d, a, b, c));
        assertEq(dave.balance, daveBefore - paid);
        assertEq(q.claimable(alice), P1);
        assertEq(q.positionOf(d), 1);
        _assertSolvent();
    }

    function test_overtake_budgetBelowFirstPriceReverts() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        uint256 daveBefore = dave.balance;
        vm.expectRevert(X429Queue.NothingPassed.selector);
        _overtake(dave, d, 64, P3 - 1);
        assertEq(dave.balance, daveBefore);
        _assertOrder(qid, _l(a, b, c, d));
        vm.expectRevert(X429Queue.NothingPassed.selector);
        _overtake(dave, d, 64, 0);
    }

    function test_overtake_invalidPositionsRevert() public {
        (,,, uint64 d) = _fixture();
        vm.expectRevert(X429Queue.InvalidPositions.selector);
        _overtake(dave, d, 0, 1 ether);
        vm.expectRevert(X429Queue.InvalidPositions.selector);
        _overtake(dave, d, 65, 1 ether);
        vm.expectRevert(X429Queue.InvalidPositions.selector);
        _joinAndOvertake(erin, qid, 0, 0, 1 ether);
        vm.expectRevert(X429Queue.InvalidPositions.selector);
        _joinAndOvertake(erin, qid, 0, 65, 1 ether);
        assertEq(q.ticketCount(), 4, "reverted joinAndOvertake must not join");
        assertEq(q.MAX_PASS_PER_TX(), 64);
    }

    function test_overtake_fromHeadRevertsNothingPassed() public {
        (uint64 a,,,) = _fixture();
        vm.expectRevert(X429Queue.NothingPassed.selector);
        _overtake(alice, a, 1, 1 ether);
    }

    function test_overtake_exactRefundToEOA() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        uint256 daveBefore = dave.balance;
        uint256 budget = 10 ether;
        (uint32 passed, uint256 paid) = _overtake(dave, d, 64, budget);
        assertEq(passed, 3);
        assertEq(paid, P1 + P2 + P3);
        assertEq(dave.balance, daveBefore - (P1 + P2 + P3), "exact refund");
        assertEq(q.claimable(dave), 0, "refund was pushed, not credited");
        assertEq(address(q).balance, P1 + P2 + P3);
        _assertOrder(qid, _l(d, a, b, c));
        _assertSolvent();
    }

    function test_overtake_refundToRejectingContractIsCredited() public {
        EthRejecter rej = new EthRejecter(q);
        uint64 a = _join(alice, qid, P1);
        uint64 b = _join(bob, qid, P2);
        uint64 r = rej.join(qid, 5e15);

        (uint32 passed, uint256 paid) = rej.overtake{value: 1 ether}(r, 64);

        assertEq(passed, 2);
        assertEq(paid, P1 + P2);
        assertEq(q.claimable(address(rej)), 1 ether - (P1 + P2), "refund credited to claimable");
        assertEq(address(rej).balance, 0);
        assertEq(address(q).balance, 1 ether);
        _assertOrder(qid, _l(r, a, b));
        address[] memory extra = new address[](1);
        extra[0] = address(rej);
        _assertSolvent(extra);

        // the credited refund cannot be pushed to a rejecting contract either; it stays claimable
        vm.expectRevert(X429Queue.TransferFailed.selector);
        rej.withdraw();
        assertEq(q.claimable(address(rej)), 1 ether - (P1 + P2));
        _assertSolvent(extra);
    }

    function test_overtake_passingOwnTicketPaysYourself() public {
        uint64 a1 = _join(alice, qid, P1);
        uint64 b = _join(bob, qid, P2);
        uint64 a2 = _join(alice, qid, P3);
        uint256 aliceBefore = alice.balance;

        (uint32 passed, uint256 paid) = _overtake(alice, a2, 64, P1 + P2);

        assertEq(passed, 2);
        assertEq(paid, P1 + P2);
        _assertOrder(qid, _l(a2, a1, b));
        assertEq(alice.balance, aliceBefore - (P1 + P2));
        assertEq(q.claimable(alice), P1, "mover credited for passing its own ticket");
        assertEq(q.claimable(bob), P2);
        assertEq(_ticket(a1).earned, P1);
        assertEq(_ticket(a1).timesPassed, 1);
        assertEq(_ticket(a2).paid, P1 + P2);
        _assertSolvent();

        vm.prank(alice);
        q.withdraw();
        assertEq(alice.balance, aliceBefore - P2, "net cost is only what others received");
        _assertSolvent();
    }

    function test_overtake_zeroPriceTicketsArePassedForFree() public {
        uint64 a = _join(alice, qid, 0);
        uint64 b = _join(bob, qid, 0);
        uint64 c = _join(carol, qid, 0);
        uint64 d = _join(dave, qid, P1);

        vm.expectEmit(address(q));
        emit X429Queue.Overtook(qid, d, dave, 3, 0);
        (uint32 passed, uint256 paid) = _overtake(dave, d, 64, 0);

        assertEq(passed, 3);
        assertEq(paid, 0);
        _assertOrder(qid, _l(d, a, b, c));
        assertEq(_ticket(a).timesPassed, 1);
        assertEq(_ticket(b).timesPassed, 1);
        assertEq(_ticket(c).timesPassed, 1);
        assertEq(q.claimable(alice) + q.claimable(bob) + q.claimable(carol), 0);
        assertEq(address(q).balance, 0);
        assertEq(q.queueInfo(qid).overtakes, 1);
    }

    function test_overtake_freeTicketsThenStopsAtFirstPricedOne() public {
        uint64 a = _join(alice, qid, 0);
        uint64 b = _join(bob, qid, P2);
        uint64 c = _join(carol, qid, 0);
        uint64 d = _join(dave, qid, 0);
        (uint32 passed, uint256 paid) = _overtake(dave, d, 64, 0);
        assertEq(passed, 1);
        assertEq(paid, 0);
        _assertOrder(qid, _l(a, b, d, c));
    }

    function test_overtake_respectsMaxPositions() public {
        uint64[] memory ids = new uint64[](5);
        for (uint256 i; i < 5; ++i) {
            ids[i] = _join(_owner(i), qid, P1);
        }
        uint64 d = _join(dave, qid, P1);
        uint256 daveBefore = dave.balance;
        (uint32 passed, uint256 paid) = _overtake(dave, d, 2, 1 ether);
        assertEq(passed, 2);
        assertEq(paid, 2 * uint256(P1));
        assertEq(dave.balance, daveBefore - paid);
        assertEq(q.positionOf(d), 4);
        assertEq(q.claimable(_owner(4)), P1);
        assertEq(q.claimable(_owner(3)), P1);
        assertEq(q.claimable(_owner(2)), 0);
    }

    function test_overtake_cappedAt64PerTransaction() public {
        uint32 big = q.createQueue(operator, 1024, "");
        for (uint256 i; i < 70; ++i) {
            _join(_owner(i), big, 0);
        }
        uint64 d = _join(dave, big, 0);
        (uint32 passed, uint256 paid) = _overtake(dave, d, 64, 0);
        assertEq(passed, 64);
        assertEq(paid, 0);
        assertEq(q.positionOf(d), 71 - 64);
        vm.expectRevert(X429Queue.InvalidPositions.selector);
        _overtake(dave, d, 65, 0);
    }

    function test_overtake_revertsForNonOwner() public {
        (,,, uint64 d) = _fixture();
        vm.expectRevert(X429Queue.NotTicketOwner.selector);
        _overtake(bob, d, 1, 1 ether);
    }

    function test_overtake_revertsWhenNotWaiting() public {
        (uint64 a, uint64 b,, uint64 d) = _fixture();
        // unknown ticket
        vm.expectRevert(X429Queue.NotWaiting.selector);
        _overtake(dave, 999, 1, 1 ether);
        // left
        vm.prank(dave);
        q.leave(d);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        _overtake(dave, d, 1, 1 ether);
        // served
        _serve(qid, 1);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        _overtake(alice, a, 1, 1 ether);
        // kicked
        vm.prank(operator);
        q.kick(b);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        _overtake(bob, b, 1, 1 ether);
    }

    function test_overtake_emitsPassedAndOvertook() public {
        (, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.expectEmit(address(q));
        emit X429Queue.Passed(qid, c, carol, d, P3);
        vm.expectEmit(address(q));
        emit X429Queue.Passed(qid, b, bob, d, P2);
        vm.expectEmit(address(q));
        emit X429Queue.Overtook(qid, d, dave, 2, uint256(P3) + P2);
        _overtake(dave, d, 64, uint256(P3) + P2);
    }

    function test_quote_matchesOvertake() public {
        (,,, uint64 d) = _fixture();
        uint256[6] memory budgets = [uint256(0), P3 - 1, P3, uint256(P3) + P2, uint256(P1) + P2 + P3 - 1, 1 ether];
        uint32[3] memory caps = [uint32(1), 2, 64];
        for (uint256 i; i < budgets.length; ++i) {
            for (uint256 j; j < caps.length; ++j) {
                (uint32 qPassed, uint256 qCost) = q.quote(qid, d, caps[j], budgets[i]);
                uint256 snap = vm.snapshotState();
                if (qPassed == 0) {
                    vm.expectRevert(X429Queue.NothingPassed.selector);
                    _overtake(dave, d, caps[j], budgets[i]);
                } else {
                    (uint32 passed, uint256 paid) = _overtake(dave, d, caps[j], budgets[i]);
                    assertEq(passed, qPassed, "quote passed");
                    assertEq(paid, qCost, "quote cost");
                }
                vm.revertToState(snap);
            }
        }
    }

    function test_quote_newTicketMatchesJoinAndOvertake() public {
        _fixture();
        uint256[6] memory budgets = [uint256(0), P4 - 1, P4, uint256(P4) + P3, uint256(P4) + P3 + P2 + P1, 1 ether];
        uint32[3] memory caps = [uint32(1), 3, 64];
        for (uint256 i; i < budgets.length; ++i) {
            for (uint256 j; j < caps.length; ++j) {
                (uint32 qPassed, uint256 qCost) = q.quote(qid, 0, caps[j], budgets[i]);
                uint256 snap = vm.snapshotState();
                (, uint32 passed, uint256 paid) = _joinAndOvertake(erin, qid, P1, caps[j], budgets[i]);
                assertEq(passed, qPassed, "quote passed");
                assertEq(paid, qCost, "quote cost");
                vm.revertToState(snap);
            }
        }
    }

    function test_quote_revertsForNonWaitingOrForeignTicket() public {
        (uint64 a,,,) = _fixture();
        uint32 other = q.createQueue(operator, 4, "");
        uint64 x = _join(erin, other, 0);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.quote(qid, 999, 1, 1 ether);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.quote(qid, x, 1, 1 ether); // ticket belongs to another queue
        _serve(qid, 1);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.quote(qid, a, 1, 1 ether);
        // the head of a queue quotes zero
        (uint32 passed, uint256 cost) = q.quote(other, x, 64, 1 ether);
        assertEq(passed, 0);
        assertEq(cost, 0);
    }

    // ------------------------------------------------------------------ joinAndOvertake

    function test_joinAndOvertake_zeroPassesStillJoinsAndRefunds() public {
        _join(alice, qid, P1);
        _join(bob, qid, P2);
        uint64 c = _join(carol, qid, P3);
        uint256 erinBefore = erin.balance;

        vm.recordLogs();
        (uint64 e, uint32 passed, uint256 paid) = _joinAndOvertake(erin, qid, P1, 64, P3 - 1);
        Vm.Log[] memory logs = _queueLogs(vm.getRecordedLogs());

        assertEq(e, 4);
        assertEq(passed, 0);
        assertEq(paid, 0);
        assertEq(erin.balance, erinBefore, "full refund");
        assertEq(address(q).balance, 0);
        assertEq(q.positionOf(e), 4);
        assertEq(_ticket(e).prev, c);
        assertEq(q.queueInfo(qid).overtakes, 0);
        assertEq(logs.length, 1, "only Joined");
        assertEq(logs[0].topics[0], X429Queue.Joined.selector);
    }

    function test_joinAndOvertake_intoEmptyQueue() public {
        uint256 erinBefore = erin.balance;
        (uint64 e, uint32 passed, uint256 paid) = _joinAndOvertake(erin, qid, P1, 1, 1 ether);
        assertEq(passed, 0);
        assertEq(paid, 0);
        assertEq(erin.balance, erinBefore);
        _assertOrder(qid, _l(e));
    }

    function test_joinAndOvertake_relinksCorrectly() public {
        uint64 a = _join(alice, qid, P1);
        uint64 b = _join(bob, qid, P2);
        uint64 c = _join(carol, qid, P3);

        vm.expectEmit(address(q));
        emit X429Queue.Joined(qid, 4, erin, P1, 4);
        vm.expectEmit(address(q));
        emit X429Queue.Overtook(qid, 4, erin, 2, uint256(P3) + P2);
        (uint64 e, uint32 passed, uint256 paid) = _joinAndOvertake(erin, qid, P1, 2, 1 ether);
        assertEq(passed, 2);
        assertEq(paid, uint256(P3) + P2);
        _assertOrder(qid, _l(a, e, b, c));
        assertEq(_ticket(e).paid, uint256(P3) + P2);

        // pass everybody: new head
        (uint64 d, uint32 passed2, uint256 paid2) = _joinAndOvertake(dave, qid, 0, 64, 1 ether);
        assertEq(passed2, 4);
        assertEq(paid2, uint256(P1) + P1 + P2 + P3);
        _assertOrder(qid, _l(d, a, e, b, c));
        assertEq(q.claimable(erin), P1);
        assertEq(q.claimable(carol), 2 * uint256(P3));
        assertEq(q.claimable(bob), 2 * uint256(P2));
        assertEq(q.claimable(alice), P1);
        _assertSolvent();
    }

    function test_joinAndOvertake_refundToRejectingContractIsCredited() public {
        EthRejecter rej = new EthRejecter(q);
        _join(alice, qid, P2);
        (, uint32 passed, uint256 paid) = rej.joinAndOvertake{value: P1}(qid, 0, 1);
        assertEq(passed, 0);
        assertEq(paid, 0);
        assertEq(q.claimable(address(rej)), P1);
        address[] memory extra = new address[](1);
        extra[0] = address(rej);
        _assertSolvent(extra);
    }

    // ------------------------------------------------------------------ setSkipPrice

    function test_setSkipPrice_updatesAndEmits() public {
        (, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.expectEmit(address(q));
        emit X429Queue.SkipPriceSet(qid, c, 9e15);
        vm.prank(carol);
        q.setSkipPrice(c, 9e15);
        assertEq(_ticket(c).skipPrice, 9e15);
        (uint32 passed, uint256 cost) = q.quote(qid, d, 64, 9e15);
        assertEq(passed, 1);
        assertEq(cost, 9e15);
        (passed, cost) = _overtake(dave, d, 1, 9e15);
        assertEq(cost, 9e15);
        assertEq(q.claimable(carol), 9e15);
        // price can go to zero as well
        vm.prank(bob);
        q.setSkipPrice(b, 0);
        assertEq(_ticket(b).skipPrice, 0);
    }

    function test_setSkipPrice_revertsForNonOwner() public {
        (, uint64 b,,) = _fixture();
        vm.expectRevert(X429Queue.NotTicketOwner.selector);
        vm.prank(alice);
        q.setSkipPrice(b, 1);
        vm.expectRevert(X429Queue.NotTicketOwner.selector);
        vm.prank(operator);
        q.setSkipPrice(b, 1);
    }

    function test_setSkipPrice_revertsWhenNotWaiting() public {
        (uint64 a, uint64 b, uint64 c,) = _fixture();
        _serve(qid, 1);
        vm.prank(alice);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.setSkipPrice(a, 1);
        vm.prank(bob);
        q.leave(b);
        vm.prank(bob);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.setSkipPrice(b, 1);
        vm.prank(operator);
        q.kick(c);
        vm.prank(carol);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.setSkipPrice(c, 1);
    }

    // ------------------------------------------------------------------ leave

    function test_leave_removesRelinksAndEmits() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.expectEmit(address(q));
        emit X429Queue.Left(qid, b, bob, false);
        vm.prank(bob);
        q.leave(b);
        assertEq(uint8(_ticket(b).status), uint8(X429Queue.Status.Left));
        assertEq(q.positionOf(b), 0);
        _assertOrder(qid, _l(a, c, d));

        vm.prank(alice);
        q.leave(a); // head
        _assertOrder(qid, _l(c, d));
        vm.prank(dave);
        q.leave(d); // tail
        _assertOrder(qid, _l(c));
        vm.prank(carol);
        q.leave(c); // last one
        _assertOrder(qid, new uint64[](0));
        assertEq(q.queueInfo(qid).joined, 4);
    }

    function test_leave_revertsForNonOwner() public {
        (, uint64 b,,) = _fixture();
        vm.expectRevert(X429Queue.NotTicketOwner.selector);
        vm.prank(operator);
        q.leave(b);
    }

    function test_leave_revertsWhenNotWaiting() public {
        (uint64 a, uint64 b, uint64 c,) = _fixture();
        vm.prank(bob);
        q.leave(b);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        vm.prank(bob);
        q.leave(b);
        _serve(qid, 1);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        vm.prank(alice);
        q.leave(a);
        vm.prank(operator);
        q.kick(c);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        vm.prank(carol);
        q.leave(c);
    }

    function test_leave_keepsClaimable() public {
        (, uint64 b,, uint64 d) = _fixture();
        _overtake(dave, d, 2, uint256(P3) + P2);
        vm.prank(bob);
        q.leave(b);
        assertEq(q.claimable(bob), P2);
        uint256 before = bob.balance;
        vm.prank(bob);
        q.withdraw();
        assertEq(bob.balance, before + P2);
    }

    // ------------------------------------------------------------------ kick

    function test_kick_onlyOperator() public {
        (, uint64 b,,) = _fixture();
        address otherOp = makeAddr("otherOperator");
        q.createQueue(otherOp, 4, "");
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(alice);
        q.kick(b);
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(bob); // even the owner cannot kick
        q.kick(b);
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(otherOp); // operator of a different queue
        q.kick(b);
    }

    function test_kick_removesAndEmits() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.expectEmit(address(q));
        emit X429Queue.Left(qid, b, bob, true);
        vm.prank(operator);
        q.kick(b);
        assertEq(uint8(_ticket(b).status), uint8(X429Queue.Status.Kicked));
        assertEq(q.positionOf(b), 0);
        _assertOrder(qid, _l(a, c, d));
    }

    function test_kick_revertsWhenNotWaiting() public {
        (uint64 a, uint64 b, uint64 c,) = _fixture();
        vm.startPrank(operator);
        q.kick(b);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.kick(b);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.kick(999);
        q.serve(qid, 1);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        q.kick(a);
        vm.stopPrank();
        vm.prank(carol);
        q.leave(c);
        vm.expectRevert(X429Queue.NotWaiting.selector);
        vm.prank(operator);
        q.kick(c);
    }

    function test_kick_ticketKeepsClaimable() public {
        (, uint64 b,, uint64 d) = _fixture();
        _overtake(dave, d, 2, uint256(P3) + P2);
        vm.prank(operator);
        q.kick(b);
        assertEq(q.claimable(bob), P2);
        assertEq(_ticket(b).earned, P2);
        uint256 before = bob.balance;
        vm.prank(bob);
        assertEq(q.withdraw(), P2);
        assertEq(bob.balance, before + P2);
        _assertSolvent();
    }

    // ------------------------------------------------------------------ setOperator

    function test_setOperator_onlyOperator() public {
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(alice);
        q.setOperator(qid, alice);
    }

    function test_setOperator_rejectsZero() public {
        vm.expectRevert(X429Queue.InvalidOperator.selector);
        vm.prank(operator);
        q.setOperator(qid, address(0));
    }

    function test_setOperator_handsOverControl() public {
        address newOp = makeAddr("newOperator");
        (, uint64 b,,) = _fixture();
        vm.expectEmit(address(q));
        emit X429Queue.OperatorChanged(qid, newOp);
        vm.prank(operator);
        q.setOperator(qid, newOp);
        assertEq(q.queueInfo(qid).operator, newOp);

        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(operator);
        q.serve(qid, 1);
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(operator);
        q.kick(b);
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(operator);
        q.setOperator(qid, operator);

        vm.prank(newOp);
        assertEq(q.serve(qid, 1), 1);
        vm.prank(newOp);
        q.kick(b);
    }

    // ------------------------------------------------------------------ serve

    function test_serve_emptyQueueReturnsZero() public {
        vm.recordLogs();
        vm.prank(operator);
        assertEq(q.serve(qid, 5), 0);
        assertEq(_queueLogs(vm.getRecordedLogs()).length, 0);
        assertEq(q.queueInfo(qid).served, 0);
    }

    function test_serve_zeroCount() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.prank(operator);
        assertEq(q.serve(qid, 0), 0);
        _assertOrder(qid, _l(a, b, c, d));
    }

    function test_serve_partialInOrder() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.prank(operator);
        assertEq(q.serve(qid, 2), 2);
        assertEq(uint8(_ticket(a).status), uint8(X429Queue.Status.Served));
        assertEq(uint8(_ticket(b).status), uint8(X429Queue.Status.Served));
        _assertOrder(qid, _l(c, d));
        assertEq(q.queueInfo(qid).served, 2);
    }

    function test_serve_countAboveLengthServesAll() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        vm.prank(operator);
        assertEq(q.serve(qid, 100), 4);
        _assertOrder(qid, new uint64[](0));
        assertEq(q.queueInfo(qid).served, 4);
        assertEq(q.positionOf(a) + q.positionOf(b) + q.positionOf(c) + q.positionOf(d), 0);
        // the queue is reusable afterwards
        uint64 e = _join(erin, qid, 0);
        _assertOrder(qid, _l(e));
    }

    function test_serve_emitsServedWithStats() public {
        uint64 a = _join(alice, qid, P1); // T0
        vm.warp(T0 + 10);
        uint64 b = _join(bob, qid, P2); // T0 + 10
        vm.warp(T0 + 20);
        (uint64 c,,) = _joinAndOvertake(carol, qid, P3, 1, P2); // T0 + 20, passes bob
        _assertOrder(qid, _l(a, c, b));
        vm.warp(T0 + 100);

        vm.expectEmit(address(q));
        emit X429Queue.Served(qid, a, alice, 100, 0, 0, 0);
        vm.expectEmit(address(q));
        emit X429Queue.Served(qid, c, carol, 80, 0, 0, P2);
        vm.expectEmit(address(q));
        emit X429Queue.Served(qid, b, bob, 90, 1, P2, 0);
        vm.prank(operator);
        assertEq(q.serve(qid, 3), 3);
    }

    function test_serve_onlyOperator() public {
        _fixture();
        vm.expectRevert(X429Queue.NotOperator.selector);
        vm.prank(alice);
        q.serve(qid, 1);
    }

    // ------------------------------------------------------------------ QueueFull

    function test_queueFull_joinAndJoinAndOvertakeRevert() public {
        uint32 small = q.createQueue(operator, 2, "");
        uint64 a = _join(alice, small, P1);
        _join(bob, small, P1);
        vm.expectRevert(X429Queue.QueueFull.selector);
        _join(carol, small, P1);
        uint256 carolBefore = carol.balance;
        vm.expectRevert(X429Queue.QueueFull.selector);
        _joinAndOvertake(carol, small, P1, 64, 1 ether);
        assertEq(carol.balance, carolBefore);
        assertEq(q.queueInfo(small).length, 2);

        // room frees up after a serve / leave
        _serve(small, 1);
        _join(carol, small, P1);
        vm.expectRevert(X429Queue.QueueFull.selector);
        _join(dave, small, P1);
        vm.prank(carol);
        q.leave(3);
        _join(dave, small, P1);
        assertEq(uint8(_ticket(a).status), uint8(X429Queue.Status.Served));
    }

    // ------------------------------------------------------------------ withdraw / withdrawFor

    function test_withdraw_paysOut() public {
        (,,, uint64 d) = _fixture();
        _overtake(dave, d, 2, uint256(P3) + P2);
        uint256 before = bob.balance;
        vm.expectEmit(address(q));
        emit X429Queue.Withdrawn(bob, bob, P2);
        vm.prank(bob);
        assertEq(q.withdraw(), P2);
        assertEq(bob.balance, before + P2);
        assertEq(q.claimable(bob), 0);
        assertEq(address(q).balance, P3);
        _assertSolvent();
        vm.expectRevert(X429Queue.NothingToWithdraw.selector);
        vm.prank(bob);
        q.withdraw();
    }

    function test_withdrawFor_paysOwnerNotCaller() public {
        (,,, uint64 d) = _fixture();
        _overtake(dave, d, 2, uint256(P3) + P2);
        uint256 carolBefore = carol.balance;
        uint256 erinBefore = erin.balance;
        vm.expectEmit(address(q));
        emit X429Queue.Withdrawn(carol, erin, P3);
        vm.prank(erin);
        assertEq(q.withdrawFor(carol), P3);
        assertEq(carol.balance, carolBefore + P3);
        assertEq(erin.balance, erinBefore);
        assertEq(q.claimable(carol), 0);
        _assertSolvent();
        vm.expectRevert(X429Queue.NothingToWithdraw.selector);
        q.withdrawFor(carol);
    }

    function test_withdraw_nothingToWithdraw() public {
        vm.expectRevert(X429Queue.NothingToWithdraw.selector);
        vm.prank(alice);
        q.withdraw();
        vm.expectRevert(X429Queue.NothingToWithdraw.selector);
        q.withdrawFor(alice);
        vm.expectRevert(X429Queue.NothingToWithdraw.selector);
        q.withdrawFor(address(0));
    }

    function test_withdraw_toRejectingContractRevertsAndPreservesBalance() public {
        EthRejecter rej = new EthRejecter(q);
        rej.join(qid, P2);
        uint64 d = _join(dave, qid, P1);
        _overtake(dave, d, 1, P2);
        assertEq(q.claimable(address(rej)), P2);

        vm.expectRevert(X429Queue.TransferFailed.selector);
        rej.withdraw();
        vm.expectRevert(X429Queue.TransferFailed.selector);
        vm.prank(alice);
        q.withdrawFor(address(rej));
        assertEq(q.claimable(address(rej)), P2);
        assertEq(address(q).balance, P2);
        address[] memory extra = new address[](1);
        extra[0] = address(rej);
        _assertSolvent(extra);
    }

    // ------------------------------------------------------------------ reentrancy

    /// @dev receiver is at the head and has been passed once (claimable == P2); alice is ahead of it.
    function _reentrancySetup() internal returns (ReentrantReceiver rcv) {
        rcv = new ReentrantReceiver(q);
        rcv.join(qid, P2);
        _joinAndOvertake(alice, qid, P1, 1, P2);
        assertEq(q.claimable(address(rcv)), P2);
        assertEq(_ticket(rcv.ticketId()).prev, 2); // alice's ticket (#2) is ahead of the receiver (#1)
    }

    function _assertSolventWith(address extra) internal view {
        address[] memory e = new address[](1);
        e[0] = extra;
        _assertSolvent(e);
    }

    function test_reentrancy_innerCallBlockedSinglePayout() public {
        for (uint8 mode = 1; mode <= 3; ++mode) {
            for (uint256 viaFor; viaFor < 2; ++viaFor) {
                uint256 snap = vm.snapshotState();
                ReentrantReceiver rcv = _reentrancySetup();
                rcv.configure(ReentrantReceiver.Attack(mode), false);
                uint256 qBalance = address(q).balance;

                uint256 amount;
                if (viaFor == 0) {
                    amount = rcv.withdraw();
                } else {
                    vm.prank(bob);
                    amount = q.withdrawFor(address(rcv));
                }

                assertEq(amount, P2);
                assertEq(rcv.receiveCount(), 1, "one receive");
                assertFalse(rcv.innerOk(), "inner call must fail");
                assertEq(rcv.innerRevertData(), abi.encodeWithSelector(X429Queue.Reentrancy.selector));
                assertEq(address(rcv).balance, P2, "exactly one payout");
                assertEq(address(q).balance, qBalance - P2);
                assertEq(q.claimable(address(rcv)), 0);
                _assertSolventWith(address(rcv));
                vm.revertToState(snap);
            }
        }
    }

    function test_reentrancy_bubbledRevertFailsWholeWithdraw() public {
        for (uint8 mode = 1; mode <= 3; ++mode) {
            uint256 snap = vm.snapshotState();
            ReentrantReceiver rcv = _reentrancySetup();
            rcv.configure(ReentrantReceiver.Attack(mode), true);
            uint256 qBalance = address(q).balance;

            vm.expectRevert(X429Queue.TransferFailed.selector);
            rcv.withdraw();
            vm.expectRevert(X429Queue.TransferFailed.selector);
            q.withdrawFor(address(rcv));

            assertEq(address(rcv).balance, 0, "no payout");
            assertEq(q.claimable(address(rcv)), P2, "claimable preserved");
            assertEq(address(q).balance, qBalance);
            _assertSolventWith(address(rcv));
            vm.revertToState(snap);
        }
    }

    function test_reentrancy_duringRefundIsBlockedAndRefundCredited() public {
        uint64 a = _join(alice, qid, P1);
        ReentrantReceiver rcv = new ReentrantReceiver(q);
        uint64 r = rcv.join(qid, 0);
        rcv.configure(ReentrantReceiver.Attack.Withdraw, true);

        (uint32 passed, uint256 paid) = rcv.overtake{value: 1 ether}(r, 1);
        assertEq(passed, 1);
        assertEq(paid, P1);
        assertEq(address(rcv).balance, 0, "push failed");
        assertEq(q.claimable(address(rcv)), 1 ether - P1, "refund credited");
        _assertOrder(qid, _l(r, a));
        _assertSolventWith(address(rcv));
    }

    function test_reentrancy_duringRefundSwallowedRefundDelivered() public {
        _join(alice, qid, P1);
        ReentrantReceiver rcv = new ReentrantReceiver(q);
        uint64 r = rcv.join(qid, 0);
        rcv.configure(ReentrantReceiver.Attack.Overtake, false);

        rcv.overtake{value: 1 ether}(r, 1);
        assertFalse(rcv.innerOk());
        assertEq(rcv.innerRevertData(), abi.encodeWithSelector(X429Queue.Reentrancy.selector));
        assertEq(address(rcv).balance, 1 ether - P1, "refund pushed");
        assertEq(q.claimable(address(rcv)), 0);
        _assertSolventWith(address(rcv));
    }

    // ------------------------------------------------------------------ getQueue / positionOf

    function test_getQueue_paginationAndFields() public {
        uint64 a = _join(alice, qid, P1);
        vm.warp(T0 + 1);
        uint64 b = _join(bob, qid, P2);
        vm.warp(T0 + 2);
        uint64 c = _join(carol, qid, P3);
        vm.warp(T0 + 3);
        uint64 d = _join(dave, qid, P4);
        _overtake(dave, d, 1, P3); // a, b, d, c

        uint64[] memory order = _l(a, b, d, c);
        _assertOrder(qid, order);

        X429Queue.TicketView[] memory v = q.getQueue(qid, 0, 2);
        assertEq(v.length, 2);
        assertEq(v[0].id, a);
        assertEq(v[1].id, b);
        v = q.getQueue(qid, 1, 2);
        assertEq(v.length, 2);
        assertEq(v[0].id, b);
        assertEq(v[1].id, d);
        v = q.getQueue(qid, 2, 100);
        assertEq(v.length, 2);
        assertEq(v[0].id, d);
        assertEq(v[1].id, c);
        v = q.getQueue(qid, 3, 1);
        assertEq(v.length, 1);
        assertEq(v[0].id, c);
        assertEq(q.getQueue(qid, 4, 1).length, 0, "offset == length");
        assertEq(q.getQueue(qid, 100, 5).length, 0, "offset beyond length");
        assertEq(q.getQueue(qid, 0, 0).length, 0, "limit 0");

        v = q.getQueue(qid, 0, type(uint32).max);
        assertEq(v.length, 4);
        // d: the mover
        assertEq(v[2].id, d);
        assertEq(v[2].owner, dave);
        assertEq(v[2].skipPrice, P4);
        assertEq(v[2].joinedAt, T0 + 3);
        assertEq(v[2].timesPassed, 0);
        assertEq(v[2].earned, 0);
        assertEq(v[2].paid, P3);
        // c: the passed ticket
        assertEq(v[3].id, c);
        assertEq(v[3].owner, carol);
        assertEq(v[3].skipPrice, P3);
        assertEq(v[3].joinedAt, T0 + 2);
        assertEq(v[3].timesPassed, 1);
        assertEq(v[3].earned, P3);
        assertEq(v[3].paid, 0);
        // a: untouched head
        assertEq(v[0].owner, alice);
        assertEq(v[0].joinedAt, T0);
        assertEq(v[0].skipPrice, P1);
    }

    function test_getQueue_emptyQueue() public view {
        assertEq(q.getQueue(qid, 0, 10).length, 0);
    }

    function test_positionOf_zeroForNonWaiting() public {
        (uint64 a, uint64 b, uint64 c, uint64 d) = _fixture();
        assertEq(q.positionOf(999), 0);
        assertEq(q.positionOf(0), 0);
        assertEq(q.positionOf(d), 4);
        vm.prank(bob);
        q.leave(b);
        vm.prank(operator);
        q.kick(c);
        _serve(qid, 1);
        assertEq(q.positionOf(a), 0, "served");
        assertEq(q.positionOf(b), 0, "left");
        assertEq(q.positionOf(c), 0, "kicked");
        assertEq(q.positionOf(d), 1);
    }

    // ------------------------------------------------------------------ several blocks, one timestamp

    function test_sameTimestamp_acrossBlocks() public {
        uint256 ts = block.timestamp;
        uint256 bn = vm.getBlockNumber();
        uint64 a = _join(alice, qid, P1);
        vm.roll(bn + 1);
        uint64 b = _join(bob, qid, P2);
        vm.roll(bn + 2);
        (uint64 c, uint32 passed,) = _joinAndOvertake(carol, qid, 0, 1, P2); // passes bob
        assertEq(passed, 1);
        _assertOrder(qid, _l(a, c, b));
        vm.roll(bn + 3);
        (passed,) = _overtake(bob, b, 1, 0); // carol's price is 0: bob passes back for free
        assertEq(passed, 1);
        _assertOrder(qid, _l(a, b, c));
        vm.roll(bn + 4);
        uint64 d = _join(dave, qid, 0);

        assertEq(block.timestamp, ts, "no warp");
        assertEq(_ticket(a).joinedAt, ts);
        assertEq(_ticket(c).joinedAt, ts);
        assertEq(_ticket(d).joinedAt, ts);

        vm.roll(bn + 5);
        vm.expectEmit(address(q));
        emit X429Queue.Served(qid, a, alice, 0, 0, 0, 0);
        vm.expectEmit(address(q));
        emit X429Queue.Served(qid, b, bob, 0, 1, P2, 0);
        vm.expectEmit(address(q));
        emit X429Queue.Served(qid, c, carol, 0, 1, 0, P2);
        vm.prank(operator);
        assertEq(q.serve(qid, 3), 3);
        _assertOrder(qid, _l(d));
        vm.roll(bn + 6);
        vm.prank(operator);
        assertEq(q.serve(qid, 1), 1);
        _assertSolvent();
    }

    // ------------------------------------------------------------------ fuzz

    function _prices(uint256 seed, uint256 n) internal pure returns (uint128[] memory prices) {
        prices = new uint128[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            prices[i] = r % 4 == 0 ? 0 : uint128(((r >> 8) % MAX_FUZZ_PRICE) + 1);
        }
    }

    /// @dev Reference model: walk from index m-1 toward 0 while affordable and below the cap.
    function _model(uint128[] memory prices, uint256 m, uint32 maxPositions, uint256 budget)
        internal
        pure
        returns (uint256 k, uint256 paid)
    {
        for (uint256 i = m; i > 0 && k < maxPositions; --i) {
            uint256 p = prices[i - 1];
            if (paid + p > budget) break;
            paid += p;
            ++k;
        }
    }

    /// @dev Budget picker that hits the interesting boundaries (exact prefix sums, one wei short, random).
    function _pickBudget(uint128[] memory prices, uint256 m, uint256 raw) internal pure returns (uint256 budget) {
        uint256 aheadSum;
        for (uint256 i; i < m; ++i) {
            aheadSum += prices[i];
        }
        uint256 j = (raw >> 2) % (m + 1);
        uint256 prefix;
        for (uint256 t; t < j; ++t) {
            prefix += prices[m - 1 - t];
        }
        uint256 mode = raw % 4;
        if (mode == 0) budget = (raw >> 16) % (aheadSum + MAX_FUZZ_PRICE + 1);
        else if (mode == 1) budget = prefix;
        else if (mode == 2) budget = prefix == 0 ? 0 : prefix - 1;
        else budget = prefix + ((raw >> 16) % 1e15);
    }

    function _expectedOrder(uint64[] memory others, uint64 mover, uint256 m, uint256 k)
        internal
        pure
        returns (uint64[] memory exp)
    {
        uint256 n = others.length;
        exp = new uint64[](n + 1);
        uint256 idx;
        for (uint256 i; i < m - k; ++i) {
            exp[idx++] = others[i];
        }
        exp[idx++] = mover;
        for (uint256 i = m - k; i < n; ++i) {
            exp[idx++] = others[i];
        }
    }

    function _assertCredits(uint128[] memory prices, uint64[] memory others, uint256 m, uint256 k) internal view {
        for (uint256 i; i < others.length; ++i) {
            bool wasPassed = i + k >= m && i < m;
            X429Queue.Ticket memory t = _ticket(others[i]);
            assertEq(q.claimable(t.owner), wasPassed ? prices[i] : uint128(0), "claimable credit");
            assertEq(t.earned, wasPassed ? prices[i] : uint128(0), "earned");
            assertEq(t.timesPassed, wasPassed ? uint24(1) : uint24(0), "timesPassed");
        }
    }

    function _sumClaimableOf(uint64[] memory ids) internal view returns (uint256 sum) {
        for (uint256 i; i < ids.length; ++i) {
            sum += q.claimable(_ticket(ids[i]).owner);
        }
    }

    struct FuzzCase {
        uint256 n; // tickets other than the mover
        uint256 m; // tickets ahead of the mover
        uint32 maxPositions;
        uint128[] prices; // prices[i] of others[i], index 0 is the head
        uint32 queueId;
        uint64[] others;
        uint64 mover;
        uint256 budget;
        uint256 k; // expected positions passed
        uint256 expPaid;
        uint256 moverBefore;
    }

    function _checkOutcome(FuzzCase memory c, uint32 passed, uint256 paid) internal view {
        assertEq(passed, c.k, "passed");
        assertEq(paid, c.expPaid, "paid == longest affordable prefix");
        assertLe(paid, c.budget);
        assertEq(fuzzMover.balance, c.moverBefore - paid, "refund");
        assertEq(q.claimable(fuzzMover), 0);
        assertEq(address(q).balance, paid);
        assertEq(_sumClaimableOf(c.others), paid, "sum credits == paid");
        _assertOrder(c.queueId, _expectedOrder(c.others, c.mover, c.m, c.k));
        _assertCredits(c.prices, c.others, c.m, c.k);
        assertEq(_ticket(c.mover).paid, paid);
        X429Queue.Queue memory info = q.queueInfo(c.queueId);
        assertEq(info.totalCompensation, paid);
        assertEq(info.overtakes, c.k == 0 ? uint32(0) : uint32(1));
    }

    function testFuzz_overtake_matchesReferenceModel(
        uint256 seed,
        uint256 nRaw,
        uint256 moverRaw,
        uint256 maxPosRaw,
        uint256 budgetRaw
    ) public {
        FuzzCase memory c;
        c.n = bound(nRaw, 1, 20);
        c.m = bound(moverRaw, 0, c.n);
        c.maxPositions = uint32(bound(maxPosRaw, 1, 64));
        c.prices = _prices(seed, c.n);

        c.queueId = q.createQueue(operator, 64, "");
        c.others = new uint64[](c.n);
        for (uint256 i; i < c.n; ++i) {
            if (i == c.m) c.mover = _join(fuzzMover, c.queueId, uint128(seed));
            c.others[i] = _join(_owner(i), c.queueId, c.prices[i]);
        }
        if (c.m == c.n) c.mover = _join(fuzzMover, c.queueId, uint128(seed));

        c.budget = _pickBudget(c.prices, c.m, budgetRaw);
        (c.k, c.expPaid) = _model(c.prices, c.m, c.maxPositions, c.budget);

        (uint32 qPassed, uint256 qCost) = q.quote(c.queueId, c.mover, c.maxPositions, c.budget);
        assertEq(qPassed, c.k, "quote passed");
        assertEq(qCost, c.expPaid, "quote cost");

        c.moverBefore = fuzzMover.balance;
        if (c.k == 0) {
            vm.expectRevert(X429Queue.NothingPassed.selector);
            _overtake(fuzzMover, c.mover, c.maxPositions, c.budget);
            assertEq(fuzzMover.balance, c.moverBefore);
            return;
        }
        (uint32 passed, uint256 paid) = _overtake(fuzzMover, c.mover, c.maxPositions, c.budget);
        _checkOutcome(c, passed, paid);
    }

    function testFuzz_joinAndOvertake_matchesReferenceModel(
        uint256 seed,
        uint256 nRaw,
        uint256 maxPosRaw,
        uint256 budgetRaw
    ) public {
        FuzzCase memory c;
        c.n = bound(nRaw, 0, 20);
        c.m = c.n; // the new ticket joins at the tail
        c.maxPositions = uint32(bound(maxPosRaw, 1, 64));
        c.prices = _prices(seed, c.n);

        c.queueId = q.createQueue(operator, 64, "");
        c.others = new uint64[](c.n);
        for (uint256 i; i < c.n; ++i) {
            c.others[i] = _join(_owner(i), c.queueId, c.prices[i]);
        }

        c.budget = _pickBudget(c.prices, c.m, budgetRaw);
        (c.k, c.expPaid) = _model(c.prices, c.m, c.maxPositions, c.budget);
        (uint32 qPassed, uint256 qCost) = q.quote(c.queueId, 0, c.maxPositions, c.budget);
        assertEq(qPassed, c.k, "quote passed");
        assertEq(qCost, c.expPaid, "quote cost");

        c.moverBefore = fuzzMover.balance;
        uint32 passed;
        uint256 paid;
        (c.mover, passed, paid) = _joinAndOvertake(fuzzMover, c.queueId, uint128(seed >> 128), c.maxPositions, c.budget);
        assertEq(c.mover, q.ticketCount());
        _checkOutcome(c, passed, paid);
    }

    function testFuzz_serve_preservesOrder(uint256 nRaw, uint256 countRaw) public {
        uint256 n = bound(nRaw, 0, 16);
        uint32 count = uint32(bound(countRaw, 0, 20));
        uint64[] memory ids = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _join(_owner(i), qid, uint128(i));
        }
        uint32 served = _serve(qid, count);
        uint256 expected = count < n ? count : n;
        assertEq(served, expected);
        uint64[] memory rest = new uint64[](n - expected);
        for (uint256 i = expected; i < n; ++i) {
            rest[i - expected] = ids[i];
        }
        _assertOrder(qid, rest);
    }
}

// =====================================================================================================
//                                         gas benchmarks
// =====================================================================================================

/// @dev Each test measures exactly one external call with a gasleft() delta; all state is prepared in setUp.
///      What the delta contains depends on the runner's `isolate` setting:
///      - isolate = true (forge >= 1.8 default): the call runs as its own transaction, so the delta is the
///        full transaction gas (21000 intrinsic + calldata + execution on cold storage, before refunds).
///      - isolate = false (e.g. arc-forge 1.7.x): the delta is execution gas plus CALL overhead (incl. the
///        value-transfer surcharge for payable calls); the target account is pre-warmed to mirror `tx.to`.
contract X429QueueGasTest is X429QueueBase {
    uint32 internal bigQ; // 24 waiting tickets, distinct owners, price 1e15
    uint32 internal overtakeQ; // 6 waiting tickets + mover's ticket at the tail
    uint32 internal serveQ; // head ticket has been passed once
    uint64 internal moverTicket;
    uint64 internal serveHead;
    address internal mover = makeAddr("bench.mover");
    address internal joiner = makeAddr("bench.joiner");
    address internal withdrawer;

    function setUp() public {
        _deployWithQueue(16);
        bigQ = q.createQueue(operator, 1024, "bench");
        for (uint256 i; i < 24; ++i) {
            _join(_owner(i), bigQ, P1);
        }
        overtakeQ = q.createQueue(operator, 1024, "bench-overtake");
        for (uint256 i; i < 6; ++i) {
            _join(_owner(100 + i), overtakeQ, P1);
        }
        deal(mover, 100 ether);
        moverTicket = _join(mover, overtakeQ, P1);

        serveQ = q.createQueue(operator, 1024, "bench-serve");
        serveHead = _join(_owner(200), serveQ, P1); // A
        uint64 b = _join(_owner(201), serveQ, P1); // B
        _join(_owner(202), serveQ, P1); // C
        deal(_owner(201), 1 ether);
        _overtake(_owner(201), b, 1, P1); // B passes A -> B, A, C
        _serve(serveQ, 1); // B served -> head is A (timesPassed == 1)
        withdrawer = _owner(200); // A has claimable P1
        deal(withdrawer, 1 ether); // an existing account, like any real ticket holder

        deal(joiner, 100 ether);
        vm.warp(T0 + 60);
        vm.roll(block.number + 5);
    }

    function _report(string memory name, uint256 gasUsed) internal {
        emit log_named_uint(name, gasUsed);
    }

    function test_gas_join() public {
        X429Queue queue = q;
        uint32 id = bigQ;
        queue.MAX_PASS_PER_TX(); // warm the target account (no storage touched)
        vm.prank(joiner);
        uint256 g = gasleft();
        queue.join(id, P1);
        uint256 used = g - gasleft();
        _report("join (24 ahead)", used);
    }

    function _benchJoinAndOvertake(uint32 positions, string memory name) internal {
        X429Queue queue = q;
        uint32 id = bigQ;
        uint256 value = uint256(P1) * positions;
        queue.MAX_PASS_PER_TX();
        vm.prank(joiner);
        uint256 g = gasleft();
        (, uint32 passed,) = queue.joinAndOvertake{value: value}(id, P1, positions);
        uint256 used = g - gasleft();
        assertEq(passed, positions);
        _report(name, used);
    }

    function test_gas_joinAndOvertake_pass1() public {
        _benchJoinAndOvertake(1, "joinAndOvertake pass 1");
    }

    function test_gas_joinAndOvertake_pass5() public {
        _benchJoinAndOvertake(5, "joinAndOvertake pass 5");
    }

    function test_gas_joinAndOvertake_pass20() public {
        _benchJoinAndOvertake(20, "joinAndOvertake pass 20");
    }

    function test_gas_overtake_pass5() public {
        X429Queue queue = q;
        uint64 id = moverTicket;
        queue.MAX_PASS_PER_TX();
        vm.prank(mover);
        uint256 g = gasleft();
        (uint32 passed,) = queue.overtake{value: 5 * uint256(P1)}(id, 5);
        uint256 used = g - gasleft();
        assertEq(passed, 5);
        _report("overtake pass 5", used);
    }

    function test_gas_serve1() public {
        X429Queue queue = q;
        uint32 id = serveQ;
        queue.MAX_PASS_PER_TX();
        vm.prank(operator);
        uint256 g = gasleft();
        queue.serve(id, 1);
        uint256 used = g - gasleft();
        X429Queue.Ticket memory head = _ticket(serveHead);
        assertEq(uint8(head.status), uint8(X429Queue.Status.Served));
        assertEq(head.timesPassed, 1, "served head had been passed");
        _report("serve(1), head passed once", used);
    }

    function test_gas_withdraw() public {
        X429Queue queue = q;
        queue.MAX_PASS_PER_TX();
        vm.prank(withdrawer);
        uint256 g = gasleft();
        uint256 amount = queue.withdraw();
        uint256 used = g - gasleft();
        assertEq(amount, P1);
        _report("withdraw", used);
    }
}
