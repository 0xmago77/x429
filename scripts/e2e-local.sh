#!/usr/bin/env bash
# x429 local end-to-end test.
#
#   arc-anvil --network arc (falls back to plain anvil) → deploy with the forge script → fund
#   operator + bots from the treasury → demo server (3 s service interval) → a "human" joins
#   with cast at 0.001 USDC → bot rush (X429_RUSH_NOW=1) → assert onchain + log outcomes.
#
# Keys are derived at runtime from anvil's public test mnemonic into .e2e/ (gitignored).
# Usage: bash scripts/e2e-local.sh        (E2E_NODE=anvil forces plain anvil)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
E2E="$ROOT/.e2e"
MNEMONIC="test test test test test test test test test test test junk"
SERVICE_INTERVAL_MS=3000
# Admission round: the head is served only once it has waited this long since joining, so the
# bots (which start after the human joins) can still reach the human. See SPEC.md.
MIN_QUEUE_MS="${E2E_MIN_QUEUE_MS:-30000}"
DEADLINE_S="${E2E_DEADLINE_S:-180}"
FEE_ARGS=(--gas-price 50gwei --priority-gas-price 0.01gwei)

log() { printf '\033[1;36m[e2e %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[e2e] %s\033[0m\n' "$*" >&2; exit 1; }

PIDS=()
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  sleep 0.5
  for pid in "${PIDS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
  if [ "$code" -ne 0 ]; then
    for f in node server agents; do
      if [ -f "$E2E/$f.log" ]; then
        printf '\n----- last lines of .e2e/%s.log -----\n' "$f" >&2
        tail -n 25 "$E2E/$f.log" >&2 || true
      fi
    done
    printf '\n\033[1;31m[e2e] FAILED (exit %s)\033[0m\n' "$code" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

wait_rpc() {
  for _ in $(seq 1 60); do
    if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$NODE_PID" 2>/dev/null; then return 1; fi
    sleep 0.25
  done
  return 1
}

for bin in forge cast node; do command -v "$bin" >/dev/null || die "$bin not found on PATH"; done
rm -rf "$E2E"
mkdir -p "$E2E/bots"
chmod 700 "$E2E"

# ---------------------------------------------------------------- 1. local chain
RPC_PORT="$(free_port)"
RPC="http://127.0.0.1:$RPC_PORT"
NODE_KIND="${E2E_NODE:-arc-anvil}"
start_node() {
  if [ "$NODE_KIND" = "arc-anvil" ]; then
    arc-anvil --network arc --port "$RPC_PORT" --chain-id 31337 --block-time 1 --mnemonic "$MNEMONIC" >"$E2E/node.log" 2>&1 &
  else
    anvil --port "$RPC_PORT" --chain-id 31337 --block-time 1 --mnemonic "$MNEMONIC" >"$E2E/node.log" 2>&1 &
  fi
  NODE_PID=$!
  PIDS+=("$NODE_PID")
}
if [ "$NODE_KIND" = "arc-anvil" ] && ! command -v arc-anvil >/dev/null; then NODE_KIND=anvil; fi
start_node
if ! wait_rpc; then
  if [ "$NODE_KIND" = "arc-anvil" ]; then
    log "arc-anvil --network arc did not start; falling back to plain anvil"
    NODE_KIND=anvil
    start_node
    wait_rpc || die "anvil did not start"
  else
    die "anvil did not start"
  fi
fi
log "chain: $NODE_KIND $([ "$NODE_KIND" = arc-anvil ] && echo '--network arc') on $RPC (chain $(cast chain-id --rpc-url "$RPC"), base fee $(cast base-fee --rpc-url "$RPC") wei)"

# ---------------------------------------------------------------- 2. keys (public test mnemonic, outside git)
derive() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr_of() { cast wallet address --private-key "$(cat "$1")"; }
umask 077
derive 0 >"$E2E/deployer.key"
derive 1 >"$E2E/operator.key"
derive 2 >"$E2E/treasury.key"
for i in 1 2 3 4 5 6 7 8; do derive $((i + 2)) >"$E2E/bots/bot$i.key"; done
derive 11 >"$E2E/human.key"
umask 022
DEPLOYER="$(addr_of "$E2E/deployer.key")"
OPERATOR="$(addr_of "$E2E/operator.key")"
TREASURY="$(addr_of "$E2E/treasury.key")"
HUMAN="$(addr_of "$E2E/human.key")"
{
  printf '{\n  "treasury": "%s",\n  "operator": "%s"' "$TREASURY" "$OPERATOR"
  for i in 1 2 3 4 5 6 7 8; do printf ',\n  "bot%s": "%s"' "$i" "$(addr_of "$E2E/bots/bot$i.key")"; done
  printf '\n}\n'
} >"$E2E/addresses.json"
log "keys derived into .e2e/ (deployer $DEPLOYER, operator $OPERATOR, treasury $TREASURY, human $HUMAN)"

