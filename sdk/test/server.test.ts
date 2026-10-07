// Gate tests against a fake chain: real HTTP, real signatures, fake RPC.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x429Abi } from "../src/abi.ts";
import { ticketMessage } from "../src/chain.ts";
import { createX429Gate, type X429Gate } from "../src/server.ts";
import type { QueueSnapshot, QueueTicket, QueueWatcher } from "../src/watcher.ts";

const CONTRACT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CHAIN_ID = 31337;
const INTERVAL = 200;

const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const operatorAccount = privateKeyToAccount(generatePrivateKey());

// ---- fake chain state
type FakeTicket = { owner: Address; queueId: number; status: number; joinedAt: number };
const chainTickets = new Map<bigint, FakeTicket>();
let snapshot: QueueSnapshot = { queueId: 1, blockNumber: 1n, fetchedAt: Date.now(), length: 0, tickets: [] };

function setQueue(tickets: Array<{ id: bigint; owner: Address; joinedAt: number }>): void {
  const list: QueueTicket[] = tickets.map((t, i) => ({
    id: t.id,
    owner: t.owner,
    skipPrice: 0n,
    joinedAt: t.joinedAt,
    timesPassed: 0,
    earned: 0n,
    paid: 0n,
    position: i + 1,
  }));
  snapshot = { queueId: 1, blockNumber: snapshot.blockNumber + 1n, fetchedAt: Date.now(), length: list.length, tickets: list };
  for (const t of tickets) chainTickets.set(t.id, { owner: t.owner, queueId: 1, status: 1, joinedAt: t.joinedAt });
}

const fakeWatcher = {
  contract: CONTRACT,
  queueId: 1,
  get snapshot() {
    return snapshot;
  },
  start() {},
  stop() {},
  refresh: async () => {
    snapshot = { ...snapshot, fetchedAt: Date.now() };
  },
} as unknown as QueueWatcher;

function servedLog(id: bigint, owner: Address) {
  return {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: x429Abi, eventName: "Served", args: { queueId: 1, ticketId: id, owner } }),
    data: encodeAbiParameters(
      [{ type: "uint32" }, { type: "uint24" }, { type: "uint128" }, { type: "uint128" }],
      [7, 2, 3000n, 5000n],
    ),
    blockNumber: 10n,
    blockHash: ("0x" + "11".repeat(32)) as Hex,
    logIndex: 0,
    transactionHash: ("0x" + "22".repeat(32)) as Hex,
    transactionIndex: 0,
    removed: false,
  };
}

let sent = 0;
const fakeClient = {
  chain: { id: CHAIN_ID },
  readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    if (functionName === "tickets") {
      const t = chainTickets.get(args[0] as bigint);
      if (!t) return ["0x0000000000000000000000000000000000000000", 0, 0, 0, 0, 0n, 0n, 0n, 0n, 0n];
      return [t.owner, t.queueId, t.status, 0, t.joinedAt, 0n, 0n, 0n, 0n, 0n];
    }
    if (functionName === "positionOf") return 1;
    throw new Error(`unexpected read ${functionName}`);
  },
  getTransactionCount: async () => sent,
  estimateGas: async () => 60_000n,
  waitForTransactionReceipt: async () => {
    // the operator served the head: mark it served and drop it from the queue
    const head = snapshot.tickets[0]!;
    chainTickets.get(head.id)!.status = 2;
    setQueue(snapshot.tickets.slice(1).map((t) => ({ id: t.id, owner: t.owner, joinedAt: t.joinedAt })));
    return {
      status: "success",
      transactionHash: ("0x" + "22".repeat(32)) as Hex,
      gasUsed: 50_000n,
      effectiveGasPrice: 20_000_000_000n,
      logs: [servedLog(head.id, head.owner)],
    };
  },
} as unknown as PublicClient;

const fakeOperator = {
  account: operatorAccount,
  chain: { id: CHAIN_ID },
  sendTransaction: async () => {
    sent++;
    return ("0x" + "22".repeat(32)) as Hex;
  },
} as unknown as WalletClient;

// ---- server under test
let gate: X429Gate;
let server: Server;
let base = "";
const logs: Array<Record<string, unknown>> = [];

