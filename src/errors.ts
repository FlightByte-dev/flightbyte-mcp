import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiResult } from './api.js';
import { KEYS_URL, PLAN_URL, REMOTE_URL, SIGNUP_URL } from './config.js';

/** The error envelope every FlightByte API failure carries (https://flightbyte.dev/docs/errors). */
export interface ErrorEnvelope {
  statusCode?: number;
  error?: string;
  message?: string | string[];
  code?: string;
  requestId?: string;
  path?: string;
  legs?: Leg[];
  window?: string;
  retryAfterSeconds?: number;
  limit?: number;
  used?: number;
  resetsAt?: string;
}

interface Leg {
  origin?: string;
  destination?: string;
  carrier?: string;
  scheduledDepartureLocal?: string;
  flightId?: string;
}

export interface ErrorContext {
  /** The MCP tool that made the call, so guidance can say "call X again with ...". */
  tool: string;
  /** What the call was about; decides what a 404 most likely means. */
  resource: 'flight' | 'subscription';
}

export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function missingKeyError(tool: string): CallToolResult {
  return toolError(
    [
      `No FlightByte API key is configured, so \`${tool}\` cannot call the API. Do not retry until a key is set.`,
      '',
      'Tell the user to add their key to this MCP server, then restart or reconnect it:',
      '- Local server (npx @flightbyte/mcp): set the FLIGHTBYTE_KEY environment variable in the MCP client config, e.g. `claude mcp add flightbyte --env FLIGHTBYTE_KEY=<key> -- npx -y @flightbyte/mcp`.',
      `- Remote server (${REMOTE_URL}): send the header \`Authorization: Bearer <key>\` (or \`x-api-key: <key>\`).`,
      `A free key comes from ${SIGNUP_URL}. The docs tools (search_docs, get_doc_page) work without a key.`,
    ].join('\n'),
  );
}

/** Turn a failed API call into an `isError` result that tells the model what to do next. */
export function apiErrorResult(result: Exclude<ApiResult, { kind: 'ok' }>, ctx: ErrorContext): CallToolResult {
  if (result.kind === 'network_error') {
    return toolError(
      `Could not reach the FlightByte API (${result.url}): ${result.message}. ` +
        'This is usually temporary: retry once after a few seconds, and tell the user if it keeps failing.',
    );
  }

  const env: ErrorEnvelope = isObject(result.body) ? (result.body as ErrorEnvelope) : {};
  const status = result.status;
  const message = Array.isArray(env.message) ? env.message.join('; ') : env.message;
  const lines: string[] = [];

  lines.push(`FlightByte API error ${status}${env.error ? ` ${env.error}` : ''}${env.code ? ` (code: ${env.code})` : ''}.`);
  if (message) lines.push(`Message: ${message}`);
  else if (!isObject(result.body) && result.text) lines.push(`Body: ${result.text.slice(0, 500)}`);
  lines.push('');
  lines.push(`What to do: ${guidance(status, env, result.headers, ctx)}`);

  const legs = Array.isArray(env.legs) ? env.legs : [];
  if (legs.length > 0) {
    lines.push('', 'Legs this flight number operates on that date:');
    for (const leg of legs) lines.push(`- ${describeLeg(leg)}`);
  }
  if (env.requestId) lines.push('', `requestId: ${env.requestId} (quote it if the user contacts FlightByte support)`);
  return toolError(lines.join('\n'));
}

function guidance(status: number, env: ErrorEnvelope, headers: Headers, ctx: ErrorContext): string {
  const { tool } = ctx;
  switch (status) {
    case 400:
      if (Array.isArray(env.legs) && env.legs.length > 0) {
        return (
          'This flight number operates more than one leg on that date, and FlightByte will not guess which one is meant. ' +
          'Use the departure airport the user mentioned, or ask them which leg, then call ' +
          `\`${tool}\` again with \`origin\` (add \`destination\` if two legs leave the same airport), or with \`flightId\` from the list below.`
        );
      }
      return 'The request failed validation. Fix the arguments named in the message and try again; repeating it unchanged gets the same answer.';
    case 401:
      return (
        'The API key is missing, invalid, revoked or expired. Do not retry. Ask the user to check the key configured for this MCP server ' +
        `(FLIGHTBYTE_KEY locally, or the Authorization header for ${REMOTE_URL}); keys are managed at ${KEYS_URL}, and a free one comes from ${SIGNUP_URL}.`
      );
    case 402: {
      if (env.code === 'watched_flight_limit') {
        const usage = env.used !== undefined && env.limit !== undefined ? ` (${env.used}/${env.limit} this month)` : '';
        const reset = env.resetsAt ? ` The allowance resets at ${env.resetsAt}.` : '';
        return (
          `The plan's monthly cap on watched flights is reached${usage}, so no new subscription can be created.${reset} ` +
          `The existing subscriptions keep running. Do not retry; tell the user they can wait for the reset or upgrade at ${PLAN_URL}.`
        );
      }
      return `The plan does not allow this request. Do not retry; tell the user to check their plan at ${PLAN_URL}.`;
    }
    case 403:
      return 'This key is not allowed to do that. Do not retry; tell the user.';
    case 404:
      if (ctx.resource === 'subscription') {
        return (
          'No subscription with this id exists for this API key (subscriptions belong to the key that created them). ' +
          'Call `list_subscriptions` to find the right id instead of guessing.'
        );
      }
      return (
        'No such flight, or no leg matching the selector. If you passed origin, destination or flightId, the message names the legs that exist: retry with one of them. ' +
        'Otherwise check carrier, flightNumber and date (the local departure date at the origin, YYYY-MM-DD). ' +
        'Live records cover a few days back to about two days ahead; a subscription can still be created up to seven days ahead and waits as `pending`.'
      );
    case 409:
      return (
        'A subscription for this flight and webhook URL already exists under the same Idempotency-Key. ' +
        'Call `list_subscriptions` (filter by carrier, flightNumber and date) to find it rather than creating another.'
      );
    case 429: {
      const wait = retryAfterSeconds(env, headers);
      const window = env.window ? `the ${env.window} quota window` : 'a quota window';
      return (
        `Rate limited: ${window} is full.${wait !== undefined ? ` Wait ${wait} seconds (Retry-After) before calling the API again.` : ' Wait before calling the API again.'} ` +
        'Do not retry in a loop; if the wait is long, tell the user. Refused requests do not count against the quota.'
      );
    }
    case 502:
    case 503:
    case 504:
      return 'A temporary failure on FlightByte\'s side or upstream. Safe to retry once after a few seconds; tell the user if it persists.';
    default:
      if (status >= 500) return 'An unexpected server error. Retry once after a few seconds; if it persists, tell the user and include the requestId.';
      return 'The API refused the request. Read the message, fix the arguments, and do not repeat the same call unchanged.';
  }
}

function retryAfterSeconds(env: ErrorEnvelope, headers: Headers): number | undefined {
  const header = headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  return typeof env.retryAfterSeconds === 'number' ? env.retryAfterSeconds : undefined;
}

function describeLeg(leg: Leg): string {
  const route = `${leg.origin ?? '?'} → ${leg.destination ?? '?'}`;
  const parts = [route];
  if (leg.carrier) parts.push(`operated by ${leg.carrier}`);
  if (leg.scheduledDepartureLocal) parts.push(`departs ${leg.scheduledDepartureLocal} local`);
  const pick = [leg.origin ? `origin "${leg.origin}"` : undefined, leg.flightId ? `flightId "${leg.flightId}"` : undefined]
    .filter(Boolean)
    .join(' or ');
  return pick ? `${parts.join(', ')}: pass ${pick}` : parts.join(', ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
