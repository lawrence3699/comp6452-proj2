/**
 * Read API — owner: person 3.
 *
 * `node:http` only, no framework. Three routes is not enough surface to earn a
 * dependency, and the point of this service is to show that a traceability
 * query is a memory lookup, not a ledger walk — a framework would only add
 * latency to the thing being measured.
 *
 *   GET /health              liveness + index size + backing file
 *   GET /batch/:id/history   assembled history, oldest first
 *   GET /batches             the batch ids the index knows (demo affordance)
 *
 * Every response carries `X-Query-Time-Ms`, which is the NFR evidence: the
 * marker can see the served latency without instrumenting anything.
 */

import * as http from 'http';
import { assembleHistory, BatchHistory } from './history';
import { EventStore, currentStore } from './store';

export interface ServerOptions {
  readonly store?: EventStore;
  readonly port?: number;
  readonly host?: string;
}

export const DEFAULT_PORT = 3001;

export const serverPort = (): number => {
  const raw = process.env.INDEXER_PORT;
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`INDEXER_PORT must be a port number, got: ${raw}`);
  }
  return parsed;
};

const sendJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
  elapsedMs: number,
): void => {
  const payload = JSON.stringify(body, undefined, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
    'X-Query-Time-Ms': elapsedMs.toFixed(3),
    // The showcase dashboard (docs/showcase.html) is opened straight from the
    // filesystem, so its fetches arrive from the opaque `file://` origin and
    // the browser blocks the response without CORS consent. `*` is safe here:
    // the API is read-only, bound to loopback, and serves nothing secret.
    'Access-Control-Allow-Origin': '*',
  });
  response.end(payload);
};

/**
 * Match `/batch/:id/history`, returning the decoded id.
 *
 * Split on `/` rather than a regex over the raw path so a batch id containing
 * a percent-encoded slash cannot smuggle in extra path segments, and so the id
 * is decoded exactly once.
 */
export const parseHistoryPath = (pathname: string): string | undefined => {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length !== 3 || segments[0] !== 'batch' || segments[2] !== 'history') {
    return undefined;
  }
  try {
    const id = decodeURIComponent(segments[1] as string);
    return id === '' ? undefined : id;
  } catch {
    // Malformed percent-encoding; treat as no match so the caller 400s.
    return undefined;
  }
};

/** History for one batch, straight off the in-memory index. */
export const historyResponse = (store: EventStore, batchId: string): BatchHistory =>
  assembleHistory(batchId, store.historyFor(batchId));

/**
 * The request handler, exported so it can be exercised without binding a port.
 */
export const createHandler =
  (store: EventStore) =>
  (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const startedAt = process.hrtime.bigint();
    const elapsed = (): number => Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    // Read-only service: anything but GET is a client error, and saying so
    // beats a 404 that reads like a routing bug.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: `method not allowed: ${request.method ?? 'unknown'}` }, elapsed());
      return;
    }

    // The base is a throwaway: we only ever use the parsed pathname, and
    // `new URL` needs an absolute URL to parse an origin-form request target.
    const pathname = new URL(request.url ?? '/', 'http://indexer.local').pathname;

    if (pathname === '/health') {
      sendJson(
        response,
        200,
        {
          status: 'ok',
          indexedEvents: store.size(),
          batches: store.batchIds().length,
          uptimeSeconds: Math.round(process.uptime()),
        },
        elapsed(),
      );
      return;
    }

    if (pathname === '/batches') {
      sendJson(response, 200, { batches: [...store.batchIds()].sort() }, elapsed());
      return;
    }

    const batchId = parseHistoryPath(pathname);
    if (batchId !== undefined) {
      const history = historyResponse(store, batchId);
      // 404 on an unknown batch rather than an empty history: "we have never
      // seen this batch" and "this batch has no events" are different answers,
      // and only the first is possible here (a registered batch always has at
      // least its BatchRegistered row).
      sendJson(response, history.eventCount === 0 ? 404 : 200, history, elapsed());
      return;
    }

    sendJson(
      response,
      404,
      {
        error: `no such route: ${pathname}`,
        routes: ['GET /health', 'GET /batches', 'GET /batch/:batchId/history'],
      },
      elapsed(),
    );
  };

export interface RunningServer {
  readonly server: http.Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Bind and start. Resolves once the socket is accepting connections. */
export const startServer = async (options: ServerOptions = {}): Promise<RunningServer> => {
  const store = options.store ?? currentStore();
  await store.open();

  const server = http.createServer(createHandler(store));
  const port = options.port ?? serverPort();
  const host = options.host ?? '127.0.0.1';

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  // `address()` is a string for a unix socket; we always bind TCP, so fall
  // back to the requested port rather than pretending the narrowing failed.
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    server,
    port: boundPort,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        // Idempotent: on SIGINT the signal handler closes the server and the
        // listen path's `finally` then closes it again. The second close's
        // ERR_SERVER_NOT_RUNNING is the desired state, not a failure — turning
        // it into a rejection would make a clean Ctrl-C exit with an error.
        server.close((error) =>
          error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : resolve(),
        );
        // Without this, an idle keep-alive connection holds the process open
        // past close() and the demo appears to hang on Ctrl-C.
        server.closeIdleConnections();
      }),
  };
};
