import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEES,
  anvilLocal,
  arc,
  caip2,
  chainFor,
  explorerAddress,
  explorerTx,
  fmtUsdc,
  isRangeError,
  isRateLimitError,
  statusName,
  ticketMessage,
  usdc,
  withWalletLock,
} from "../src/chain.ts";

describe("chain", () => {
  it("defines Arc mainnet with 18-decimal native USDC", () => {
    assert.equal(arc.id, 5042);
    assert.deepEqual(arc.nativeCurrency, { name: "USDC", symbol: "USDC", decimals: 18 });
    assert.equal(arc.rpcUrls.default.http[0], "https://rpc.mainnet.arc.io");
    assert.equal(arc.blockExplorers?.default.url, "https://explorer.arc.io");
    assert.equal(anvilLocal.id, 31337);
  });

  it("uses 50 gwei max fee and 0.01 gwei tip", () => {
    assert.equal(FEES.maxFeePerGas, 50_000_000_000n);
    assert.equal(FEES.maxPriorityFeePerGas, 10_000_000n);
  });

  it("converts and formats USDC amounts", () => {
    assert.equal(usdc("0.002"), 2_000_000_000_000_000n);
    assert.equal(usdc(1), 10n ** 18n);
    assert.equal(fmtUsdc(usdc("0.0021")), "0.0021");
    assert.equal(fmtUsdc(usdc("12.5")), "12.5");
    assert.equal(fmtUsdc(0n), "0");
    assert.equal(fmtUsdc(usdc("0.123456789")), "0.123456");
    assert.equal(fmtUsdc(usdc("0.123456789"), 2), "0.12");
    assert.equal(fmtUsdc(1n), "<0.000001");
    assert.equal(fmtUsdc(-usdc("0.5")), "-0.5");
  });

  it("builds explorer links", () => {
    assert.equal(explorerTx("0xabc"), "https://explorer.arc.io/tx/0xabc");
    assert.equal(explorerAddress("0xdef", "http://x/"), "http://x/address/0xdef");
  });

  it("builds the exact ticket message", () => {
    assert.equal(
      ticketMessage(5042, "0xAbCdEf0000000000000000000000000000000001", 17n),
      "x429:v1:5042:0xabcdef0000000000000000000000000000000001:17",
    );
    assert.equal(caip2(5042), "eip155:5042");
  });

  it("chainFor overrides rpc urls", () => {
    assert.equal(chainFor(5042).id, 5042);
    assert.deepEqual(chainFor(31337, ["http://127.0.0.1:9999"]).rpcUrls.default.http, ["http://127.0.0.1:9999"]);
    assert.throws(() => chainFor(1));
  });

  it("names statuses", () => {
    assert.equal(statusName(1), "waiting");
    assert.equal(statusName(2), "served");
    assert.equal(statusName(9), "none");
  });

  it("classifies RPC errors", () => {
    assert.equal(isRateLimitError({ status: 429 }), true);
    assert.equal(isRateLimitError({ message: "HTTP request failed. Status: 429" }), true);
    assert.equal(isRateLimitError({ cause: { code: 429 } }), true);
    assert.equal(isRateLimitError(new Error("execution reverted")), false);
    assert.equal(isRangeError({ code: -32012, message: "requested range too large" }), true);
    assert.equal(isRangeError({ details: "query exceeds max results 2000, retry with the range 1-500" }), true);
    assert.equal(isRangeError({ cause: { code: -32012 } }), true);
    assert.equal(isRangeError(new Error("nope")), false);
  });

  it("withWalletLock runs one task at a time per address", async () => {
    const order: string[] = [];
    const a = "0x0000000000000000000000000000000000000001" as const;
    const b = "0x0000000000000000000000000000000000000002" as const;
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([
      withWalletLock(a, task("a1", 30)),
      withWalletLock(a, task("a2", 1)),
      withWalletLock(b, task("b1", 5)),
    ]);
    assert.deepEqual(results, ["a1", "a2", "b1"]);
    assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"), order.join(","));
    assert.ok(order.indexOf("b1:start") < order.indexOf("a1:end"), "different wallets run concurrently");
  });

  it("withWalletLock releases after a failure", async () => {
    const a = "0x0000000000000000000000000000000000000003" as const;
    await assert.rejects(withWalletLock(a, async () => Promise.reject(new Error("boom"))));
    assert.equal(await withWalletLock(a, async () => 42), 42);
  });
});
