import {
  defineChain,
  fallback,
  formatUnits,
  http,
  parseGwei,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";

/** Public Arc mainnet RPCs. The first one is the canonical endpoint. */
export const ARC_RPC_URLS: readonly string[] = [
  "https://rpc.mainnet.arc.io",
  "https://rpc.drpc.mainnet.arc.io",
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://rpc.quicknode.mainnet.arc.io",
];

export const ARC_EXPLORER = "https://explorer.arc.io";

/** Native USDC on Arc: 18 decimals for msg.value, balances and gas. */
export const NATIVE_USDC = { name: "USDC", symbol: "USDC", decimals: 18 } as const;

export const arc: Chain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: NATIVE_USDC,
  rpcUrls: { default: { http: [...ARC_RPC_URLS] } },
  blockExplorers: { default: { name: "Arc Explorer", url: ARC_EXPLORER } },
});

export const anvilLocal: Chain = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: NATIVE_USDC,
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export type TransportOptions = {
  /** Retries per endpoint before falling back to the next one. */
  retryCount?: number;
  /** Base delay of viem's exponential backoff, in ms. */
  retryDelayMs?: number;
  timeoutMs?: number;
};

/**
 * A fallback transport over several HTTP RPCs. viem retries 429 / 5xx with exponential
 * backoff (honouring Retry-After) and then moves on to the next endpoint.
 */
export function makeTransport(urls: readonly string[], opts: TransportOptions = {}): Transport {
  if (urls.length === 0) throw new Error("makeTransport: no RPC urls");
  const retryCount = opts.retryCount ?? 3;
  const retryDelay = opts.retryDelayMs ?? 600;
  const timeout = opts.timeoutMs ?? 20_000;
  const transports = urls.map((url) => http(url, { retryCount, retryDelay, timeout }));
  if (transports.length === 1) return transports[0]!;
  return fallback(transports, { retryCount, retryDelay });
}

/**
 * Every transaction x429 sends uses these fees. Arc's base fee floor is 20 gwei and a tx
 * whose maxFeePerGas is below it is silently dropped, so we leave plenty of headroom.
 */
export const FEES = {
  maxFeePerGas: parseGwei("50"),
  maxPriorityFeePerGas: parseGwei("0.01"),
} as const;

/** `usdc("0.002")` → 2000000000000000n (native USDC, 18 decimals). */
export function usdc(amount: string | number): bigint {
  return parseUnits(typeof amount === "number" ? amount.toString() : amount, 18);
}

/** Formats native USDC wei as a decimal string, trimmed to at most `maxDecimals` places. */
export function fmtUsdc(wei: bigint, maxDecimals = 6): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const [whole, frac = ""] = formatUnits(abs, 18).split(".");
  let f = frac.slice(0, maxDecimals).replace(/0+$/, "");
  // keep tiny non-zero amounts visible instead of rounding them to "0"
  if (f === "" && whole === "0" && abs > 0n) return `${negative ? "-" : ""}<0.${"0".repeat(Math.max(0, maxDecimals - 1))}1`;
  return `${negative ? "-" : ""}${whole}${f ? "." + f : ""}`;
}

export function explorerTx(hash: Hash | string, explorer: string = ARC_EXPLORER): string {
  return `${explorer.replace(/\/$/, "")}/tx/${hash}`;
}

export function explorerAddress(address: Address | string, explorer: string = ARC_EXPLORER): string {
  return `${explorer.replace(/\/$/, "")}/address/${address}`;
}

/** Picks the chain definition for a chain id, optionally overriding its RPC urls. */
export function chainFor(chainId: number, rpcUrls?: readonly string[]): Chain {
  const base = chainId === arc.id ? arc : chainId === anvilLocal.id ? anvilLocal : undefined;
  if (!base) {
    if (!rpcUrls?.length) throw new Error(`unknown chain ${chainId}`);
    return defineChain({
      id: chainId,
      name: `chain ${chainId}`,
      nativeCurrency: NATIVE_USDC,
      rpcUrls: { default: { http: [...rpcUrls] } },
    });
  }
  if (!rpcUrls?.length) return base;
  return { ...base, rpcUrls: { default: { http: [...rpcUrls] } } };
}

/** CAIP-2 network id, e.g. `eip155:5042`. */
export function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}

/** The exact message a ticket owner signs to redeem an admission (EIP-191 personal_sign). */
export function ticketMessage(chainId: number, contract: Address | string, ticketId: bigint | number | string): string {
  return `x429:v1:${chainId}:${contract.toLowerCase()}:${BigInt(ticketId).toString()}`;
}

/** Ticket status, mirrors `X429Queue.Status`. */
export const TicketStatus = {
  None: 0,
  Waiting: 1,
  Served: 2,
  Left: 3,
  Kicked: 4,
} as const;
export type TicketStatusCode = (typeof TicketStatus)[keyof typeof TicketStatus];

