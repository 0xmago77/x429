# x429 v0.1

x429 settles HTTP `429 Too Many Requests` onchain. A saturated service answers 429 with a
descriptor of an onchain queue. Clients join that queue with a **skip price**. Anyone may move
ahead, but must pay **every ticket they pass, at that ticket's own posted skip price**, in the
same transaction. The service serves the queue strictly from the head. A served ticket redeems
one request, authenticated by a signature from the ticket owner.

The reference deployment runs on **Arc mainnet** (`eip155:5042`), where the native gas token is
USDC with 18 decimals. All amounts in this document are native-USDC wei (18 decimals).

Key words MUST, SHOULD and MAY are used as in RFC 2119.

---

## 1. The 429 response

A server that cannot admit a request right now responds:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Retry-After: 18
X-429-Network: eip155:5042
X-429-Queue: 0x5FbDB2315678afecb367f032d93F642f64180aa3/1
```

```json
{
  "error": "too_many_requests",
  "x429": {
    "version": "0.1",
    "network": "eip155:5042",
    "chainId": 5042,
    "contract": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "queueId": 1,
    "queueLength": 6,
    "serviceIntervalMs": 15000,
    "admissionTtlMs": 60000,
    "suggestedSkipPrice": "2000000000000000",
    "currency": { "symbol": "USDC", "decimals": 18 },
    "signature": "x429:v1:5042:0x5fbdb2315678afecb367f032d93f642f64180aa3:<ticketId>",
    "ticket": null
  }
}
```

| Header | Meaning |
|---|---|
| `Retry-After` | Seconds. For a fresh request: the expected wait if you queue now (`busy time left + queueLength × serviceInterval`). For a waiting ticket: the expected wait at its position. Always ≥ 1. |
| `X-429-Network` | CAIP-2 id of the chain that hosts the queue. |
| `X-429-Queue` | `<contract>/<queueId>`. |

### 1.1 Descriptor schema

| Field | Type | Meaning |
|---|---|---|
| `version` | string | `"0.1"`. |
| `network` | string | CAIP-2 chain id, `eip155:<chainId>`. |
| `chainId` | number | EVM chain id. |
| `contract` | address | The `X429Queue` contract. |
| `queueId` | number | Queue id inside the contract. |
| `queueLength` | number | Waiting tickets, as last observed by the server. |
| `serviceIntervalMs` | number | The service admits one request per interval. |
| `admissionTtlMs` | number | How long a served ticket may take to redeem its request. |
| `suggestedSkipPrice` | string | Decimal wei. A hint for clients without a policy. |
| `currency` | object | `{symbol, decimals}` of the native token amounts. |
| `signature` | string | Template of the message to sign (§2). |
| `ticket` | object \| null | `null` for a request without ticket headers. Otherwise `{id, status, position}`: `id` decimal string, `status` one of `waiting`, `serving`, and `position` 1-based (`0` while `serving`). |

JSON schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "x429 429 body",
  "type": "object",
  "required": ["error", "x429"],
  "properties": {
    "error": { "const": "too_many_requests" },
    "x429": {
      "type": "object",
      "required": ["version", "network", "chainId", "contract", "queueId", "queueLength", "serviceIntervalMs",
                   "admissionTtlMs", "suggestedSkipPrice", "currency", "signature", "ticket"],
      "properties": {
        "version": { "const": "0.1" },
        "network": { "type": "string", "pattern": "^eip155:[0-9]+$" },
        "chainId": { "type": "integer" },
        "contract": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
        "queueId": { "type": "integer", "minimum": 1 },
        "queueLength": { "type": "integer", "minimum": 0 },
        "serviceIntervalMs": { "type": "integer", "minimum": 1 },
        "admissionTtlMs": { "type": "integer", "minimum": 1 },
        "suggestedSkipPrice": { "type": "string", "pattern": "^[0-9]+$" },
        "currency": {
          "type": "object",
          "required": ["symbol", "decimals"],
          "properties": { "symbol": { "type": "string" }, "decimals": { "type": "integer" } }
        },
        "signature": { "type": "string" },
        "ticket": {
          "oneOf": [
            { "type": "null" },
            {
              "type": "object",
              "required": ["id", "status", "position"],
              "properties": {
                "id": { "type": "string", "pattern": "^[0-9]+$" },
                "status": { "enum": ["waiting", "serving"] },
                "position": { "type": "integer", "minimum": 0 }
              }
            }
          ]
        }
      }
    }
  }
}
```

