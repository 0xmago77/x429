import {
  encodeFunctionData,
  parseEventLogs,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { x429Abi } from "./abi.ts";
import { FEES, TicketStatus, sendTx, sleep, ticketMessage, type TicketStatusName } from "./chain.ts";
import { decide, type PolicyDecision } from "./policy.ts";
import { TicketGoneError, readQueue, type QueueWatcher, type ServedInfo } from "./watcher.ts";

/** The `x429` object of a 429 response body. */
export type X429Descriptor = {
  version: string;
  network: string;
  chainId: number;
  contract: Address;
  queueId: number;
  queueLength: number;
  serviceIntervalMs: number;
  admissionTtlMs: number;
  /** native USDC wei, decimal string */
  suggestedSkipPrice: string;
  currency: { symbol: string; decimals: number };
  /** template of the message to sign, `x429:v1:<chainId>:<contract>:<ticketId>` */
  signature: string;
  ticket: { id: string; status: TicketStatusName | "serving"; position: number } | null;
};

export const TICKET_HEADER = "X-429-Ticket";
export const SIGNATURE_HEADER = "X-429-Signature";

export type JoinInfo = { ticketId: bigint; skipPrice: bigint; position: number; txHash: Hash; decision: PolicyDecision };
export type OvertakeInfo = { ticketId: bigint; passed: number; paid: bigint; passedIds: bigint[]; txHash: Hash };

export type X429FetchOptions = {
  /** Wallet with a local account and a chain, used to join/overtake/leave and to sign. */
  wallet: WalletClient;
  publicClient: PublicClient;
  /** What one second of waiting is worth to this client, in native USDC wei. */
  valuePerSecond: bigint;
  /** Shared watcher for the queue (recommended: one per process). Without it, `tickets(id)` is polled. */
  watcher?: QueueWatcher;
  /** Gas cost assumed by the policy. Default 0.003 USDC. */
  gasCost?: bigint;
  /** Post this skip price instead of the policy's. */
  skipPrice?: bigint;
  /** Never overtake, just join. */
  joinOnly?: boolean;
  /** Max time to wait for Served before leaving the queue. Default 10 min. */
  timeoutMs?: number;
  /** Poll period for `tickets(id)` when there is no watcher. Default 1500 ms. */
  pollMs?: number;
  /** How many times to retry the request after being served while the server still says 429. Default 8. */
  maxRetries?: number;
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onDescriptor?: (d: X429Descriptor) => void;
  onDecision?: (d: PolicyDecision, descriptor: X429Descriptor) => void;
  onJoin?: (e: JoinInfo) => void;
  onOvertake?: (e: OvertakeInfo) => void;
  onServed?: (e: ServedInfo) => void;
  onLeave?: (e: { ticketId: bigint; reason: string; txHash?: Hash }) => void;
  /** Every receipt this call paid gas for (for budget accounting). */
  onGas?: (receipt: TransactionReceipt) => void;
};

export type X429ErrorCode = "chain_mismatch" | "join_failed" | "timeout" | "gone" | "aborted";

export class X429Error extends Error {
  code: X429ErrorCode;
  ticketId: bigint | undefined;
  constructor(code: X429ErrorCode, message: string, ticketId?: bigint) {
    super(message);
    this.name = "X429Error";
    this.code = code;
    this.ticketId = ticketId;
  }
}

/** Parses an x429 descriptor out of a 429 response (without consuming the original body). */
export async function readDescriptor(res: Response): Promise<X429Descriptor | null> {
  if (res.status !== 429) return null;
  try {
    const body = (await res.clone().json()) as { x429?: X429Descriptor };
    const d = body?.x429;
    if (!d || typeof d.contract !== "string" || typeof d.chainId !== "number" || d.queueId === undefined) return null;
    return d;
  } catch {
    return null;
  }
}

function retryAfterMs(res: Response, fallbackMs: number): number {
  const v = res.headers.get("retry-after");
  const s = v === null ? NaN : Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : fallbackMs;
  return Math.min(Math.max(ms, 500), 30_000);
}

function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return { ...init, headers };
}

/**
 * `fetch`, but a 429 carrying an x429 descriptor is settled onchain: the client decides with
 * its value-of-time policy, joins (and possibly overtakes) the queue, waits until the operator
 * serves its ticket, then retries the request with a signed ticket.
 *
 * Non-x429 responses are returned untouched. Request bodies must be re-sendable (string,
 * Blob, URLSearchParams…), as the request is sent again after being served.
 */
