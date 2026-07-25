import { expect } from 'chai';
import { IndexedEvent } from '../src/events';
import { BatchHistory } from '../src/history';
import { RunningServer, parseHistoryPath, startServer } from '../src/server';
import { MemoryEventStore } from '../src/store';

const registered = (batchId: string, block: number): IndexedEvent => ({
  eventName: 'BatchRegistered',
  batchId,
  producer: 'producer1',
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

const transferred = (batchId: string, block: number, to: string): IndexedEvent => ({
  eventName: 'CustodyTransferred',
  batchId,
  from: 'producer1',
  to,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

describe('history path parsing', () => {
  it('extracts the batch id', () => {
    expect(parseHistoryPath('/batch/BATCH-1/history')).to.equal('BATCH-1');
  });

  it('decodes a percent-encoded id exactly once', () => {
    expect(parseHistoryPath('/batch/BATCH%20one/history')).to.equal('BATCH one');
  });

  it('rejects a path with extra segments', () => {
    expect(parseHistoryPath('/batch/BATCH-1/history/extra')).to.equal(undefined);
    expect(parseHistoryPath('/batch/BATCH-1')).to.equal(undefined);
  });

  it('rejects an empty id', () => {
    expect(parseHistoryPath('/batch//history')).to.equal(undefined);
  });

  it('rejects malformed percent-encoding rather than throwing', () => {
    expect(parseHistoryPath('/batch/%E0%A4%A/history')).to.equal(undefined);
  });
});

/**
 * The HTTP tests bind an ephemeral port on loopback and use the global fetch
 * that ships with Node 18+. Still no Fabric: the store is in memory and
 * pre-loaded with fabricated events.
 */
describe('read API', () => {
  let running: RunningServer;
  let base: string;

  beforeEach(async () => {
    const store = new MemoryEventStore();
    await store.append(registered('BATCH-1', 3));
    await store.append(transferred('BATCH-1', 5, 'transporter1'));
    await store.append(transferred('BATCH-1', 8, 'warehouse1'));
    await store.append(registered('BATCH-2', 4));

    // Port 0 lets the OS pick a free port, so the suite never collides with a
    // running demo on 3001.
    running = await startServer({ store, port: 0 });
    base = `http://127.0.0.1:${String(running.port)}`;
  });

  afterEach(async () => {
    await running.close();
  });

  it('answers /health with the index size', async () => {
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { status: string; indexedEvents: number; batches: number };

    expect(response.status).to.equal(200);
    expect(body.status).to.equal('ok');
    expect(body.indexedEvents).to.equal(4);
    expect(body.batches).to.equal(2);
  });

  it('serves a batch history oldest first', async () => {
    const response = await fetch(`${base}/batch/BATCH-1/history`);
    const body = (await response.json()) as BatchHistory;

    expect(response.status).to.equal(200);
    expect(body.batchId).to.equal('BATCH-1');
    expect(body.currentHolder).to.equal('warehouse1');
    expect(body.custodyChain.map((step) => step.holder)).to.deep.equal([
      'producer1',
      'transporter1',
      'warehouse1',
    ]);
    expect(body.events.map((event) => event.blockNumber)).to.deep.equal([3, 5, 8]);
  });

  it('reports the served query time, which is the NFR evidence', async () => {
    const response = await fetch(`${base}/batch/BATCH-1/history`);
    const header = response.headers.get('x-query-time-ms');

    expect(header).to.be.a('string');
    expect(Number(header)).to.be.a('number').and.to.be.lessThan(50);
  });

  it('404s an unknown batch rather than returning an empty history as success', async () => {
    const response = await fetch(`${base}/batch/NOPE/history`);
    const body = (await response.json()) as BatchHistory;

    expect(response.status).to.equal(404);
    expect(body.eventCount).to.equal(0);
    expect(body.registered).to.equal(false);
  });

  it('lists the known batch ids', async () => {
    const response = await fetch(`${base}/batches`);
    const body = (await response.json()) as { batches: string[] };

    expect(response.status).to.equal(200);
    expect(body.batches).to.deep.equal(['BATCH-1', 'BATCH-2']);
  });

  it('404s an unrouted path and names the routes it does serve', async () => {
    const response = await fetch(`${base}/nope`);
    const body = (await response.json()) as { error: string; routes: string[] };

    expect(response.status).to.equal(404);
    expect(body.routes).to.include('GET /health');
  });

  it('405s a write, because this service is read-only', async () => {
    const response = await fetch(`${base}/batch/BATCH-1/history`, { method: 'POST' });

    expect(response.status).to.equal(405);
  });

  it('handles a batch id containing a space via percent-encoding', async () => {
    const store = new MemoryEventStore();
    await store.append(registered('BATCH one', 3));
    const other = await startServer({ store, port: 0 });
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(other.port)}/batch/${encodeURIComponent('BATCH one')}/history`,
      );
      const body = (await response.json()) as BatchHistory;
      expect(response.status).to.equal(200);
      expect(body.batchId).to.equal('BATCH one');
    } finally {
      await other.close();
    }
  });
});
