// The live queue lane: one card per waiting ticket, head ("served next") first.
// Cards are keyed by ticket id and reused, so reorders animate with FLIP (First, Last, Invert, Play):
// measure every card, reorder the DOM, then slide each card from its old spot to the new one.
// An overtaking card also "hops", and every card it passed flashes a floating "+amount USDC" badge.
import { explorerAddress, fmtUsdc } from "../../sdk/src/chain.ts";
import { h, placeChildren, prefersReducedMotion, replayClass, setText } from "./dom.ts";
import { usdcText } from "./format.ts";
import type { Directory } from "./names.ts";
import type { TicketView } from "./rpc.ts";

export type LaneHints = { moved: ReadonlySet<string>; passed: ReadonlyMap<string, bigint> };

type Card = {
  li: HTMLLIElement;
  inner: HTMLDivElement;
  pos: HTMLSpanElement;
  tag: HTMLSpanElement;
  who: HTMLAnchorElement;
  emoji: HTMLSpanElement;
  name: HTMLSpanElement;
  skip: HTMLElement;
  passed: HTMLElement;
  earned: HTMLElement;
};

/**
 * Fallback when no Overtook/Passed logs explain a change: compares the relative order of the
 * tickets present before and after. A ticket that is now ahead of tickets it used to trail moved
 * forward; the tickets it jumped over were passed. Joins at the tail and removals (served / left)
 * do not change the relative order, so they are not mistaken for overtakes.
 */
export function detectReorder(prev: readonly string[], next: readonly string[]): { moved: Set<string>; passed: Set<string> } {
  const inPrev = new Set(prev);
  const inNext = new Set(next);
  const before = prev.filter((id) => inNext.has(id));
  const after = next.filter((id) => inPrev.has(id));
  const rankBefore = new Map(before.map((id, i) => [id, i] as const));
  const rankAfter = new Map(after.map((id, i) => [id, i] as const));
  const moved = new Set<string>();
  const passed = new Set<string>();
  after.forEach((id, i) => {
    if (i < rankBefore.get(id)!) moved.add(id);
  });
  for (const id of moved) {
    const was = rankBefore.get(id)!;
    const now = rankAfter.get(id)!;
    for (const other of before.slice(0, was)) if (rankAfter.get(other)! > now) passed.add(other);
  }
  for (const id of moved) passed.delete(id);
  return { moved, passed };
}

export class Lane {
  private readonly root: HTMLOListElement;
  private readonly dir: Directory;
  private readonly explorer: string;
  private readonly cards = new Map<string, Card>();
  private readonly emptyEl: HTMLLIElement;
  private readonly moreEl: HTMLLIElement;
  private readonly tailEl: HTMLLIElement;
  private readonly messageEl: HTMLLIElement;
  private order: string[] = [];
  private live = false;
  private last: { list: readonly TicketView[]; total: number } | undefined;

  constructor(root: HTMLOListElement, dir: Directory, explorer: string) {
    this.root = root;
    this.dir = dir;
    this.explorer = explorer;
    this.emptyEl = h(
      "li",
      { class: "lane-note" },
      h("strong", null, "The line is empty."),
      h("span", null, "The next bot rush, or you, will fill it."),
    );
    this.moreEl = h("li", { class: "lane-ghost lane-more" });
    this.tailEl = h("li", { class: "lane-ghost lane-tail", "aria-hidden": "true" }, "new tickets join here");
    this.messageEl = h("li", { class: "lane-note" });
  }

  /** Replaces the lane with a calm message (loading, not deployed, queue missing…). */
  message(title: string, detail = ""): void {
    this.cards.clear();
    this.order = [];
    this.live = false;
    this.last = undefined;
    this.messageEl.replaceChildren(h("strong", null, title), detail ? h("span", null, detail) : "");
    this.root.replaceChildren(this.messageEl);
  }

  /** Re-renders the last list without animation (e.g. the connected account changed). */
  refresh(): void {
    if (this.last) this.render(this.last.list, this.last.total, undefined, false);
  }

