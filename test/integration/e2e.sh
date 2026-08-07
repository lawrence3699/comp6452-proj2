#!/usr/bin/env bash
#
# End-to-end test against a live network. Unlike the chaincode unit tests, this
# needs the network up, identities registered and both chaincodes deployed:
#
#   network/network.sh all
#   test/integration/e2e.sh
#
# Covers the required path from test/integration/README.md:
#   1. producer registers a batch
#   2. custody moves producer -> transporter -> warehouse, and the holder
#      marks the batch delivered
#   3. oracle submits readings that breach the cold chain range
#   4. coldchain-compliance flags the (already delivered) batch through
#      invokeChaincode
#   5. the regulator recalls it, and the recall cascades to derived batches
#   6. regulator reads back the complete lifecycle history:
#      CREATED -> IN_TRANSIT -> AT_WAREHOUSE -> DELIVERED -> FLAGGED -> RECALLED
#   7. the off-chain indexer, replaying this run's blocks, serves the same
#      story over HTTP
#
# Owner: person 4.

source "$(dirname "${BASH_SOURCE[0]}")/../../network/env.sh"

# Unique per run so repeated runs never collide on an existing key.
BATCH="E2E-$(date +%s)"
PASS=0
FAIL=0

ok()   { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }

# Assert a command succeeds.
expectOk() {
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi
}

# Assert a command fails, and that its output mentions the expected reason.
expectFail() {
  local what=$1 want=$2; shift 2
  local out
  if out=$("$@" 2>&1); then
    bad "$what (expected a rejection, but it succeeded)"
  elif echo "$out" | grep -q "$want"; then
    ok "$what"
  else
    bad "$what (rejected, but not for the expected reason: $out)"
  fi
}

# The indexer leg at the end replays chaincode events from where the chain is
# NOW, so the events of this very run are exactly the ones it indexes. The
# height must be captured before the first invoke; `peer channel getinfo`
# prints a line `Blockchain info: {"height":N,...}`.
setOrg1
START_HEIGHT=$(peer channel getinfo -c "$CHANNEL" 2>&1 \
  | sed -n 's/.*Blockchain info: //p' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["height"])') \
  || fail "cannot read the chain height — is the network up?"
echo "chain height at start: ${START_HEIGHT}"

step "1. producer registers batch ${BATCH}"
setUser producer1
expectOk "producer can register a batch" \
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:RegisterBatch\",\"Args\":[\"{\\\"batchId\\\":\\\"${BATCH}\\\",\\\"foodType\\\":\\\"chilled\\\",\\\"producedAt\\\":1700000000,\\\"shelfLifeDays\\\":14,\\\"origin\\\":\\\"Bowen QLD\\\",\\\"quantity\\\":500}\"]}"
sleep 3

setUser transporter1
expectFail "a transporter cannot register a batch" "access denied" \
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:RegisterBatch\",\"Args\":[\"{\\\"batchId\\\":\\\"${BATCH}-X\\\",\\\"foodType\\\":\\\"chilled\\\",\\\"producedAt\\\":1700000000,\\\"shelfLifeDays\\\":7,\\\"quantity\\\":10}\"]}"

step "1b. private data collection"
setUser producer1
PRIV_BATCH="${BATCH}-PRIV"
# Sensitive fields travel in the transient map, never as a normal argument: a
# normal argument is recorded in the proposal and lands on the public ledger.
TRANSIENT=$(printf '{"unitPrice":42.5,"inspectionNotes":"grade A"}' | base64)
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" -C "$CHANNEL" -n batch-registry \
  -c "{\"function\":\"BatchRegistryContract:RegisterBatch\",\"Args\":[\"{\\\"batchId\\\":\\\"${PRIV_BATCH}\\\",\\\"foodType\\\":\\\"chilled\\\",\\\"producedAt\\\":1700000000,\\\"shelfLifeDays\\\":9,\\\"origin\\\":\\\"Priv\\\",\\\"quantity\\\":20}\"]}" \
  --transient "{\"batch_private_details\":\"${TRANSIENT}\"}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_CA" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_CA" >/dev/null 2>&1 \
  && ok "batch registered with private details" \
  || bad "registration with private details failed"
sleep 3

public=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"${PRIV_BATCH}\"]}" 2>/dev/null)
echo "$public" | grep -q "unitPrice" \
  && bad "unitPrice leaked onto the public ledger" \
  || ok "unitPrice is absent from the public ledger"

