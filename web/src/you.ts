// "Your panel": connect a wallet, check the network, join with a skip price, manage your tickets
// (change price, leave) and withdraw compensation. Chain reads happen only inside refresh(), which
// the page's single poll loop calls; transactions go through the visitor's wallet.
import { parseEventLogs, type Address, type Hash, type TransactionReceipt } from "viem";
import { getBalance, readContract, simulateContract, writeContract } from "viem/actions";
import { FEES, TicketStatus, explorerAddress, explorerTx, fmtUsdc, statusName, usdc } from "../../sdk/src/chain.ts";
import { x429Abi } from "../../sdk/src/abi.ts";
import type { Config } from "./config.ts";
import { button, extLink, h, placeChildren, setText, storage } from "./dom.ts";
import type { Digest } from "./events.ts";
import { parseUsdcInput, usdcText } from "./format.ts";
import { shortAddress, type Directory } from "./names.ts";
import { waitForReceipt, type ReadClient, type TicketView } from "./rpc.ts";
import {
  WalletSession,
  explainError,
  firstAccount,
  makeWalletClient,
  parseChainId,
  switchToChain,
  type InjectedWallet,
  type WalletDiscovery,
  type X429WalletClient,
} from "./wallet.ts";

const DEFAULT_SKIP_PRICE = "0.002";
const REFRESH_MS = 20_000;
const MAX_TICKET_READS = 6;
const MAX_TICKETS_KEPT = 20;
const MAX_FINISHED_SHOWN = 4;
const LOW_BALANCE = usdc("0.01");
const WALLET_KEY = "x429:wallet";

export type YouDeps = {
  config: Config;
  deployed: boolean;
  client: ReadClient;
  dir: Directory;
  discovery: WalletDiscovery;
  /** Ticket ids the feed saw being joined by `account`. */
  joinsOf: (account: Address) => bigint[];
  /** Names changed (connect / disconnect / account switch). */
  onAccountChange: () => void;
  /** Wake the poll loop now. */
  wake: () => void;
  /** Our transaction changed the queue: re-read it and wake the poll loop. */
  queueChanged: () => void;
};

type MyTicket = {
  id: bigint;
  /** undefined until read from the chain */
  status: number | undefined;
  skipPrice: bigint | undefined;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
  position: number | undefined;
  positionExact: boolean;
};

type TicketRow = {
  li: HTMLLIElement;
  title: HTMLElement;
  status: HTMLElement;
  where: HTMLElement;
  facts: HTMLElement;
  actions: HTMLElement;
  price: HTMLInputElement;
  setBtn: HTMLButtonElement;
  leaveBtn: HTMLButtonElement;
  touched: boolean;
};

type TxKind = "pending" | "ok" | "error";

export class YouPanel {
  private readonly d: YouDeps;
  private readonly cfg: Config;
  private session: WalletSession | undefined;
  private mode: "idle" | "picking" | "none" | "connecting" = "idle";
  private walletError = "";
  private busy = false;
  private dirty = false;
  private lastRefresh = 0;
  private generation = 0;
  private claimable: bigint | undefined;
  private balance: bigint | undefined;
  private readonly tickets = new Map<string, MyTicket>();
  private queue: readonly TicketView[] = [];
  private queueTotal = 0;
  private walletSig = "";
  private networkSig = "";

  private readonly walletBox = h("div", { class: "you-wallet" });
  private readonly networkBox = h("div", { class: "notice notice-warn you-network" });
  private readonly body = h("div", { class: "you-body" });
  private readonly balanceLine = h("p", { class: "you-balance" });
  private readonly joinInput: HTMLInputElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly joinHint = h("p", { class: "muted small" });
  private readonly sections = h("div", { class: "you-sections" });
  private readonly ticketList = h("ul", { class: "my-tickets" });
  private readonly ticketEmpty = h("p", { class: "muted small" }, "No tickets yet.");
  private readonly rows = new Map<string, TicketRow>();
  private readonly claimValue = h("strong", { class: "claim-value" }, "…");
  private readonly withdrawBtn: HTMLButtonElement;
  private readonly txBox = h("div", { class: "tx-status", role: "status", "aria-live": "polite" });

