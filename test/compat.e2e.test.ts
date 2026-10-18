/**
 * Clients built on the v1 SDK (@modelcontextprotocol/sdk 1.x, protocol 2025-11-25) are most of the MCP clients in use today.
 * The v1 package is a dev dependency only so these tests can prove they still connect to the v2 server over both transports.
 */
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, stopServer } from './helpers/http-server.js';
import { flightSnapshot, MockFlightByte } from './helpers/mock.js';

const KEY = 'fb_test_compat_key_0005';
const mock = new MockFlightByte();
let http: { child: ChildProcess; base: string };

beforeAll(async () => {
  await mock.start();
  http = await startServer(mock);
});
afterAll(async () => {
  await stopServer(http.child);
  await mock.stop();
});

async function exercise(client: Client) {
  expect(client.getServerVersion()).toMatchObject({ name: 'flightbyte' });
  expect(client.getInstructions()).toContain('search_docs');
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(15);
  expect(tools.find((t) => t.name === 'get_flight')!.inputSchema.required).toEqual(['carrier', 'flightNumber', 'date']);

  mock.on('GET', '/v1/flights/TK/1848/2026-10-18', { status: 200, body: flightSnapshot() });
  const result = await client.callTool({ name: 'get_flight', arguments: { carrier: 'TK', flightNumber: '1848', date: '2026-10-18' } });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ flightKey: 'TK1848:2026-10-18@IST-ATH' });
  expect(mock.last!.headers['x-api-key']).toBe(KEY);

  // Bad arguments are still a tool error the model can read, not a protocol failure.
  const bad = await client.callTool({ name: 'get_flight', arguments: { carrier: 'TK', flightNumber: 'abc', date: '2026-10-18' } });
  expect(bad.isError).toBe(true);
}

describe('a v1 SDK client (protocol 2025-11-25)', () => {
  it('connects over stdio', async () => {
    const client = new Client({ name: 'v1-stdio', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url))],
        env: { PATH: process.env.PATH ?? '', FLIGHTBYTE_API_URL: mock.apiUrl, FLIGHTBYTE_DOCS_URL: mock.url, FLIGHTBYTE_KEY: KEY },
        stderr: 'ignore',
      }),
    );
    try {
      await exercise(client);
    } finally {
      await client.close();
    }
  });

  it('connects over Streamable HTTP and negotiates 2025-11-25', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${http.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${KEY}` } },
    });
    const client = new Client({ name: 'v1-http', version: '0' });
    await client.connect(transport);
    try {
      expect(transport.protocolVersion).toBe('2025-11-25');
      await exercise(client);
    } finally {
      await client.close();
    }
  });
});
