// Environment parsing for the demo processes. Secrets are only ever read from key files whose
// paths come from the environment, and are never logged.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, getAddress, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC_EXPLORER, ARC_RPC_URLS, anvilLocal, arc, makeTransport, usdc } from "../sdk/src/chain.ts";
import { BOTS, type BotSpec } from "./bots.ts";

export type Env = Record<string, string | undefined>;

export type DemoConfig = {
  chainKind: "arc" | "anvil";
  chain: Chain;
  rpcUrls: string[];
  explorer: string;
  contract: Address | undefined;
  queueId: number;
  deployBlock: bigint | undefined;
  host: string;
  port: number;
  apiUrl: string;
  serviceIntervalMs: number;
  minQueueMs: number;
  admissionTtlMs: number;
  suggestedSkipPrice: bigint;
  pollMs: number;
  // agents
  rushEveryMin: number;
  rushSpreadS: number;
  humanRushSpreadS: number;
  humanRushCooldownMin: number;
  maxHumanRushesPerDay: number;
  rushNow: boolean;
  exitAfterRush: boolean;
  agentTimeoutS: number;
  stateFile: string;
  dailyGasBudget: bigint;
  gasCost: bigint;
  topupMin: bigint;
  topupTo: bigint;
  treasuryReserve: bigint;
  withdrawMin: bigint;
  sweepAbove: bigint;
  sweepTo: bigint;
  // key files (paths only)
  operatorKeyFile: string | undefined;
  treasuryKeyFile: string | undefined;
  botKeysDir: string | undefined;
  addressesFile: string | undefined;
};

function str(env: Env, name: string, fallback: string): string {
  const v = env[name]?.trim();
  return v ? v : fallback;
}

