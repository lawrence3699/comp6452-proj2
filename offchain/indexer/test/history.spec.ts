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

const delivered = (batchId: string, holder: string, block: number): IndexedEvent => ({
  eventName: 'BatchDelivered',
  batchId,
  holder,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

const recalled = (batchId: string, block: number): IndexedEvent => ({
  eventName: 'BatchRecalled',
  batchId,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'batch-registry',
});

const breach = (batchId: string, tempC: number, block: number): IndexedEvent => ({
  eventName: 'ComplianceBreach',
  batchId,
  consecutive: 3,
  tempC,
  rawDataHash: 'c'.repeat(64),
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'coldchain-compliance',
});

const cascaded = (root: string, ids: readonly string[], block: number): IndexedEvent => ({
  eventName: 'RecallCascaded',
  batchId: root,
  recalled: ids,
  timestamp: 1_700_000_000 + block,
  blockNumber: block,
  transactionId: `tx-${String(block)}`,
  chaincodeName: 'coldchain-compliance',
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
      delivered: false,
      recalled: false,
      custodyChain: [],
      flags: [],
      breaches: [],
      recallCascades: [],
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

  it('records a delivery as a lifecycle step and marks the batch delivered', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'Org1MSP', 3),
      transferred('BATCH-1', 'Org1MSP', 'Org2MSP', 5),
      delivered('BATCH-1', 'Org2MSP', 8),
    ]);

    expect(history.delivered).to.equal(true);
    expect(history.recalled).to.equal(false);
    expect(history.currentHolder).to.equal('Org2MSP');
    expect(history.custodyChain.map((step) => step.kind)).to.deep.equal([
      'held',
      'held',
      'delivered',
    ]);
    expect(history.custodyChain[2]?.holder).to.equal('Org2MSP');
    expect(history.custodyChain[2]?.blockNumber).to.equal(8);
  });

  it('records a recall as a lifecycle step attributed to the current holder', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      transferred('BATCH-1', 'producer1', 'transporter1', 5),
      recalled('BATCH-1', 9),
    ]);

    expect(history.recalled).to.equal(true);
    expect(history.delivered).to.equal(false);
    // The recall event carries no holder; the goods stay where they were.
    expect(history.custodyChain[2]?.kind).to.equal('recalled');
    expect(history.custodyChain[2]?.holder).to.equal('transporter1');
    expect(history.currentHolder).to.equal('transporter1');
  });

  it('reports an unknown holder on a recall seen without any custody history', () => {
    // Listener started mid-chain: the gap is represented, not repaired.
    const history = assembleHistory('BATCH-1', [recalled('BATCH-1', 9)]);

    expect(history.recalled).to.equal(true);
    expect(history.custodyChain[0]?.holder).to.equal('unknown');
  });

  it('surfaces compliance breaches without disturbing the custody chain', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      breach('BATCH-1', 9.5, 6),
      breach('BATCH-1', 11.2, 7),
    ]);

    expect(history.breaches).to.have.lengthOf(2);
    expect(history.breaches[0]?.tempC).to.equal(9.5);
    expect(history.breaches[0]?.consecutive).to.equal(3);
    expect(history.breaches[0]?.rawDataHash).to.equal('c'.repeat(64));
    expect(history.breaches[1]?.blockNumber).to.equal(7);
    expect(history.custodyChain).to.have.lengthOf(1);
    expect(history.flags).to.have.lengthOf(0);
  });

  it('files a cascade in the root batch history with its blast radius', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'producer1', 3),
      cascaded('BATCH-1', ['BATCH-1', 'BATCH-1-SPLIT'], 10),
    ]);

    expect(history.recalled).to.equal(true);
    expect(history.recallCascades).to.have.lengthOf(1);
    expect(history.recallCascades[0]?.recalled).to.deep.equal(['BATCH-1', 'BATCH-1-SPLIT']);
    expect(history.recallCascades[0]?.blockNumber).to.equal(10);
    // The cascade is not a custody step: the per-batch BatchRecalled rows are.
    expect(history.custodyChain).to.have.lengthOf(1);
  });

  it('assembles the full lifecycle with both chaincodes interleaved', () => {
    const history = assembleHistory('BATCH-1', [
      registered('BATCH-1', 'Org1MSP', 3),
      transferred('BATCH-1', 'Org1MSP', 'Org2MSP', 5),
      breach('BATCH-1', 9.9, 6),
      delivered('BATCH-1', 'Org2MSP', 8),
      flagged('BATCH-1', 'temperature breach', 9),
      recalled('BATCH-1', 11),
      cascaded('BATCH-1', ['BATCH-1'], 11),
    ]);

    expect(history.delivered).to.equal(true);
    expect(history.recalled).to.equal(true);
    expect(history.custodyChain.map((step) => step.kind)).to.deep.equal([
      'held',
      'held',
      'delivered',
      'recalled',
    ]);
    expect(history.breaches).to.have.lengthOf(1);
    expect(history.flags).to.have.lengthOf(1);
    expect(history.recallCascades).to.have.lengthOf(1);
    expect(history.eventCount).to.equal(7);
  });
});
