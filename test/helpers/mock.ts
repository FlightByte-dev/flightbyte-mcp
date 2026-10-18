import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const LLMS_FULL = readFileSync(new URL('../fixtures/llms-full.txt', import.meta.url), 'utf8');

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  /** Sent as is instead of JSON-encoding `body`. */
  raw?: string;
  headers?: Record<string, string>;
}

type Route = { method: string; path: string | RegExp; respond: (req: RecordedRequest) => MockResponse };

/**
 * A local stand-in for both api.flightbyte.dev (under /v1) and flightbyte.dev (llms-full.txt and <page>.md).
 * Unrouted API requests answer 200 with an echo of what was received.
 */
export class MockFlightByte {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: Route[] = [];
  readonly docsPages = new Map<string, string>([
    ['/docs.md', '# Introduction\n\nThe docs index.'],
    ['/docs/webhooks.md', '# Webhooks\n\n> The delivery format.\n\nThe page as Markdown.'],
    ['/docs/errors.md', '# Errors\n\nOne error envelope for every failure.'],
  ]);
  llmsFull = LLMS_FULL;
  llmsFullStatus = 200;
  #server: Server | undefined;
  url = '';

  get apiUrl(): string {
    return `${this.url}/v1`;
  }

  /** Requests to the API only (docs fetches excluded). */
  get apiRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith('/v1/'));
  }

  get last(): RecordedRequest | undefined {
    return this.apiRequests.at(-1);
  }

  on(method: string, path: string | RegExp, respond: MockResponse | ((req: RecordedRequest) => MockResponse)): this {
    this.#routes.unshift({ method, path, respond: typeof respond === 'function' ? respond : () => respond });
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.#routes.length = 0;
    this.llmsFull = LLMS_FULL;
    this.llmsFullStatus = 200;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://mock');
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = text;
        }
        const recorded: RecordedRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body,
        };
        this.requests.push(recorded);
        const response = this.#respond(recorded);
        const headers = { ...response.headers };
        let payload = response.raw;
        if (payload === undefined && response.body !== undefined) {
          payload = JSON.stringify(response.body);
          headers['content-type'] ??= 'application/json';
        }
        res.writeHead(response.status, headers).end(payload);
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  #respond(req: RecordedRequest): MockResponse {
    for (const route of this.#routes) {
      const matches = typeof route.path === 'string' ? route.path === req.path : route.path.test(req.path);
      if (route.method === req.method && matches) return route.respond(req);
    }
    if (req.path === '/llms-full.txt') {
      return { status: this.llmsFullStatus, raw: this.llmsFull, headers: { 'content-type': 'text/plain; charset=utf-8' } };
    }
    const page = this.docsPages.get(req.path);
    if (page !== undefined) return { status: 200, raw: page, headers: { 'content-type': 'text/markdown; charset=utf-8' } };
    if (req.path.startsWith('/v1/')) {
      return { status: 200, body: { echo: { method: req.method, path: req.path, query: req.query, body: req.body ?? null } } };
    }
    return { status: 404, raw: 'Not found', headers: { 'content-type': 'text/plain' } };
  }
}

export function flightSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flightKey: 'TK1848:2026-10-18@IST-ATH',
    carrierCode: 'TK',
    flightNumber: '1848',
    date: '2026-10-18',
    status: { code: 'S', label: 'Scheduled', phase: 'scheduled', delayed: false, cancelled: false, diverted: false },
    alternates: [{ departureIata: 'IST', arrivalIata: 'ATH', selected: true }],
    cached: false,
    ...overrides,
  };
}

export function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_test123',
    status: 'active',
    flightKey: 'TK1848:2026-10-18@IST-ATH',
    carrier: 'TK',
    flightNumber: '1848',
    date: '2026-10-18',
    webhookUrl: 'https://example.com/hooks/flights',
    secretHint: 'whsec_abcde...wxyz',
    events: ['flight.departed'],
    delayThresholdMinutes: 1,
    ...overrides,
  };
}
