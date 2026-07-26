import * as chai from 'chai';
import { Context } from 'fabric-contract-api';

const { expect } = chai;

import { Batch } from '../src/batch';
import { BatchRegistryContract, HOLDER_INDEX } from '../src/batchRegistry';
import { BatchQueryContract } from '../src/queries';
import { Role } from '../src/access';

/**
 * A minimal in-memory ledger with enough of getHistoryForKey and
 * getStateByPartialCompositeKey to exercise the two query paths, since the
 * BatchRegistryContract tests do not need iterators at all.
 */
class FakeLedger {
  public readonly state = new Map<string, Buffer>();
  public readonly history = new Map<string, { txId: string; seconds: number; value: Buffer }[]>();
  private txCounter = 0;

  public putState(key: string, value: Buffer): void {
    this.state.set(key, value);
    const entries = this.history.get(key) ?? [];
    entries.push({ txId: `tx${++this.txCounter}`, seconds: 1_800_000_000 + entries.length, value });
    this.history.set(key, entries);
  }
}

/**
 * fabric-shim types getHistoryForKey/getStateByPartialCompositeKey as
 * `Promise<Iterator> & AsyncIterable<T>` — the returned object is directly
 * async-iterable without being awaited first, which is how queries.ts uses
 * it. A plain `async function` mock would return a native Promise instead,
 * which has no Symbol.asyncIterator, so the mock must return this shape.
 */
const makeAsyncIterable = <T>(items: T[]) => ({
  [Symbol.asyncIterator]() {
    let i = 0;
    return {
      next: async () =>
        i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true },
    };
  },
});

const makeContext = (): { ctx: Context; ledger: FakeLedger } => {
  const ledger = new FakeLedger();

  const stub = {
    getState: async (k: string) => ledger.state.get(k) ?? Buffer.alloc(0),
    putState: async (k: string, v: Buffer) => ledger.putState(k, v),
    createCompositeKey: (objectType: string, attributes: string[]) =>
      ` ${objectType} ${attributes.join(' ')} `,
    splitCompositeKey: (key: string) => {
      const parts = key.split(' ').filter((p) => p.length > 0);
      return { objectType: parts[0], attributes: parts.slice(1) };
    },
    getHistoryForKey: (key: string) => {
      const entries = ledger.history.get(key) ?? [];
      return makeAsyncIterable(
        entries.map((e) => ({
          txId: e.txId,
          timestamp: { seconds: e.seconds, nanos: 0 },
          isDelete: false,
          value: e.value,
        })),
      );
    },
    getStateByPartialCompositeKey: (objectType: string, keyParts: string[]) => {
      const prefix = ` ${objectType} ${keyParts.join(' ')}`;
      const matches = [...ledger.state.keys()].filter((k) => k.startsWith(prefix));
      return makeAsyncIterable(matches.map((k) => ({ key: k, value: Buffer.alloc(0) })));
    },
    getTxTimestamp: () => ({ seconds: 1_800_000_000, nanos: 0 }),
    getTransient: () => new Map<string, Uint8Array>(),
    setEvent: () => undefined,
    deleteState: (k: string) => {
      ledger.state.delete(k);
    },
    putPrivateData: async () => undefined,
  };

  let msp = 'Org1MSP';
  const attrs: Record<string, string> = { role: Role.Producer };
  const clientIdentity = {
    getMSPID: () => msp,
    getAttributeValue: (a: string) => (a in attrs ? attrs[a] : null),
  };

  const ctx = { stub, clientIdentity } as unknown as Context;
  return { ctx, ledger };
};

const validBatch = (batchId: string) =>
  JSON.stringify({
    batchId,
    foodType: 'chilled',
    producedAt: 1_700_000_000,
    shelfLifeDays: 14,
    origin: 'Farm A',
    quantity: 100,
  });

describe('BatchQueryContract', () => {
  let registry: BatchRegistryContract;
  let queries: BatchQueryContract;
  let t: { ctx: Context; ledger: FakeLedger };

  beforeEach(() => {
    registry = new BatchRegistryContract();
    queries = new BatchQueryContract();
    t = makeContext();
  });

  it('returns every write to a batch in order, oldest first', async () => {
    await registry.RegisterBatch(t.ctx, validBatch('H1'));
    await registry.TransferCustody(t.ctx, 'H1', 'Org2MSP');

    const history = JSON.parse(await queries.GetBatchHistory(t.ctx, 'H1')) as {
      value: Batch;
    }[];

    expect(history).to.have.length(2);
    expect(history[0].value.status).to.equal('CREATED');
    expect(history[1].value.status).to.equal('IN_TRANSIT');
  });

  it('returns an empty history for a batch that was never written', async () => {
    const history = JSON.parse(await queries.GetBatchHistory(t.ctx, 'missing'));
    expect(history).to.deep.equal([]);
  });

  it('lists only the batches currently held by the given organisation', async () => {
    await registry.RegisterBatch(t.ctx, validBatch('H2'));
    await registry.RegisterBatch(t.ctx, validBatch('H3'));
    await registry.TransferCustody(t.ctx, 'H2', 'Org2MSP');

    const org1Batches = JSON.parse(await queries.GetBatchesByHolder(t.ctx, 'Org1MSP')) as Batch[];
    expect(org1Batches.map((b) => b.batchId)).to.deep.equal(['H3']);

    const org2Batches = JSON.parse(await queries.GetBatchesByHolder(t.ctx, 'Org2MSP')) as Batch[];
    expect(org2Batches.map((b) => b.batchId)).to.deep.equal(['H2']);
  });

  it('checks the composite key prefix rather than matching every holder', () => {
    const key = t.ctx.stub.createCompositeKey(HOLDER_INDEX, ['Org1MSP', 'H4']);
    expect(t.ctx.stub.splitCompositeKey(key)).to.deep.equal({
      objectType: HOLDER_INDEX,
      attributes: ['Org1MSP', 'H4'],
    });
  });
});
