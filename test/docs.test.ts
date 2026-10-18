import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildIndex, DocsStore, parseLlmsFull, search, slugify, tokenize } from '../src/docs.js';
import { connect, text } from './helpers/client.js';
import { LLMS_FULL, MockFlightByte } from './helpers/mock.js';

const mock = new MockFlightByte();
beforeAll(async () => {
  await mock.start();
});
afterEach(() => mock.reset());
afterAll(async () => {
  await mock.stop();
});

describe('parsing llms-full.txt', () => {
  const pages = parseLlmsFull(LLMS_FULL);

  it('splits pages at the separator, skipping the preamble and fenced look-alikes', () => {
    expect(pages.map((p) => p.title)).toEqual([
      'Introduction',
      'Authentication and quotas',
      'Flights',
      'Webhooks',
      'Verifying webhook signatures the right way',
      'Flight phase',
    ]);
    const webhooks = pages.find((p) => p.title === 'Webhooks')!;
    expect(webhooks.url).toBe('https://flightbyte.dev/docs/webhooks');
    expect(webhooks.description).toBe('The delivery format, every event and change type, how to verify signatures, and what retries look like.');
    expect(webhooks.markdown).toContain('# Not a page: a SKILL.md example inside a code fence');
  });

  it('splits sections at ## headings outside code fences, with github-style anchors', () => {
    const webhooks = pages.find((p) => p.title === 'Webhooks')!;
    expect(webhooks.sections.map((s) => [s.heading, s.anchor])).toEqual([
      [null, null],
      ['Change types', 'change-types'],
      ['Verifying a delivery', 'verifying-a-delivery'],
      ['Retries and suspension', 'retries-and-suspension'],
    ]);
    const intro = pages.find((p) => p.title === 'Introduction')!;
    // "# Look a flight up" is a shell comment in a code block, not a heading.
    expect(intro.sections.map((s) => s.heading)).toEqual([null, 'The shape of it']);
    expect(intro.sections[1]!.text).toContain('# Look a flight up');
  });

  it('slugify matches the docs site anchors', () => {
    expect(slugify('Mistake one: verifying the wrong bytes')).toBe('mistake-one-verifying-the-wrong-bytes');
    expect(slugify('`Retry-After` and backoff')).toBe('retry-after-and-backoff');
    expect(slugify('3. Receive and verify')).toBe('3-receive-and-verify');
  });

  it('tokenize drops stopwords and folds plurals and -ing/-ed', () => {
    expect(tokenize('How do I verify the Webhooks signatures?')).toEqual(['verify', 'webhook', 'signature']);
    expect(tokenize('verifying delayed flights')).toEqual(['verify', 'delay', 'flight']);
  });
});

