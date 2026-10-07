// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title  X429Queue
/// @notice Paid line-cutting for saturated services, settled in native USDC on Arc.
///
///         x429 turns "HTTP 429 Too Many Requests" into an onchain queue:
///         1. A rate-limited client joins the queue and posts a skip price: the native USDC it wants
///            for being pushed back one position (native USDC has 18 decimals on Arc).
///         2. Anyone may move ahead, but pays every ticket it passes that ticket's own skip price,
///            in the same transaction. `msg.value` is the budget; whatever is not spent is refunded.
///         3. The queue operator (the service) serves tickets strictly from the head.
///
///         Nobody can be passed for less than the price they chose, so with honest prices every
///         overtake leaves all parties at least as well off. The contract takes no fee.
///         Compensation is credited to `claimable` (pull payments) so that no recipient can block an
///         overtake; `withdraw` / `withdrawFor` pay it out.
contract X429Queue {
    enum Status {
        None,
        Waiting,
        Served,
        Left,
        Kicked
    }

    struct Ticket {
        // slot 0
        address owner;
        uint32 queueId;
        Status status;
        uint24 timesPassed;
        uint32 joinedAt;
        // slot 1
        uint64 prev; // neighbour towards the head, 0 if this ticket is the head
        uint64 next; // neighbour towards the tail, 0 if this ticket is the tail
        uint128 skipPrice; // native USDC (18 decimals) owed to this ticket per position it is pushed back
        // slot 2
        uint128 earned; // total received for being passed
        uint128 paid; // total paid to move ahead
    }

    struct Queue {
        // slot 0
        address operator;
        uint32 length;
        uint32 maxLength;
        uint32 overtakes;
        // slot 1
        uint64 head;
        uint64 tail;
        uint64 joined;
        uint64 served;
        // slot 2
        uint128 totalCompensation;
        // slot 3
        string meta;
    }

    struct TicketView {
        uint64 id;
        address owner;
        uint128 skipPrice;
        uint32 joinedAt;
        uint24 timesPassed;
        uint128 earned;
        uint128 paid;
    }

    uint32 public constant MAX_QUEUE_LENGTH = 1024;
    uint32 public constant MAX_PASS_PER_TX = 64;

    uint32 public queueCount;
    uint64 public ticketCount;
    mapping(uint32 => Queue) private _queues;
    mapping(uint64 => Ticket) public tickets;
    mapping(address => uint256) public claimable;
    uint256 private _locked = 1;

    event QueueCreated(uint32 indexed queueId, address indexed operator, uint32 maxLength, string meta);
    event OperatorChanged(uint32 indexed queueId, address indexed operator);
    event Joined(
        uint32 indexed queueId, uint64 indexed ticketId, address indexed owner, uint128 skipPrice, uint32 position
    );
    event SkipPriceSet(uint32 indexed queueId, uint64 indexed ticketId, uint128 skipPrice);
    event Passed(
        uint32 indexed queueId, uint64 indexed passedTicketId, address indexed passedOwner, uint64 byTicketId, uint128 amount
    );
    event Overtook(uint32 indexed queueId, uint64 indexed ticketId, address indexed owner, uint32 positions, uint256 paid);
    event Served(
        uint32 indexed queueId,
        uint64 indexed ticketId,
        address indexed owner,
        uint32 waited,
        uint24 timesPassed,
        uint128 earned,
        uint128 paid
    );
    event Left(uint32 indexed queueId, uint64 indexed ticketId, address indexed owner, bool kicked);
    event Withdrawn(address indexed owner, address indexed caller, uint256 amount);

    error UnknownQueue();
    error InvalidOperator();
    error InvalidMaxLength();
    error NotOperator();
    error NotTicketOwner();
    error NotWaiting();
    error QueueFull();
    error InvalidPositions();
    error NothingPassed();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------ queues

    /// @notice Open a queue for a service. `operator` is the only account that can serve it.
    function createQueue(address operator, uint32 maxLength, string calldata meta) external returns (uint32 queueId) {
        if (operator == address(0)) revert InvalidOperator();
        if (maxLength == 0 || maxLength > MAX_QUEUE_LENGTH) revert InvalidMaxLength();
        queueId = ++queueCount;
        Queue storage q = _queues[queueId];
        q.operator = operator;
        q.maxLength = maxLength;
        q.meta = meta;
        emit QueueCreated(queueId, operator, maxLength, meta);
    }

    function setOperator(uint32 queueId, address operator) external {
        Queue storage q = _queue(queueId);
        if (msg.sender != q.operator) revert NotOperator();
        if (operator == address(0)) revert InvalidOperator();
        q.operator = operator;
        emit OperatorChanged(queueId, operator);
    }

    // ------------------------------------------------------------------ clients

    /// @notice Join the tail of a queue. `skipPrice` is what you are paid each time someone passes you.
    function join(uint32 queueId, uint128 skipPrice) external returns (uint64 ticketId) {
        ticketId = _join(queueId, skipPrice);
    }

    /// @notice Join and immediately move ahead as far as `msg.value` pays for (at most `maxPositions`).
    ///         Joining succeeds even if the budget does not cover a single position; unspent value is refunded.
    function joinAndOvertake(uint32 queueId, uint128 skipPrice, uint32 maxPositions)
        external
        payable
        nonReentrant
        returns (uint64 ticketId, uint32 passed, uint256 paid)
    {
        ticketId = _join(queueId, skipPrice);
        (passed, paid) = _overtake(ticketId, maxPositions, msg.value);
        _refund(msg.value - paid);
    }

    /// @notice Move your ticket ahead, paying each ticket you pass its own skip price.
    ///         Passes tickets one by one from the one directly ahead, while the running total stays within
    ///         `msg.value` and at most `maxPositions` are passed. Reverts if nothing could be passed.
    function overtake(uint64 ticketId, uint32 maxPositions)
        external
        payable
        nonReentrant
        returns (uint32 passed, uint256 paid)
    {
        _ownedWaiting(ticketId);
        (passed, paid) = _overtake(ticketId, maxPositions, msg.value);
        if (passed == 0) revert NothingPassed();
        _refund(msg.value - paid);
    }

    function setSkipPrice(uint64 ticketId, uint128 skipPrice) external {
        Ticket storage t = _ownedWaiting(ticketId);
        t.skipPrice = skipPrice;
        emit SkipPriceSet(t.queueId, ticketId, skipPrice);
    }

    function leave(uint64 ticketId) external {
        Ticket storage t = _ownedWaiting(ticketId);
        _remove(t, Status.Left);
        emit Left(t.queueId, ticketId, msg.sender, false);
    }

    /// @notice Withdraw your accumulated compensation (and any refund that could not be pushed).
    function withdraw() external nonReentrant returns (uint256) {
        return _payout(msg.sender);
    }

    /// @notice Push `owner`'s claimable balance to `owner`. Anyone may call; funds only go to the owner.
    function withdrawFor(address owner) external nonReentrant returns (uint256) {
        return _payout(owner);
    }

    // ------------------------------------------------------------------ operator

    /// @notice Serve up to `count` tickets from the head, in order.
    function serve(uint32 queueId, uint32 count) external returns (uint32 servedCount) {
        Queue storage q = _queue(queueId);
        if (msg.sender != q.operator) revert NotOperator();
        while (servedCount < count) {
            uint64 id = q.head;
            if (id == 0) break;
            Ticket storage t = tickets[id];
            _unlink(q, t);
            t.status = Status.Served;
            unchecked {
                --q.length;
                ++q.served;
                ++servedCount;
            }
            emit Served(queueId, id, t.owner, uint32(block.timestamp) - t.joinedAt, t.timesPassed, t.earned, t.paid);
        }
    }

    /// @notice Remove a waiting ticket (spam control). The ticket keeps whatever it already earned.
    function kick(uint64 ticketId) external {
        Ticket storage t = tickets[ticketId];
        if (t.status != Status.Waiting) revert NotWaiting();
        if (msg.sender != _queues[t.queueId].operator) revert NotOperator();
        _remove(t, Status.Kicked);
        emit Left(t.queueId, ticketId, t.owner, true);
    }

    // ------------------------------------------------------------------ views

    function queueInfo(uint32 queueId) external view returns (Queue memory) {
        return _queue(queueId);
    }

    /// @notice Waiting tickets in serving order (index 0 is served next).
    function getQueue(uint32 queueId, uint32 offset, uint32 limit) external view returns (TicketView[] memory list) {
        Queue storage q = _queue(queueId);
        uint256 len = q.length;
        if (offset >= len) return new TicketView[](0);
        uint256 n = len - offset;
        if (n > limit) n = limit;
        list = new TicketView[](n);
        uint64 id = q.head;
        for (uint256 i = 0; i < offset; ++i) {
            id = tickets[id].next;
        }
        for (uint256 i = 0; i < n; ++i) {
            Ticket storage t = tickets[id];
            list[i] = TicketView(id, t.owner, t.skipPrice, t.joinedAt, t.timesPassed, t.earned, t.paid);
            id = t.next;
        }
    }

    /// @notice 1-based position of a waiting ticket, 0 if it is not waiting.
    function positionOf(uint64 ticketId) external view returns (uint32 position) {
        Ticket storage t = tickets[ticketId];
        if (t.status != Status.Waiting) return 0;
        position = 1;
        for (uint64 p = t.prev; p != 0; p = tickets[p].prev) {
            ++position;
        }
    }

    /// @notice How far `budget` would move a ticket, and what it would cost.
    ///         `ticketId == 0` quotes a new ticket joining at the tail (for joinAndOvertake).
    function quote(uint32 queueId, uint64 ticketId, uint32 maxPositions, uint256 budget)
        external
        view
        returns (uint32 passed, uint256 cost)
    {
        uint64 cursor;
        if (ticketId == 0) {
            cursor = _queue(queueId).tail;
        } else {
            Ticket storage t = tickets[ticketId];
            if (t.status != Status.Waiting || t.queueId != queueId) revert NotWaiting();
            cursor = t.prev;
        }
        while (cursor != 0 && passed < maxPositions) {
            Ticket storage a = tickets[cursor];
            if (cost + a.skipPrice > budget) break;
            cost += a.skipPrice;
            ++passed;
            cursor = a.prev;
        }
    }

    // ------------------------------------------------------------------ internals

    function _join(uint32 queueId, uint128 skipPrice) private returns (uint64 ticketId) {
        Queue storage q = _queue(queueId);
        if (q.length >= q.maxLength) revert QueueFull();
        ticketId = ++ticketCount;
        Ticket storage t = tickets[ticketId];
        t.owner = msg.sender;
        t.queueId = queueId;
        t.status = Status.Waiting;
        t.joinedAt = uint32(block.timestamp);
        t.skipPrice = skipPrice;
        uint64 tail = q.tail;
        if (tail == 0) {
            q.head = ticketId;
        } else {
            t.prev = tail;
            tickets[tail].next = ticketId;
        }
        q.tail = ticketId;
        uint32 position = ++q.length;
        unchecked {
            ++q.joined;
        }
        emit Joined(queueId, ticketId, msg.sender, skipPrice, position);
    }

    function _overtake(uint64 ticketId, uint32 maxPositions, uint256 budget)
        private
        returns (uint32 passed, uint256 paid)
    {
        if (maxPositions == 0 || maxPositions > MAX_PASS_PER_TX) revert InvalidPositions();
        Ticket storage t = tickets[ticketId];
        uint32 queueId = t.queueId;
        uint64 cursor = t.prev;
        uint64 furthest;
        while (cursor != 0 && passed < maxPositions) {
            Ticket storage a = tickets[cursor];
            uint128 price = a.skipPrice;
            if (paid + price > budget) break;
            paid += price;
            ++passed;
            a.earned += price;
            a.timesPassed += 1;
            claimable[a.owner] += price;
            emit Passed(queueId, cursor, a.owner, ticketId, price);
            furthest = cursor;
            cursor = a.prev;
        }
        if (passed == 0) return (0, 0);

        Queue storage q = _queues[queueId];
        _unlink(q, t);
        _insertBefore(q, ticketId, t, furthest);
        // casting to 'uint128' is safe because paid <= msg.value, far below 2**128 for any real USDC amount
        // forge-lint: disable-next-line(unsafe-typecast)
        t.paid += uint128(paid);
        // forge-lint: disable-next-line(unsafe-typecast)
        q.totalCompensation += uint128(paid);
        unchecked {
            ++q.overtakes;
        }
        emit Overtook(queueId, ticketId, t.owner, passed, paid);
    }

    function _remove(Ticket storage t, Status status) private {
        Queue storage q = _queues[t.queueId];
        _unlink(q, t);
        t.status = status;
        unchecked {
            --q.length;
        }
    }

    function _unlink(Queue storage q, Ticket storage t) private {
        uint64 p = t.prev;
        uint64 n = t.next;
        if (p == 0) q.head = n;
        else tickets[p].next = n;
        if (n == 0) q.tail = p;
        else tickets[n].prev = p;
        t.prev = 0;
        t.next = 0;
    }

    function _insertBefore(Queue storage q, uint64 id, Ticket storage t, uint64 beforeId) private {
        Ticket storage b = tickets[beforeId];
        uint64 p = b.prev;
        t.prev = p;
        t.next = beforeId;
        b.prev = id;
        if (p == 0) q.head = id;
        else tickets[p].next = id;
    }

    function _refund(uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) claimable[msg.sender] += amount;
    }

    function _payout(address owner) private returns (uint256 amount) {
        amount = claimable[owner];
        if (amount == 0) revert NothingToWithdraw();
        claimable[owner] = 0;
        emit Withdrawn(owner, msg.sender, amount);
        // funds only ever go to the address they were credited to
        // forge-lint: disable-next-line(arbitrary-send-eth)
        (bool ok,) = payable(owner).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _queue(uint32 queueId) private view returns (Queue storage q) {
        q = _queues[queueId];
        if (q.operator == address(0)) revert UnknownQueue();
    }

    function _ownedWaiting(uint64 ticketId) private view returns (Ticket storage t) {
        t = tickets[ticketId];
        if (t.status != Status.Waiting) revert NotWaiting();
        if (t.owner != msg.sender) revert NotTicketOwner();
    }
}
