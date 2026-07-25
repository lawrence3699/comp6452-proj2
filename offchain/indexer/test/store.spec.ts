import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexedEvent } from '../src/events';
import { JsonlEventStore, MemoryEventStore } from '../src/store';

const event = (
  batchId: string,
  block: number,
  overrides: Partial<IndexedEvent> = {},
): IndexedEvent =>
  ({
    eventName: 'BatchRegistered',
    batchId,
    producer: 'producer1',
    timestamp: 1_700_000_000 + block,
    blockNumber: block,
    transactionId: `tx-${String(block)}`,
    chaincodeName: 'batch-registry',
    ...overrides,
  }) as IndexedEvent;

const transfer = (batchId: string, block: number, to: string): IndexedEvent => ({
  eventName: 'CustodyTransferred',
  batchId,
  from: 'producer1',
  to,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

/** Every filesystem test runs against a throwaway root, so nothing touches a real store. */
describe('append-only JSONL store', () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-store-'));
    file = path.join(root, 'nested', 'events.jsonl');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the directory and appends one JSON line per event', async () => {
    const store = new JsonlEventStore(file);
    await store.open();
    await store.append(event('BATCH-1', 3));
    await store.append(transfer('BATCH-1', 5, 'transporter1'));

    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).to.have.lengthOf(2);
    expect(JSON.parse(lines[0] as string)).to.have.nested.property('event.batchId', 'BATCH-1');
  });

  it('reloads the index from disk on restart', async () => {
    const first = new JsonlEventStore(file);
    await first.open();
    await first.append(event('BATCH-1', 3));
    await first.append(transfer('BATCH-1', 5, 'transporter1'));

    const restarted = new JsonlEventStore(file);
    await restarted.open();

    expect(restarted.size()).to.equal(2);
    expect(restarted.historyFor('BATCH-1').map((e) => e.eventName)).to.deep.equal([
      'BatchRegistered',
      'CustodyTransferred',
    ]);
  });

  it('drops a duplicate event so a checkpoint replay is idempotent', async () => {
    const store = new JsonlEventStore(file);
    await store.open();

    expect(await store.append(event('BATCH-1', 3))).to.equal(true);
    expect(await store.append(event('BATCH-1', 3))).to.equal(false);
    expect(store.size()).to.equal(1);
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).to.have.lengthOf(1);
  });

  it('dedupes across a restart, not just within one process', async () => {
    const first = new JsonlEventStore(file);
    await first.open();
    await first.append(event('BATCH-1', 3));

    const restarted = new JsonlEventStore(file);
    await restarted.open();

    expect(await restarted.append(event('BATCH-1', 3))).to.equal(false);
    expect(restarted.size()).to.equal(1);
  });

  it('survives a torn final line from a crash mid-append', async () => {
    const first = new JsonlEventStore(file);
    await first.open();
    await first.append(event('BATCH-1', 3));
    // Simulate a process killed halfway through writing the next row.
    await fs.appendFile(file, '{"seq":1,"event":{"batchId":"BATC', 'utf8');

    const restarted = new JsonlEventStore(file);
    await restarted.open();

    expect(restarted.size()).to.equal(1);
    // A later append must still land on a fresh line, not glue itself to the
    // truncated one — appendFile does that for us, and the next load proves it.
    await restarted.append(transfer('BATCH-1', 5, 'transporter1'));
    const reloaded = new JsonlEventStore(file);
    await reloaded.open();
    expect(reloaded.size()).to.equal(2);
  });

  it('returns history oldest first even when events arrive out of order', async () => {
    const store = new JsonlEventStore(file);
    await store.open();
    await store.append(transfer('BATCH-1', 9, 'warehouse1'));
    await store.append(event('BATCH-1', 3));
    await store.append(transfer('BATCH-1', 5, 'transporter1'));

    expect(store.historyFor('BATCH-1').map((e) => e.blockNumber)).to.deep.equal([3, 5, 9]);
  });

  it('orders two events in the same block by arrival, stably across a restart', async () => {
    const store = new JsonlEventStore(file);
    await store.open();
    await store.append(event('BATCH-1', 4, { transactionId: 'tx-a' }));
    await store.append(transfer('BATCH-1', 4, 'transporter1'));

    const before = store.historyFor('BATCH-1').map((e) => e.transactionId);
    const restarted = new JsonlEventStore(file);
    await restarted.open();

    expect(restarted.historyFor('BATCH-1').map((e) => e.transactionId)).to.deep.equal(before);
  });

  it('keeps batches separate', async () => {
    const store = new JsonlEventStore(file);
    await store.open();
    await store.append(event('BATCH-1', 3));
    await store.append(event('BATCH-2', 4));

    expect(store.historyFor('BATCH-1')).to.have.lengthOf(1);
    expect(store.historyFor('BATCH-2')).to.have.lengthOf(1);
    expect([...store.batchIds()].sort()).to.deep.equal(['BATCH-1', 'BATCH-2']);
  });

  it('returns an empty history for an unknown batch instead of throwing', async () => {
    const store = new JsonlEventStore(file);
    await store.open();

    expect(store.historyFor('NOPE')).to.deep.equal([]);
  });

  it('treats a missing file as an empty first run', async () => {
    const store = new JsonlEventStore(path.join(root, 'never-written.jsonl'));
    await store.open();

    expect(store.size()).to.equal(0);
  });
});

describe('in-memory store', () => {
  it('behaves like the file store for dedupe and ordering', async () => {
    const store = new MemoryEventStore();
    await store.open();

    expect(await store.append(transfer('BATCH-1', 9, 'warehouse1'))).to.equal(true);
    expect(await store.append(event('BATCH-1', 3))).to.equal(true);
    expect(await store.append(event('BATCH-1', 3))).to.equal(false);

    expect(store.historyFor('BATCH-1').map((e) => e.blockNumber)).to.deep.equal([3, 9]);
    expect(store.size()).to.equal(2);
  });
});
