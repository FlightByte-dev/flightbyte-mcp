import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { VERSION } from './config.js';
import type { DocsStore } from './docs.js';
import {
  bearerChallenge,
  calledTools,
  isAccessToken,
  OAUTH_SCOPES,
  protectedResourceMetadata,
  resourceMetadataPaths,
  scopeSatisfies,
  TokenExchanger,
  type OAuthOptions,
} from './oauth.js';
import { createServer } from './server.js';
import { API_TOOLS } from './tools/api-tools.js';

export interface HttpAppOptions {
  apiUrl: string;
  docs: DocsStore;
  /** Requests per minute per client IP on POST /mcp. 0 disables the limit. */
  rateLimitPerMinute: number;
  /** Number of reverse proxies in front of this server whose X-Forwarded-For entries can be trusted. */
  trustProxy: number;
  /** Host header names accepted on /mcp (DNS rebinding protection). Empty accepts any host. */
  allowedHosts: string[];
  maxBodyBytes?: number;
  /** Sign-in for clients that take OAuth only (Claude's connectors). Unset: API keys only, as before. */
  oauth?: OAuthOptions | null;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, x-api-key, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, retry-after, www-authenticate',
  'access-control-max-age': '86400',
};

/** A fixed one-minute window per key. Small, in memory, and per process: enough to stop one client hammering the server. */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    readonly now: () => number = Date.now,
  ) {}

  take(key: string): { ok: boolean; retryAfterSeconds: number } {
    const now = this.now();
    let entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.#hits.set(key, entry);
    }
    entry.count++;
    return { ok: entry.count <= this.limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.#hits) if (entry.resetAt <= now) this.#hits.delete(key);
  }
}

/** The caller's FlightByte key from `Authorization: Bearer <key>` or `x-api-key`. */
export function extractApiKey(headers: Headers): string | undefined {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  if (bearer) return bearer;
  return headers.get('x-api-key')?.trim() || undefined;
}

/** The OAuth scope each API tool needs; docs tools need none. */
const TOOL_SCOPES = new Map(API_TOOLS.map((def) => [def.name, def.scope]));

function scopesFor(tools: string[]): string[] {
  return [...new Set(tools.flatMap((name) => TOOL_SCOPES.get(name) ?? []))];
}

