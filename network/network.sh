#!/usr/bin/env bash
#
# Entry point for the Fabric network underneath this project.
#
#   ./network.sh up          bring up test-network with CAs and create the channel
#   ./network.sh identities  register the demo identities
#   ./network.sh deploy      build and deploy both chaincodes (CCaaS)
#   ./network.sh all         up + identities + deploy
#   ./network.sh down        tear everything down
#   ./network.sh status      show what is running
#
# Owner: person 4.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

networkUp() {
  step "bringing up test-network with CAs and creating channel ${CHANNEL}"
  (cd "$TEST_NETWORK" && ./network.sh up createChannel -ca -c "$CHANNEL") \
    || fail "test-network failed to start"

  step "pulling the node chaincode runtime image"
  # Not included in the install-fabric.sh docker set, but required to run the
  # CCaaS containers built from node:18-alpine against fabric-chaincode-node.
  docker pull -q hyperledger/fabric-nodeenv:2.5 >/dev/null 2>&1 || true
}

networkDown() {
  step "stopping chaincode containers"
  for cc in batch-registry coldchain-compliance; do
    docker rm -f "${cc}.org1.example.com" >/dev/null 2>&1 || true
  done

  step "tearing down test-network"
  (cd "$TEST_NETWORK" && ./network.sh down) || true
}

networkStatus() {
  step "containers"
  docker ps --format '{{.Names}}\t{{.Status}}' \
    | grep -E 'peer0|orderer|ca_|batch-registry|coldchain' || echo "  (none running)"

  step "committed chaincode on ${CHANNEL}"
  setOrg1
  peer lifecycle chaincode querycommitted --channelID "$CHANNEL" 2>/dev/null \
    || echo "  (channel not reachable)"
}

case "${1:-}" in
  up)         networkUp ;;
  identities) bash "${HERE}/registerIdentities.sh" ;;
  deploy)     bash "${HERE}/deployCC.sh" ;;
  all)
    networkUp
    bash "${HERE}/registerIdentities.sh"
    bash "${HERE}/deployCC.sh"
    ;;
  down)       networkDown ;;
  status)     networkStatus ;;
  *)
    sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
