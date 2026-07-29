# Demo runbook — Task 3 presentation

Cold-chain traceability: producer registers a batch, the oracle aggregates
temperature readings off chain and submits them, coldchain-compliance flags the
batch after 3 breaches, and the indexer shows the full traceability trail.

Everything below has been verified end to end. **Do a full rehearsal before the
presentation.**

## 0. Prerequisites (once)
- Docker Desktop running (whale icon = running).
- Repo on branch `main`, at `~/Documents/comp6452`.
- Fabric installed; set this in every terminal that runs a network script:
  ```bash
  export FABRIC_SAMPLES_PATH=~/fabric-samples
  ```

## 1. Pre-stage the network (BEFORE the demo slot — takes ~5 min)
Run in one terminal. `down.sh` gives a clean slate (wipes any earlier batch).
```bash
export FABRIC_SAMPLES_PATH=~/fabric-samples
cd ~/Documents/comp6452/network/scripts
./down.sh && ./up.sh && ./deployAll.sh && ./setupDemoIdentities.sh
```
Leaves the network running with the two chaincodes deployed and the demo
identities registered (producer1, transporter1, regulator1, oracle1). No
batches yet — you register one live.

## 2. The live demo (3 terminals, from repo root)
`cd ~/Documents/comp6452` in each terminal first.

### Terminal 1 — producer registers a chilled batch B1
```bash
export $(cat network/identities/producer1.env | xargs)
npm --prefix application run producer -- B1 chilled 14 "Farm A" 500 12 "ok"
```
→ prints `registered batch B1`.

### Terminal 2 — indexer (start it, keep it visible)
```bash
export $(cat network/identities/regulator1.env | xargs)
DEMO_BATCH_ID=B1 npm --prefix offchain/demo run indexer
```
→ every 3s prints B1's history. First shows just `BatchRegistered`.

### Terminal 3 — oracle triggers the flag
```bash
export $(cat network/identities/oracle1.env | xargs)
npm --prefix offchain/demo run oracle
```
→ replays 3 temperature windows (max 14 / 16 / 15.5 °C, all breach chilled
0–4 °C): aggregate → store raw series off chain → submit on chain.

### The payoff
Within ~3s, **Terminal 2 (indexer) now shows 2 events**:
```
B1: 2 event(s)
  BatchRegistered   {"producer":"Org1MSP"}
  BatchFlagged      {"reason":"3 consecutive temperature violations for chilled;
                      expected 0C to 4C, latest reading 15.5C",
                      "evidenceHash":"<sha256>","flaggedBy":"oracle"}
```
Point out: **`evidenceHash` is the SHA-256 of the raw series in off-chain
storage** — off-chain computation + off-chain storage + oracle + on-chain
automation, in one verifiable trail.

## 3. Optional — prove it on chain
In a spare terminal (shows `status: FLAGGED`):
```bash
export FABRIC_SAMPLES_PATH=~/fabric-samples
source network/scripts/lib.sh; setGlobalsForOrg 1
peer chaincode query -C mychannel -n batch-registry \
  -c '{"function":"BatchRegistryContract:GetBatch","Args":["B1"]}'
```

## 4. Tear down (after)
```bash
cd ~/Documents/comp6452/network/scripts && ./down.sh
```

## Notes / gotchas
- Run steps live but keep them scripted — do not improvise commands.
- If B1 is already flagged from a rehearsal, re-run step 1 (`./down.sh` ... )
  for a fresh batch, or register a different id and pass your own readings file:
  `npm --prefix offchain/demo run oracle -- path/to/readings.json`
  (the file's batchId must match, and set DEMO_BATCH_ID for the indexer).
- The oracle identity must be `oracle1` (Org2, enrolled with oracle=true) or the
  chaincode rejects the submission.
- Have a screen recording of a good run as a backup in case the live network hiccups.