# ---------------------------------------------------------------- 3. deploy + fund
# Stock forge refuses a node that reports the `arc` network family, so use Arc Foundry there.
if [ "$NODE_KIND" = "arc-anvil" ]; then FORGE_SCRIPT=(arc-forge script --network arc); else FORGE_SCRIPT=(forge script); fi
DEPLOY_BLOCK="$(cast block-number --rpc-url "$RPC")"
DEPLOY_OUT="$(cd contracts && DEPLOYER_PRIVATE_KEY="$(cat "$E2E/deployer.key")" X429_OPERATOR="$OPERATOR" \
  X429_QUEUE_META='{"name":"x429 e2e","serviceIntervalMs":3000}' \
  "${FORGE_SCRIPT[@]}" script/Deploy.s.sol --rpc-url "$RPC" --broadcast --with-gas-price 50gwei --priority-gas-price 0.01gwei 2>&1)" \
  || { echo "$DEPLOY_OUT"; die "deploy failed"; }
CONTRACT="$(grep -oE 'X429_CONTRACT=0x[0-9a-fA-F]{40}' <<<"$DEPLOY_OUT" | head -n1 | cut -d= -f2)"
QUEUE_ID="$(grep -oE 'X429_QUEUE_ID=[0-9]+' <<<"$DEPLOY_OUT" | head -n1 | cut -d= -f2)"
[ -n "$CONTRACT" ] && [ -n "$QUEUE_ID" ] || { echo "$DEPLOY_OUT"; die "could not parse the deploy output"; }
log "deployed X429Queue at $CONTRACT, queue $QUEUE_ID (operator $OPERATOR)"

export X429_CHAIN=anvil
export X429_RPC_URLS="$RPC"
export X429_CONTRACT="$CONTRACT"
export X429_QUEUE_ID="$QUEUE_ID"
export X429_OPERATOR_KEY_FILE="$E2E/operator.key"
export X429_TREASURY_KEY_FILE="$E2E/treasury.key"
export X429_BOT_KEYS_DIR="$E2E/bots"
export X429_ADDRESSES_FILE="$E2E/addresses.json"
export X429_STATE_FILE="$E2E/agents-state.json"
export X429_HOST=127.0.0.1
export X429_PORT="$(free_port)"
export X429_SERVICE_INTERVAL_MS="$SERVICE_INTERVAL_MS"
export X429_MIN_QUEUE_MS="$MIN_QUEUE_MS"
export X429_POLL_MS=1000
export X429_RUSH_SPREAD_S="${E2E_RUSH_SPREAD_S:-8}"
export X429_AGENT_TIMEOUT_S=$((DEADLINE_S - 10))

node demo/setup.ts fund --operator 1 --bot 0.25 --dry-run >"$E2E/setup.log" 2>&1 || { cat "$E2E/setup.log"; die "setup.ts fund --dry-run failed"; }
node demo/setup.ts fund --operator 1 --bot 0.25 >>"$E2E/setup.log" 2>&1 || { cat "$E2E/setup.log"; die "setup.ts fund failed"; }
log "setup.ts fund: $(grep -c '"evt":"funded"' "$E2E/setup.log") transfers from the treasury (arc-anvil pre-funds mnemonic indices 0-9)"
node demo/setup.ts site-config --out "$E2E/site" --deploy-block "$DEPLOY_BLOCK" >>"$E2E/setup.log" 2>&1 || die "setup.ts site-config failed"
node -e '
  const fs = require("fs");
  const dir = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(dir + "/config.json", "utf8"));
  const bots = JSON.parse(fs.readFileSync(dir + "/bots.json", "utf8"));
  const text = fs.readFileSync(dir + "/config.json", "utf8") + fs.readFileSync(dir + "/bots.json", "utf8");
  const ok = cfg.contract.toLowerCase() === process.argv[2].toLowerCase() && cfg.queueId === Number(process.argv[3]) &&
    cfg.chainId === 31337 && bots.length === 10 && !/[0-9a-fA-F]{64}/.test(text);
  if (!ok) { console.error("bad site config", cfg, bots.length); process.exit(1); }
' "$E2E/site" "$CONTRACT" "$QUEUE_ID" || die "site-config output is wrong"
log "setup.ts site-config: config.json + bots.json (10 labelled addresses, no secrets)"
cast send --rpc-url "$RPC" --private-key "$(cat "$E2E/deployer.key")" "${FEE_ARGS[@]}" --value 1ether "$HUMAN" >/dev/null
log "human funded with 1 USDC"

# ---------------------------------------------------------------- 4. demo server
node demo/server.ts >"$E2E/server.log" 2>&1 &
SERVER_PID=$!
PIDS+=("$SERVER_PID")
API="http://127.0.0.1:$X429_PORT"
for _ in $(seq 1 80); do
  if curl -fsS "$API/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || die "demo server exited"
  sleep 0.25
done
curl -fsS "$API/healthz" >/dev/null || die "demo server not healthy"
log "demo server on $API (1 request / ${SERVICE_INTERVAL_MS} ms, admission round ${MIN_QUEUE_MS} ms)"

