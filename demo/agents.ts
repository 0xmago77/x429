// The agent swarm. Eight bots with different values of time hit the demo API in "rushes":
// on a wall-clock schedule, or right away when a human joins the queue. Each arrival goes
// through x429Fetch with its own value-of-time policy.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeFunctionData, type Address, type TransactionReceipt, type WalletClient } from "viem";
import { x429Abi } from "../sdk/src/abi.ts";
import { fmtUsdc, gasCostOf, sendTx } from "../sdk/src/chain.ts";
import { X429Error, x429Fetch } from "../sdk/src/client.ts";
import { QueueWatcher } from "../sdk/src/watcher.ts";
import { arrivalValuePerSecond } from "./bots.ts";
import {
  errMsg,
  loadConfig,
  logger,
  makePublicClient,
  makeWallet,
  readAddresses,
  readBotKeys,
  readKeyFile,
  requireContract,
  type BotAccount,
} from "./config.ts";

const cfg = loadConfig();
const log = logger("agents");
const contract = requireContract(cfg);
const publicClient = makePublicClient(cfg);

type Bot = BotAccount & { wallet: WalletClient; busy: boolean };
const bots: Bot[] = readBotKeys(cfg).map((b) => ({ ...b, wallet: makeWallet(cfg, b.account), busy: false }));
if (bots.length === 0) throw new Error("no bot keys found in X429_BOT_KEYS_DIR");

const treasuryAccount = cfg.treasuryKeyFile ? readKeyFile(cfg.treasuryKeyFile, "treasury") : undefined;
const treasury = treasuryAccount ? makeWallet(cfg, treasuryAccount) : undefined;
const book = readAddresses(cfg);

/** Owners whose joins never trigger a human rush. */
const known = new Set<string>(bots.map((b) => b.account.address.toLowerCase()));
if (treasuryAccount) known.add(treasuryAccount.address.toLowerCase());
for (const v of Object.values(book ?? {})) if (v) known.add(v.toLowerCase());

// ------------------------------------------------------------------ state (gas budget, human rush caps)

type DayState = { gasWei: string; txs: number; rushes: number; humanRushes: number };
type State = { days: Record<string, DayState>; lastHumanRushAt: number };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(cfg.stateFile, "utf8")) as State;
    return { days: s.days ?? {}, lastHumanRushAt: s.lastHumanRushAt ?? 0 };
  } catch {
    return { days: {}, lastHumanRushAt: 0 };
  }
}

const state = loadState();

function day(): DayState {
  const key = today();
  return (state.days[key] ??= { gasWei: "0", txs: 0, rushes: 0, humanRushes: 0 });
}