export function clientIp(req: IncomingMessage, trustProxy: number): string {
  if (trustProxy > 0) {
    const forwarded = first(req.headers['x-forwarded-for'])
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (forwarded && forwarded.length > 0) return forwarded[Math.max(0, forwarded.length - trustProxy)]!;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createHttpApp(options: HttpAppOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? Date.now;
  const limiter = options.rateLimitPerMinute > 0 ? new RateLimiter(options.rateLimitPerMinute, 60_000, now) : undefined;
  const allowedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const oauth = options.oauth ?? null;
  const exchanger = oauth ? new TokenExchanger({ ...oauth, fetch: oauth.fetch ?? options.fetch, now }) : undefined;
  const metadataPaths = new Set(oauth ? resourceMetadataPaths(oauth.resource) : []);

  /** What the API is called with for one request: the caller's API key, or the token traded for their OAuth sign-in. */
  interface Caller {
    apiKey?: string;
    /** The client's own access token, when it signed in with OAuth. */
    subject?: string;
    /** The API refused the traded token during this request: access was revoked since the trade. */
    rejected?: boolean;
  }
  const serverFor = (caller: Caller) =>
    createServer({
      apiUrl: options.apiUrl,
      apiKey: caller.apiKey,
      docs: options.docs,
      fetch: options.fetch,
      // Revoked since the trade: forget it, and answer this request with a 401 (see below).
      onUnauthorized:
        caller.subject !== undefined
          ? () => {
              caller.rejected = true;
              exchanger?.forget(caller.subject!);
            }
          : undefined,
    });

  // 2026-07-28 requests: the SDK entry builds a fresh server per request. Tools send nothing before their result, so it answers plain JSON.
  // The caller reaches the factory through authInfo, which the SDK passes through untouched.
  const modern = createMcpHandler(({ authInfo }) => serverFor((authInfo?.extra?.caller as Caller | undefined) ?? {}), {
    legacy: 'reject',
    onerror: (err) => log(`mcp error: ${err.message}`),
  });

  // 2025-era requests (protocol 2024-11-05 to 2025-11-25): stateless Streamable HTTP with JSON responses, a fresh server per request.
  const serveLegacy = async (request: Request, body: unknown, res: ServerResponse, caller: Caller): Promise<Response> => {
    const server = serverFor(caller);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    let note = '';
    res.on('finish', () => {
      // Never log headers or bodies: they carry API keys, webhook URLs and secrets.
      log(`${req.method} ${url.pathname} ${res.statusCode} ${now() - started}ms${note}`);
    });

    try {
      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendJson(res, 200, { status: 'ok', version: VERSION });
      }
      if (url.pathname === '/' && req.method === 'GET') {
        return sendJson(res, 200, {
          name: 'FlightByte MCP server',
          version: VERSION,
          mcp: '/mcp',
          transport: 'streamable-http',
          auth: oauth
            ? 'Authorization: Bearer <FlightByte API key>, or OAuth (see /.well-known/oauth-protected-resource)'
            : 'Authorization: Bearer <FlightByte API key>',
          docs: 'https://flightbyte.dev/docs/ai',
        });
      }
      if (oauth && metadataPaths.has(url.pathname)) {
        // RFC 9728 protected resource metadata: where Claude learns which server signs people in.
        res.setHeader('access-control-allow-origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' }).end();
          return;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          res.setHeader('cache-control', 'public, max-age=300');
          return sendJson(res, 200, protectedResourceMetadata(oauth));
        }
      }
      if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });

      for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);

      if (allowedHosts.size > 0) {
        const host = hostname(first(req.headers.host));
        if (!host || !allowedHosts.has(host)) return sendRpcError(res, 403, -32000, 'Host not allowed.');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST, OPTIONS');
        // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
        return sendRpcError(res, 405, -32000, 'Method not allowed. This server is stateless: send JSON-RPC requests with POST.');
      }

      if (limiter) {
        const verdict = limiter.take(clientIp(req, options.trustProxy));
        if (!verdict.ok) {
          res.setHeader('retry-after', String(verdict.retryAfterSeconds));
          return sendRpcError(res, 429, -32000, `Too many requests. Retry after ${verdict.retryAfterSeconds} seconds.`);
        }
      }

      let raw: string;
      let body: unknown;
      try {
        raw = await readBody(req, maxBodyBytes);
        body = JSON.parse(raw);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          res.setHeader('connection', 'close');
          return sendRpcError(res, 413, -32600, `Request body over ${maxBodyBytes} bytes.`);
        }
        return sendRpcError(res, 400, -32700, 'Parse error: the body must be a JSON-RPC message.');
      }
      note = describeRpc(body);

      // Aborted when the client goes away before the response is complete, which cancels the work behind it.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const request = toWebRequest(req, url, raw, abort.signal);
      const credential = extractApiKey(request.headers);
      const caller: Caller = { apiKey: credential };

      if (oauth && exchanger) {
        // Before the SDK runs: only an HTTP 401 makes Claude sign in, and a tool result is always a 200.
        const needed = scopesFor(calledTools(body));
        if (credential && isAccessToken(credential)) {
          const traded = await exchanger.trade(credential);
          if (traded.kind === 'invalid') {
            note += ' auth=oauth-invalid';
            return sendChallenge(res, 401, bearerChallenge(oauth, { error: 'invalid_token', description: 'The access token is invalid, expired or revoked.' }), {
              error: 'invalid_token',
              error_description: 'The access token is invalid, expired or revoked. Refresh it or sign in again.',
            });
          }
          if (traded.kind === 'unavailable') {
            log(`token exchange failed: ${traded.reason}`);
            return sendRpcError(res, 503, -32000, 'Sign-in is temporarily unavailable. Try again in a moment.');
          }
          const missing = needed.filter((scope) => !scopeSatisfies(traded.scopes, scope));
          if (missing.length > 0) {
            note += ' auth=oauth-scope';
            // Everything still needed, not just what is missing: clients do not reliably keep earlier scopes.
            const scope = OAUTH_SCOPES.filter((s) => traded.scopes.includes(s) || needed.includes(s));
            return sendChallenge(res, 403, bearerChallenge(oauth, { error: 'insufficient_scope', scope }), {
              error: 'insufficient_scope',
              error_description: `This connection was not granted ${missing.join(', ')}.`,
            });
          }
          caller.apiKey = traded.token;
          caller.subject = credential;
        } else if (!credential && needed.length > 0) {
          // Lazy authentication: tools/list and the docs tools work signed out; an API tool asks to sign in.
          note += ' auth=challenge';
          return sendChallenge(res, 401, bearerChallenge(oauth, { scope: OAUTH_SCOPES }), {
            error: 'invalid_token',
            error_description: 'Sign in to FlightByte to use this tool.',
          });
        }
      }

      const legacy = await isLegacyRequest(request, body);
      const auth = caller.subject !== undefined ? 'oauth' : credential ? 'yes' : 'no';
      note += ` key=${auth} era=${legacy ? 'legacy' : 'modern'}`;
      const authInfo = { token: caller.apiKey ?? '', clientId: 'flightbyte-mcp', scopes: [], extra: { caller } };
      let response = legacy ? await serveLegacy(request, body, res, caller) : await modern.fetch(request, { parsedBody: body, authInfo });
      if (oauth && caller.subject !== undefined) {
        // Plain JSON, so nothing has reached the client yet: if the API refused the token mid-request,
        // the client gets the 401 the spec asks for (and refreshes or signs in again), not a tool error.
        const buffered = await response.arrayBuffer();
        if (caller.rejected) {
          note += ' auth=oauth-revoked';
          return sendChallenge(res, 401, bearerChallenge(oauth, { error: 'invalid_token', description: 'The access token was revoked.' }), {
            error: 'invalid_token',
            error_description: 'The access token was revoked. Refresh it or sign in again.',
          });
        }
        response = new Response(buffered, { status: response.status, headers: response.headers });
      }
      await sendResponse(res, response);
    } catch (err) {
      log(`error handling ${req.method} ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendRpcError(res, 500, -32603, 'Internal server error.');
      else res.end();
    }
  };

  return { handler, limiter, exchanger, close: () => modern.close() };
}

/** Hop-by-hop headers describe this connection, not the request; a web Request must not carry them. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer']);

function toWebRequest(req: IncomingMessage, url: URL, body: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return new Request(url, { method: req.method, headers, body, signal });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
  } catch (err) {
    // A client that hangs up mid-stream is not a server error.
    if (!res.destroyed) throw err;
  }
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering but let the request drain, so the 413 still reaches the client.
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function describeRpc(body: unknown): string {
  const messages = Array.isArray(body) ? body : [body];
  const parts = messages.map((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    if (typeof msg?.method !== 'string') return 'response';
    return msg.method === 'tools/call' && typeof msg.params?.name === 'string' ? `tools/call:${msg.params.name}` : msg.method;
  });
  return parts.length > 0 ? ` ${parts.join(',')}` : '';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** A 401 or 403 with the WWW-Authenticate challenge that starts (or widens) an OAuth sign-in. */
function sendChallenge(res: ServerResponse, status: 401 | 403, challenge: string, body: Record<string, string>): void {
  res.setHeader('www-authenticate', challenge);
  sendJson(res, status, body);
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) return lower.slice(0, lower.indexOf(']') + 1);
  return lower.split(':')[0];
}