  constructor(root: HTMLElement, deps: YouDeps) {
    this.d = deps;
    this.cfg = deps.config;

    this.joinInput = h("input", {
      id: "join-price",
      class: "input",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      value: DEFAULT_SKIP_PRICE,
      "aria-describedby": "join-tradeoff",
    });
    this.joinBtn = button("Join the queue", "btn btn-primary", () => void this.join());
    this.withdrawBtn = button("Withdraw", "btn", () => void this.withdraw());

    const form = h(
      "form",
      { class: "join-form" },
      h("label", { for: "join-price" }, "Your skip price"),
      h("div", { class: "input-row" }, h("div", { class: "input-unit" }, this.joinInput, h("span", null, "USDC")), this.joinBtn),
      h(
        "p",
        { id: "join-tradeoff", class: "tradeoff" },
        "Higher price: you are paid more each time someone passes you, but cutting ahead of you costs more, so you are passed less often. " +
          "Lower price: you will likely be passed, and paid each time.",
      ),
      this.joinHint,
    );
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void this.join();
    });

    this.sections.append(
      h("div", { class: "you-section" }, h("h3", null, "Your tickets"), this.ticketEmpty, this.ticketList),
      h(
        "div",
        { class: "you-section" },
        h("h3", null, "Compensation"),
        h(
          "div",
          { class: "claim-row" },
          h("div", null, h("div", { class: "muted small" }, "Claimable: what agents paid to pass you"), this.claimValue),
          this.withdrawBtn,
        ),
      ),
    );
    this.body.append(this.balanceLine, form, this.sections);
    this.txBox.hidden = true;
    root.replaceChildren(this.walletBox, this.networkBox, this.body, this.txBox);

    deps.discovery.onChange(() => {
      if (!this.session && (this.mode === "picking" || this.mode === "none")) this.mode = "picking";
      this.render();
    });
    this.render();
    setTimeout(() => void this.reconnect(), 400);
  }

  // ---------------------------------------------------------------- called by the poll loop

  needsRefresh(now: number): boolean {
    return this.session !== undefined && this.d.deployed && (this.dirty || now - this.lastRefresh > REFRESH_MS);
  }

  /** Reads claimable, balance and the status of tickets that may still be waiting (a few calls). */
  async refresh(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const gen = this.generation;
    const account = session.account;
    const client = this.d.client;
    const address = this.cfg.contract;
    this.dirty = false;
    try {
      const [claimable, balance] = await Promise.all([
        readContract(client, { address, abi: x429Abi, functionName: "claimable", args: [account] }),
        getBalance(client, { address: account }),
      ]);
      if (gen !== this.generation) return;
      this.claimable = claimable;
      this.balance = balance;

      const open = [...this.tickets.values()]
        .filter((t) => t.status === undefined || t.status === TicketStatus.Waiting)
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      for (const t of open.slice(0, MAX_TICKET_READS)) {
        const [owner, queueId, status, timesPassed, , , , skipPrice, earned, paid] = await readContract(client, {
          address,
          abi: x429Abi,
          functionName: "tickets",
          args: [t.id],
        });
        if (gen !== this.generation) return;
        if (owner.toLowerCase() !== account.toLowerCase() || queueId !== this.cfg.queueId) {
          this.tickets.delete(t.id.toString());
          continue;
        }
        t.status = status;
        t.timesPassed = timesPassed;
        t.skipPrice = skipPrice;
        t.earned = earned;
        t.paid = paid;
        t.position = undefined;
        if (status === TicketStatus.Waiting) {
          const idx = this.queue.findIndex((x) => x.id === t.id);
          if (idx >= 0) {
            t.position = idx + 1;
            t.positionExact = true;
          } else if (this.queueTotal > this.queue.length) {
            const pos = await readContract(client, { address, abi: x429Abi, functionName: "positionOf", args: [t.id] });
            if (gen !== this.generation) return;
            t.position = pos > 0 ? pos : undefined;
            t.positionExact = true;
          }
        }
      }
      if (open.length > MAX_TICKET_READS) this.dirty = true;
      this.lastRefresh = Date.now();
      this.persist();
      this.render();
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  /** The lane was re-read: update positions of my tickets and adopt tickets of mine found in it. */
  setQueue(list: readonly TicketView[], total: number): void {
    this.queue = list;
    this.queueTotal = total;
    if (!this.session) return;
    if (this.adoptFromQueue()) this.persist();
    const complete = total <= list.length;
    for (const t of this.tickets.values()) {
      if (t.status !== TicketStatus.Waiting) continue;
      const idx = list.findIndex((x) => x.id === t.id);
      const view = idx >= 0 ? list[idx] : undefined;
      if (view) {
        t.position = idx + 1;
        t.positionExact = true;
        t.skipPrice = view.skipPrice;
        t.timesPassed = view.timesPassed;
        t.earned = view.earned;
        t.paid = view.paid;
      } else if (complete) {
        t.position = undefined;
        this.dirty = true; // no longer in line: served, left or kicked; refresh() will tell
      } else {
        t.positionExact = false;
      }
    }
    this.render();
  }

  /** New logs: pick up my joins, and refresh if anything involves me or my tickets. */
  noteDigest(digest: Digest): void {
    const session = this.session;
    if (!session) return;
    let added = false;
    for (const join of digest.joins) if (this.d.dir.isMine(join.owner)) added = this.track(join.ticketId) || added;
    if (added) this.persist();
    const involved =
      digest.addresses.has(session.account.toLowerCase()) || [...digest.ticketIds].some((id) => this.tickets.has(id));
    if (added || involved) this.dirty = true;
  }

  // ---------------------------------------------------------------- wallet connection

  private connectClicked(): void {
    this.walletError = "";
    const wallets = this.d.discovery.list();
    if (wallets.length === 0) {
      this.mode = "none";
      this.render();
    } else if (wallets.length === 1) {
      void this.connect(wallets[0]!);
    } else {
      this.mode = "picking";
      this.render();
    }
  }

  private async connect(wallet: InjectedWallet): Promise<void> {
    this.mode = "connecting";
    this.walletError = "";
    this.render();
    try {
      const session = await WalletSession.connect(wallet);
      if (session) this.attach(session);
    } catch (err) {
      this.mode = "idle";
      this.walletError = explainError(err);
      this.render();
    }
  }

  /** Silently restores the last wallet if the site is still authorised (eth_accounts, no prompt). */
  private async reconnect(): Promise<void> {
    const rdns = storage.get(WALLET_KEY);
    if (!rdns || this.session) return;
    const wallet = this.d.discovery.list().find((w) => w.info.rdns === rdns);
    if (!wallet) return;
    try {
      const session = await WalletSession.connect(wallet, true);
      if (session && !this.session) this.attach(session);
    } catch {
      /* stay disconnected */
    }
  }

  private attach(session: WalletSession): void {
    this.session?.dispose();
    this.session = session;
    this.mode = "idle";
    this.walletError = "";
    storage.set(WALLET_KEY, session.wallet.info.rdns);
    session.on("accountsChanged", (accounts) => {
      if (this.session !== session) return;
      const account = firstAccount(accounts);
      if (!account) this.detach(true);
      else if (account !== session.account) {
        session.account = account;
        this.loadAccount();
      }
    });
    session.on("chainChanged", (chainId) => {
      if (this.session !== session) return;
      session.chainId = parseChainId(chainId);
      this.render();
    });
    this.loadAccount();
  }

  private detach(forget: boolean): void {
    this.session?.dispose();
    this.session = undefined;
    if (forget) storage.remove(WALLET_KEY);
    this.generation++;
    this.tickets.clear();
    this.claimable = undefined;
    this.balance = undefined;
    this.mode = "idle";
    this.d.dir.setAccount(undefined);
    this.d.onAccountChange();
    this.render();
  }

  private loadAccount(): void {
    const session = this.session;
    if (!session) return;
    this.generation++;
    this.tickets.clear();
    this.claimable = undefined;
    this.balance = undefined;
    this.d.dir.setAccount(session.account);
    for (const id of this.storedIds(session.account)) this.track(id);
    for (const id of this.d.joinsOf(session.account)) this.track(id);
    this.adoptFromQueue();
    this.persist();
    this.dirty = true;
    this.d.onAccountChange();
    this.render();
    this.d.wake();
  }

  private async switchChain(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      await switchToChain(session.wallet.provider, this.cfg);
      const chainId = parseChainId(await session.wallet.provider.request({ method: "eth_chainId" }));
      if (this.session === session) {
        session.chainId = chainId;
        this.render();
      }
    } catch (err) {
      this.showTx("error", `Network switch: ${explainError(err)}`);
    }
  }

  // ---------------------------------------------------------------- tickets bookkeeping

  private storageKey(account: Address): string {
    return `x429:tickets:${this.cfg.chainId}:${this.cfg.contract.toLowerCase()}:${account.toLowerCase()}`;
  }

  private storedIds(account: Address): bigint[] {
    try {
      const raw: unknown = JSON.parse(storage.get(this.storageKey(account)) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter((v): v is string => typeof v === "string" && /^\d{1,20}$/.test(v)).map((v) => BigInt(v));
    } catch {
      return [];
    }
  }

  private persist(): void {
    const session = this.session;
    if (!session) return;
    const ids = [...this.tickets.values()]
      .map((t) => t.id)
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, MAX_TICKETS_KEPT)
      .map((id) => id.toString());
    storage.set(this.storageKey(session.account), JSON.stringify(ids));
  }

  private track(id: bigint): boolean {
    const key = id.toString();
    if (this.tickets.has(key)) return false;
    this.tickets.set(key, {
      id,
      status: undefined,
      skipPrice: undefined,
      timesPassed: 0,
      earned: 0n,
      paid: 0n,
      position: undefined,
      positionExact: false,
    });
    return true;
  }

  /** Tickets of mine visible in the lane are waiting by definition. */
  private adoptFromQueue(): boolean {
    let added = false;
    this.queue.forEach((view, i) => {
      if (!this.d.dir.isMine(view.owner)) return;
      added = this.track(view.id) || added;
      const t = this.tickets.get(view.id.toString())!;
      t.status = TicketStatus.Waiting;
      t.position = i + 1;
      t.positionExact = true;
      t.skipPrice = view.skipPrice;
      t.timesPassed = view.timesPassed;
      t.earned = view.earned;
      t.paid = view.paid;
    });
    return added;
  }

  // ---------------------------------------------------------------- transactions

  private canSend(): boolean {
    const s = this.session;
    return s !== undefined && this.d.deployed && !this.busy && s.chainId === this.cfg.chainId;
  }

  /**
   * Sends one transaction through the wallet (fees pinned to FEES), waits for the receipt on the
   * public RPC and reports progress with a link to the transaction.
   */
  private async send(
    label: string,
    write: (wallet: X429WalletClient, account: Address) => Promise<Hash>,
    after?: (receipt: TransactionReceipt, account: Address) => void,
  ): Promise<boolean> {
    const session = this.session;
    if (!session || this.busy || !this.d.deployed) return false;
    if (session.chainId !== this.cfg.chainId) {
      this.showTx("error", `Switch your wallet to ${this.cfg.chainName} first.`);
      return false;
    }
    this.busy = true;
    this.render();
    let hash: Hash | undefined;
    try {
      this.showTx("pending", `${label}: confirm in your wallet…`);
      hash = await write(makeWalletClient(session, this.cfg), session.account);
      this.showTx("pending", `${label}: sent, waiting for confirmation…`, hash);
      const receipt = await waitForReceipt(this.d.client, hash);
      if (!receipt) {
        this.showTx("pending", `${label}: not confirmed yet. Check the transaction on the explorer.`, hash);
        return false;
      }
      if (receipt.status !== "success") {
        this.showTx("error", `${label}: the transaction reverted.`, hash);
        return false;
      }
      after?.(receipt, session.account);
      this.showTx("ok", `${label}: confirmed.`, hash);
      return true;
    } catch (err) {
      this.showTx("error", `${label}: ${explainError(err)}`, hash);
      return false;
    } finally {
      this.busy = false;
      this.dirty = true;
      this.render();
      this.d.queueChanged();
    }
  }

  private async join(): Promise<void> {
    if (!this.canSend()) return;
    const price = parseUsdcInput(this.joinInput.value);
    if (price === undefined) {
      this.showTx("error", "Enter your skip price in USDC, for example 0.002.");
      return;
    }
    const { contract: address, queueId } = this.cfg;
    await this.send(
      "Join",
      async (wallet, account) => {
        await simulateContract(this.d.client, { address, abi: x429Abi, functionName: "join", args: [queueId, price], account });
        return writeContract(wallet, { address, abi: x429Abi, functionName: "join", args: [queueId, price], ...FEES });
      },
      (receipt, account) => {
        const joined = parseEventLogs<typeof x429Abi, true, "Joined">({
          abi: x429Abi,
          logs: receipt.logs,
          eventName: "Joined",
          strict: true,
        });
        for (const log of joined) {
          if (log.address.toLowerCase() !== address.toLowerCase()) continue;
          if (log.args.owner.toLowerCase() !== account.toLowerCase()) continue;
          this.track(log.args.ticketId);
          const t = this.tickets.get(log.args.ticketId.toString())!;
          t.status = TicketStatus.Waiting;
          t.skipPrice = log.args.skipPrice;
          t.position = log.args.position;
          t.positionExact = true;
        }
        this.persist();
      },
    );
  }

  private async setPrice(ticketId: bigint, row: TicketRow): Promise<void> {
    if (!this.canSend()) return;
    const price = parseUsdcInput(row.price.value);
    if (price === undefined) {
      this.showTx("error", "Enter the new skip price in USDC, for example 0.003.");
      return;
    }
    const address = this.cfg.contract;
    await this.send(
      `Set skip price of ticket #${ticketId}`,
      async (wallet, account) => {
        await simulateContract(this.d.client, { address, abi: x429Abi, functionName: "setSkipPrice", args: [ticketId, price], account });
        return writeContract(wallet, {
          address,
          abi: x429Abi,
          functionName: "setSkipPrice",
          args: [ticketId, price],
          ...FEES,
        });
      },
      () => {
        row.touched = false;
        const t = this.tickets.get(ticketId.toString());
        if (t) t.skipPrice = price;
      },
    );
  }

  private async leave(ticketId: bigint): Promise<void> {
    if (!this.canSend()) return;
    const address = this.cfg.contract;
    await this.send(
      `Leave with ticket #${ticketId}`,
      async (wallet, account) => {
        await simulateContract(this.d.client, { address, abi: x429Abi, functionName: "leave", args: [ticketId], account });
        return writeContract(wallet, { address, abi: x429Abi, functionName: "leave", args: [ticketId], ...FEES });
      },
      () => {
        const t = this.tickets.get(ticketId.toString());
        if (t) {
          t.status = TicketStatus.Left;
          t.position = undefined;
        }
      },
    );
  }

  private async withdraw(): Promise<void> {
    if (!this.canSend()) return;
    const address = this.cfg.contract;
    await this.send(
      "Withdraw",
      async (wallet, account) => {
        await simulateContract(this.d.client, { address, abi: x429Abi, functionName: "withdraw", account });
        return writeContract(wallet, { address, abi: x429Abi, functionName: "withdraw", ...FEES });
      },
      () => {
        this.claimable = 0n;
      },
    );
  }

  // ---------------------------------------------------------------- rendering

  private showTx(kind: TxKind, text: string, hash?: Hash): void {
    this.txBox.hidden = false;
    this.txBox.className = `tx-status tx-${kind}`;
    const parts: Node[] = [h("span", null, text)];
    if (hash) parts.push(extLink(explorerTx(hash, this.cfg.explorer), "view transaction ↗", "tx-link"));
    this.txBox.replaceChildren(...parts);
  }

  private render(): void {
    const session = this.session;
    this.renderWallet();
    const wrongChain = session !== undefined && session.chainId !== this.cfg.chainId;
    this.networkBox.hidden = !wrongChain;
    if (session && wrongChain) this.renderNetwork(session);
    this.body.hidden = !session;
    if (session) this.renderBody();
  }

  private renderWallet(): void {
    const session = this.session;
    const wallets = this.mode === "picking" ? this.d.discovery.list() : [];
    const sig = [
      session?.account,
      session?.wallet.info.rdns,
      this.mode,
      this.walletError,
      wallets.map((w) => w.info.rdns).join(","),
    ].join("|");
    if (sig === this.walletSig) return;
    this.walletSig = sig;

    const parts: Node[] = [];
    if (session) {
      parts.push(
        h(
          "div",
          { class: "you-account" },
          h("span", { class: "dot", "aria-hidden": "true" }),
          h("span", null, "Connected "),
          extLink(explorerAddress(session.account, this.cfg.explorer), shortAddress(session.account), "mono"),
          h("span", { class: "muted" }, ` · ${session.wallet.info.name}`),
        ),
        button("Disconnect", "btn btn-ghost btn-small", () => this.detach(true)),
      );
    } else if (this.mode === "connecting") {
      parts.push(h("p", { class: "muted" }, "Waiting for your wallet… approve the connection there."));
    } else if (this.mode === "picking") {
      parts.push(
        h("p", { class: "muted small" }, "Choose a wallet:"),
        h("div", { class: "wallet-list" }, ...wallets.map((w) => this.walletButton(w))),
        button("Cancel", "btn btn-ghost btn-small", () => {
          this.mode = "idle";
          this.render();
        }),
      );
    } else if (this.mode === "none") {
      parts.push(
        h(
          "div",
          { class: "notice" },
          h("strong", null, "No wallet found. "),
          "Install a browser wallet such as MetaMask or Rabby, or open this page in your wallet app's browser. " +
            "You can still watch the queue without one.",
        ),
        button("Try again", "btn btn-small", () => this.connectClicked()),
      );
    } else {
      parts.push(
        button("Connect wallet", "btn btn-primary", () => this.connectClicked()),
        h(
          "p",
          { class: "muted small" },
          "Watching needs no wallet. Connect one to join the queue, change your price or withdraw what you earned.",
        ),
      );
    }
    if (this.walletError) parts.push(h("p", { class: "error" }, this.walletError));
    this.walletBox.replaceChildren(...parts);
  }

  private walletButton(wallet: InjectedWallet): HTMLButtonElement {
    const b = h(
      "button",
      { type: "button", class: "btn wallet-btn" },
      wallet.info.icon ? h("img", { src: wallet.info.icon, alt: "", width: 20, height: 20 }) : null,
      wallet.info.name,
    );
    b.addEventListener("click", () => void this.connect(wallet));
    return b;
  }

  private renderNetwork(session: WalletSession): void {
    const sig = String(session.chainId);
    if (sig === this.networkSig) return;
    this.networkSig = sig;
    const current = Number.isFinite(session.chainId) ? `chain ${session.chainId}` : "another network";
    this.networkBox.replaceChildren(
      h(
        "p",
        null,
        h("strong", null, "Wrong network. "),
        `Your wallet is on ${current}; x429 runs on ${this.cfg.chainName} (chain id ${this.cfg.chainId}).`,
      ),
      button(`Switch to ${this.cfg.chainName}`, "btn btn-primary btn-small", () => void this.switchChain()),
    );
  }

  private renderBody(): void {
    const deployed = this.d.deployed;
    const canSend = this.canSend();

    if (this.balance === undefined) {
      setText(this.balanceLine, deployed ? "Balance: loading…" : "");
      this.balanceLine.classList.remove("warn");
    } else {
      const low = this.balance < LOW_BALANCE;
      setText(
        this.balanceLine,
        `Balance: ${fmtUsdc(this.balance, 4)} USDC` +
          (low ? ". You need a little USDC on Arc for gas (about 0.002 USDC per transaction)." : ""),
      );
      this.balanceLine.classList.toggle("warn", low);
    }

    this.joinInput.disabled = !deployed;
    this.joinBtn.disabled = !canSend;
    setText(
      this.joinHint,
      deployed
        ? `You join queue #${this.cfg.queueId} at the tail. Joining wakes the bot swarm: expect a rush within seconds.`
        : "Joining opens once the contract is deployed.",
    );

    this.sections.hidden = !deployed;
    setText(this.claimValue, this.claimable === undefined ? "…" : usdcText(this.claimable));
    this.withdrawBtn.disabled = !canSend || !this.claimable;
    this.renderTickets(canSend);
  }

  private renderTickets(canSend: boolean): void {
    const all = [...this.tickets.values()];
    const byId = (a: MyTicket, b: MyTicket): number => (a.id < b.id ? 1 : -1);
    const waiting = all
      .filter((t) => t.status === TicketStatus.Waiting)
      .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
    const unknown = all.filter((t) => t.status === undefined).sort(byId);
    const finished = all
      .filter((t) => t.status !== undefined && t.status !== TicketStatus.Waiting && t.status !== TicketStatus.None)
      .sort(byId)
      .slice(0, MAX_FINISHED_SHOWN);

    const wanted: HTMLLIElement[] = [];
    const keep = new Set<string>();
    for (const t of [...waiting, ...unknown, ...finished]) {
      const key = t.id.toString();
      keep.add(key);
      let row = this.rows.get(key);
      if (!row) {
        row = this.createRow(t.id);
        this.rows.set(key, row);
      }
      this.fillRow(row, t, canSend);
      wanted.push(row.li);
    }
    for (const key of [...this.rows.keys()]) if (!keep.has(key)) this.rows.delete(key);
    placeChildren(this.ticketList, wanted);
    this.ticketEmpty.hidden = wanted.length > 0;
  }

  private createRow(ticketId: bigint): TicketRow {
    const price = h("input", {
      class: "input input-small",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": `New skip price for ticket ${ticketId}, in USDC`,
    });
    const title = h("strong", { class: "ticket-title" });
    const status = h("span", { class: "status" });
    const where = h("span", { class: "ticket-where" });
    const facts = h("p", { class: "ticket-facts muted small" });
    const row: TicketRow = {
      li: h("li", { class: "ticket" }),
      title,
      status,
      where,
      facts,
      actions: h("div", { class: "ticket-actions" }),
      price,
      setBtn: button("Set price", "btn btn-small", () => void this.setPrice(ticketId, row)),
      leaveBtn: button("Leave", "btn btn-small btn-danger", () => void this.leave(ticketId)),
      touched: false,
    };
    price.addEventListener("input", () => {
      row.touched = true;
    });
    row.actions.append(h("div", { class: "input-unit input-unit-small" }, price, h("span", null, "USDC")), row.setBtn, row.leaveBtn);
    row.li.append(h("div", { class: "ticket-head" }, title, status, where), facts, row.actions);
    return row;
  }

  private fillRow(row: TicketRow, t: MyTicket, canSend: boolean): void {
    const waiting = t.status === TicketStatus.Waiting;
    const name = t.status === undefined ? "checking" : statusName(t.status);
    setText(row.title, `Ticket #${t.id}`);
    setText(row.status, t.status === undefined ? "checking…" : name);
    row.status.className = `status status-${name}`;

    let where = "";
    if (waiting) {
      if (t.position === undefined) where = "position …";
      else {
        where = `position #${t.position}`;
        if (this.queueTotal > 0) where += ` of ${this.queueTotal}`;
        if (!t.positionExact) where += " (approx.)";
        if (t.position === 1) where += " · served next";
      }
    }
    setText(row.where, where);

    const facts: string[] = [];
    if (t.skipPrice !== undefined) facts.push(`skip price ${usdcText(t.skipPrice)}`);
    if (t.status !== undefined) {
      facts.push(`passed ${t.timesPassed}×`, `earned ${usdcText(t.earned)}`);
      if (t.paid > 0n) facts.push(`paid ${usdcText(t.paid)} to cut`);
    }
    setText(row.facts, facts.join(" · "));

    row.actions.hidden = !waiting;
    row.setBtn.disabled = !canSend;
    row.leaveBtn.disabled = !canSend;
    if (!row.touched && t.skipPrice !== undefined && document.activeElement !== row.price) {
      const value = fmtUsdc(t.skipPrice, 18);
      if (row.price.value !== value) row.price.value = value;
    }
  }
}
