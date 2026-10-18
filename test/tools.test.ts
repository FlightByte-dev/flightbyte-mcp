import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/config.js';
import { API_TOOLS } from '../src/tools/api-tools.js';
import { connect, TEST_KEY, text, type Connected } from './helpers/client.js';
import { flightSnapshot, MockFlightByte, subscription } from './helpers/mock.js';

const mock = new MockFlightByte();
let mcp: Connected;

beforeAll(async () => {
  await mock.start();
  mcp = await connect(mock);
});
afterEach(() => mock.reset());
afterAll(async () => {
  await mcp.close();
  await mock.stop();
});

describe('tool list', () => {
  it('exposes the docs tools and one tool per mapped API operation, with annotations', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'search_docs',
        'get_doc_page',
        'get_flight',
        'search_flights',
        'get_flight_timeline',
        'create_subscription',
        'list_subscriptions',
        'get_subscription',
        'update_subscription',
        'pause_subscription',
        'resume_subscription',
        'delete_subscription',
        'send_test_event',
        'list_deliveries',
        'list_events',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(80);
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf('boolean');
      expect(tool.annotations?.openWorldHint, tool.name).toBeTypeOf('boolean');
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.delete_subscription!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.create_subscription!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(byName.get_flight!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.create_subscription!.inputSchema.properties).toHaveProperty('Idempotency-Key');
    expect(tools.some((t) => /secret/.test(t.name))).toBe(false);
  });
});

