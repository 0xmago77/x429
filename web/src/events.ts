// Turns decoded X429Queue logs into feed items, lane animation hints and "what changed" flags.
// No DOM in here.
import type { Address, Hash } from "viem";
import type { X429Log } from "./rpc.ts";

export type PassedEntry = { owner: Address; ticketId: bigint; amount: bigint };

type ItemBase = { key: string; tx: Hash; block: bigint; logIndex: number };
export type JoinedItem = ItemBase & {
  kind: "joined";
  owner: Address;
  ticketId: bigint;
  skipPrice: bigint;
  position: number;
};
export type OvertookItem = ItemBase & {
  kind: "overtook";
  owner: Address;
  ticketId: bigint;
  positions: number;
  paid: bigint;
  passed: PassedEntry[];
};
export type ServedItem = ItemBase & {
  kind: "served";
  owner: Address;
  ticketId: bigint;
  waited: number;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
};
export type LeftItem = ItemBase & { kind: "left"; owner: Address; ticketId: bigint; kicked: boolean };
export type WithdrawnItem = ItemBase & { kind: "withdrawn"; owner: Address; caller: Address; amount: bigint };
export type FeedItem = JoinedItem | OvertookItem | ServedItem | LeftItem | WithdrawnItem;

export type Digest = {
  /** Feed items, newest first. */
  items: FeedItem[];
  /** Tickets that moved ahead (Overtook), as decimal strings. */
  moved: Set<string>;
  /** Tickets that were passed → total amount they received. */
  passed: Map<string, bigint>;
  /** Something about the configured queue changed (re-read queueInfo / getQueue). */
  queueTouched: boolean;
  /** Lower-cased addresses that appear as owners/recipients. */
  addresses: Set<string>;
  /** Ticket ids that appear in any event of the queue. */
  ticketIds: Set<string>;
  joins: { ticketId: bigint; owner: Address }[];
};

export function logKey(log: { transactionHash: Hash; logIndex: number }): string {
  return `${log.transactionHash}:${log.logIndex}`;
}

function compareLogs(a: X429Log, b: X429Log): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

export function compareItemsNewestFirst(a: FeedItem, b: FeedItem): number {
  if (a.block !== b.block) return a.block > b.block ? -1 : 1;
  return b.logIndex - a.logIndex;
}

/** Events that count towards the "40 events" history target. */
export function isCountable(log: X429Log, queueId: number): boolean {
  switch (log.eventName) {
    case "Joined":
    case "Overtook":
    case "Served":
    case "Left":
      return log.args.queueId === queueId;
    case "Withdrawn":
      return true;
    default:
      return false;
  }
}

export function digest(logs: readonly X429Log[], queueId: number): Digest {
  const sorted = [...logs].sort(compareLogs);
  const d: Digest = {
    items: [],
    moved: new Set(),
    passed: new Map(),
    queueTouched: false,
    addresses: new Set(),
    ticketIds: new Set(),
    joins: [],
  };
  const touch = (owner: Address, ticketId?: bigint): void => {
    d.addresses.add(owner.toLowerCase());
    if (ticketId !== undefined) d.ticketIds.add(ticketId.toString());
  };

  // Passed events precede their Overtook in the same tx; group them by (tx, byTicketId).
  const passedBy = new Map<string, PassedEntry[]>();
  for (const log of sorted) {
    if (log.eventName !== "Passed" || log.args.queueId !== queueId) continue;
    const key = `${log.transactionHash}:${log.args.byTicketId}`;
    const list = passedBy.get(key) ?? [];
    list.push({ owner: log.args.passedOwner, ticketId: log.args.passedTicketId, amount: log.args.amount });
    passedBy.set(key, list);
  }

  for (const log of sorted) {
    const base: ItemBase = {
      key: logKey(log),
      tx: log.transactionHash,
      block: log.blockNumber,
      logIndex: log.logIndex,
    };
    switch (log.eventName) {
      case "Joined": {
        const a = log.args;
        if (a.queueId !== queueId) break;
        d.queueTouched = true;
        touch(a.owner, a.ticketId);
        d.joins.push({ ticketId: a.ticketId, owner: a.owner });
        d.items.push({ ...base, kind: "joined", owner: a.owner, ticketId: a.ticketId, skipPrice: a.skipPrice, position: a.position });
        break;
      }
      case "Passed": {
        const a = log.args;
        if (a.queueId !== queueId) break;
        d.queueTouched = true;
        touch(a.passedOwner, a.passedTicketId);
        const id = a.passedTicketId.toString();
        d.passed.set(id, (d.passed.get(id) ?? 0n) + a.amount);
        break;
      }
      case "Overtook": {
        const a = log.args;
        if (a.queueId !== queueId) break;
        d.queueTouched = true;
        touch(a.owner, a.ticketId);
        d.moved.add(a.ticketId.toString());
        d.items.push({
          ...base,
          kind: "overtook",
          owner: a.owner,
          ticketId: a.ticketId,
          positions: a.positions,
          paid: a.paid,
          passed: passedBy.get(`${log.transactionHash}:${a.ticketId}`) ?? [],
        });
        break;
      }
      case "Served": {
        const a = log.args;
        if (a.queueId !== queueId) break;
        d.queueTouched = true;
        touch(a.owner, a.ticketId);
        d.items.push({
          ...base,
          kind: "served",
          owner: a.owner,
          ticketId: a.ticketId,
          waited: a.waited,
          timesPassed: a.timesPassed,
          earned: a.earned,
          paid: a.paid,
        });
        break;
      }
      case "Left": {
        const a = log.args;
        if (a.queueId !== queueId) break;
        d.queueTouched = true;
        touch(a.owner, a.ticketId);
        d.items.push({ ...base, kind: "left", owner: a.owner, ticketId: a.ticketId, kicked: a.kicked });
        break;
      }
      case "SkipPriceSet": {
        if (log.args.queueId !== queueId) break;
        d.queueTouched = true;
        d.ticketIds.add(log.args.ticketId.toString());
        break;
      }
      case "OperatorChanged":
      case "QueueCreated": {
        if (log.args.queueId === queueId) d.queueTouched = true;
        break;
      }
      case "Withdrawn": {
        // Withdrawn has no queue id; this contract only serves x429 queues, so keep them all.
        const a = log.args;
        touch(a.owner);
        d.items.push({ ...base, kind: "withdrawn", owner: a.owner, caller: a.caller, amount: a.amount });
        break;
      }
    }
  }
  d.items.reverse();
  return d;
}
