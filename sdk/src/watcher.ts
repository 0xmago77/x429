import { parseEventLogs, type Address, type Hash, type ParseEventLogsReturnType, type PublicClient } from "viem";
import { x429Abi } from "./abi.ts";
import { TicketStatus, isRangeError, isRateLimitError, sleep } from "./chain.ts";

/** A decoded X429Queue event log. */
export type X429Log = ParseEventLogsReturnType<typeof x429Abi, undefined, true>[number];

/** A waiting ticket, in serving order. */
export type QueueTicket = {
  id: bigint;
  owner: Address;
  skipPrice: bigint;
  /** unix seconds */
  joinedAt: number;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
  /** 1-based, 1 = served next */
  position: number;
};

export type QueueSnapshot = {
  queueId: number;
  blockNumber: bigint;
  /** wall-clock ms when the snapshot was taken */
  fetchedAt: number;
  length: number;
  tickets: QueueTicket[];
};

export type ServedInfo = {
  ticketId: bigint;
  owner: Address;
  /** seconds between join and serve; -1 if only known from the ticket struct */
  waited: number;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
  txHash?: Hash;
  blockNumber?: bigint;
};

export type WatcherUpdate = { snapshot: QueueSnapshot; events: X429Log[] };

export type QueueWatcherOptions = {
  client: PublicClient;
  contract: Address;
  queueId: number;
  /** Poll period. Keep ≥ 1500 ms on public Arc RPCs. Default 1500. */
  pollMs?: number;
  /** First block to scan for logs. Default: the head block when the watcher starts. */
  fromBlock?: bigint;
  /** Max blocks per eth_getLogs request (halved on range errors). Default 1000. */
  logChunk?: bigint;
  /** Stay this many blocks behind the head when scanning logs, so lagging RPC backends behind a fallback cannot hide fresh logs. Default 1. */
  logLagBlocks?: bigint;
  /** How many tickets `getQueue` reads per poll. Default 256. */
  snapshotLimit?: number;
  /** Max backoff after RPC errors. Default 30 s. */
  maxBackoffMs?: number;
  onError?: (err: unknown, retryInMs: number, rateLimited: boolean) => void;
};

/** Thrown by waitForServed when the ticket leaves the queue without being served. */
export class TicketGoneError extends Error {
  ticketId: bigint;
  kicked: boolean;
  constructor(ticketId: bigint, kicked: boolean) {
    super(`ticket ${ticketId} ${kicked ? "was kicked" : "left the queue"}`);
    this.name = "TicketGoneError";
    this.ticketId = ticketId;
    this.kicked = kicked;
  }
}

type Waiter = { resolve: (v: ServedInfo | null) => void; reject: (e: unknown) => void };

/**
 * Fetches `eth_getLogs` for the contract in chunks of at most `chunk` blocks, halving the
 * chunk on "range too large" style errors, and decodes them with the x429 ABI.
 */
export async function getLogsChunked(
  client: PublicClient,
  args: { address: Address; fromBlock: bigint; toBlock: bigint; chunk?: bigint; signal?: AbortSignal },
): Promise<X429Log[]> {
  const out: X429Log[] = [];
  let size = args.chunk ?? 1000n;
  let from = args.fromBlock;
  while (from <= args.toBlock) {
    if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted");
    const to = from + size - 1n < args.toBlock ? from + size - 1n : args.toBlock;
    try {
      const raw = await client.getLogs({ address: args.address, fromBlock: from, toBlock: to });
      out.push(...parseEventLogs({ abi: x429Abi, logs: raw, strict: true }));
      from = to + 1n;
    } catch (err) {
      if (isRangeError(err) && size > 1n) {
        size = size / 2n;
        continue;
      }
      throw err;
    }
  }
  return out;
}

