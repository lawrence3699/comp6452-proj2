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

export interface BatchHistory {
  readonly batchId: string;
  /** True once a BatchRegistered event has been indexed for this batch. */
  readonly registered: boolean;
  readonly producer?: string;
  readonly registeredAt?: number;
  /** Latest known holder — the producer, or the recipient of the last transfer. */
  readonly currentHolder?: string;
  readonly custodyChain: readonly CustodyStep[];
  readonly flags: readonly FlagRecord[];
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
  let registered = false;
  let producer: string | undefined;
  let registeredAt: number | undefined;
  let currentHolder: string | undefined;

  for (const event of events) {
    switch (event.eventName) {
      case 'BatchRegistered':
        registered = true;
        producer = event.producer;
        registeredAt = event.timestamp;
        currentHolder = event.producer;
        custodyChain.push({
          holder: event.producer,
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
    custodyChain,
    flags,
    events,
    eventCount: events.length,
  };
};
