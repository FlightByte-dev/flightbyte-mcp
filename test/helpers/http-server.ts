/** Spawns the built HTTP entry point (dist/http.js) on a free loopback port. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MockFlightByte } from './mock.js';

const entry = fileURLToPath(new URL('../../dist/http.js', import.meta.url));

export interface SpawnedServer {
  child: ChildProcess;
  /** http://127.0.0.1:<port>, without /mcp. */
  base: string;
  logs: () => string;
}

export async function startServer(mock: MockFlightByte, env: Record<string, string> = {}): Promise<SpawnedServer> {
  if (!existsSync(entry)) throw new Error('dist/http.js is missing: run `npm run build` first (npm test does).');
  const proc = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '', PORT: '0', HOST: '127.0.0.1', FLIGHTBYTE_API_URL: mock.apiUrl, FLIGHTBYTE_DOCS_URL: mock.url, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/listening on (http:\/\/\S+)\/mcp/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
  });
  return { child: proc, base: url, logs: () => output };
}

export function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}
