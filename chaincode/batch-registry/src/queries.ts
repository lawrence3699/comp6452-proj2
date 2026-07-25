import { Context, Contract } from 'fabric-contract-api';
import { Batch } from './batch';

/**
 * FR2 traceability queries. Read-only, kept in its own file so that person 4
 * and person 1 never edit the same file.
 * Owner: person 4.
 */

/** Shape of each entry returned by GetBatchHistory. */
interface HistoryEntry {
  txId: string;
  /** Wall-clock time of the transaction in ISO 8601 format. */
  timestamp: string;
  isDelete: boolean;
  /** Null when this record is a deletion tombstone or carries an empty value. */
  value: Batch | null;
}

/**
 * Convert a protobuf Timestamp to an ISO 8601 string.
 *
 * The shim serialises the seconds field as a long.js Long object.  We avoid
 * importing the long package by checking for the .toNumber() method at
 * runtime, falling back to Number() coercion for plain numeric values.
 * any is justified here: the Timestamp type comes from fabric-shim-api and
 * carries a long.js Long for seconds, which is not in our direct dependency
 * graph; typing it as any avoids pulling in @types/long.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const timestampToIso = (ts: any): string => {
  const secs: number =
    typeof ts?.seconds?.toNumber === 'function'
      ? (ts.seconds.toNumber() as number)
      : Number(ts?.seconds ?? 0);
  // nanos is sub-second precision; convert to milliseconds for Date.
  const ms = secs * 1000 + Math.floor((ts?.nanos ?? 0) / 1_000_000);
  return new Date(ms).toISOString();
};

export class BatchQueryContract extends Contract {
  /**
   * Return the full custody history for a batch, oldest-first.
   *
   * Fabric's getHistoryForKey guarantees chronological order.
   * The iterator is always closed in the finally block to avoid resource leaks,
   * even if processing throws.
   *
   * @returns JSON-serialised HistoryEntry[]
   */
  public async GetBatchHistory(ctx: Context, batchId: string): Promise<string> {
    if (!batchId) {
      throw new Error('GetBatchHistory: batchId is required');
    }

    const iterator = await ctx.stub.getHistoryForKey(batchId);
    const entries: HistoryEntry[] = [];

    try {
      // Use the CommonIterator<KeyModification> interface directly rather than
      // for-await-of, which would require the iterator to also be AsyncIterable.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          break;
        }
        const km = result.value;
        // A deletion tombstone carries isDelete=true and an empty value buffer.
        const hasValue = !km.isDelete && km.value != null && km.value.length > 0;
        entries.push({
          txId: km.txId,
          timestamp: timestampToIso(km.timestamp),
          isDelete: km.isDelete,
          value: hasValue
            ? (JSON.parse(Buffer.from(km.value).toString('utf8')) as Batch)
            : null,
        });
      }
    } finally {
      // Must close to release the underlying gRPC stream on the peer.
      await iterator.close();
    }

    // getHistoryForKey returned newest-first when verified against a live peer,
    // so sort explicitly rather than relying on the iterator's order. Ties are
    // broken by ledger order, which the stable sort preserves.
    entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    return JSON.stringify(entries);
  }

  /**
   * Return all batches currently held by a given MSP.
   *
   * Person 1 maintains a 'holder~batchId' composite-key index with attributes
   * [holderMsp, batchId].  A partial-key query on [holderMsp] returns every
   * index entry for that holder; we split each composite key to recover the
   * batchId, then fetch the authoritative batch state from the ledger.
   *
   * @returns JSON-serialised Batch[]
   */
  public async GetBatchesByHolder(ctx: Context, holderMsp: string): Promise<string> {
    if (!holderMsp) {
      throw new Error('GetBatchesByHolder: holderMsp is required');
    }

    const iterator = await ctx.stub.getStateByPartialCompositeKey('holder~batchId', [holderMsp]);
    const batches: Batch[] = [];

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          break;
        }
        const kv = result.value;

        // Split the composite key to recover attributes [holderMsp, batchId].
        const split = ctx.stub.splitCompositeKey(kv.key);
        const batchId = split.attributes[1];
        if (!batchId) {
          // Malformed index entry — skip rather than throw to stay non-halting.
          continue;
        }

        // The composite key is an index sentinel; the canonical batch state is
        // stored under the plain batchId key by BatchRegistryContract.
        const raw = await ctx.stub.getState(batchId);
        if (!raw || raw.length === 0) {
          // Index entry exists but the batch has been deleted; skip it.
          continue;
        }

        batches.push(JSON.parse(Buffer.from(raw).toString('utf8')) as Batch);
      }
    } finally {
      await iterator.close();
    }

    return JSON.stringify(batches);
  }
}
