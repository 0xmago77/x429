// x429 dashboard entry point.
//
// Data flow: ONE poll loop (every 2 s, slower when the tab is hidden, exponential backoff on RPC
// errors) reads the head block, fetches new logs since the last block it saw, re-reads the queue
// only when those logs touched it (or every 15 s as a safety net), and lets the wallet panel do its
// few reads when something involving the visitor changed. On load, a one-off backward scan fills
// the feed with recent history.
import type { Address } from "viem";
import { getBlockNumber } from "viem/actions";
import { explorerAddress, fmtUsdc } from "../../sdk/src/chain.ts";
import { DEFAULT_REPO_URL, DEFAULT_RUSH_EVERY_MIN, isDeployed, loadBots, loadConfig, type Config } from "./config.ts";
import { byId, extLink, h, setText } from "./dom.ts";
import { digest, isCountable, logKey } from "./events.ts";
import { Feed } from "./feed.ts";
import { BlockClock, fmtClock, fmtEvery, fmtInt, nextRush } from "./format.ts";
import { Lane } from "./lane.ts";
import { Directory, shortAddress } from "./names.ts";
import {
  Backoff,
  LogFetcher,
  describeError,
  isNoContract,
  makeReadClient,
  readQueueInfo,
  readQueueList,
  revertName,
  scanBackwards,
  withRetry,
  type QueueInfo,
  type ReadClient,
  type TicketView,
  type X429Log,
} from "./rpc.ts";
import { WalletDiscovery } from "./wallet.ts";
import { YouPanel } from "./you.ts";

const POLL_MS = 2_000;
const HIDDEN_POLL_MS = 10_000;
const QUEUE_REFRESH_MS = 15_000;
/** About 4 hours of Arc blocks at ~0.5 s per block. */
const HISTORY_BLOCKS = 28_800n;
const HISTORY_EVENTS = 40;
const HISTORY_BUDGET_MS = 30_000;
/** Blocks fetched per poll when catching up (4 chunks of 1000). */
const LIVE_MAX_SPAN = 4_000n;
const LANE_LIMIT = 64;
const RUSH_LIVE_MS = 90_000;

// ------------------------------------------------------------------ page chrome

type BannerKind = "info" | "warn" | "error";

function banner(kind: BannerKind | null, text = ""): void {
  const el = byId("banner");
  el.hidden = kind === null;
  el.className = `banner banner-${kind ?? "info"}`;
  setText(el, text);
}

function setFooter(repoUrl: string): void {
  byId<HTMLAnchorElement>("repo-link").href = repoUrl;
  byId<HTMLAnchorElement>("spec-link").href = `${repoUrl}/blob/main/SPEC.md`;
}

let rushEveryMin = DEFAULT_RUSH_EVERY_MIN;
const tickers: (() => void)[] = [];

function updateRush(): void {
  const now = Date.now();
  const next = nextRush(now, rushEveryMin);
  const period = rushEveryMin * 60_000;
  const sinceLast = now - (next - period);
  setText(byId("rush-clock"), fmtClock(next - now));
  const at = new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  setText(
    byId("rush-at"),
    sinceLast < RUSH_LIVE_MS ? `A rush just started: watch the lane. Next one at ${at}.` : `Next rush at ${at} (your time).`,
  );
  setText(byId("rush-every"), fmtEvery(rushEveryMin));
}

/** One 1-second UI timer for the countdown and relative times (no RPC in here). */
function startUiTimer(): void {
  let n = 0;
  updateRush();
  setInterval(() => {
    updateRush();
    if (++n % 5 === 0) for (const fn of tickers) fn();
  }, 1_000);
}

// ------------------------------------------------------------------ live view

type Hints = { moved: Set<string>; passed: Map<string, bigint> };
type Problem = "none" | "no-queue" | "no-contract";

class LiveView {
  private readonly cfg: Config;
  private readonly client: ReadClient;
  private readonly dir: Directory;
  private readonly lane: Lane;
  private readonly feed: Feed;
  private readonly clock: BlockClock;
  private readonly backoff: Backoff;
  private readonly fetcher: LogFetcher;
  private you: YouPanel | undefined;

