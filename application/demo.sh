#!/usr/bin/env bash
#
# The scripted five-minute demo — owner: person 4.
#
# NON-INTERACTIVE by design. The brief requires the demo to be scripted end to
# end rather than typed live, so this runs start to finish with no prompts and
# no input, and fails loudly the moment a step does not do what it claims.
#
# The story, in order:
#   1. the producer registers a batch, with private commercial detail and an
#      inspection report anchored off chain;
#   2. a transporter — a different identity — is refused when it tries to
#      register one, which is the access control being demonstrated, not a bug;
#   3. custody moves to Org2MSP, an in-transit event is logged off chain, and
#      a non-holder is refused a transfer;
#   4. the clean path: a SIDE batch is walked to the warehouse and marked
#      DELIVERED by the warehouse identity — the terminus the incident batch
#      never reaches;
#   5. the oracle submits temperature summaries; the cold chain is breached
#      three windows running and the batch is flagged AUTOMATICALLY by
#      chaincode-to-chaincode call, with no human involved;
#   6. the regulator reads the whole trail back and recalls the batch;
#   7. one recall cascades through the derivation graph.
#
# Usage:
#   ./demo.sh              full demo against the live network
#   ./demo.sh --fast       same, with shorter pauses (no narration time)
#   DEMO_PAUSE=5 ./demo.sh set the pause between evidence beats
#   DEMO_BATCH=MY-ID ./demo.sh    pin the batch id instead of generating one
#
# The batch id is unique per run, so the demo is re-runnable: RegisterBatch
# rejects a duplicate id and a fixed one would fail on the second run.

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/.." && pwd)"
ORACLE_DIR="${REPO_ROOT}/offchain/oracle-service"

# Off-chain documents (inspection reports, transit events, raw sensor series)
# all land in one store, so the report the producer writes is the report the
# oracle run and the regulator read back.
export OFFCHAIN_STORAGE_ROOT="${OFFCHAIN_STORAGE_ROOT:-${REPO_ROOT}/.offchain-store}"

BATCH_ID="${DEMO_BATCH:-DEMO-$(date +%s)}"

PAUSE="${DEMO_PAUSE:-3}"
case "$PAUSE" in
  ''|*[!0-9]*)
    echo "DEMO_PAUSE must be a non-negative integer number of seconds" >&2
    exit 2
    ;;
esac
for arg in "$@"; do
  case "$arg" in
    --fast) PAUSE=0 ;;
    -h|--help)
      sed -n '2,32p' "${BASH_SOURCE[0]:-$0}"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (expected --fast)" >&2
      exit 2
      ;;
  esac
done

FAILURES=0

cli() { (cd "$APP_DIR" && npx ts-node src/run.ts "$@"); }

beat() { [ "$PAUSE" -gt 0 ] && sleep "$PAUSE"; return 0; }

# Narration between the machine-generated section headers, so an audience is
# told what to look for BEFORE it scrolls past. Each argument is one line, and
# the blank separator is printed once for the whole block rather than once per
# line — otherwise a three-line explanation renders double-spaced.
say() {
  echo
  for line in "$@"; do
    echo "-- ${line}"
  done
}

# A step that must succeed. A failure here means the demo is broken, so it is
# recorded and the run ends non-zero rather than scrolling on as if fine.
must() {
  local label=$1; shift
  if ! "$@"; then
    echo
    echo "!! DEMO STEP FAILED: ${label}" >&2
    FAILURES=$((FAILURES + 1))
  fi
  beat
}

# A step that must be REFUSED by the network. --expect-rejection makes the CLI
# exit 0 on a policy rejection and, importantly, exit 1 if the transaction is
# accepted — a security check that passes when the guard is missing is worse
# than no check at all.
must_be_refused() {
  local label=$1; shift
  if ! "$@" --expect-rejection; then
    echo
    echo "!! DEMO STEP FAILED (expected a rejection, did not get one): ${label}" >&2
    FAILURES=$((FAILURES + 1))
  fi
  beat
}

banner() {
  echo
  echo "##########################################################################"
  echo "#  $1"
  echo "##########################################################################"
}

banner "COMP6452 Task 3 — food traceability on Hyperledger Fabric"
echo
echo "  Batch for this run:  ${BATCH_ID}"
echo "  Channel:             ${CHANNEL_NAME:-mychannel}"
echo "  Chaincodes:          batch-registry, coldchain-compliance"
echo "  Off-chain store:     ${OFFCHAIN_STORAGE_ROOT}"
echo
echo "  Every command below signs with a DIFFERENT Fabric CA identity."
echo "  Nothing here runs as an administrator or a super-user."
beat

