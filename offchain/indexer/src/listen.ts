/**
 * Chaincode event subscription — owner: person 3.
 *
 * The only module here that touches the network. It connects through the
 * shared gateway helper (`@comp6452/offchain-shared`), so the indexer and the
 * oracle dial the same peer with the same crypto material and there is one
 * place to change when the network moves.
 *
 * Two properties matter and both come from `checkpointers.file`:
 *
 *   1. RESUME, NOT REPLAY. Without a checkpoint the only safe start is block 0,
 *      and every restart re-reads the whole chain. The checkpointer records the
 *      last processed block + transaction id in a file, and passing it as
 *      `options.checkpoint` makes the peer resume from there. `startBlock` is
 *      ignored once the checkpointer has state, which is why the two can be
 *      supplied together.
 *   2. NO LOSS ACROSS A DROPPED CONNECTION. A gRPC stream to a peer will break
 *      — the peer restarts, the network blips. The loop below reconnects and
 *      the checkpoint means the new stream picks up exactly where the old one
 *      stopped. Delivery is at-least-once, so the store dedupes on
 *      (block, tx, event); the pair is what makes it look exactly-once.
 *
 * CHECKPOINT FILE PRECEDENCE. The indexer runs one `listen()` per chaincode
 * (batch-registry and coldchain-compliance), and two streams MUST NOT share a
 * checkpoint file: each stream's progress through the chain is independent,
 * and a shared file would let the faster stream's checkpoint skip the slower
 * stream past events it has not yet indexed. So the default checkpoint path
 * is derived per chaincode (`checkpoint-<chaincode>.json`). Precedence for
 * the registry stream only, highest first:
 *
 *   1. `options.checkpointer`         — an explicit checkpointer wins always;
 *   2. `INDEXER_CHECKPOINT_FILE`      — back-compat: existing deployments set
 *                                       this expecting it to name the (then
 *                                       only) registry stream's file, and a
 *                                       redeploy must not orphan their state;
 *   3. `.indexer/checkpoint-<chaincode>.json` under the working directory.
 *
 * Every non-registry stream ignores `INDEXER_CHECKPOINT_FILE` — honouring it
 * there would recreate exactly the shared-file hazard the per-chaincode
 * default exists to prevent.
 */

import {
  ChaincodeEvent,
  Checkpointer,
  CloseableAsyncIterable,
  Network,
  checkpointers,
} from '@hyperledger/fabric-gateway';
import {
  FabricConfig,
  GatewayConnection,
  connectGateway,
  getNetwork,
  loadConfig,
} from '@comp6452/offchain-shared';
import * as path from 'path';
import { IndexedEvent, tryDecodeEvent } from './events';
import { EventStore, currentStore } from './store';

/**
 * Compile-time proof that the decoder's local `RawChaincodeEvent` really does
 * describe the SDK's `ChaincodeEvent`. If the SDK changes shape this line
 * fails to compile, instead of the decoder quietly reading absent fields.
 */
import type { RawChaincodeEvent } from './events';
const _sdkEventIsRaw = (event: ChaincodeEvent): RawChaincodeEvent => event;
void _sdkEventIsRaw;

/** Per-chaincode default path — see the header for why streams never share one. */
export const defaultCheckpointFile = (chaincodeName: string): string =>
  path.join(process.cwd(), '.indexer', `checkpoint-${chaincodeName}.json`);

/**
 * Resolve the checkpoint file for one chaincode's stream. `registryChaincode`
 * identifies which stream `INDEXER_CHECKPOINT_FILE` is allowed to override —
 * the env var predates the second stream and has always meant "the registry
 * stream's file", so it must keep meaning exactly that.
 */
export const checkpointFile = (chaincodeName: string, registryChaincode: string): string => {
  const configured = process.env.INDEXER_CHECKPOINT_FILE;
  if (chaincodeName === registryChaincode && configured !== undefined && configured !== '') {
    return configured;
  }
  return defaultCheckpointFile(chaincodeName);
};

export interface ListenOptions {
  /** Chaincode to subscribe to. Defaults to `config.registryChaincode`. */
  readonly chaincodeName?: string;
  /** Store to persist into. Defaults to the process-wide store. */
  readonly store?: EventStore;
  /** Checkpointer. Defaults to a file checkpointer at `checkpointFile(...)`. */
  readonly checkpointer?: Checkpointer;
  /** First block to read when the checkpointer has no saved state. */
  readonly startBlock?: bigint;
  /** Stop after this many events. Used by the demo and by tests; undefined runs forever. */
  readonly maxEvents?: number;
  /** Cooperative cancellation, so the HTTP server's shutdown can stop the listener. */
  readonly signal?: AbortSignal;
  /** Seconds to wait before reconnecting after a stream error. */
  readonly reconnectDelayMs?: number;
  /** Called after each event is persisted. The demo prints; tests assert. */
  readonly onEvent?: (event: IndexedEvent, isNew: boolean) => void;
  /** Called with the reason a malformed event was dropped. */
  readonly onSkip?: (reason: string) => void;
  /** Config override; defaults to the shared env-driven config. */
  readonly config?: FabricConfig;
}