describe('request mapping', () => {
  it('get_flight: path parameters, query selectors, refresh as a string, key and User-Agent headers', async () => {
    mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
    const result = await mcp.call('get_flight', {
      carrier: 'tk',
      flightNumber: '1848',
      date: '2026-10-18',
      origin: 'ist',
      refresh: true,
    });
    expect(result.isError).toBeFalsy();
    expect(mock.last).toMatchObject({ method: 'GET', path: '/v1/flights/TK/1848/2026-10-18', query: { origin: 'IST', refresh: 'true' } });
    expect(mock.last!.headers['x-api-key']).toBe(TEST_KEY);
    expect(mock.last!.headers['user-agent']).toBe(`flightbyte-mcp/${VERSION}`);
    expect(result.structuredContent).toMatchObject({ flightKey: 'TK1848:2026-10-18@IST-ATH' });
    expect(JSON.parse(result.content.at(-1)!.type === 'text' ? (result.content.at(-1) as { text: string }).text : '')).toMatchObject({
      flightNumber: '1848',
    });
  });

  it('get_flight: notes when the number operates several legs and no selector was given', async () => {
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', {
      status: 200,
      body: flightSnapshot({
        flightKey: 'TK1:2026-10-18@SAW-AMS',
        alternates: [
          { departureIata: 'SAW', arrivalIata: 'AMS', selected: true },
          { departureIata: 'IST', arrivalIata: 'JFK', selected: false },
        ],
      }),
    });
    const result = await mcp.call('get_flight', { carrier: 'TK', flightNumber: '1', date: '2026-10-18' });
    expect(text(result)).toContain('operates 2 legs');
    expect(text(result)).toContain('SAW→AMS (this snapshot)');
    expect(text(result)).toContain('call again with `origin`');
  });

  it('search_flights: everything in the query string', async () => {
    await mcp.call('search_flights', { carrier: 'TK', flightNumber: '0012', date: '2026-10-18', destination: 'jfk', flightId: '1407266450' });
    expect(mock.last).toMatchObject({
      method: 'GET',
      path: '/v1/flights/search',
      query: { carrier: 'TK', flightNumber: '0012', date: '2026-10-18', destination: 'JFK', flightId: '1407266450' },
    });
  });

  it('get_flight_timeline', async () => {
    mock.on('GET', '/v1/flights/PC/1001/2026-10-18/timeline', { status: 200, body: { flightKey: 'PC1001:2026-10-18', count: 0, data: [] } });
    const result = await mcp.call('get_flight_timeline', { carrier: 'PC', flightNumber: '1001', date: '2026-10-18', origin: 'SAW' });
    expect(mock.last).toMatchObject({ path: '/v1/flights/PC/1001/2026-10-18/timeline', query: { origin: 'SAW' } });
    expect(result.structuredContent).toEqual({ flightKey: 'PC1001:2026-10-18', count: 0, data: [] });
  });

  it('create_subscription: JSON body, Idempotency-Key header, and a warning that the secret is shown once', async () => {
    mock.on('POST', '/v1/subscriptions', { status: 201, body: subscription({ secret: 'whsec_FULLSECRETVALUE', secretHint: undefined }) });
    const result = await mcp.call('create_subscription', {
      carrier: 'TK',
      flightNumber: '1848',
      date: '2026-10-18',
      origin: 'IST',
      webhookUrl: 'https://example.com/hooks/flights',
      events: ['flight.departed', 'flight.arrived'],
      delayThresholdMinutes: 5,
      metadata: { bookingId: 'BK-1042' },
      headers: { Authorization: 'Bearer receiver-token' },
      'Idempotency-Key': 'booking-BK-1042',
    });
    expect(result.isError).toBeFalsy();
    expect(mock.last).toMatchObject({
      method: 'POST',
      path: '/v1/subscriptions',
      body: {
        carrier: 'TK',
        flightNumber: '1848',
        date: '2026-10-18',
        origin: 'IST',
        webhookUrl: 'https://example.com/hooks/flights',
        events: ['flight.departed', 'flight.arrived'],
        delayThresholdMinutes: 5,
        metadata: { bookingId: 'BK-1042' },
        headers: { Authorization: 'Bearer receiver-token' },
      },
    });
    expect(mock.last!.body).not.toHaveProperty('Idempotency-Key');
    expect(mock.last!.headers['idempotency-key']).toBe('booking-BK-1042');
    expect(mock.last!.headers['content-type']).toBe('application/json');
    const out = text(result);
    expect(out).toMatch(/shown in full only in this response/);
    expect(out).toContain('whsec_FULLSECRETVALUE');
    expect(result.structuredContent).toMatchObject({ id: 'sub_test123', secret: 'whsec_FULLSECRETVALUE' });
  });

  it('create_subscription: mentions a pending status', async () => {
    mock.on('POST', '/v1/subscriptions', { status: 201, body: subscription({ status: 'pending', secret: 'whsec_x' }) });
    const result = await mcp.call('create_subscription', {
      carrier: 'TK',
      flightNumber: '1848',
      date: '2026-10-24',
      webhookUrl: 'https://example.com/hooks',
    });
    expect(text(result)).toContain('Status is `pending`');
  });

  it('create_subscription: rejects a non-http webhook URL and an unknown change type before calling the API', async () => {
    const bad = await mcp.call('create_subscription', { carrier: 'TK', flightNumber: '1848', date: '2026-10-18', webhookUrl: 'ftp://example.com' });
    expect(bad.isError).toBe(true);
    const badEvent = await mcp.call('create_subscription', {
      carrier: 'TK',
      flightNumber: '1848',
      date: '2026-10-18',
      webhookUrl: 'https://example.com',
      events: ['flight.teleported'],
    });
    expect(badEvent.isError).toBe(true);
    expect(mock.apiRequests).toHaveLength(0);
  });

  it('list_subscriptions: filters and paging as query strings', async () => {
    mock.on('GET', '/v1/subscriptions', { status: 200, body: { total: 1, data: [subscription()] } });
    const result = await mcp.call('list_subscriptions', { status: 'active', carrier: 'TK', flightNumber: '1848', date: '2026-10-18', limit: 50, offset: 10 });
    expect(mock.last).toMatchObject({
      method: 'GET',
      path: '/v1/subscriptions',
      query: { status: 'active', carrier: 'TK', flightNumber: '1848', date: '2026-10-18', limit: '50', offset: '10' },
    });
    expect(result.structuredContent).toMatchObject({ total: 1 });
  });

  it('list_subscriptions: no arguments sends no query', async () => {
    await mcp.call('list_subscriptions');
    expect(mock.last).toMatchObject({ path: '/v1/subscriptions', query: {} });
  });

  it.each([
    ['get_subscription', 'GET', '/v1/subscriptions/sub_test123'],
    ['pause_subscription', 'POST', '/v1/subscriptions/sub_test123/pause'],
    ['resume_subscription', 'POST', '/v1/subscriptions/sub_test123/resume'],
    ['send_test_event', 'POST', '/v1/subscriptions/sub_test123/test'],
    ['list_deliveries', 'GET', '/v1/subscriptions/sub_test123/deliveries'],
    ['list_events', 'GET', '/v1/subscriptions/sub_test123/events'],
  ])('%s → %s %s', async (tool, method, path) => {
    const result = await mcp.call(tool, { id: 'sub_test123' });
    expect(result.isError).toBeFalsy();
    expect(mock.last).toMatchObject({ method, path, query: {} });
    expect(mock.last!.body).toBeUndefined();
  });

  it('list_deliveries and list_events pass limit', async () => {
    await mcp.call('list_deliveries', { id: 'sub_test123', limit: 5 });
    expect(mock.last).toMatchObject({ path: '/v1/subscriptions/sub_test123/deliveries', query: { limit: '5' } });
    await mcp.call('list_events', { id: 'sub_test123', limit: 100 });
    expect(mock.last).toMatchObject({ path: '/v1/subscriptions/sub_test123/events', query: { limit: '100' } });
  });

  it('update_subscription: PATCH with only the given fields', async () => {
    mock.on('PATCH', '/v1/subscriptions/sub_test123', { status: 200, body: subscription({ delayThresholdMinutes: 15 }) });
    const result = await mcp.call('update_subscription', { id: 'sub_test123', delayThresholdMinutes: 15, events: ['delay.increased'] });
    expect(result.isError).toBeFalsy();
    expect(mock.last).toMatchObject({ method: 'PATCH', path: '/v1/subscriptions/sub_test123' });
    expect(mock.last!.body).toEqual({ delayThresholdMinutes: 15, events: ['delay.increased'] });
  });

  it('update_subscription: refuses an empty update without calling the API', async () => {
    const result = await mcp.call('update_subscription', { id: 'sub_test123' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing to update');
    expect(mock.apiRequests).toHaveLength(0);
  });

  it('delete_subscription: DELETE, and a 204 becomes a plain confirmation', async () => {
    mock.on('DELETE', '/v1/subscriptions/sub_test123', { status: 204 });
    const result = await mcp.call('delete_subscription', { id: 'sub_test123' });
    expect(mock.last).toMatchObject({ method: 'DELETE', path: '/v1/subscriptions/sub_test123' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Subscription sub_test123 deleted');
    expect(result.structuredContent).toBeUndefined();
  });

  it('encodes ids into the path', async () => {
    await mcp.call('get_subscription', { id: 'sub_a/../b?c' });
    expect(mock.requests.at(-1)!.path).toBe('/v1/subscriptions/sub_a%2F..%2Fb%3Fc');
  });

  it('validates arguments before calling the API', async () => {
    const result = await mcp.call('get_flight', { carrier: 'TOOLONG', flightNumber: '1848', date: '18/10/2026' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/carrier|date/);
    expect(mock.apiRequests).toHaveLength(0);
  });

  it('every API tool path placeholder is filled from a path parameter', () => {
    for (const def of API_TOOLS) {
      const placeholders = [...def.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const pathParams = Object.entries(def.params)
        .filter(([, p]) => p.in === 'path')
        .map(([name]) => name);
      expect(placeholders.sort(), def.name).toEqual(pathParams.sort());
    }
  });
});

describe('without an API key', () => {
  it('API tools explain how to configure one and make no request; docs tools still work', async () => {
    const keyless = await connect(mock, { apiKey: null });
    try {
      const result = await keyless.call('get_flight', { carrier: 'TK', flightNumber: '1848', date: '2026-10-18' });
      expect(result.isError).toBe(true);
      const out = text(result);
      expect(out).toContain('No FlightByte API key is configured');
      expect(out).toContain('FLIGHTBYTE_KEY');
      expect(out).toContain('Authorization: Bearer');
      expect(out).toContain('https://app.flightbyte.dev/signup');
      expect(mock.apiRequests).toHaveLength(0);

      const docs = await keyless.call('search_docs', { query: 'webhook signature' });
      expect(docs.isError).toBeFalsy();
    } finally {
      await keyless.close();
    }
  });
});
