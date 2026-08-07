#!/usr/bin/env bash
#
# One-command presentation launcher.
#
# It starts a fresh event indexer at the current ledger height, opens the
# full-screen animated walkthrough, runs the scripted business story and keeps
# the read API alive for the animation's Q&A data view. A fresh checkpoint
# keeps old rehearsal batches out of that view.
#
# Usage:
#   ./showcase.sh                    presentation pace; keep indexer for Q&A
#   ./showcase.sh --fast             no narration pauses
#   ./showcase.sh --no-open          do not open the animation
#   ./showcase.sh --exit             stop the indexer after verification
#   ./showcase.sh --fast --no-open --exit   CI/rehearsal verification

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/.." && pwd)"
INDEXER_DIR="${REPO_ROOT}/offchain/indexer"
DASHBOARD="${REPO_ROOT}/docs/animation.html"
DASHBOARD_CSS="${REPO_ROOT}/docs/animation.css"
DASHBOARD_JS="${REPO_ROOT}/docs/animation.js"

OPEN_DASHBOARD=1
EXIT_AFTER=0
DEMO_ARGS=()

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]:-$0}"
}

for arg in "$@"; do
  case "$arg" in
    --fast) DEMO_ARGS+=(--fast) ;;
    --no-open) OPEN_DASHBOARD=0 ;;
    --exit) EXIT_AFTER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

fail() {
  echo "showcase: $*" >&2
  exit 1
}

for command in docker node curl python3; do
  command -v "$command" >/dev/null 2>&1 || fail "missing dependency: ${command}"
done

[ -f "$DASHBOARD" ] || fail "animation not found: ${DASHBOARD}"
[ -f "$DASHBOARD_CSS" ] || fail "animation stylesheet not found: ${DASHBOARD_CSS}"
[ -f "$DASHBOARD_JS" ] || fail "animation script not found: ${DASHBOARD_JS}"
[ -d "${INDEXER_DIR}/node_modules" ] || fail "run npm install in ${INDEXER_DIR} first"

required_containers=(
  peer0.org1.example.com
  peer0.org2.example.com
  orderer.example.com
  batch-registry.org1.example.com
  coldchain-compliance.org1.example.com
)
for container in "${required_containers[@]}"; do
  running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
  [ "$running" = "true" ] || fail "required container is not running: ${container}"
done

# The dashboard is intentionally fixed to :3001. Refuse to replace an
# unrelated listener: killing an existing process would make a one-command
# demo convenient at the cost of corrupting someone else's session.
if command -v lsof >/dev/null 2>&1 &&
   lsof -nP -iTCP:3001 -sTCP:LISTEN 2>/dev/null | grep -q .; then
  fail "port 3001 is already in use; stop that listener before starting the showcase"
fi

channel_info="$({
  source "${REPO_ROOT}/network/env.sh"
  setOrg1
  peer channel getinfo -c "${CHANNEL:-mychannel}"
} 2>&1)" || fail "could not query channel height: ${channel_info}"

start_block="$(printf '%s\n' "$channel_info" |
  sed -n 's/.*"height":[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -1)"
[ -n "$start_block" ] || fail "could not parse channel height from: ${channel_info}"

batch_id="${DEMO_BATCH:-SHOWCASE-$(date +%s)}"
tmp_base="${TMPDIR:-/tmp}"
runtime_root="${SHOWCASE_RUNTIME_ROOT:-${tmp_base%/}/comp6452-showcase}"
runtime_dir="${runtime_root%/}/${batch_id}"
mkdir -p "$runtime_dir/.indexer"

indexer_log="${runtime_dir}/indexer.log"
demo_log="${runtime_dir}/demo.log"
history_json="${runtime_dir}/history.json"
headers_file="${runtime_dir}/history.headers"

