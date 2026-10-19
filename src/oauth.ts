import { createHash } from 'node:crypto';
import { USER_AGENT } from './config.js';

/**
 * OAuth for the hosted server, so Claude's custom connectors (which take OAuth
 * or nothing) can sign people in. This server is the protected resource: it
 * publishes where its authorization server is (RFC 9728), answers 401 with a
 * WWW-Authenticate challenge when a tool needs an account, and checks the
 * token it is given. The authorization server is the FlightByte API.
 *
 * The MCP spec forbids passing a client's token through to an upstream API,
 * so a token (audience: this server) is traded at the authorization server
 * for one whose audience is the API (RFC 8693), with this server's own client
 * secret. The trade also validates it: a revoked or expired token fails.
 *
 * API keys keep working exactly as before, and without credentials the docs
 * tools and tools/list still answer (lazy authentication).
 */

export type OAuthScope = 'flights:read' | 'subscriptions:read' | 'subscriptions:write';

export const OAUTH_SCOPES: readonly OAuthScope[] = ['flights:read', 'subscriptions:read', 'subscriptions:write'];

/** A token for this server starts with this; FlightByte API keys start with `frk_`. */
export const ACCESS_TOKEN_PREFIX = 'fbo_at_';

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';

export interface OAuthOptions {
  /** This server's MCP endpoint exactly as people add it, e.g. https://mcp.flightbyte.dev/mcp. */
  resource: string;
  /** The authorization server's issuer, e.g. https://api.flightbyte.dev. */
  issuer: string;
  /** This server's client at the authorization server, used only to trade tokens. */
  clientId: string;
  clientSecret: string;
  /** Defaults to `<issuer>/oauth/token`. */
  tokenEndpoint?: string;
  /** The audience of the traded token: the API. Defaults to the issuer. */
  apiAudience?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export const isAccessToken = (credential: string): boolean => credential.startsWith(ACCESS_TOKEN_PREFIX);

export const scopeSatisfies = (held: readonly string[], needed: string): boolean =>
  held.includes(needed) || (needed === 'subscriptions:read' && held.includes('subscriptions:write'));

/** Where the protected resource metadata for `resource` lives: RFC 9728's path-suffixed well-known URL. */
export function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** The paths this server answers protected resource metadata on: path-suffixed first, then the root. */
export function resourceMetadataPaths(resource: string): string[] {
  const suffixed = new URL(resourceMetadataUrl(resource)).pathname;
  return [...new Set([suffixed, '/.well-known/oauth-protected-resource'])];
}

export function protectedResourceMetadata(options: OAuthOptions): Record<string, unknown> {
  return {
    resource: options.resource,
    authorization_servers: [options.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'FlightByte',
    resource_documentation: 'https://flightbyte.dev/docs/ai',
  };
}

const quote = (value: string): string => `"${value.replace(/["\\]/g, '')}"`;

/** A `WWW-Authenticate: Bearer` challenge pointing at the metadata, as Claude needs it to start signing in. */
export function bearerChallenge(
  options: OAuthOptions,
  params: { error?: string; description?: string; scope?: readonly string[] } = {},
): string {
  const parts: string[] = [];
  if (params.error) parts.push(`error=${quote(params.error)}`);
  if (params.description) parts.push(`error_description=${quote(params.description)}`);
  parts.push(`resource_metadata=${quote(resourceMetadataUrl(options.resource))}`);
  if (params.scope && params.scope.length > 0) parts.push(`scope=${quote(params.scope.join(' '))}`);
  return `Bearer ${parts.join(', ')}`;
}

export type TradeResult =
  | { kind: 'ok'; token: string; scopes: string[] }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: string };

interface CachedTrade {
  token: string;
  scopes: string[];
  expiresAt: number;
}

/** Traded tokens are dropped this long before they expire, so one never runs out mid-call. */
const EXPIRY_MARGIN_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;

/**
 * Trades a client's access token for an API token and remembers the answer
 * for as long as it is valid, so a conversation costs one trade per hour, not
 * one per request. Keyed by the token's SHA-256; tokens themselves are never
 * kept as keys or logged.
 */
export class TokenExchanger {
  readonly #options: OAuthOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedTrade>();
  readonly #inflight = new Map<string, Promise<TradeResult>>();

