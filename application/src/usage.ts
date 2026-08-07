/**
 * Usage text — owner: person 4.
 *
 * The brief requires that a marker can run these clients without reading the
 * source, so the help output is the interface documentation and is kept here
 * as a pure string rather than scattered through the command modules.
 */

export const USAGE = `
COMP6452 Task 3 — role clients for the food traceability network

  npm run cli -- <role> <command> [options]

Each role signs with its OWN Fabric CA identity, so every access-control
decision below is made by the endorsing peers against a signed certificate
attribute, not by this program.

PRODUCER  (signs as producer1, role=producer)
  producer register [--batch ID] [--food-type chilled|frozen|ambient]
                    [--quantity N] [--shelf-life DAYS] [--origin TEXT]
                    [--unit-price N] [--inspection-notes TEXT]
                    [--derived-from PARENT_BATCH] [--no-private] [--no-report]
      Register a batch. An inspection report is stored off chain and its hash
      anchored on the ledger; commercial fields go in through the transient map
      into the batchPrivateDetails collection.
  producer report --batch ID
      Resolve the anchored report hash back to the document and re-verify it.

TRANSPORTER  (signs as transporter1, role=transporter)
  transporter transfer --batch ID --to Org1MSP|Org2MSP
      Hand custody to another organisation. Only the current holder may.
  transporter log --batch ID [--carrier TEXT] [--location TEXT] [--note TEXT]
      Record an in-transit observation off chain, anchored by content hash.
  transporter show --batch ID
      Read the current public record.
  transporter register [--batch ID]
      Deliberately attempt a producer-only transaction, to show it being
      refused. Expected to fail.

WAREHOUSE  (signs as warehouse1, role=warehouse)
  warehouse deliver --batch ID
      Close out the custody chain: AT_WAREHOUSE -> DELIVERED. Only the current
      holder may, and only from AT_WAREHOUSE.
  warehouse show --batch ID
      Read the current public record.

REGULATOR  (signs as regulator1, role=regulator)
  regulator history --batch ID
      Full traceability read-back: every ledger version of the batch, the
      oracle's temperature readings, and the breach counter.
  regulator holdings [--holder Org1MSP]
      Every batch an organisation currently holds.
  regulator flag --batch ID [--reason TEXT] [--evidence HASH] [--direct]
      Mark a batch as a problem. Routed through coldchain-compliance unless
      --direct sends it straight to batch-registry.
  regulator recall --batch ID [--direct]
      Withdraw a flagged batch. Through compliance the recall cascades to every
      batch derived from this one; --direct recalls only the named batch.

COMMON OPTIONS
  --as NAME          sign as a different enrolled identity (used to demonstrate
                     access control, e.g. --as transporter1 on a producer command)
  --expect-rejection exit 0 when the network refuses the transaction; use for
                     the demo steps that are supposed to be refused
  --help             this text

ENVIRONMENT
  FABRIC_USER          override the signing identity for every command
  FABRIC_TEST_NETWORK  path to fabric-samples/test-network
  CHANNEL_NAME         channel, default mychannel
  PEER_ENDPOINT        gateway peer, default localhost:7051
  OFFCHAIN_STORAGE_ROOT  where off-chain documents are written

The scripted five-minute demo is application/demo.sh — run that rather than
typing commands one at a time.
`.trim();
