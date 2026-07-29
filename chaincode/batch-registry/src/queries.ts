import { Context, Contract } from 'fabric-contract-api';
import { Batch } from './batch';
import { HOLDER_INDEX } from './batchRegistry';

/** One entry in a batch's custody/status history. */
interface HistoryEntry {
  readonly txId: string;
  readonly timestamp: number;
  readonly isDelete: boolean;
  readonly value: Batch | null;
}

/**
 * FR2 traceability queries. Read-only, kept in its own file so that person 4
 * and person 1 never edit the same file.
 * Owner: person 4.
 */
export class BatchQueryContract extends Contract {
  /** Full custody/status history for one batch, oldest write first. */
  public async GetBatchHistory(ctx: Context, batchId: string): Promise<string> {
    const history: HistoryEntry[] = [];

    // The promise itself is AsyncIterable — awaiting it first would discard
    // that and leave a plain StateQueryIterator with no async iterator.
    for await (const record of ctx.stub.getHistoryForKey(batchId)) {
      history.push({
        txId: record.txId,
        timestamp: Number(record.timestamp.seconds),
        isDelete: record.isDelete,
        value:
          record.isDelete || record.value.length === 0
            ? null
            : (JSON.parse(record.value.toString()) as Batch),
      });
    }

    return JSON.stringify(history);
  }

  /**
   * Every batch currently held by one organisation.
   *
   * Range-scans the holder~batchId composite key that RegisterBatch and
   * TransferCustody keep in step, rather than scanning every batch on the
   * ledger to find the ones this holder owns.
   */
  public async GetBatchesByHolder(ctx: Context, holderMsp: string): Promise<string> {
    const batchIds: string[] = [];
    for await (const kv of ctx.stub.getStateByPartialCompositeKey(HOLDER_INDEX, [holderMsp])) {
      const { attributes } = ctx.stub.splitCompositeKey(kv.key);
      batchIds.push(attributes[1]);
    }

    const batches: Batch[] = [];
    for (const batchId of batchIds) {
      const raw = await ctx.stub.getState(batchId);
      if (raw && raw.length > 0) {
        batches.push(JSON.parse(raw.toString()) as Batch);
      }
    }

    return JSON.stringify(batches);
  }
}