  constructor(options: OAuthOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#cache.size;
  }

  async trade(subject: string): Promise<TradeResult> {
    const id = createHash('sha256').update(subject).digest('hex');
    const cached = this.#cache.get(id);
    if (cached && cached.expiresAt > this.#now()) return { kind: 'ok', token: cached.token, scopes: cached.scopes };
    if (cached) this.#cache.delete(id);

    // Concurrent requests of one conversation share a single trade.
    let pending = this.#inflight.get(id);
    if (!pending) {
      pending = this.#request(id, subject).finally(() => this.#inflight.delete(id));
      this.#inflight.set(id, pending);
    }
    return pending;
  }

  /** Forget a trade the API no longer accepts (revoked meanwhile), so the next request asks again. */
  forget(subject: string): void {
    this.#cache.delete(createHash('sha256').update(subject).digest('hex'));
  }

  sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#cache) if (entry.expiresAt <= now) this.#cache.delete(id);
  }

  async #request(id: string, subject: string): Promise<TradeResult> {
    const { issuer, clientId, clientSecret } = this.#options;
    const endpoint = this.#options.tokenEndpoint ?? `${issuer.replace(/\/+$/, '')}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subject,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource: this.#options.apiAudience ?? issuer,
    });
    const credentials = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');

    let res: Response;
    try {
      res = await this.#fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 400 && (json.error === 'invalid_grant' || json.error === 'invalid_target')) {
      return { kind: 'invalid', reason: String(json.error_description ?? json.error) };
    }
    if (!res.ok || typeof json.access_token !== 'string') {
      // invalid_client here means this server is misconfigured, not that the user's token is bad.
      return { kind: 'unavailable', reason: `token exchange answered HTTP ${res.status}${json.error ? ` (${String(json.error)})` : ''}` };
    }

    const seconds = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 300;
    const scopes = typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [];
    const entry: CachedTrade = { token: json.access_token, scopes, expiresAt: this.#now() + seconds * 1000 - EXPIRY_MARGIN_MS };
    if (this.#cache.size >= MAX_CACHE_ENTRIES) this.sweep();
    if (this.#cache.size >= MAX_CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(id, entry);
    return { kind: 'ok', token: entry.token, scopes };
  }
}

/** The tools/call messages in a JSON-RPC body (a single message or a batch). */
export function calledTools(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const message of messages) {
    const msg = message as { method?: unknown; params?: { name?: unknown } } | null;
    if (msg && typeof msg === 'object' && msg.method === 'tools/call' && typeof msg.params?.name === 'string') {
      names.push(msg.params.name);
    }
  }
  return names;
}

/** Reads the OAuth settings from the environment; null (OAuth off) unless the client secret is set. */
export function loadOAuthOptions(env: NodeJS.ProcessEnv = process.env): OAuthOptions | null {
  const clientSecret = env.FLIGHTBYTE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientSecret) return null;
  const publicUrl = (env.MCP_PUBLIC_URL?.trim() || 'https://mcp.flightbyte.dev').replace(/\/+$/, '');
  const issuer = (env.FLIGHTBYTE_OAUTH_ISSUER?.trim() || 'https://api.flightbyte.dev').replace(/\/+$/, '');
  return {
    resource: `${publicUrl}/mcp`,
    issuer,
    clientId: env.FLIGHTBYTE_OAUTH_CLIENT_ID?.trim() || 'flightbyte-mcp',
    clientSecret,
    tokenEndpoint: env.FLIGHTBYTE_OAUTH_TOKEN_URL?.trim() || undefined,
    apiAudience: env.FLIGHTBYTE_OAUTH_API_AUDIENCE?.trim() || undefined,
  };
}
