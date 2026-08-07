# Frozen interfaces

Agreed in the Day 1 kick-off. Any change must be announced to the whole team
before it is merged, because all four workstreams depend on these shapes.

## 1. Batch model and status (owner: person 1)

```ts
export enum BatchStatus {
  Created     = 'CREATED',
  InTransit   = 'IN_TRANSIT',
  AtWarehouse = 'AT_WAREHOUSE',
  Delivered   = 'DELIVERED',
  Flagged     = 'FLAGGED',
  Recalled    = 'RECALLED',
}

export interface Batch {
  batchId: string;
  foodType: string;
  producedAt: number;      // unix seconds
  shelfLifeDays: number;
  origin: string;
  quantity: number;
  status: BatchStatus;
  currentHolder: string;   // MSP id of the organisation holding the batch
  reportHash: string;      // anchor for the off-chain inspection report
}
```

## 2. Chaincode events (emitted by persons 1 and 2, consumed by person 3)

| Event | Payload |
|---|---|
| `BatchRegistered` | `{ batchId, producer, timestamp }` |
| `CustodyTransferred` | `{ batchId, from, to, timestamp }` |
| `BatchFlagged` | `{ batchId, reason, evidenceHash, timestamp }` |

## 3. Cross-chaincode call (called by person 2, implemented by person 1)

```ts
FlagBatch(batchId: string, reason: string, evidenceHash: string): Promise<void>
```

Invoked with `ctx.stub.invokeChaincode('batch-registry', [...], 'mychannel')`.
Because both chaincodes live on the same channel, the callee's write set is
committed as part of the caller's transaction.

## 4. Oracle entry point (called by person 3, implemented by person 2)

```ts
SubmitTemperatureReading(
  batchId: string,
  tempC: number,
  observedAt: number,   // unix seconds
  rawDataHash: string,  // anchor for the raw reading series held off-chain
): Promise<void>
```

Only identities on the oracle allow-list may call this.

## Amendment — 2026-07-26 (announced to all workstreams)

Announced per the change rule above; all four workstreams have been notified.
The Day 1 sections are unchanged — this section extends them.

### A. New transaction: `MarkDelivered` (owner: person 1)

```ts
MarkDelivered(batchId: string): Promise<void>
```

Holder-gated: the caller's MSP must equal `batch.currentHolder` (same
semantics as `TransferCustody` — no role attribute needed). Legal only for
`AT_WAREHOUSE -> DELIVERED`; any other source status is rejected by the state
machine. Emits `BatchDelivered` (see below).

Rationale: the delivery step was declared in the state machine but unreachable
— no transaction could ever produce a `DELIVERED` batch.

### B. Chaincode events — full table (now 7 rows)

The original three rows are unchanged. Four rows are added:

| Event | Payload |
|---|---|
| `BatchRegistered` | `{ batchId, producer, timestamp }` |
| `CustodyTransferred` | `{ batchId, from, to, timestamp }` |
| `BatchFlagged` | `{ batchId, reason, evidenceHash, timestamp }` |
| `BatchDelivered` | `{ batchId, holder, timestamp }` |
| `BatchRecalled` | `{ batchId, timestamp }` |
| `ComplianceBreach` | `{ batchId, consecutive, tempC, rawDataHash, timestamp }` |
| `RecallCascaded` | `{ root, recalled, timestamp }` |

`ComplianceBreach` and `RecallCascaded` are emitted by `coldchain-compliance`
(person 2), not `batch-registry`; the indexer (person 3) now subscribes to
both chaincodes. All timestamps are unix seconds from `getTxTimestamp`.

For the record: `BatchFlagged` has always carried one extra field the Day 1
table omitted — `flaggedBy: 'regulator' | 'oracle'`, distinguishing a human
decision from the automated cross-chaincode path. Consumers that only read
the tabled fields are unaffected; the indexer ignores fields it does not know.

Rationale: recalls were invisible off-chain — the indexer only saw the
registry stream, so consumers could not learn a batch had been recalled.

### C. `SubmitTemperatureReading`: `rawDataHash` validated on-chain

`rawDataHash` must now match `/^[0-9a-f]{64}$/` — a 64-character lowercase
hex SHA-256 digest. Non-conforming values are rejected on-chain with an error
naming `rawDataHash`.

Rationale: a malformed anchor is unverifiable evidence — a hash that cannot
be recomputed against the off-chain series anchors nothing.
