import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeFunctionData, parseEventLogs, verifyMessage, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { x429Abi } from "./abi.ts";
import { FEES, TicketStatus, caip2, sendTx, statusName, ticketMessage, usdc } from "./chain.ts";
import { SIGNATURE_HEADER, TICKET_HEADER, type X429Descriptor } from "./client.ts";
import { QueueWatcher, type QueueSnapshot } from "./watcher.ts";

/** A served ticket that may redeem one request. */
export type Admission = {
  ticketId: bigint;
  owner: Address;
  servedAt: number;
  expiresAt: number;
  servedTx: Hash;
  waited: number;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
};

export type GateLog = (entry: Record<string, unknown>) => void;

export type X429GateOptions = {
  publicClient: PublicClient;
  /** The queue operator's wallet. Without it the gate answers requests but never serves the queue. */
  operator?: WalletClient;
  contract: Address;
  queueId: number;
  /** Defaults to publicClient.chain.id. */
  chainId?: number;
  /** One request is admitted per interval. Default 15 000 ms. */
  serviceIntervalMs?: number;
  /** Admission round: the head is served only after waiting this long since its own join. Default = serviceIntervalMs. */
  minQueueMs?: number;
  /** How long a served ticket may take to come back. Default 60 000 ms. */
  admissionTtlMs?: number;
  /** Advertised in the descriptor. Default 0.002 USDC. */
  suggestedSkipPrice?: bigint;
  /** Shared watcher; created (and started by `start()`) if omitted. */
  watcher?: QueueWatcher;
  /** Poll period of the watcher the gate creates. Default 1500 ms. */
  pollMs?: number;
  /** How often the operator loop checks whether it may serve. Default 250 ms. */
  tickMs?: number;
  /** Path that returns the descriptor. Default "/x429". */
  descriptorPath?: string;
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  log?: GateLog;
  now?: () => number;
};

export type GateStats = {
  direct: number;
  queued: number;
  rejected429: number;
  forbidden403: number;
  served: number;
  serveErrors: number;
  busyUntil: number;
  admissions: number;
};

/** `(req, res) => Promise<boolean>`: true means the gate already answered (429, 403 or the descriptor). */
export type X429Gate = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & {
  readonly watcher: QueueWatcher;
  /** Starts the watcher (if the gate owns it) and the operator loop. */
  start(): void;
  stop(): void;
  /** The admission redeemed by this request, if it came through the queue. */
  admission(req: IncomingMessage): Admission | undefined;
  descriptor(ticket?: X429Descriptor["ticket"]): X429Descriptor;
  stats(): GateStats;
};

const TICKET_RE = /^[0-9]{1,20}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

