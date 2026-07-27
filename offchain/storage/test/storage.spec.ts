import { expect } from 'chai';
import { promises as fs, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore, Store } from '../src';

/** Assert a promise rejects with a message matching `pattern` (no extra deps). */
const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  expect.fail('expected the promise to reject, but it resolved');
};

describe('content-addressed storage', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-test-'));
    store = createStore(dir);
  });

  it('addresses an object by a SHA-256 hex digest of its bytes', async () => {
    const { hash } = await store.put(Buffer.from('inspection report v1'), 'text/plain');
    expect(hash).to.match(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: identical content yields the same hash', async () => {
    const a = await store.put(Buffer.from('same bytes'), 'text/plain');
    const b = await store.put(Buffer.from('same bytes'), 'application/json');
    expect(b.hash).to.equal(a.hash);
  });

  it('round-trips the exact bytes that were stored', async () => {
    const payload = Buffer.from([0x00, 0x01, 0xff, 0x42, 0x7f]);
    const { hash } = await store.put(payload, 'application/octet-stream');
    const fetched = await store.get(hash);
    expect(fetched.equals(payload)).to.equal(true);
  });

  it('throws for a hash that was never stored', async () => {
    await rejectsWith(store.get('0'.repeat(64)), /no object stored/);
  });

  it('detects a tampered object instead of returning it', async () => {
    const { hash, location } = await store.put(Buffer.from('trusted'), 'text/plain');
    await fs.writeFile(location, Buffer.from('tampered'));
    await rejectsWith(store.get(hash), /corrupt/);
  });
});
