// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {X429Queue} from "../src/X429Queue.sol";

// =====================================================================================================
//                                      ETH-rejecting actor
// =====================================================================================================

/// @dev A ticket holder that rejects every plain native transfer: its refunds get credited to claimable
///      and its withdrawals revert with TransferFailed.
contract RejectingActor {
    X429Queue internal immutable queue;

    constructor(X429Queue queue_) {
        queue = queue_;
    }

    receive() external payable {
        revert("RejectingActor: no native transfers");
    }

    function join(uint32 queueId, uint128 price) external returns (uint64) {
        return queue.join(queueId, price);
    }

    function joinAndOvertake(uint32 queueId, uint128 price, uint32 maxPositions, uint256 value)
        external
        returns (uint64, uint32, uint256)
    {
        return queue.joinAndOvertake{value: value}(queueId, price, maxPositions);
    }

    function overtake(uint64 ticketId, uint32 maxPositions, uint256 value) external returns (uint32, uint256) {
        return queue.overtake{value: value}(ticketId, maxPositions);
    }

    function setSkipPrice(uint64 ticketId, uint128 price) external {
        queue.setSkipPrice(ticketId, price);
    }

    function leave(uint64 ticketId) external {
        queue.leave(ticketId);
    }

    function withdraw() external returns (uint256) {
        return queue.withdraw();
    }
}

// =====================================================================================================
//                                             handler
// =====================================================================================================

