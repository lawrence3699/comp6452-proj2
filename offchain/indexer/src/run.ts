/**
 * Runnable indexer entry point — owner: person 3. This is what drives the demo.
 *
 *   npm start                     # listen + serve
 *   npm run serve                 # serve only, from what is already indexed
 *   INDEXER_PORT=3001 npm start
 *
 * The HTTP server comes up before the gateway connection is attempted, so
 * `/health` answers even when the test network is down — a demo that dies on
 * connect looks identical to a demo with no code in it.
 */

import { listen } from './listen';
import { startServer } from './server';
import { currentStore } from './store';

const isTruthy = (key: string): boolean => {
  const flag = process.env[key];
  return flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
};

const startBlockFromEnv = (): bigint | undefined => {
  const raw = process.env.INDEXER_START_BLOCK;
  if (raw === undefined || raw === '') {
    return undefined;
  }
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`INDEXER_START_BLOCK must be an integer block number, got: ${raw}`);
  }
};

export const main = async (): Promise<void> => {
  const store = currentStore();
  await store.open();

  const running = await startServer({ store });
  console.log(`indexer: read API on http://127.0.0.1:${String(running.port)}`);
  console.log(`indexer:   GET /health`);
  console.log(`indexer:   GET /batches`);
  console.log(`indexer:   GET /batch/:batchId/history`);
  console.log(`indexer: ${String(store.size())} event(s) already indexed`);

  // Ctrl-C has to reach both the listener and the socket, or the process hangs
  // on an open gRPC stream and the marker has to kill -9 it.
  const controller = new AbortController();
  const shutdown = (): void => {
    console.log('indexer: shutting down');
    controller.abort();
    void running.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (isTruthy('INDEXER_SERVE_ONLY')) {
    console.log('indexer: serve-only mode, not subscribing to chaincode events');
    return;
  }

  const startBlock = startBlockFromEnv();
  console.log(
    `indexer: subscribing to chaincode events` +
      `${startBlock !== undefined ? ` from block ${startBlock.toString()} (unless checkpointed)` : ''}`,
  );

  try {
    const result = await listen({
      store,
      signal: controller.signal,
      ...(startBlock !== undefined ? { startBlock } : {}),
      onEvent: (event, isNew) => {
        console.log(
          `  ${isNew ? 'indexed' : 'duplicate'} ${event.eventName} ` +
            `batch=${event.batchId} block=${String(event.blockNumber)} tx=${event.transactionId.slice(0, 12)}`,
        );
      },
      onSkip: (reason) => console.warn(`indexer: ${reason}`),
    });
    console.log(
      `indexer: stopped — ${String(result.indexed)} indexed, ` +
        `${String(result.duplicates)} duplicate, ${String(result.skipped)} skipped`,
    );
  } finally {
    await running.close();
  }
};

// `require.main === module` keeps the module importable by tests without the
// demo firing as a side effect of the import.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('indexer run failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
