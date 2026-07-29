#!/usr/bin/env bash
# Builds and deploys both chaincodes with the correct parameters for each.
#
# batch-registry carries the private data collection (it owns the batch
# state the collection attaches to); coldchain-compliance does not need one.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BATCH_REGISTRY_PATH="$(cd ../../chaincode/batch-registry && pwd)"
COLDCHAIN_COMPLIANCE_PATH="$(cd ../../chaincode/coldchain-compliance && pwd)"
COLLECTIONS_CONFIG="$(cd .. && pwd)/collections_config.json"

for ccPath in "${BATCH_REGISTRY_PATH}" "${COLDCHAIN_COMPLIANCE_PATH}"; do
  echo "== building $(basename "${ccPath}") =="
  (cd "${ccPath}" && npm install && npm run build)
done

./deployChaincode.sh batch-registry "${BATCH_REGISTRY_PATH}" batch-registry_1 "${COLLECTIONS_CONFIG}"
./deployChaincode.sh coldchain-compliance "${COLDCHAIN_COMPLIANCE_PATH}" coldchain-compliance_1
