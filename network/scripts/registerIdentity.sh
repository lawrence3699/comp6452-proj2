#!/usr/bin/env bash
# Registers and enrolls one client identity through an org's Fabric CA, then
# writes an application/-ready env file for it.
#
# Usage: registerIdentity.sh <org> <name> <secret> <attrsCsv> <attrNames>
#   org       1 or 2
#   name      enrollment ID, e.g. producer1
#   secret    enrollment secret, e.g. producer1pw
#   attrsCsv  passed to `register --id.attrs`, e.g. "role=producer:ecert"
#   attrNames passed to `enroll --enrollment.attrs`, e.g. "role"
#
# Registering alone does not put the attribute in the certificate — it must
# also be requested at enrollment via --enrollment.attrs, or access.ts and
# oracleIdentity.ts will see no attribute at all and reject the identity.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

ORG="${1:?usage: registerIdentity.sh <org> <name> <secret> <attrsCsv> <attrNames>}"
NAME="${2:?usage: registerIdentity.sh <org> <name> <secret> <attrsCsv> <attrNames>}"
SECRET="${3:?usage: registerIdentity.sh <org> <name> <secret> <attrsCsv> <attrNames>}"
ATTRS_CSV="${4:?usage: registerIdentity.sh <org> <name> <secret> <attrsCsv> <attrNames>}"
ATTR_NAMES="${5:?usage: registerIdentity.sh <org> <name> <secret> <attrsCsv> <attrNames>}"

case "${ORG}" in
  1) CA_NAME="ca-org1"; CA_PORT=7054; MSP_ID="Org1MSP"; PEER_ENDPOINT="localhost:7051"; PEER_HOST_ALIAS="peer0.org1.example.com" ;;
  2) CA_NAME="ca-org2"; CA_PORT=8054; MSP_ID="Org2MSP"; PEER_ENDPOINT="localhost:9051"; PEER_HOST_ALIAS="peer0.org2.example.com" ;;
  *) echo "org must be 1 or 2" >&2; exit 1 ;;
esac

ORG_DOMAIN="org${ORG}.example.com"
export FABRIC_CA_CLIENT_HOME="${TEST_NETWORK}/organizations/peerOrganizations/${ORG_DOMAIN}"
TLS_CERT="${TEST_NETWORK}/organizations/peerOrganizations/${ORG_DOMAIN}/tlsca/tlsca.${ORG_DOMAIN}-cert.pem"

OUT_DIR="$(cd .. && pwd)/identities"
IDENTITY_DIR="${OUT_DIR}/${NAME}"
mkdir -p "${IDENTITY_DIR}"

echo "== registering ${NAME} on ${CA_NAME} =="
fabric-ca-client register \
  --caname "${CA_NAME}" \
  --id.name "${NAME}" --id.secret "${SECRET}" --id.type client \
  --id.affiliation "org${ORG}.department1" --id.attrs "${ATTRS_CSV}" \
  --tls.certfiles "${TLS_CERT}"

echo "== enrolling ${NAME} =="
fabric-ca-client enroll \
  -u "https://${NAME}:${SECRET}@localhost:${CA_PORT}" \
  --caname "${CA_NAME}" -M "${IDENTITY_DIR}/msp" \
  --tls.certfiles "${TLS_CERT}" \
  --enrollment.attrs "${ATTR_NAMES}"

ENV_FILE="${OUT_DIR}/${NAME}.env"
cat > "${ENV_FILE}" <<EOF
MSP_ID=${MSP_ID}
CERT_DIRECTORY_PATH=${IDENTITY_DIR}/msp/signcerts
KEY_DIRECTORY_PATH=${IDENTITY_DIR}/msp/keystore
TLS_CERT_PATH=${TLS_CERT}
PEER_ENDPOINT=${PEER_ENDPOINT}
PEER_HOST_ALIAS=${PEER_HOST_ALIAS}
CHANNEL_NAME=${CHANNEL_NAME}
EOF

echo "== wrote ${ENV_FILE} =="
