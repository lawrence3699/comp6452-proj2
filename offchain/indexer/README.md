# Event indexer — owner: person 3

Subscribes to `batch-registry` chaincode events, persists them to an
append-only JSONL store, and serves batch history over HTTP without touching
the ledger. This is the off-chain read model behind FR2 (traceability query)
and NFR1 (fast query).

## Run

```bash
npm install
npm start          # subscribe + serve
npm run serve      # serve only, from what is already indexed (no network)
npm test           # 57 unit tests, no network
```

## Read API

| Route | Response |
|---|---|
| `GET /health` | `{status, indexedEvents, batches, uptimeSeconds}` |
| `GET /batches` | `{batches: string[]}` |
| `GET /batch/:batchId/history` | assembled history, oldest first; 404 if unknown |

Every response carries `X-Query-Time-Ms` — the served latency, which is the
NFR evidence. A history is a `Map` lookup plus one pass over that batch's rows;
answering the same question from chain means `GetHistoryForKey` and a walk of
every transaction that touched the key.

History body:

```json
{
  "batchId": "BATCH-1",
  "registered": true,
  "producer": "producer1",
  "registeredAt": 1700000001,
  "currentHolder": "warehouse1",
  "custodyChain": [{ "holder": "...", "from": "...", "timestamp": 0,
                     "blockNumber": 0, "transactionId": "..." }],
  "flags": [{ "reason": "...", "evidenceHash": "...", "timestamp": 0,
              "blockNumber": 0, "transactionId": "..." }],
  "events": [],
  "eventCount": 4
}
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `INDEXER_PORT` | `3001` | Read API port |
| `INDEXER_STORE_FILE` | `./.indexer/events.jsonl` | Append-only event log |
| `INDEXER_CHECKPOINT_FILE` | `./.indexer/checkpoint.json` | Resume position |
| `INDEXER_START_BLOCK` | genesis | First block on a fresh run; ignored once checkpointed |
| `INDEXER_STORE` | `jsonl` | `memory` for an ephemeral store |
| `INDEXER_SERVE_ONLY` | unset | Skip the subscription |

Gateway connection settings (`CHANNEL_NAME`, `PEER_ENDPOINT`, `FABRIC_USER`, …)
come from `@comp6452/offchain-shared`.

## Design notes

**JSONL, not SQLite.** SQLite from Node needs a native module, and this project
already lost a day to a native-toolchain failure (the peer's Docker builder
breaking on Docker 29, which is why the chaincode ships as CCaaS). An append-only
file gives durability, crash safety, and an index that is greppable and
diffable; the in-memory `Map<batchId, rows[]>` gives the query speed. `store.ts`
is the single seam if that trade ever needs revisiting.

**Resume, not replay.** `checkpointers.file` records the last processed block
and transaction; passing it as `options.checkpoint` makes the peer resume there
instead of at genesis. Delivery is at-least-once, so the store dedupes on
`(blockNumber, transactionId, eventName)` — the pair is what makes a restart
look exactly-once to a reader.

**Malformed events are skipped, never fatal.** `tryDecodeEvent` turns a bad
payload into a log line and a skip. The checkpoint advances past it too: an
undecodable event will never decode on retry, and leaving the checkpoint behind
it would wedge the listener there forever.
