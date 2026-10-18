import { createServer as createHttpServer } from 'node:http';
import { loadConfig, VERSION } from './config.js';
import { DocsStore } from './docs.js';
import { createHttpApp } from './http-app.js';

const config = loadConfig();
const port = intEnv('PORT', 8080);
const host = process.env.HOST?.trim() || '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

// Bound to loopback, only loopback Host headers are accepted (DNS rebinding protection), unless ALLOWED_HOSTS says otherwise.
const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
if (allowedHosts.length === 0 && loopback) allowedHosts.push('localhost', '127.0.0.1', '[::1]');

const app = createHttpApp({
  apiUrl: config.apiUrl,
  docs: new DocsStore({ docsUrl: config.docsUrl }),
  rateLimitPerMinute: intEnv('RATE_LIMIT_PER_MINUTE', 120),
  trustProxy: intEnv('TRUST_PROXY', 0),
  allowedHosts,
});

const server = createHttpServer((req, res) => void app.handler(req, res));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;

const sweeper = setInterval(() => app.limiter?.sweep(), 60_000);
sweeper.unref();

server.listen(port, host, () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  console.error(`flightbyte-mcp ${VERSION} listening on http://${host.includes(':') ? `[${host}]` : host}:${bound}/mcp`);
});

const shutdown = (signal: string) => {
  console.error(`${signal} received, closing`);
  // End in-flight 2026-era exchanges so open streams do not hold the server past the grace period.
  void app.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}