`GET /x429` returns the bare descriptor object (the value of `x429` above, with `ticket: null`)
with status 200, so clients can discover the queue before they are limited.

## 2. Retry headers and the signature

After its ticket is served, the client repeats the original request with:

```
X-429-Ticket: <ticketId, decimal>
X-429-Signature: <0x-hex 65-byte EIP-191 personal_sign signature>
```

The signed message is exactly (ASCII, no trailing newline):

```
x429:v1:<chainId>:<contract lowercase 0x-hex>:<ticketId decimal>
```

e.g. `x429:v1:5042:0x5fbdb2315678afecb367f032d93f642f64180aa3:17`. The signature is checked with
EIP-191 recovery (`verifyMessage`) against the ticket's onchain `owner`. The message binds the
chain, the contract and the ticket, so a signature cannot be replayed on another deployment.
It carries no expiry: freshness comes from the admission window and single use (§3).

## 3. Admission rules

The server keeps a **busy-until clock** that models one service slot per `serviceIntervalMs`.
Every admission, direct or from the queue, sets `busyUntil = now + serviceIntervalMs`.

A request **without** ticket headers:

1. is admitted directly iff the onchain queue is empty, no serve transaction is in flight and
   `now ≥ busyUntil`;
2. otherwise gets **429** with the descriptor.

A request **with** ticket headers:

| Situation | Response |
|---|---|
| Malformed id or signature | **403** `malformed_ticket` |
| Ticket already redeemed, or its admission expired | **403** `ticket_used_or_expired` |
| Ticket has an admission and the signature recovers its owner | **admitted** (the admission is consumed; it can never be used again) |
| Ticket has an admission but the signature does not match | **403** `bad_signature` |
| Ticket unknown, or belongs to another queue | **403** `unknown_ticket` |
| Ticket is `Waiting` (valid signature) | **429** with `ticket {id, status:"waiting", position}` and a `Retry-After` for that position |
| Ticket was just served and the server is still processing that serve | **429** with `ticket {status:"serving"}`, `Retry-After: 1` |
| Ticket served, but not admitted by this server (e.g. served before a restart) | **403** `not_admitted` |
| Ticket `Left` / `Kicked` | **403** `ticket_left` / `ticket_kicked` |

403 bodies are `{"error":"forbidden","reason":"<reason>","x429":{…descriptor…}}`.

An admission is valid for `admissionTtlMs` after the serve, and is consumed by the first valid
request. Admissions live in the server's memory: a restart drops pending admissions (§7).

### 3.1 The admission round (`minQueueMs`)

The operator serves the head only after it has waited at least `minQueueMs` since its **own**
`joinedAt` (default: `serviceIntervalMs`). This is an **admission round**: anyone who arrives
during the round can still bid to move ahead of the head.

Without it, a request that joins an idle queue is served on the next tick, before anyone else
can even see it. Nobody could ever pass it, so its skip price would be meaningless. With the
round, a person who joins an idle queue has `minQueueMs` in which faster, more impatient
clients can pay them to step back. In the demo, a human joining wakes the bot swarm within
about 2 s, and its arrivals are spread over 12 s, inside the default 15 s round.

The round costs at most `minQueueMs` of latency for the head and none for a busy queue: when
tickets queue up for longer than the round anyway, the rule never binds.

## 4. Operator duties

The operator (the `operator` of the queue onchain, usually the service itself) MUST:

1. **Serve from the head only**, with `serve(queueId, 1)`, and only when the queue is non-empty,
   `now ≥ busyUntil`, and the head has waited at least `minQueueMs` (§3.1).
2. **Record admissions from the receipt.** It parses `Served` events from the serve receipt and
   records `{ticketId → owner, expiresAt = now + admissionTtlMs}`, then sets `busyUntil`.
3. **Redeem each admission once** (§3).
4. **Keep one transaction in flight per wallet.** It awaits each receipt before sending the
   next transaction. With fallback RPCs, two concurrent sends could otherwise read the same
   pending nonce from different providers.
5. **Pay enough fees.** On Arc the base fee floor is 20 gwei, and a transaction whose
   `maxFeePerGas` is below the floor is silently dropped. The reference code always sends
   `maxFeePerGas = 50 gwei` and `maxPriorityFeePerGas = 0.01 gwei`.
6. MAY `kick` spam tickets. Kicked tickets keep what they already earned.

The operator never handles compensation: it moves between clients inside the contract.

## 5. Client algorithm

