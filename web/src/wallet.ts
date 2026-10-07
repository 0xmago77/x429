// Injected wallets: EIP-6963 discovery with a window.ethereum fallback, connection, chain switching,
// a viem wallet client for sending, and human-readable error messages.
import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  createClient,
  custom,
  decodeErrorResult,
  getAddress,
  isAddress,
  isHex,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { NATIVE_USDC, chainFor, isRateLimitError } from "../../sdk/src/chain.ts";
import { x429Abi } from "../../sdk/src/abi.ts";
import type { Config } from "./config.ts";

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type InjectedWallet = { info: WalletInfo; provider: Eip1193Provider };

function isProvider(value: unknown): value is Eip1193Provider {
  return !!value && typeof value === "object" && typeof (value as { request?: unknown }).request === "function";
}

function text(value: unknown, fallback: string, max = 60): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

/** Only inline raster/SVG data URIs (EIP-6963 requires data URIs; an <img> never runs SVG scripts). */
function safeIcon(icon: unknown): string {
  return typeof icon === "string" && icon.length < 200_000 && /^data:image\/(svg\+xml|png|jpeg|jpg|webp|gif)[;,]/i.test(icon)
    ? icon
    : "";
}

function legacyName(provider: unknown): string {
  const p = provider as Record<string, unknown>;
  if (p.isRabby) return "Rabby";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

export class WalletDiscovery {
  private readonly found = new Map<string, InjectedWallet>();
  private readonly listeners: (() => void)[] = [];

  start(): void {
    window.addEventListener("eip6963:announceProvider", (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail as { info?: Record<string, unknown>; provider?: unknown } | null;
      if (!detail || !isProvider(detail.provider) || !detail.info || typeof detail.info.uuid !== "string") return;
      const info: WalletInfo = {
        uuid: detail.info.uuid,
        name: text(detail.info.name, "Wallet", 40),
        icon: safeIcon(detail.info.icon),
        rdns: text(detail.info.rdns, detail.info.uuid, 100),
      };
      this.found.set(info.rdns, { info, provider: detail.provider });
      for (const listener of this.listeners) listener();
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** EIP-6963 wallets; if none announced, the legacy window.ethereum (if any). */
  list(): InjectedWallet[] {
    const wallets = [...this.found.values()];
    if (wallets.length > 0) return wallets;
    const legacy = (window as unknown as { ethereum?: unknown }).ethereum;
    if (isProvider(legacy)) {
      return [{ info: { uuid: "injected", name: legacyName(legacy), icon: "", rdns: "injected" }, provider: legacy }];
    }
    return [];
  }
}

export function parseChainId(value: unknown): number {
  if (typeof value === "string") return value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.NaN;
}

export function firstAccount(value: unknown): Address | undefined {
  if (!Array.isArray(value)) return undefined;
  const found = value.find((a): a is string => typeof a === "string" && isAddress(a, { strict: false }));
  return found ? getAddress(found) : undefined;
}

export class WalletSession {
  readonly wallet: InjectedWallet;
  account: Address;
  chainId: number;
  private readonly handlers: [string, (...args: unknown[]) => void][] = [];

  constructor(wallet: InjectedWallet, account: Address, chainId: number) {
    this.wallet = wallet;
    this.account = account;
    this.chainId = chainId;
  }

  /** `silent` uses eth_accounts (no prompt) and resolves undefined when the site is not authorised. */
  static async connect(wallet: InjectedWallet, silent = false): Promise<WalletSession | undefined> {
    const accounts = await wallet.provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    const account = firstAccount(accounts);
    if (!account) {
      if (silent) return undefined;
      throw new Error("The wallet did not share an account.");
    }
    const chainId = parseChainId(await wallet.provider.request({ method: "eth_chainId" }));
    return new WalletSession(wallet, account, chainId);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.wallet.provider.on?.(event, listener);
    this.handlers.push([event, listener]);
  }

  dispose(): void {
    for (const [event, listener] of this.handlers) this.wallet.provider.removeListener?.(event, listener);
    this.handlers.length = 0;
  }
}

/**
 * The wallet client used for every transaction: the visitor's account on the configured chain, over
 * the injected provider. Built with `createClient` (+ the tree-shakable `writeContract` action at the
 * call site) rather than `createWalletClient`, which would bundle every wallet action (~80 kB).
 */
export function makeWalletClient(session: WalletSession, config: Config) {
  return createClient({
    account: session.account,
    chain: chainFor(config.chainId, config.rpcUrls),
    transport: custom(session.wallet.provider),
  });
}
export type X429WalletClient = ReturnType<typeof makeWalletClient>;

function errorCode(err: unknown): number | undefined {
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError) !== null) return true;
  if (errorCode(err) === 4001) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /user (rejected|denied|cancel)/i.test(msg);
}

/**
 * Asks the wallet to switch to the configured chain, adding it first if the wallet does not know it
 * (error 4902, or any non-rejection error since wallets report this inconsistently).
 */
export async function switchToChain(provider: Eip1193Provider, config: Config): Promise<void> {
  const chainId = numberToHex(config.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    return;
  } catch (err) {
    if (isUserRejection(err)) throw err;
  }
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId,
        chainName: config.chainName,
        nativeCurrency: { name: NATIVE_USDC.name, symbol: NATIVE_USDC.symbol, decimals: NATIVE_USDC.decimals },
        rpcUrls: config.rpcUrls,
        blockExplorerUrls: [config.explorer],
      },
    ],
  });
  // Most wallets switch right after adding; ask once more for those that do not.
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch {
    /* the chainChanged event (or its absence) tells the panel what happened */
  }
}

