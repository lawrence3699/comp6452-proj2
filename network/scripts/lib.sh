#!/usr/bin/env bash
# Shared helpers for the scripts in this directory.
#
# These wrap the CA-based fabric-samples test-network rather than
# reimplementing crypto/genesis generation — the network lifecycle is risky
# enough without also hand-rolling that part (see ../README.md).
set -euo pipefail

: "${FABRIC_SAMPLES_PATH:?set FABRIC_SAMPLES_PATH to your fabric-samples checkout, e.g. export FABRIC_SAMPLES_PATH=~/fabric-samples}"
TEST_NETWORK="${FABRIC_SAMPLES_PATH}/test-network"
CHANNEL_NAME="${CHANNEL_NAME:-mychannel}"

export PATH="${TEST_NETWORK}/../bin:${PATH}"
export FABRIC_CFG_PATH="${TEST_NETWORK}/../config"

ORDERER_CA="${TEST_NETWORK}/organizations/ordererOrganizations/example.com/msp/tlscacerts/tlsca.example.com-cert.pem"
ORDERER_ENDPOINT="localhost:7050"

PEER0_ORG1_CA="${TEST_NETWORK}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
PEER0_ORG2_CA="${TEST_NETWORK}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt"

# Exports CORE_PEER_* so a subsequent `peer` CLI call acts as the given org's
# admin. Org 1 and Org 2 are the two organisations in the default test-network
# topology; there is no third org in this project.
setGlobalsForOrg() {
  local org="$1"
  export CORE_PEER_TLS_ENABLED=true

  case "$org" in
    1)
      export CORE_PEER_LOCALMSPID="Org1MSP"
      export CORE_PEER_TLS_ROOTCERT_FILE="${PEER0_ORG1_CA}"
      export CORE_PEER_MSPCONFIGPATH="${TEST_NETWORK}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
      export CORE_PEER_ADDRESS="localhost:7051"
      ;;
    2)
      export CORE_PEER_LOCALMSPID="Org2MSP"
      export CORE_PEER_TLS_ROOTCERT_FILE="${PEER0_ORG2_CA}"
      export CORE_PEER_MSPCONFIGPATH="${TEST_NETWORK}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
      export CORE_PEER_ADDRESS="localhost:9051"
      ;;
    *)
      echo "setGlobalsForOrg: unknown org '${org}', expected 1 or 2" >&2
      exit 1
      ;;
  esac
}

peerAddressFlagsForOrg() {
  local org="$1"
  case "$org" in
    1) echo "--peerAddresses localhost:7051 --tlsRootCertFiles ${PEER0_ORG1_CA}" ;;
    2) echo "--peerAddresses localhost:9051 --tlsRootCertFiles ${PEER0_ORG2_CA}" ;;
    *)
      echo "peerAddressFlagsForOrg: unknown org '${org}', expected 1 or 2" >&2
      exit 1
      ;;
  esac
}
