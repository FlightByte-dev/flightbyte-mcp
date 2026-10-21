import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { ApiClient } from '../src/api.js';
import { apiErrorResult } from '../src/errors.js';
import { connect, text, type Connected } from './helpers/client.js';
import { MockFlightByte } from './helpers/mock.js';

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

const flight = { carrier: 'TK', flightNumber: '1', date: '2026-10-18' };
const newSubscription = { ...flight, webhookUrl: 'https://example.com/hooks' };

function envelope(statusCode: number, error: string, message: string | string[], extra: Record<string, unknown> = {}) {
  return { statusCode, error, message, path: '/v1/x', timestamp: '2026-10-18T10:00:00.000Z', requestId: 'req-1234', ...extra };
}

describe('API error envelope → isError result', () => {
  it('400 with legs: pass origin or flightId, and list the legs', async () => {
    mock.on('POST', '/v1/subscriptions', {
      status: 400,
      body: envelope(400, 'BadRequestException', 'TK1 operates 2 legs on 2026-10-18. Pass "origin" to choose one.', {
        legs: [
          { origin: 'SAW', destination: 'AMS', carrier: 'AJA', scheduledDepartureLocal: '08:45', flightId: '1407278900' },
          { origin: 'ISL', destination: 'JFK', carrier: 'TK', scheduledDepartureLocal: '14:10', flightId: '1407266450' },
        ],
      }),
    });
    const result = await mcp.call('create_subscription', newSubscription);
    expect(result.isError).toBe(true);
    const out = text(result);
    expect(out).toContain('FlightByte API error 400 BadRequestException');
    expect(out).toContain('TK1 operates 2 legs');
    expect(out).toContain('call `create_subscription` again with `origin`');
    expect(out).toContain('SAW → AMS, operated by AJA, departs 08:45 local: pass origin "SAW" or flightId "1407278900"');
    expect(out).toContain('ISL → JFK');
    expect(out).toContain('requestId: req-1234');
  });

  it('400 validation: joins an array of messages and says to fix the arguments', async () => {
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', {
      status: 400,
      body: envelope(400, 'BadRequestException', ['origin must be a 3-4 character airport code', 'flightId is malformed']),
    });
    const out = text(await mcp.call('get_flight', flight));
    expect(out).toContain('origin must be a 3-4 character airport code; flightId is malformed');
    expect(out).toContain('Fix the arguments');
  });

  it('401: do not retry, check the configured key', async () => {
    mock.on('GET', '/v1/subscriptions', { status: 401, body: envelope(401, 'UnauthorizedException', 'Invalid API key.') });
    const out = text(await mcp.call('list_subscriptions'));
    expect(out).toContain('401');
    expect(out).toContain('Do not retry');
    expect(out).toContain('FLIGHTBYTE_KEY');
    expect(out).toContain('https://app.flightbyte.dev/keys');
  });

  it('402 watched_flight_limit: usage, reset time, existing ones keep running, upgrade link', async () => {
    mock.on('POST', '/v1/subscriptions', {
      status: 402,
      body: envelope(402, 'PaymentRequiredException', 'Watched flight limit reached.', {
        code: 'watched_flight_limit',
        limit: 3,
        used: 3,
        resetsAt: '2026-11-01T00:00:00.000Z',
      }),
    });
    const out = text(await mcp.call('create_subscription', newSubscription));
    expect(out).toContain('(code: watched_flight_limit)');
    expect(out).toContain('(3/3 this month)');
    expect(out).toContain('resets at 2026-11-01T00:00:00.000Z');
    expect(out).toContain('existing subscriptions keep running');
    expect(out).toContain('Do not retry');
    expect(out).toContain('https://app.flightbyte.dev/plan');
  });

  it('402 overage_cap_reached: the cap, usage, nothing billed, raise or remove it on the Plan page', async () => {
    mock.on('POST', '/v1/subscriptions', {
      status: 402,
      body: envelope(402, 'PaymentRequired', 'This account caps extra flights at $20.00 a month.', {
        code: 'overage_cap_reached',
        limit: 350,
        used: 350,
        resetsAt: '2026-11-01T00:00:00.000Z',
        capCents: 2000,
      }),
    });
    const out = text(await mcp.call('create_subscription', newSubscription));
    expect(out).toContain('(code: overage_cap_reached)');
    expect(out).toContain('($20.00 a month)');
    expect(out).toContain('(350/350 this month)');
    expect(out).toContain('nothing was billed');
    expect(out).toContain('resets at 2026-11-01T00:00:00.000Z');
    expect(out).toContain('existing subscriptions keep running');
    expect(out).toContain('raise or remove the cap at https://app.flightbyte.dev/plan');
    expect(out).not.toContain('upgrade');
  });

  it('404 on a subscription: look the id up with list_subscriptions', async () => {
    mock.on('GET', '/v1/subscriptions/sub_nope', { status: 404, body: envelope(404, 'NotFoundException', 'Subscription sub_nope not found.') });
    const out = text(await mcp.call('get_subscription', { id: 'sub_nope' }));
    expect(out).toContain('No subscription with this id exists for this API key');
    expect(out).toContain('list_subscriptions');
  });

  it('404 on a flight: check the date and coverage window', async () => {
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', {
      status: 404,
      body: envelope(404, 'NotFoundException', 'TK1 on 2026-10-18 has no leg matching origin=LHR. Available: SAW-AMS, ISL-JFK.'),
    });
    const out = text(await mcp.call('get_flight', { ...flight, origin: 'LHR' }));
    expect(out).toContain('Available: SAW-AMS, ISL-JFK');
    expect(out).toContain('local departure date at the origin');
    expect(out).toContain('seven days ahead');
  });

  it('409: find the existing subscription instead of creating another', async () => {
    mock.on('POST', '/v1/subscriptions', { status: 409, body: envelope(409, 'ConflictException', 'Duplicate.') });
    const out = text(await mcp.call('create_subscription', { ...newSubscription, 'Idempotency-Key': 'k1' }));
    expect(out).toContain('already exists under the same Idempotency-Key');
    expect(out).toContain('list_subscriptions');
  });

  it('429: wait for Retry-After, do not loop', async () => {
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', {
      status: 429,
      headers: { 'retry-after': '23' },
      body: envelope(429, 'TooManyRequests', 'Quota exceeded for the current minute window (120/120).', { window: 'minute', retryAfterSeconds: 23 }),
    });
    const out = text(await mcp.call('get_flight', flight));
    expect(out).toContain('the minute quota window is full');
    expect(out).toContain('Wait 23 seconds (Retry-After)');
    expect(out).toContain('Do not retry in a loop');
  });

  it('429 without the header falls back to retryAfterSeconds in the body', () => {
    const result = apiErrorResult(
      { kind: 'http_error', status: 429, body: envelope(429, 'TooManyRequests', 'Quota exceeded.', { window: 'day', retryAfterSeconds: 3600 }), text: '', headers: new Headers() },
      { tool: 'get_flight', resource: 'flight' },
    );
    expect(text(result)).toContain('Wait 3600 seconds');
  });

  it('502 and 503: safe to retry once', async () => {
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', { status: 502, body: envelope(502, 'BadGatewayException', 'Upstream failed after retries.') });
    expect(text(await mcp.call('get_flight', flight))).toContain('Safe to retry once');
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', { status: 503, body: envelope(503, 'ServiceUnavailableException', 'Deploying.') });
    expect(text(await mcp.call('get_flight', flight))).toContain('Safe to retry once');
  });

  it('a non-JSON error body is quoted, not dropped', async () => {
    mock.on('GET', '/v1/flights/TK/1/2026-10-18', { status: 500, raw: '<html>Internal Server Error</html>', headers: { 'content-type': 'text/html' } });
    const out = text(await mcp.call('get_flight', flight));
    expect(out).toContain('FlightByte API error 500');
    expect(out).toContain('Body: <html>Internal Server Error</html>');
    expect(out).toContain('Retry once');
  });
});

describe('network failures', () => {
  it('an unreachable API becomes a retry-once result, not a crash', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' });
    const result = await client.request({ method: 'GET', path: '/flights/TK/1/2026-10-18' });
    expect(result.kind).toBe('network_error');
    const out = text(apiErrorResult(result as Exclude<typeof result, { kind: 'ok' }>, { tool: 'get_flight', resource: 'flight' }));
    expect(out).toContain('Could not reach the FlightByte API');
    expect(out).toContain('retry once');
  });

  it('a timeout is reported as such', async () => {
    const slow = new ApiClient({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      timeoutMs: 50,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    const result = await slow.request({ method: 'GET', path: '/x' });
    expect(result).toMatchObject({ kind: 'network_error', message: 'no response within 1s' });
  });
});