contract Handler is CommonBase, StdCheats, StdUtils {
    X429Queue public immutable queue;
    RejectingActor public immutable rejecter;

    uint256 internal constant MAX_PRICE = 1e16;
    uint256 internal constant MAX_BUDGET = 5e16;

    address[] internal _actors; // EOAs + the rejecting contract
    uint32[] internal _queueIds;
    uint64[] internal _tickets;

    // ------------------------------------------------------------------ ghost variables
    uint256 public ghostJoined;
    uint256 public ghostPaid; // sum of `paid` returned to movers
    uint256 public ghostEarned; // sum of Passed amounts (credited to passed tickets)
    uint256 public ghostOvertakes; // successful overtakes (incl. joinAndOvertake with >= 1 pass)
    uint256 public ghostWithdrawn;
    uint256 public ghostMismatches; // handler-level consistency failures (asserted == 0 by an invariant)
    mapping(uint32 => uint256) public ghostServed;
    mapping(uint32 => uint256) public ghostRemoved; // left + kicked

    // ------------------------------------------------------------------ call counters
    uint256 public nJoin;
    uint256 public nJoinAndOvertake;
    uint256 public nJoinAndOvertakeNoPass;
    uint256 public nOvertake;
    uint256 public nPasses;
    uint256 public nSetSkipPrice;
    uint256 public nLeave;
    uint256 public nKick;
    uint256 public nServeCalls;
    uint256 public nWithdraw;
    uint256 public nWithdrawRejected;
    uint256 public nRefundCredited;
    uint256 public nSkipped;

    constructor(X429Queue queue_, uint32[] memory queueIds_, address[] memory eoas) {
        queue = queue_;
        rejecter = new RejectingActor(queue_);
        _queueIds = queueIds_;
        for (uint256 i; i < eoas.length; ++i) {
            _actors.push(eoas[i]);
        }
        _actors.push(address(rejecter));
    }

    // ------------------------------------------------------------------ actions

    /// @dev Joins 1..4 tickets (different actors/prices) to keep the queues deep enough for overtakes.
    function join(uint256 actorSeed, uint256 queueSeed, uint256 priceSeed) external {
        uint32 queueId = _queueId(queueSeed);
        if (_isFull(queueId)) return _skip();
        uint256 count = 1 + (actorSeed >> 128) % 4;
        for (uint256 i; i < count && !_isFull(queueId); ++i) {
            address actor = _actor(actorSeed % _actors.length + i);
            uint64 id = _joinAs(actor, queueId, _price(uint256(keccak256(abi.encode(priceSeed, i)))));
            _tickets.push(id);
            ++ghostJoined;
            ++nJoin;
        }
    }

    function joinAndOvertake(
        uint256 actorSeed,
        uint256 queueSeed,
        uint256 priceSeed,
        uint256 maxPosSeed,
        uint256 budgetSeed
    ) external {
        Move memory mv;
        mv.mover = _actor(actorSeed);
        uint32 queueId = _queueId(queueSeed);
        if (_isFull(queueId)) return _skip();
        mv.maxPositions = uint32(_bound(maxPosSeed, 1, 64));
        mv.budget = _bound(budgetSeed, 0, MAX_BUDGET);
        (mv.qPassed, mv.qCost) = queue.quote(queueId, 0, mv.maxPositions, mv.budget);
        mv.claimBefore = queue.claimable(mv.mover);

        _fund(mv.mover, mv.budget);
        vm.recordLogs();
        uint64 id;
        (id, mv.passed, mv.paid) = _joinAndOvertakeAs(mv, queueId, _price(priceSeed));
        _afterMove(mv);

        _tickets.push(id);
        ++ghostJoined;
        ++nJoinAndOvertake;
        if (mv.passed == 0) ++nJoinAndOvertakeNoPass;
    }

    function overtake(uint256 ticketSeed, uint256 maxPosSeed, uint256 budgetSeed) external {
        (bool found, uint64 id) = _findWaiting(ticketSeed, true);
        if (!found) return _skip();
        X429Queue.Ticket memory t = _ticket(id);
        Move memory mv;
        mv.mover = t.owner;
        mv.maxPositions = uint32(_bound(maxPosSeed, 1, 64));
        mv.budget = _bound(budgetSeed, 0, MAX_BUDGET);
        (mv.qPassed, mv.qCost) = queue.quote(t.queueId, id, mv.maxPositions, mv.budget);
        if (mv.qPassed == 0) {
            // make sure at least the ticket directly ahead is affordable
            mv.budget += _ticket(t.prev).skipPrice;
            (mv.qPassed, mv.qCost) = queue.quote(t.queueId, id, mv.maxPositions, mv.budget);
        }
        mv.claimBefore = queue.claimable(mv.mover);

        _fund(mv.mover, mv.budget);
        vm.recordLogs();
        (mv.passed, mv.paid) = _overtakeAs(mv, id);
        _afterMove(mv);
        ++nOvertake;
    }

    function setSkipPrice(uint256 ticketSeed, uint256 priceSeed) external {
        (bool found, uint64 id) = _findWaiting(ticketSeed, false);
        if (!found) return _skip();
        address owner = _ticket(id).owner;
        uint128 price = _price(priceSeed);
        if (owner == address(rejecter)) {
            rejecter.setSkipPrice(id, price);
        } else {
            vm.prank(owner);
            queue.setSkipPrice(id, price);
        }
        ++nSetSkipPrice;
    }

    function leave(uint256 ticketSeed) external {
        (bool found, uint64 id) = _findWaiting(ticketSeed, false);
        if (!found) return _skip();
        X429Queue.Ticket memory t = _ticket(id);
        if (t.owner == address(rejecter)) {
            rejecter.leave(id);
        } else {
            vm.prank(t.owner);
            queue.leave(id);
        }
        ++ghostRemoved[t.queueId];
        ++nLeave;
    }

    function kick(uint256 ticketSeed) external {
        (bool found, uint64 id) = _findWaiting(ticketSeed, false);
        if (!found) return _skip();
        uint32 queueId = _ticket(id).queueId;
        vm.prank(queue.queueInfo(queueId).operator);
        queue.kick(id);
        ++ghostRemoved[queueId];
        ++nKick;
    }

    function serve(uint256 queueSeed, uint256 countSeed) external {
        uint32 queueId = _queueId(queueSeed);
        uint32 count = uint32(_bound(countSeed, 0, 2));
        uint32 expected = queue.queueInfo(queueId).length;
        if (count < expected) expected = count;
        vm.prank(queue.queueInfo(queueId).operator);
        uint32 served = queue.serve(queueId, count);
        if (served != expected) ++ghostMismatches;
        ghostServed[queueId] += served;
        ++nServeCalls;
    }

    function withdraw(uint256 actorSeed, uint256 callerSeed) external {
        address actor = _actor(actorSeed);
        uint256 amount = queue.claimable(actor);
        if (amount == 0) return _skip();
        bool viaFor = callerSeed % 2 == 1;
        address caller = _actor(callerSeed >> 1);

        if (actor == address(rejecter)) {
            // the payout cannot be delivered: must revert with TransferFailed and keep the balance
            bool reverted;
            if (viaFor) {
                vm.prank(caller);
                try queue.withdrawFor(actor) {}
                catch (bytes memory err) {
                    reverted = bytes4(err) == X429Queue.TransferFailed.selector;
                }
            } else {
                try rejecter.withdraw() {}
                catch (bytes memory err) {
                    reverted = bytes4(err) == X429Queue.TransferFailed.selector;
                }
            }
            if (!reverted || queue.claimable(actor) != amount) ++ghostMismatches;
            ++nWithdrawRejected;
            return;
        }

        uint256 balBefore = actor.balance;
        uint256 got;
        if (viaFor) {
            vm.prank(caller);
            got = queue.withdrawFor(actor);
        } else {
            vm.prank(actor);
            got = queue.withdraw();
        }
        if (got != amount || actor.balance != balBefore + amount || queue.claimable(actor) != 0) {
            ++ghostMismatches;
        }
        ghostWithdrawn += amount;
        ++nWithdraw;
    }

    // ------------------------------------------------------------------ views for the invariant test

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    function queueIds() external view returns (uint32[] memory) {
        return _queueIds;
    }

    function ticketsCreated() external view returns (uint256) {
        return _tickets.length;
    }

    // ------------------------------------------------------------------ internals

    struct Move {
        address mover;
        uint32 maxPositions;
        uint256 budget;
        uint32 qPassed; // quoted before the move
        uint256 qCost;
        uint256 claimBefore;
        uint32 passed; // returned by the move
        uint256 paid;
    }

    function _afterMove(Move memory mv) internal {
        (uint256 earned, uint256 passedLogs, uint256 selfEarned) = _passedFromLogs(mv.mover);
        if (mv.passed != mv.qPassed || mv.paid != mv.qCost) ++ghostMismatches; // quote must predict the move
        if (passedLogs != mv.passed || earned != mv.paid || mv.paid > mv.budget) ++ghostMismatches;

        uint256 claimDelta = queue.claimable(mv.mover) - mv.claimBefore;
        if (claimDelta > selfEarned) {
            // the refund push failed and was credited instead (only possible for the rejecting actor)
            if (claimDelta - selfEarned != mv.budget - mv.paid || mv.mover != address(rejecter)) ++ghostMismatches;
            ++nRefundCredited;
        } else if (claimDelta != selfEarned) {
            ++ghostMismatches;
        }

        ghostPaid += mv.paid;
        ghostEarned += earned;
        if (mv.passed > 0) ++ghostOvertakes;
        nPasses += mv.passed;
    }

    function _passedFromLogs(address mover) internal view returns (uint256 sum, uint256 count, uint256 toMover) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 moverTopic = bytes32(uint256(uint160(mover)));
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(queue) || logs[i].topics[0] != X429Queue.Passed.selector) continue;
            (, uint128 amount) = abi.decode(logs[i].data, (uint64, uint128));
            sum += amount;
            ++count;
            if (logs[i].topics[3] == moverTopic) toMover += amount;
        }
    }

    function _joinAs(address actor, uint32 queueId, uint128 price) internal returns (uint64) {
        if (actor == address(rejecter)) return rejecter.join(queueId, price);
        vm.prank(actor);
        return queue.join(queueId, price);
    }

    function _joinAndOvertakeAs(Move memory mv, uint32 queueId, uint128 price)
        internal
        returns (uint64, uint32, uint256)
    {
        if (mv.mover == address(rejecter)) {
            return rejecter.joinAndOvertake(queueId, price, mv.maxPositions, mv.budget);
        }
        vm.prank(mv.mover);
        return queue.joinAndOvertake{value: mv.budget}(queueId, price, mv.maxPositions);
    }

    function _overtakeAs(Move memory mv, uint64 id) internal returns (uint32, uint256) {
        if (mv.mover == address(rejecter)) return rejecter.overtake(id, mv.maxPositions, mv.budget);
        vm.prank(mv.mover);
        return queue.overtake{value: mv.budget}(id, mv.maxPositions);
    }

    function _fund(address actor, uint256 amount) internal {
        vm.deal(actor, actor.balance + amount);
    }

    function _findWaiting(uint256 seed, bool notHead) internal view returns (bool, uint64) {
        uint256 len = _tickets.length;
        if (len == 0) return (false, 0);
        uint256 start = seed % len;
        for (uint256 j; j < len; ++j) {
            uint64 id = _tickets[(start + j) % len];
            X429Queue.Ticket memory t = _ticket(id);
            if (t.status == X429Queue.Status.Waiting && (!notHead || t.prev != 0)) return (true, id);
        }
        return (false, 0);
    }

    function _ticket(uint64 id) internal view returns (X429Queue.Ticket memory t) {
        (bool ok, bytes memory ret) = address(queue).staticcall(abi.encodeWithSelector(queue.tickets.selector, id));
        require(ok, "tickets() failed");
        t = abi.decode(ret, (X429Queue.Ticket));
    }

    function _isFull(uint32 queueId) internal view returns (bool) {
        X429Queue.Queue memory info = queue.queueInfo(queueId);
        return info.length >= info.maxLength;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _queueId(uint256 seed) internal view returns (uint32) {
        return _queueIds[seed % _queueIds.length];
    }

    function _price(uint256 seed) internal pure returns (uint128) {
        if (seed % 5 == 0) return 0; // free tickets now and then
        return uint128(_bound(seed, 1, MAX_PRICE));
    }

    function _skip() internal {
        ++nSkipped;
    }
}

