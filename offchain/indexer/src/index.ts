/**
 * Chaincode event indexer — owner: person 3.
 *
 * Consumes BatchRegistered, CustodyTransferred, BatchFlagged and BatchRecalled,
 * persists them, and serves the fast traceability queries behind FR2 and NFR1.
 *
 * The parse and query logic is pure and network-free so it can be unit tested
 * without a Fabric network. `listen()` (Phase 2) is the only part that needs
 * the gateway; it decodes each raw event with `parseEvent` and hands it to the
 * same index the tests exercise directly.
 */

export type EventName =
  | 'BatchRegistered'
  | 'CustodyTransferred'
  | 'BatchFlagged'
  | 'BatchRecalled';

const EVENT_NAMES: readonly EventName[] = [
  'BatchRegistered',
  'CustodyTransferred',
  'BatchFlagged',
  'BatchRecalled',
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

/** A raw chaincode event as delivered by the gateway (or a test double). */
export interface RawChaincodeEvent {
  readonly eventName: string;
  readonly payload: Uint8Array;
  readonly blockNumber: number;
  readonly transactionId: string;
}

/** A stream of raw events: one chaincode's subscription, or a fake for tests. */
export interface EventSource {
  events(): AsyncIterable<RawChaincodeEvent>;
}

/**
 * Drain one event source into the index: decode each event and record the ones
 * this indexer understands, skipping the rest. Runs until the source ends.
 * Network-agnostic — drive it with a fake source in tests.
 */
export const consume = async (source: EventSource, sink: EventStore = store): Promise<void> => {
  for await (const raw of source.events()) {
    try {
      const event = parseEvent(raw.eventName, Buffer.from(raw.payload), {
        blockNumber: raw.blockNumber,
        txId: raw.transactionId,
      });
      sink.record(event);
    } catch {
      // An event this indexer does not track (unknown name, malformed payload).
    }
  }
};

/**
 * Default entry point: subscribe to batch-registry and coldchain-compliance
 * events and index both concurrently. Gateway wiring lives in ./gateway and is
 * imported lazily so the pure logic and its tests never load fabric-gateway.
 * UNVERIFIED until the network is up and person 4 supplies connection config.
 */
export const listen = async (): Promise<void> => {
  const { connectEventSources } = await import('./gateway');
  const { sources, close } = await connectEventSources();
  try {
    await Promise.all(sources.map((source) => consume(source)));
  } finally {
    close();
  }
};
