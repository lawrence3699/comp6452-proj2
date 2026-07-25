/**
 * Append-only JSONL event store — owner: person 3.
 *
 * WHY JSONL AND NOT SQLITE
 * ------------------------
 * The obvious choice for an index is SQLite, and it is what we would reach for
 * in production. It is not used here for a concrete reason: SQLite from Node
 * needs a native module (`better-sqlite3`, or `node:sqlite` which is still
 * flagged experimental on the Node 18 baseline these packages target), and this
 * project already lost time to a native-toolchain failure — the peer's Docker
 * builder breaking on Docker 29 is the reason the chaincode ships as CCaaS. A
 * marker running `npm install` on a machine without build tools would get a
 * gyp failure and no indexer at all, which is a worse outcome than a slightly
 * less capable store.
 *
 * The properties we actually need are met by an append-only file:
 *   - durability of what has been indexed  -> one `appendFile` per event;
 *   - crash safety                         -> appends are never rewrites, so a
 *     torn write can only ever damage the last line, which the loader drops;
 *   - fast history reads                   -> an in-memory Map<batchId, rows[]>
 *     built once at startup makes `historyFor` O(size of that batch's history)
 *     with no scan, which is the NFR the HTTP API demonstrates;
 *   - auditability                         -> the file is greppable, diffable,
 *     and each row names the block and transaction it came from.
 *
 * What we give up is ad-hoc querying and a store larger than memory. Both are
 * out of scope for a PoC whose ledger is a two-org test network. If either
 * became real, this module is the single seam to swap — `EventStore` is an
 * interface and nothing above it knows the storage format.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { IndexedEvent, eventKey } from './events';

export interface EventStore {
  /** Load persisted rows into memory. Safe to call once, before any append. */
  readonly open: () => Promise<void>;
  /** Persist one event. Returns false if it was already indexed (replay after restart). */
  readonly append: (event: IndexedEvent) => Promise<boolean>;
  /** Every event for one batch, oldest first. */
  readonly historyFor: (batchId: string) => readonly IndexedEvent[];
  /** Every event, oldest first. Used by the /health summary and by tests. */
  readonly all: () => readonly IndexedEvent[];
  /** Number of indexed events. */
  readonly size: () => number;
  /** Batch ids known to the index. */
  readonly batchIds: () => readonly string[];
}

export const DEFAULT_STORE_FILE = path.join(process.cwd(), '.indexer', 'events.jsonl');

/** `INDEXER_STORE_FILE` lets the demo, the tests and a marker's run use different files. */
export const storeFile = (): string => {
  const configured = process.env.INDEXER_STORE_FILE;
  return configured === undefined || configured === '' ? DEFAULT_STORE_FILE : configured;
};

/**
 * A row as it appears on disk: the event plus the sequence number it was
 * indexed at. The sequence exists because Fabric gives us no intra-block
 * ordinal for an event — two events in the same block would otherwise have no
 * defined order, and "oldest first" would be unstable across restarts.
 */
interface StoredRow {
  readonly seq: number;
  readonly event: IndexedEvent;
}

/**
 * Sort key: block number first (that is ledger truth), then arrival order.
 * Deliberately not the event's own `timestamp` — that is chaincode-supplied
 * and, while it comes from the tx timestamp today, ordering the audit trail on
 * a field the emitting contract controls would let a clock skew reorder
 * custody. The block number is the only ordering the ledger guarantees.
 */
const byLedgerOrder = (a: StoredRow, b: StoredRow): number =>
  a.event.blockNumber !== b.event.blockNumber
    ? a.event.blockNumber - b.event.blockNumber
    : a.seq - b.seq;

/**
 * Rebuild an IndexedEvent from a parsed JSONL row. Loading is as defensive as
 * decoding: the file may have been truncated by a crash, or hand-edited.
 */
const rowFrom = (parsed: unknown): StoredRow | undefined => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as { seq?: unknown; event?: unknown };
  const { seq, event } = candidate;
  if (typeof seq !== 'number' || !Number.isInteger(seq)) {
    return undefined;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return undefined;
  }
  const fields = event as Record<string, unknown>;
  if (
    typeof fields['batchId'] !== 'string' ||
    typeof fields['eventName'] !== 'string' ||
    typeof fields['transactionId'] !== 'string' ||
    typeof fields['blockNumber'] !== 'number'
  ) {
    return undefined;
  }
  // Cast justified: the four discriminating fields above are checked, and the
  // file is only ever written by `append` with an already-decoded event.
  return { seq, event: event as IndexedEvent };
};

export class JsonlEventStore implements EventStore {
  readonly #file: string;
  readonly #byBatch = new Map<string, StoredRow[]>();
  readonly #seen = new Set<string>();
  #rows: StoredRow[] = [];
  #nextSeq = 0;
  #opened = false;

  constructor(file: string = storeFile()) {
    this.#file = file;
  }

  /** Absolute path of the backing file, surfaced by /health so a demo can `tail -f` it. */
  get file(): string {
    return this.#file;
  }

