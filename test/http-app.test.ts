import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocsStore } from '../src/docs.js';
import { clientIp, createHttpApp, extractApiKey, RateLimiter } from '../src/http-app.js';

describe('extractApiKey', () => {
  it('reads Bearer tokens and x-api-key, preferring Authorization', () => {
    const key = (headers: Record<string, string>) => extractApiKey(new Headers(headers));
    expect(key({ authorization: 'Bearer abc123' })).toBe('abc123');
    expect(key({ authorization: 'bearer   abc123  ' })).toBe('abc123');
    expect(key({ 'x-api-key': ' xyz ' })).toBe('xyz');
    expect(key({ authorization: 'Bearer abc', 'x-api-key': 'xyz' })).toBe('abc');
    expect(key({ authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': 'xyz' })).toBe('xyz');
    expect(key({ authorization: 'Basic dXNlcjpwYXNz' })).toBeUndefined();
    expect(key({})).toBeUndefined();
  });
});

describe('clientIp', () => {
  const req = (xff: string | undefined, remote = '10.0.0.2') =>
    ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('uses the socket address unless proxies are trusted', () => {
    expect(clientIp(req('1.1.1.1'), 0)).toBe('10.0.0.2');
  });

  it('with N trusted proxies, takes the address the outermost trusted proxy saw (spoofed entries on the left are ignored)', () => {
    expect(clientIp(req('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientIp(req('6.6.6.6, 203.0.113.7, 172.18.0.5'), 2)).toBe('203.0.113.7');
    expect(clientIp(req(undefined), 1)).toBe('10.0.0.2');
  });
});

describe('RateLimiter', () => {
  it('allows `limit` hits per window and key, then resets', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(limiter.take('b').ok).toBe(true);
    now = 45_000;
    expect(limiter.take('a').retryAfterSeconds).toBe(15);
    now = 60_000;
    expect(limiter.take('a').ok).toBe(true);
    limiter.sweep();
  });
});

describe('createHttpApp', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const { handler } = createHttpApp({
      apiUrl: 'http://127.0.0.1:9/v1',
      docs: new DocsStore({ docsUrl: 'http://127.0.0.1:9' }),
      rateLimitPerMinute: 0,
      trustProxy: 0,
      allowedHosts: ['mcp.flightbyte.dev'],
      maxBodyBytes: 1_000,
      log: () => {},
    });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('enforces ALLOWED_HOSTS on /mcp but not on /healthz', async () => {
    const refused = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(refused.status).toBe(403);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('refuses bodies over the limit with 413', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: 'POST', headers: { host: 'mcp.flightbyte.dev', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(5_000) } }));
    });
    expect(status).toBe(413);
  });

  it('describes itself on GET /', async () => {
    const res = await fetch(`${base}/`);
    expect(await res.json()).toMatchObject({ mcp: '/mcp', transport: 'streamable-http' });
  });
});
