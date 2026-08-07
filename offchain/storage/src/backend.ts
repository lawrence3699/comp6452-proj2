/**
 * Storage backend contract — owner: person 3.
 *
 * The adapter in `index.ts` owns hashing and verification; a backend is a dumb
 * content-addressed blob store keyed by the hash the adapter computes. Keeping
 * the verification out of the backend is deliberate: an IPFS backend would
 * happily return whatever bytes the network served, and it is precisely that
 * "trust the remote" step we want to check.
 *
 * Two implementations ship behind this interface: `FilesystemBackend`
 * (default) and `IpfsBackend` (`write` -> /api/v0/add, `read` -> /api/v0/cat,
 * `location` -> `ipfs://<cid>`; select with STORAGE_BACKEND=ipfs). Both drop
 * in behind `configureBackend()` with no change to callers or to the tamper
 * check — see the note in `index.ts`.
 */

export interface Backend {
  /** Human-readable name of the backend, surfaced in StoredObject.location. */
  readonly kind: string;
  /** Persist `payload` under `hash`. Must be idempotent: re-putting identical bytes is a no-op. */
  readonly write: (hash: string, payload: Buffer, contentType: string) => Promise<string>;
  /** Return the stored bytes, or undefined if the key is unknown. */
  readonly read: (hash: string) => Promise<Buffer | undefined>;
  /** Return the recorded content type, or undefined if the key is unknown. */
  readonly readContentType: (hash: string) => Promise<string | undefined>;
}
