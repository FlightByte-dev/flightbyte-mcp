/** Spawns the built HTTP entry point (dist/http.js) and talks to POST /mcp with raw JSON-RPC and with the SDK client. */
import type { ChildProcess } from 'node:child_process';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/config.js';
import { text } from './helpers/client.js';
import { startServer, stopServer } from './helpers/http-server.js';
import { flightSnapshot, MockFlightByte } from './helpers/mock.js';

const BEARER_KEY = 'fb_test_bearer_key_0003';
const HEADER_KEY = 'fb_test_header_key_0004';
const mock = new MockFlightByte();

let child: ChildProcess;
let base = '';
let serverLogs: () => string = () => '';

let nextId = 1;
async function rpc(method: string, params: Record<string, unknown> | undefined, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } } };
}

beforeAll(async () => {
  await mock.start();
  const started = await startServer(mock);
  child = started.child;
  base = started.base;
  serverLogs = started.logs;
});
afterEach(() => mock.reset());
afterAll(async () => {
  await stopServer(child);
  await mock.stop();
});

describe('Streamable HTTP transport', () => {
  it('GET /healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: VERSION });
  });

  it('POST /mcp initialize, then tools/list on a separate stateless request', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toContain('application/json');
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(init.body.result).toMatchObject({ serverInfo: { name: 'flightbyte', version: VERSION }, capabilities: { tools: {} } });

    const list = await rpc('tools/list', {}, { 'mcp-protocol-version': '2025-11-25' });
    expect(list.status).toBe(200);
    expect((list.body.result!.tools as unknown[]).length).toBe(15);
  });

  it('initialize accepts the older 2025-era protocol versions', async () => {
    for (const protocolVersion of ['2025-06-18', '2025-03-26', '2024-11-05']) {
      const init = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '0' } });
      expect(init.status, protocolVersion).toBe(200);
      expect(init.body.result, protocolVersion).toMatchObject({ protocolVersion, serverInfo: { name: 'flightbyte' } });
    }
  });

  it('tools/call reads the key from Authorization: Bearer, or from x-api-key', async () => {
    mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
    const args = { name: 'get_flight', arguments: { carrier: 'TK', flightNumber: '1848', date: '2026-10-18' } };

    const bearer = await rpc('tools/call', args, { authorization: `Bearer ${BEARER_KEY}` });
    expect(bearer.status).toBe(200);
    expect(bearer.body.result!.isError).toBeFalsy();
    expect(bearer.body.result!.structuredContent).toMatchObject({ flightNumber: '1848' });
    expect(mock.last!.headers['x-api-key']).toBe(BEARER_KEY);
    expect(mock.last!.headers.authorization).toBeUndefined();

    await rpc('tools/call', args, { 'x-api-key': HEADER_KEY });
    expect(mock.last!.headers['x-api-key']).toBe(HEADER_KEY);
  });

  it('tools/call without a key: a configuration error for API tools, docs tools still work', async () => {
    const api = await rpc('tools/call', { name: 'get_subscription', arguments: { id: 'sub_1' } });
    expect(api.body.result!.isError).toBe(true);
    expect(text(api.body.result as unknown as CallToolResult)).toContain('Authorization: Bearer <key>');
    expect(mock.apiRequests).toHaveLength(0);

    const docs = await rpc('tools/call', { name: 'search_docs', arguments: { query: 'leg selection origin' } });
    expect(docs.body.result!.isError).toBeFalsy();
    expect(text(docs.body.result as unknown as CallToolResult)).toContain('https://flightbyte.dev/docs/flights#leg-selection');
  });

  // Both eras through the SDK client: 2025-11-25 (initialize handshake, today's clients) and 2026-07-28 (server/discover, per-request envelope).
  for (const era of ['legacy', 'modern'] as const) {
    it(`works with the SDK StreamableHTTPClientTransport (${era} era)`, async () => {
      mock.on('GET', '/v1/subscriptions', { status: 200, body: { total: 0, data: [] } });
      const contentTypes: string[] = [];
      const client = new Client(
        { name: `sdk-http-${era}`, version: '0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${BEARER_KEY}` } },
          fetch: async (url, init) => {
            const res = await fetch(url, init);
            if (res.status === 200) contentTypes.push(res.headers.get('content-type') ?? '');
            return res;
          },
        }),
      );
      try {
        expect(client.getProtocolEra()).toBe(era);
        expect(client.getNegotiatedProtocolVersion()).toBe(era === 'modern' ? '2026-07-28' : '2025-11-25');
        expect(client.getServerVersion()).toMatchObject({ name: 'flightbyte', version: VERSION });
        expect((await client.listTools()).tools).toHaveLength(15);
        const result = await client.callTool({ name: 'list_subscriptions', arguments: { status: 'active' } });
        expect(result.structuredContent).toEqual({ total: 0, data: [] });
        expect(mock.last).toMatchObject({ path: '/v1/subscriptions', query: { status: 'active' } });
        expect(mock.last!.headers['x-api-key']).toBe(BEARER_KEY);
        // Plain JSON responses, no SSE, in both eras.
        expect(contentTypes.length).toBeGreaterThanOrEqual(3);
        for (const type of contentTypes) expect(type).toContain('application/json');
      } finally {
        await client.close();
      }
    });
  }

  it('a 2026-07-28 client with auto negotiation picks the modern era; a key-less one still gets the docs tools', async () => {
    const client = new Client({ name: 'sdk-http-auto', version: '0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const api = await client.callTool({ name: 'get_subscription', arguments: { id: 'sub_1' } });
      expect(api.isError).toBe(true);
      expect(text(api)).toContain('Authorization: Bearer <key>');
      const docs = await client.callTool({ name: 'search_docs', arguments: { query: 'leg selection origin' } });
      expect(text(docs)).toContain('https://flightbyte.dev/docs/flights#leg-selection');
      expect(mock.apiRequests).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('GET and DELETE /mcp answer 405 (stateless: no SSE stream, no sessions)', async () => {
    const get = await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    const del = await fetch(`${base}/mcp`, { method: 'DELETE' });
    expect(del.status).toBe(405);
  });

  it('answers CORS preflight and 404s other paths', async () => {
    const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('refuses a Host header that is not loopback when bound to loopback (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: 'POST', headers: { host: 'evil.example.com', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('a malformed body is a JSON-RPC parse error', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });

  it('logs requests without keys', () => {
    // Runs last in this file; the logs cover every request above.
    const output = serverLogs();
    expect(output).toContain('POST /mcp 200');
    expect(output).toContain('tools/call:get_flight key=yes era=legacy');
    expect(output).toContain('tools/call:list_subscriptions key=yes era=modern');
    expect(output).not.toContain(BEARER_KEY);
    expect(output).not.toContain(HEADER_KEY);
  });
});

describe('per-IP rate limit', () => {
  it('answers 429 with Retry-After past the limit, and keeps /healthz open', async () => {
    const limited = await startServer(mock, { RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const post = () =>
        fetch(`${limited.base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await post()).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      const refused = await post();
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await refused.json()).toMatchObject({ jsonrpc: '2.0', error: { message: expect.stringContaining('Too many requests') } });
      expect((await fetch(`${limited.base}/healthz`)).status).toBe(200);
    } finally {
      await stopServer(limited.child);
    }
  });
});

