import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FilesystemBackend,
  configureBackend,
  contentTypeOf,
  currentBackend,
  get,
  getJson,
  hashOf,
  put,
  putJson,
  storageRoot,
  verify,
  DEFAULT_ROOT,
} from '../src/index';

/**
 * Every test runs against a throwaway root under the OS temp directory, so the
 * suite never touches the real store and needs no Fabric network.
 */
describe('storage adapter', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'offchain-store-'));
    configureBackend(new FilesystemBackend(root));
  });

  afterEach(async () => {
    configureBackend(undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('put/get round trip', () => {
    it('returns the SHA-256 of the payload as the hash', async () => {
      const payload = Buffer.from('inspection report body', 'utf8');
      const stored = await put(payload, 'text/plain');

      expect(stored.hash).to.equal(hashOf(payload));
      expect(stored.hash).to.match(/^[0-9a-f]{64}$/);
    });

    it('round trips the exact bytes that were stored', async () => {
      const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
      const stored = await put(payload, 'application/octet-stream');

      const fetched = await get(stored.hash);

      expect(fetched.equals(payload)).to.equal(true);
    });

    it('records the content type alongside the object', async () => {
      const stored = await put(Buffer.from('{"a":1}', 'utf8'), 'application/json');

      expect(await contentTypeOf(stored.hash)).to.equal('application/json');
    });

    it('is idempotent: identical bytes yield the same hash and stay readable', async () => {
      const payload = Buffer.from('same series twice', 'utf8');

      const first = await put(payload, 'application/json');
      const second = await put(payload, 'application/json');

      expect(second.hash).to.equal(first.hash);
      expect((await get(first.hash)).equals(payload)).to.equal(true);
    });

    it('round trips JSON through putJson/getJson', async () => {
      const value = { batchId: 'BATCH-1', readings: [1, 2, 3] };

      const stored = await putJson(value);

      expect(await getJson<typeof value>(stored.hash)).to.deep.equal(value);
    });

    it('reports a location that names the backend', async () => {
      const stored = await put(Buffer.from('x', 'utf8'), 'text/plain');

      expect(stored.location).to.match(/^file:\/\//);
      expect(stored.location).to.contain(stored.hash);
    });
  });

  describe('tamper detection', () => {
    it('throws when the stored bytes no longer hash to the requested hash', async () => {
      const payload = Buffer.from('temperature series v1', 'utf8');
      const stored = await put(payload, 'application/json');
      const backend = currentBackend() as FilesystemBackend;

      // Corrupt the object on disk behind the adapter's back — exactly what an
      // attacker with filesystem access would do after the hash was anchored.
      await fs.writeFile(backend.objectPath(stored.hash), 'temperature series TAMPERED');

      let thrown: Error | undefined;
      try {
        await get(stored.hash);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown, 'get() must reject tampered content').to.be.instanceOf(Error);
      expect(thrown?.message).to.contain('integrity check failed');
      expect(thrown?.message).to.contain(stored.hash);
    });

    it('detects truncation as well as substitution', async () => {
      const payload = Buffer.from('a long enough series to truncate', 'utf8');
      const stored = await put(payload, 'application/json');
      const backend = currentBackend() as FilesystemBackend;

      await fs.writeFile(backend.objectPath(stored.hash), payload.subarray(0, 5));

      let thrown: Error | undefined;
      try {
        await get(stored.hash);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('integrity check failed');
    });

    it('verify() reports false for a tampered object and true for a clean one', async () => {
      const clean = await put(Buffer.from('clean', 'utf8'), 'text/plain');
      const dirty = await put(Buffer.from('dirty', 'utf8'), 'text/plain');
      const backend = currentBackend() as FilesystemBackend;

      await fs.writeFile(backend.objectPath(dirty.hash), 'not dirty any more');

      expect(await verify(clean.hash)).to.equal(true);
      expect(await verify(dirty.hash)).to.equal(false);
    });
  });

  describe('unknown and invalid hashes', () => {
    it('throws for a well-formed hash that was never stored', async () => {
      const unknown = 'a'.repeat(64);

      let thrown: Error | undefined;
      try {
        await get(unknown);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown, 'get() must reject an unknown hash').to.be.instanceOf(Error);
      expect(thrown?.message).to.contain('no object for hash');
    });

    it('rejects a malformed hash before touching the backend', async () => {
      let thrown: Error | undefined;
      try {
        await get('not-a-hash');
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('lowercase hex SHA-256');
    });

    it('contentTypeOf returns undefined for an unknown hash', async () => {
      expect(await contentTypeOf('b'.repeat(64))).to.equal(undefined);
    });
  });

  describe('put validation', () => {
    it('refuses an empty payload', async () => {
      let thrown: Error | undefined;
      try {
        await put(Buffer.alloc(0), 'text/plain');
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('empty payload');
    });

    it('refuses a missing content type', async () => {
      let thrown: Error | undefined;
      try {
        await put(Buffer.from('x', 'utf8'), '');
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('content type');
    });
  });

  describe('configuration', () => {
    it('defaults the root to .offchain-store when the env var is unset', () => {
      const previous = process.env.OFFCHAIN_STORAGE_ROOT;
      delete process.env.OFFCHAIN_STORAGE_ROOT;
      try {
        expect(storageRoot()).to.equal(DEFAULT_ROOT);
      } finally {
        if (previous !== undefined) {
          process.env.OFFCHAIN_STORAGE_ROOT = previous;
        }
      }
    });

    it('honours OFFCHAIN_STORAGE_ROOT', () => {
      const previous = process.env.OFFCHAIN_STORAGE_ROOT;
      process.env.OFFCHAIN_STORAGE_ROOT = '/tmp/somewhere-else';
      try {
        expect(storageRoot()).to.equal('/tmp/somewhere-else');
      } finally {
        if (previous === undefined) {
          delete process.env.OFFCHAIN_STORAGE_ROOT;
        } else {
          process.env.OFFCHAIN_STORAGE_ROOT = previous;
        }
      }
    });
  });
});