/** Reads `getQueue(queueId, 0, limit)` and returns the tickets in serving order. */
export async function readQueue(client: PublicClient, contract: Address, queueId: number, limit = 256): Promise<QueueTicket[]> {
  const list = await client.readContract({
    address: contract,
    abi: x429Abi,
    functionName: "getQueue",
    args: [queueId, 0, limit],
  });
  return list.map((t, i) => ({
    id: t.id,
    owner: t.owner,
    skipPrice: t.skipPrice,
    joinedAt: Number(t.joinedAt),
    timesPassed: Number(t.timesPassed),
    earned: t.earned,
    paid: t.paid,
    position: i + 1,
  }));
}

/**
 * One poller per process: every `pollMs` it reads the queue and any new contract logs, then
 * hands both to subscribers. Backs off exponentially on RPC errors and 429s.
 */
export class QueueWatcher {
  readonly client: PublicClient;
  readonly contract: Address;
  readonly queueId: number;
  readonly pollMs: number;

  #opts: QueueWatcherOptions;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inflight: Promise<void> | undefined;
  #cursor: bigint | undefined; // last block whose logs were processed
  #snapshot: QueueSnapshot | undefined;
  #backoffMs = 0;
  #listeners = new Set<(u: WatcherUpdate) => void>();
  #served = new Map<bigint, ServedInfo>();
  #gone = new Map<bigint, boolean>(); // ticketId → kicked
  #waiters = new Map<bigint, Set<Waiter>>();
  #snapshotWaiters: Array<(s: QueueSnapshot) => void> = [];

  constructor(opts: QueueWatcherOptions) {
    this.#opts = opts;
    this.client = opts.client;
    this.contract = opts.contract;
    this.queueId = opts.queueId;
    this.pollMs = opts.pollMs ?? 1500;
    if (opts.fromBlock !== undefined) this.#cursor = opts.fromBlock - 1n;
  }

