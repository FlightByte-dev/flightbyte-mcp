import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { DocsStore } from '../docs.js';
import { toolError } from '../errors.js';

/** Path and URL parts that say nothing about which page was meant. */
const ROOT_WORDS = new Set(['docs', 'guides', 'glossary', 'reference', 'md', 'http', 'https', 'www', 'flightbyte', 'dev']);

export function registerDocsTools(server: McpServer, docs: DocsStore): void {
  server.registerTool(
    'search_docs',
    {
      title: 'Search the FlightByte docs',
      description:
        'Keyword search over the whole FlightByte documentation: the docs, the API reference, the engineering guides and the glossary. ' +
        'Returns the best-matching sections with title, URL and a snippet. Use it before answering questions about the API (authentication, quotas, errors, flight lookups, leg selection, ' +
        'subscriptions, webhook payloads and change types, signature verification, retries) or before writing integration code, then read the full page with get_doc_page. Works without an API key.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(300)
          .describe('Keywords, e.g. "verify webhook signature", "429 retry", "flight number two legs origin", "baggage carousel event".'),
        limit: z.number().int().min(1).max(10).optional().describe('How many sections to return, 1 to 10. Default 5.'),
      }),
      annotations: { title: 'Search the FlightByte docs', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      let hits;
      try {
        hits = await docs.search(query, limit ?? 5);
      } catch (err) {
        return toolError(
          `The docs could not be loaded (${err instanceof Error ? err.message : String(err)}). Retry shortly; the same content is at ${docs.docsUrl}/llms-full.txt.`,
        );
      }
      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No docs section matched "${query}". Try fewer or different keywords, or open the index with get_doc_page("/docs").`,
            },
          ],
          structuredContent: { query, results: [] },
        };
      }
      const text = [
        `Top ${hits.length} docs sections for "${query}":`,
        '',
        ...hits.flatMap((hit, i) => [`${i + 1}. ${hit.title}`, `   ${hit.url}`, `   ${hit.snippet}`, '']),
        'Read a full page with get_doc_page, passing its URL.',
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { query, results: hits.map(({ title, url, snippet }) => ({ title, url, snippet })) },
      };
    },
  );

  server.registerTool(
    'get_doc_page',
    {
      title: 'Read a FlightByte docs page',
      description:
        'Fetch one FlightByte documentation page as Markdown. Accepts a URL from search_docs (anchors are ignored) or a path such as "/docs/webhooks", "/docs/reference/subscriptions/create-subscription", ' +
        '"/guides/verifying-webhook-signatures" or "/glossary/flight-phase". "/docs" is the introduction, with links to every page. Works without an API key.',
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .max(500)
          .describe('Docs path or URL, e.g. "/docs/errors" or "https://flightbyte.dev/docs/webhooks#verifying-signatures".'),
      }),
      annotations: { title: 'Read a FlightByte docs page', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path }): Promise<CallToolResult> => {
      const page = await docs.page(path);
      if (page.ok) return { content: [{ type: 'text', text: page.markdown }] };
      if (page.status === 'not_found') {
        let suggestions = '';
        try {
          const words = path
            .split(/[/#?.:-]+/)
            .filter((w) => w && !ROOT_WORDS.has(w.toLowerCase()))
            .join(' ');
          const hits = words ? await docs.search(words, 3) : [];
          if (hits.length > 0) suggestions = `\nClosest pages: ${hits.map((h) => h.url.split('#')[0]).filter((u, i, a) => a.indexOf(u) === i).join(', ')}`;
        } catch {
          // Suggestions are a courtesy; the error stands without them.
        }
        return toolError(`${page.message} Use search_docs to find the right page, or get_doc_page("/docs") for the index.${suggestions}`);
      }
      return toolError(page.message);
    },
  );
}