private=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetPrivateDetails\",\"Args\":[\"${PRIV_BATCH}\"]}" 2>/dev/null)
echo "$private" | grep -q '"unitPrice":42.5' \
  && ok "a collection member can read the private details" \
  || bad "private details unreadable by a collection member: $private"

# The hash is public even to organisations outside the collection, which is how
# an auditor proves the payload has not changed without ever seeing it.
hash=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetPrivateDetailsHash\",\"Args\":[\"${PRIV_BATCH}\"]}" 2>/dev/null)
expected=$(python3 -c "
import hashlib, json
d = {'batchId': '${PRIV_BATCH}', 'unitPrice': 42.5, 'inspectionNotes': 'grade A'}
print(hashlib.sha256(json.dumps(d, separators=(',', ':')).encode()).hexdigest())")
[ "$hash" = "$expected" ] \
  && ok "the on-chain hash matches the private payload" \
  || bad "hash mismatch: chain=$hash expected=$expected"

step "2. custody transfer"
setUser producer1
expectOk "holder can transfer custody" \
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:TransferCustody\",\"Args\":[\"${BATCH}\",\"Org2MSP\"]}"
sleep 3

status=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null)
[ "$status" = "IN_TRANSIT" ] && ok "status is IN_TRANSIT after transfer" \
                             || bad "status is '$status', expected IN_TRANSIT"

# The batch now belongs to Org2MSP, so the original holder must be refused.
expectFail "a non-holder cannot transfer custody" "not the current holder" \
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:TransferCustody\",\"Args\":[\"${BATCH}\",\"Org1MSP\"]}"

step "2b. warehouse receipt and delivery"
# Org2 hands the batch to itself: the holder stays Org2MSP while the status
# walks IN_TRANSIT -> AT_WAREHOUSE — receiving into a warehouse is the one
# transfer that parks the batch instead of keeping it moving.
setOrg2
ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:TransferCustody\",\"Args\":[\"${BATCH}\",\"Org2MSP\"]}" >/dev/null 2>&1
sleep 3

status=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null)
[ "$status" = "AT_WAREHOUSE" ] && ok "status is AT_WAREHOUSE after warehouse receipt" \
                               || bad "status is '$status', expected AT_WAREHOUSE"

# Delivery is gated on possession, not on a role attribute: only the current
# holder may close the custody chain, so an Org1 identity must be refused.
setUser producer1
expectFail "a non-holder cannot mark delivery" "not the current holder" \
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:MarkDelivered\",\"Args\":[\"${BATCH}\"]}"

setOrg2
ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:MarkDelivered\",\"Args\":[\"${BATCH}\"]}" >/dev/null 2>&1
sleep 3

status=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null)
[ "$status" = "DELIVERED" ] && ok "the holder marked the batch DELIVERED" \
                            || bad "status is '$status', expected DELIVERED"

step "3. oracle submits breaching readings (chilled range is 0..4C)"
# rawDataHash anchors the off-chain raw series, so the chaincode insists on a
# real lowercase hex SHA-256 — every hash below is computed, never invented.
# The non-oracle probe gets a VALID hash on purpose: the assertion is about the
# oracle attribute, and a malformed hash would trip the wrong rejection.
PROBE_HASH=$(printf '%s' "probe-${BATCH}" | shasum -a 256 | cut -d' ' -f1)

setUser transporter1
expectFail "a non-oracle cannot submit a reading" "oracle attribute" \
  ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:SubmitTemperatureReading\",\"Args\":[\"${BATCH}\",\"9\",\"1700001000\",\"${PROBE_HASH}\"]}"

setUser oracle1
# In-range temperature on purpose: were the malformed hash somehow accepted,
# the reading still must not advance the breach counter.
expectFail "a malformed rawDataHash is rejected" "rawDataHash" \
  ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:SubmitTemperatureReading\",\"Args\":[\"${BATCH}\",\"3\",\"1700000900\",\"not-a-hash\"]}"

for i in 1 2 3; do
  READING_HASH=$(printf '%s' "reading-${BATCH}-${i}" | shasum -a 256 | cut -d' ' -f1)
  expectOk "oracle submits breach reading ${i}" \
    ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:SubmitTemperatureReading\",\"Args\":[\"${BATCH}\",\"$((8 + i))\",\"17000010${i}0\",\"${READING_HASH}\"]}"
  sleep 3
