/**
 * Local demo control plane.
 *
 * Serves application/web and runs the repository's real showcase script. The
 * browser only selects a batch id and starts/stops a fixed command; arbitrary
 * commands are never accepted over HTTP.
 */

import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');
const WEB_ROOT = path.join(APP_DIR, 'web');
const SHOWCASE = path.join(APP_DIR, 'showcase.sh');
const PORT = Number(process.env.DEMO_WEB_PORT ?? '4174');
const HOST = process.env.DEMO_WEB_HOST ?? '127.0.0.1';

type RunStatus = 'idle' | 'running' | 'passed' | 'failed' | 'stopped';

interface DemoEvent {
  readonly id: number;
  readonly type: 'state' | 'output' | 'system';
  readonly at: string;
  readonly stream?: 'stdout' | 'stderr';
  readonly line?: string;
  readonly status?: RunStatus;
  readonly batchId?: string;
  readonly exitCode?: number | null;
}

interface DemoState {
  status: RunStatus;
  batchId: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
}

const state: DemoState = { status: 'idle', batchId: '' };
const history: DemoEvent[] = [];
const clients = new Set<http.ServerResponse>();
let nextEventId = 1;
let child: ChildProcess | undefined;

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
};

const publish = (event: Omit<DemoEvent, 'id' | 'at'>): void => {
  const complete: DemoEvent = {
    id: nextEventId++,
    at: new Date().toISOString(),
    ...event,
  };
  history.push(complete);
  if (history.length > 1200) history.shift();
  const frame = `id: ${String(complete.id)}\nevent: ${complete.type}\ndata: ${JSON.stringify(complete)}\n\n`;
  for (const client of clients) client.write(frame);
};

const emitState = (): void => {
  publish({
    type: 'state',
    status: state.status,
    batchId: state.batchId,
    exitCode: state.exitCode,
  });
};

const pipeLines = (
  stream: NodeJS.ReadableStream,
  source: 'stdout' | 'stderr',
): void => {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) publish({ type: 'output', stream: source, line });
  });
  stream.on('end', () => {
    if (pending !== '') publish({ type: 'output', stream: source, line: pending });
  });
};

const validBatchId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);

const readBody = async (request: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 16_384) throw new Error('request body is too large');
    chunks.push(data);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const startDemo = (batchId: string): void => {
  history.length = 0;
  state.status = 'running';
  state.batchId = batchId;
  state.startedAt = new Date().toISOString();
  delete state.finishedAt;
  delete state.exitCode;

  publish({
    type: 'system',
    line: `Executing: DEMO_BATCH=${batchId} ${SHOWCASE} --fast --no-open --exit`,
  });
  emitState();

  const demoProcess = spawn('bash', [SHOWCASE, '--fast', '--no-open', '--exit'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DEMO_BATCH: batchId,
      DEMO_PAUSE: '0',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = demoProcess;

  pipeLines(demoProcess.stdout, 'stdout');
  pipeLines(demoProcess.stderr, 'stderr');

  demoProcess.once('error', (error) => {
    publish({ type: 'system', line: `Failed to start demo: ${error.message}` });
  });
  demoProcess.once('close', (code, signal) => {
    state.exitCode = code;
    state.finishedAt = new Date().toISOString();
    state.status = signal !== null ? 'stopped' : code === 0 ? 'passed' : 'failed';
    publish({
      type: 'system',
      line: signal !== null
        ? `Demo stopped by ${signal}`
        : `Demo exited with code ${String(code)}`,
    });
    child = undefined;
    emitState();
  });
};

const preflight = (): Record<string, unknown> => {
  const names = [
    'peer0.org1.example.com',
    'peer0.org2.example.com',
    'orderer.example.com',
    'batch-registry.org1.example.com',
    'coldchain-compliance.org1.example.com',
  ];
  const containers = names.map((name) => {
    const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      encoding: 'utf8',
    });
    return { name, running: result.status === 0 && result.stdout.trim() === 'true' };
  });
  return {
    ready: containers.every((item) => item.running),
    containers,
    showcase: fs.existsSync(SHOWCASE),
    indexerDependencies: fs.existsSync(path.join(REPO_ROOT, 'offchain/indexer/node_modules')),
  };
};

const mimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const serveStatic = (pathname: string, response: http.ServerResponse): void => {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const normalised = path.normalize(requested);
  if (normalised.startsWith('..') || path.isAbsolute(normalised)) {
    json(response, 400, { error: 'invalid path' });
    return;
  }
  const file = path.join(WEB_ROOT, normalised);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    json(response, 404, { error: 'not found' });
    return;
  }
  const body = fs.readFileSync(file);
  response.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  response.end(body);
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${String(PORT)}`);

  if (request.method === 'GET' && url.pathname === '/api/state') {
    json(response, 200, { ...state, preflight: preflight() });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    for (const event of history) {
      response.write(`id: ${String(event.id)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    clients.add(response);
    request.once('close', () => clients.delete(response));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/start') {
    if (child !== undefined) {
      json(response, 409, { error: 'a demo is already running', state });
      return;
    }
    try {
      const body = await readBody(request) as { batchId?: unknown };
      const generated = `WEB-DEMO-${String(Date.now())}`;
      const batchId = body.batchId === undefined || body.batchId === '' ? generated : body.batchId;
      if (!validBatchId(batchId)) {
        json(response, 400, { error: 'batchId must use 1-64 letters, numbers, dot, underscore, colon or dash' });
        return;
      }
      startDemo(batchId);
      json(response, 202, { accepted: true, batchId });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/stop') {
    if (child === undefined) {
      json(response, 409, { error: 'no demo is running' });
      return;
    }
    child.kill('SIGTERM');
    json(response, 202, { accepted: true });
    return;
  }

  if (request.method === 'GET') {
    serveStatic(url.pathname, response);
    return;
  }

  json(response, 405, { error: 'method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`demo web: http://${HOST}:${String(PORT)}`);
  console.log(`demo command: ${SHOWCASE} --fast --no-open --exit`);
});

const shutdown = (): void => {
  if (child !== undefined) child.kill('SIGTERM');
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
