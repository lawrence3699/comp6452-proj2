# COMP6452 Project 2 — Task 3 Presentation Outline

Timing: 2-min intro + design · 5-min demo · 3-min code walkthrough · 5-min Q&A.
Slides needed: design (2–3), implementation (1), demo. Draft content below —
convert to PowerPoint/Google Slides. `[FILL]` marks what only you know.

---

## Slide 1 — Title + who did what

**Blockchain-based cold-chain traceability and automated recall for pasteurised milk**
Hyperledger Fabric proof of concept · COMP6452 26T2 · Team of 4

| Member | zID | Responsibility |
|---|---|---|
| Yan, Chaoliang | z5643222 | `batch-registry` chaincode — state machine, ABAC roles, private data |
| Huang, Neier | z5400040 | `coldchain-compliance` chaincode — breach logic, recall cascade |
| **Hu, Zhaoheng** | z5357529 | **Off-chain oracle, storage adapter, event indexer** |
| Lin, Chi-Hsien | z5620437 | Fabric network, role clients, integration tests |

> Say this up front (marking requires it). Everyone wrote chaincode / oracle /
> tests.

---

## Slide 2 — Problem & why blockchain

- Domain: **pasteurised-milk cold chain** — a concrete product with a chilled
  0–4°C profile, short shelf life, and time-critical contamination recalls.
- Multi-party, low trust: producer → transporter → warehouse → **regulator**.
  No single party should own the record; nobody can quietly rewrite history.
- What blockchain buys us here:
  - Tamper-evident shared custody + temperature-compliance record.
  - **Automated**, rule-based flagging/recall that every party can verify.
  - Access control by cryptographic identity, not by trusting an app server.
- Commercially sensitive fields (unit price, inspection notes) stay **private**
  → Fabric private data collections, not a public chain.

> Blockchain suitability: multi-party + shared state + need for verifiable
> automation + no trusted intermediary → good fit.

---

## Slide 3 — Architecture (component & connector)

```
 Clients (person 4)      producer      transporter      regulator
 fabric-gateway, each        \             |             /
 with its own identity        \            |            /
                               v           v           v
 ┌──────────────────────── Fabric channel: mychannel ─────────────────────┐
 │  batch-registry (P1)                    coldchain-compliance (P2)       │
 │  FR1 register, FR2 custody/trace   <--   FR3 breach detection + recall  │
 │  state machine · ABAC roles        invoke   consumes oracle readings    │
 │  private data collection           FlagBatch  counts 3 breaches -> flag │
 │  emits BatchRegistered/...Flagged/...Recalled                          │
 └───────────▲───────────────────────────────▲───────────────────────────┘
             │ events                          │ SubmitTemperatureReading
             │                                 │ (oracle identity, oracle=true)
   ┌─────────┴─────────┐          ┌────────────┴───────────┐
   │ indexer (P3)      │          │ oracle-service (P3)     │
   │ subscribe events  │          │ aggregate temp windows  │
   │ per-batch history │          │ -> submit signed summary│
   └───────────────────┘          └────────────┬───────────┘
                                                │ store raw series
                                     ┌──────────┴──────────┐
                                     │ storage (P3)        │
                                     │ content-addressed   │
                                     │ SHA-256, hash on-ch │
                                     └─────────────────────┘
```

- Two smart contracts with real business logic (not just storage).
- Off-chain oracle folds in **off-chain computation** (aggregation) and
  **off-chain storage** (raw series), as the spec allows.

---

## Slide 4 — Requirements → design

| Requirement | Where it lives |
|---|---|
| FR1 Register a batch | `batch-registry.RegisterBatch` (producer only, ABAC) |
| FR2 Trace custody & history | custody state machine + events + **indexer** query |
| FR3 Flag a problem batch | oracle → `coldchain-compliance` → 3 breaches → `FlagBatch` |
| FR3 Recall derived batches | `coldchain-compliance` BFS cascade over `derivedFrom` |
| NFR fast traceability query | off-chain **indexer** (events → in-memory index) |
| Confidentiality of price/notes | Fabric **private data collection** |

