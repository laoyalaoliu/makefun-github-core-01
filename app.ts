// The forge's HTTP surface, grown from the starter: git smart HTTP (protocol v2 and v0) under
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp. One bearer
// token (MAKEFUN_SHOP_TOKEN) guards everything but the health probe; its owner is the scenario's
// viewer. Every REST answer carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { forge } from './forge.ts';
import { advertiseV0, advertiseV2, handleReceivePack, handleUploadPackV0, handleUploadPackV2 } from './gitproto.ts';
import { restRoute } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId() });
  res.end(body);
}

/** Whether the request carries the trial token (checked only when the env set one). */
function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${EXPECTED_TOKEN}` || header === EXPECTED_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((segment) => segment !== '').map(decode);

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const name = segments[1].slice(0, -'.git'.length);
    const tail = segments.slice(2).join('/');
    if (tail === 'info/refs' || tail === 'git-upload-pack' || tail === 'git-receive-pack') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const repo = forge.getRepo(owner, name);
      if (repo === null) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
        res.end('not found\n');
        return;
      }
      const service = tail === 'info/refs' ? (url.searchParams.get('service') ?? '') : tail;
      if (tail === 'info/refs') {
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'Unknown service' });
          return;
        }
        const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
        const body = wantsV2 ? advertiseV2(service) : advertiseV0(repo, service);
        sendBytes(res, 200, body, `application/x-${service}-advertisement`);
        return;
      }
      const body = await readBody(req);
      try {
        if (tail === 'git-upload-pack') {
          const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          const out = wantsV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
          sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
        } else {
          const out = handleReceivePack(repo, body);
          sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
        }
      } catch {
        // A malformed pack or pkt-line stream must never take the server down.
        if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
      }
      return;
    }
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const result = executeGraphQL(body);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(body);
    if (result.json === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = needsBody ? await readBody(req) : Buffer.alloc(0);
    const host = req.headers.host ?? 'entry';
    const result = restRoute(method, segments, url.searchParams, body, host, path);
    if (result.json === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json, result.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
