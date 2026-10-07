// Setup helpers.
//   node demo/setup.ts fund [--operator 0.5] [--bot 0.25] [--dry-run]
//       Bring the operator and the bots up to target balances (USDC) from the treasury.
//   node demo/setup.ts site-config [--out site] [--deploy-block N]
//       Write site/config.json and site/bots.json (public addresses only).
//   node demo/setup.ts addresses
//       Print the public address book {treasury, operator, bot1..bot8} derived from the key files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Address } from "viem";
import { fmtUsdc, sendTx, usdc } from "../sdk/src/chain.ts";
import { BOTS } from "./bots.ts";
import {
  errMsg,
  loadConfig,
  logger,
  makePublicClient,
  makeWallet,
  readAddresses,
  readBotKeys,
  readKeyFile,
  requireContract,
  type DemoConfig,
} from "./config.ts";

const REPO_URL = "https://github.com/0xmago77/x429";
const log = logger("setup");

function addressBook(cfg: DemoConfig): Record<string, Address> {
  const fromFile = readAddresses(cfg);
  if (fromFile) return fromFile as Record<string, Address>;
  const out: Record<string, Address> = {};
  if (cfg.treasuryKeyFile) out.treasury = readKeyFile(cfg.treasuryKeyFile, "treasury").address;
  if (cfg.operatorKeyFile) out.operator = readKeyFile(cfg.operatorKeyFile, "operator").address;
  if (cfg.botKeysDir) for (const b of readBotKeys(cfg)) out[b.slug] = b.account.address;
  return out;
}

async function fund(cfg: DemoConfig, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      operator: { type: "string", default: process.env.X429_FUND_OPERATOR_USDC ?? "0.5" },
      bot: { type: "string", default: process.env.X429_FUND_BOT_USDC ?? process.env.X429_TOPUP_TO_USDC ?? "0.25" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const dryRun = values["dry-run"] ?? false;
  const operatorTarget = usdc(values.operator!);
  const botTarget = usdc(values.bot!);
  const treasuryAccount = readKeyFile(cfg.treasuryKeyFile, "treasury");
  const treasury = makeWallet(cfg, treasuryAccount);
  const client = makePublicClient(cfg);
  const book = addressBook(cfg);

  const targets: Array<{ label: string; address: Address; target: bigint }> = [];
  if (book.operator) targets.push({ label: "operator", address: book.operator, target: operatorTarget });
  BOTS.forEach((spec, i) => {
    const a = book[`bot${i + 1}`];
    if (a) targets.push({ label: spec.name, address: a, target: botTarget });
  });
  if (targets.length === 0) throw new Error("no operator/bot addresses: set X429_ADDRESSES_FILE or the key file paths");

  let treasuryBalance = await client.getBalance({ address: treasuryAccount.address });
  log({ evt: "fund_start", dryRun, chainId: cfg.chain.id, treasury: treasuryAccount.address, treasuryUsdc: fmtUsdc(treasuryBalance), operatorTargetUsdc: fmtUsdc(operatorTarget), botTargetUsdc: fmtUsdc(botTarget) });
  let total = 0n;
  for (const t of targets) {
    const balance = await client.getBalance({ address: t.address });
    const need = t.target > balance ? t.target - balance : 0n;
    if (need === 0n) {
      log({ evt: "fund_skip", who: t.label, address: t.address, balanceUsdc: fmtUsdc(balance) });
      continue;
    }
    total += need;
    if (dryRun) {
      log({ evt: "fund_plan", who: t.label, address: t.address, balanceUsdc: fmtUsdc(balance), sendUsdc: fmtUsdc(need) });
      continue;
    }
    if (need >= treasuryBalance) throw new Error(`treasury too low to fund ${t.label}: has ${fmtUsdc(treasuryBalance)}, needs ${fmtUsdc(need)}`);
    const r = await sendTx(treasury, client, { to: t.address, value: need });
    treasuryBalance = await client.getBalance({ address: treasuryAccount.address });
    log({ evt: "funded", who: t.label, address: t.address, sentUsdc: fmtUsdc(need), tx: r.transactionHash, status: r.status });
  }
  log({ evt: "fund_done", dryRun, totalUsdc: fmtUsdc(total), treasuryUsdc: fmtUsdc(treasuryBalance) });
}

function siteConfig(cfg: DemoConfig, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", default: "site" },
      "deploy-block": { type: "string" },
    },
  });
  const contract = requireContract(cfg);
  const deployBlock = values["deploy-block"] !== undefined ? Number(values["deploy-block"]) : Number(cfg.deployBlock ?? 0n);
  const config = {
    chainId: cfg.chain.id,
    chainName: cfg.chainKind === "arc" ? "Arc" : cfg.chain.name,
    rpcUrls: cfg.rpcUrls,
    explorer: cfg.explorer,
    contract,
    queueId: cfg.queueId,
    deployBlock,
    rushEveryMin: cfg.rushEveryMin,
    serviceIntervalMs: cfg.serviceIntervalMs,
    repoUrl: REPO_URL,
  };
  const book = readAddresses(cfg);
  const bots: Array<{ address: Address; name: string; emoji: string; role: string }> = [];
  if (book) {
    BOTS.forEach((spec, i) => {
      const a = book[`bot${i + 1}`];
      if (a) bots.push({ address: a, name: spec.name, emoji: spec.emoji, role: "bot" });
    });
    if (book.operator) bots.push({ address: book.operator, name: "operator", emoji: "🛎️", role: "operator" });
    if (book.treasury) bots.push({ address: book.treasury, name: "treasury", emoji: "🏦", role: "treasury" });
  } else {
    log({ evt: "warning", message: "X429_ADDRESSES_FILE not set: bots.json will be empty" });
  }
  const out = values.out!;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(out, "bots.json"), JSON.stringify(bots, null, 2) + "\n");
  log({ evt: "site_config_written", out, contract, queueId: cfg.queueId, deployBlock, bots: bots.length });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case "fund":
      return fund(cfg, rest);
    case "site-config":
      return siteConfig(cfg, rest);
    case "addresses":
      process.stdout.write(JSON.stringify(addressBook(cfg), null, 2) + "\n");
      return;
    default:
      process.stderr.write(
        "usage:\n" +
          "  node demo/setup.ts fund [--operator 0.5] [--bot 0.25] [--dry-run]\n" +
          "  node demo/setup.ts site-config [--out site] [--deploy-block N]\n" +
          "  node demo/setup.ts addresses\n",
      );
      process.exit(2);
  }
}

main().catch((err) => {
  log({ evt: "fatal", error: errMsg(err) });
  process.exit(1);
});
