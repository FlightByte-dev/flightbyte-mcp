import { USER_AGENT } from './config.js';

/**
 * Docs search over https://flightbyte.dev/llms-full.txt: the whole documentation as one Markdown file,
 * pages separated by "\n---\n\n", each starting with "# Title", a "> description" line and "Source: <url>".
 */

export interface DocPage {
  title: string;
  description: string;
  url: string;
  /** The page exactly as it appears in llms-full.txt, title line included. */
  markdown: string;
  sections: DocSection[];
}

export interface DocSection {
  page: DocPage;
  /** null for the text before the first "##" heading. */
  heading: string | null;
  anchor: string | null;
  text: string;
}

export interface SearchHit {
  title: string;
  page: string;
  section: string | null;
  url: string;
  snippet: string;
  score: number;
}

const PAGE_SEPARATOR = /\n---\n\n(?=# )/;

export function parseLlmsFull(text: string): DocPage[] {
  const pages: DocPage[] = [];
  for (const chunk of text.replace(/\r\n/g, '\n').split(PAGE_SEPARATOR)) {
    const markdown = chunk.trim();
    const lines = markdown.split('\n');
    const title = lines[0]?.match(/^# (.+)$/)?.[1]?.trim();
    // Only real pages carry a Source line in their header; the file's own preamble does not.
    const head = lines.slice(0, 8);
    const url = head.find((l) => l.startsWith('Source: '))?.slice('Source: '.length).trim();
    if (!title || !url) continue;
    const description = head.find((l) => l.startsWith('> '))?.slice(2).trim() ?? '';
    const page: DocPage = { title, description, url, markdown, sections: [] };
    page.sections = splitSections(page, lines.slice(1).filter((l) => !l.startsWith('Source: ') && l !== `> ${description}`));
    pages.push(page);
  }
  return pages;
}

function splitSections(page: DocPage, lines: string[]): DocSection[] {
  const sections: DocSection[] = [];
  const seen = new Map<string, number>();
  let current: DocSection = { page, heading: null, anchor: null, text: '' };
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    current.text = buffer.join('\n').trim();
    if (current.text || current.heading) sections.push(current);
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
      buffer.push(line);
      continue;
    }
    const heading = fence === null ? line.match(/^(#{2,3}) (.+)$/) : null;
    if (heading) {
      flush();
      const text = heading[2]!.trim();
      current = { page, heading: stripInline(text), anchor: uniqueSlug(text, seen), text: '' };
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/** github-slugger compatible: what the docs site uses for heading anchors. */
export function slugify(heading: string): string {
  return stripInline(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function uniqueSlug(heading: string, seen: Map<string, number>): string {
  const base = slugify(heading);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function stripInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// Ranking: BM25 over sections, with the section heading and the page title and description counted as
// extra, heavier occurrences, light stemming, and prefix matches at a discount.

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from get how i if in into is it its me my of on or the this that to use what when where which with you your'.split(' '),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

interface IndexedSection {
  section: DocSection;
  tf: Map<string, number>;
  length: number;
  lowerText: string;
}

export interface SearchIndex {
  pages: DocPage[];
  sections: IndexedSection[];
  df: Map<string, number>;
  avgLength: number;
}

const WEIGHT_HEADING = 3;
const WEIGHT_TITLE = 2;
const WEIGHT_DESCRIPTION = 1;
const K1 = 1.2;
const B = 0.75;

export function buildIndex(pages: DocPage[]): SearchIndex {
  const sections: IndexedSection[] = [];
  const df = new Map<string, number>();
  for (const page of pages) {
    const titleTokens = tokenize(page.title);
    const descriptionTokens = tokenize(page.description);
    for (const section of page.sections) {
      const tf = new Map<string, number>();
      const add = (tokens: string[], weight: number) => {
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
      };
      const bodyTokens = tokenize(section.text);
      add(bodyTokens, 1);
      add(tokenize(section.heading ?? ''), WEIGHT_HEADING);
      add(titleTokens, WEIGHT_TITLE);
      // The description summarises the page's opening, so it counts there in full and elsewhere at half.
      add(descriptionTokens, section.heading === null ? WEIGHT_DESCRIPTION : WEIGHT_DESCRIPTION / 2);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      sections.push({
        section,
        tf,
        length: bodyTokens.length,
        lowerText: `${page.title} ${section.heading ?? ''} ${section.text}`.toLowerCase(),
      });
    }
  }
  const avgLength = sections.reduce((sum, s) => sum + s.length, 0) / Math.max(1, sections.length);
  return { pages, sections, df, avgLength };
}

export function search(index: SearchIndex, query: string, limit = 5): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const n = index.sections.length;
  const idf = (t: string) => {
    const df = index.df.get(t) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };

  // Each query term matches itself exactly, and vocabulary words it is a prefix of (or that are a prefix of it) at a discount.
  const vocabulary = [...index.df.keys()];
  const expansions = terms.map((q) => {
    const matches: Array<[string, number]> = [];
    if (index.df.has(q)) matches.push([q, 1]);
    if (q.length >= 4) {
      for (const t of vocabulary) {
        if (t === q) continue;
        if (t.startsWith(q) || (t.length >= 5 && q.startsWith(t))) matches.push([t, 0.5]);
      }
    }
    return matches;
  });
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ');

  const scored: Array<{ entry: IndexedSection; score: number }> = [];
  for (const entry of index.sections) {
    let score = 0;
    let matchedTerms = 0;
    for (const matches of expansions) {
      let best = 0;
      for (const [t, weight] of matches) {
        const tf = entry.tf.get(t);
        if (!tf) continue;
        const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * entry.length) / index.avgLength));
        best = Math.max(best, weight * idf(t) * norm);
      }
      if (best > 0) matchedTerms++;
      score += best;
    }
    if (score === 0) continue;
    // Favour sections that cover more of the query, and exact phrases.
    score *= 0.5 + (0.5 * matchedTerms) / expansions.length;
    if (terms.length > 1 && phrase.length > 3 && entry.lowerText.includes(phrase)) score *= 1.5;
    // The reference pages are generated and long; the hand-written docs explain things.
    const url = entry.section.page.url;
    if (/\/docs(\/|$)/.test(url) && !url.includes('/docs/reference/')) score *= 1.1;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const hits: SearchHit[] = [];
  const perPage = new Map<string, number>();
  for (const { entry, score } of scored) {
    const { page, heading, anchor } = entry.section;
    const count = perPage.get(page.url) ?? 0;
    if (count >= 2) continue;
    perPage.set(page.url, count + 1);
    hits.push({
      title: heading ? `${page.title} › ${heading}` : page.title,
      page: page.title,
      section: heading,
      url: anchor ? `${page.url}#${anchor}` : page.url,
      snippet: snippet(entry.section.text || page.description, terms),
      score: Math.round(score * 100) / 100,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function snippet(text: string, terms: string[], width = 320): string {
  const clean = text
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, ' ')
    .replace(/\|?\s*:?-{3,}:?\s*/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= width) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.search(new RegExp(`\\b${escapeRegExp(t)}`));
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at === -1 ? 0 : at - Math.floor(width / 3));
  const end = Math.min(clean.length, start + width);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Fetching, with a TTL cache shared by every server instance in the process.

export interface DocsStoreOptions {
  docsUrl: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export type PageResult =
  | { ok: true; url: string; markdown: string; from: 'markdown' | 'llms-full' }
  | { ok: false; status: 'invalid' | 'not_found' | 'unavailable'; message: string };

/** Canonical docs host; links in the docs use it even when FLIGHTBYTE_DOCS_URL points somewhere else. */
const CANONICAL_ORIGINS = new Set(['https://flightbyte.dev', 'https://www.flightbyte.dev']);
const PAGE_ROOTS = ['/docs', '/guides', '/glossary'];
const MAX_PAGE_CHARS = 120_000;

export class DocsStore {
  readonly docsUrl: string;
  readonly #origin: string;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #index: { value: SearchIndex; expires: number } | undefined;
  #loading: Promise<SearchIndex> | undefined;
  readonly #pages = new Map<string, { markdown: string; expires: number }>();

  constructor(options: DocsStoreOptions) {
    this.docsUrl = options.docsUrl.replace(/\/+$/, '');
    this.#origin = new URL(this.docsUrl).origin;
    this.#ttlMs = options.ttlMs ?? 15 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** The parsed docs, refreshed after the TTL. A failed refresh keeps serving the previous copy. */
  async index(): Promise<SearchIndex> {
    const cached = this.#index;
    if (cached && cached.expires > this.#now()) return cached.value;
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    try {
      return await this.#loading;
    } catch (err) {
      if (cached) return cached.value;
      throw err;
    }
  }

  async #load(): Promise<SearchIndex> {
    const url = `${this.docsUrl}/llms-full.txt`;
    const res = await this.#get(url, 'text/plain');
    if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
    const pages = parseLlmsFull(await res.text());
    if (pages.length === 0) throw new Error(`${url} contained no pages`);
    const value = buildIndex(pages);
    this.#index = { value, expires: this.#now() + this.#ttlMs };
    return value;
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    return search(await this.index(), query, limit);
  }

  /** Map a docs path or URL to the page's canonical URL on the configured docs site. */
  resolve(input: string): { ok: true; pageUrl: string; path: string } | { ok: false; message: string } {
    const value = input.trim();
    if (!value) return { ok: false, message: 'Pass a docs path such as "/docs/webhooks" or a URL from search_docs.' };
    let url: URL;
    try {
      url = /^[a-z][a-z\d+.-]*:/i.test(value) ? new URL(value) : new URL(value.startsWith('/') ? value : `/${value}`, this.docsUrl);
    } catch {
      return { ok: false, message: `"${value}" is not a docs path or URL.` };
    }
    if (url.origin !== this.#origin && !CANONICAL_ORIGINS.has(url.origin)) {
      return { ok: false, message: `Only FlightByte docs pages can be fetched (${this.docsUrl}/docs, /guides, /glossary), not ${url.origin}.` };
    }
    let path = decodeURIComponent(url.pathname).replace(/\/+$/, '').replace(/\.md$/, '');
    if (path === '' || path === '/llms-full.txt' || path === '/llms.txt') path = '/docs';
    if (!PAGE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) path = `/docs${path}`;
    if (!/^[\w/.-]+$/.test(path) || path.includes('..')) return { ok: false, message: `"${value}" is not a docs path.` };
    return { ok: true, pageUrl: `${this.docsUrl}${path}`, path };
  }

  async page(input: string): Promise<PageResult> {
    const resolved = this.resolve(input);
    if (!resolved.ok) return { ok: false, status: 'invalid', message: resolved.message };
    const { pageUrl, path } = resolved;

    const cached = this.#pages.get(pageUrl);
    if (cached && cached.expires > this.#now()) return { ok: true, url: pageUrl, markdown: cached.markdown, from: 'markdown' };

    let fetchError: string | undefined;
    try {
      const res = await this.#get(`${pageUrl}.md`, 'text/markdown');
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && !type.includes('text/html')) {
        const markdown = truncate(await res.text());
        this.#remember(pageUrl, markdown);
        return { ok: true, url: pageUrl, markdown, from: 'markdown' };
      }
      if (res.status !== 404 && !res.ok) fetchError = `${pageUrl}.md answered ${res.status}`;
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    // Guides and glossary entries have no .md twin; llms-full.txt has every page.
    try {
      const index = await this.index();
      const page = index.pages.find((p) => samePath(p.url, path));
      if (page) return { ok: true, url: page.url, markdown: truncate(page.markdown), from: 'llms-full' };
    } catch (err) {
      fetchError ??= err instanceof Error ? err.message : String(err);
    }

    if (fetchError) return { ok: false, status: 'unavailable', message: `Could not fetch ${pageUrl}: ${fetchError}. Retry shortly.` };
    return { ok: false, status: 'not_found', message: `No docs page at ${pageUrl}.` };
  }

  #remember(url: string, markdown: string) {
    if (this.#pages.size >= 200) this.#pages.delete(this.#pages.keys().next().value!);
    this.#pages.set(url, { markdown, expires: this.#now() + this.#ttlMs });
  }

  #get(url: string, accept: string): Promise<Response> {
    return this.#fetch(url, {
      headers: { accept, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }
}

function samePath(url: string, path: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === path;
  } catch {
    return false;
  }
}

function truncate(markdown: string): string {
  if (markdown.length <= MAX_PAGE_CHARS) return markdown;
  return `${markdown.slice(0, MAX_PAGE_CHARS)}\n\n[Truncated at ${MAX_PAGE_CHARS} characters.]`;
}
