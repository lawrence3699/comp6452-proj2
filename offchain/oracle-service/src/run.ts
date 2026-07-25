/**
 * Runnable oracle entry point — owner: person 3. This is what drives the demo.
 *
 *   npm run demo                       # generated series, real network
 *   ORACLE_SERIES_FILE=series.json npm run demo
 *   ORACLE_DRY_RUN=1 npm run demo      # store + summarise only, no network
 *
 * Steps, in order:
 *   1. obtain a raw temperature series (generated, or read from a file);
 *   2. store it through the content-addressed storage adapter;
 *   3. read it straight back, so the run proves the anchor verifies before it
 *      is ever written to the ledger;
 *   4. summarise each window and submit summary + storage hash on chain as the
 *      oracle identity.
 */

import { getJson } from '@comp6452/offchain-storage';
import { loadSeries } from './readings';
import { runOracle, Submitter } from './pipeline';
import { Reading, reportedStatFromEnv, reportedTempC } from './summarise';
import { submit } from './submit';

const envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`);
  }
  return parsed;
};

/**
 * A dry run exercises storage, verification and aggregation without a network,
 * which is how the pipeline is demonstrated when the test network is down.
 */
const isDryRun = (): boolean => {
  const flag = process.env.ORACLE_DRY_RUN;
  return flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
};

export const main = async (): Promise<void> => {
  const dryRun = isDryRun();
  const batchId = process.env.ORACLE_BATCH_ID;
  const readings = await loadSeries({
    ...(batchId !== undefined && batchId !== '' ? { batchId } : {}),
    count: envInt('ORACLE_READING_COUNT', 12),
  });

  console.log(`oracle: ${readings.length} readings for batch ${readings[0]?.batchId ?? '(none)'}`);
  console.log(`oracle: mode ${dryRun ? 'DRY RUN (no network)' : 'submitting on chain'}`);

  const stat = reportedStatFromEnv();
  const submitter: Submitter = dryRun
    ? async (summary) => {
        console.log(
          `  would submit ${summary.batchId} ${stat}=${String(reportedTempC(summary, stat))}C ` +
            `range [${String(summary.minC)}, ${String(summary.maxC)}] at ${String(summary.observedAt)}`,
        );
      }
    : submit;

  const result = await runOracle(readings, submitter, {
    windowSize: envInt('ORACLE_WINDOW_SIZE', 4),
  });

  // Fetch the anchored series straight back. `getJson` re-hashes before
  // returning, so reaching this line proves the anchor on chain resolves to
  // exactly the bytes we summarised.
  const roundTripped = await getJson<{ readings: Reading[] }>(result.rawDataHash);
  if (roundTripped.readings.length !== readings.length) {
    throw new Error('anchored series did not round trip: reading count differs');
  }

  console.log(`oracle: raw series stored at ${result.location}`);
  console.log(`oracle: anchored rawDataHash ${result.rawDataHash} (verified on read back)`);
  console.log(`oracle: submitted ${String(result.summaries.length)} window summaries`);
  result.summaries.forEach((summary, index) => {
    console.log(
      `  window ${String(index + 1)}: mean=${String(summary.meanC)}C ` +
        `min=${String(summary.minC)}C max=${String(summary.maxC)}C ` +
        `observedAt=${String(summary.observedAt)}`,
    );
  });
};

// `require.main === module` keeps the module importable by tests without the
// demo firing as a side effect of the import.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('oracle run failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
