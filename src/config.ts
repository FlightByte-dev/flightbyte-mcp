import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;
export const USER_AGENT = `flightbyte-mcp/${VERSION}`;

export const DEFAULT_API_URL = 'https://api.flightbyte.dev/v1';
export const DEFAULT_DOCS_URL = 'https://flightbyte.dev';

/** Where to get a key, and how to hand one to this server. Shown whenever a key is missing or rejected. */
export const SIGNUP_URL = 'https://app.flightbyte.dev/signup';
export const KEYS_URL = 'https://app.flightbyte.dev/keys';
export const PLAN_URL = 'https://app.flightbyte.dev/plan';
export const REMOTE_URL = 'https://mcp.flightbyte.dev/mcp';

export interface Config {
  /** API base URL including the version prefix, without a trailing slash. */
  apiUrl: string;
  /** Docs site origin (serves /llms-full.txt and <page>.md), without a trailing slash. */
  docsUrl: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiUrl: trimSlash(env.FLIGHTBYTE_API_URL?.trim() || DEFAULT_API_URL),
    docsUrl: trimSlash(env.FLIGHTBYTE_DOCS_URL?.trim() || DEFAULT_DOCS_URL),
  };
}