indexer_pid=''
cleanup() {
  if [ -n "$indexer_pid" ] && kill -0 "$indexer_pid" 2>/dev/null; then
    kill "$indexer_pid" 2>/dev/null || true
    wait "$indexer_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo
echo "========================================================================"
echo "  COMP6452 presentation launcher"
echo "========================================================================"
echo "  batch id       ${batch_id}"
echo "  start block    ${start_block}"
echo "  animation      ${DASHBOARD}"
echo "  runtime logs   ${runtime_dir}"
echo

# Running from runtime_dir makes both per-chaincode checkpoint defaults local
# to this presentation. INDEXER_START_BLOCK is the current height (the next
# block number), so the fresh index contains the live story and no old runs.
(
  cd "$runtime_dir"
  INDEXER_PORT=3001 \
  INDEXER_START_BLOCK="$start_block" \
  INDEXER_STORE_FILE="${runtime_dir}/events.jsonl" \
  INDEXER_CHECKPOINT_FILE="${runtime_dir}/checkpoint-batch-registry.json" \
  "${INDEXER_DIR}/node_modules/.bin/ts-node" \
    --project "${INDEXER_DIR}/tsconfig.json" "${INDEXER_DIR}/src/run.ts"
) >"$indexer_log" 2>&1 &
indexer_pid=$!

indexer_ready=0
for _ in $(seq 1 80); do
  if curl -fsS --max-time 1 http://127.0.0.1:3001/health >/dev/null 2>&1; then
    indexer_ready=1
    break
  fi
  if ! kill -0 "$indexer_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if [ "$indexer_ready" -ne 1 ]; then
  cat "$indexer_log" >&2
  fail "indexer did not become ready"
fi

echo "  [ready] Fabric network and both chaincodes"
echo "  [ready] event indexer: http://127.0.0.1:3001"

if [ "$OPEN_DASHBOARD" -eq 1 ]; then
  if command -v open >/dev/null 2>&1; then
    open "$DASHBOARD"
    echo "  [opened] animated walkthrough — Space pauses; arrows change scenes"
  else
    echo "  [open manually] file://${DASHBOARD}"
  fi
fi

echo
set +e
DEMO_PAUSE="${DEMO_PAUSE:-5}" DEMO_BATCH="$batch_id" \
  "${APP_DIR}/demo.sh" "${DEMO_ARGS[@]}" 2>&1 | tee "$demo_log"
demo_code=${PIPESTATUS[0]}
set -e
[ "$demo_code" -eq 0 ] || fail "business demo failed; see ${demo_log}"

history_url="http://127.0.0.1:3001/batch/${batch_id}/history"
history_ready=0
for _ in $(seq 1 80); do
  if curl -fsS --max-time 1 -D "$headers_file" "$history_url" -o "$history_json"; then
    history_ready=1
    break
  fi
  sleep 0.25
done

[ "$history_ready" -eq 1 ] || fail "indexer did not expose ${batch_id}; see ${indexer_log}"

echo
echo "========================================================================"
echo "  LIVE OFF-CHAIN READ MODEL"
echo "========================================================================"
python3 - "$history_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    history = json.load(handle)

print(f"  batch           {history['batchId']}")
print(f"  indexed events  {history['eventCount']}")
print(f"  current holder  {history.get('currentHolder', 'unknown')}")
print(f"  recalled        {str(history['recalled']).lower()}")
print("  event sequence  " + " -> ".join(event["eventName"] for event in history["events"]))
PY
query_ms="$(awk 'BEGIN{IGNORECASE=1} /^X-Query-Time-Ms:/ {gsub("\r", "", $2); print $2}' "$headers_file" | tail -1)"
echo "  HTTP query      ${query_ms:-n/a} ms"
echo "  history URL     ${history_url}"
echo
echo "  Demo verified. In the animation, open Data view and click Refresh."
echo "  Logs: ${demo_log} and ${indexer_log}"

if [ "$EXIT_AFTER" -eq 1 ]; then
  exit 0
fi

echo
echo "  The indexer stays online for Q&A. Press Ctrl-C when the presentation ends."
wait "$indexer_pid"
