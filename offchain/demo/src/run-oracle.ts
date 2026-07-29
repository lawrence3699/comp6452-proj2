/**
 * Demo runner for the oracle — owner: person 3.
 *
 * Replays windows of raw temperature readings from a JSON file. For each
 * window it aggregates (summarise), stores the raw series off chain (content-
 * addressed), and submits the summary to coldchain-compliance through the
 * oracle identity. Enough consecutive breaching windows trip the on-chain flag.
 *
 * Run with the oracle identity's env exported (see ../README.md):
 *   export $(cat network/identities/oracle1.env | xargs)
 *   npm run oracle            # optionally: npm run oracle -- path/to/readings.json
 */

import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runOracleCycle, Reading } from '../../oracle-service/src';
import { createStore } from '../../storage/src';
import { connectOracleSubmitter } from '../../oracle-service/src/gateway';

const readingsFile = process.argv[2] ?? join(__dirname, '..', 'sample-readings.json');
const storageDir = process.env.STORAGE_DIR ?? join(tmpdir(), 'offchain-demo-storage');

const main = async (): Promise<void> => {
  const windows = JSON.parse(readFileSync(readingsFile, 'utf8')) as Reading[][];
  const store = createStore(storageDir);
  const { submitter, close } = await connectOracleSubmitter();

  console.log(`oracle: replaying ${windows.length} window(s) from ${readingsFile}`);
  console.log(`oracle: raw series stored under ${storageDir}\n`);

  try {
    for (let i = 0; i < windows.length; i++) {
      const summary = await runOracleCycle(windows[i], store, submitter);
      console.log(
        `  window ${i + 1}: batch=${summary.batchId} ` +
          `max=${summary.maxC}C mean=${summary.meanC}C observedAt=${summary.observedAt} -> submitted`,
      );
    }
    console.log('\noracle: done — check the batch status on chain or in the indexer.');
  } finally {
    close();
  }
};

main().catch((err) => {
  console.error('oracle runner failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
