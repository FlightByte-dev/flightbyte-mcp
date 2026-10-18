#!/usr/bin/env node
// Refresh the vendored OpenAPI document that test/spec.test.ts checks every tool against.
// Usage: npm run sync:openapi [-- <url>]   (default https://flightbyte.dev/openapi.json)
import { writeFile } from 'node:fs/promises';

const url = process.argv[2] ?? 'https://flightbyte.dev/openapi.json';
const target = new URL('../spec/openapi.json', import.meta.url);

const res = await fetch(url, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.error(`GET ${url} answered ${res.status}`);
  process.exit(1);
}
const spec = await res.json();
if (typeof spec.openapi !== 'string' || typeof spec.paths !== 'object') {
  console.error(`${url} is not an OpenAPI document`);
  process.exit(1);
}
await writeFile(target, `${JSON.stringify(spec, null, 2)}\n`);
const operations = Object.values(spec.paths).flatMap((ops) => Object.values(ops)).filter((op) => op?.operationId);
console.error(`Wrote spec/openapi.json: ${operations.length} operations, version ${spec.info?.version}. Run npm test to check the tools against it.`);
