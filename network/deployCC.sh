#!/usr/bin/env bash
#
# Deploy both chaincodes to the running network as Chaincode-as-a-Service.
#
# WHY CCaaS RATHER THAN THE USUAL --lang node PACKAGE
# ---------------------------------------------------
# The peer's built-in Docker builder drives a legacy image-build API that
# Docker 29 no longer serves. `peer lifecycle chaincode install` of a normal
# node package therefore dies with:
#
#   could not build chaincode: docker build failed: docker image build failed:
#   write unix @->/run/docker.sock: write: broken pipe
#
# CCaaS sidesteps this: we build the image ourselves, run the chaincode as a
# long-lived container on the peer's network, and install a package that only
# tells the peer where to dial. This is a supported Fabric 2.5 mode, not a
# workaround — see the ccaas_builder entry in the peer's core.yaml.
#
# Owner: person 4.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

CC_NETWORK="${CC_NETWORK:-fabric_test}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# Sequence is per chaincode, and each redeploy must use exactly one more than
# the currently committed sequence. Setting SEQUENCE forces a value for both;
# leaving it unset lets each chaincode work out its own next sequence, which is
# what makes this script safely re-runnable.
SEQUENCE="${SEQUENCE:-}"

# Next lifecycle sequence for a chaincode: committed + 1, or 1 when it has
# never been committed on this channel.
nextSequence() {
  local name=$1 committed
  committed=$(peer lifecycle chaincode querycommitted \
    --channelID "$CHANNEL" --name "$name" --output json 2>/dev/null \
    | jq -r '.sequence // 0' 2>/dev/null) || committed=0
  [ -n "$committed" ] || committed=0
  echo $((committed + 1))
}

deployOne() {
  local name=$1 collections=${2:-}
  local dir="${REPO_ROOT}/chaincode/${name}"
  local seq

  step "[$name] compiling TypeScript"
  (cd "$dir" && npm install --silent && npx tsc) || fail "[$name] tsc failed"
  [ -d "$dir/dist" ] || fail "[$name] no dist/ produced"

  step "[$name] building the chaincode image"
  # BuildKit is disabled deliberately: the classic builder is what works with
  # the Docker daemon shipped here.
  (cd "$dir" && DOCKER_BUILDKIT=0 docker build -q -t "${name}-ccaas" .) \
    || fail "[$name] docker build failed"

  step "[$name] packaging for the lifecycle"
  local pkg="${BUILD_DIR}/${name}"
  mkdir -p "$pkg"
  # The address must match the container name started below, or the peer
  # cannot resolve the chaincode on the docker network.
  cat > "${pkg}/connection.json" <<EOF
{"address":"${name}.org1.example.com:9999","dial_timeout":"10s","tls_required":false}
EOF
  cat > "${pkg}/metadata.json" <<EOF
{"type":"ccaas","label":"${name}_1.0"}
EOF
  (cd "$pkg" && tar cfz code.tar.gz connection.json \
     && tar cfz "${name}.tgz" metadata.json code.tar.gz) \
    || fail "[$name] packaging failed"

  step "[$name] installing on both peers"
  setOrg1; peer lifecycle chaincode install "${pkg}/${name}.tgz" >/dev/null \
    || fail "[$name] install on org1 failed"
  setOrg2; peer lifecycle chaincode install "${pkg}/${name}.tgz" >/dev/null \
    || fail "[$name] install on org2 failed"

  setOrg1
  seq="${SEQUENCE:-$(nextSequence "$name")}"
  echo "    deploying at sequence $seq"

  # Read the package id straight from the install output rather than searching
  # queryinstalled by label: after a rebuild the same label exists several
  # times with different hashes, and queryinstalled has no defined ordering, so
  # picking "the last one" can silently select a stale package.
  local pkgid
  pkgid=$(peer lifecycle chaincode calculatepackageid "${pkg}/${name}.tgz" 2>/dev/null)
  [ -n "$pkgid" ] || fail "[$name] could not compute the package id"
  echo "    package id: $pkgid"

  step "[$name] starting the chaincode container"
  docker rm -f "${name}.org1.example.com" >/dev/null 2>&1 || true
  docker run -d \
    --name "${name}.org1.example.com" \
    --hostname "${name}.org1.example.com" \
    --network "$CC_NETWORK" \
    -e CHAINCODE_ID="$pkgid" \
    -e CORE_CHAINCODE_ID_NAME="$pkgid" \
    "${name}-ccaas" >/dev/null || fail "[$name] could not start the container"

  # The server needs a moment before the peer's first dial succeeds.
  sleep 6

  # Collections config must be an absolute path: the peer CLI does not expand
  # a leading ~, and silently treats the resulting missing file as a failure.
  # macOS ships bash 3.2, where an empty array counts as unbound under `set -u`.
  # Every expansion below therefore uses the ${arr[@]+"${arr[@]}"} idiom, which
  # yields nothing at all when the array is empty instead of erroring.
  local extra=()
  if [ -n "$collections" ]; then
    [ -f "$collections" ] || fail "[$name] collections config not found: $collections"
    extra=(--collections-config "$collections")
  fi

  step "[$name] approving for both orgs"
  for org in 1 2; do
    [ "$org" = 1 ] && setOrg1 || setOrg2
    peer lifecycle chaincode approveformyorg \
      -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
      --tls --cafile "$ORDERER_CA" \
      --channelID "$CHANNEL" --name "$name" --version 1.0 \
      --package-id "$pkgid" --sequence "$seq" ${extra[@]+"${extra[@]}"} >/dev/null \
      || fail "[$name] approve for org${org} failed"
  done

  setOrg1
  step "[$name] checking commit readiness"
  peer lifecycle chaincode checkcommitreadiness \
    --channelID "$CHANNEL" --name "$name" --version 1.0 \
    --sequence "$seq" ${extra[@]+"${extra[@]}"} --output json

  step "[$name] committing"
  peer lifecycle chaincode commit \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL" --name "$name" --version 1.0 \
    --sequence "$seq" ${extra[@]+"${extra[@]}"} \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_CA" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_CA" \
    || fail "[$name] commit failed"

  echo "${name} ${pkgid}" >> "${BUILD_DIR}/pkgids"
}

command -v jq >/dev/null || fail "jq is required (brew install jq)"

deployOne batch-registry "${REPO_ROOT}/network/collections_config.json"
deployOne coldchain-compliance

step "committed definitions on ${CHANNEL}"
setOrg1
peer lifecycle chaincode querycommitted --channelID "$CHANNEL"

echo
echo "============================================================"
echo "Package IDs — paste these into addresses.txt"
echo "============================================================"
cat "${BUILD_DIR}/pkgids"