before(async () => {
  gate = createX429Gate({
    publicClient: fakeClient,
    operator: fakeOperator,
    contract: CONTRACT,
    queueId: 1,
    serviceIntervalMs: INTERVAL,
    minQueueMs: 0,
    admissionTtlMs: 5_000,
    watcher: fakeWatcher,
    tickMs: 20,
    log: (e) => logs.push(e),
  });
  server = createServer(async (req, res) => {
    if (await gate(req, res)) return;
    const adm = gate.admission(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ticketId: adm?.ticketId.toString() ?? null, waited: adm?.waited ?? null }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  gate.stop();
  server.close();
});

const sign = (account: typeof alice, id: bigint) => account.signMessage({ message: ticketMessage(CHAIN_ID, CONTRACT, id) });
const withTicket = (id: bigint | string, sig: string) => ({ headers: { "X-429-Ticket": id.toString(), "X-429-Signature": sig } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createX429Gate", () => {
  it("GET /x429 returns the descriptor", async () => {
    const res = await fetch(`${base}/x429`);
    assert.equal(res.status, 200);
    const d = (await res.json()) as Record<string, unknown>;
    assert.equal(d.version, "0.1");
    assert.equal(d.network, "eip155:31337");
    assert.equal(d.chainId, CHAIN_ID);
    assert.equal(d.contract, CONTRACT);
    assert.equal(d.queueId, 1);
    assert.equal(d.serviceIntervalMs, INTERVAL);
    assert.equal(d.suggestedSkipPrice, "2000000000000000");
    assert.deepEqual(d.currency, { symbol: "USDC", decimals: 18 });
    assert.equal(d.signature, `x429:v1:${CHAIN_ID}:${CONTRACT.toLowerCase()}:<ticketId>`);
    assert.equal(d.ticket, null);
  });

  it("admits directly when the queue is empty and the slot is free, then answers 429", async () => {
    await wait(INTERVAL + 20);
    const first = await fetch(`${base}/v1/thing`);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, ticketId: null, waited: null });

    const second = await fetch(`${base}/v1/thing`);
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get("retry-after")) >= 1);
    assert.equal(second.headers.get("x-429-network"), "eip155:31337");
    assert.equal(second.headers.get("x-429-queue"), `${CONTRACT}/1`);
    const body = (await second.json()) as { error: string; x429: { queueLength: number; ticket: unknown } };
    assert.equal(body.error, "too_many_requests");
    assert.equal(body.x429.queueLength, 0);
    assert.equal(body.x429.ticket, null);
  });

  it("answers 429 while tickets are waiting, even when the slot is free", async () => {
    setQueue([{ id: 1n, owner: alice.address, joinedAt: Math.floor(Date.now() / 1000) + 3600 }]); // round not over
    await wait(INTERVAL + 20);
    const res = await fetch(`${base}/v1/thing`);
    assert.equal(res.status, 429);
  });

  it("rejects malformed and unknown tickets with 403", async () => {
    const bad = await fetch(`${base}/v1/thing`, withTicket("abc", "0x00"));
    assert.equal(bad.status, 403);
    assert.equal(((await bad.json()) as { reason: string }).reason, "malformed_ticket");
    const unknown = await fetch(`${base}/v1/thing`, withTicket(99n, await sign(alice, 99n)));
    assert.equal(unknown.status, 403);
    assert.equal(((await unknown.json()) as { reason: string }).reason, "unknown_ticket");
  });

  it("answers 429 with the position for a waiting ticket, 403 for a foreign signature", async () => {
    const waiting = await fetch(`${base}/v1/thing`, withTicket(1n, await sign(alice, 1n)));
    assert.equal(waiting.status, 429);
    const body = (await waiting.json()) as { x429: { ticket: { id: string; status: string; position: number } } };
    assert.deepEqual(body.x429.ticket, { id: "1", status: "waiting", position: 1 });

    const stolen = await fetch(`${base}/v1/thing`, withTicket(1n, await sign(mallory, 1n)));
    assert.equal(stolen.status, 403);
    assert.equal(((await stolen.json()) as { reason: string }).reason, "bad_signature");
  });

  it("serves the head after its admission round, then admits its owner exactly once", async () => {
    setQueue([{ id: 2n, owner: alice.address, joinedAt: Math.floor(Date.now() / 1000) - 1 }]);
    gate.start();
    for (let i = 0; i < 100 && gate.stats().served === 0; i++) await wait(20);
    assert.equal(gate.stats().served, 1, "operator served the head");
    assert.equal(snapshot.length, 0);
    assert.ok(logs.some((l) => l.evt === "served" && l.ticketId === "2"));

    const forged = await fetch(`${base}/v1/thing`, withTicket(2n, await sign(mallory, 2n)));
    assert.equal(forged.status, 403, "someone else cannot redeem it");

    const sig = await sign(alice, 2n);
    const ok = await fetch(`${base}/v1/thing`, withTicket(2n, sig));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, ticketId: "2", waited: 7 });

    const replay = await fetch(`${base}/v1/thing`, withTicket(2n, sig));
    assert.equal(replay.status, 403);
    assert.equal(((await replay.json()) as { reason: string }).reason, "ticket_used_or_expired");
    gate.stop();
  });
});
