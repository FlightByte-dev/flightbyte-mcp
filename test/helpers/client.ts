import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { DocsStore } from '../../src/docs.js';
import { createServer } from '../../src/server.js';
import type { MockFlightByte } from './mock.js';

export const TEST_KEY = 'fb_test_mock_key_0001';

export interface Connected {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

/** An MCP client wired in memory to a fresh server that talks to the mock. */
export async function connect(mock: MockFlightByte, options: { apiKey?: string | null; docs?: DocsStore } = {}): Promise<Connected> {
  const apiKey = options.apiKey === null ? undefined : (options.apiKey ?? TEST_KEY);
  const docs = options.docs ?? new DocsStore({ docsUrl: mock.url });
  const server = createServer({ apiUrl: mock.apiUrl, apiKey, docs });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** All text blocks of a result, joined. */
export function text(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
