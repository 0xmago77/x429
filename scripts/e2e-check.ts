// Helper for scripts/e2e-local.sh.
//   node scripts/e2e-check.ts status   → prints "<queueLength> <humanStatus>" (e.g. "3 waiting")
//   node scripts/e2e-check.ts assert   → checks the e2e outcome, prints a summary, exits 1 on failure
// Env: E2E_RPC, E2E_CONTRACT, E2E_QUEUE_ID, E2E_HUMAN, E2E_HUMAN_TICKET, E2E_AGENTS_LOG, E2E_STATE_FILE
import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { x429Abi } from "../sdk/src/abi.ts";
import { anvilLocal, fmtUsdc, statusName } from "../sdk/src/chain.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const client = createPublicClient({ chain: anvilLocal, transport: http(env("E2E_RPC")) });
const contract = getAddress(env("E2E_CONTRACT"));
const queueId = Number(env("E2E_QUEUE_ID"));

async function humanStatus(): Promise<string> {
  const id = process.env.E2E_HUMAN_TICKET;
  if (!id) return "none";
  const t = await client.readContract({ address: contract, abi: x429Abi, functionName: "tickets", args: [BigInt(id)] });
  return statusName(t[2]);
}

async function status(): Promise<void> {
  const q = await client.readContract({ address: contract, abi: x429Abi, functionName: "queueInfo", args: [queueId] });
  console.log(`${q.length} ${await humanStatus()}`);
}

async function assertAll(): Promise<void> {
  const human = getAddress(env("E2E_HUMAN"));
  const humanTicket = BigInt(env("E2E_HUMAN_TICKET"));
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures.push(what);
  };

  // agent log: JSON lines
  const lines = readFileSync(env("E2E_AGENTS_LOG"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  const fortunes = lines.filter((l) => l.evt === "fortune");
  const ok200 = fortunes.filter((l) => l.status === 200);
  const viaQueue = ok200.filter((l) => (l.receipt as { ticketId?: string | null } | undefined)?.ticketId);
  const errors = lines.filter((l) => l.evt === "arrival_error" || l.evt === "fatal");

  const events = await client.getContractEvents({ address: contract, abi: x429Abi, fromBlock: 0n, strict: true });
  const count = (name: string) => events.filter((e) => e.eventName === name).length;
  const passedHuman = events.filter((e) => e.eventName === "Passed" && getAddress(e.args.passedOwner) === human);
  const humanServed = events.find((e) => e.eventName === "Served" && e.args.ticketId === humanTicket);
  const q = await client.readContract({ address: contract, abi: x429Abi, functionName: "queueInfo", args: [queueId] });

  // every address that can hold claimable is a ticket owner (credits and refunds both go to owners)
  const owners = new Set<Address>();
  for (const e of events) if (e.eventName === "Joined") owners.add(getAddress(e.args.owner));
  let sumClaimable = 0n;
  for (const o of owners) {
    sumClaimable += await client.readContract({ address: contract, abi: x429Abi, functionName: "claimable", args: [o] });
  }
  const balance = await client.getBalance({ address: contract });
  const humanClaimable = await client.readContract({ address: contract, abi: x429Abi, functionName: "claimable", args: [human] });

  let gasSpent = "n/a";
  try {
    const st = JSON.parse(readFileSync(env("E2E_STATE_FILE"), "utf8")) as { days: Record<string, { gasWei: string; txs: number }> };
    const total = Object.values(st.days).reduce((s, d) => s + BigInt(d.gasWei), 0n);
    const txs = Object.values(st.days).reduce((s, d) => s + d.txs, 0);
    gasSpent = `${fmtUsdc(total, 8)} USDC over ${txs} agent txs`;
  } catch {
    // no state file
  }

  console.log("");
  console.log("x429 e2e summary");
  console.log("----------------");
  console.log(`  contract            ${contract} (queue ${queueId})`);
  console.log(`  fortunes            ${ok200.length} × 200 (${viaQueue.length} via the queue, ${ok200.length - viaQueue.length} direct), ${fortunes.length - ok200.length} other, ${errors.length} agent errors`);
  console.log(`  events              Joined ${count("Joined")}, Overtook ${count("Overtook")}, Passed ${count("Passed")}, Served ${count("Served")}, Left ${count("Left")}, Withdrawn ${count("Withdrawn")}`);
  console.log(`  compensation        ${fmtUsdc(q.totalCompensation)} USDC paid to people waiting (${q.overtakes} overtakes)`);
  console.log(
    `  human ticket #${humanTicket}    passed ${passedHuman.length}× earning ${fmtUsdc(passedHuman.reduce((s, e) => s + (e.eventName === "Passed" ? e.args.amount : 0n), 0n))} USDC; ` +
      (humanServed && humanServed.eventName === "Served"
        ? `served after ${humanServed.args.waited}s`
        : `status ${await humanStatus()}`) +
      `; claimable ${fmtUsdc(humanClaimable)} USDC`,
  );
  console.log(`  queue               length ${q.length}, joined ${q.joined}, served ${q.served}`);
  console.log(`  balance check       contract ${fmtUsdc(balance, 18)} USDC vs Σ claimable ${fmtUsdc(sumClaimable, 18)} USDC (${owners.size} owners)`);
  console.log(`  agent gas           ${gasSpent}`);
  console.log("");
  check(ok200.length >= 8, `≥ 8 HTTP 200 fortunes (got ${ok200.length})`);
  check(count("Overtook") >= 1, `≥ 1 Overtook event (got ${count("Overtook")})`);
  check(passedHuman.length >= 1, `≥ 1 Passed event paid to the human (got ${passedHuman.length})`);
  check(!!humanServed, "the human ticket was served");
  check(q.length === 0, `the queue is empty at the end (length ${q.length})`);
  check(balance === sumClaimable, "contract balance == Σ claimable");
  if (failures.length) {
    console.log(`\nE2E FAILED: ${failures.length} check(s)`);
    process.exit(1);
  }
  console.log("\nE2E PASSED");
}

const mode = process.argv[2];
(mode === "status" ? status() : mode === "assert" ? assertAll() : Promise.reject(new Error("usage: e2e-check.ts status|assert"))).catch(
  (err) => {
    console.error(String((err as Error)?.message ?? err).split("\n")[0]);
    process.exit(2);
  },
);
