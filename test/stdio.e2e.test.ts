/** Spawns the built stdio entry point (dist/stdio.js) the way an MCP client would, against the mock API. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { text } from './helpers/client.js';
import { flightSnapshot, MockFlightByte } from './helpers/mock.js';

const entry = fileURLToPath(new URL('../dist/stdio.js', import.meta.url));
const KEY = 'fb_test_stdio_key_0002';
const mock = new MockFlightByte();

async function spawnClient(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH ?? '', FLIGHTBYTE_API_URL: mock.apiUrl, FLIGHTBYTE_DOCS_URL: mock.url, ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'stdio-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

beforeAll(async () => {
  if (!existsSync(entry)) throw new Error('dist/stdio.js is missing: run `npm run build` first (npm test does).');
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
});

describe('stdio transport', () => {
  it('initializes, lists the tools and calls an API tool with FLIGHTBYTE_KEY', async () => {
    const { client, stderr } = await spawnClient({ FLIGHTBYTE_KEY: KEY });
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'flightbyte' });
      expect(client.getInstructions()).toContain('search_docs');

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(15);

      mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
      const result = (await client.callTool({
        name: 'get_flight',
        arguments: { carrier: 'TK', flightNumber: '1848', date: '2026-10-18' },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ flightKey: 'TK1848:2026-10-18@IST-ATH' });
      expect(mock.last!.headers['x-api-key']).toBe(KEY);

      const docs = (await client.callTool({ name: 'search_docs', arguments: { query: 'retry after' } })) as CallToolResult;
      expect(text(docs)).toContain('When a window is full');

      expect(stderr()).toContain('running on stdio (API key set)');
      expect(stderr()).not.toContain(KEY);
    } finally {
      await client.close();
    }
  });

  it('without FLIGHTBYTE_KEY, API tools return a configuration error instead of crashing', async () => {
    const { client, stderr } = await spawnClient({});
    try {
      const result = (await client.callTool({
        name: 'list_subscriptions',
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('FLIGHTBYTE_KEY');
      expect(stderr()).toContain('no FLIGHTBYTE_KEY');
      // Still alive and answering.
      expect((await client.listTools()).tools).toHaveLength(15);
    } finally {
      await client.close();
    }
  });
});