  open = async (): Promise<void> => {
    if (this.#opened) {
      return;
    }
    this.#opened = true;
    await fs.mkdir(path.dirname(this.#file), { recursive: true });

    let contents: string;
    try {
      contents = await fs.readFile(this.#file, 'utf8');
    } catch (error: unknown) {
      // A missing file is the normal first run, not a failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    // Repair the record boundary before anything is appended. A process killed
    // mid-append leaves a fragment with no trailing newline; `appendFile` does
    // not insert one, so the next row would be glued onto the fragment and the
    // corruption would spread from one lost event to two. Terminating the
    // fragment confines the damage to the row that was already lost.
    if (contents !== '' && !contents.endsWith('\n')) {
      await fs.appendFile(this.#file, '\n', 'utf8');
    }

    let skipped = 0;
    for (const line of contents.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A half-written final line is exactly what a crash mid-append leaves.
        skipped += 1;
        continue;
      }
      const row = rowFrom(parsed);
      if (row === undefined) {
        skipped += 1;
        continue;
      }
      this.#insert(row);
    }
    if (skipped > 0) {
      console.warn(`indexer: dropped ${String(skipped)} unreadable row(s) from ${this.#file}`);
    }
  };

  /**
   * Append one event. Returns false when the event is already indexed, which
   * happens legitimately: the checkpointer resumes at the last processed block,
   * so the first block after a restart can be redelivered. Dropping the
   * duplicate here is what makes at-least-once delivery look exactly-once to
   * every reader.
   */
  append = async (event: IndexedEvent): Promise<boolean> => {
    const key = eventKey(event);
    if (this.#seen.has(key)) {
      return false;
    }
    const row: StoredRow = { seq: this.#nextSeq, event };
    // Write before mutating the in-memory index: if the append throws (disk
    // full), the caller sees the failure and memory still matches the file.
    await fs.appendFile(this.#file, `${JSON.stringify(row)}\n`, 'utf8');
    this.#insert(row);
    return true;
  };

  historyFor = (batchId: string): readonly IndexedEvent[] => {
    const rows = this.#byBatch.get(batchId);
    if (rows === undefined) {
      return [];
    }
    // Sorted on read rather than on insert. Events almost always arrive in
    // ledger order, so this is a near-no-op scan of one batch's rows, and it
    // keeps the append path a plain push.
    return [...rows].sort(byLedgerOrder).map((row) => row.event);
  };

  all = (): readonly IndexedEvent[] => [...this.#rows].sort(byLedgerOrder).map((row) => row.event);

  size = (): number => this.#rows.length;

  batchIds = (): readonly string[] => [...this.#byBatch.keys()];

  #insert = (row: StoredRow): void => {
    this.#rows.push(row);
    this.#seen.add(eventKey(row.event));
    const existing = this.#byBatch.get(row.event.batchId);
    if (existing === undefined) {
      this.#byBatch.set(row.event.batchId, [row]);
    } else {
      existing.push(row);
    }
    // Survives an out-of-order or hand-edited file: the next sequence is
    // always above every one already present.
    this.#nextSeq = Math.max(this.#nextSeq, row.seq + 1);
  };
}

/**
 * In-memory store used by the tests and by `INDEXER_STORE=memory`. Same
 * semantics minus the file, so a test never needs a temp directory just to
 * check history assembly.
 */
export class MemoryEventStore implements EventStore {
  readonly #byBatch = new Map<string, StoredRow[]>();
  readonly #seen = new Set<string>();
  #rows: StoredRow[] = [];

  open = async (): Promise<void> => undefined;

  append = async (event: IndexedEvent): Promise<boolean> => {
    const key = eventKey(event);
    if (this.#seen.has(key)) {
      return false;
    }
    const row: StoredRow = { seq: this.#rows.length, event };
    this.#rows.push(row);
    this.#seen.add(key);
    const existing = this.#byBatch.get(event.batchId);
    if (existing === undefined) {
      this.#byBatch.set(event.batchId, [row]);
    } else {
      existing.push(row);
    }
    return true;
  };

  historyFor = (batchId: string): readonly IndexedEvent[] =>
    [...(this.#byBatch.get(batchId) ?? [])].sort(byLedgerOrder).map((row) => row.event);

  all = (): readonly IndexedEvent[] => [...this.#rows].sort(byLedgerOrder).map((row) => row.event);

  size = (): number => this.#rows.length;

  batchIds = (): readonly string[] => [...this.#byBatch.keys()];
}

/**
 * Process-wide store, created lazily so importing the module never touches the
 * filesystem — `historyFor` in `index.ts` and the HTTP server share one index
 * with the listener rather than each building their own.
 */
let active: EventStore | undefined;

export const currentStore = (): EventStore => {
  if (active === undefined) {
    active =
      process.env.INDEXER_STORE === 'memory' ? new MemoryEventStore() : new JsonlEventStore();
  }
  return active;
};

/** Swap the store. Passing undefined restores the default; tests use both. */
export const configureStore = (store: EventStore | undefined): void => {
  active = store;
};
