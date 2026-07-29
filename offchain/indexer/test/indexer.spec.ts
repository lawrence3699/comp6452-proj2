import { expect } from 'chai';
import {
  parseEvent,
  createStore,
  record,
  reset,
  historyFor,
  IndexedEvent,
} from '../src';

describe('parseEvent', () => {
  it('decodes a BatchRegistered event, keeping extra fields as details', () => {
    const payload = JSON.stringify({ batchId: 'B1', producer: 'Org1MSP', timestamp: 1000 });
    const event = parseEvent('BatchRegistered', payload);
    expect(event.name).to.equal('BatchRegistered');
    expect(event.batchId).to.equal('B1');
    expect(event.timestamp).to.equal(1000);
    expect(event.details).to.deep.equal({ producer: 'Org1MSP' });
  });

  it('decodes a CustodyTransferred event', () => {
    const payload = JSON.stringify({ batchId: 'B1', from: 'Org1MSP', to: 'Org2MSP', timestamp: 2000 });
    const event = parseEvent('CustodyTransferred', payload);
    expect(event.details).to.deep.equal({ from: 'Org1MSP', to: 'Org2MSP' });
  });

  it('decodes a BatchFlagged event, ignoring extra fields like flaggedBy', () => {
    const payload = JSON.stringify({ batchId: 'B1', reason: 'temp breach', evidenceHash: 'abc', flaggedBy: 'oracle', timestamp: 3000 });
    const event = parseEvent('BatchFlagged', payload);
    expect(event.details).to.deep.equal({ reason: 'temp breach', evidenceHash: 'abc', flaggedBy: 'oracle' });
  });

  it('decodes a BatchRecalled event', () => {
    const event = parseEvent('BatchRecalled', JSON.stringify({ batchId: 'B1', timestamp: 4000 }));
    expect(event.name).to.equal('BatchRecalled');
    expect(event.batchId).to.equal('B1');
    expect(event.details).to.deep.equal({});
  });

  it('accepts a Buffer payload and carries ledger coordinates', () => {
    const payload = Buffer.from(JSON.stringify({ batchId: 'B1', timestamp: 1 }));
    const event = parseEvent('BatchRegistered', payload, { blockNumber: 7, txId: 'tx-9' });
    expect(event.blockNumber).to.equal(7);
    expect(event.txId).to.equal('tx-9');
  });

  it('rejects an unknown event name', () => {
    expect(() => parseEvent('SomethingElse', '{"batchId":"B1"}')).to.throw(/unknown chaincode event/);
  });

  it('rejects a payload with no batchId', () => {
    expect(() => parseEvent('BatchRegistered', '{"timestamp":1}')).to.throw(/missing a batchId/);
  });
});

describe('event index', () => {
  const ev = (batchId: string, timestamp: number, blockNumber: number): IndexedEvent => ({
    name: 'CustodyTransferred',
    batchId,
    timestamp,
    details: {},
    blockNumber,
  });

  it('returns one batch history oldest-first, isolated from other batches', () => {
    const store = createStore();
    store.record(ev('B1', 300, 3));
    store.record(ev('B2', 150, 2));
    store.record(ev('B1', 100, 1));

    const history = store.history('B1');
    expect(history.map((e) => e.timestamp)).to.deep.equal([100, 300]);
  });

  it('breaks equal timestamps by block number', () => {
    const store = createStore();
    store.record(ev('B1', 100, 5));
    store.record(ev('B1', 100, 2));
    expect(store.history('B1').map((e) => e.blockNumber)).to.deep.equal([2, 5]);
  });

  it('returns an empty history for an unknown batch', () => {
    expect(createStore().history('nope')).to.deep.equal([]);
  });

  it('feeds the default index used by historyFor', async () => {
    reset();
    record(ev('B9', 500, 1));
    expect(await historyFor('B9')).to.have.length(1);
    reset();
    expect(await historyFor('B9')).to.deep.equal([]);
  });
});
