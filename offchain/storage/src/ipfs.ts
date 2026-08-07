/**
 * IPFS storage backend (kubo HTTP API) — owner: person 3.
 *
 * Talks to a kubo daemon over its HTTP API: `write` -> POST /api/v0/add
 * (cid-version=1, multipart field `file`), `read` -> POST /api/v0/cat?arg=<cid>.
 * The fetch implementation is injectable so unit tests fabricate responses and
 * never need a daemon; the default is the global fetch shipped with Node 18+.
 *
 * WHY the on-chain anchor stays OUR SHA-256 and never becomes the CID: the
 * chaincode side is backend-agnostic — Batch.reportHash and the oracle's
 * rawDataHash are defined as "hex SHA-256 of the bytes", and a CID is not a
 * plain SHA-256 of the content (it hashes an IPFS-specific encoding and varies
 * with chunking/codec parameters). Anchoring a CID would couple the ledger to
 * one backend's storage internals and break the re-hash-on-read tamper check
 * in `index.ts`. The CID is therefore backend bookkeeping only: it appears in
 * `location` (`ipfs://<cid>`) and in the hash->CID map below, which this
 * backend needs because the `Backend` interface is keyed by SHA-256 while the
 * IPFS API retrieves by CID. The map is in-process state, same trust model as
 * the filesystem backend's sidecar metadata: losing it loses the pointer, not
 * the integrity guarantee, because `get()` re-hashes whatever comes back.
 */

import { Backend } from './backend';

export const DEFAULT_IPFS_API_URL = 'http://127.0.0.1:5001';

/** kubo API endpoint. Env-driven so a non-local daemon needs no code change. */
export const ipfsApiUrl = (): string => {
  const configured = process.env.IPFS_API_URL;
  return configured === undefined || configured === '' ? DEFAULT_IPFS_API_URL : configured;
};

export interface IpfsBackendOptions {
  readonly apiUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface Entry {
  readonly cid: string;
  readonly contentType: string;
}

/** Shape of a successful /api/v0/add response; kubo emits `Hash`, some proxies `Cid`. */
interface AddResponse {
  readonly Hash?: unknown;
  readonly Cid?: unknown;
}

export class IpfsBackend implements Backend {
  public readonly kind = 'ipfs';

  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly entries = new Map<string, Entry>();

  public constructor(options: IpfsBackendOptions = {}) {
    this.apiUrl = options.apiUrl ?? ipfsApiUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The CID recorded for `hash`, or undefined. Exposed for tests and diagnostics. */
  public cidFor(hash: string): string | undefined {
    return this.entries.get(hash)?.cid;
  }

  public async write(hash: string, payload: Buffer, contentType: string): Promise<string> {
    // The multipart body is built by hand rather than via FormData so the exact
    // bytes on the wire are deterministic and inspectable by the unit tests.
    // The boundary embeds a random suffix purely so payload bytes cannot
    // collide with it.
    const boundary = `----offchain-storage-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${hash}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      ),
      payload,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const response = await this.fetchImpl(`${this.apiUrl}/api/v0/add?cid-version=1`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!response.ok) {
      throw new Error(`ipfs add failed: HTTP ${response.status} from ${this.apiUrl}`);
    }

    let parsed: AddResponse;
    try {
      parsed = JSON.parse(await response.text()) as AddResponse;
    } catch {
      throw new Error(`ipfs add failed: malformed JSON response from ${this.apiUrl}`);
    }
    const cid = typeof parsed.Hash === 'string' && parsed.Hash !== ''
      ? parsed.Hash
      : typeof parsed.Cid === 'string' && parsed.Cid !== ''
        ? parsed.Cid
        : undefined;
    if (cid === undefined) {
      throw new Error(`ipfs add failed: response carries no Hash/Cid from ${this.apiUrl}`);
    }

    this.entries.set(hash, { cid, contentType });
    return `${this.kind}://${cid}`;
  }

  public async read(hash: string): Promise<Buffer | undefined> {
    const entry = this.entries.get(hash);
    if (entry === undefined) {
      // Unknown key is "not here", same contract as the filesystem backend —
      // without a CID there is nothing to ask the daemon for.
      return undefined;
    }
    const response = await this.fetchImpl(
      `${this.apiUrl}/api/v0/cat?arg=${encodeURIComponent(entry.cid)}`,
      { method: 'POST' },
    );
    if (!response.ok) {
      throw new Error(`ipfs cat failed: HTTP ${response.status} for ${entry.cid} from ${this.apiUrl}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  public async readContentType(hash: string): Promise<string | undefined> {
    return this.entries.get(hash)?.contentType;
  }
}
