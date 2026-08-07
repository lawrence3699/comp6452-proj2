import { expect } from 'chai';
import {
  DEFAULT_IPFS_API_URL,
  FilesystemBackend,
  IpfsBackend,
  configureBackend,
  currentBackend,
  get,
  hashOf,
  ipfsApiUrl,
  put,
} from '../src/index';

/**
 * The IPFS backend is exercised entirely through its injectable fetch: the
 * fake below records every request and fabricates kubo-shaped responses, so
 * the suite needs no daemon and asserts the exact bytes on the wire.
 *
 * Test doubles here avoid constructor parameter properties on purpose — the
 * toolchain must stay compatible with strip-only TS transforms, which cannot
 * express the implicit field assignment that parameter properties rely on.
 */

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type Responder = (url: string, init: RequestInit | undefined) => Response;

class FakeFetch {
  public readonly calls: RecordedCall[] = [];
  private readonly responder: Responder;

  public constructor(responder: Responder) {
    this.responder = responder;
  }

  // Bound arrow so it can be passed as `fetchImpl` without losing `this`.
  public readonly impl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    this.calls.push({ url, init });
    return this.responder(url, init);
  };
}

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const API = 'http://ipfs.test:5001';

const bodyBytes = (init: RequestInit | undefined): Buffer => {
  const body = init?.body;
  if (Buffer.isBuffer(body)) {
    return body;
  }
  throw new Error('expected the request body to be a Buffer');
};

/** kubo-shaped success for /add plus raw bytes for /cat, keyed on the URL. */
const kuboResponder = (catPayload: Buffer): Responder => (url) => {
  if (url.includes('/api/v0/add')) {
    return new Response(JSON.stringify({ Hash: CID }), { status: 200 });
  }
  if (url.includes('/api/v0/cat')) {
    return new Response(new Uint8Array(catPayload), { status: 200 });
  }
  return new Response('unexpected endpoint', { status: 404 });
};

const expectRejection = async (operation: Promise<unknown>): Promise<Error> => {
  let thrown: Error | undefined;
  try {
    await operation;
  } catch (error) {
    thrown = error as Error;
  }
  expect(thrown, 'expected the operation to reject').to.be.instanceOf(Error);
  return thrown as Error;
};

