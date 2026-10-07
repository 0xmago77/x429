// Address → display name: bots.json entries, "you" for the connected wallet, else a short address.
import type { Bot, BotRole } from "./config.ts";

export type WhoKind = BotRole | "you" | "address";
export type Who = { label: string; emoji: string; kind: WhoKind; address: string };

const FALLBACK_EMOJI: Record<WhoKind, string> = {
  bot: "🤖",
  operator: "🛎️",
  treasury: "🏦",
  you: "🙋",
  address: "👤",
};

/** 0x1234…abcd */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export class Directory {
  private readonly bots = new Map<string, Bot>();
  private account: string | undefined;

  constructor(bots: readonly Bot[]) {
    for (const bot of bots) this.bots.set(bot.address.toLowerCase(), bot);
  }

  setAccount(address: string | undefined): void {
    this.account = address?.toLowerCase();
  }

  isMine(address: string): boolean {
    return this.account !== undefined && address.toLowerCase() === this.account;
  }

  who(address: string): Who {
    if (this.isMine(address)) return { label: "you", emoji: FALLBACK_EMOJI.you, kind: "you", address };
    const bot = this.bots.get(address.toLowerCase());
    if (bot) return { label: bot.name, emoji: bot.emoji || FALLBACK_EMOJI[bot.role], kind: bot.role, address };
    return { label: shortAddress(address), emoji: FALLBACK_EMOJI.address, kind: "address", address };
  }
}
