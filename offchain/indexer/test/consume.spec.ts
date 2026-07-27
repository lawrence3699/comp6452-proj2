import { expect } from 'chai';
import { consume, createStore, EventSource, RawChaincodeEvent } from '../src';

const raw = (
  eventName: string,
  body: Record<string, unknown>,
  blockNumber: number,
): RawChaincodeEvent => ({
  eventName,
  payload: Buffer.from(JSON.stringify(body)),
  blockNumber,
  transactionId: `tx-${blockNumber}`,
});

const sourceOf = (events: RawChaincodeEvent[]): EventSource => ({
  async *events() {
    for (const event of events) {
      yield event;
    }
  },
});

describe('consume', () => {
  it('indexes understood events by batch and skips the rest', async () => {
    const store = createStore();
    const source = sourceOf([
      raw('BatchRegistered', { batchId: 'B1', producer: 'Org1MSP', timestamp: 100 }, 1),
      raw('CustodyTransferred', { batchId: 'B1', from: 'Org1MSP', to: 'Org2MSP', timestamp: 200 }, 2),
      raw('SomethingUnindexed', { batchId: 'B1', timestamp: 250 }, 3),
      raw('BatchFlagged', { batchId: 'B2', reason: 'breach', evidenceHash: 'h', timestamp: 300 }, 4),
    ]);

    await consume(source, store);

    const b1 = store.history('B1');
    expect(b1.map((e) => e.name)).to.deep.equal(['BatchRegistered', 'CustodyTransferred']);
    expect(b1[1].blockNumber).to.equal(2);
    expect(b1[1].txId).to.equal('tx-2');

    expect(store.history('B2').map((e) => e.name)).to.deep.equal(['BatchFlagged']);
  });

  it('does not throw when the whole stream is unindexed', async () => {
    const store = createStore();
    await consume(sourceOf([raw('Noise', { batchId: 'B1' }, 1)]), store);
    expect(store.history('B1')).to.deep.equal([]);
  });
});