export async function x429Fetch(input: string | URL | Request, init: RequestInit | undefined, opts: X429FetchOptions): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const first = await doFetch(input, init);
  const descriptor = await readDescriptor(first);
  if (!descriptor) return first;
  opts.onDescriptor?.(descriptor);

  const { wallet, publicClient } = opts;
  const account = wallet.account;
  if (!account) throw new X429Error("join_failed", "x429Fetch: wallet client has no account");
  const chainId = wallet.chain?.id ?? (await publicClient.getChainId());
  if (chainId !== descriptor.chainId) {
    throw new X429Error("chain_mismatch", `server queues on chain ${descriptor.chainId}, wallet is on ${chainId}`);
  }
  const contract = descriptor.contract;
  const queueId = Number(descriptor.queueId);

  // 1. decide
  const watcher =
    opts.watcher && opts.watcher.contract.toLowerCase() === contract.toLowerCase() && opts.watcher.queueId === queueId
      ? opts.watcher
      : undefined;
  const queue = watcher?.snapshot?.tickets ?? (await readQueue(publicClient, contract, queueId, 256));
  const decision = decide({
    valuePerSecond: opts.valuePerSecond,
    serviceIntervalMs: descriptor.serviceIntervalMs,
    queue,
    gasCost: opts.gasCost,
  });
  if (opts.skipPrice !== undefined) decision.mySkipPrice = opts.skipPrice;
  if (opts.joinOnly) decision.overtake = false;
  opts.onDecision?.(decision, descriptor);

  // 2. join (and overtake)
  const data = decision.overtake
    ? encodeFunctionData({
        abi: x429Abi,
        functionName: "joinAndOvertake",
        args: [queueId, decision.mySkipPrice, decision.maxPositions],
      })
    : encodeFunctionData({ abi: x429Abi, functionName: "join", args: [queueId, decision.mySkipPrice] });
  let receipt: TransactionReceipt;
  try {
    receipt = await sendTx(
      wallet,
      publicClient,
      { to: contract, data, value: decision.overtake ? decision.budget : undefined },
      { fees: opts.fees ?? FEES },
    );
  } catch (err) {
    throw new X429Error("join_failed", `join failed: ${(err as Error).message?.split("\n")[0]}`);
  }
  opts.onGas?.(receipt);
  if (receipt.status !== "success") throw new X429Error("join_failed", `join reverted in ${receipt.transactionHash}`);

  const logs = parseEventLogs({ abi: x429Abi, logs: receipt.logs, strict: true });
  const joined = logs.find(
    (l) => l.eventName === "Joined" && l.args.owner.toLowerCase() === account.address.toLowerCase(),
  );
  if (!joined || joined.eventName !== "Joined") throw new X429Error("join_failed", "no Joined event in receipt");
  const ticketId = joined.args.ticketId;
  opts.onJoin?.({
    ticketId,
    skipPrice: joined.args.skipPrice,
    position: Number(joined.args.position),
    txHash: receipt.transactionHash,
    decision,
  });
  const overtook = logs.find((l) => l.eventName === "Overtook" && l.args.ticketId === ticketId);
  if (overtook && overtook.eventName === "Overtook") {
    const passedIds = logs.flatMap((l) => (l.eventName === "Passed" && l.args.byTicketId === ticketId ? [l.args.passedTicketId] : []));
    opts.onOvertake?.({
      ticketId,
      passed: Number(overtook.args.positions),
      paid: overtook.args.paid,
      passedIds,
      txHash: receipt.transactionHash,
    });
  }

  // 3. wait to be served
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  let served: ServedInfo | null;
  try {
    served = watcher
      ? await watcher.waitForServed(ticketId, timeoutMs)
      : await pollServed(publicClient, contract, ticketId, timeoutMs, opts.pollMs ?? 1500, opts.signal);
  } catch (err) {
    if (err instanceof TicketGoneError) {
      throw new X429Error("gone", err.message, ticketId);
    }
    if (opts.signal?.aborted) {
      await leaveQuietly(opts, contract, ticketId, "aborted");
      throw new X429Error("aborted", "aborted while waiting", ticketId);
    }
    throw err;
  }
  if (!served) {
    await leaveQuietly(opts, contract, ticketId, "timeout");
    throw new X429Error("timeout", `ticket ${ticketId} not served within ${timeoutMs} ms`, ticketId);
  }
  opts.onServed?.(served);

  // 4. retry with the signed ticket
  const signature = await wallet.signMessage({ account, message: ticketMessage(chainId, contract, ticketId) });
  const retryInit = withHeaders(init, { [TICKET_HEADER]: ticketId.toString(), [SIGNATURE_HEADER]: signature });
  const maxRetries = opts.maxRetries ?? 8;
  let res = await doFetch(input, retryInit);
  for (let i = 0; i < maxRetries && res.status === 429; i++) {
    await sleep(retryAfterMs(res, 1000), opts.signal);
    res = await doFetch(input, retryInit);
  }
  return res;
}

/** Polls `tickets(id)` until it is served. Null on timeout; throws TicketGoneError if it left. */
export async function pollServed(
  client: PublicClient,
  contract: Address,
  ticketId: bigint,
  timeoutMs: number,
  pollMs = 1500,
  signal?: AbortSignal,
): Promise<ServedInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [owner, , status, timesPassed, , , , , earned, paid] = await client.readContract({
      address: contract,
      abi: x429Abi,
      functionName: "tickets",
      args: [ticketId],
    });
    if (status === TicketStatus.Served) {
      return { ticketId, owner, waited: -1, timesPassed: Number(timesPassed), earned, paid };
    }
    if (status === TicketStatus.Left || status === TicketStatus.Kicked) {
      throw new TicketGoneError(ticketId, status === TicketStatus.Kicked);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
  return null;
}

async function leaveQuietly(opts: X429FetchOptions, contract: Address, ticketId: bigint, reason: string): Promise<void> {
  try {
    const receipt = await sendTx(
      opts.wallet,
      opts.publicClient,
      { to: contract, data: encodeFunctionData({ abi: x429Abi, functionName: "leave", args: [ticketId] }) },
      { fees: opts.fees ?? FEES },
    );
    opts.onGas?.(receipt);
    opts.onLeave?.({ ticketId, reason, txHash: receipt.transactionHash });
  } catch {
    // already served/left in the meantime: nothing to do
    opts.onLeave?.({ ticketId, reason: `${reason} (leave failed)` });
  }
}