  /**
   * @param list  waiting tickets in serving order (index 0 is served next)
   * @param total queue length (the list may be truncated)
   * @param hints overtakes seen in fresh logs; when absent, reorders are detected by diffing
   */
  render(list: readonly TicketView[], total: number, hints?: LaneHints, animate = true): void {
    const motion = animate && this.live && !prefersReducedMotion();
    const ids = list.map((t) => t.id.toString());

    // First: where every card is now.
    const first = new Map<string, DOMRect>();
    if (motion) for (const [id, card] of this.cards) first.set(id, card.li.getBoundingClientRect());

    // Who moved forward, and who got paid for it.
    let moved: ReadonlySet<string> = hints?.moved ?? new Set<string>();
    const passed = new Map<string, bigint>(hints?.passed ?? []);
    if (motion && moved.size === 0) {
      const diff = detectReorder(this.order, ids);
      moved = diff.moved;
      for (const id of diff.passed) {
        const t = list.find((x) => x.id.toString() === id);
        if (t) passed.set(id, t.skipPrice); // a pass pays the ticket's own skip price
      }
    }

    // Update / create cards, then put them in order.
    const wanted: HTMLLIElement[] = [];
    const entering: HTMLLIElement[] = [];
    const keep = new Set(ids);
    list.forEach((ticket, i) => {
      const id = ids[i]!;
      let card = this.cards.get(id);
      if (!card) {
        card = this.createCard(id);
        this.cards.set(id, card);
        if (motion) entering.push(card.li);
      }
      this.fill(card, ticket, i);
      wanted.push(card.li);
    });
    for (const id of [...this.cards.keys()]) if (!keep.has(id)) this.cards.delete(id);
    if (list.length === 0) {
      wanted.push(this.emptyEl);
    } else {
      if (total > list.length) {
        setText(this.moreEl, `+${total - list.length} more waiting`);
        wanted.push(this.moreEl);
      }
      wanted.push(this.tailEl);
    }
    placeChildren(this.root, wanted);

    if (motion) {
      // Last + Invert: put each moved card back where it was, without transition…
      const sliding: HTMLElement[] = [];
      for (const [id, rect] of first) {
        const card = this.cards.get(id);
        if (!card) continue;
        const now = card.li.getBoundingClientRect();
        const dx = rect.left - now.left;
        const dy = rect.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.li.style.transition = "none";
        card.li.style.transform = `translate(${dx}px, ${dy}px)`;
        sliding.push(card.li);
      }
      // …Play: then let the CSS transition carry it to its new place.
      if (sliding.length > 0) {
        void this.root.offsetWidth;
        for (const el of sliding) {
          el.style.transition = "";
          el.style.transform = "";
        }
      }
      for (const li of entering) replayClass(li, "enter");
      for (const id of moved) {
        const card = this.cards.get(id);
        if (card) replayClass(card.inner, "hop");
      }
      for (const [id, amount] of passed) {
        const card = this.cards.get(id);
        if (!card) continue;
        replayClass(card.inner, "flash");
        this.badge(card, amount);
      }
    }

    this.order = ids;
    this.live = true;
    this.last = { list, total };
  }

  private badge(card: Card, amount: bigint): void {
    const badge = h("span", { class: "pass-badge", "aria-hidden": "true" }, `+${fmtUsdc(amount)} USDC`);
    card.li.append(badge);
    setTimeout(() => badge.remove(), 2_400);
  }

  private createCard(id: string): Card {
    const pos = h("span", { class: "card-pos" });
    const tag = h("span", { class: "card-tag" });
    const emoji = h("span", { class: "card-emoji", "aria-hidden": "true" });
    const name = h("span", { class: "card-name" });
    const who = h("a", { class: "card-who", target: "_blank", rel: "noopener noreferrer" }, emoji, name);
    const skip = h("dd");
    const passed = h("dd");
    const earned = h("dd");
    const inner = h(
      "div",
      { class: "card-inner" },
      h("div", { class: "card-top" }, pos, tag),
      who,
      h(
        "dl",
        { class: "card-facts" },
        h("div", null, h("dt", null, "skip price"), skip),
        h("div", null, h("dt", null, "times passed"), passed),
        h("div", null, h("dt", null, "earned"), earned),
      ),
    );
    const li = h("li", { class: "card", "data-ticket": id }, inner);
    return { li, inner, pos, tag, who, emoji, name, skip, passed, earned };
  }

  private fill(card: Card, t: TicketView, index: number): void {
    const who = this.dir.who(t.owner);
    card.li.classList.toggle("is-head", index === 0);
    card.li.classList.toggle("is-mine", who.kind === "you");
    card.li.classList.toggle("is-bot", who.kind === "bot");
    setText(card.pos, `#${index + 1}`);
    setText(card.tag, index === 0 ? "served next" : `ticket ${t.id}`);
    setText(card.emoji, who.emoji);
    setText(card.name, who.label);
    const href = explorerAddress(t.owner, this.explorer);
    if (card.who.getAttribute("href") !== href) card.who.setAttribute("href", href);
    card.who.title = `${t.owner} · ticket #${t.id}`;
    setText(card.skip, usdcText(t.skipPrice));
    setText(card.passed, `${t.timesPassed}×`);
    setText(card.earned, usdcText(t.earned));
  }
}
