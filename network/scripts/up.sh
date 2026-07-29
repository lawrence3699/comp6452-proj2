#!/usr/bin/env bash
# Brings up the CA-based test-network and creates the channel.
#
# CA-based (not cryptogen) because the ABAC role/oracle attributes that
# access.ts and oracleIdentity.ts check must be issued by a Fabric CA at
# enrollment time — cryptogen identities carry no such attributes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

pushd "${TEST_NETWORK}" >/dev/null
./network.sh up createChannel -c "${CHANNEL_NAME}" -ca
popd >/dev/null

echo "network up, channel '${CHANNEL_NAME}' created."
