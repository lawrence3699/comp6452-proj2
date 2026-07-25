import { Context } from 'fabric-contract-api';

/**
 * Composite key linking a parent batch to batches derived from it.
 * Written by batch-registry at registration time with attributes
 * [parentBatchId, childBatchId].
 */
export const DERIVED_INDEX = 'derivedFrom~batchId';

export const REGISTRY_CHAINCODE = 'batch-registry';
export const CHANNEL = 'mychannel';

/**
 * Read the children of one batch out of batch-registry.
 *
 * Chaincode state is namespaced per chaincode, so the derivedFrom~batchId index
 * that batch-registry writes is invisible to a getStateByPartialCompositeKey
 * issued from here — that call searches this chaincode's own namespace and
 * always returns empty, which silently reduced the cascade to the named batch
 * alone. Crossing the namespace boundary requires invokeChaincode.
 */
const childrenOf = async (ctx: Context, batchId: string): Promise<string[]> => {
  const response = await ctx.stub.invokeChaincode(
    REGISTRY_CHAINCODE,
    ['BatchQueryContract:GetDerivedBatches', batchId],
    CHANNEL,
  );

  if (response.status !== 200) {
    throw new Error(
      `could not read the batches derived from ${batchId}: ${response.message}`,
    );
  }

  if (!response.payload || response.payload.length === 0) {
    return [];
  }

  return JSON.parse(response.payload.toString()) as string[];
};

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

    for (const child of await childrenOf(ctx, parent)) {
      if (visited.has(child)) {
        continue;
      }
      visited.add(child);
      ordered.push(child);
      queue.push(child);
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
      REGISTRY_CHAINCODE,
      ['BatchRegistryContract:RecallBatch', id],
      CHANNEL,
    );
  }

  return all;
};
