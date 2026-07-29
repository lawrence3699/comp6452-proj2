/**
 * Demo runner for the indexer — owner: person 3.
 *
 * Subscribes to batch-registry and coldchain-compliance events and prints the
 * accumulating traceability history for one batch, so the demo shows events
 * landing in real time (registration, custody, flag, recall).
 *
 * Run with any member identity's env exported (see ../README.md):
 *   export $(cat network/identities/regulator1.env | xargs)
 *   npm run indexer           # optionally: DEMO_BATCH_ID=B1 npm run indexer
 */

import { listen, historyFor } from '../../indexer/src';

const batchId = process.env.DEMO_BATCH_ID ?? 'B1';

listen().catch((err) => {
  console.error('indexer listen failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

console.log(`indexer: listening; polling history for batch ${batchId} every 3s\n`);

setInterval(() => {
  void historyFor(batchId).then((history) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${batchId}: ${history.length} event(s)`);
    for (const event of history) {
      console.log(`  ${event.name.padEnd(20)} t=${event.timestamp} ${JSON.stringify(event.details)}`);
    }
  });
}, 3000);