function num(env: Env, name: string, fallback: number): number {
  const v = env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function amount(env: Env, name: string, fallback: string): bigint {
  const v = env[name]?.trim();
  try {
    return usdc(v ? v : fallback);
  } catch {
    throw new Error(`${name} must be a USDC amount like 0.25, got "${v}"`);
  }
}

function flag(env: Env, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function loadConfig(env: Env = process.env): DemoConfig {
  const chainKind = str(env, "X429_CHAIN", "arc");
  if (chainKind !== "arc" && chainKind !== "anvil") throw new Error(`X429_CHAIN must be arc or anvil, got "${chainKind}"`);
  const defaultRpcs = chainKind === "arc" ? [...ARC_RPC_URLS] : ["http://127.0.0.1:8545"];
  const rpcUrls = str(env, "X429_RPC_URLS", defaultRpcs.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = chainKind === "arc" ? arc : anvilLocal;
  const chain: Chain = { ...base, rpcUrls: { default: { http: rpcUrls } } };
  const rawContract = env.X429_CONTRACT?.trim();
  const host = str(env, "X429_HOST", "127.0.0.1");
  const port = num(env, "X429_PORT", 8429);
  const serviceIntervalMs = num(env, "X429_SERVICE_INTERVAL_MS", 15_000);
  const defaultPoll = chainKind === "arc" ? 1500 : 1000;
  const pollMs = num(env, "X429_POLL_MS", defaultPoll);
  if (chainKind === "arc" && pollMs < 1500) throw new Error("X429_POLL_MS must be ≥ 1500 on Arc (public RPC rate limits)");
  const topupTo = amount(env, "X429_TOPUP_TO_USDC", "0.25");
  const deployBlock = env.X429_DEPLOY_BLOCK?.trim();
  return {
    chainKind,
    chain,
    rpcUrls,
    explorer: str(env, "X429_EXPLORER", ARC_EXPLORER),
    contract: rawContract ? getAddress(rawContract) : undefined,
    queueId: num(env, "X429_QUEUE_ID", 1),
    deployBlock: deployBlock ? BigInt(deployBlock) : undefined,
    host,
    port,
    apiUrl: str(env, "X429_API_URL", `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`).replace(/\/$/, ""),
    serviceIntervalMs,
    minQueueMs: num(env, "X429_MIN_QUEUE_MS", serviceIntervalMs),
    admissionTtlMs: num(env, "X429_ADMISSION_TTL_MS", 60_000),
    suggestedSkipPrice: amount(env, "X429_SUGGESTED_SKIP_PRICE_USDC", "0.002"),
    pollMs,
    rushEveryMin: num(env, "X429_RUSH_EVERY_MIN", 120),
    rushSpreadS: num(env, "X429_RUSH_SPREAD_S", 40),
    humanRushSpreadS: num(env, "X429_HUMAN_RUSH_SPREAD_S", 12),
    humanRushCooldownMin: num(env, "X429_HUMAN_RUSH_COOLDOWN_MIN", 10),
    maxHumanRushesPerDay: num(env, "X429_MAX_HUMAN_RUSHES_PER_DAY", 12),
    rushNow: flag(env, "X429_RUSH_NOW"),
    exitAfterRush: flag(env, "X429_EXIT_AFTER_RUSH"),
    agentTimeoutS: num(env, "X429_AGENT_TIMEOUT_S", 600),
    stateFile: str(env, "X429_STATE_FILE", "./.state/agents.json"),
    dailyGasBudget: amount(env, "X429_DAILY_GAS_BUDGET_USDC", "0.5"),
    gasCost: amount(env, "X429_GAS_COST_USDC", "0.003"),
    topupMin: amount(env, "X429_TOPUP_MIN_USDC", "0.05"),
    topupTo,
    treasuryReserve: amount(env, "X429_TREASURY_RESERVE_USDC", "0.5"),
    withdrawMin: amount(env, "X429_WITHDRAW_MIN_USDC", "0.02"),
    sweepAbove: amount(env, "X429_SWEEP_ABOVE_USDC", "0.6"),
    sweepTo: env.X429_SWEEP_TO_USDC?.trim() ? amount(env, "X429_SWEEP_TO_USDC", "0.25") : topupTo,
    operatorKeyFile: env.X429_OPERATOR_KEY_FILE?.trim() || undefined,
    treasuryKeyFile: env.X429_TREASURY_KEY_FILE?.trim() || undefined,
    botKeysDir: env.X429_BOT_KEYS_DIR?.trim() || undefined,
    addressesFile: env.X429_ADDRESSES_FILE?.trim() || undefined,
  };
}

export function requireContract(cfg: DemoConfig): Address {
  if (!cfg.contract) throw new Error("X429_CONTRACT is not set");
  return cfg.contract;
}

/** Reads a key file holding one 0x-prefixed 32-byte hex key. The key is never logged. */
export function readKeyFile(path: string | undefined, label: string): PrivateKeyAccount {
  if (!path) throw new Error(`no key file configured for ${label}`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`cannot read key file for ${label}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`key file for ${label} must hold one 0x-hex private key`);
  return privateKeyToAccount(raw as Hex);
}

export type BotAccount = { slug: string; spec: BotSpec; account: PrivateKeyAccount };

/** Loads bot1.key … bot8.key from X429_BOT_KEYS_DIR. Missing files are skipped. */
export function readBotKeys(cfg: DemoConfig): BotAccount[] {
  if (!cfg.botKeysDir) throw new Error("X429_BOT_KEYS_DIR is not set");
  const present = new Set(readdirSync(cfg.botKeysDir));
  const out: BotAccount[] = [];
  BOTS.forEach((spec, i) => {
    const slug = `bot${i + 1}`;
    if (!present.has(`${slug}.key`)) return;
    out.push({ slug, spec, account: readKeyFile(join(cfg.botKeysDir!, `${slug}.key`), slug) });
  });
  return out;
}

export type Addresses = { treasury?: Address; operator?: Address } & Partial<Record<`bot${number}`, Address>>;

/** Public address book `{treasury, operator, bot1..bot8}` from X429_ADDRESSES_FILE. */
export function readAddresses(cfg: DemoConfig): Addresses | undefined {
  if (!cfg.addressesFile) return undefined;
  const raw = JSON.parse(readFileSync(cfg.addressesFile, "utf8")) as Record<string, string>;
  const out: Record<string, Address> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = getAddress(v);
  }
  return out as Addresses;
}

export function makePublicClient(cfg: DemoConfig): PublicClient {
  return createPublicClient({
    chain: cfg.chain,
    transport: makeTransport(cfg.rpcUrls),
    pollingInterval: cfg.pollMs,
  }) as PublicClient;
}

export function makeWallet(cfg: DemoConfig, account: PrivateKeyAccount): WalletClient {
  return createWalletClient({ account, chain: cfg.chain, transport: makeTransport(cfg.rpcUrls) });
}

/** JSON-lines logger: one object per line on stdout, bigints as decimal strings. */
export function logger(component: string): (entry: Record<string, unknown>) => void {
  return (entry) => {
    const line = JSON.stringify({ t: new Date().toISOString(), c: component, ...entry }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    process.stdout.write(line + "\n");
  };
}

export function errMsg(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return String(e?.shortMessage ?? e?.message ?? err).split("\n")[0]!;
}