export interface ListenResult {
  readonly indexed: number;
  readonly duplicates: number;
  readonly skipped: number;
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Consume one already-open event stream until it ends, the cap is reached or
 * the caller aborts. Factored out from `listen` so the tests can drive it with
 * a fabricated async iterable and never open a gRPC channel.
 */
export const consumeEvents = async (
  events: AsyncIterable<ChaincodeEvent>,
  store: EventStore,
  checkpointer: Checkpointer,
  options: Pick<ListenOptions, 'maxEvents' | 'signal' | 'onEvent' | 'onSkip'> = {},
): Promise<ListenResult> => {
  const onSkip = options.onSkip ?? ((reason: string): void => console.warn(`indexer: ${reason}`));
  let indexed = 0;
  let duplicates = 0;
  let skipped = 0;

  for await (const raw of events) {
    if (options.signal?.aborted === true) {
      break;
    }

    const decoded = tryDecodeEvent(raw, (reason) => {
      skipped += 1;
      onSkip(reason);
    });

    if (decoded !== undefined) {
      const isNew = await store.append(decoded);
      if (isNew) {
        indexed += 1;
      } else {
        duplicates += 1;
      }
      options.onEvent?.(decoded, isNew);
    }

    // Checkpoint after persisting, and for skipped events too. Checkpointing
    // an undecodable event is correct: it will never decode on a retry, so
    // leaving the checkpoint behind it would wedge the listener on it forever.
    // Checkpointing *before* the append would be the real bug — a crash in
    // between would lose the event with the checkpoint already past it.
    await checkpointer.checkpointChaincodeEvent(raw);

    if (options.maxEvents !== undefined && indexed + duplicates + skipped >= options.maxEvents) {
      break;
    }
  }

  return { indexed, duplicates, skipped };
};

/**
 * Open the event stream for one attempt. Separate so `listen` reads as the
 * reconnect policy and nothing else.
 */
const openEvents = async (
  network: Network,
  chaincodeName: string,
  checkpointer: Checkpointer,
  startBlock?: bigint,
): Promise<CloseableAsyncIterable<ChaincodeEvent>> =>
  network.getChaincodeEvents(chaincodeName, {
    checkpoint: checkpointer,
    // Ignored once the checkpointer holds state; on a fresh run it decides
    // whether we replay from genesis (the default) or only take new blocks.
    ...(startBlock !== undefined ? { startBlock } : {}),
  });

/**
 * Subscribe to one chaincode's events and index them until cancelled.
 * Defaults to `config.registryChaincode`; `run.ts` calls this twice, once per
 * chaincode, over one shared store.
 *
 * Resolves with the tallies when `maxEvents` is reached or `signal` aborts;
 * otherwise it runs until the process is stopped, reconnecting through peer
 * restarts.
 */
export const listen = async (options: ListenOptions = {}): Promise<ListenResult> => {
  const config = options.config ?? loadConfig();
  const chaincodeName = options.chaincodeName ?? config.registryChaincode;
  const store = options.store ?? currentStore();
  await store.open();

  const checkpointer =
    options.checkpointer ??
    (await checkpointers.file(checkpointFile(chaincodeName, config.registryChaincode)));
  const reconnectDelayMs = options.reconnectDelayMs ?? 3_000;

  const total: { indexed: number; duplicates: number; skipped: number } = {
    indexed: 0,
    duplicates: 0,
    skipped: 0,
  };

  // A function, not an inlined `options.signal?.aborted` test: the compiler
  // narrows the property from the loop condition and would then insist the
  // check inside the catch block is unreachable, when in fact `aborted` flips
  // under us while the loop body is awaiting.
  const isAborted = (): boolean => options.signal?.aborted === true;

  let connection: GatewayConnection | undefined;
  try {
    connection = await connectGateway(config);
    const network = getNetwork(connection);

    while (!isAborted()) {
      const remaining =
        options.maxEvents === undefined
          ? undefined
          : options.maxEvents - (total.indexed + total.duplicates + total.skipped);
      if (remaining !== undefined && remaining <= 0) {
        break;
      }

      let events: CloseableAsyncIterable<ChaincodeEvent> | undefined;
      // An idle stream never reaches the loop's signal check: for-await parks
      // on the peer until the next event arrives, which may be never. Closing
      // the stream on abort is what makes Ctrl-C effective while idle — the
      // iterator ends (or throws, caught below with isAborted() breaking out).
      const closeOnAbort = (): void => events?.close();
      options.signal?.addEventListener('abort', closeOnAbort, { once: true });
      try {
        events = await openEvents(network, chaincodeName, checkpointer, options.startBlock);
        if (isAborted()) {
          break;
        }
        const result = await consumeEvents(events, store, checkpointer, {
          ...(remaining !== undefined ? { maxEvents: remaining } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
          ...(options.onSkip !== undefined ? { onSkip: options.onSkip } : {}),
        });
        total.indexed += result.indexed;
        total.duplicates += result.duplicates;
        total.skipped += result.skipped;
      } catch (error: unknown) {
        // A stream error is expected operational noise, not a reason to exit:
        // the checkpoint makes reconnecting lossless, so log and retry.
        if (isAborted()) {
          break;
        }
        console.warn(
          `indexer: event stream error, reconnecting in ${String(reconnectDelayMs)}ms: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await delay(reconnectDelayMs, options.signal);
      } finally {
        // Closing frees the gRPC stream; leaving it open through a reconnect
        // loop leaks one stream per iteration. The abort listener goes with it
        // — a once-listener that already fired is a no-op to remove.
        options.signal?.removeEventListener('abort', closeOnAbort);
        events?.close();
      }
    }
  } finally {
    connection?.close();
  }

  return total;
};
