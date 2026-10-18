import { USER_AGENT } from './config.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequest {
  method: HttpMethod;
  /** Path below the API base URL, with path parameters already substituted and encoded. */
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

export type ApiResult =
  | { kind: 'ok'; status: number; data: unknown; headers: Headers }
  | { kind: 'http_error'; status: number; body: unknown; text: string; headers: Headers }
  | { kind: 'network_error'; url: string; message: string };

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A thin client over the public FlightByte REST API. It never throws for HTTP or network failures. */
export class ApiClient {
  readonly baseUrl: string;
  readonly hasKey: boolean;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.hasKey = this.#apiKey !== undefined;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? fetch;
  }

  url(path: string, query?: ApiRequest['query']): string {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return url.toString();
  }

  async request(req: ApiRequest): Promise<ApiResult> {
    const url = this.url(req.path, req.query);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    if (this.#apiKey) headers['x-api-key'] = this.#apiKey;
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (value !== undefined) headers[name] = value;
    }
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const message =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? `no response within ${Math.round(this.#timeoutMs / 1000)}s`
          : describeFetchError(err);
      return { kind: 'network_error', url, message };
    }

    const text = await res.text().catch(() => '');
    const data = parseJson(text);
    if (res.ok) return { kind: 'ok', status: res.status, data, headers: res.headers };
    return { kind: 'http_error', status: res.status, body: data, text, headers: res.headers };
  }
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
  return err.message;
}