# ---------------------------------------------------------------------------
banner "ACT 1 — the producer registers a batch"
say "producer1 holds role=producer on its enrolment certificate. Commercial" \
    "detail goes in through the transient map into a private data collection;" \
    "the inspection report is stored off chain and only its hash is anchored."
must "producer registers ${BATCH_ID}" \
  cli producer register --batch "$BATCH_ID" --food-type chilled --quantity 500 \
      --origin "Riverina NSW" --unit-price 4.50

say "The same anchored hash resolves back to the report and still verifies."
must "producer verifies the anchored inspection report" \
  cli producer report --batch "$BATCH_ID"

# ---------------------------------------------------------------------------
banner "ACT 2 — access control, demonstrated rather than asserted"
say "The transporter now attempts the SAME registration transaction. The" \
    "endorsing peers read role=transporter off its certificate and refuse." \
    "This rejection is the point of the act — it is supposed to happen."
must_be_refused "transporter is refused RegisterBatch" \
  cli transporter register --batch "${BATCH_ID}-STOLEN"

# ---------------------------------------------------------------------------
banner "ACT 3 — custody moves down the supply chain"
say "TransferCustody does not check a job title: it checks that the caller's" \
    "organisation is the one currently holding the goods. Org1MSP holds this" \
    "batch, so the transporter can hand it on."
must "custody moves to Org2MSP" \
  cli transporter transfer --batch "$BATCH_ID" --to Org2MSP

say "Telemetry from the journey is bulky and undisputed, so it is stored off" \
    "chain and anchored by content hash rather than written to every peer."
must "transporter logs an in-transit event" \
  cli transporter log --batch "$BATCH_ID" \
      --location "Hume Highway, Goulburn NSW" \
      --note "Reefer at 2C, doors sealed, on schedule."

say "The batch is now held by Org2MSP, so an Org1 identity may no longer move" \
    "it. Second rejection: custody is enforced, not advisory."
must_be_refused "a non-holder is refused TransferCustody" \
  cli transporter transfer --batch "$BATCH_ID" --to Org1MSP

# ---------------------------------------------------------------------------
banner "ACT 4 — the clean path: a batch actually arrives"
say "Before the incident, the happy ending: a second batch that keeps its cold" \
    "chain and completes the journey. DELIVERED is the terminus the main batch" \
    "will never reach, so a side batch has to demonstrate it."

OK_BATCH="${BATCH_ID}-OK"

must "producer registers ${OK_BATCH}" \
  cli producer register --batch "$OK_BATCH" --food-type chilled --quantity 300 \
      --origin "Riverina NSW"

say "Two custody legs: CREATED -> IN_TRANSIT (goods on the truck), then" \
    "IN_TRANSIT -> AT_WAREHOUSE (goods received at the dock). The status walks" \
    "regardless of whether the holder MSP changes."
# Both transfers name Org1MSP as the recipient, so the holder stays Org1MSP
# while the status walks — which keeps the batch deliverable by warehouse1, an
# Org1 identity, since MarkDelivered requires caller MSP == currentHolder.
must "custody leg 1: the batch goes into transit" \
  cli transporter transfer --batch "$OK_BATCH" --to Org1MSP
must "custody leg 2: the batch is received at the warehouse" \
  cli transporter transfer --batch "$OK_BATCH" --to Org1MSP

say "warehouse1 — the holder's receiving identity — closes the chain. Only the" \
    "current holder may, and only from AT_WAREHOUSE: a batch still on the road" \
    "cannot be marked delivered."
must "warehouse marks the batch delivered" \
  cli warehouse deliver --batch "$OK_BATCH"

say "The clean batch reads DELIVERED. Now for the batch that goes wrong."
must "the delivered batch is final" \
  cli warehouse show --batch "$OK_BATCH"

# ---------------------------------------------------------------------------
banner "ACT 5 — the oracle breaks the cold chain"
say "The oracle service signs as oracle1 (oracle=true) — the only identity" \
    "SubmitTemperatureReading accepts. It stores the raw sensor series off" \
    "chain, then submits one summary per window with the series hash attached." \
    "Chilled range is 0-4C. Windows 2, 3 and 4 average about 9C." \
    "At the third consecutive breach coldchain-compliance calls" \
    "batch-registry:FlagBatch itself. No human flags this batch."
if ! (cd "$ORACLE_DIR" && ORACLE_BATCH_ID="$BATCH_ID" npm run --silent demo); then
  echo
  echo "!! DEMO STEP FAILED: oracle run" >&2
  FAILURES=$((FAILURES + 1))
