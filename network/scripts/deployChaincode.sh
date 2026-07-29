#!/usr/bin/env bash
# Package / install / approve / commit one chaincode on both organisations.
#
# Usage: deployChaincode.sh <ccName> <ccPath> <ccLabel> [collectionsConfigPath]
#
# ccPath must already be built (npm install && npm run build), since
# `--lang node` packages whatever is on disk as-is rather than building it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

CC_NAME="${1:?usage: deployChaincode.sh <ccName> <ccPath> <ccLabel> [collectionsConfigPath]}"
CC_PATH="${2:?usage: deployChaincode.sh <ccName> <ccPath> <ccLabel> [collectionsConfigPath]}"
CC_LABEL="${3:?usage: deployChaincode.sh <ccName> <ccPath> <ccLabel> [collectionsConfigPath]}"
COLLECTIONS_CONFIG="${4:-}"
CC_VERSION="${CC_VERSION:-1}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"

COLLECTIONS_FLAG=()
if [[ -n "${COLLECTIONS_CONFIG}" ]]; then
  COLLECTIONS_FLAG=(--collections-config "${COLLECTIONS_CONFIG}")
fi

PACKAGE_FILE="/tmp/${CC_LABEL}.tar.gz"

echo "== packaging ${CC_NAME} from ${CC_PATH} =="
peer lifecycle chaincode package "${PACKAGE_FILE}" \
  --path "${CC_PATH}" --lang node --label "${CC_LABEL}"

for org in 1 2; do
  echo "== installing on org${org} =="
  setGlobalsForOrg "${org}"
  peer lifecycle chaincode install "${PACKAGE_FILE}"
done

setGlobalsForOrg 1
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled | grep "${CC_LABEL}" | sed -n 's/^Package ID: \(.*\), Label:.*$/\1/p')
if [[ -z "${PACKAGE_ID}" ]]; then
  echo "could not find an installed package ID for label ${CC_LABEL}" >&2
  exit 1
fi
echo "== package ID: ${PACKAGE_ID} =="

for org in 1 2; do
  echo "== approving for org${org} =="
  setGlobalsForOrg "${org}"
  peer lifecycle chaincode approveformyorg \
    -o "${ORDERER_ENDPOINT}" --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "${ORDERER_CA}" \
    --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
    --version "${CC_VERSION}" --package-id "${PACKAGE_ID}" --sequence "${CC_SEQUENCE}" \
    ${COLLECTIONS_FLAG[@]+"${COLLECTIONS_FLAG[@]}"}
done

echo "== committing =="
setGlobalsForOrg 1
# shellcheck disable=SC2046,SC2086
peer lifecycle chaincode commit \
  -o "${ORDERER_ENDPOINT}" --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "${ORDERER_CA}" \
  --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
  --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" \
  $(peerAddressFlagsForOrg 1) $(peerAddressFlagsForOrg 2) \
  ${COLLECTIONS_FLAG[@]+"${COLLECTIONS_FLAG[@]}"}

echo "== ${CC_NAME} committed at version ${CC_VERSION}, sequence ${CC_SEQUENCE} =="
echo "package ID (record this in addresses.txt): ${PACKAGE_ID}"
