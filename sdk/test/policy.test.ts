import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { usdc } from "../src/chain.ts";
import { DEFAULT_GAS_COST, decide, skipPriceFor, type PolicyTicket } from "../src/policy.ts";

const q = (...prices: string[]): PolicyTicket[] => prices.map((p, i) => ({ id: BigInt(i + 1), skipPrice: usdc(p) }));

describe("skipPriceFor", () => {
  it("prices one service slot of waiting", () => {
    assert.equal(skipPriceFor(usdc("0.001"), 15_000), usdc("0.015"));
    assert.equal(skipPriceFor(usdc("0.00001"), 15_000), usdc("0.00015"));
    assert.equal(skipPriceFor(0n, 15_000), 0n);
  });
});

describe("decide", () => {
  it("joins at the tail of an empty queue without overtaking", () => {
    const d = decide({ valuePerSecond: usdc("0.003"), serviceIntervalMs: 15_000, queue: [] });
    assert.equal(d.overtake, false);
    assert.equal(d.mySkipPrice, usdc("0.045"));
    assert.equal(d.positionBefore, 1);
    assert.equal(d.maxPositions, 0);
    assert.equal(d.budget, 0n);
  });

  it("passes contiguous cheaper tickets from directly ahead toward the head", () => {
    // my price 0.015; queue head→tail: 0.02 (stop), 0.001, 0.002
    const d = decide({ valuePerSecond: usdc("0.001"), serviceIntervalMs: 15_000, queue: q("0.02", "0.001", "0.002") });
    assert.equal(d.overtake, true);
    assert.deepEqual(d.passIds, [3n, 2n]);
    assert.equal(d.cost, usdc("0.003"));
    assert.equal(d.budget, usdc("0.00303"));
    assert.equal(d.maxPositions, 2);
    assert.equal(d.surplus, usdc("0.015") - usdc("0.002") + usdc("0.015") - usdc("0.001"));
    assert.equal(d.positionBefore, 4);
    assert.equal(d.positionAfter, 2);
  });

  it("stops at the first ticket that is not strictly cheaper (equal price is not passed)", () => {
    const d = decide({ valuePerSecond: usdc("0.001"), serviceIntervalMs: 15_000, queue: q("0.001", "0.015", "0.001") });
    assert.deepEqual(d.passIds, [3n]);
  });

  it("does not overtake when the surplus does not beat gas", () => {
    // my price 0.004, ahead 0.002 → surplus 0.002 < 0.003 default gas
    const d = decide({ valuePerSecond: usdc("0.0004"), serviceIntervalMs: 10_000, queue: q("0.002") });
    assert.equal(d.mySkipPrice, usdc("0.004"));
    assert.equal(d.overtake, false);
    assert.equal(d.surplus, usdc("0.002"));
    assert.equal(d.budget, 0n);
    // surplus must be strictly greater than gas
    const edge = decide({ valuePerSecond: usdc("0.0005"), serviceIntervalMs: 10_000, queue: q("0.002") });
    assert.equal(edge.surplus, DEFAULT_GAS_COST);
    assert.equal(edge.overtake, false);
    const cheapGas = decide({ valuePerSecond: usdc("0.0004"), serviceIntervalMs: 10_000, queue: q("0.002"), gasCost: usdc("0.001") });
    assert.equal(cheapGas.overtake, true);
  });

  it("passes zero-priced tickets for free", () => {
    const d = decide({ valuePerSecond: usdc("0.001"), serviceIntervalMs: 15_000, queue: q("0", "0") });
    assert.equal(d.overtake, true);
    assert.equal(d.cost, 0n);
    assert.equal(d.budget, 0n);
    assert.equal(d.maxPositions, 2);
  });

  it("an existing ticket ignores the tickets behind it", () => {
    // ticket 2 is mine; behind me sits a cheap ticket, ahead of me an expensive one
    const queue = q("0.05", "0.001", "0.0001");
    const d = decide({ valuePerSecond: usdc("0.001"), serviceIntervalMs: 15_000, queue, myTicketId: 2n });
    assert.equal(d.overtake, false);
    assert.equal(d.positionBefore, 2);
  });

  it("an existing ticket passes the cheaper tickets ahead of it only", () => {
    const queue = q("0.001", "0.001", "0.05", "0.001");
    const d = decide({ valuePerSecond: usdc("0.003"), serviceIntervalMs: 15_000, queue, myTicketId: 3n });
    assert.equal(d.overtake, true);
    assert.deepEqual(d.passIds, [2n, 1n]);
    assert.equal(d.positionBefore, 3);
    assert.equal(d.positionAfter, 1);
  });

  it("an existing ticket at the head or missing from the queue never moves", () => {
    const queue = q("0.001", "0.001");
    assert.equal(decide({ valuePerSecond: usdc("1"), serviceIntervalMs: 15_000, queue, myTicketId: 1n }).overtake, false);
    const missing = decide({ valuePerSecond: usdc("1"), serviceIntervalMs: 15_000, queue, myTicketId: 99n });
    assert.equal(missing.overtake, false);
    assert.equal(missing.positionBefore, 0);
  });

  it("caps maxPositions at 64", () => {
    const queue = Array.from({ length: 100 }, (_, i) => ({ id: BigInt(i + 1), skipPrice: usdc("0.0001") }));
    const d = decide({ valuePerSecond: usdc("0.003"), serviceIntervalMs: 15_000, queue });
    assert.equal(d.maxPositions, 64);
    assert.equal(d.passIds.length, 64);
    assert.equal(d.passIds[0], 100n);
    assert.equal(d.cost, usdc("0.0064"));
    const capped = decide({ valuePerSecond: usdc("0.003"), serviceIntervalMs: 15_000, queue, maxPositions: 5 });
    assert.equal(capped.maxPositions, 5);
  });

  it("budget is the exact cost plus 1% slack", () => {
    const d = decide({ valuePerSecond: usdc("0.01"), serviceIntervalMs: 1_000, queue: q("0.000123") });
    assert.equal(d.cost, usdc("0.000123"));
    assert.equal(d.budget, usdc("0.000123") + usdc("0.000123") / 100n);
  });

  it("demo bots: quant-desk cuts past a 0.001 human, nightly-backup does not", () => {
    const human = q("0.001");
    assert.equal(decide({ valuePerSecond: usdc("0.003"), serviceIntervalMs: 15_000, queue: human }).overtake, true);
    assert.equal(decide({ valuePerSecond: usdc("0.00001"), serviceIntervalMs: 15_000, queue: human }).overtake, false);
  });
});
