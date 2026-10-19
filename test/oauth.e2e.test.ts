/**
 * The hosted server with OAuth on (dist/http.js, spawned), in front of a mock that plays both the
 * API and the authorization server's token endpoint: protected resource metadata, the 401 that
 * makes Claude sign in, the token trade, scopes, and API keys working as before.
 */
import type { ChildProcess } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer, stopServer } from './helpers/http-server.js';
import { flightSnapshot, MockFlightByte, type RecordedRequest } from './helpers/mock.js';

const SECRET = 'mcp-exchange-secret-0123456789abcdef';
const RESOURCE = 'https://mcp.flightbyte.test/mcp';
const METADATA = 'https://mcp.flightbyte.test/.well-known/oauth-protected-resource/mcp';
const ALL = 'flights:read subscriptions:read subscriptions:write';
const API_KEY = 'frk_test_plain_api_key_0005';

/** What the mock authorization server knows: client token → the scope it was granted. */
const TOKENS: Record<string, string> = {
  fbo_at_claude: ALL,
  fbo_at_readonly: 'flights:read',
  fbo_at_revoked_later: ALL,
};

const mock = new MockFlightByte();
let child: ChildProcess;
let base = '';
let serverLogs: () => string = () => '';
let trades: RecordedRequest[] = [];
let tokenEndpointDown = false;

function routeTokenEndpoint(): void {
  mock.on('POST', '/oauth/token', (req) => {
    if (tokenEndpointDown) return { status: 500, body: { error: 'server_error' } };
    trades.push(req);
    const expected = `Basic ${Buffer.from(`flightbyte-mcp:${SECRET}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return { status: 401, body: { error: 'invalid_client' } };
    const form = new URLSearchParams(String(req.body));
    const scope = TOKENS[form.get('subject_token') ?? ''];
    if (!scope || form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'The subject token is invalid.' } };
    }
    return {
      status: 200,
      body: {
        access_token: `fbo_at_api_for_${form.get('subject_token')}`,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
      },
    };
  });
}

let nextId = 1;
async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> & { result?: Record<string, unknown> } };
}

