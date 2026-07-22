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
