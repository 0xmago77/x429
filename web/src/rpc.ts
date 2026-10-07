// Chain reads for the dashboard. No DOM in here, so it can be exercised from Node against anvil.
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createClient,
  parseEventLogs,
  type Address,
  type Chain,
  type Client,
  type Hash,
  type ParseEventLogsReturnType,
  type TransactionReceipt,
  type Transport,
} from "viem";
import { getLogs, getTransactionReceipt, readContract } from "viem/actions";
import { chainFor, isRangeError, isRateLimitError, makeTransport, sleep } from "../../sdk/src/chain.ts";
import { x429Abi } from "../../sdk/src/abi.ts";

export type ReadClient = Client<Transport, Chain>;
export type X429Log = ParseEventLogsReturnType<typeof x429Abi, undefined, true>[number];

export type QueueInfo = {
  operator: Address;
  length: number;
  maxLength: number;
  overtakes: number;
  head: bigint;
  tail: bigint;
  joined: bigint;
  served: bigint;
  totalCompensation: bigint;
  meta: string;
};

export type TicketView = {
  id: bigint;
  owner: Address;
  skipPrice: bigint;
  joinedAt: number;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
};

/**
 * Read-only client over the configured RPCs. viem's own retries are disabled (retryCount 0): the
 * fallback transport still moves to the next RPC on failure, and the dashboard applies its own
 * exponential backoff (2 s → 30 s) so it can tell the visitor "RPC busy, retrying".
 * The chain has no multicall3 configured, so reads are plain eth_calls.
 */
export function makeReadClient(chainId: number, rpcUrls: readonly string[]): ReadClient {
  return createClient({
    chain: chainFor(chainId, rpcUrls),
    transport: makeTransport(rpcUrls, { retryCount: 0, timeoutMs: 15_000 }),
    cacheTime: 0,
  });
}

// ------------------------------------------------------------------ errors and backoff

