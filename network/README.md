# Network — owner: person 4

Holds the scripts that bring up the Fabric test network, create the channel
and drive the chaincode lifecycle.

Priority for days 1 and 2: get two *empty* chaincodes through the full
package / install / approve / commit lifecycle. Do not wait for business
logic — the lifecycle is the risky part, not the code.

`collections_config.json` defines the private data collection that holds
commercially sensitive batch details. It is referenced at commit time with
`--collections-config`.

## Prerequisites

These scripts wrap the standard `fabric-samples` test-network rather than
reimplementing crypto/genesis generation from scratch. Requires Docker,
Docker Compose, and a POSIX shell (WSL2 or Linux/macOS — the Fabric sample
scripts are bash and do not run under plain PowerShell/cmd).

```bash
# One-time: fetch Fabric binaries, docker images and fabric-samples itself.
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh docker samples binary

export FABRIC_SAMPLES_PATH=~/fabric-samples   # wherever the above put it
```

Every script here reads `FABRIC_SAMPLES_PATH` (via `scripts/lib.sh`) — set it
once per shell before running any of them.

## Usage

```bash
cd network/scripts

./up.sh                    # start the CA-based test-network, create the channel
./deployAll.sh              # build and deploy both chaincodes
./setupDemoIdentities.sh    # register producer1, transporter1, regulator1, oracle1

./down.sh                   # tear down and wipe generated crypto material
```

The network is CA-based (`network.sh up createChannel -ca`), not the default
cryptogen topology, because the ABAC `role`/`oracle` attributes that
`chaincode/batch-registry/src/access.ts` and
`chaincode/coldchain-compliance/src/oracleIdentity.ts` check must come from a
Fabric CA at enrollment time.

`setupDemoIdentities.sh` writes one env file per identity under
`network/identities/<name>.env` (gitignored — it contains key material paths,
regenerated every time the network comes up). Each file matches the
`RoleConfig` shape `application/src/connect.ts` and
`test/integration/src/connect.ts` expect:

```
MSP_ID=Org1MSP
CERT_DIRECTORY_PATH=.../identities/producer1/msp/signcerts
KEY_DIRECTORY_PATH=.../identities/producer1/msp/keystore
TLS_CERT_PATH=.../tlsca/tlsca.org1.example.com-cert.pem
PEER_ENDPOINT=localhost:7051
PEER_HOST_ALIAS=peer0.org1.example.com
CHANNEL_NAME=mychannel
```

To run a client as, say, the producer:

```bash
export $(cat network/identities/producer1.env | xargs)
cd application && npm run producer -- B1 pasteurised-milk 14 "Dairy A" 500
```

To register a different identity or role, call `registerIdentity.sh`
directly — see its header comment for the argument list.
