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
  summary anchored by the raw-series hash. `representativeTempC()` picks which
  statistic goes on chain (mean by default).
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

## Configuration

The oracle and indexer reach the peer through the Fabric Gateway and are
configured entirely from environment variables (no hard-coded paths). Values
come from the running test network — ask person 4 for the peer endpoint, MSP
id and the crypto material paths.

| Variable | Used by | Example |
|---|---|---|
| `ORACLE_PEER_ENDPOINT` | oracle | `localhost:7051` |
| `ORACLE_PEER_HOST_ALIAS` | oracle | `peer0.org1.example.com` |
| `ORACLE_MSP_ID` | oracle | `Org1MSP` |
| `ORACLE_TLS_ROOT_CERT` | oracle | path to the peer TLS CA cert |
| `ORACLE_CERT` | oracle | path to the oracle identity cert **(must carry the `oracle` attribute)** |
| `ORACLE_KEY` | oracle | path to the oracle identity private key |
| `INDEXER_PEER_ENDPOINT` | indexer | `localhost:7051` |
| `INDEXER_PEER_HOST_ALIAS` | indexer | `peer0.org1.example.com` |
| `INDEXER_MSP_ID` | indexer | `Org1MSP` |
| `INDEXER_TLS_ROOT_CERT` | indexer | path to the peer TLS CA cert |
| `INDEXER_CERT` | indexer | path to a member identity cert (read-only, no attribute needed) |
| `INDEXER_KEY` | indexer | path to that identity's private key |
| `CHANNEL_NAME` | both | defaults to `mychannel` |
| `COMPLIANCE_CHAINCODE` | oracle | defaults to `coldchain-compliance` |

The oracle identity **must** be enrolled with the `oracle` attribute that
`coldchain-compliance`'s `assertOracle` checks, or every submission is rejected.
