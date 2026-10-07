// The demo API: one fortune per service interval. Saturated? You get a 429 with an x429 descriptor.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createX429Gate } from "../sdk/src/server.ts";
import { fmtUsdc } from "../sdk/src/chain.ts";
import { errMsg, loadConfig, logger, makePublicClient, makeWallet, readKeyFile, requireContract } from "./config.ts";

const FORTUNES: readonly string[] = [
  "The line moves for those who price their patience.",
  "Your 429 today is someone's paycheck tomorrow.",
  "Fairness is a queue with receipts.",
  "He who cuts the line pays the line.",
  "Patience is a skip price you set to zero.",
  "Retry storms gather where no queue is kept.",
  "Every overtake is a tiny apology, paid in USDC.",
  "Good things come to those who wait. Better things come to those who are paid to wait.",
  "The head of the queue is not a place, it is a moment.",
  "You cannot rate-limit destiny, but you can queue for it.",
  "A ticket in the hand is worth two retries in the backoff.",
  "Exponential backoff is just patience with extra steps.",
  "Time is money; on Arc, the exchange rate is posted onchain.",
  "Somebody passed you. Check your claimable balance.",
  "The fastest request is the one that already holds a ticket.",
  "Too many requests? Not too many — just not yet.",
  "In a fair queue, even the impatient pay their way.",
  "Your place in line is safe; your price is negotiable.",
  "The operator serves from the head; fortune favours the tail that bids.",
  "Waiting is free. Being waited for is not.",
];

const cfg = loadConfig();
const log = logger("server");
const contract = requireContract(cfg);
const publicClient = makePublicClient(cfg);
const operatorAccount = readKeyFile(cfg.operatorKeyFile, "operator");
const operator = makeWallet(cfg, operatorAccount);

const gate = createX429Gate({
  publicClient,
  operator,
  contract,
  queueId: cfg.queueId,
  chainId: cfg.chain.id,
  serviceIntervalMs: cfg.serviceIntervalMs,
  minQueueMs: cfg.minQueueMs,
  admissionTtlMs: cfg.admissionTtlMs,
  suggestedSkipPrice: cfg.suggestedSkipPrice,
  pollMs: cfg.pollMs,
  log,
});

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function cors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "x-429-ticket, x-429-signature, content-type");
  res.setHeader("access-control-expose-headers", "retry-after, x-429-network, x-429-queue");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

let fortuneIndex = Math.floor(Math.random() * FORTUNES.length);

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (cors(req, res)) return;
    if (url.pathname === "/" && req.method === "GET") {
      return send(res, 200, {
        name: "x429 demo API",
        endpoints: { fortune: "GET /v1/fortune", descriptor: "GET /x429", health: "GET /healthz" },
        capacity: `1 request per ${cfg.serviceIntervalMs} ms`,
      });
    }
    if (url.pathname === "/healthz") {
      return send(res, 200, { ok: true, operator: operatorAccount.address, ...gate.stats(), queueLength: gate.watcher.snapshot?.length ?? null });
    }
    if (url.pathname === "/x429") {
      await gate(req, res);
      return;
    }
    if (url.pathname === "/v1/fortune" && req.method === "GET") {
      if (await gate(req, res)) {
        log({ evt: "request", path: url.pathname, status: res.statusCode, ms: Date.now() - started, ticket: req.headers["x-429-ticket"] });
        return;
      }
      const adm = gate.admission(req);
      fortuneIndex = (fortuneIndex + 1 + Math.floor(Math.random() * 3)) % FORTUNES.length;
      const fortune = FORTUNES[fortuneIndex]!;
      const receipt = adm
        ? {
            ticketId: adm.ticketId.toString(),
            waitedSeconds: adm.waited,
            timesPassed: adm.timesPassed,
            earned: adm.earned.toString(),
            paid: adm.paid.toString(),
            servedTx: adm.servedTx,
          }
        : { ticketId: null, waitedSeconds: 0, timesPassed: 0, earned: "0", paid: "0", servedTx: null };
      send(res, 200, { fortune, receipt });
      log({
        evt: "request",
        path: url.pathname,
        status: 200,
        via: adm ? "queue" : "direct",
        ms: Date.now() - started,
        ticketId: receipt.ticketId,
        earned: adm ? fmtUsdc(adm.earned) : "0",
        paid: adm ? fmtUsdc(adm.paid) : "0",
      });
      return;
    }
    send(res, 404, { error: "not_found" });
  } catch (err) {
    log({ evt: "error", path: url.pathname, error: errMsg(err) });
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, async () => {
  gate.start();
  let balance: string | undefined;
  try {
    balance = fmtUsdc(await publicClient.getBalance({ address: operatorAccount.address }));
  } catch (err) {
    balance = `unknown (${errMsg(err)})`;
  }
  log({
    evt: "listening",
    url: `http://${cfg.host}:${cfg.port}`,
    chainId: cfg.chain.id,
    contract,
    queueId: cfg.queueId,
    operator: operatorAccount.address,
    operatorBalanceUsdc: balance,
    serviceIntervalMs: cfg.serviceIntervalMs,
    minQueueMs: cfg.minQueueMs,
    admissionTtlMs: cfg.admissionTtlMs,
  });
});

function shutdown(signal: string): void {
  log({ evt: "shutdown", signal });
  gate.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