const call = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  rpc({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, headers);

const flight = { carrier: 'TK', flightNumber: '1848', date: '2026-10-18' };

beforeAll(async () => {
  await mock.start();
  const started = await startServer(mock, {
    FLIGHTBYTE_OAUTH_CLIENT_SECRET: SECRET,
    FLIGHTBYTE_OAUTH_ISSUER: 'https://api.flightbyte.test',
    FLIGHTBYTE_OAUTH_TOKEN_URL: `${mock.url}/oauth/token`,
    MCP_PUBLIC_URL: 'https://mcp.flightbyte.test',
  });
  child = started.child;
  base = started.base;
  serverLogs = started.logs;
});
afterEach(() => {
  mock.reset();
  trades = [];
  tokenEndpointDown = false;
});
afterAll(async () => {
  await stopServer(child);
  await mock.stop();
});

describe('OAuth on the hosted server', () => {
  it('publishes protected resource metadata at both well-known paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: ['https://api.flightbyte.test'],
        scopes_supported: ALL.split(' '),
      });
    }
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { method: 'OPTIONS' })).status).toBe(204);
    expect(serverLogs()).toContain('OAuth on: resource https://mcp.flightbyte.test/mcp');
  });

  it('signed out: connecting, listing and the docs work; an API tool answers 401 with the challenge', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0' } },
    });
    expect(init.status).toBe(200);
    const list = await rpc({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' });
    expect(list.status).toBe(200);
    expect((list.body.result!.tools as unknown[]).length).toBe(15);
    const docs = await call('search_docs', { query: 'leg selection origin' });
    expect(docs.status).toBe(200);
    expect(docs.body.result!.isError).toBeFalsy();

    const api = await call('get_flight', flight);
    expect(api.status).toBe(401);
    expect(api.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA}", scope="${ALL}"`);
    expect(api.headers.get('access-control-expose-headers')).toContain('www-authenticate');
    expect(api.body).toMatchObject({ error: 'invalid_token' });

    // A batch with any API tool in it asks too.
    const batch = await rpc([
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'search_docs', arguments: { query: 'x' } } },
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'list_events', arguments: { id: 'sub_1' } } },
    ]);
    expect(batch.status).toBe(401);
    expect(mock.apiRequests).toHaveLength(0);
  });

  it('API keys work exactly as before: passed through, never traded', async () => {
    mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
    const res = await call('get_flight', flight, { authorization: `Bearer ${API_KEY}` });
    expect(res.status).toBe(200);
    expect(res.body.result!.structuredContent).toMatchObject({ flightNumber: '1848' });
    expect(mock.last!.headers['x-api-key']).toBe(API_KEY);
    await call('get_flight', flight, { 'x-api-key': API_KEY });
    expect(mock.last!.headers['x-api-key']).toBe(API_KEY);
    expect(trades).toHaveLength(0);
  });

  it('signed in: the token is traded once and the API sees only the traded token', async () => {
    routeTokenEndpoint();
    mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
    const headers = { authorization: 'Bearer fbo_at_claude' };

    const first = await call('get_flight', flight, headers);
    expect(first.status).toBe(200);
    expect(first.body.result!.isError).toBeFalsy();
    expect(mock.last!.headers['x-api-key']).toBe('fbo_at_api_for_fbo_at_claude');
    await call('list_subscriptions', {}, headers);
    expect(mock.last!.headers['x-api-key']).toBe('fbo_at_api_for_fbo_at_claude');
    expect(trades).toHaveLength(1);
    expect(serverLogs()).toContain('tools/call:get_flight key=oauth era=legacy');
    expect(serverLogs()).not.toContain('fbo_at_claude');
  });

  it('a bad token gets 401 on every request, so the client refreshes', async () => {
    routeTokenEndpoint();
    const list = await rpc({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, { authorization: 'Bearer fbo_at_expired' });
    expect(list.status).toBe(401);
    expect(list.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", error_description="The access token is invalid, expired or revoked.", resource_metadata="${METADATA}"`,
    );
  });

  it('a tool outside the granted scopes gets 403 insufficient_scope naming everything still needed', async () => {
    routeTokenEndpoint();
    mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
    const headers = { authorization: 'Bearer fbo_at_readonly' };
    expect((await call('get_flight', flight, headers)).status).toBe(200);

    const create = await call('create_subscription', { ...flight, webhookUrl: 'https://example.com/hooks' }, headers);
    expect(create.status).toBe(403);
    expect(create.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", resource_metadata="${METADATA}", scope="flights:read subscriptions:write"`,
    );
    expect(mock.apiRequests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('access revoked after the trade: that request already answers 401, and the next one asks again', async () => {
    routeTokenEndpoint();
    mock.on('GET', '/v1/subscriptions', { status: 401, body: { statusCode: 401, message: 'Invalid, revoked or expired access token.' } });
    const headers = { authorization: 'Bearer fbo_at_revoked_later' };

    const res = await call('list_subscriptions', {}, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${METADATA}"`);

    delete TOKENS.fbo_at_revoked_later;
    try {
      const next = await call('list_subscriptions', {}, headers);
      expect(next.status).toBe(401);
      expect(trades).toHaveLength(2);
    } finally {
      TOKENS.fbo_at_revoked_later = ALL;
    }
  });

  it('answers 503 when the authorization server cannot be reached, rather than signing the user out', async () => {
    routeTokenEndpoint();
    tokenEndpointDown = true;
    const res = await call('get_flight', flight, { authorization: 'Bearer fbo_at_claude_other' });
    expect(res.status).toBe(503);
  });

  it('carries the traded token into the 2026-07-28 era too', async () => {
    routeTokenEndpoint();
    mock.on('GET', '/v1/subscriptions', { status: 200, body: { total: 0, data: [] } });
    const client = new Client({ name: 'sdk-modern-oauth', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer fbo_at_claude' } } }),
    );
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const result = await client.callTool({ name: 'list_subscriptions', arguments: {} });
      expect(result.structuredContent).toEqual({ total: 0, data: [] });
      expect(mock.last!.headers['x-api-key']).toBe('fbo_at_api_for_fbo_at_claude');
    } finally {
      await client.close();
    }
  });
});
