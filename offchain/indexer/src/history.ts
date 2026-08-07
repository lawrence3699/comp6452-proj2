/**
 * History assembly — owner: person 3.
 *
 * Turns the flat event rows into the answer a traceability user actually
 * asks: who has held this batch, in order, and has anything been flagged.
 * Pure over an array of events, so the tests fabricate the array and no store
 * or network is involved.
 *
 * This is the off-chain read model. Reconstructing the same answer from the
 * ledger means `GetHistoryForKey` plus a walk of every transaction that
 * touched the key; here it is a hash lookup and a linear pass over a handful
 * of rows, which is the NFR the HTTP API exists to demonstrate.
 */

import { IndexedEvent } from './events';

/** One step of the custody chain, in the order custody actually moved. */
export interface CustodyStep {
  readonly holder: string;
  /** Who handed the batch over; undefined for the producer, who originated it. */
  readonly from?: string;
  /**
   * What happened at this step. `held` is a plain custody move (registration
   * or transfer); `delivered` and `recalled` are terminal lifecycle marks that
   * belong in the chain because they answer the same question the chain
   * exists for — where the batch ended up.
   */
  readonly kind: 'held' | 'delivered' | 'recalled';
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly transactionId: string;
}

export interface FlagRecord {
  readonly reason: string;
  readonly evidenceHash: string;
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly transactionId: string;
}

/** One threshold trip from the compliance chaincode, ledger-anchored. */
export interface BreachRecord {
  readonly consecutive: number;
  readonly tempC: number;
  readonly rawDataHash: string;
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly transactionId: string;
}

/**
 * A recall cascade rooted at this batch. Appears only in the ROOT batch's
 * history (the decoder files RecallCascaded under `root`). Note the derived
 * batches get NO event of their own from the cascade path: Fabric commits
 * only the outermost chaincode's events, so the BatchRecalled that
 * batch-registry sets under invokeChaincode is dropped. `recalled` here is
 * therefore the only off-chain record of the blast radius; a per-batch
 * BatchRecalled row appears only when a regulator recalls that batch
 * directly (the client's --direct path).
 */
export interface RecallCascade {
  /** Every batch id the cascade recalled — the blast radius. */
  readonly recalled: readonly string[];
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly transactionId: string;
}

export interface BatchHistory {
  readonly batchId: string;
  /** True once a BatchRegistered event has been indexed for this batch. */
  readonly registered: boolean;
  readonly producer?: string;
  readonly registeredAt?: number;
  /** Latest known holder — the producer, or the recipient of the last transfer. */
  readonly currentHolder?: string;
  /** True once a BatchDelivered event has been indexed. */
  readonly delivered: boolean;
  /** True once a BatchRecalled event (or a cascade rooted here) has been indexed. */
  readonly recalled: boolean;
  readonly custodyChain: readonly CustodyStep[];
  readonly flags: readonly FlagRecord[];
  readonly breaches: readonly BreachRecord[];
  readonly recallCascades: readonly RecallCascade[];
  /** Every raw event, oldest first. The custody chain is a projection of this. */
  readonly events: readonly IndexedEvent[];
  readonly eventCount: number;
}

/**
 * Assemble the read model. `events` must already be in ledger order — the
 * store sorts on read, so this stays a single pass and the caller keeps one
 * definition of "oldest first" rather than two that can drift.
 *
 * A gap in the chain is represented, not repaired: if a transfer arrives whose
 * `from` is not the holder we believe in (a missed event, or an out-of-order
 * delivery), the step is still recorded with its stated `from`. Silently
 * rewriting it would make the index disagree with the ledger, and the ledger
 * is the thing being audited.
 */
export const assembleHistory = (
  batchId: string,
  events: readonly IndexedEvent[],
): BatchHistory => {
  const custodyChain: CustodyStep[] = [];
  const flags: FlagRecord[] = [];
  const breaches: BreachRecord[] = [];
  const recallCascades: RecallCascade[] = [];
  let registered = false;
  let producer: string | undefined;
  let registeredAt: number | undefined;
  let currentHolder: string | undefined;
  let delivered = false;
  let recalled = false;

  for (const event of events) {
    switch (event.eventName) {
      case 'BatchRegistered':
        registered = true;
        producer = event.producer;
        registeredAt = event.timestamp;
        currentHolder = event.producer;
        custodyChain.push({
          holder: event.producer,
          kind: 'held',
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
      case 'CustodyTransferred':
        currentHolder = event.to;
        custodyChain.push({
          holder: event.to,
          from: event.from,
          kind: 'held',
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
      case 'BatchFlagged':
        flags.push({
          reason: event.reason,
          evidenceHash: event.evidenceHash,
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
      case 'BatchDelivered':
        // A lifecycle step, not just a boolean: delivery ends the custody
        // story, so it belongs in the chain in the position it happened. The
        // event's `holder` is the MSP that completed the delivery, which is
        // also our best knowledge of who holds the goods now.
        delivered = true;
        currentHolder = event.holder;
        custodyChain.push({
          holder: event.holder,
          kind: 'delivered',
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
      case 'BatchRecalled':
        // The recall carries no holder; whoever held the batch still holds
        // the (now recalled) goods, so the step repeats the current holder
        // rather than inventing one. An unknown holder — listener started
        // mid-chain — is represented as such, same policy as a gap in the
        // transfer chain.
        recalled = true;
        custodyChain.push({
          holder: currentHolder ?? 'unknown',
          kind: 'recalled',
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
      case 'ComplianceBreach':
        breaches.push({
          consecutive: event.consecutive,
          tempC: event.tempC,
          rawDataHash: event.rawDataHash,
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
      case 'RecallCascaded':
        // Filed under the root batch only (the decoder maps `root` to
        // batchId). Not a custody step: this row carries the blast radius,
        // and — because Fabric drops events set under invokeChaincode — it is
        // the only event the cascade produces at all (see RecallCascade doc).
        recalled = true;
        recallCascades.push({
          recalled: event.recalled,
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
          transactionId: event.transactionId,
        });
        break;
    }
  }

  // Optional properties are added conditionally rather than set to undefined:
  // with exactOptionalPropertyTypes-style discipline, `{producer: undefined}`
  // and `{}` serialise differently over HTTP and the absent form is the honest
  // one for "we have never seen a registration".
  return {
    batchId,
    registered,
    ...(producer !== undefined ? { producer } : {}),
    ...(registeredAt !== undefined ? { registeredAt } : {}),
    ...(currentHolder !== undefined ? { currentHolder } : {}),
    delivered,
    recalled,
    custodyChain,
    flags,
    breaches,
    recallCascades,
    events,
    eventCount: events.length,
  };
};
