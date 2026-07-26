#!/usr/bin/env bash
# Tears down the test-network and removes its generated crypto material.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

pushd "${TEST_NETWORK}" >/dev/null
./network.sh down
popd >/dev/null

rm -rf ../identities
echo "network down."
