import { expect } from 'chai';
import { IndexedEvent } from '../src/events';
import { assembleHistory } from '../src/history';

/**
 * History assembly is pure over an array of already-decoded events, so these
 * tests build the array by hand — no store, no filesystem, no network.
 */
const registered = (batchId: string, producer: string, block: number): IndexedEvent => ({
  eventName: 'BatchRegistered',
  batchId,
  producer,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

const transferred = (
  batchId: string,
  from: string,
  to: string,
  block: number,
): IndexedEvent => ({
  eventName: 'CustodyTransferred',
  batchId,
  from,
  to,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

const flagged = (batchId: string, reason: string, block: number): IndexedEvent => ({
  eventName: 'BatchFlagged',
  batchId,
  reason,
  evidenceHash: 'b'.repeat(64),
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

describe('history assembly', () => {
  it('builds the custody chain oldest first, starting at the producer', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      transferred('BATCH-1', 'producer1', 'transporter1', 5),
      transferred('BATCH-1', 'transporter1', 'warehouse1', 8),
    ]);

    expect(history.registered).to.equal(true);
    expect(history.producer).to.equal('producer1');
    expect(history.registeredAt).to.equal(1_700_000_003);
    expect(history.currentHolder).to.equal('warehouse1');
    expect(history.custodyChain.map((step) => step.holder)).to.deep.equal([
      'producer1',
      'transporter1',
      'warehouse1',
    ]);
    // The producer originated the batch, so their step has no handover.
    expect(history.custodyChain[0]?.from).to.equal(undefined);
    expect(history.custodyChain[1]?.from).to.equal('producer1');
    expect(history.eventCount).to.equal(3);
  });

  it('collects flags without disturbing the custody chain', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      transferred('BATCH-1', 'producer1', 'transporter1', 5),
      flagged('BATCH-1', 'temperature breach', 6),
      transferred('BATCH-1', 'transporter1', 'warehouse1', 9),
    ]);

    expect(history.flags).to.have.lengthOf(1);
    expect(history.flags[0]?.reason).to.equal('temperature breach');
    expect(history.flags[0]?.blockNumber).to.equal(6);
    expect(history.custodyChain).to.have.lengthOf(3);
    expect(history.currentHolder).to.equal('warehouse1');
  });

  it('reports an unknown batch as unregistered with an empty chain', () => {
    const history = assembleHistory('NOPE', []);

    expect(history).to.deep.equal({
      batchId: 'NOPE',
      registered: false,
      custodyChain: [],
      flags: [],
      events: [],
      eventCount: 0,
    });
    // The absent form matters: `{producer: undefined}` would serialise
    // differently over HTTP from "we have never seen this batch".
    expect(Object.prototype.hasOwnProperty.call(history, 'producer')).to.equal(false);
  });

  it('records a transfer with no registration rather than inventing one', () => {
    // A listener started mid-chain sees the transfer but not the registration.
    // Reporting the gap honestly beats fabricating a producer.
    const history = assembleHistory('BATCH-1', [
      transferred('BATCH-1', 'transporter1', 'warehouse1', 9),
    ]);

    expect(history.registered).to.equal(false);
    expect(history.producer).to.equal(undefined);
    expect(history.currentHolder).to.equal('warehouse1');
    expect(history.custodyChain[0]?.from).to.equal('transporter1');
  });

  it('preserves a transfer whose sender is not the believed holder', () => {
    // A missed event should surface as an inconsistency the auditor can see,
    // not be silently rewritten to agree with the index.
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      transferred('BATCH-1', 'someone-else', 'warehouse1', 7),
    ]);

    expect(history.custodyChain[1]?.from).to.equal('someone-else');
    expect(history.currentHolder).to.equal('warehouse1');
  });

  it('keeps every flag when a batch is flagged more than once', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      flagged('BATCH-1', 'first breach', 4),
      flagged('BATCH-1', 'second breach', 6),
    ]);

    expect(history.flags.map((flag) => flag.reason)).to.deep.equal([
      'first breach',
      'second breach',
    ]);
  });
});