export const STATUS_NAMES = ["none", "waiting", "served", "left", "kicked"] as const;
export type TicketStatusName = (typeof STATUS_NAMES)[number];

export function statusName(code: number): TicketStatusName {
  return STATUS_NAMES[code] ?? "none";
}

/** True for errors that mean "the RPC is rate limiting or overloaded" rather than a real failure. */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string; details?: string; cause?: unknown } | undefined;
  if (!e) return false;
  if (e.status === 429 || e.code === 429 || e.code === -32005) return true;
  const text = `${e.message ?? ""} ${e.details ?? ""}`.toLowerCase();
  if (text.includes("429") || text.includes("too many requests") || text.includes("rate limit")) return true;
  return e.cause !== undefined && e.cause !== err ? isRateLimitError(e.cause) : false;
}

/** True for eth_getLogs errors that ask for a smaller block range. */
export function isRangeError(err: unknown): boolean {
  const e = err as { code?: number; message?: string; details?: string; cause?: unknown } | undefined;
  if (!e) return false;
  if (e.code === -32012) return true;
  const text = `${e.message ?? ""} ${e.details ?? ""}`.toLowerCase();
  if (
    text.includes("range too large") ||
    text.includes("query exceeds max results") ||
    text.includes("retry with the range") ||
    text.includes("block range") ||
    text.includes("too many results") ||
    text.includes("limit exceeded")
  ) {
    return true;
  }
  return e.cause !== undefined && e.cause !== err ? isRangeError(e.cause) : false;
}

// ------------------------------------------------------------------ transactions

const walletLocks = new Map<string, Promise<void>>();
const nextNonces = new Map<string, number>();

/**
 * Runs `fn` while holding a per-address lock, so each wallet has at most one transaction in
 * flight. Behind a fallback transport, two concurrent sends could otherwise read the same
 * pending nonce from different providers.
 */
export async function withWalletLock<T>(address: Address, fn: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  const prev = walletLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  walletLocks.set(key, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (walletLocks.get(key) === tail) walletLocks.delete(key);
  }
}

export type TxRequest = {
  to: Address;
  data?: Hex;
  value?: bigint;
  /** Exact gas limit. Default: estimate × 1.25 + 25k, at least `minGas`. */
  gas?: bigint;
  /** Lower bound for the estimated gas limit (e.g. for overtakes, whose cost depends on who is passed at execution time). */
  minGas?: bigint;
};

export type SendTxOptions = {
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** Give up waiting for the receipt after this long. Default 120 s. */
  receiptTimeoutMs?: number;
  pollingIntervalMs?: number;
};

/**
 * Sends one transaction with x429's fixed fees and waits for its receipt, holding the wallet
 * lock throughout. The nonce is the max of the RPC's pending count and our own counter, so a
 * lagging RPC backend cannot make us reuse a nonce.
 */
export async function sendTx(
  wallet: WalletClient,
  client: PublicClient,
  req: TxRequest,
  opts: SendTxOptions = {},
): Promise<TransactionReceipt> {
  const account = wallet.account;
  if (!account) throw new Error("sendTx: wallet client has no account");
  const key = account.address.toLowerCase();
  return withWalletLock(account.address, async () => {
    const pending = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
    const nonce = Math.max(pending, nextNonces.get(key) ?? 0);
    const fees = opts.fees ?? FEES;
    // State can change between estimation and inclusion (another join lands first, so an
    // overtake passes different tickets), so never send with the bare estimate. Unused gas is
    // not charged.
    let gas = req.gas;
    if (gas === undefined) {
      const estimate = await client.estimateGas({ account, to: req.to, data: req.data, value: req.value });
      gas = estimate + estimate / 4n + 25_000n;
      if (req.minGas !== undefined && gas < req.minGas) gas = req.minGas;
    }
    let hash: Hash;
    try {
      hash = await wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: req.to,
        data: req.data,
        value: req.value,
        gas,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    } catch (err) {
      nextNonces.delete(key);
      throw err;
    }
    nextNonces.set(key, nonce + 1);
    try {
      return await client.waitForTransactionReceipt({
        hash,
        timeout: opts.receiptTimeoutMs ?? 120_000,
        pollingInterval: opts.pollingIntervalMs,
      });
    } catch (err) {
      // unknown fate: re-read the nonce from the chain next time, and tell the caller the tx
      // was broadcast (so it does not blindly send it again)
      nextNonces.delete(key);
      if (err && typeof err === "object") (err as { txHash?: Hash }).txHash = hash;
      throw err;
    }
  });
}

/** Gas actually paid by a receipt, in native USDC wei. */
export function gasCostOf(receipt: TransactionReceipt): bigint {
  return receipt.gasUsed * receipt.effectiveGasPrice;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
