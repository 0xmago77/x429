import { usdc } from "../sdk/src/chain.ts";

export type BotSpec = {
  name: string;
  emoji: string;
  /** Base value of time, in USDC per second of waiting. */
  valuePerSecond: string;
};

/** The demo swarm: from latency-critical to "whenever". Order matches bot1.key … bot8.key. */
export const BOTS: readonly BotSpec[] = [
  { name: "quant-desk", emoji: "⚡", valuePerSecond: "0.003" },
  { name: "price-watcher", emoji: "📈", valuePerSecond: "0.001" },
  { name: "support-agent", emoji: "💬", valuePerSecond: "0.0004" },
  { name: "news-digest", emoji: "📰", valuePerSecond: "0.00015" },
  { name: "data-labeler", emoji: "🏷️", valuePerSecond: "0.00006" },
  { name: "research-crawler", emoji: "🔎", valuePerSecond: "0.00003" },
  { name: "batch-embedder", emoji: "🧮", valuePerSecond: "0.00002" },
  { name: "nightly-backup", emoji: "🌙", valuePerSecond: "0.00001" },
];

/** Standard normal sample (Box–Muller). */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), Number.EPSILON);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lognormal noise factor exp(σ·Z), clamped to [0.5, 2]. */
export function noiseFactor(rand: () => number = Math.random, sigma = 0.5): number {
  const f = Math.exp(sigma * gaussian(rand));
  return Math.min(2, Math.max(0.5, f));
}

/** This arrival's value of time in native USDC wei per second: base × noise. */
export function arrivalValuePerSecond(bot: BotSpec, rand: () => number = Math.random): { valuePerSecond: bigint; factor: number } {
  const factor = noiseFactor(rand);
  const scaled = (usdc(bot.valuePerSecond) * BigInt(Math.round(factor * 1_000_000))) / 1_000_000n;
  return { valuePerSecond: scaled, factor };
}