describe('ipfs backend', () => {
  // Snapshot the selection env vars so a process launched with
  // STORAGE_BACKEND/IPFS_API_URL already set (as the e2e harness does) gets
  // them back — the suite must not destroy its caller's environment.
  let savedBackendEnv: string | undefined;
  let savedApiUrlEnv: string | undefined;

  before(() => {
    savedBackendEnv = process.env.STORAGE_BACKEND;
    savedApiUrlEnv = process.env.IPFS_API_URL;
  });

  after(() => {
    if (savedBackendEnv === undefined) {
      delete process.env.STORAGE_BACKEND;
    } else {
      process.env.STORAGE_BACKEND = savedBackendEnv;
    }
    if (savedApiUrlEnv === undefined) {
      delete process.env.IPFS_API_URL;
    } else {
      process.env.IPFS_API_URL = savedApiUrlEnv;
    }
  });

  afterEach(() => {
    configureBackend(undefined);
    delete process.env.STORAGE_BACKEND;
    delete process.env.IPFS_API_URL;
  });

  describe('write (add)', () => {
    it('POSTs the payload to /api/v0/add with cid-version=1 and returns ipfs://<cid>', async () => {
      const payload = Buffer.from('inspection report body', 'utf8');
      const hash = hashOf(payload);
      const fake = new FakeFetch(kuboResponder(payload));
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      const location = await backend.write(hash, payload, 'text/plain');

      expect(location).to.equal(`ipfs://${CID}`);
      expect(fake.calls).to.have.length(1);
      const call = fake.calls[0];
      expect(call.url).to.contain('/api/v0/add');
      expect(call.url).to.contain('cid-version=1');
      expect(call.url.startsWith(API)).to.equal(true);
      expect(call.init?.method).to.equal('POST');
      // The multipart body must carry the payload bytes verbatim, framed by
      // the SAME boundary the content-type header declares — kubo rejects a
      // body whose framing does not match the header.
      const body = bodyBytes(call.init);
      expect(body.includes(payload)).to.equal(true);
      const contentType = new Headers(call.init?.headers).get('content-type') ?? '';
      const boundary = contentType.split('boundary=')[1];
      expect(boundary, 'content-type must declare the multipart boundary').to.be.a('string')
        .and.to.have.length.greaterThan(0);
      expect(body.indexOf(Buffer.from(`--${boundary}\r\n`, 'utf8'))).to.equal(0);
      expect(
        body.subarray(body.length - Buffer.byteLength(`\r\n--${boundary}--\r\n`)).toString('utf8'),
      ).to.equal(`\r\n--${boundary}--\r\n`);
      expect(backend.cidFor(hash)).to.equal(CID);
    });

    it('accepts the Cid field emitted by some proxies in place of Hash', async () => {
      const payload = Buffer.from('proxy-shaped response', 'utf8');
      const fake = new FakeFetch(
        () => new Response(JSON.stringify({ Cid: CID }), { status: 200 }),
      );
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      const location = await backend.write(hashOf(payload), payload, 'text/plain');

      expect(location).to.equal(`ipfs://${CID}`);
    });

    it('names the add operation when the daemon answers non-2xx', async () => {
      const fake = new FakeFetch(() => new Response('nope', { status: 500 }));
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      const thrown = await expectRejection(
        backend.write('a'.repeat(64), Buffer.from('x'), 'text/plain'),
      );
      expect(thrown.message).to.contain('ipfs add failed');
      expect(thrown.message).to.contain('500');
    });

    it('throws on malformed JSON from add', async () => {
      const fake = new FakeFetch(() => new Response('not json at all', { status: 200 }));
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      const thrown = await expectRejection(
        backend.write('a'.repeat(64), Buffer.from('x'), 'text/plain'),
      );
      expect(thrown.message).to.contain('ipfs add failed');
      expect(thrown.message).to.contain('malformed JSON');
    });

    it('throws when the add response carries neither Hash nor Cid', async () => {
      const fake = new FakeFetch(
        () => new Response(JSON.stringify({ Size: 42 }), { status: 200 }),
      );
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      const thrown = await expectRejection(
        backend.write('a'.repeat(64), Buffer.from('x'), 'text/plain'),
      );
      expect(thrown.message).to.contain('no Hash/Cid');
    });
  });

  describe('read (cat)', () => {
    it('round trips the exact bytes through /api/v0/cat by CID', async () => {
      const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
      const hash = hashOf(payload);
      const fake = new FakeFetch(kuboResponder(payload));
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      await backend.write(hash, payload, 'application/octet-stream');
      const fetched = await backend.read(hash);

      expect(fetched?.equals(payload)).to.equal(true);
      const cat = fake.calls[fake.calls.length - 1];
      expect(cat.url).to.contain('/api/v0/cat');
      expect(cat.url).to.contain(encodeURIComponent(CID));
      expect(cat.init?.method).to.equal('POST');
    });

    it('returns undefined for a hash it never stored, without calling the daemon', async () => {
      const fake = new FakeFetch(kuboResponder(Buffer.from('x')));
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      expect(await backend.read('b'.repeat(64))).to.equal(undefined);
      expect(fake.calls).to.have.length(0);
    });

    it('names the cat operation when the daemon answers non-2xx', async () => {
      const payload = Buffer.from('gone from the network', 'utf8');
      const hash = hashOf(payload);
      const fake = new FakeFetch((url) =>
        url.includes('/api/v0/add')
          ? new Response(JSON.stringify({ Hash: CID }), { status: 200 })
          : new Response('gateway timeout', { status: 504 }),
      );
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });
      await backend.write(hash, payload, 'text/plain');

      const thrown = await expectRejection(backend.read(hash));
      expect(thrown.message).to.contain('ipfs cat failed');
      expect(thrown.message).to.contain('504');
      expect(thrown.message).to.contain(CID);
    });

    it('records the content type from write time', async () => {
      const payload = Buffer.from('{"a":1}', 'utf8');
      const fake = new FakeFetch(kuboResponder(payload));
      const backend = new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl });

      await backend.write(hashOf(payload), payload, 'application/json');

      expect(await backend.readContentType(hashOf(payload))).to.equal('application/json');
      expect(await backend.readContentType('c'.repeat(64))).to.equal(undefined);
    });
  });

  describe('backend selection from STORAGE_BACKEND', () => {
    it('selects IpfsBackend when STORAGE_BACKEND=ipfs', () => {
      process.env.STORAGE_BACKEND = 'ipfs';
      configureBackend(undefined);

      expect(currentBackend()).to.be.instanceOf(IpfsBackend);
    });

    it('defaults to the filesystem when STORAGE_BACKEND is unset', () => {
      delete process.env.STORAGE_BACKEND;
      configureBackend(undefined);

      expect(currentBackend()).to.be.instanceOf(FilesystemBackend);
    });

    it('selects the filesystem when STORAGE_BACKEND=filesystem', () => {
      process.env.STORAGE_BACKEND = 'filesystem';
      configureBackend(undefined);

      expect(currentBackend()).to.be.instanceOf(FilesystemBackend);
    });

    it('throws on an unknown STORAGE_BACKEND value rather than falling back', () => {
      process.env.STORAGE_BACKEND = 'carrier-pigeon';
      configureBackend(undefined);

      let thrown: Error | undefined;
      try {
        currentBackend();
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('Unknown STORAGE_BACKEND');
      expect(thrown?.message).to.contain('carrier-pigeon');
    });

    it('defaults the API URL to the local kubo daemon when IPFS_API_URL is unset', () => {
      delete process.env.IPFS_API_URL;

      expect(ipfsApiUrl()).to.equal(DEFAULT_IPFS_API_URL);
      expect(DEFAULT_IPFS_API_URL).to.equal('http://127.0.0.1:5001');
    });

    it('honours IPFS_API_URL for a default-constructed backend', async () => {
      process.env.IPFS_API_URL = 'http://kubo.remote:9095';
      const payload = Buffer.from('env-routed payload', 'utf8');
      const fake = new FakeFetch(kuboResponder(payload));
      // No apiUrl option: the constructor must fall back to the env value.
      const backend = new IpfsBackend({ fetchImpl: fake.impl });

      await backend.write(hashOf(payload), payload, 'text/plain');

      expect(fake.calls[0].url.startsWith('http://kubo.remote:9095/api/v0/add')).to.equal(true);
    });
  });

  describe('adapter over the ipfs backend', () => {
    it('anchors the LOCAL SHA-256, not the CID, and reports an ipfs:// location', async () => {
      const payload = Buffer.from('raw sensor series', 'utf8');
      const fake = new FakeFetch(kuboResponder(payload));
      configureBackend(new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl }));

      const stored = await put(payload, 'application/json');

      expect(stored.hash).to.equal(hashOf(payload));
      expect(stored.hash).to.match(/^[0-9a-f]{64}$/);
      expect(stored.hash).to.not.equal(CID);
      expect(stored.location).to.equal(`ipfs://${CID}`);
    });

    it('get() re-verifies the bytes the daemon returns and round trips them', async () => {
      const payload = Buffer.from('verified series', 'utf8');
      const fake = new FakeFetch(kuboResponder(payload));
      configureBackend(new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl }));

      const stored = await put(payload, 'application/json');
      const fetched = await get(stored.hash);

      expect(fetched.equals(payload)).to.equal(true);
    });

    it('get() rejects bytes the daemon substituted, by re-hashing on read', async () => {
      const payload = Buffer.from('honest series', 'utf8');
      // The daemon serves DIFFERENT bytes for cat than were added — the
      // "trust the remote" step the adapter's re-hash exists to catch.
      const fake = new FakeFetch(kuboResponder(Buffer.from('forged series', 'utf8')));
      configureBackend(new IpfsBackend({ apiUrl: API, fetchImpl: fake.impl }));

      const stored = await put(payload, 'application/json');

      const thrown = await expectRejection(get(stored.hash));
      expect(thrown.message).to.contain('integrity check failed');
    });
  });
});
