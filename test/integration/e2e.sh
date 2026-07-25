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
#   2. custody moves producer -> transporter -> warehouse
#   3. oracle submits readings that breach the cold chain range
#   4. coldchain-compliance flags the batch through invokeChaincode
#   5. regulator reads back the complete history, including the flag
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

step "3. oracle submits breaching readings (chilled range is 0..4C)"
setUser transporter1
expectFail "a non-oracle cannot submit a reading" "oracle attribute" \
  ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:SubmitTemperatureReading\",\"Args\":[\"${BATCH}\",\"9\",\"1700001000\",\"h\"]}"

setUser oracle1
for i in 1 2 3; do
  expectOk "oracle submits breach reading ${i}" \
    ccInvoke coldchain-compliance "{\"function\":\"ComplianceContract:SubmitTemperatureReading\",\"Args\":[\"${BATCH}\",\"$((8 + i))\",\"17000010${i}0\",\"evidence-${i}\"]}"
  sleep 3
done

step "4. the batch is flagged through invokeChaincode"
count=$(ccQuery coldchain-compliance "{\"function\":\"ComplianceContract:GetBreachCount\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null)
[ "$count" = "3" ] && ok "breach count reached 3" || bad "breach count is '$count', expected 3"

status=$(ccQuery batch-registry "{\"function\":\"BatchRegistryContract:GetBatch\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null)
[ "$status" = "FLAGGED" ] && ok "cross-chaincode call flagged the batch" \
                          || bad "status is '$status', expected FLAGGED"

step "5. regulator reads the full history"
setUser regulator1
history=$(ccQuery batch-registry "{\"function\":\"BatchQueryContract:GetBatchHistory\",\"Args\":[\"${BATCH}\"]}" 2>/dev/null)
echo "$history" | python3 -c '
import json, sys
h = json.load(sys.stdin)
for e in h:
    v = e.get("value") or {}
    print("     %s  %s" % (e["timestamp"], v.get("status", "-")))
sys.exit(0 if len(h) >= 3 else 1)
' && ok "history contains every state change" || bad "history is incomplete"

# The states must appear in the order they happened.
echo "$history" | python3 -c '
import json, sys
h = json.load(sys.stdin)
seen = [ (e.get("value") or {}).get("status") for e in h ]
ts   = [ e["timestamp"] for e in h ]
sys.exit(0 if ts == sorted(ts) and seen[0] == "CREATED" and seen[-1] == "FLAGGED" else 1)
' && ok "history is ordered oldest-first, CREATED through FLAGGED" \
  || bad "history ordering is wrong"

echo
echo "============================================================"
echo "  passed: $PASS   failed: $FAIL"
echo "============================================================"
[ "$FAIL" -eq 0 ]
