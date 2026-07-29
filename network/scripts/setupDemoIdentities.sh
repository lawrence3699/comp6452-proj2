#!/usr/bin/env bash
# Registers the four identities the demo and test/integration/ need: one
# producer, one transporter, one regulator, and the oracle. Org placement
# matches chaincode/batch-registry/test/batchRegistry.spec.ts (producer on
# Org1, transporter on Org2).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

./registerIdentity.sh 1 producer1    producer1pw    "role=producer:ecert"    role
./registerIdentity.sh 2 transporter1 transporter1pw "role=transporter:ecert" role
./registerIdentity.sh 1 regulator1   regulator1pw   "role=regulator:ecert"   role
./registerIdentity.sh 2 oracle1      oracle1pw      "oracle=true:ecert"      oracle

echo "== identities ready under ../identities =="
