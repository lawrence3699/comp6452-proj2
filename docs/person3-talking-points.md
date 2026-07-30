# Person 3 (Hu, Zhaoheng) — presentation talking points

Your part = the off-chain layer: **oracle-service, storage, indexer**.
Deliver the English lines; the Chinese notes are for you.

## 1. Intro — "who did what" (one line, ~10s)
> "I'm Zhaoheng. I built the **off-chain layer** — the oracle, the off-chain
> storage adapter, and the event indexer — which cover the off-chain
> computation, off-chain storage and oracle requirements."

## 2. Code walkthrough (your ~3 min) — open `offchain/`

**Framing (say first):**
> "My three components turn raw sensor data into a trustworthy on-chain signal,
> and back into a queryable history. Each one is split into **pure,
> network-free logic — which is unit-tested — and a thin `gateway.ts` adapter**
> that talks to Fabric, so my business logic never needs a running network to
> test."  （中文:先講「純邏輯 vs gateway 分層 + 可單測」這個設計原則。）

**(a) Oracle — `oracle-service/src/index.ts`**
> "The oracle aggregates a window of temperature readings into a summary —
> mean, max, min. I submit the **max** — the worst case — so a brief warm spike
> still triggers the on-chain breach check instead of being averaged away.
> `runOracleCycle` ties it together: aggregate → store the raw series off chain
> → submit the summary anchored by the storage hash."
> "`summarise` is a pure function — here are its unit tests: empty window,
> mixed batches, rounding, sub-zero frozen readings."
（開 `test/summarise.spec.ts` 秀那幾個測試。)

**(b) Storage — `storage/src/index.ts`**
> "Storage is **content-addressed**: an object's id is the SHA-256 of its
> bytes. On read I re-hash and reject anything that doesn't match — so the hash
> we anchor on chain is **tamper-evident**. Only the hash goes on chain; the
> bulky raw data stays off chain."

**(c) Indexer — `indexer/src/index.ts`**
> "The indexer subscribes to chaincode events and builds a per-batch history in
> memory, so traceability queries are fast and don't scan the ledger.
> `parseEvent` decodes each event; `historyFor` returns the ordered history."
> "One nice detail: the automated flag goes through a **nested
> `invokeChaincode`**, and Fabric doesn't deliver events from nested calls — so
> we emit `BatchFlagged` from the **top-level** compliance chaincode, and my
> indexer picks it up."

**Close:**
> "All of this is **29 network-free unit tests**, plus the live demo."

## 3. During the demo (your narration lines)
- Oracle running:
  > "The oracle is aggregating three temperature windows, storing each raw
  > series off chain, and submitting the summaries on chain through an
  > authorised oracle identity."
- Flag appears in the indexer:
  > "Three consecutive breaches — the compliance contract flagged the batch, and
  > my indexer received the event. Notice the `evidenceHash`: that's the SHA-256
  > of the raw temperature series in off-chain storage."

## 4. Q&A prep (likely questions → your answers)
- **How do you stop a fake oracle?** The oracle identity carries an ABAC
  attribute `oracle=true` issued by the Fabric CA; the chaincode rejects anyone
  without it, and every reading is hash-anchored, so submissions are auditable.
- **Why send max, not mean?** Safety-conservative for a cold chain — a short
  warm spike would be averaged away by the mean but still matters; max keeps it.
- **Why store off chain at all?** Raw series / reports / photos are large and
  don't belong on every peer; we keep them off chain and anchor only the hash,
  which is enough for tamper-evidence and confidentiality.
- **What if the indexer restarts?** It replays from block 0 to rebuild the
  history; a production version would persist a checkpoint and resume from it.
- **Is the off-chain data trusted?** No — that's the point of the hash anchor:
  anyone can re-hash the off-chain object and check it against the on-chain
  value, so tampering is detectable.
