import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { ApiClient } from './api.js';
import { VERSION } from './config.js';
import { DocsStore } from './docs.js';
import { API_TOOLS, inputSchema, runApiTool } from './tools/api-tools.js';
import { registerDocsTools } from './tools/docs-tools.js';

export { VERSION } from './config.js';
export { DocsStore } from './docs.js';
export { API_TOOLS } from './tools/api-tools.js';

const INSTRUCTIONS = `FlightByte is a flight status API with signed webhooks.

- Questions about the API, its errors, webhooks or how to integrate: call search_docs, then get_doc_page for the full page. These work without an API key.
- Flight status: get_flight with carrier (e.g. "TK"), flightNumber (e.g. "1848") and date, the local departure date at the origin (YYYY-MM-DD). A flight number can operate several legs on one date; pass origin when the user names a departure airport.
- To be told about changes instead of asking repeatedly, create_subscription with the user's webhook URL. Each subscription is a billable watched flight, so create one only when the user asks. The response carries the webhook signing secret, shown once: relay it to the user.
- Manage subscriptions with list_subscriptions, get_subscription, update_subscription, pause_subscription, resume_subscription and delete_subscription (ask before deleting); debug a receiver with send_test_event, list_deliveries and list_events.
- When a tool returns an error, follow its "What to do" line; do not retry 400, 401, 402 or 404 errors unchanged.`;

export interface ServerOptions {
  apiUrl: string;
  /** The caller's FlightByte API key. Without one, API tools explain how to configure it and docs tools still work. */
  apiKey?: string;
  /** Shared across server instances so the docs are fetched once per TTL, not once per request. */
  docs: DocsStore;
  fetch?: typeof fetch;
  /** Called when the API answers 401; the HTTP server uses it to spot a revoked OAuth sign-in. */
  onUnauthorized?: () => void;
}

export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'flightbyte', title: 'FlightByte', version: VERSION, websiteUrl: 'https://flightbyte.dev/docs/ai' },
    // The tool list never changes, so clients have nothing to listen for.
    { instructions: INSTRUCTIONS, capabilities: { tools: { listChanged: false } } },
  );
  const client = new ApiClient({
    baseUrl: options.apiUrl,
    apiKey: options.apiKey,
    onUnauthorized: options.onUnauthorized,
    fetch: options.fetch,
  });

  registerDocsTools(server, options.docs);

  for (const def of API_TOOLS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: inputSchema(def), annotations: def.annotations },
      async (args: Record<string, unknown>): Promise<CallToolResult> => runApiTool(def, client, args),
    );
  }
  return server;
}
