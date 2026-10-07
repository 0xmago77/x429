// Tiny DOM helpers. Text always goes through text nodes (never innerHTML), so chain data cannot inject markup.

export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Child = Node | string | number | bigint | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = String(value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Link that opens in a new tab without giving the target page a handle on this one. */
export function extLink(href: string, text: Child, cls?: string): HTMLAnchorElement {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls }, text);
}

export function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: cls }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** Sets textContent only when it changes (avoids needless layout work in the poll loop). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el as T;
}

/**
 * Puts `wanted` as the exact children of `root`, moving only nodes that are out of place
 * (moving a node restarts its CSS animations, so untouched nodes keep animating).
 */
export function placeChildren(root: Element, wanted: readonly Element[]): void {
  const kids = root.children;
  for (let i = 0; i < wanted.length; i++) {
    const el = wanted[i]!;
    if (kids[i] !== el) root.insertBefore(el, kids[i] ?? null);
  }
  while (root.children.length > wanted.length) root.lastElementChild?.remove();
}

/** Restarts a one-shot CSS animation class on `el`. */
export function replayClass(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth; // force a reflow so the animation starts again
  el.classList.add(cls);
  const done = (ev: AnimationEvent): void => {
    if (ev.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** localStorage that never throws (private mode, disabled storage, quota). */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
