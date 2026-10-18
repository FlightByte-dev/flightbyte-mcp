/** server.json (MCP Registry) and package.json must agree, or registry publishing fails npm ownership verification. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

describe('package metadata', () => {
  it('server.json names this npm package and version', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } });
    expect(server.packages[0].environmentVariables.map((v: { name: string }) => v.name)).toEqual(['FLIGHTBYTE_KEY']);
    expect(server.remotes[0]).toMatchObject({ type: 'streamable-http', url: 'https://mcp.flightbyte.dev/mcp' });
  });

  it('fits the registry limits', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  });

  it('has one bin, so `npx -y @flightbyte/mcp` runs the stdio server', () => {
    expect(Object.values(pkg.bin)).toEqual(['dist/stdio.js']);
    expect(readFileSync(new URL('../src/stdio.ts', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(pkg.files).toContain('dist');
  });
});
