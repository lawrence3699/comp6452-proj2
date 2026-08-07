import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Context } from 'fabric-contract-api';

chai.use(chaiAsPromised);
const { expect } = chai;

import {
  BatchPrivateDetails,
  COLLECTION,
  TRANSIENT_KEY,
  getPrivateDetails,
  getPrivateDetailsHash,
  putPrivateDetails,
  readTransientDetails,
} from '../src/privateData';

/**
 * Unit tests for the private data collection helpers.
 *
 * The stub mirrors the mocked-ledger pattern of batchRegistry.spec.ts, extended
 * with the private-data APIs. Private state is keyed per collection so a test
 * can prove writes land in batchPrivateDetails and nowhere else — the
 * collection name is part of the endorsement/dissemination policy, so writing
 * to the wrong one would silently change who can read the price.
 */

interface TestCtx {
  ctx: Context;
  /** collection -> key -> value, standing in for each org's SideDB. */
  privateState: Map<string, Map<string, Buffer>>;
  /** collection -> key -> hash bytes, standing in for the public hash ledger. */
  privateHashes: Map<string, Map<string, Uint8Array>>;
  transient: Map<string, Uint8Array>;
}

const makeContext = (): TestCtx => {
  const privateState = new Map<string, Map<string, Buffer>>();
  const privateHashes = new Map<string, Map<string, Uint8Array>>();
  const transient = new Map<string, Uint8Array>();

  const stub = {
    putPrivateData: async (collection: string, key: string, value: Buffer) => {
      const bucket = privateState.get(collection) ?? new Map<string, Buffer>();
      bucket.set(key, value);
      privateState.set(collection, bucket);
    },
    getPrivateData: async (collection: string, key: string) =>
      privateState.get(collection)?.get(key) ?? Buffer.alloc(0),
    getPrivateDataHash: async (collection: string, key: string) =>
      privateHashes.get(collection)?.get(key) ?? Buffer.alloc(0),
    getTransient: () => transient,
  };

  const ctx = { stub } as unknown as Context;
  return { ctx, privateState, privateHashes, transient };
};

const details = (over: Partial<BatchPrivateDetails> = {}): BatchPrivateDetails => ({
  batchId: 'B1',
  unitPrice: 4.25,
  inspectionNotes: 'grade A',
  ...over,
});

describe('privateData.readTransientDetails', () => {
  let t: TestCtx;

  beforeEach(() => {
    t = makeContext();
  });

  it('returns null when the transient map lacks the key', () => {
    // Absence means the caller chose not to supply commercial terms; the
    // contract must treat that as "no private write", not an error.
    expect(readTransientDetails(t.ctx, 'B1')).to.equal(null);
  });

  it('returns null when the transient value is present but empty', () => {
    t.transient.set(TRANSIENT_KEY, new Uint8Array(0));
    expect(readTransientDetails(t.ctx, 'B1')).to.equal(null);
  });

  it('ignores transient entries under any other key', () => {
    t.transient.set('wrong_key', Buffer.from(JSON.stringify({ unitPrice: 1 })));
    expect(readTransientDetails(t.ctx, 'B1')).to.equal(null);
  });

  it('parses valid transient JSON and stamps the batchId from the argument', () => {
    // The client-supplied batchId inside the payload must NOT win: the details
    // are keyed by the batch being registered, not by whatever the transient
    // blob claims, or a client could attach its price to someone else's batch.
    t.transient.set(
      TRANSIENT_KEY,
      Buffer.from(JSON.stringify({ batchId: 'SPOOFED', unitPrice: '9.5', inspectionNotes: 'ok' })),
    );

    const parsed = readTransientDetails(t.ctx, 'B7');
    expect(parsed).to.deep.equal({
      batchId: 'B7',
      unitPrice: 9.5,
      inspectionNotes: 'ok',
    });
  });

  it('defaults inspectionNotes to an empty string when omitted', () => {
    t.transient.set(TRANSIENT_KEY, Buffer.from(JSON.stringify({ unitPrice: 2 })));
    const parsed = readTransientDetails(t.ctx, 'B1');
    expect(parsed?.inspectionNotes).to.equal('');
    expect(parsed?.unitPrice).to.equal(2);
  });

  it('throws on malformed transient JSON', () => {
    t.transient.set(TRANSIENT_KEY, Buffer.from('{not json'));
    expect(() => readTransientDetails(t.ctx, 'B1')).to.throw(SyntaxError);
  });

  it('coerces a non-numeric unitPrice to NaN for putPrivateDetails to reject', () => {
    // readTransientDetails does not validate; it normalises. The NaN it
    // produces here is exactly what putPrivateDetails refuses below, so the
    // two functions together still reject the bad payload.
    t.transient.set(TRANSIENT_KEY, Buffer.from(JSON.stringify({ unitPrice: 'a lot' })));
    const parsed = readTransientDetails(t.ctx, 'B1');
    expect(Number.isNaN(parsed?.unitPrice)).to.equal(true);
  });
});