export function createX429Gate(opts: X429GateOptions): X429Gate {
  const client = opts.publicClient;
  const chainId = opts.chainId ?? client.chain?.id;
  if (chainId === undefined) throw new Error("createX429Gate: chainId unknown (pass opts.chainId or a client with a chain)");
  const contract = opts.contract;
  const queueId = opts.queueId;
  const interval = opts.serviceIntervalMs ?? 15_000;
  const minQueueMs = opts.minQueueMs ?? interval;
  const ttl = opts.admissionTtlMs ?? 60_000;
  const suggested = opts.suggestedSkipPrice ?? usdc("0.002");
  const descriptorPath = opts.descriptorPath ?? "/x429";
  const now = opts.now ?? Date.now;
  const log: GateLog = opts.log ?? (() => {});
  const ownWatcher = !opts.watcher;
  const watcher =
    opts.watcher ??
    new QueueWatcher({
      client,
      contract,
      queueId,
      pollMs: opts.pollMs ?? 1500,
      onError: (err, retryInMs, rateLimited) =>
        log({ evt: "watcher_error", rateLimited, retryInMs, error: String((err as Error)?.message ?? err).split("\n")[0] }),
    });

  let busyUntil = 0;
  let serving = false; // a serve tx is in flight
  let lastServeAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const admissions = new Map<bigint, Admission>();
  const consumed = new Set<bigint>();
  const redeemed = new WeakMap<IncomingMessage, Admission>();
  const stats: GateStats = {
    direct: 0,
    queued: 0,
    rejected429: 0,
    forbidden403: 0,
    served: 0,
    serveErrors: 0,
    busyUntil: 0,
    admissions: 0,
  };

  function descriptor(ticket: X429Descriptor["ticket"] = null): X429Descriptor {
    return {
      version: "0.1",
      network: caip2(chainId!),
      chainId: chainId!,
      contract,
      queueId,
      queueLength: watcher.snapshot?.length ?? 0,
      serviceIntervalMs: interval,
      admissionTtlMs: ttl,
      suggestedSkipPrice: suggested.toString(),
      currency: { symbol: "USDC", decimals: 18 },
      signature: `x429:v1:${chainId}:${contract.toLowerCase()}:<ticketId>`,
      ticket,
    };
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-429-network": caip2(chainId!),
      "x-429-queue": `${contract}/${queueId}`,
      ...headers,
    });
    res.end(text);
  }

  /** Seconds until a request at `position` (1 = head) can expect to be served. */
  function etaSeconds(position: number): number {
    const t = now();
    const free = Math.max(0, busyUntil - t);
    return Math.max(1, Math.ceil((free + Math.max(0, position - 1) * interval) / 1000));
  }

  function tooMany(res: ServerResponse, ticket: X429Descriptor["ticket"], retryAfterS: number): true {
    stats.rejected429++;
    send(res, 429, { error: "too_many_requests", x429: descriptor(ticket) }, { "retry-after": String(retryAfterS) });
    return true;
  }

  function forbidden(res: ServerResponse, reason: string, ticketId?: bigint): true {
    stats.forbidden403++;
    log({ evt: "forbidden", reason, ticketId: ticketId?.toString() });
    send(res, 403, { error: "forbidden", reason, x429: descriptor(null) });
    return true;
  }

  function sweep(): void {
    const t = now();
    for (const [id, a] of admissions) {
      if (a.expiresAt < t) {
        admissions.delete(id);
        remember(id);
        log({ evt: "admission_expired", ticketId: id.toString(), owner: a.owner });
      }
    }
  }

  function remember(id: bigint): void {
    consumed.add(id);
    if (consumed.size > 50_000) consumed.delete(consumed.values().next().value!);
  }

  async function handleTicket(req: IncomingMessage, res: ServerResponse, rawId: string, rawSig: string): Promise<boolean> {
    if (!TICKET_RE.test(rawId) || !SIG_RE.test(rawSig)) return forbidden(res, "malformed_ticket");
    const id = BigInt(rawId);
    const sig = rawSig as Hex;
    const message = ticketMessage(chainId!, contract, id);
    sweep();
    if (consumed.has(id)) return forbidden(res, "ticket_used_or_expired", id);

    const adm = admissions.get(id);
    if (adm) {
      const ok = await verifyMessage({ address: adm.owner, message, signature: sig }).catch(() => false);
      if (!ok) return forbidden(res, "bad_signature", id);
      // re-check after the await: an admission is consumed exactly once
      if (!admissions.has(id) || consumed.has(id)) return forbidden(res, "ticket_used_or_expired", id);
      admissions.delete(id);
      remember(id);
      redeemed.set(req, adm);
      stats.queued++;
      log({ evt: "admit", via: "queue", ticketId: id.toString(), owner: adm.owner, waited: adm.waited });
      return false;
    }

    // not admitted (yet): look at the ticket onchain
    let t: readonly [Address, number, number, number, number, bigint, bigint, bigint, bigint, bigint];
    try {
      t = await client.readContract({ address: contract, abi: x429Abi, functionName: "tickets", args: [id] });
    } catch {
      return tooMany(res, null, 2);
    }
    const [owner, tQueue, status] = t;
    if (status === TicketStatus.None || tQueue !== queueId) return forbidden(res, "unknown_ticket", id);
    const ok = await verifyMessage({ address: owner, message, signature: sig }).catch(() => false);
    if (!ok) return forbidden(res, "bad_signature", id);
    if (status === TicketStatus.Waiting) {
      const snap = watcher.snapshot;
      let position = snap?.tickets.find((x) => x.id === id)?.position;
      if (position === undefined) {
        position = await client
          .readContract({ address: contract, abi: x429Abi, functionName: "positionOf", args: [id] })
          .then(Number)
          .catch(() => 0);
      }
      return tooMany(res, { id: id.toString(), status: "waiting", position }, etaSeconds(position || 1));
    }
    if (status === TicketStatus.Served && serving) {
      // served onchain, receipt not processed yet: come back in a second
      return tooMany(res, { id: id.toString(), status: "serving", position: 0 }, 1);
    }
    return forbidden(res, status === TicketStatus.Served ? "not_admitted" : `ticket_${statusName(status)}`, id);
  }

  async function operatorTick(): Promise<void> {
    if (!opts.operator || serving) return;
    sweep();
    const snap: QueueSnapshot | undefined = watcher.snapshot;
    if (!snap || snap.length === 0) return;
    if (snap.fetchedAt <= lastServeAt) return; // wait for a snapshot taken after our last serve
    const t = now();
    if (t < busyUntil) return;
    const head = snap.tickets[0]!;
    if (t < head.joinedAt * 1000 + minQueueMs) return; // admission round still open
    serving = true;
    try {
      const receipt = await sendTx(
        opts.operator,
        client,
        { to: contract, data: encodeFunctionData({ abi: x429Abi, functionName: "serve", args: [queueId, 1] }) },
        { fees: opts.fees ?? FEES },
      );
      lastServeAt = now();
      if (receipt.status !== "success") throw new Error(`serve reverted in ${receipt.transactionHash}`);
      const servedNow = now();
      for (const ev of parseEventLogs({ abi: x429Abi, logs: receipt.logs, eventName: "Served", strict: true })) {
        const a = ev.args;
        const adm: Admission = {
          ticketId: a.ticketId,
          owner: a.owner,
          servedAt: servedNow,
          expiresAt: servedNow + ttl,
          servedTx: receipt.transactionHash,
          waited: Number(a.waited),
          timesPassed: Number(a.timesPassed),
          earned: a.earned,
          paid: a.paid,
        };
        admissions.set(a.ticketId, adm);
        stats.served++;
        stats.admissions = admissions.size;
        busyUntil = servedNow + interval;
        stats.busyUntil = busyUntil;
        log({
          evt: "served",
          ticketId: a.ticketId.toString(),
          owner: a.owner,
          waited: adm.waited,
          timesPassed: adm.timesPassed,
          earned: adm.earned.toString(),
          paid: adm.paid.toString(),
          tx: receipt.transactionHash,
          gasUsed: receipt.gasUsed.toString(),
        });
      }
    } catch (err) {
      stats.serveErrors++;
      lastServeAt = now();
      busyUntil = Math.max(busyUntil, now() + 2000);
      log({ evt: "serve_error", error: String((err as Error)?.message ?? err).split("\n")[0] });
    } finally {
      serving = false;
      watcher.refresh().catch(() => {});
    }
  }

  const gate = (async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === descriptorPath && (req.method === "GET" || req.method === "HEAD")) {
      send(res, 200, descriptor(null));
      return true;
    }
    const rawId = header(req, TICKET_HEADER);
    const rawSig = header(req, SIGNATURE_HEADER);
    if (rawId !== undefined || rawSig !== undefined) {
      return handleTicket(req, res, rawId ?? "", rawSig ?? "");
    }
    const snap = watcher.snapshot;
    const t = now();
    if (snap && snap.length === 0 && !serving && t >= busyUntil) {
      busyUntil = t + interval;
      stats.busyUntil = busyUntil;
      stats.direct++;
      log({ evt: "admit", via: "direct" });
      return false;
    }
    return tooMany(res, null, etaSeconds((snap?.length ?? 0) + 1));
  }) as X429Gate;

  Object.defineProperty(gate, "watcher", { value: watcher, enumerable: true });
  gate.start = () => {
    if (ownWatcher) watcher.start();
    if (!timer && opts.operator) {
      timer = setInterval(() => void operatorTick(), opts.tickMs ?? 250);
    }
  };
  gate.stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ownWatcher) watcher.stop();
  };
  gate.admission = (req) => redeemed.get(req);
  gate.descriptor = descriptor;
  gate.stats = () => ({ ...stats, admissions: admissions.size, busyUntil });
  return gate;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}
