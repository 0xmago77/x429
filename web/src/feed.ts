// The live feed: newest first, every entry links to its transaction on the explorer.
import { explorerTx, fmtUsdc } from "../../sdk/src/chain.ts";
import { extLink, h, placeChildren, setText, type Child } from "./dom.ts";
import { compareItemsNewestFirst, type FeedItem, type PassedEntry } from "./events.ts";
import { fmtAgo, fmtDuration, usdcText, type BlockClock } from "./format.ts";
import type { Directory } from "./names.ts";

const MAX_ITEMS = 80;
const MAX_PASSED_NAMES = 4;

type Row = { li: HTMLLIElement; time: HTMLElement; block: bigint };

export class Feed {
  private readonly root: HTMLOListElement;
  private readonly note: HTMLElement;
  private readonly dir: Directory;
  private readonly explorer: string;
  private readonly clock: BlockClock;
  private items: FeedItem[] = [];
  private readonly keys = new Set<string>();
  private readonly rows = new Map<string, Row>();
  private readonly emptyEl: HTMLLIElement;

  constructor(root: HTMLOListElement, note: HTMLElement, dir: Directory, explorer: string, clock: BlockClock) {
    this.root = root;
    this.note = note;
    this.dir = dir;
    this.explorer = explorer;
    this.clock = clock;
    this.emptyEl = h("li", { class: "feed-empty" }, "Loading recent activity…");
    this.root.replaceChildren(this.emptyEl);
  }

  /** Text shown while there is nothing in the feed. */
  setEmptyText(text: string): void {
    setText(this.emptyEl, text);
  }

  setNote(text: string): void {
    setText(this.note, text);
  }

  get size(): number {
    return this.items.length;
  }

  /** Merges items (deduplicated by tx + log index); `fresh` ones get a short highlight. */
  add(items: readonly FeedItem[], fresh: boolean): void {
    const added = new Set<string>();
    for (const item of items) {
      if (this.keys.has(item.key)) continue;
      this.keys.add(item.key);
      this.items.push(item);
      added.add(item.key);
    }
    if (added.size === 0) return;
    this.items.sort(compareItemsNewestFirst);
    for (const dropped of this.items.splice(MAX_ITEMS)) this.rows.delete(dropped.key);
    this.sync(fresh ? added : new Set());
  }

  /** Rebuilds every row (names changed because a wallet connected or disconnected). */
  rebuild(): void {
    this.rows.clear();
    this.sync(new Set());
  }

  /** Refreshes the "≈ 3 min ago" labels. */
  tick(): void {
    const now = Date.now();
    for (const row of this.rows.values()) setText(row.time, this.ago(row.block, now));
  }

  private sync(fresh: ReadonlySet<string>): void {
    const wanted: HTMLLIElement[] = [];
    for (const item of this.items) {
      let row = this.rows.get(item.key);
      if (!row) {
        row = this.build(item);
        this.rows.set(item.key, row);
        if (fresh.has(item.key)) row.li.classList.add("fresh");
      }
      wanted.push(row.li);
    }
    placeChildren(this.root, wanted.length > 0 ? wanted : [this.emptyEl]);
  }

  private ago(block: bigint, now = Date.now()): string {
    const label = fmtAgo(this.clock.ageMs(block, now));
    return label === "just now" ? label : `≈ ${label}`;
  }

  private actor(address: string): HTMLSpanElement {
    const who = this.dir.who(address);
    return h(
      "span",
      { class: who.kind === "you" ? "actor actor-you" : "actor", title: address },
      h("span", { class: "actor-emoji", "aria-hidden": "true" }, who.emoji),
      h("b", null, who.label),
    );
  }

  private passedList(passed: readonly PassedEntry[]): Child[] {
    const parts: Child[] = ["passed "];
    passed.slice(0, MAX_PASSED_NAMES).forEach((p, i) => {
      if (i > 0) parts.push(", ");
      parts.push(this.actor(p.owner), h("span", { class: "plus" }, ` +${fmtUsdc(p.amount)}`));
    });
    if (passed.length > MAX_PASSED_NAMES) parts.push(` and ${passed.length - MAX_PASSED_NAMES} more`);
    return parts;
  }

  private build(item: FeedItem): Row {
    let kind: string;
    let label: string;
    let main: Child[];
    let sub: Child[] = [];
    switch (item.kind) {
      case "joined":
        kind = "joined";
        label = "join";
        main = [this.actor(item.owner), ` joined at #${item.position} with skip price ${usdcText(item.skipPrice)}`];
        break;
      case "overtook": {
        kind = "overtook";
        label = "cut";
        const places = item.positions === 1 ? "1 place" : `${item.positions} places`;
        main = [this.actor(item.owner), ` cut ahead ${places}, paying ${usdcText(item.paid)} to the agents passed`];
        if (item.passed.length > 0) sub = this.passedList(item.passed);
        break;
      }
      case "served": {
        kind = "served";
        label = "served";
        const passes = item.timesPassed === 1 ? "1 pass" : `${item.timesPassed} passes`;
        main = [this.actor(item.owner), ` was served after ${fmtDuration(item.waited)}`];
        sub = [item.earned > 0n ? `earned ${usdcText(item.earned)} from ${passes}` : "never passed, earned nothing"];
        if (item.paid > 0n) sub.push(` · paid ${usdcText(item.paid)} to cut`);
        break;
      }
      case "left":
        kind = item.kicked ? "kicked" : "left";
        label = item.kicked ? "kicked" : "left";
        main = item.kicked
          ? [this.actor(item.owner), " was removed by the operator"]
          : [this.actor(item.owner), " left the queue"];
        break;
      case "withdrawn":
        kind = "withdrawn";
        label = "payout";
        main = [this.actor(item.owner), ` withdrew ${usdcText(item.amount)} of compensation`];
        if (item.caller.toLowerCase() !== item.owner.toLowerCase()) sub = ["pushed by ", this.actor(item.caller)];
        break;
    }
    const time = h("span", { class: "feed-time", title: `block ${item.block}` }, this.ago(item.block));
    const li = h(
      "li",
      { class: `feed-item kind-${kind}` },
      h("span", { class: "feed-kind" }, label),
      h(
        "div",
        { class: "feed-body" },
        h("p", { class: "feed-main" }, ...main),
        sub.length > 0 ? h("p", { class: "feed-sub" }, ...sub) : null,
        h(
          "p",
          { class: "feed-meta" },
          time,
          " · ",
          extLink(explorerTx(item.tx, this.explorer), "tx ↗", "feed-tx"),
        ),
      ),
    );
    return { li, time, block: item.block };
  }
}
