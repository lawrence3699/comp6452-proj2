/**
 * Off-chain storage adapter — owner: person 3.
 *
 * Inspection reports, photographs and raw sensor series live here. Only the
 * returned hash is anchored on chain.
 *
 * The store is content-addressed: an object's identity IS the SHA-256 of its
 * bytes, so the same hash always maps to the same content. On retrieval the
 * bytes are re-hashed and checked against the requested hash, which means a
 * tampered object is detected rather than silently returned. Swapping this
 * filesystem backend for IPFS or a cloud bucket later keeps the same contract:
 * the hash is what gets anchored on chain.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface StoredObject {
  readonly hash: string;
  readonly location: string;
}

export interface Store {
  put(payload: Buffer, contentType: string): Promise<StoredObject>;
  get(hash: string): Promise<Buffer>;
}

const sha256 = (payload: Buffer): string =>
  createHash('sha256').update(payload).digest('hex');

/**
 * Create a content-addressed store rooted at `baseDir`. Injecting the directory
 * keeps the store hermetic under test; production uses the default store below.
 */
export const createStore = (baseDir: string): Store => {
  const blobPath = (hash: string): string => join(baseDir, hash);

  return {
    async put(payload: Buffer, contentType: string): Promise<StoredObject> {
      const hash = sha256(payload);
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(blobPath(hash), payload);
      // Record the content type alongside the blob for callers that need it;
      // it is metadata only and never affects the content hash.
      await fs.writeFile(`${blobPath(hash)}.type`, contentType, 'utf8');
      return { hash, location: blobPath(hash) };
    },

    async get(hash: string): Promise<Buffer> {
      let payload: Buffer;
      try {
        payload = await fs.readFile(blobPath(hash));
      } catch {
        throw new Error(`no object stored for hash ${hash}`);
      }
      const actual = sha256(payload);
      if (actual !== hash) {
        throw new Error(
          `stored object for ${hash} is corrupt: content now hashes to ${actual}`,
        );
      }
      return payload;
    },
  };
};

const defaultStore = createStore(
  process.env.OFFCHAIN_STORAGE_DIR ?? join(tmpdir(), 'offchain-storage'),
);

export const put = (payload: Buffer, contentType: string): Promise<StoredObject> =>
  defaultStore.put(payload, contentType);

export const get = (hash: string): Promise<Buffer> => defaultStore.get(hash);
