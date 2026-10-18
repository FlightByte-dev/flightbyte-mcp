#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, VERSION } from './config.js';
import { DocsStore } from './docs.js';
import { createServer } from './server.js';

// stdout carries the protocol; anything human-readable goes to stderr.
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.error(VERSION);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.error(`flightbyte-mcp ${VERSION}: the FlightByte MCP server over stdio.

Environment:
  FLIGHTBYTE_KEY        Your FlightByte API key (https://app.flightbyte.dev/signup). Docs tools work without it.
  FLIGHTBYTE_API_URL    API base URL (default https://api.flightbyte.dev/v1)
  FLIGHTBYTE_DOCS_URL   Docs site (default https://flightbyte.dev)

Docs: https://flightbyte.dev/docs/ai`);
  process.exit(0);
}

const config = loadConfig();
const apiKey = process.env.FLIGHTBYTE_KEY?.trim() || undefined;
const docs = new DocsStore({ docsUrl: config.docsUrl });

// The client's opening message picks the protocol era (2025 initialize or 2026-07-28); one server instance serves the connection.
const connection = serveStdio(() => createServer({ apiUrl: config.apiUrl, apiKey, docs }), {
  onerror: (err) => console.error(`stdio error: ${err.message}`),
});
console.error(`flightbyte-mcp ${VERSION} running on stdio (${apiKey ? 'API key set' : 'no FLIGHTBYTE_KEY: docs tools only'})`);

const shutdown = () => {
  void connection.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