const REVERT_TEXT: Record<string, string> = {
  NotWaiting: "That ticket is not waiting any more (it was served, left or was removed).",
  NotTicketOwner: "That ticket belongs to another address.",
  QueueFull: "The queue is full right now. Try again after a few tickets are served.",
  UnknownQueue: "This queue does not exist on the configured contract.",
  NothingToWithdraw: "There is nothing to withdraw yet.",
  TransferFailed: "The payout transfer failed.",
  InvalidPositions: "Invalid number of positions.",
  NothingPassed: "Your budget does not cover the skip price of the ticket ahead.",
  NotOperator: "Only the queue operator can do that.",
  InvalidOperator: "Invalid operator address.",
  InvalidMaxLength: "Invalid maximum queue length.",
  Reentrancy: "Reentrant call rejected.",
};

function findRevertData(err: unknown, depth = 0): Hex | undefined {
  if (!err || typeof err !== "object" || depth > 8) return undefined;
  const e = err as { data?: unknown; cause?: unknown; error?: unknown; originalError?: unknown };
  if (typeof e.data === "string" && isHex(e.data) && e.data.length >= 10) return e.data;
  for (const next of [e.data, e.originalError, e.error, e.cause]) {
    const found = next !== err ? findRevertData(next, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** The contract error name behind a failure, from viem's decoding or raw revert data. */
export function contractErrorName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return reverted.data.errorName;
  }
  const data = findRevertData(err);
  if (data) {
    try {
      return decodeErrorResult({ abi: x429Abi, data }).errorName;
    } catch {
      /* not one of ours */
    }
  }
  const msg = err instanceof Error ? err.message : "";
  return Object.keys(REVERT_TEXT).find((name) => msg.includes(name));
}

/** One line a visitor can act on. */
export function explainError(err: unknown): string {
  if (isUserRejection(err)) return "You rejected the request in your wallet.";
  const name = contractErrorName(err);
  if (name) return `${REVERT_TEXT[name] ?? "The contract rejected the transaction."} (${name})`;
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof InsufficientFundsError) !== null) {
      return "Not enough USDC on Arc to pay for this transaction (gas is paid in USDC).";
    }
    if (err.walk((e) => e instanceof ChainMismatchError) !== null) {
      return "Your wallet is on another network. Switch to Arc and try again.";
    }
  }
  const msg = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
  if (/insufficient funds/i.test(msg)) return "Not enough USDC on Arc to pay for this transaction (gas is paid in USDC).";
  if (isRateLimitError(err)) return "The RPC is busy. Wait a few seconds and try again.";
  if (errorCode(err) === -32002) return "Your wallet already has a pending request. Open it to continue.";
  const line = msg.split("\n")[0] ?? msg;
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}
