import { Context } from 'fabric-contract-api';

/**
 * Composite key linking a parent batch to batches derived from it.
 * Written by batch-registry at registration time with attributes
 * [parentBatchId, childBatchId].
 */
export const DERIVED_INDEX = 'derivedFrom~batchId';

/**
 * Collect every batch downstream of the given one, breadth-first.
 *
 * A contaminated pallet may have been split into cases and repacked, so a
 * recall has to follow the derivation graph rather than stopping at the first
 * level. The visited set guards against cycles: the graph should be a DAG, but
 * a mis-registered batch claiming its own ancestor as a parent would otherwise
 * loop until the transaction timed out.
 */
export const collectDownstream = async (
  ctx: Context,
  batchId: string,
): Promise<string[]> => {
  const visited = new Set<string>([batchId]);
  const ordered: string[] = [];
  const queue: string[] = [batchId];

  while (queue.length > 0) {
    const parent = queue.shift() as string;
    const iterator = await ctx.stub.getStateByPartialCompositeKey(DERIVED_INDEX, [parent]);

    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }

        const attributes = ctx.stub.splitCompositeKey(next.value.key).attributes;
        const child = attributes[1];

        if (!child || visited.has(child)) {
          continue;
        }

        visited.add(child);
        ordered.push(child);
        queue.push(child);
      }
    } finally {
      await iterator.close();
    }
  }

  return ordered;
};

/**
 * Recall the batch and everything derived from it.
 *
 * Returns every batch id that was recalled, parent first, so the caller can
 * report the blast radius.
 */
export const cascadeRecall = async (ctx: Context, batchId: string): Promise<string[]> => {
  const downstream = await collectDownstream(ctx, batchId);
  const all = [batchId, ...downstream];

  for (const id of all) {
    // The registry owns batch state, so the status change goes through it.
    // Same channel, so this write set commits atomically with ours: either the
    // whole cascade lands or none of it does.
    await ctx.stub.invokeChaincode(
      'batch-registry',
      ['BatchRegistryContract:RecallBatch', id],
      'mychannel',
    );
  }

  return all;
};