describe('privateData.putPrivateDetails', () => {
  let t: TestCtx;

  beforeEach(() => {
    t = makeContext();
  });

  it('writes the serialized details into the batchPrivateDetails collection', async () => {
    const d = details({ batchId: 'B9', unitPrice: 12.5, inspectionNotes: 'chilled ok' });
    await putPrivateDetails(t.ctx, d);

    const stored = t.privateState.get(COLLECTION)?.get('B9');
    expect(stored).to.not.equal(undefined);
    // Byte-exact round trip: the private-data hash on the public ledger is
    // computed over these bytes, so serialization must be deterministic.
    expect(stored?.toString()).to.equal(JSON.stringify(d));
    expect(JSON.parse(stored!.toString())).to.deep.equal({
      batchId: 'B9',
      unitPrice: 12.5,
      inspectionNotes: 'chilled ok',
    });
    // Nothing may leak into any other collection.
    expect([...t.privateState.keys()]).to.deep.equal([COLLECTION]);
  });

  it('accepts a zero unit price', async () => {
    // Free samples are legitimate; only negative and non-finite are nonsense.
    await putPrivateDetails(t.ctx, details({ unitPrice: 0 }));
    expect(t.privateState.get(COLLECTION)?.has('B1')).to.equal(true);
  });

  it('rejects details without a batchId', async () => {
    await expect(putPrivateDetails(t.ctx, details({ batchId: '' }))).to.be.rejectedWith(
      /batchId is required/,
    );
    expect(t.privateState.size).to.equal(0);
  });

  it('rejects a negative unitPrice', async () => {
    await expect(putPrivateDetails(t.ctx, details({ unitPrice: -1 }))).to.be.rejectedWith(
      /unitPrice must be a non-negative number/,
    );
    expect(t.privateState.size).to.equal(0);
  });

  it('rejects a NaN unitPrice', async () => {
    await expect(putPrivateDetails(t.ctx, details({ unitPrice: Number.NaN }))).to.be.rejectedWith(
      /unitPrice must be a non-negative number/,
    );
  });

  it('rejects an infinite unitPrice', async () => {
    await expect(
      putPrivateDetails(t.ctx, details({ unitPrice: Number.POSITIVE_INFINITY })),
    ).to.be.rejectedWith(/unitPrice must be a non-negative number/);
  });
});

describe('privateData.getPrivateDetails', () => {
  let t: TestCtx;

  beforeEach(() => {
    t = makeContext();
  });

  it('throws a combined missing-or-forbidden error when no private row exists', async () => {
    // "Missing" and "not a collection member" must be indistinguishable, or
    // the error channel itself leaks which batches exist.
    await expect(getPrivateDetails(t.ctx, 'GHOST')).to.be.rejectedWith(
      /no private details readable for batch GHOST/,
    );
    await expect(getPrivateDetails(t.ctx, 'GHOST')).to.be.rejectedWith(
      new RegExp(`collection ${COLLECTION}`),
    );
  });

  it('returns parsed details when a private row exists', async () => {
    const d = details({ batchId: 'B3', unitPrice: 7.75, inspectionNotes: 'minor bruising' });
    t.privateState.set(COLLECTION, new Map([['B3', Buffer.from(JSON.stringify(d))]]));

    const got = await getPrivateDetails(t.ctx, 'B3');
    expect(got).to.deep.equal({
      batchId: 'B3',
      unitPrice: 7.75,
      inspectionNotes: 'minor bruising',
    });
  });

  it('round-trips what putPrivateDetails wrote', async () => {
    const d = details({ batchId: 'B4' });
    await putPrivateDetails(t.ctx, d);
    expect(await getPrivateDetails(t.ctx, 'B4')).to.deep.equal(d);
  });
});

describe('privateData.getPrivateDetailsHash', () => {
  let t: TestCtx;

  beforeEach(() => {
    t = makeContext();
  });

  it('hex-encodes the hash bytes the stub returns', async () => {
    // Raw bytes chosen so the expected hex exercises zero-padding (0x01 ->
    // "01") and high bytes (0xff -> "ff") — a naive toString(16) join would
    // drop the leading zero.
    t.privateHashes.set(
      COLLECTION,
      new Map([['B5', Uint8Array.from([0x01, 0xab, 0x00, 0xff, 0x10])]]),
    );

    expect(await getPrivateDetailsHash(t.ctx, 'B5')).to.equal('01ab00ff10');
  });

  it('throws when the ledger holds no hash for the batch', async () => {
    await expect(getPrivateDetailsHash(t.ctx, 'GHOST')).to.be.rejectedWith(
      /no private data hash on the ledger for batch GHOST/,
    );
  });
});
