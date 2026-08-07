/**
 * Off-chain storage adapter — owner: person 3.
 *
 * Inspection reports, photographs and raw sensor series live here. Only the
 * returned hash is anchored on chain (Batch.reportHash, and the oracle's
 * rawDataHash argument), which is what keeps bulk data off the ledger while
 * still making it tamper-evident.
 *
 * Content addressing is the whole design: the key IS SHA-256 of the bytes, so
 * "has this object been altered since it was anchored?" is answered by
 * re-hashing on read rather than by trusting the store. `get()` therefore
 * verifies before returning and throws on mismatch — silently returning
 * corrupted bytes would defeat the anchor.
 *
 * Two backends ship: the local filesystem (default) and `IpfsBackend` in
 * `ipfs.ts` (kubo HTTP API; select with STORAGE_BACKEND=ipfs). Both sit behind
 * `configureBackend()`, so every caller, every test and the verification path
 * below are identical under either. The only visible change is
 * `StoredObject.location`, which becomes `ipfs://<cid>`. We deliberately keep
 * our own SHA-256 as the anchored value rather than the CID, because a CID
 * depends on IPFS chunking parameters and the chaincode must not care which
 * storage backend produced the anchor.
 */

import * as crypto from 'crypto';
import { Backend } from './backend';
import { FilesystemBackend } from './filesystem';
import { IpfsBackend } from './ipfs';

export interface StoredObject {
  readonly hash: string;
  readonly location: string;
}

export { Backend } from './backend';
export { DEFAULT_ROOT, FilesystemBackend, storageRoot } from './filesystem';
export { DEFAULT_IPFS_API_URL, IpfsBackend, ipfsApiUrl } from './ipfs';

/** Hex SHA-256 of the payload. This is the value anchored on chain. */
export const hashOf = (payload: Buffer): string =>
  crypto.createHash('sha256').update(payload).digest('hex');

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Resolved lazily rather than at import time, so that a change to
 * OFFCHAIN_STORAGE_ROOT after the module is loaded — which is exactly what a
 * test or a wrapper script does — is still honoured.
 */
let backend: Backend | undefined;

/** Swap the backend. Used by tests, and the hook an IPFS backend would use. */
export const configureBackend = (next: Backend | undefined): void => {
  backend = next;
};

/**
 * Backend chosen by STORAGE_BACKEND. Unknown values throw rather than fall
 * back to the filesystem: silently storing evidence somewhere other than
 * where the operator asked would be worse than failing loudly.
 */
const backendFromEnv = (): Backend => {
  const selected = process.env.STORAGE_BACKEND;
  if (selected === undefined || selected === '' || selected === 'filesystem') {
    return new FilesystemBackend();
  }
  if (selected === 'ipfs') {
    return new IpfsBackend();
  }
  throw new Error(
    `Unknown STORAGE_BACKEND "${selected}"; expected "filesystem" or "ipfs"`,
  );
};

export const currentBackend = (): Backend => {
  if (backend === undefined) {
    backend = backendFromEnv();
  }
  return backend;
};

/**
 * Store `payload` and return its content hash plus a backend-specific
 * location. Storing the same bytes twice yields the same hash and overwrites
 * harmlessly, so a retried oracle run does not duplicate data.
 */
export const put = async (payload: Buffer, contentType: string): Promise<StoredObject> => {
  if (!Buffer.isBuffer(payload)) {
    throw new Error('storage.put requires a Buffer payload');
  }
  if (payload.length === 0) {
    // An empty object hashes to a well-known constant and carries no evidence;
    // anchoring it on chain would be a false assurance.
    throw new Error('storage.put refuses an empty payload');
  }
  if (contentType === '') {
    throw new Error('storage.put requires a content type');
  }
  const hash = hashOf(payload);
  const location = await currentBackend().write(hash, payload, contentType);
  return { hash, location };
};

/**
 * Fetch by hash and re-verify before returning. Throws if the object is
 * unknown, or if the stored bytes no longer hash to the requested value — that
 * is the tamper detection the on-chain anchor exists to enable.
 */
export const get = async (hash: string): Promise<Buffer> => {
  if (!SHA256_HEX.test(hash)) {
    throw new Error(`storage.get requires a lowercase hex SHA-256 hash, got: ${hash}`);
  }
  const payload = await currentBackend().read(hash);
  if (payload === undefined) {
    throw new Error(`storage.get found no object for hash ${hash}`);
  }
  const actual = hashOf(payload);
  if (actual !== hash) {
    throw new Error(
      `storage.get integrity check failed for ${hash}: stored bytes hash to ${actual}. ` +
        'The object has been tampered with or corrupted.',
    );
  }
  return payload;
};

/** Content type recorded at put time, or undefined if the object is unknown. */
export const contentTypeOf = async (hash: string): Promise<string | undefined> =>
  currentBackend().readContentType(hash);

/** True if the stored object still matches its hash. Never throws — for health checks. */
export const verify = async (hash: string): Promise<boolean> => {
  try {
    await get(hash);
    return true;
  } catch {
    return false;
  }
};

/** Convenience for the common case: store a JSON document, return its anchor. */
export const putJson = async (value: unknown): Promise<StoredObject> =>
  put(Buffer.from(JSON.stringify(value), 'utf8'), 'application/json');

/** Inverse of putJson: fetch, verify, parse. */
export const getJson = async <T>(hash: string): Promise<T> =>
  JSON.parse((await get(hash)).toString('utf8')) as T;