done

step "4. the delivered batch is flagged through invokeChaincode"
# DELIVERED -> FLAGGED is a legal move: contamination is routinely discovered
# after receipt, and delivery must not immunise a batch against the oracle.
count=$(ccQuery coldchain-compliance "{\"function\":\"ComplianceContract:GetBreachCount\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null)
[ "$count" = "3" ] && ok "breach count reached 3" || bad "breach count is '$count', expected 3"

status=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null)
[ "$status" = "FLAGGED" ] && ok "cross-chaincode call flagged the batch" \
                          || bad "status is '$status', expected FLAGGED"

step "4b. a recall cascades to derived batches"
# A contaminated pallet gets split and repacked, so the recall has to follow the
# derivation graph. This regression-guards a real bug: the cascade used to scan
# the derivedFrom index in coldchain-compliance's own state namespace, where
# batch-registry's index is invisible, so only the named batch was ever recalled.
setUser producer1
PARENT="${BATCH}-P"
CHILD="${BATCH}-C"
GRANDCHILD="${BATCH}-G"
regBatch() {
  local id=$1 parent=${2:-} extra=""
  [ -n "$parent" ] && extra=",\\\"derivedFrom\\\":\\\"${parent}\\\""
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:RegisterBatch\",\"Args\":[\"{\\\"batchId\\\":\\\"${id}\\\",\\\"foodType\\\":\\\"chilled\\\",\\\"producedAt\\\":1700000000,\\\"shelfLifeDays\\\":9,\\\"quantity\\\":10${extra}}\"]}" >/dev/null 2>&1
  sleep 2
}
regBatch "$PARENT"
regBatch "$CHILD" "$PARENT"
regBatch "$GRANDCHILD" "$CHILD"

CASCADE_HASH=$(printf '%s' "cascade-${BATCH}" | shasum -a 256 | cut -d' ' -f1)
setUser regulator1
for id in "$PARENT" "$CHILD" "$GRANDCHILD"; do
  ccInvoke batch-registry "{\"function\":\"BatchRegistryContract:FlagBatch\",\"Args\":[\"${id}\",\"cascade test\",\"${CASCADE_HASH}\"]}" >/dev/null 2>&1
  sleep 2
done

ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:RecallBatch\",\"Args\":[\"${PARENT}\"]}" >/dev/null 2>&1
sleep 3

statusOf() {
  ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"$1\"]}" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null
}
[ "$(statusOf "$PARENT")" = "RECALLED" ] \
  && ok "the named batch is recalled" || bad "parent is $(statusOf "$PARENT"), expected RECALLED"
[ "$(statusOf "$CHILD")" = "RECALLED" ] \
  && ok "the recall reached the derived batch" || bad "child is $(statusOf "$CHILD"), expected RECALLED"
[ "$(statusOf "$GRANDCHILD")" = "RECALLED" ] \
  && ok "the recall reached two levels down" || bad "grandchild is $(statusOf "$GRANDCHILD"), expected RECALLED"

# FLAGGED -> RECALLED on the main batch closes out the full lifecycle that the
# history assertions in step 5 walk end to end.
ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:RecallBatch\",\"Args\":[\"${BATCH}\"]}" >/dev/null 2>&1
sleep 3