function saveState(): void {
  const keys = Object.keys(state.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete state.days[k];
  mkdirSync(dirname(cfg.stateFile), { recursive: true });
  const tmp = `${cfg.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, cfg.stateFile);
}

function recordGas(receipt: TransactionReceipt, who: string, what: string): void {
  const cost = gasCostOf(receipt);
  const d = day();
  d.gasWei = (BigInt(d.gasWei) + cost).toString();
  d.txs++;
  saveState();
  log({ evt: "gas", who, what, tx: receipt.transactionHash, gasUsed: receipt.gasUsed, costUsdc: fmtUsdc(cost, 8), dayTotalUsdc: fmtUsdc(BigInt(d.gasWei), 8) });
}

function overBudget(): boolean {
  return BigInt(day().gasWei) >= cfg.dailyGasBudget;
}

// ------------------------------------------------------------------ treasury flows

async function balances(addr: Address): Promise<{ balance: bigint; claimable: bigint }> {
  const [balance, claimable] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    publicClient.readContract({ address: contract, abi: x429Abi, functionName: "claimable", args: [addr] }),
  ]);
  return { balance, claimable };
}

/** Withdraw claimable ≥ withdrawMin; sweep excess above sweepAbove back to the treasury; top up bots below topupMin. */
async function treasuryFlows(): Promise<void> {
  // each bot only touches its own wallet, so bots run in parallel; the treasury then tops up one by one
  await Promise.all(bots.map((bot) => botFlows(bot)));
  if (!treasury || !treasuryAccount) return;
  for (const bot of bots) {
    try {
      const balance = await publicClient.getBalance({ address: bot.account.address });
      if (balance >= cfg.topupMin) continue;
      const treasuryBalance = await publicClient.getBalance({ address: treasuryAccount.address });
      if (treasuryBalance <= cfg.treasuryReserve) {
        log({ evt: "topup_skipped", bot: bot.spec.name, reason: "treasury at reserve", treasuryUsdc: fmtUsdc(treasuryBalance) });
        continue;
      }
      let amount = cfg.topupTo - balance;
      if (treasuryBalance - amount < cfg.treasuryReserve) amount = treasuryBalance - cfg.treasuryReserve;
      if (amount <= 0n) continue;
      const r = await sendTx(treasury, publicClient, { to: bot.account.address, value: amount });
      recordGas(r, "treasury", "topup");
      log({ evt: "topup", bot: bot.spec.name, amountUsdc: fmtUsdc(amount), tx: r.transactionHash });
    } catch (err) {
      log({ evt: "flow_error", bot: bot.spec.name, error: errMsg(err) });
    }
  }
}

async function botFlows(bot: Bot): Promise<void> {
  if (bot.busy) return;
  try {
    let { balance, claimable } = await balances(bot.account.address);
    if (claimable >= cfg.withdrawMin) {
      const r = await sendTx(bot.wallet, publicClient, {
        to: contract,
        data: encodeFunctionData({ abi: x429Abi, functionName: "withdraw" }),
      });
      recordGas(r, bot.spec.name, "withdraw");
      log({ evt: "withdraw", bot: bot.spec.name, amountUsdc: fmtUsdc(claimable), tx: r.transactionHash });
      ({ balance, claimable } = await balances(bot.account.address));
    }
    // hysteresis: above sweepAbove, send everything over sweepTo (default: the top-up target) back
    if (treasuryAccount && balance + claimable > cfg.sweepAbove && balance > cfg.sweepTo) {
      const amount = balance - cfg.sweepTo;
      const r = await sendTx(bot.wallet, publicClient, { to: treasuryAccount.address, value: amount });
      recordGas(r, bot.spec.name, "sweep");
      log({ evt: "sweep", bot: bot.spec.name, amountUsdc: fmtUsdc(amount), tx: r.transactionHash });
    }
  } catch (err) {
    log({ evt: "flow_error", bot: bot.spec.name, error: errMsg(err) });
  }
}

// ------------------------------------------------------------------ rushes

let rushActive = false;
let rushSeq = 0;

function shuffle<T>(xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type ArrivalResult = { ok: boolean; status?: number; overtook: boolean; paid: bigint };

async function arrive(bot: Bot, rush: number): Promise<ArrivalResult> {
  const { valuePerSecond, factor } = arrivalValuePerSecond(bot.spec);
  const result: ArrivalResult = { ok: false, overtook: false, paid: 0n };
  bot.busy = true;
  const who = bot.spec.name;
  log({ evt: "arrive", rush, bot: who, valuePerSecond, factor: Number(factor.toFixed(3)) });
  try {
    const res = await x429Fetch(`${cfg.apiUrl}/v1/fortune`, { method: "GET" }, {
      wallet: bot.wallet,
      publicClient,
      watcher,
      valuePerSecond,
      gasCost: cfg.gasCost,
      timeoutMs: cfg.agentTimeoutS * 1000,
      onDescriptor: (d) => log({ evt: "429", rush, bot: who, queueLength: d.queueLength }),
      onDecision: (d) =>
        log({
          evt: "decision",
          rush,
          bot: who,
          skipPriceUsdc: fmtUsdc(d.mySkipPrice),
          overtake: d.overtake,
          pass: d.passIds.length,
          costUsdc: fmtUsdc(d.cost),
          surplusUsdc: fmtUsdc(d.surplus),
        }),
      onJoin: (e) => log({ evt: "joined", rush, bot: who, ticketId: e.ticketId, position: e.position, skipPriceUsdc: fmtUsdc(e.skipPrice), tx: e.txHash }),
      onOvertake: (e) => {
        result.overtook = true;
        result.paid = e.paid;
        log({ evt: "overtook", rush, bot: who, ticketId: e.ticketId, passed: e.passed, paidUsdc: fmtUsdc(e.paid), tx: e.txHash });
      },
      onServed: (e) =>
        log({ evt: "served", rush, bot: who, ticketId: e.ticketId, waited: e.waited, timesPassed: e.timesPassed, earnedUsdc: fmtUsdc(e.earned), tx: e.txHash }),
      onLeave: (e) => log({ evt: "left", rush, bot: who, ticketId: e.ticketId, reason: e.reason, tx: e.txHash }),
      onGas: (r) => recordGas(r, who, "queue"),
    });
    result.status = res.status;
    const body = (await res.json().catch(() => ({}))) as { fortune?: string; receipt?: unknown; error?: string; reason?: string };
    result.ok = res.status === 200;
    log({ evt: "fortune", rush, bot: who, status: res.status, fortune: body.fortune, receipt: body.receipt, error: body.error, reason: body.reason });
  } catch (err) {
    log({ evt: "arrival_error", rush, bot: who, code: err instanceof X429Error ? err.code : undefined, error: errMsg(err) });
  } finally {
    bot.busy = false;
  }
  return result;
}

async function rush(kind: "scheduled" | "human" | "manual", spreadS: number, trigger?: Record<string, unknown>): Promise<void> {
  if (rushActive) {
    log({ evt: "rush_skipped", kind, reason: "a rush is already running", ...trigger });
    return;
  }
  if (overBudget()) {
    log({ evt: "rush_skipped", kind, reason: "daily gas budget exhausted", spentUsdc: fmtUsdc(BigInt(day().gasWei)), budgetUsdc: fmtUsdc(cfg.dailyGasBudget) });
    return;
  }
  rushActive = true;
  const id = ++rushSeq;
  const startedAt = Date.now();
  try {
    day().rushes++;
    if (kind === "human") {
      day().humanRushes++;
      state.lastHumanRushAt = startedAt;
    }
    saveState();
    log({ evt: "rush_start", rush: id, kind, spreadS, bots: bots.length, ...trigger });
    await treasuryFlows();
    const order = shuffle(bots.filter((b) => !b.busy));
    const offsets = order.map(() => Math.random() * spreadS * 1000).sort((a, b) => a - b);
    const flowsMs = Date.now() - startedAt;
    const results = await Promise.all(
      order.map(
        (bot, i) =>
          new Promise<ArrivalResult>((resolve) => {
            setTimeout(() => resolve(arrive(bot, id)), Math.max(0, offsets[i]! - flowsMs));
          }),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    const overtakes = results.filter((r) => r.overtook).length;
    const paid = results.reduce((s, r) => s + r.paid, 0n);
    log({ evt: "rush_done", rush: id, kind, ok, failed: results.length - ok, overtakes, paidUsdc: fmtUsdc(paid), seconds: Math.round((Date.now() - startedAt) / 1000) });
  } finally {
    rushActive = false;
  }
  if (cfg.exitAfterRush) shutdown("rush done");
}

function maybeHumanRush(owner: Address, ticketId: bigint): void {
  const trigger = { trigger: "human_join", owner, ticketId: ticketId.toString() };
  if (rushActive) return log({ evt: "rush_skipped", kind: "human", reason: "bots are already rushing", ...trigger });
  const cooldownMs = cfg.humanRushCooldownMin * 60_000;
  if (Date.now() - state.lastHumanRushAt < cooldownMs) {
    return log({ evt: "rush_skipped", kind: "human", reason: "cooldown", ...trigger });
  }
  if (day().humanRushes >= cfg.maxHumanRushesPerDay) {
    return log({ evt: "rush_skipped", kind: "human", reason: "daily human rush cap", ...trigger });
  }
  void rush("human", cfg.humanRushSpreadS, trigger);
}

// ------------------------------------------------------------------ main

const watcher = new QueueWatcher({
  client: publicClient,
  contract,
  queueId: cfg.queueId,
  pollMs: cfg.pollMs,
  onError: (err, retryInMs, rateLimited) => log({ evt: "watcher_error", rateLimited, retryInMs, error: errMsg(err) }),
});

watcher.subscribe(({ events }) => {
  for (const ev of events) {
    if (ev.eventName === "Joined" && !known.has(ev.args.owner.toLowerCase())) {
      log({ evt: "human_joined", owner: ev.args.owner, ticketId: ev.args.ticketId, skipPriceUsdc: fmtUsdc(ev.args.skipPrice), tx: ev.transactionHash });
      maybeHumanRush(ev.args.owner, ev.args.ticketId);
    }
  }
});

const periodMs = cfg.rushEveryMin * 60_000;
let nextScheduled = Math.ceil(Date.now() / periodMs) * periodMs;
let scheduler: ReturnType<typeof setInterval> | undefined;

function shutdown(reason: string): void {
  log({ evt: "shutdown", reason });
  if (scheduler) clearInterval(scheduler);
  watcher.stop();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main(): Promise<void> {
  log({
    evt: "start",
    chainId: cfg.chain.id,
    contract,
    queueId: cfg.queueId,
    api: cfg.apiUrl,
    bots: bots.map((b) => ({ name: b.spec.name, address: b.account.address })),
    treasury: treasuryAccount?.address,
    rushEveryMin: cfg.rushEveryMin,
    nextScheduledRush: new Date(nextScheduled).toISOString(),
    gasSpentTodayUsdc: fmtUsdc(BigInt(day().gasWei), 8),
  });
  watcher.start();
  await watcher.waitForSnapshot();
  if (cfg.rushNow) void rush("manual", cfg.rushSpreadS, { trigger: "X429_RUSH_NOW" });
  scheduler = setInterval(() => {
    if (Date.now() < nextScheduled) return;
    nextScheduled = Math.ceil((Date.now() + 1) / periodMs) * periodMs;
    void rush("scheduled", cfg.rushSpreadS);
  }, 1000);
}

main().catch((err) => {
  log({ evt: "fatal", error: errMsg(err) });
  process.exit(1);
});
