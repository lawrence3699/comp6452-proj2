#!/usr/bin/env bash
#
# Register and enrol the demo identities with Fabric CA.
#
# Roles travel as ABAC attributes on the enrolment certificate, so the chaincode
# reads them with ctx.clientIdentity.getAttributeValue('role'). The ":ecert"
# suffix makes the CA copy the attribute into the certificate by default; the
# --enrollment.attrs flag then requests it at enrolment time. A role asserted
# this way is signed by the CA and cannot be forged by the client, unlike a role
# passed as a transaction argument.
#
# Owner: person 4.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

export FABRIC_CA_CLIENT_HOME="${TEST_NETWORK}/organizations/peerOrganizations/org1.example.com/"
CA_PEM="${TEST_NETWORK}/organizations/fabric-ca/org1/ca-cert.pem"

[ -f "$CA_PEM" ] || fail "org1 CA certificate not found at $CA_PEM — is the network up with -ca?"

registerUser() {
  local name=$1 attrs=$2
  local attrName="${attrs%%=*}"
  local msp="${ORG1_USERS}/${name}@org1.example.com/msp"

  step "registering $name ($attrs)"

  # Idempotent: re-registering an existing id is an error we can safely ignore,
  # which keeps the script re-runnable during development.
  fabric-ca-client register \
    --caname ca-org1 --id.name "$name" --id.secret "${name}pw" \
    --id.type client --id.attrs "$attrs" --tls.certfiles "$CA_PEM" \
    >/dev/null 2>&1 || echo "    (already registered, continuing)"

  fabric-ca-client enroll \
    -u "https://${name}:${name}pw@localhost:7054" --caname ca-org1 \
    -M "$msp" --enrollment.attrs "$attrName" --tls.certfiles "$CA_PEM" \
    >/dev/null 2>&1 || fail "enrolment failed for $name"

  # Without the org's config.yaml the MSP has no OU definitions and the peer
  # rejects the identity as unclassified.
  cp "${TEST_NETWORK}/organizations/peerOrganizations/org1.example.com/msp/config.yaml" \
     "${msp}/config.yaml" 2>/dev/null || true

  echo "    -> ${msp}"
}

registerUser producer1    'role=producer:ecert'
registerUser transporter1 'role=transporter:ecert'
registerUser warehouse1   'role=warehouse:ecert'
registerUser regulator1   'role=regulator:ecert'
registerUser oracle1      'oracle=true:ecert'

step "identities available"
ls -1 "$ORG1_USERS"
