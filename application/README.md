# Client applications — owner: person 4

Three role-specific clients built on `@hyperledger/fabric-gateway`, each using
its own identity so that the demo shows access control taking effect rather
than one super user doing everything.

| Client | Actions |
|---|---|
| `producer` | Register a batch, attach commercially sensitive details as private data |
| `transporter` | Hand over custody (producer → transporter → warehouse → ...) |
| `regulator` | Flag a batch through coldchain-compliance, query the full traceability history |

The five minute demo must be scripted end to end. Do not type commands live.

## Setup

```bash
cd application
npm install
```

Each client reads its identity and connection details from environment
variables — set these per role before running a command, pointing at
whatever `network/` produces for that identity:

| Variable | Meaning |
|---|---|
| `MSP_ID` | MSP the identity belongs to, e.g. `Org1MSP` |
| `CERT_DIRECTORY_PATH` | Directory containing the identity's signed certificate |
| `KEY_DIRECTORY_PATH` | Directory containing the identity's private key |
| `TLS_CERT_PATH` | Peer's TLS CA certificate |
| `PEER_ENDPOINT` | Peer gRPC address, e.g. `localhost:7051` |
| `PEER_HOST_ALIAS` | TLS server name override for the peer |
| `CHANNEL_NAME` | Defaults to `mychannel` |

The identity behind each identity's certificate must carry the right ABAC
attribute for its role (`role=producer`, `role=transporter`,
`role=regulator`, per `chaincode/batch-registry/src/access.ts`) — that
attribute is what the chaincode actually checks, not which script you ran.

## Running

```bash
npm run producer     -- <batchId> <foodType> <shelfLifeDays> <origin> <quantity> [unitPrice] [inspectionNotes]
npm run transporter  -- <batchId> <toMsp>
npm run regulator    -- flag <batchId> <reason> <evidenceHash>
npm run regulator    -- history <batchId>
```

`npm run build` compiles to `dist/` for a from-source run with plain `node`.