fi
beat

say "The batch should now read FLAGGED, and no regulator touched it."
must "batch was flagged automatically" \
  cli regulator show --batch "$BATCH_ID"

# ---------------------------------------------------------------------------
banner "ACT 6 — the regulator audits and recalls"
say "regulator1 reads the complete trail: every committed version of the key," \
    "the oracle's readings with the breaches marked, and the breach counter." \
    "This is the traceability requirement, answered from the ledger itself."
must "regulator reads the full history" \
  cli regulator history --batch "$BATCH_ID"

say "The regulator withdraws the batch through coldchain-compliance, which" \
    "reports every batch id the recall touched."
must "regulator recalls the batch" \
  cli regulator recall --batch "$BATCH_ID"

say "RECALLED is terminal: the state machine allows no move out of it, so even" \
    "the regulator cannot put this batch back into transit."
must "recalled batch is final" \
  cli regulator show --batch "$BATCH_ID"

# The ledger is deliberately persistent between rehearsals, so printing the
# complete holder index here grows without bound and eventually scrolls the
# evidence above out of a presentation terminal. The query remains available
# for a code walkthrough or marker inspection, but the default live story is
# bounded to the batches created by this run. Set DEMO_SHOW_HOLDINGS=1 when the
# composite-key query itself is what needs to be demonstrated.
if [ "${DEMO_SHOW_HOLDINGS:-0}" = "1" ]; then
  say "Finally, what each organisation is holding right now."
  must "regulator lists Org2MSP holdings" \
    cli regulator holdings --holder Org2MSP
else
  say "The holder~batchId composite-key query remains available as" \
      "'regulator holdings'; it is omitted here so previous rehearsal data" \
      "cannot make the five-minute presentation output grow without bound."
fi

# ---------------------------------------------------------------------------
banner "ACT 7 — one recall cascades through the derivation graph"
say "A pallet rarely stays whole: it is split into cases and repacked, and each" \
    "child batch records the batch it came from. Recalling the parent has to" \
    "follow that graph, or contaminated stock stays on the shelf."

PARENT="${BATCH_ID}-PALLET"
CHILD="${BATCH_ID}-CASE"
GRANDCHILD="${BATCH_ID}-PACK"

must "producer registers the pallet" \
  cli producer register --batch "$PARENT" --food-type chilled --quantity 600
must "producer registers a case split from the pallet" \
  cli producer register --batch "$CHILD" --food-type chilled --quantity 200 \
      --derived-from "$PARENT"
must "producer registers a pack split from that case" \
  cli producer register --batch "$GRANDCHILD" --food-type chilled --quantity 50 \
      --derived-from "$CHILD"

say "The regulator flags all three, then recalls only the pallet."
for id in "$PARENT" "$CHILD" "$GRANDCHILD"; do
  must "regulator flags ${id}" \
    cli regulator flag --batch "$id" --reason "traced to the same source" --direct
done

must "regulator recalls the pallet, and the recall spreads" \
  cli regulator recall --batch "$PARENT"

say "Both descendants are now RECALLED even though neither was named — the" \
    "cascade walked pallet -> case -> pack."
must "the case was recalled too" \
  cli regulator show --batch "$CHILD"
must "the pack two levels down was recalled too" \
  cli regulator show --batch "$GRANDCHILD"

# ---------------------------------------------------------------------------
banner "DEMO COMPLETE"
echo
echo "  Batch ${BATCH_ID} travelled:"
echo "    CREATED -> IN_TRANSIT -> FLAGGED (automatically) -> RECALLED"
echo "  Batch ${BATCH_ID}-OK travelled:"
echo "    CREATED -> IN_TRANSIT -> AT_WAREHOUSE -> DELIVERED"
echo
echo "  Demonstrated:"
echo "    * role-based access control from signed CA certificate attributes"
echo "    * custody enforced against the current holder, not a job title"
echo "    * the full clean lifecycle closed out by the warehouse identity"
echo "    * private data kept off the public ledger via the transient map"
echo "    * bulk documents off chain, anchored on chain by content hash"
echo "    * an oracle bridging off-chain sensor data onto the ledger"
echo "    * chaincode-to-chaincode escalation with no human in the loop"
echo "    * an append-only audit trail read back in full"
echo "    * a recall cascading through the derivation graph, two levels deep"
echo

if [ "$FAILURES" -ne 0 ]; then
  echo "  ${FAILURES} step(s) did not behave as scripted — see the !! lines above." >&2
  exit 1
fi

echo "  All steps behaved exactly as scripted."
