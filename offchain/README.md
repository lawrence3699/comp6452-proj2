# Off-chain components — owner: person 3

Three services. Together they satisfy three of the Task 3 requirements at
once: off-chain computation, off-chain storage, and the oracle. The
specification allows the off-chain computation and storage components to be
folded into the oracle, so keep them here rather than inventing a fourth
service.

| Directory | Role |
|---|---|
| `oracle-service/` | Polls temperature readings, aggregates them, submits a signed summary on chain |
| `storage/` | Stores inspection reports and photographs, returns the hash anchored on chain |
| `indexer/` | Listens to chaincode events, persists them, serves fast batch history queries |

## Design

Each package splits into pure, network-free logic (unit tested) and a thin
`gateway.ts` adapter that talks to Fabric. `submit()` and `listen()` import
their gateway lazily, so the unit tests never load `fabric-gateway`.

- `oracle-service` — `summarise()` aggregates a window into mean/max/min;
  `runOracleCycle()` aggregates, stores the raw series, then submits the
  summary anchored by the raw-series hash. `representativeTempC()` sends the
  window's worst-case reading (max) so a warm spike still drives flagging.
- `storage` — content-addressed: an object's id is the SHA-256 of its bytes;
  `get()` re-hashes on read and rejects a tampered or missing object.
- `indexer` — `parseEvent()` decodes the three chaincode events; an in-memory
  index serves time-ordered per-batch history via `historyFor()`.

## Testing

No network required — each package is standalone:

```bash
cd oracle-service && npm install && npm test   # aggregation + submit mapping
cd storage        && npm install && npm test   # hashing + tamper detection
cd indexer        && npm install && npm test   # event parsing + query
```

## Running against the network (demo)

The oracle and indexer reach the peer through the Fabric Gateway, configured
from the same `RoleConfig` environment shape person 4's network emits per
identity under `network/identities/<name>.env`. So each runner starts straight
off an identity env file — no hand-editing:

```bash
# terminal 1 — oracle: replays readings, aggregates, stores, submits on chain.
# MUST be oracle1 (Org2, enrolled with oracle=true).
export $(cat network/identities/oracle1.env | xargs)
cd offchain/demo && npm install && npm run oracle

# terminal 2 — indexer: subscribes to events, prints batch history live.
# Any enrolled member identity works (read-only).
export $(cat network/identities/regulator1.env | xargs)
cd offchain/demo && npm run indexer
```

The runners live in `offchain/demo/` (see [demo/README.md](demo/README.md)).

| Variable | Meaning |
|---|---|
| `MSP_ID` | organisation MSP id, e.g. `Org2MSP` |
| `CERT_DIRECTORY_PATH` | directory holding the identity's signing certificate |
| `KEY_DIRECTORY_PATH` | directory holding the identity's private key |
| `TLS_CERT_PATH` | peer TLS CA certificate |
| `PEER_ENDPOINT` | e.g. `localhost:9051` |
| `PEER_HOST_ALIAS` | e.g. `peer0.org2.example.com` |
| `CHANNEL_NAME` | defaults to `mychannel` |
| `COMPLIANCE_CHAINCODE` | oracle only; defaults to `coldchain-compliance` |

The oracle identity **must** be enrolled with `oracle=true` — the exact value
`coldchain-compliance`'s `assertOracle` checks — or every submission is
rejected. Person 4's `setupDemoIdentities.sh` issues `oracle1` in **Org2** with
that attribute. The indexer only reads events, so any enrolled member works.
