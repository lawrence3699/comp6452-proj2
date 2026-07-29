import { Context } from 'fabric-contract-api';
import { invokeRegistry } from './registry';

/**
 * Read-only batch-registry transaction required for
 * reading the derived-batch index.
 *
 * This query has to live inside batch-registry because
 * each chaincode has its own world-state namespace.
 *
 * Person 1 must expose this transaction before the
 * integration test is run.
 */
export const DERIVED_BATCH_QUERY =
  'GetDerivedBatches';

/**
 * Parse the JSON returned by GetDerivedBatches.
 */
const parseChildren = (
  payload: Buffer,
  batchId: string,
): string[] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(
      payload.toString('utf8'),
    );
  } catch {
    throw new Error(
      `GetDerivedBatches returned invalid JSON for batch ${batchId}`,
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (value) =>
        typeof value !== 'string',
    )
  ) {
    throw new Error(
      `GetDerivedBatches returned an invalid child list for batch ${batchId}`,
    );
  }

  return parsed;
};

/**
 * Recall the selected batch and every batch derived
 * from it.
 *
 * The batch registry only permits:
 *
 * FLAGGED -> RECALLED
 *
 * Therefore, every batch is first flagged and then
 * recalled.
 *
 * The visited set prevents malformed derived-batch
 * data from causing an infinite loop.
 */
export const cascadeRecall = async (
  ctx: Context,
  batchId: string,
): Promise<string[]> => {
  const pending: string[] = [
    batchId,
  ];

  const visited =
    new Set<string>();

  const recalled: string[] = [];

  while (pending.length > 0) {
    const current =
      pending.shift() as string;

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    /*
     * Ask batch-registry for the direct child batches.
     */
    const childPayload =
      await invokeRegistry(
        ctx,
        DERIVED_BATCH_QUERY,
        current,
      );

    const children =
      parseChildren(
        childPayload,
        current,
      );

    const reason =
      current === batchId
        ? `regulator recall requested for batch ${batchId}`
        : `cascade recall from batch ${batchId}`;

    /*
     * The state machine requires the batch to be
     * FLAGGED before it can become RECALLED.
     */
    await invokeRegistry(
      ctx,
      'FlagBatch',
      current,
      reason,
      '',
    );

    await invokeRegistry(
      ctx,
      'RecallBatch',
      current,
    );

    recalled.push(current);

    /*
     * Add all direct children to the BFS queue.
     */
    for (const child of children) {
      if (!visited.has(child)) {
        pending.push(child);
      }
    }
  }

  return recalled;
};
