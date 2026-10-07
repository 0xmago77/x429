// Formatting and time helpers (no DOM).
import { fmtUsdc, usdc } from "../../sdk/src/chain.ts";

export const MAX_UINT128 = (1n << 128n) - 1n;

/** `2000000000000000n` → "0.002 USDC" (native USDC, 18 decimals). */
export function usdcText(wei: bigint, maxDecimals = 6): string {
  return `${fmtUsdc(wei, maxDecimals)} USDC`;
}

export function fmtInt(n: number | bigint): string {
  return typeof n === "bigint" ? n.toLocaleString("en-US") : Math.round(n).toLocaleString("en-US");
}

/** Seconds → "45s", "2m 13s", "1h 05m", "2d 3h". */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Milliseconds in the past → "just now", "12s ago", "3 min ago", "2 h ago". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Countdown: "07:09" below one hour, "01:07:09" above. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return hours > 0 ? `${pad(hours)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Next wall-clock multiple of `everyMin` minutes since the Unix epoch. */
export function nextRush(nowMs: number, everyMin: number): number {
  const period = Math.max(1, everyMin) * 60_000;
  return Math.ceil(nowMs / period) * period;
}

export function fmtEvery(everyMin: number): string {
  if (everyMin >= 60 && everyMin % 60 === 0) return `${everyMin / 60} h`;
  return `${everyMin} min`;
}

/** Parses a user-typed USDC amount ("0.002", "1,5") into wei; undefined when invalid. */
export function parseUsdcInput(text: string): bigint | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "" || t === "." || !/^\d{0,15}(\.\d{0,18})?$/.test(t)) return undefined;
  const wei = usdc(t.startsWith(".") ? `0${t}` : t);
  return wei <= MAX_UINT128 ? wei : undefined;
}

/**
 * Estimates how long ago a block was produced, from the head block number and the moment it was
 * first seen. Starts at Arc's measured ~0.508 s/block and recalibrates from what it observes.
 */
export class BlockClock {
  blockMs = 508;
  private head = -1n;
  private seenAt = 0;
  private anchor: { block: bigint; at: number } | undefined;

  observe(head: bigint, now = Date.now()): void {
    if (head <= this.head) return;
    this.head = head;
    this.seenAt = now;
    if (!this.anchor) {
      this.anchor = { block: head, at: now };
      return;
    }
    const blocks = Number(head - this.anchor.block);
    const elapsed = now - this.anchor.at;
    if (elapsed >= 60_000 && blocks > 0) this.blockMs = Math.min(10_000, Math.max(100, elapsed / blocks));
  }

  get headBlock(): bigint {
    return this.head;
  }

  ageMs(block: bigint, now = Date.now()): number {
    if (this.head < 0n) return 0;
    return Math.max(0, Number(this.head - block) * this.blockMs + (now - this.seenAt));
  }
}
