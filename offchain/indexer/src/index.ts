/**
 * Chaincode event indexer — owner: person 3.
 *
 * Consumes BatchRegistered, CustodyTransferred and BatchFlagged, persists
 * them, and serves the fast traceability queries behind FR2 and NFR1.
 *
 * The parse and query logic is pure and network-free so it can be unit tested
 * without a Fabric network. `listen()` (Phase 2) is the only part that needs
 * the gateway; it decodes each raw event with `parseEvent` and hands it to the
 * same index the tests exercise directly.
 */

export type EventName = 'BatchRegistered' | 'CustodyTransferred' | 'BatchFlagged';

const EVENT_NAMES: readonly EventName[] = [
  'BatchRegistered',
  'CustodyTransferred',
  'BatchFlagged',
];

export interface IndexedEvent {
  readonly name: EventName;
  readonly batchId: string;
  readonly timestamp: number;
  /** The remaining event-specific fields (producer, from/to, reason, ...). */
  readonly details: Readonly<Record<string, unknown>>;
  /** Ledger coordinates, when the event came off a real block. */
  readonly blockNumber?: number;
  readonly txId?: string;
}

export interface EventMeta {
  readonly blockNumber?: number;
  readonly txId?: string;
}

const isEventName = (name: string): name is EventName =>
  (EVENT_NAMES as readonly string[]).includes(name);

/**
 * Decode one raw chaincode event into an `IndexedEvent`.
 *
 * @param name    the chaincode event name
 * @param payload the event payload, as the JSON bytes or string emitted on chain
 * @throws if the event name is unknown or the payload lacks `batchId`
 */
export const parseEvent = (
  name: string,
  payload: Buffer | string,
  meta: EventMeta = {},
): IndexedEvent => {
  if (!isEventName(name)) {
    throw new Error(`unknown chaincode event '${name}'`);
  }
  const text = typeof payload === 'string' ? payload : payload.toString('utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;

  const { batchId, timestamp, ...details } = parsed;
  if (typeof batchId !== 'string' || batchId.length === 0) {
    throw new Error(`${name} payload is missing a batchId`);
  }

  return {
    name,
    batchId,
    timestamp: typeof timestamp === 'number' ? timestamp : 0,
    details,
    blockNumber: meta.blockNumber,
    txId: meta.txId,
  };
};

export interface EventStore {
  record(event: IndexedEvent): void;
  history(batchId: string): IndexedEvent[];
  reset(): void;
}

/** Order events oldest-first, breaking ties on block number then insertion. */
const chronological = (a: IndexedEvent, b: IndexedEvent): number =>
  a.timestamp - b.timestamp || (a.blockNumber ?? 0) - (b.blockNumber ?? 0);

/** In-memory index keyed by batch. A file/SQLite backend can drop in later. */
export const createStore = (): EventStore => {
  const byBatch = new Map<string, IndexedEvent[]>();
  return {
    record(event: IndexedEvent): void {
      const events = byBatch.get(event.batchId) ?? [];
      events.push(event);
      byBatch.set(event.batchId, events);
    },
    history(batchId: string): IndexedEvent[] {
      return [...(byBatch.get(batchId) ?? [])].sort(chronological);
    },
    reset(): void {
      byBatch.clear();
    },
  };
};

const store = createStore();

/** Record an event into the default index (used by `listen` and by tests). */
export const record = (event: IndexedEvent): void => store.record(event);

/** Clear the default index (used by tests). */
export const reset = (): void => store.reset();

/** Serve the full, time-ordered history for one batch (FR2 traceability). */
export const historyFor = async (batchId: string): Promise<IndexedEvent[]> =>
  store.history(batchId);

// TODO(person 3, Phase 2): with the Fabric gateway, subscribe to chaincode
// events from both batch-registry and coldchain-compliance, decode each with
// parseEvent(name, payload, { blockNumber, txId }) and record() it. Use a
// checkpointer so a restart resumes from the last processed block.
export const listen = async (): Promise<void> => {
  throw new Error('not implemented');
};
