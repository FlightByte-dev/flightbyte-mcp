import { describe, expect, it } from 'vitest';
import {
  bearerChallenge,
  calledTools,
  loadOAuthOptions,
  protectedResourceMetadata,
  resourceMetadataPaths,
  resourceMetadataUrl,
  scopeSatisfies,
  TokenExchanger,
  type OAuthOptions,
} from '../src/oauth.js';
import { API_TOOLS } from '../src/tools/api-tools.js';

const OPTIONS: OAuthOptions = {
  resource: 'https://mcp.flightbyte.dev/mcp',
  issuer: 'https://api.flightbyte.dev',
  clientId: 'flightbyte-mcp',
  clientSecret: 'a-secret-of-at-least-thirty-two-chars',
};

describe('protected resource metadata', () => {
  it('lives at the path-suffixed well-known URL and at the root', () => {
    expect(resourceMetadataUrl('https://mcp.flightbyte.dev/mcp')).toBe('https://mcp.flightbyte.dev/.well-known/oauth-protected-resource/mcp');
    expect(resourceMetadataUrl('https://mcp.example.com')).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(resourceMetadataPaths('https://mcp.flightbyte.dev/mcp')).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('names the MCP URL exactly as people add it, and the API as its only authorization server', () => {
    expect(protectedResourceMetadata(OPTIONS)).toEqual({
      resource: 'https://mcp.flightbyte.dev/mcp',
      authorization_servers: ['https://api.flightbyte.dev'],
      scopes_supported: ['flights:read', 'subscriptions:read', 'subscriptions:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'FlightByte',
      resource_documentation: 'https://flightbyte.dev/docs/ai',
    });
  });
});

describe('bearerChallenge', () => {
  it('points at the metadata and carries the scopes', () => {
    expect(bearerChallenge(OPTIONS, { scope: ['flights:read', 'subscriptions:write'] })).toBe(
      'Bearer resource_metadata="https://mcp.flightbyte.dev/.well-known/oauth-protected-resource/mcp", scope="flights:read subscriptions:write"',
    );
    expect(bearerChallenge(OPTIONS, { error: 'invalid_token', description: 'Expired "now"' })).toBe(
      'Bearer error="invalid_token", error_description="Expired now", resource_metadata="https://mcp.flightbyte.dev/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('scopes', () => {
  it('gives every API tool a scope, and every tool that changes something the write scope', () => {
    for (const def of API_TOOLS) {
      expect(def.scope, def.name).toBeDefined();
      const writes = def.annotations.readOnlyHint !== true;
      expect(def.scope === 'subscriptions:write', def.name).toBe(writes);
    }
    expect(API_TOOLS.filter((def) => def.scope === 'flights:read').map((def) => def.name)).toEqual([
      'get_flight',
      'search_flights',
      'get_flight_timeline',
    ]);
  });

  it('lets write cover read', () => {
    expect(scopeSatisfies(['subscriptions:write'], 'subscriptions:read')).toBe(true);
    expect(scopeSatisfies(['subscriptions:read'], 'subscriptions:write')).toBe(false);
    expect(scopeSatisfies(['subscriptions:write'], 'flights:read')).toBe(false);
  });

  it('finds the tools a JSON-RPC message or batch calls', () => {
    expect(calledTools({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_flight' } })).toEqual(['get_flight']);
    expect(
      calledTools([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_docs' } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_subscription' } },
      ]),
    ).toEqual(['search_docs', 'delete_subscription']);
    expect(calledTools(null)).toEqual([]);
    expect(calledTools({ method: 'tools/call', params: { name: 42 } })).toEqual([]);
  });
});

describe('loadOAuthOptions', () => {
  it('is off without the client secret, and defaults to the production addresses', () => {
    expect(loadOAuthOptions({})).toBeNull();
    expect(loadOAuthOptions({ FLIGHTBYTE_OAUTH_CLIENT_SECRET: 's3cret' })).toEqual({
      resource: 'https://mcp.flightbyte.dev/mcp',
      issuer: 'https://api.flightbyte.dev',
      clientId: 'flightbyte-mcp',
      clientSecret: 's3cret',
      tokenEndpoint: undefined,
      apiAudience: undefined,
    });
    expect(
      loadOAuthOptions({
        FLIGHTBYTE_OAUTH_CLIENT_SECRET: 's3cret',
        MCP_PUBLIC_URL: 'https://mcp.staging.flightbyte.dev/',
        FLIGHTBYTE_OAUTH_ISSUER: 'https://api.staging.flightbyte.dev',
        FLIGHTBYTE_OAUTH_TOKEN_URL: 'http://api:3000/oauth/token',
      }),
    ).toMatchObject({
      resource: 'https://mcp.staging.flightbyte.dev/mcp',
      issuer: 'https://api.staging.flightbyte.dev',
      tokenEndpoint: 'http://api:3000/oauth/token',
    });
  });
});

describe('TokenExchanger', () => {
  const setup = (respond: (body: URLSearchParams, auth: string | null) => { status: number; body: unknown }) => {
    let now = 1_000_000;
    const calls: URLSearchParams[] = [];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      calls.push(body);
      const auth = new Headers(init?.headers).get('authorization');
      const answer = respond(body, auth);
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const exchanger = new TokenExchanger({ ...OPTIONS, fetch: fetchStub, now: () => now });
    return { exchanger, calls, advance: (ms: number) => (now += ms) };
  };

  it('trades with RFC 8693 parameters and Basic client authentication, then serves the trade from memory', async () => {
    const { exchanger, calls, advance } = setup((_body, auth) => {
      expect(auth).toBe(`Basic ${Buffer.from('flightbyte-mcp:a-secret-of-at-least-thirty-two-chars').toString('base64')}`);
      return { status: 200, body: { access_token: `fbo_at_api_${calls.length}`, expires_in: 3600, scope: 'flights:read' } };
    });

    const [a, b] = await Promise.all([exchanger.trade('fbo_at_client'), exchanger.trade('fbo_at_client')]);
    expect(a).toEqual({ kind: 'ok', token: 'fbo_at_api_1', scopes: ['flights:read'] });
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'fbo_at_client',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: 'https://api.flightbyte.dev',
    });

    advance(3_000_000);
    expect(await exchanger.trade('fbo_at_client')).toMatchObject({ token: 'fbo_at_api_1' });
    // Dropped 30 seconds before it would expire.
    advance(580_000);
    expect(await exchanger.trade('fbo_at_client')).toMatchObject({ token: 'fbo_at_api_2' });

    exchanger.forget('fbo_at_client');
    expect(await exchanger.trade('fbo_at_client')).toMatchObject({ token: 'fbo_at_api_3' });
    expect(exchanger.size).toBe(1);
  });

  it('tells a bad token apart from a broken trade', async () => {
    const invalid = setup(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } }));
    expect(await invalid.exchanger.trade('fbo_at_x')).toEqual({ kind: 'invalid', reason: 'revoked' });
    // Not cached: the next request asks again.
    await invalid.exchanger.trade('fbo_at_x');
    expect(invalid.calls).toHaveLength(2);

    const misconfigured = setup(() => ({ status: 401, body: { error: 'invalid_client' } }));
    expect(await misconfigured.exchanger.trade('fbo_at_x')).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('invalid_client') });

    const down = new TokenExchanger({
      ...OPTIONS,
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(await down.trade('fbo_at_x')).toMatchObject({ kind: 'unavailable', reason: 'connect ECONNREFUSED' });
  });
});