step "5. regulator reads the full history"
setUser regulator1
history=$(ccQuery batch-registry "{\"function\":\"BatchQueryContract:GetBatchHistory\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null)
echo "$history" | python3 -c '
import json, sys
h = json.load(sys.stdin)
for e in h:
    v = e.get("value") or {}
    print("     %s  %s" % (e["timestamp"], v.get("status", "-")))
sys.exit(0 if len(h) >= 6 else 1)
' && ok "history contains every state change" || bad "history is incomplete"

# The states must appear in the order they happened — the full lifecycle.
echo "$history" | python3 -c '
import json, sys
h = json.load(sys.stdin)
seen = [ (e.get("value") or {}).get("status") for e in h ]
ts   = [ e["timestamp"] for e in h ]
want = ["CREATED", "IN_TRANSIT", "AT_WAREHOUSE", "DELIVERED", "FLAGGED", "RECALLED"]
sys.exit(0 if ts == sorted(ts) and seen == want else 1)
' && ok "history is ordered oldest-first, CREATED through RECALLED" \
  || bad "history ordering is wrong"

step "6. the off-chain indexer serves the same story over HTTP"
# The indexer runs against THIS run's blocks: a fresh store and a fresh
# registry checkpoint under mktemp, INDEXER_START_BLOCK at the height captured
# before the first invoke. The compliance stream's checkpoint lives at its
# per-chaincode default under offchain/indexer/.indexer (the env var only
# names the registry stream's file — see offchain/indexer/src/listen.ts); a
# leftover from a previous run is safe, because a checkpoint only ever resumes
# forward and this run's events are newer than any old checkpoint.
INDEXER_TMP=$(mktemp -d)
INDEXER_LOG="${INDEXER_TMP}/indexer.log"
INDEXER_URL="http://127.0.0.1:3199"

(cd "$REPO_ROOT/offchain/indexer" && \
  INDEXER_PORT=3199 \
  INDEXER_STORE_FILE="${INDEXER_TMP}/events.jsonl" \
  INDEXER_CHECKPOINT_FILE="${INDEXER_TMP}/checkpoint-registry.json" \
  INDEXER_START_BLOCK="${START_HEIGHT}" \
  FABRIC_TEST_NETWORK="${TEST_NETWORK}" \
  npm start) >"$INDEXER_LOG" 2>&1 &
INDEXER_PID=$!

# npm start wraps ts-node wraps node: killing only the leader would leave node
# holding port 3199 and the next run could not bind it. Kill the whole tree,
# children first.
killTree() {
  local pid=$1 child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    killTree "$child"
  done
  kill "$pid" 2>/dev/null || true
}
trap 'killTree "${INDEXER_PID:-}"' EXIT

# /health answers before the gateway connection is attempted, so readiness here
# only means "the HTTP server is up"; the history poll below waits for the
# actual indexing. Not an assertion — a dead server fails the history check.
READY=""
for i in $(seq 1 30); do
  if curl -s -o /dev/null "${INDEXER_URL}/health" 2>/dev/null; then READY=1; break; fi
  sleep 1
done
[ -n "$READY" ] || echo "  WARN  indexer /health not ready after 30s (log: $INDEXER_LOG)"

# Poll until the history reflects the recall — the last event of the run — so
# the greps below never race the replay. The recall reaches the main batch's
# history as RecallCascaded (compliance was the invoked chaincode; Fabric drops
# the callee's BatchRecalled event), which the indexer files under the root and
# surfaces as `"recalled": true`.
HIST_URL="${INDEXER_URL}/batch/${BATCH}/history"
HIST_CODE=""
HIST_JSON=""
for i in $(seq 1 30); do
  HIST_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HIST_URL" 2>/dev/null || true)
  if [ "$HIST_CODE" = "200" ]; then
    HIST_JSON=$(curl -s "$HIST_URL" 2>/dev/null || true)
    if echo "$HIST_JSON" | grep -qi '"recalled": true'; then break; fi
  fi
  sleep 1
done

[ "$HIST_CODE" = "200" ] \
  && ok "indexer serves /batch/:id/history with HTTP 200" \
  || bad "history endpoint answered '$HIST_CODE', expected 200 (log: $INDEXER_LOG)"

echo "$HIST_JSON" | grep -qi '"delivered": true' \
  && ok "indexed history records the delivery" \
  || bad "indexed history is missing the delivery"

echo "$HIST_JSON" | grep -qi '"recalled": true' \
  && ok "indexed history records the recall" \
  || bad "indexed history is missing the recall"

HEALTH_HEADERS=$(curl -si "${INDEXER_URL}/health" 2>/dev/null || true)
echo "$HEALTH_HEADERS" | grep -qi 'access-control-allow-origin' \
  && ok "responses carry Access-Control-Allow-Origin (dashboard CORS)" \
  || bad "Access-Control-Allow-Origin header is missing"

echo "$HEALTH_HEADERS" | grep -qi 'x-query-time-ms' \
  && ok "responses carry X-Query-Time-Ms (NFR evidence)" \
  || bad "X-Query-Time-Ms header is missing"

echo
echo "============================================================"
echo "  passed: $PASS   failed: $FAIL"
echo "============================================================"
[ "$FAIL" -eq 0 ]
