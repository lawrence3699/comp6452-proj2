/**
 * Chaincode event indexer — owner: person 3.
 *
 * Consumes all seven chaincode events — BatchRegistered, CustodyTransferred,
 * BatchFlagged, BatchDelivered and BatchRecalled from `batch-registry`,
 * ComplianceBreach and RecallCascaded from `coldchain-compliance` — persists
 * them to an append-only JSONL store, and serves the fast traceability
 * queries behind FR2 and NFR1.
 *
 * Five modules, split so only two of them need anything outside the process:
 *   events.ts   defensive decoding of a raw chaincode event   (pure)
 *   history.ts  events -> custody chain read model            (pure)
 *   store.ts    append-only persistence + in-memory index     (filesystem)
 *   listen.ts   gateway subscription with checkpointing       (network)
 *   server.ts   node:http read API                            (sockets)
 */

export {
  BatchDeliveredPayload,
  BatchFlaggedPayload,
  BatchRecalledPayload,
  BatchRegisteredPayload,
  ComplianceBreachPayload,
  CustodyTransferredPayload,
  EVENT_NAMES,
  EventDecodeError,
  EventName,
  EventPayload,
  IndexedEvent,
  RawChaincodeEvent,
  RecallCascadedPayload,
  decodeEvent,
  eventKey,
  isEventName,
  tryDecodeEvent,
} from './events';

export {
  DEFAULT_STORE_FILE,
  EventStore,
  JsonlEventStore,
  MemoryEventStore,
  configureStore,
  currentStore,
  storeFile,
} from './store';

export {
  BatchHistory,
  BreachRecord,
  CustodyStep,
  FlagRecord,
  RecallCascade,
  assembleHistory,
} from './history';

export {
  ListenOptions,
  ListenResult,
  checkpointFile,
  consumeEvents,
  defaultCheckpointFile,
  listen,
} from './listen';

export {
  DEFAULT_PORT,
  RunningServer,
  ServerOptions,
  createHandler,
  historyResponse,
  parseHistoryPath,
  serverPort,
  startServer,
} from './server';

import { BatchHistory, assembleHistory } from './history';
import { currentStore } from './store';

/**
 * Indexed history for one batch, oldest first.
 *
 * Async only because the store may still need to load its file; after the
 * first call it is a Map lookup plus one pass over that batch's rows, with no
 * ledger access at all. That is the whole argument for having an indexer:
 * answering this from chain means `GetHistoryForKey` plus a walk of every
 * transaction that ever touched the key.
 */
export const historyFor = async (batchId: string): Promise<BatchHistory> => {
  if (batchId === '') {
    throw new Error('historyFor requires a batchId');
  }
  const store = currentStore();
  await store.open();
  return assembleHistory(batchId, store.historyFor(batchId));
};
