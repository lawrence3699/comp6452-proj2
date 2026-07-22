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