describe('ranking', () => {
  const index = buildIndex(parseLlmsFull(LLMS_FULL));
  const top = (query: string, n = 3) => search(index, query, n).map((h) => h.url);

  it('ranks the section that answers the question first', () => {
    expect(top('429 retry after')[0]).toBe('https://flightbyte.dev/docs/authentication#when-a-window-is-full');
    expect(top('flight number two legs origin')[0]).toBe('https://flightbyte.dev/docs/flights#leg-selection');
    expect(top('watched flight limit 402')[0]).toBe('https://flightbyte.dev/docs/authentication#quotas');
    expect(top('bearer authorization header')[0]).toBe('https://flightbyte.dev/docs/authentication#the-key');
    expect(top('retries suspension')[0]).toBe('https://flightbyte.dev/docs/webhooks#retries-and-suspension');
  });

  it('prefers the hand-written docs over a guide on the same topic, and keeps the guide in the list', () => {
    const urls = top('verify webhook signature', 5);
    expect(urls[0]).toBe('https://flightbyte.dev/docs/webhooks#verifying-a-delivery');
    expect(urls.some((u) => u.startsWith('https://flightbyte.dev/guides/verifying-webhook-signatures'))).toBe(true);
  });

  it('finds glossary entries and matches by prefix', () => {
    expect(top('phase')).toContain('https://flightbyte.dev/glossary/flight-phase');
    // "baggage" is a prefix match for nothing else; "carousel" does not occur, "baggage" does.
    expect(top('baggage')[0]).toBe('https://flightbyte.dev/docs/webhooks#change-types');
  });

  it('returns at most two sections per page and respects the limit', () => {
    const hits = search(index, 'webhook signature verify raw body', 10);
    const perPage = new Map<string, number>();
    for (const h of hits) perPage.set(h.page, (perPage.get(h.page) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
    expect(search(index, 'flight', 2)).toHaveLength(2);
  });

  it('returns title, URL with anchor, and a snippet around the match', () => {
    const [hit] = search(index, 'retry after', 1);
    expect(hit).toMatchObject({
      title: 'Authentication and quotas › When a window is full',
      url: 'https://flightbyte.dev/docs/authentication#when-a-window-is-full',
    });
    expect(hit!.snippet).toContain('Retry-After');
  });

  it('finds nothing for stopwords or unknown words', () => {
    expect(search(index, 'the and of', 5)).toEqual([]);
    expect(search(index, 'zeppelin', 5)).toEqual([]);
  });
});

describe('DocsStore', () => {
  it('fetches llms-full.txt once per TTL, then refreshes', async () => {
    let now = 1_000_000;
    const store = new DocsStore({ docsUrl: mock.url, ttlMs: 60_000, now: () => now });
    const fetches = () => mock.requests.filter((r) => r.path === '/llms-full.txt').length;

    await Promise.all([store.search('webhook', 3), store.search('flight', 3)]);
    expect(fetches()).toBe(1);
    now += 59_000;
    await store.search('webhook', 3);
    expect(fetches()).toBe(1);
    now += 2_000;
    await store.search('webhook', 3);
    expect(fetches()).toBe(2);
    expect(mock.requests[0]!.headers['user-agent']).toMatch(/^flightbyte-mcp\//);
  });

  it('keeps serving the previous copy when a refresh fails, and fails when there is none', async () => {
    let now = 0;
    const store = new DocsStore({ docsUrl: mock.url, ttlMs: 1_000, now: () => now });
    expect(await store.search('quota', 1)).toHaveLength(1);
    mock.llmsFullStatus = 500;
    now += 5_000;
    expect(await store.search('quota', 1)).toHaveLength(1);

    const fresh = new DocsStore({ docsUrl: mock.url });
    await expect(fresh.search('quota', 1)).rejects.toThrow(/answered 500/);
  });

  it('resolves paths and URLs onto the docs site, and refuses other hosts', () => {
    const store = new DocsStore({ docsUrl: 'http://127.0.0.1:4000' });
    const pageUrl = (input: string) => {
      const r = store.resolve(input);
      return r.ok ? r.pageUrl : `error: ${r.message}`;
    };
    expect(pageUrl('/docs/webhooks')).toBe('http://127.0.0.1:4000/docs/webhooks');
    expect(pageUrl('docs/webhooks/')).toBe('http://127.0.0.1:4000/docs/webhooks');
    expect(pageUrl('webhooks')).toBe('http://127.0.0.1:4000/docs/webhooks');
    expect(pageUrl('reference/flights/get-flight')).toBe('http://127.0.0.1:4000/docs/reference/flights/get-flight');
    expect(pageUrl('https://flightbyte.dev/docs/webhooks.md')).toBe('http://127.0.0.1:4000/docs/webhooks');
    expect(pageUrl('https://flightbyte.dev/docs/webhooks#verifying-a-delivery')).toBe('http://127.0.0.1:4000/docs/webhooks');
    expect(pageUrl('/guides/verifying-webhook-signatures')).toBe('http://127.0.0.1:4000/guides/verifying-webhook-signatures');
    expect(pageUrl('/')).toBe('http://127.0.0.1:4000/docs');
    expect(pageUrl('https://evil.example.com/docs/webhooks')).toMatch(/^error: Only FlightByte docs pages/);
    expect(pageUrl('file:///etc/passwd')).toMatch(/^error:/);
  });
});

describe('docs tools', () => {
  it('search_docs returns ranked sections as text and structuredContent', async () => {
    const mcp = await connect(mock, { apiKey: null });
    try {
      const result = await mcp.call('search_docs', { query: 'retry after 429', limit: 2 });
      expect(result.isError).toBeFalsy();
      const out = text(result);
      expect(out).toContain('1. Authentication and quotas › When a window is full');
      expect(out).toContain('https://flightbyte.dev/docs/authentication#when-a-window-is-full');
      const structured = result.structuredContent as { results: Array<{ title: string; url: string; snippet: string }> };
      expect(structured.results).toHaveLength(2);
      expect(structured.results[0]).toEqual(expect.objectContaining({ url: 'https://flightbyte.dev/docs/authentication#when-a-window-is-full' }));
    } finally {
      await mcp.close();
    }
  });

  it('search_docs reports an unreachable docs site as a tool error', async () => {
    mock.llmsFullStatus = 503;
    const mcp = await connect(mock, { apiKey: null });
    try {
      const result = await mcp.call('search_docs', { query: 'webhook' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('The docs could not be loaded');
    } finally {
      await mcp.close();
    }
  });

  it('get_doc_page fetches <page>.md', async () => {
    const mcp = await connect(mock, { apiKey: null });
    try {
      const result = await mcp.call('get_doc_page', { path: 'https://flightbyte.dev/docs/webhooks#verifying-a-delivery' });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe('# Webhooks\n\n> The delivery format.\n\nThe page as Markdown.');
      expect(mock.requests.at(-1)!.path).toBe('/docs/webhooks.md');
    } finally {
      await mcp.close();
    }
  });

  it('get_doc_page falls back to llms-full.txt for pages without a .md twin (guides, glossary)', async () => {
    const mcp = await connect(mock, { apiKey: null });
    try {
      const result = await mcp.call('get_doc_page', { path: '/guides/verifying-webhook-signatures' });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toMatch(/^# Verifying webhook signatures the right way/);
      expect(mock.requests.map((r) => r.path)).toEqual(['/guides/verifying-webhook-signatures.md', '/llms-full.txt']);
    } finally {
      await mcp.close();
    }
  });

  it('get_doc_page explains a missing page and suggests close ones', async () => {
    const mcp = await connect(mock, { apiKey: null });
    try {
      const result = await mcp.call('get_doc_page', { path: '/docs/flight' });
      expect(result.isError).toBe(true);
      const out = text(result);
      expect(out).toContain(`No docs page at ${mock.url}/docs/flight.`);
      expect(out).toContain('search_docs');
      expect(out).toMatch(/Closest pages: .*flightbyte\.dev\/docs\/flights/);
    } finally {
      await mcp.close();
    }
  });

  it('get_doc_page refuses other hosts without fetching', async () => {
    const mcp = await connect(mock, { apiKey: null });
    try {
      const result = await mcp.call('get_doc_page', { path: 'http://169.254.169.254/latest/meta-data' });
      expect(result.isError).toBe(true);
      expect(mock.requests).toHaveLength(0);
    } finally {
      await mcp.close();
    }
  });
});
