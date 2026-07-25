/**
 * The oracle pipeline — owner: person 3.
 *
 * store raw series -> summarise -> submit summary + storage hash.
 *
 * The submission step is injected rather than imported directly so the whole
 * pipeline can be unit tested with a sinon spy and no Fabric network, while
 * `run.ts` passes the real gateway-backed submitter.
 */

import { StoredObject, putJson } from '@comp6452/offchain-storage';
import { Reading, Summary, summarise, window } from './summarise';

/** Anything that can push a summary on chain. `submit` from `submit.ts` fits. */
export type Submitter = (summary: Summary, rawDataHash: string) => Promise<unknown>;

export interface OracleRunResult {
  /** Content hash of the full raw series, anchored on chain. */
  readonly rawDataHash: string;
  /** Backend-specific location of the stored series, for the demo transcript. */
  readonly location: string;
  /** One summary per submitted window, in submission order. */
  readonly summaries: readonly Summary[];
}

/**
 * Store the raw series off chain and return its anchor.
 *
 * The stored document keeps the readings verbatim plus the batch id, so an
 * auditor holding only the on-chain hash can refetch the series, verify the
 * hash, and recompute every statistic the oracle claimed.
 */
export const anchorSeries = async (
  batchId: string,
  readings: readonly Reading[],
): Promise<StoredObject> => {
  if (readings.length === 0) {
    throw new Error('anchorSeries requires at least one reading');
  }
  return putJson({
    batchId,
    schema: 'comp6452.oracle.temperature-series.v1',
    count: readings.length,
    readings,
  });
};

export interface RunOptions {
  /**
   * Readings per on-chain submission. The compliance chaincode flags after 3
   * consecutive breaching submissions, so this sets how long an excursion must
   * persist before it counts.
   */
  readonly windowSize?: number;
}

/**
 * Run the oracle over one series.
 *
 * The entire raw series is stored once and every window's summary carries the
 * same anchor: the evidence for "why was this batch flagged" is the series as
 * a whole, and storing each window separately would leave an auditor stitching
 * fragments together.
 */
export const runOracle = async (
  readings: readonly Reading[],
  submitter: Submitter,
  options: RunOptions = {},
): Promise<OracleRunResult> => {
  if (readings.length === 0) {
    throw new Error('runOracle requires at least one reading');
  }
  const batchId = readings[0].batchId;
  // summarise() rejects a mixed-batch series; calling it up front means we
  // never store an anchor for a series we are then unable to submit.
  summarise(readings);

  const stored = await anchorSeries(batchId, readings);
  const windowSize = options.windowSize ?? readings.length;

  const summaries: Summary[] = [];
  for (const slice of window(readings, windowSize)) {
    const summary = summarise(slice);
    // Sequential: the chaincode's consecutive-breach counter reads and writes
    // the same key, so concurrent submissions would collide on MVCC.
    await submitter(summary, stored.hash);
    summaries.push(summary);
  }

  return { rawDataHash: stored.hash, location: stored.location, summaries };
};
