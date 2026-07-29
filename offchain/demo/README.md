# Demo runners — owner: person 3

Thin runners that wire the three off-chain packages to a live Fabric network,
so the whole off-chain flow can be shown end to end. They are run-only (no unit
tests — the logic they call is unit tested in each package).

| Script | What it does |
|---|---|
| `npm run oracle` | Replays reading windows from `sample-readings.json`; for each: aggregate → store raw series off chain → submit summary on chain. Consecutive breaches trip the flag. |
| `npm run indexer` | Subscribes to chaincode events and prints the batch's traceability history live. |

## Prerequisites

The network must be up with both chaincodes deployed and the demo identities
registered (see `network/scripts` and the top-level `readme.txt`). Then export
an identity env file before starting each runner.

```bash
# terminal 1 — oracle (identity oracle1, Org2, enrolled with oracle=true)
export $(cat ../../network/identities/oracle1.env | xargs)
npm install
npm run oracle

# terminal 2 — indexer (any enrolled member, read-only)
export $(cat ../../network/identities/regulator1.env | xargs)
npm run indexer
```

The batch (`B1` in `sample-readings.json`) must already be registered on chain
by the producer client before the oracle runs — otherwise coldchain-compliance
cannot look up its food type. See the demo section of the top-level readme.

Pass a different file to the oracle with `npm run oracle -- path/to/readings.json`.
Point the indexer at a different batch with `DEMO_BATCH_ID=... npm run indexer`.
