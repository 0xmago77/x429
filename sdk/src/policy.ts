import { usdc } from "./chain.ts";

/** A waiting ticket as the policy sees it. */
export type PolicyTicket = { id: bigint; skipPrice: bigint };

export type PolicyInput = {
  /** What one second of waiting is worth to me, in native USDC wei. */
  valuePerSecond: bigint;
  /** How often the service admits one request, in ms. */
  serviceIntervalMs: number;
  /** Waiting tickets in serving order (index 0 is served next). */
  queue: readonly PolicyTicket[];
  /** My waiting ticket, or null/undefined for a new joiner at the tail. */
  myTicketId?: bigint | null;
  /** Expected gas cost of the overtake, in native USDC wei. Default 0.003 USDC. */
  gasCost?: bigint;
  /** Upper bound on positions passed in one tx (the contract allows 64). */
  maxPositions?: number;
};

export type PolicyDecision = {
  /** The price I post: what being pushed back one slot costs me. */
  mySkipPrice: bigint;
  /** Whether moving ahead is worth it. */
  overtake: boolean;
  /** Tickets I would pass (contiguous, starting directly ahead of me). */
  passIds: bigint[];
  /** Σ of their skip prices. */
  cost: bigint;
  /** cost + 1% slack: the msg.value to send. The contract never charges more than the posted prices. */
  budget: bigint;
  /** = passIds.length, the contract's `maxPositions` argument. */
  maxPositions: number;
  /** Σ (mySkipPrice − p_j): the time value I gain net of what I pay. */
  surplus: bigint;
  gasCost: bigint;
  /** 1-based position after joining / now (before moving). */
  positionBefore: number;
  /** 1-based position if the overtake goes through. */
  positionAfter: number;
};

export const DEFAULT_GAS_COST = usdc("0.003");
export const MAX_PASS_PER_TX = 64;

/** The skip price implied by a value of time: what one service slot of waiting is worth. */
export function skipPriceFor(valuePerSecond: bigint, serviceIntervalMs: number): bigint {
  return (valuePerSecond * BigInt(Math.round(serviceIntervalMs))) / 1000n;
}

/**
 * Value-of-time policy. Being passed costs me one service slot, so I price a slot at
 * `valuePerSecond × serviceInterval`. Walking from directly ahead of me toward the head,
 * every ticket priced strictly below that is worth passing; I stop at the first one that is not.
 * I only overtake if the total surplus beats the gas cost.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const gasCost = input.gasCost ?? DEFAULT_GAS_COST;
  const cap = Math.max(0, Math.min(input.maxPositions ?? MAX_PASS_PER_TX, MAX_PASS_PER_TX));
  const mySkipPrice = skipPriceFor(input.valuePerSecond, input.serviceIntervalMs);
  const queue = input.queue;

  // index of the first ticket ahead of me
  let start: number;
  let positionBefore: number;
  if (input.myTicketId === undefined || input.myTicketId === null) {
    start = queue.length - 1;
    positionBefore = queue.length + 1;
  } else {
    const mine = queue.findIndex((t) => t.id === input.myTicketId);
    if (mine < 0) {
      return noMove(mySkipPrice, gasCost, 0);
    }
    start = mine - 1;
    positionBefore = mine + 1;
  }

  const passIds: bigint[] = [];
  let cost = 0n;
  let surplus = 0n;
  for (let i = start; i >= 0 && passIds.length < cap; i--) {
    const p = queue[i]!.skipPrice;
    if (p >= mySkipPrice) break;
    passIds.push(queue[i]!.id);
    cost += p;
    surplus += mySkipPrice - p;
  }

  if (passIds.length === 0 || surplus <= gasCost) {
    return { ...noMove(mySkipPrice, gasCost, positionBefore), surplus };
  }
  return {
    mySkipPrice,
    overtake: true,
    passIds,
    cost,
    budget: cost + cost / 100n,
    maxPositions: passIds.length,
    surplus,
    gasCost,
    positionBefore,
    positionAfter: positionBefore - passIds.length,
  };
}

function noMove(mySkipPrice: bigint, gasCost: bigint, position: number): PolicyDecision {
  return {
    mySkipPrice,
    overtake: false,
    passIds: [],
    cost: 0n,
    budget: 0n,
    maxPositions: 0,
    surplus: 0n,
    gasCost,
    positionBefore: position,
    positionAfter: position,
  };
}
