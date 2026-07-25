#!/usr/bin/env bash
# Shared environment and helpers for the network scripts. Source, do not run.
#
# Owner: person 4.

set -euo pipefail

# Where fabric-samples lives. Override on a machine that keeps it elsewhere:
#   export FABRIC_SAMPLES=/path/to/fabric-samples
FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-bootstrap/fabric-samples}"
TEST_NETWORK="${FABRIC_SAMPLES}/test-network"
CHANNEL="${CHANNEL:-mychannel}"

# Absolute path to this repository, resolved from this script's own location so
# the scripts work regardless of the directory they are invoked from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$TEST_NETWORK" ]; then
  echo "error: test-network not found at $TEST_NETWORK" >&2
  echo "       set FABRIC_SAMPLES to the directory holding fabric-samples" >&2
  exit 1
fi

export PATH="${FABRIC_SAMPLES}/bin:$PATH"
export FABRIC_CFG_PATH="${FABRIC_SAMPLES}/config"
export CORE_PEER_TLS_ENABLED=true

ORG1_CA="${TEST_NETWORK}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
ORG2_CA="${TEST_NETWORK}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt"
ORDERER_CA="${TEST_NETWORK}/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORG1_USERS="${TEST_NETWORK}/organizations/peerOrganizations/org1.example.com/users"

# Act as the Org1 admin.
setOrg1() {
  export CORE_PEER_LOCALMSPID=Org1MSP
  export CORE_PEER_TLS_ROOTCERT_FILE="$ORG1_CA"
  export CORE_PEER_MSPCONFIGPATH="${ORG1_USERS}/Admin@org1.example.com/msp"
  export CORE_PEER_ADDRESS=localhost:7051
}

# Act as the Org2 admin.
setOrg2() {
  export CORE_PEER_LOCALMSPID=Org2MSP
  export CORE_PEER_TLS_ROOTCERT_FILE="$ORG2_CA"
  export CORE_PEER_MSPCONFIGPATH="${TEST_NETWORK}/organizations/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp"
  export CORE_PEER_ADDRESS=localhost:9051
}

# Act as one of the demo end users registered by registerIdentities.sh.
setUser() {
  export CORE_PEER_LOCALMSPID=Org1MSP
  export CORE_PEER_TLS_ROOTCERT_FILE="$ORG1_CA"
  export CORE_PEER_MSPCONFIGPATH="${ORG1_USERS}/$1@org1.example.com/msp"
  export CORE_PEER_ADDRESS=localhost:7051
}

# Invoke against both peers so the endorsement policy is satisfied.
ccInvoke() {
  local name=$1 payload=$2
  peer chaincode invoke \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" \
    -C "$CHANNEL" -n "$name" -c "$payload" \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_CA" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_CA"
}

ccQuery() {
  peer chaincode query -C "$CHANNEL" -n "$1" -c "$2"
}

step() { echo; echo "==> $*"; }
fail() { echo "error: $*" >&2; exit 1; }