### Changes after Task 2 feedback  `[FILL — what did the markers say?]`
- e.g. *scoped the domain from "supply chain" to pasteurised milk*
- e.g. *separated FRs from NFRs, rewrote with MUST/SHOULD (RFC 2119)*
- e.g. *moved role from a tx argument to a cryptographic ABAC attribute*
- e.g. *added the alternative design (centralised DB) comparison* `[FILL]`

---

## Slide 5 — Implementation details

- **Platform**: Hyperledger Fabric **2.5.16**, CA-based test-network, one
  channel `mychannel`, two organisations (Org1, Org2).
- **Smart contracts**: TypeScript, `fabric-contract-api`. State machine for
  batch status; **ABAC** (role / oracle attributes issued by Fabric CA);
  **private data collection**; **cross-chaincode invoke** for the flag path.
- **Off-chain (TypeScript)**: `@hyperledger/fabric-gateway`.
  - oracle: window aggregation (mean/max/min), submits worst-case temp.
  - storage: **content-addressed** SHA-256 store; re-hashes on read to detect
    tampering; only the hash is anchored on chain.
  - indexer: chaincode-event listener → per-batch history.
- **Tools**: Node 18, mocha + chai (**60 unit tests, network-free**), ts-node,
  GitHub Actions CI, fabric-samples test-network.
- **Patterns / best practice**: dependency injection for testability (submitter
  & store are injected), pure-logic vs gateway-adapter split, frozen interface
  doc (`docs/interfaces.md`), content-addressing, BFS with visited-set for the
  recall cascade.

---

## Slide 6 — Demo (5 min, scripted — do not type live)

Pre-staged: network up, chaincode deployed, identities registered (sections
3–4 of readme.txt). Three terminals.

1. **Producer registers** a pasteurised-milk batch B1 (chilled profile, 0–4 °C).
2. **Indexer** (terminal 2) is already listening — shows `BatchRegistered`.
3. **Oracle** (terminal 3) replays 3 temperature windows (max 14/16/15.5 °C):
   aggregate → store raw series off chain → submit summary on chain.
4. After the 3rd breach, `coldchain-compliance` **flags B1** via cross-chaincode
   invoke.
5. **Indexer now shows `BatchFlagged`**; `GetBatch B1` → **`status: FLAGGED`**.
6. Punchline: the flag's `evidenceHash` **is** the SHA-256 of the raw series in
   off-chain storage → off-chain computation + storage + oracle + on-chain
   automation, in one trail.

> Have this recorded as a backup in case the live network hiccups.

---

## Slide 7 — Code walkthrough (3 min) + testing

Pick 2–3 highlights; each member speaks to their own code.

- **P3 (you)**: `summarise()` pure aggregation + its unit-test suite; storage
  tamper-detection (re-hash on read); why the oracle sends `maxC`; the
  pure-logic / `gateway.ts` split so tests never touch the network.
- **P1/P2**: deterministic `getTxTimestamp` (not `Date.now()`); ABAC check in
  `access.ts`; consecutive-breach counter; the **top-level `BatchFlagged`
  event** (Fabric doesn't surface events from nested `invokeChaincode`).
- **Testing**: 60 network-free unit tests + a Fabric integration/e2e suite; CI
  runs unit tests on every PR.

---

## Backup slides / Q&A prep

- Why Fabric not Ethereum? Permissioned parties, private data, no gas, ABAC.
- Where's the oracle trust boundary? oracle identity carries `oracle=true`;
  chaincode rejects anyone else; raw series is hash-anchored so it's auditable.
- Cross-chaincode atomicity: both writes commit in one transaction.
- Known limitation: nested-invoke chaincode events aren't delivered → we emit
  `BatchFlagged` from the top-level chaincode. `[good honest point to raise]`
- Alternative design considered: `[FILL — centralised DB / cloud, and why the
  multi-party trust + verifiable automation made blockchain the better fit]`