  private lastBlock = -1n;
  private queueDirty = true;
  private lastQueueRead = 0;
  private hints: Hints = { moved: new Set(), passed: new Map() };
  private readonly seen = new Set<string>();
  private readonly joins = new Map<string, Address>();
  private problem: Problem = "none";
  private operator: Address | undefined;
  private wakeFn: (() => void) | undefined;

  constructor(cfg: Config, client: ReadClient, dir: Directory, lane: Lane, feed: Feed, clock: BlockClock) {
    this.cfg = cfg;
    this.client = client;
    this.dir = dir;
    this.lane = lane;
    this.feed = feed;
    this.clock = clock;
    const pill = byId("rpc-pill");
    this.backoff = new Backoff((health, detail) => {
      pill.hidden = health === "ok";
      setText(pill, health === "busy" ? "RPC busy, retrying" : "RPC error, retrying");
      pill.title = detail;
    });
    this.fetcher = new LogFetcher(client, cfg.contract);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.wake();
    });
  }

  attachYou(you: YouPanel): void {
    this.you = you;
  }

  /** Wakes the poll loop early (not while backing off from RPC errors). */
  wake(): void {
    this.wakeFn?.();
  }

  queueChanged(): void {
    this.queueDirty = true;
    this.wake();
  }

  joinsOf(account: Address): bigint[] {
    const mine: bigint[] = [];
    const lower = account.toLowerCase();
    for (const [id, owner] of this.joins) if (owner.toLowerCase() === lower) mine.push(BigInt(id));
    return mine;
  }

  async start(): Promise<void> {
    this.lane.message("Loading the queue…");
    const head = await withRetry(() => getBlockNumber(this.client, { cacheTime: 0 }), this.backoff);
    this.observeHead(head);
    try {
      await withRetry(() => this.readQueue(), this.backoff);
    } catch (err) {
      console.warn("x429: first queue read failed", err);
    }

    // History: walk back from the head until 40 events, ~4 h, or the deploy block.
    const windowFloor = head > HISTORY_BLOCKS ? head - HISTORY_BLOCKS : 0n;
    const floor = this.cfg.deployBlock > windowFloor ? this.cfg.deployBlock : windowFloor;
    try {
      const scan = await scanBackwards({
        fetcher: this.fetcher,
        backoff: this.backoff,
        head,
        floor,
        maxEvents: HISTORY_EVENTS,
        countable: (log) => isCountable(log, this.cfg.queueId),
        concurrency: 2,
        budgetMs: HISTORY_BUDGET_MS,
      });
      this.handleLogs(scan.logs, false);
      this.feed.setEmptyText(
        floor === this.cfg.deployBlock && floor > 0n
          ? "No activity since the contract was deployed. The next bot rush will show up here."
          : "No activity in the last 4 hours. The next bot rush will show up here.",
      );
      this.feed.setNote(scan.complete ? "newest first" : "newest first · older history skipped (RPC busy)");
    } catch (err) {
      console.warn("x429: history scan failed", err);
      this.feed.setEmptyText("Could not load recent history. New events will show up here.");
      this.feed.setNote(`history unavailable: ${describeError(err)}`);
    }
    this.lastBlock = head;
    void this.loop();
  }

  private async loop(): Promise<void> {
    for (;;) {
      let wait = POLL_MS;
      try {
        await this.tick();
        this.backoff.ok();
      } catch (err) {
        wait = this.backoff.fail(err);
        console.warn("x429: poll failed", err);
      }
      if (document.hidden) wait = Math.max(wait, HIDDEN_POLL_MS);
      await this.nap(wait, this.backoff.delayMs === 0);
    }
  }

  private nap(ms: number, wakeable: boolean): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wakeFn === done) this.wakeFn = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (wakeable) this.wakeFn = done;
    });
  }

  private async tick(): Promise<void> {
    const head = await getBlockNumber(this.client, { cacheTime: 0 });
    this.observeHead(head);
    if (head > this.lastBlock) {
      let from = this.lastBlock + 1n;
      if (head - from >= HISTORY_BLOCKS) {
        // The tab slept for hours: skip the gap rather than replaying it.
        from = head - HISTORY_BLOCKS + 1n;
        this.feed.setNote("newest first · skipped a gap while the tab was asleep");
      }
      const to = head - from + 1n > LIVE_MAX_SPAN ? from + LIVE_MAX_SPAN - 1n : head;
      const logs = await this.fetcher.fetch(from, to);
      this.lastBlock = to;
      this.handleLogs(logs, true);
    }
    const now = Date.now();
    if (this.queueDirty || now - this.lastQueueRead > QUEUE_REFRESH_MS) await this.readQueue();
    if (this.you?.needsRefresh(now)) await this.you.refresh();
  }

  private observeHead(head: bigint): void {
    this.clock.observe(head);
    setText(byId("net-pill"), `${this.cfg.chainName} · block ${fmtInt(head)}`);
  }

  private handleLogs(logs: readonly X429Log[], live: boolean): void {
    const fresh: X429Log[] = [];
    for (const log of logs) {
      const key = logKey(log);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push(log);
    }
    if (this.seen.size > 20_000) {
      let drop = this.seen.size - 10_000;
      for (const key of this.seen) {
        if (drop-- <= 0) break;
        this.seen.delete(key);
      }
    }
    if (fresh.length === 0) return;

    const d = digest(fresh, this.cfg.queueId);
    for (const join of d.joins) this.joins.set(join.ticketId.toString(), join.owner);
    this.feed.add(d.items, live);
    if (live) {
      for (const id of d.moved) this.hints.moved.add(id);
      for (const [id, amount] of d.passed) this.hints.passed.set(id, (this.hints.passed.get(id) ?? 0n) + amount);
    }
    if (d.queueTouched) this.queueDirty = true;
    this.you?.noteDigest(d);
  }

  private async readQueue(): Promise<void> {
    let info: QueueInfo;
    let list: readonly TicketView[];
    try {
      [info, list] = await Promise.all([
        readQueueInfo(this.client, this.cfg.contract, this.cfg.queueId),
        readQueueList(this.client, this.cfg.contract, this.cfg.queueId, LANE_LIMIT),
      ]);
    } catch (err) {
      const problem: Problem | undefined =
        revertName(err) === "UnknownQueue" ? "no-queue" : isNoContract(err) ? "no-contract" : undefined;
      if (!problem) throw err;
      this.setProblem(problem);
      this.queueDirty = false;
      this.lastQueueRead = Date.now();
      return;
    }
    this.setProblem("none");
    this.queueDirty = false;
    this.lastQueueRead = Date.now();

    const hints = this.hints;
    this.hints = { moved: new Set(), passed: new Map() };
    const hasHints = hints.moved.size > 0 || hints.passed.size > 0;
    this.lane.render(list, info.length, hasHints ? hints : undefined);
    this.renderStats(info);
    this.setLaneMeta(info);
    this.you?.setQueue(list, info.length);
  }

  private setProblem(problem: Problem): void {
    if (problem === this.problem) return;
    this.problem = problem;
    if (problem === "none") {
      banner(null);
    } else if (problem === "no-queue") {
      banner("info", `Queue #${this.cfg.queueId} is not open on this contract yet. This page picks it up as soon as it is.`);
      this.lane.message("Queue not open yet", "The operator has not created this queue yet.");
    } else {
      banner(
        "error",
        `No x429 contract found at ${this.cfg.contract} on chain ${this.cfg.chainId}. The site configuration may be out of date.`,
      );
      this.lane.message("No contract at the configured address");
    }
  }

  private setLaneMeta(info: QueueInfo): void {
    const meta = info.meta.trim();
    const parts = [`queue #${this.cfg.queueId}`];
    if (meta) parts.push(meta.length > 60 ? `${meta.slice(0, 57)}…` : meta);
    parts.push(`${fmtInt(info.length)} waiting`);
    parts.push(`the operator serves from the head about every ${Math.round(this.cfg.serviceIntervalMs / 1000)} s`);
    setText(byId("lane-meta"), parts.join(" · "));
  }

  private renderStats(info: QueueInfo): void {
    setText(byId("stat-paid"), fmtUsdc(info.totalCompensation));
    setText(byId("stat-overtakes"), fmtInt(info.overtakes));
    setText(byId("stat-served"), fmtInt(info.served));
    setText(byId("stat-joined"), fmtInt(info.joined));
    setText(byId("stat-length"), fmtInt(info.length));
    setText(byId("stat-length-sub"), `of ${fmtInt(info.maxLength)} max`);
    if (info.operator !== this.operator) {
      this.operator = info.operator;
      renderLinks(this.cfg, this.dir, info.operator);
    }
  }
}