// =====================================================================================================
//                                          invariant test
// =====================================================================================================

contract X429QueueInvariantTest is Test {
    X429Queue internal queue;
    Handler internal handler;
    uint32[] internal queueIds;
    address[] internal holders;

    function setUp() public {
        vm.warp(1_700_000_000);
        queue = new X429Queue();
        queueIds.push(queue.createQueue(makeAddr("operator1"), 64, '{"name":"q1"}'));
        queueIds.push(queue.createQueue(makeAddr("operator2"), 12, '{"name":"q2"}')); // small: QueueFull path

        address[] memory eoas = new address[](4);
        eoas[0] = makeAddr("alice");
        eoas[1] = makeAddr("bob");
        eoas[2] = makeAddr("carol");
        eoas[3] = makeAddr("dave");
        handler = new Handler(queue, queueIds, eoas);
        holders = handler.actors();

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = Handler.join.selector;
        selectors[1] = Handler.joinAndOvertake.selector;
        selectors[2] = Handler.overtake.selector;
        selectors[3] = Handler.setSkipPrice.selector;
        selectors[4] = Handler.leave.selector;
        selectors[5] = Handler.kick.selector;
        selectors[6] = Handler.serve.selector;
        selectors[7] = Handler.withdraw.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _ticket(uint64 id) internal view returns (X429Queue.Ticket memory t) {
        (bool ok, bytes memory ret) = address(queue).staticcall(abi.encodeWithSelector(queue.tickets.selector, id));
        require(ok, "tickets() failed");
        t = abi.decode(ret, (X429Queue.Ticket));
    }

    // ------------------------------------------------------------------ invariants

    /// @dev Walking from head visits exactly `length` tickets with symmetric links; tail is the last one;
    ///      every visited ticket is Waiting in this queue; getQueue returns the same order.
    function invariant_linkedListConsistent() public view {
        for (uint256 k; k < queueIds.length; ++k) {
            uint32 queueId = queueIds[k];
            X429Queue.Queue memory info = queue.queueInfo(queueId);
            X429Queue.TicketView[] memory view_ = queue.getQueue(queueId, 0, type(uint32).max);
            assertEq(view_.length, info.length, "getQueue length");

            uint64 prev;
            uint64 id = info.head;
            uint256 count;
            while (id != 0) {
                assertLt(count, info.length, "walk exceeds length (cycle?)");
                X429Queue.Ticket memory t = _ticket(id);
                assertEq(uint8(t.status), uint8(X429Queue.Status.Waiting), "visited ticket not waiting");
                assertEq(t.queueId, queueId, "visited ticket in wrong queue");
                assertEq(t.prev, prev, "prev/next asymmetric");
                assertEq(view_[count].id, id, "getQueue order");
                prev = id;
                id = t.next;
                ++count;
            }
            assertEq(count, info.length, "walk length");
            assertEq(info.tail, prev, "tail is last visited");
            if (info.length == 0) assertEq(info.head, 0, "empty head");
            assertEq(
                uint256(info.length),
                uint256(info.joined) - info.served - handler.ghostRemoved(queueId),
                "length == joined - served - removed"
            );
            assertEq(info.served, handler.ghostServed(queueId), "served counter");
        }
    }

    /// @dev No waiting ticket exists outside the lists.
    function invariant_waitingTicketsAreAllLinked() public view {
        uint256 total = queue.ticketCount();
        uint256 waiting;
        for (uint64 id = 1; id <= total; ++id) {
            if (_ticket(id).status == X429Queue.Status.Waiting) ++waiting;
        }
        uint256 lengths;
        for (uint256 k; k < queueIds.length; ++k) {
            lengths += queue.queueInfo(queueIds[k]).length;
        }
        assertEq(waiting, lengths, "waiting tickets == sum of lengths");
    }

    function invariant_solvency() public view {
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            sum += queue.claimable(holders[i]);
        }
        assertEq(address(queue).balance, sum, "balance == sum(claimable)");
    }

    function invariant_compensationAccounting() public view {
        uint256 totalCompensation;
        uint256 overtakes;
        for (uint256 k; k < queueIds.length; ++k) {
            X429Queue.Queue memory info = queue.queueInfo(queueIds[k]);
            totalCompensation += info.totalCompensation;
            overtakes += info.overtakes;
        }
        assertEq(totalCompensation, handler.ghostPaid(), "sum(totalCompensation) == ghostPaid");
        assertEq(handler.ghostPaid(), handler.ghostEarned(), "ghostPaid == ghostEarned");
        assertEq(overtakes, handler.ghostOvertakes(), "overtake counters");

        uint256 earned;
        uint256 paid;
        uint256 total = queue.ticketCount();
        for (uint64 id = 1; id <= total; ++id) {
            X429Queue.Ticket memory t = _ticket(id);
            earned += t.earned;
            paid += t.paid;
        }
        assertEq(earned, handler.ghostEarned(), "sum(ticket.earned)");
        assertEq(paid, handler.ghostPaid(), "sum(ticket.paid)");
    }

    function invariant_ticketCount() public view {
        assertEq(queue.ticketCount(), handler.ghostJoined(), "ticketCount == ghostJoined");
        uint256 joined;
        for (uint256 k; k < queueIds.length; ++k) {
            joined += queue.queueInfo(queueIds[k]).joined;
        }
        assertEq(joined, handler.ghostJoined(), "sum(joined) == ghostJoined");
    }

    function invariant_handlerSawNoMismatch() public view {
        assertEq(handler.ghostMismatches(), 0, "handler-level mismatch (quote/logs/refund/withdraw)");
    }

    /// @dev Every invariant run starts from the setUp snapshot, so per-run counters reset. To report campaign
    ///      totals, accumulate them in process env vars (which survive the EVM state reset) after each run.
    ///      Diagnostics only (nothing asserts on them). Exact with forge >= 1.8, which runs all invariants in
    ///      one shared campaign; older runners (e.g. arc-forge 1.7.x) run one campaign per invariant function,
    ///      so the totals then aggregate over all of those campaigns.
    function afterInvariant() public {
        uint256 runs = _accumulate("X429_INV_TOTAL_RUNS", 1);
        uint256 overtakes = _accumulate("X429_INV_TOTAL_OVERTAKES", handler.ghostOvertakes());
        uint256 passes = _accumulate("X429_INV_TOTAL_PASSES", handler.nPasses());
        uint256 credited = _accumulate("X429_INV_TOTAL_REFUNDS_CREDITED", handler.nRefundCredited());
        uint256 withdrawals = _accumulate("X429_INV_TOTAL_WITHDRAWALS", handler.nWithdraw());
        uint256 rejected = _accumulate("X429_INV_TOTAL_WITHDRAW_REJECTED", handler.nWithdrawRejected());
        if (runs % 64 == 0) {
            console.log("campaign totals after runs:", runs);
            console.log("  successful overtakes    ", overtakes);
            console.log("  positions passed        ", passes);
            console.log("  refunds credited        ", credited);
            console.log("  withdrawals ok          ", withdrawals);
            console.log("  withdrawals rejected    ", rejected);
        }
    }

    function _accumulate(string memory key, uint256 amount) internal returns (uint256 total) {
        total = vm.envOr(key, uint256(0)) + amount;
        vm.setEnv(key, vm.toString(total));
    }

    function invariant_callSummary() public view {
        console.log("-- x429 campaign totals (completed runs) --");
        console.log("runs                 ", vm.envOr("X429_INV_TOTAL_RUNS", uint256(0)));
        console.log("successful overtakes ", vm.envOr("X429_INV_TOTAL_OVERTAKES", uint256(0)));
        console.log("positions passed     ", vm.envOr("X429_INV_TOTAL_PASSES", uint256(0)));
        console.log("refunds credited     ", vm.envOr("X429_INV_TOTAL_REFUNDS_CREDITED", uint256(0)));
        console.log("withdrawals ok       ", vm.envOr("X429_INV_TOTAL_WITHDRAWALS", uint256(0)));
        console.log("withdrawals rejected ", vm.envOr("X429_INV_TOTAL_WITHDRAW_REJECTED", uint256(0)));
        _logRunSummary();
    }

    function _logRunSummary() internal view {
        console.log("-- x429 handler call summary (this run) --");
        console.log("join                 ", handler.nJoin());
        console.log("joinAndOvertake      ", handler.nJoinAndOvertake());
        console.log("  of which no pass   ", handler.nJoinAndOvertakeNoPass());
        console.log("overtake             ", handler.nOvertake());
        console.log("successful overtakes ", handler.ghostOvertakes());
        console.log("positions passed     ", handler.nPasses());
        console.log("setSkipPrice         ", handler.nSetSkipPrice());
        console.log("leave                ", handler.nLeave());
        console.log("kick                 ", handler.nKick());
        console.log("serve calls          ", handler.nServeCalls());
        console.log("withdraw ok          ", handler.nWithdraw());
        console.log("withdraw rejected    ", handler.nWithdrawRejected());
        console.log("refunds credited     ", handler.nRefundCredited());
        console.log("skipped (no target)  ", handler.nSkipped());
        console.log("ghostPaid            ", handler.ghostPaid());
    }

    // ------------------------------------------------------------------ deterministic handler smoke test

    /// @dev Drives the handler with a fixed pseudo-random sequence, checks every action kind is exercised
    ///      (overtakes, credited refunds, rejected withdrawals...) and that the invariants hold at the end.
    function test_handlerSmoke_exercisesEveryAction() public {
        uint256 seed = 429;
        for (uint256 step; step < 600; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 a = uint256(keccak256(abi.encode(seed, 1)));
            uint256 b = uint256(keccak256(abi.encode(seed, 2)));
            uint256 c = uint256(keccak256(abi.encode(seed, 3)));
            uint256 action = seed % 16;
            if (action < 3) handler.join(a, b, c);
            else if (action < 6) handler.joinAndOvertake(a, b, c, a >> 128, b >> 128);
            else if (action < 9) handler.overtake(a, b, c);
            else if (action < 10) handler.setSkipPrice(a, b);
            else if (action < 11) handler.leave(a);
            else if (action < 12) handler.kick(a);
            else if (action < 14) handler.serve(a, b);
            else handler.withdraw(a, b);
        }
        _logRunSummary();
        assertGt(handler.ghostOvertakes(), 0, "overtakes");
        assertGt(handler.nOvertake(), 0, "overtake()");
        assertGt(handler.nJoinAndOvertake() - handler.nJoinAndOvertakeNoPass(), 0, "joinAndOvertake with passes");
        assertGt(handler.nJoinAndOvertakeNoPass(), 0, "joinAndOvertake without passes");
        assertGt(handler.nRefundCredited(), 0, "refund credited to rejecting actor");
        assertGt(handler.nWithdraw(), 0, "withdrawals");
        assertGt(handler.nWithdrawRejected(), 0, "rejected withdrawals");
        assertGt(handler.nLeave() + handler.nKick(), 0, "removals");
        invariant_linkedListConsistent();
        invariant_waitingTicketsAreAllLinked();
        invariant_solvency();
        invariant_compensationAccounting();
        invariant_ticketCount();
        invariant_handlerSawNoMismatch();
    }
}