  get snapshot(): QueueSnapshot | undefined {
    return this.#snapshot;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Latest block whose logs have been delivered. */
  get cursor(): bigint | undefined {
    return this.#cursor;
  }

  start(): this {
    if (this.#running) return this;
    this.#running = true;
    void this.#loop();
    return this;
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const set of this.#waiters.values()) for (const w of set) w.resolve(null);
    this.#waiters.clear();
  }

  /** Receive every snapshot and the events decoded since the previous one. Returns an unsubscribe function. */
  subscribe(fn: (u: WatcherUpdate) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Resolves with the next (or current) snapshot. */
  waitForSnapshot(): Promise<QueueSnapshot> {
    if (this.#snapshot) return Promise.resolve(this.#snapshot);
    return new Promise((resolve) => this.#snapshotWaiters.push(resolve));
  }

  /** Poll right now (deduplicated with an in-flight poll). */
  refresh(): Promise<void> {
    if (!this.#inflight) {
      this.#inflight = this.#tick().finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  /**
   * Resolves when `ticketId` is served (from the Served event), or null on timeout.
   * Rejects with TicketGoneError if the ticket leaves or is kicked.
   */
  async waitForServed(ticketId: bigint, timeoutMs: number): Promise<ServedInfo | null> {
    const known = this.#served.get(ticketId);
    if (known) return known;
    if (this.#gone.has(ticketId)) throw new TicketGoneError(ticketId, this.#gone.get(ticketId)!);

    let waiter: Waiter | undefined;
    const done = new Promise<ServedInfo | null>((resolve, reject) => {
      waiter = { resolve, reject };
      let set = this.#waiters.get(ticketId);
      if (!set) this.#waiters.set(ticketId, (set = new Set()));
      set.add(waiter);
    });
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => waiter!.resolve(null), timeoutMs);

    // Safety net for events this watcher cannot see (e.g. served before `fromBlock`):
    // every few polls, look at the ticket struct directly.
    const stop = new AbortController();
    void (async () => {
      while (!stop.signal.aborted && Date.now() < deadline) {
        try {
          await sleep(Math.max(this.pollMs * 5, 5000), stop.signal);
          const info = await this.#checkTicket(ticketId);
          if (info) waiter!.resolve(info);
        } catch (err) {
          if (err instanceof TicketGoneError) waiter!.reject(err);
          if (stop.signal.aborted) return;
        }
      }
    })();
    try {
      return await done;
    } finally {
      stop.abort();
      clearTimeout(timer);
      this.#waiters.get(ticketId)?.delete(waiter!);
      if (this.#waiters.get(ticketId)?.size === 0) this.#waiters.delete(ticketId);
    }
  }

  async #checkTicket(ticketId: bigint): Promise<ServedInfo | null> {
    const seen = this.#served.get(ticketId);
    if (seen) return seen;
    const t = await this.client.readContract({
      address: this.contract,
      abi: x429Abi,
      functionName: "tickets",
      args: [ticketId],
    });
    const [owner, , status, timesPassed, , , , , earned, paid] = t;
    if (status === TicketStatus.Served) {
      return { ticketId, owner, waited: -1, timesPassed: Number(timesPassed), earned, paid };
    }
    if (status === TicketStatus.Left || status === TicketStatus.Kicked) {
      throw new TicketGoneError(ticketId, status === TicketStatus.Kicked);
    }
    return null;
  }

  #loop = async (): Promise<void> => {
    if (!this.#running) return;
    let delay = this.pollMs;
    try {
      await this.refresh();
      this.#backoffMs = 0;
    } catch (err) {
      const max = this.#opts.maxBackoffMs ?? 30_000;
      this.#backoffMs = Math.min(Math.max(this.#backoffMs * 2, this.pollMs * 2), max);
      delay = this.#backoffMs;
      this.#opts.onError?.(err, delay, isRateLimitError(err));
    }
    if (this.#running) this.#timer = setTimeout(this.#loop, delay);
  };

  async #tick(): Promise<void> {
    const client = this.client;
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const tickets = await readQueue(client, this.contract, this.queueId, this.#opts.snapshotLimit ?? 256);

    let events: X429Log[] = [];
    const lag = this.#opts.logLagBlocks ?? 1n;
    const target = head > lag ? head - lag : 0n;
    if (this.#cursor === undefined) {
      this.#cursor = target;
    } else if (target > this.#cursor) {
      const logs = await getLogsChunked(client, {
        address: this.contract,
        fromBlock: this.#cursor + 1n,
        toBlock: target,
        chunk: this.#opts.logChunk ?? 1000n,
      });
      events = logs.filter((l) => !("queueId" in l.args) || Number(l.args.queueId) === this.queueId);
      this.#cursor = target;
    }

    const snapshot: QueueSnapshot = {
      queueId: this.queueId,
      blockNumber: head,
      fetchedAt: Date.now(),
      length: tickets.length,
      tickets,
    };
    this.#snapshot = snapshot;
    for (const ev of events) this.#track(ev);
    for (const resolve of this.#snapshotWaiters.splice(0)) resolve(snapshot);
    for (const fn of this.#listeners) {
      try {
        fn({ snapshot, events });
      } catch {
        // a broken subscriber must not stop the poller
      }
    }
  }

  #track(ev: X429Log): void {
    if (ev.eventName === "Served") {
      const a = ev.args;
      const info: ServedInfo = {
        ticketId: a.ticketId,
        owner: a.owner,
        waited: Number(a.waited),
        timesPassed: Number(a.timesPassed),
        earned: a.earned,
        paid: a.paid,
        txHash: ev.transactionHash,
        blockNumber: ev.blockNumber,
      };
      this.#served.set(a.ticketId, info);
      trim(this.#served, 2000);
      for (const w of this.#waiters.get(a.ticketId) ?? []) w.resolve(info);
    } else if (ev.eventName === "Left") {
      const a = ev.args;
      this.#gone.set(a.ticketId, a.kicked);
      trim(this.#gone, 2000);
      for (const w of this.#waiters.get(a.ticketId) ?? []) w.reject(new TicketGoneError(a.ticketId, a.kicked));
    }
  }
}

function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}