function renderLinks(cfg: Config, dir: Directory, operator?: Address): void {
  const links: Node[] = [];
  if (isDeployed(cfg)) {
    links.push(
      h(
        "span",
        null,
        "Contract ",
        extLink(explorerAddress(cfg.contract, cfg.explorer), `${shortAddress(cfg.contract)} ↗`, "mono"),
      ),
    );
    if (operator) {
      const who = dir.who(operator);
      const label = who.kind === "address" ? shortAddress(operator) : `${who.emoji} ${who.label}`;
      links.push(h("span", null, "Operator ", extLink(explorerAddress(operator, cfg.explorer), `${label} ↗`)));
    }
    links.push(h("span", null, `Queue #${cfg.queueId} on ${cfg.chainName}`));
  } else {
    links.push(h("span", null, "Contract: not deployed yet"));
  }
  byId("stat-links").replaceChildren(...links);
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  startUiTimer();
  setFooter(DEFAULT_REPO_URL);

  const lane = byId<HTMLOListElement>("lane");
  const feedRoot = byId<HTMLOListElement>("feed");

  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    banner("error", `Could not load the site configuration (config.json): ${describeError(err)}. Reload to try again.`);
    lane.replaceChildren(h("li", { class: "lane-note" }, h("strong", null, "Live view unavailable")));
    feedRoot.replaceChildren(h("li", { class: "feed-empty" }, "Live view unavailable."));
    byId("you").replaceChildren(h("p", { class: "muted" }, "Unavailable without a site configuration."));
    setText(byId("net-pill"), "offline");
    return;
  }

  setFooter(config.repoUrl);
  rushEveryMin = config.rushEveryMin;
  updateRush();
  setText(byId("net-pill"), `${config.chainName} · chain ${config.chainId}`);

  const bots = await loadBots();
  const dir = new Directory(bots);
  const clock = new BlockClock();
  const laneView = new Lane(lane, dir, config.explorer);
  const feed = new Feed(feedRoot, byId("feed-note"), dir, config.explorer, clock);
  tickers.push(() => feed.tick());
  const client = makeReadClient(config.chainId, config.rpcUrls);
  const discovery = new WalletDiscovery();
  discovery.start();
  renderLinks(config, dir);

  const deployed = isDeployed(config);
  let live: LiveView | undefined;
  if (deployed) live = new LiveView(config, client, dir, laneView, feed, clock);

  const you = new YouPanel(byId("you"), {
    config,
    deployed,
    client,
    dir,
    discovery,
    joinsOf: (account) => live?.joinsOf(account) ?? [],
    onAccountChange: () => {
      laneView.refresh();
      feed.rebuild();
    },
    wake: () => live?.wake(),
    queueChanged: () => live?.queueChanged(),
  });

  if (!live) {
    // Calm pre-deployment state: no RPC traffic at all.
    banner("info", "The x429 contract is not deployed yet. The live queue, feed and stats appear here as soon as it is.");
    laneView.message("Not deployed yet", "The queue goes live once the contract is deployed on Arc.");
    feed.setEmptyText("The feed starts once the contract is deployed.");
    return;
  }
  live.attachYou(you);
  await live.start();
}

boot().catch((err: unknown) => {
  console.error("x429: dashboard failed to start", err);
  try {
    banner("error", `The dashboard failed to start: ${describeError(err)}`);
  } catch {
    /* index.html is missing the banner; nothing else to do */
  }
});
