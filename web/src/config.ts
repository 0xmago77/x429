// Runtime configuration: ./config.json and ./bots.json, fetched with relative URLs so the page
// works under the GitHub Pages subpath. Both files only contain public data.
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { ARC_EXPLORER, ARC_RPC_URLS } from "../../sdk/src/chain.ts";

export type Config = {
  chainId: number;
  chainName: string;
  rpcUrls: string[];
  explorer: string;
  contract: Address;
  queueId: number;
  deployBlock: bigint;
  rushEveryMin: number;
  serviceIntervalMs: number;
  repoUrl: string;
};

export type BotRole = "bot" | "operator" | "treasury";
export type Bot = { address: Address; name: string; emoji: string; role: BotRole };

export const DEFAULT_REPO_URL = "https://github.com/0xmago77/x429";
export const DEFAULT_RUSH_EVERY_MIN = 120;

/** The placeholder config ships the zero address until the orchestrator deploys the contract. */
export function isDeployed(config: Config): boolean {
  return config.contract.toLowerCase() !== zeroAddress;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function integer(value: unknown, fallback: number | undefined, name: string, min: number): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error(`config.json is missing "${name}"`);
    return fallback;
  }
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min) {
    throw new Error(`config.json: "${name}" must be an integer >= ${min}`);
  }
  return n;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json is not a JSON object");
  const r = raw as Record<string, unknown>;

  const chainId = integer(r.chainId, undefined, "chainId", 1);
  if (typeof r.contract !== "string" || !isAddress(r.contract, { strict: false })) {
    throw new Error('config.json: "contract" must be a 0x address');
  }
  const urls = Array.isArray(r.rpcUrls) ? r.rpcUrls.map(httpUrl).filter((u): u is string => u !== undefined) : [];
  const rpcUrls = urls.length > 0 ? urls : chainId === 5042 ? [...ARC_RPC_URLS] : [];
  if (rpcUrls.length === 0) throw new Error('config.json: "rpcUrls" has no http(s) URL');

  let deployBlock = 0n;
  if (typeof r.deployBlock === "number" && Number.isSafeInteger(r.deployBlock) && r.deployBlock > 0) {
    deployBlock = BigInt(r.deployBlock);
  } else if (typeof r.deployBlock === "string" && /^\d+$/.test(r.deployBlock)) {
    deployBlock = BigInt(r.deployBlock);
  }

  const chainName = typeof r.chainName === "string" && r.chainName.trim() ? r.chainName.trim().slice(0, 40) : "Arc";

  return {
    chainId,
    chainName,
    rpcUrls,
    explorer: httpUrl(r.explorer) ?? ARC_EXPLORER,
    contract: getAddress(r.contract),
    queueId: integer(r.queueId, 1, "queueId", 1),
    deployBlock,
    rushEveryMin: positive(r.rushEveryMin, DEFAULT_RUSH_EVERY_MIN),
    serviceIntervalMs: positive(r.serviceIntervalMs, 15_000),
    repoUrl: httpUrl(r.repoUrl) ?? DEFAULT_REPO_URL,
  };
}

export function parseBots(raw: unknown): Bot[] {
  if (!Array.isArray(raw)) return [];
  const bots: Bot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.address !== "string" || !isAddress(e.address, { strict: false })) continue;
    const role: BotRole = e.role === "operator" || e.role === "treasury" ? e.role : "bot";
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 32) : role;
    const emoji = typeof e.emoji === "string" ? Array.from(e.emoji.trim()).slice(0, 4).join("") : "";
    bots.push({ address: getAddress(e.address), name, emoji, role });
  }
  return bots;
}

async function loadJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

export async function loadConfig(url = "./config.json"): Promise<Config> {
  return parseConfig(await loadJson(url));
}

/** Never throws: a missing or broken bots.json just means "no names". */
export async function loadBots(url = "./bots.json"): Promise<Bot[]> {
  try {
    return parseBots(await loadJson(url));
  } catch (err) {
    console.warn("x429: could not load bots.json", err);
    return [];
  }
}