# ---------------------------------------------------------------- 5 + 6. the human joins, the bots rush
# Default (as specified): the human joins, then the agents start with X429_RUSH_NOW=1.
# E2E_MODE=human: the agents start idle first and the human's Joined event wakes them
# (the dashboard flow: human-triggered rush, arrivals spread over X429_HUMAN_RUSH_SPREAD_S).
E2E_MODE="${E2E_MODE:-rush-now}"
export E2E_RPC="$RPC" E2E_CONTRACT="$CONTRACT" E2E_QUEUE_ID="$QUEUE_ID" E2E_HUMAN="$HUMAN"
export E2E_AGENTS_LOG="$E2E/agents.log" E2E_STATE_FILE="$X429_STATE_FILE"

start_agents() {
  X429_EXIT_AFTER_RUSH=1 node demo/agents.ts >"$E2E/agents.log" 2>&1 &
  AGENTS_PID=$!
  PIDS+=("$AGENTS_PID")
}

human_join() {
  JOIN_JSON="$(cast send --rpc-url "$RPC" --private-key "$(cat "$E2E/human.key")" "${FEE_ARGS[@]}" --json \
    "$CONTRACT" "join(uint32,uint128)" "$QUEUE_ID" 1000000000000000)"
  HUMAN_TICKET="$(node -e '
    const r = JSON.parse(process.argv[1]);
    const joined = r.logs.find((l) => l.topics[0] === process.argv[2]);
    console.log(BigInt(joined.topics[2]).toString());
  ' "$JOIN_JSON" "$(cast keccak 'Joined(uint32,uint64,address,uint128,uint32)')")"
  export E2E_HUMAN_TICKET="$HUMAN_TICKET"
  log "human joined: ticket #$HUMAN_TICKET, skip price 0.001 USDC"
}

if [ "$E2E_MODE" = "human" ]; then
  export X429_HUMAN_RUSH_SPREAD_S="${X429_HUMAN_RUSH_SPREAD_S:-12}"
  start_agents
  for _ in $(seq 1 60); do grep -q '"evt":"start"' "$E2E/agents.log" 2>/dev/null && break; sleep 0.5; done
  sleep 3 # let the shared watcher take its first snapshot
  log "agents idle (no scheduled rush due); a human join should wake them"
  human_join
else
  human_join
  X429_RUSH_NOW=1 start_agents
  log "agents started (rush now, spread ${X429_RUSH_SPREAD_S}s)"
fi
log "waiting up to ${DEADLINE_S}s"

# ---------------------------------------------------------------- 7. wait
START=$(date +%s)
LAST=""
while true; do
  ELAPSED=$(($(date +%s) - START))
  STATUS="$(node scripts/e2e-check.ts status 2>/dev/null || echo "? ?")"
  AGENTS_DONE=0
  kill -0 "$AGENTS_PID" 2>/dev/null || AGENTS_DONE=1
  OK=$(grep -c '"evt":"fortune".*"status":200' "$E2E/agents.log" || true)
  LINE="queue length ${STATUS% *}, human ${STATUS#* }, fortunes 200: $OK/8, agents $([ $AGENTS_DONE = 1 ] && echo done || echo running)"
  if [ "$LINE" != "$LAST" ]; then log "t+${ELAPSED}s $LINE"; LAST="$LINE"; fi
  if [ "$AGENTS_DONE" = 1 ] && [ "${STATUS% *}" = "0" ] && [ "${STATUS#* }" = "served" ]; then break; fi
  if [ "$ELAPSED" -ge "$DEADLINE_S" ]; then log "deadline reached"; break; fi
  sleep 2
done

# ---------------------------------------------------------------- 8. assert + summary
log "agent log highlights:"
grep -E '"evt":"(decision|overtook|fortune|rush_done|arrival_error)"' "$E2E/agents.log" \
  | node -e '
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.on("line", (l) => {
      const e = JSON.parse(l);
      if (e.evt === "decision") console.log(`  ${e.bot.padEnd(17)} decides: skip price ${e.skipPriceUsdc} USDC, ${e.overtake ? `overtake ${e.pass} for ${e.costUsdc} USDC` : "just join"}`);
      else if (e.evt === "overtook") console.log(`  ${e.bot.padEnd(17)} overtook ${e.passed} ticket(s), paid ${e.paidUsdc} USDC`);
      else if (e.evt === "fortune") console.log(`  ${e.bot.padEnd(17)} HTTP ${e.status}${e.receipt ? ` (ticket ${e.receipt.ticketId ?? "direct"}, waited ${e.receipt.waitedSeconds}s, passed ${e.receipt.timesPassed}x)` : ""}: ${e.fortune ?? e.error ?? ""}`);
      else if (e.evt === "rush_done") console.log(`  rush done: ${e.ok} ok, ${e.failed} failed, ${e.overtakes} overtakes, ${e.paidUsdc} USDC paid, ${e.seconds}s`);
      else console.log(`  ${e.bot ?? ""} ERROR ${e.code ?? ""} ${e.error}`);
    });
  ' || true
node scripts/e2e-check.ts assert