On a 429 with an `x429` descriptor (reference: `x429Fetch` in `sdk/src/client.ts`):

1. **Check** that `chainId` matches the wallet's chain.
2. **Read the queue** (`getQueue(queueId, 0, 256)`, or a shared watcher's snapshot).
3. **Decide** with the value-of-time policy (reference: `decide` in `sdk/src/policy.ts`):
   - `valuePerSecond`: what one second of waiting is worth to this client, in wei.
   - `mySkipPrice = valuePerSecond × serviceIntervalMs / 1000`. Being passed costs one service
     slot of waiting, so this is the honest price of being passed.
   - Walk from the ticket directly ahead of me (the tail, for a new joiner) toward the head,
     passing contiguous tickets while `p_j < mySkipPrice`, at most 64.
   - `surplus = Σ (mySkipPrice − p_j)` over those tickets. Overtake iff `surplus > gasCost`
     (default `gasCost` 0.003 USDC).
   - `budget = Σ p_j + 1%` (sent as `msg.value`), and `maxPositions` = the number of tickets to pass.
4. **Act**: `joinAndOvertake(queueId, mySkipPrice, maxPositions)` with `value = budget`, or
   `join(queueId, mySkipPrice)`, with a gas limit that has headroom (the cost depends on who is
   passed at execution time). Wait for the receipt and read `Joined` / `Overtook` / `Passed`.
   If the overtake passed fewer of the planned tickets than intended (the queue changed in
   flight), re-run the policy once for the ticket now held and, if it says so, send
   `overtake(ticketId, maxPositions)` with the new budget. A join that reverts is retried
   once from a fresh read.
5. **Wait** for `Served(ticketId)` (watcher logs, or polling `tickets(id).status`). On timeout,
   call `leave(ticketId)` and give up.
6. **Retry** the original request with `X-429-Ticket` / `X-429-Signature`. While the server
   answers 429 (e.g. `serving`), sleep `Retry-After` and retry.

Budget mode makes the overtake safe against price changes in flight. The contract passes
tickets only while the running total fits in `msg.value`, and at most `maxPositions` of them,
then refunds the rest. A client can never pay more than `budget`, and never pays any ticket
more than its posted price.

## 6. Contract interface

`contracts/src/X429Queue.sol` (Solidity 0.8.30, no owner, no fee, no upgradeability).

```solidity
// queues
function createQueue(address operator, uint32 maxLength, string meta) returns (uint32 queueId); // maxLength ≤ 1024
function setOperator(uint32 queueId, address operator);                 // operator only

// clients
function join(uint32 queueId, uint128 skipPrice) returns (uint64 ticketId);
function joinAndOvertake(uint32 queueId, uint128 skipPrice, uint32 maxPositions) payable
    returns (uint64 ticketId, uint32 passed, uint256 paid);             // zero passes allowed
function overtake(uint64 ticketId, uint32 maxPositions) payable
    returns (uint32 passed, uint256 paid);                              // owner only; reverts NothingPassed
function setSkipPrice(uint64 ticketId, uint128 skipPrice);              // owner only, while waiting
function leave(uint64 ticketId);                                        // owner only, while waiting
function withdraw() returns (uint256);                                  // pull your claimable
function withdrawFor(address owner) returns (uint256);                  // anyone; pays `owner`

// operator
function serve(uint32 queueId, uint32 count) returns (uint32 served);   // pops from the head
function kick(uint64 ticketId);

// views
function queueInfo(uint32 queueId) view returns (Queue);   // operator, length, maxLength, overtakes, head, tail,
                                                          // joined, served, totalCompensation, meta
function getQueue(uint32 queueId, uint32 offset, uint32 limit) view returns (TicketView[]); // serving order
function positionOf(uint64 ticketId) view returns (uint32);             // 1-based, 0 if not waiting
function quote(uint32 queueId, uint64 ticketId, uint32 maxPositions, uint256 budget) view
    returns (uint32 passed, uint256 cost);                              // ticketId 0 = new joiner at the tail
function tickets(uint64) view returns (owner, queueId, status, timesPassed, joinedAt, prev, next,
                                       skipPrice, earned, paid);
function claimable(address) view returns (uint256);
function queueCount() view returns (uint32);
function ticketCount() view returns (uint64);
```

**Overtake semantics.** Starting from the ticket directly ahead of the mover and walking toward
the head, the contract passes ticket `j` while `paid + p_j ≤ msg.value` and fewer than
`maxPositions` (1..64) tickets have been passed. Each passed ticket gets `earned += p_j` and
`timesPassed += 1`, and its owner gets `claimable += p_j`. The mover is re-linked directly in
front of the furthest ticket it passed, and `paid` is added to its ticket and to the queue's
`totalCompensation`. Unspent value is refunded to the caller by a push; if the push fails, it
is credited to `claimable`.

**Events.** `QueueCreated`, `OperatorChanged`, `Joined(queueId, ticketId, owner, skipPrice, position)`,
`SkipPriceSet`, `Passed(queueId, passedTicketId, passedOwner, byTicketId, amount)`,
`Overtook(queueId, ticketId, owner, positions, paid)`,
`Served(queueId, ticketId, owner, waited, timesPassed, earned, paid)`,
`Left(queueId, ticketId, owner, kicked)`, `Withdrawn(owner, caller, amount)`.

**Statuses.** `0 None, 1 Waiting, 2 Served, 3 Left, 4 Kicked`.

**Invariants** (fuzzed in `contracts/test/X429Queue.invariant.t.sol`):

- the linked list is consistent: walking from the head visits exactly `length` Waiting tickets,
  `prev`/`next` are symmetric, `head.prev == 0` and `tail.next == 0`;
- `address(this).balance == Σ claimable`;
- `Σ totalCompensation == Σ paid == Σ earned`;
- `ticketCount == Σ joined`.

## 7. Security considerations

**Front-running price changes.** A ticket ahead may raise its price (`setSkipPrice`) after a
mover's quote. Budget mode caps the damage: the mover sends `msg.value = budget` and
`maxPositions`. Tickets that became more expensive are simply not passed, and the unspent
value is refunded. Nobody can ever be charged more than their own `msg.value`, and nobody is
paid more than their posted price. Lowering a price only makes passing cheaper.

The cap is on the total, not per ticket. If the queue changes between the quote and inclusion
(another client joins in the same block, directly ahead of the mover), the mover may spend
some of its positions on the newcomer and stop short. It still pays each ticket exactly that
ticket's price, and never more than `budget` in total. The reference client then re-runs the
policy once for the ticket it now holds and, if it is still worth it, finishes with a plain
`overtake`.

**Spam.** Joining costs only gas, so a spammer can fill a queue (`maxLength` ≤ 1024) with
zero-priced tickets. On Arc a join costs about 94k gas × 2e-8 USDC ≈ 0.0019 USDC, which
is real but small. Mitigations: the operator can `kick`; `maxLength` bounds the damage; and
zero-priced spam is passed for free by anyone who cares. A future version adds a refundable
spam bond (README, "Next steps").

**Griefing with high prices.** A ticket posting a huge skip price cannot be passed at a
reasonable cost. That is not an attack: it degrades to plain FIFO, which is what a 429 queue
without x429 would be anyway. A high price also does not help its owner move ahead; only
paying does.

**No-shows.** A served ticket whose owner never comes back burns one service slot (the
`busyUntil` it set) and its admission expires after `admissionTtlMs`. Its owner still paid for
any overtake. The operator MAY kick tickets whose owners repeatedly no-show.

**Why payments are pull.** On Arc a value transfer to or from a blocklisted address reverts,
and so does sending value to `address(0)`. If overtakes pushed compensation to each passed
owner, one blocklisted (or reverting) owner could make every overtake past them revert, and so
freeze their position. Compensation is therefore credited to `claimable` and withdrawn later
(`withdraw` / `withdrawFor`, both `nonReentrant`, checks-effects-interactions, reverting with
`TransferFailed` so a failed payout never loses funds). The one push, the refund of unspent
budget to the caller, falls back to a `claimable` credit if it fails.

**Reentrancy.** `overtake`, `joinAndOvertake`, `withdraw` and `withdrawFor` share one
`nonReentrant` lock. All state is final before any value leaves the contract.

**Ticket theft.** Redeeming an admission requires an EIP-191 signature by the ticket owner over
a message bound to chain, contract and ticket id, and each admission is consumed once. A
leaked signature is useless after its single redemption and outside its admission window.

**Server trust.** The server decides admission. A dishonest operator can refuse service or
serve out of order offchain, but the onchain order, every payment and every serve are public
and auditable. Clients only ever pay other clients, never the operator.

**Timestamps.** `block.timestamp` on Arc is non-decreasing and several blocks can share a
timestamp, so `waited` can be 0. The contract never relies on strictly increasing time.
`PREVRANDAO` is always 0 on Arc, and x429 uses no onchain randomness.