export function describeError(err: unknown): string {
  const text = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/** Name of the contract custom error behind a failed call (e.g. "NotWaiting"), if any. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? "reverted";
  return undefined;
}

/** The configured address has no contract code (eth_call returned 0x). */
export function isNoContract(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null;
}

/** Worth retrying later: anything but "ask for a smaller range" and genuine contract answers. */
export function isTransient(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (isRangeError(err)) return false;
  return revertName(err) === undefined && !isNoContract(err);
}

export type RpcHealth = "ok" | "busy" | "error";

/** Shared exponential backoff: 2 s, 4 s, … up to 30 s; reset on the first success. */
export class Backoff {
  static readonly BASE_MS = 2_000;
  static readonly MAX_MS = 30_000;
  delayMs = 0;
  health: RpcHealth = "ok";
  private readonly listener: (health: RpcHealth, detail: string) => void;

  constructor(listener: (health: RpcHealth, detail: string) => void = () => {}) {
    this.listener = listener;
  }

  /** Records a failure and returns how long to wait before retrying. */
  fail(err: unknown): number {
    this.delayMs = this.delayMs === 0 ? Backoff.BASE_MS : Math.min(this.delayMs * 2, Backoff.MAX_MS);
    this.health = isRateLimitError(err) ? "busy" : "error";
    this.listener(this.health, describeError(err));
    return this.delayMs;
  }

  ok(): void {
    if (this.delayMs === 0 && this.health === "ok") return;
    this.delayMs = 0;
    this.health = "ok";
    this.listener("ok", "");
  }
}

/** Runs `fn` until it succeeds, sleeping with `backoff` between transient failures. */
export async function withRetry<T>(fn: () => Promise<T>, backoff: Backoff): Promise<T> {
  for (;;) {
    try {
      const value = await fn();
      backoff.ok();
      return value;
    } catch (err) {
      if (!isTransient(err)) throw err;
      await sleep(backoff.fail(err));
    }
  }
}

// ------------------------------------------------------------------ logs

const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxB = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Fetches and decodes every X429Queue log in a block range, in chunks of at most `chunk` blocks. */
export class LogFetcher {
  /** Current chunk size; halved for good whenever an RPC says the range is too large. */
  chunk: bigint;
  private readonly client: ReadClient;
  private readonly address: Address;

  constructor(client: ReadClient, address: Address, chunk = 1000n) {
    this.client = client;
    this.address = address;
    this.chunk = chunk;
  }

  /**
   * All logs in [from, to]. Range errors halve the chunk and retry; transient errors are retried
   * with `backoff` when given, otherwise thrown (the caller's loop backs off instead).
   */
  async fetch(from: bigint, to: bigint, backoff?: Backoff): Promise<X429Log[]> {
    const out: X429Log[] = [];
    let start = from;
    while (start <= to) {
      const s = start;
      const e = minB(to, s + this.chunk - 1n);
      try {
        const logs = backoff ? await withRetry(() => this.once(s, e), backoff) : await this.once(s, e);
        out.push(...logs);
        start = e + 1n;
      } catch (err) {
        if (isRangeError(err) && e > s) {
          this.chunk = maxB(1n, (e - s + 1n) / 2n);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  private async once(fromBlock: bigint, toBlock: bigint): Promise<X429Log[]> {
    const logs = await getLogs(this.client, { address: this.address, fromBlock, toBlock });
    return parseEventLogs<typeof x429Abi, true, undefined>({ abi: x429Abi, logs, strict: true });
  }
}

export type ScanOptions = {
  fetcher: LogFetcher;
  backoff: Backoff;
  head: bigint;
  /** Lowest block to look at (deploy block or the history window). */
  floor: bigint;
  /** Stop once this many countable events have been found. */
  maxEvents: number;
  countable: (log: X429Log) => boolean;
  /** Chunks in flight at once. */
  concurrency?: number;
  /** Give up on older history after this long (the live view matters more). */
  budgetMs?: number;
};

export type ScanResult = { logs: X429Log[]; oldest: bigint; complete: boolean };

/**
 * Scans backwards from `head` in chunk-sized ranges, `concurrency` at a time, until `maxEvents`
 * countable events were found, `floor` was reached, or the time budget ran out.
 */
export async function scanBackwards(o: ScanOptions): Promise<ScanResult> {
  const concurrency = Math.max(1, o.concurrency ?? 2);
  const started = Date.now();
  const logs: X429Log[] = [];
  let found = 0;
  let to = o.head;
  let oldest = o.head + 1n;
  while (to >= o.floor && found < o.maxEvents) {
    if (o.budgetMs !== undefined && Date.now() - started > o.budgetMs) return { logs, oldest, complete: false };
    const ranges: [bigint, bigint][] = [];
    for (let i = 0; i < concurrency && to >= o.floor; i++) {
      const from = maxB(o.floor, to - o.fetcher.chunk + 1n);
      ranges.push([from, to]);
      to = from - 1n;
    }
    const results = await Promise.all(ranges.map(([from, end]) => o.fetcher.fetch(from, end, o.backoff)));
    for (const chunk of results) {
      logs.push(...chunk);
      found += chunk.filter(o.countable).length;
    }
    oldest = ranges[ranges.length - 1]![0];
  }
  return { logs, oldest, complete: true };
}

// ------------------------------------------------------------------ contract reads

export function readQueueInfo(client: ReadClient, address: Address, queueId: number): Promise<QueueInfo> {
  return readContract(client, { address, abi: x429Abi, functionName: "queueInfo", args: [queueId] });
}

export function readQueueList(
  client: ReadClient,
  address: Address,
  queueId: number,
  limit: number,
): Promise<readonly TicketView[]> {
  return readContract(client, { address, abi: x429Abi, functionName: "getQueue", args: [queueId, 0, limit] });
}

/** Polls for a receipt (Arc finalises in ~0.5 s); undefined if it did not show up within `timeoutMs`. */
export async function waitForReceipt(
  client: ReadClient,
  hash: Hash,
  timeoutMs = 120_000,
): Promise<TransactionReceipt | undefined> {
  const deadline = Date.now() + timeoutMs;
  let delay = 700;
  while (Date.now() < deadline) {
    try {
      return await getTransactionReceipt(client, { hash });
    } catch (err) {
      // not mined yet, or the RPC is busy: either way, ask again a bit later
      if (isRateLimitError(err)) delay = Math.min(delay * 2, 8_000);
    }
    await sleep(delay);
  }
  return undefined;
}
