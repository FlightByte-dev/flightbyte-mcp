import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type { ApiClient, ApiRequest, HttpMethod } from '../api.js';
import { apiErrorResult, missingKeyError } from '../errors.js';

/** The 23 change types a subscription can filter on (CreateSubscriptionDto.events in the OpenAPI document). */
export const CHANGE_TYPES = [
  'status.changed',
  'flight.departed',
  'flight.arrived',
  'flight.cancelled',
  'flight.diverted',
  'flight.reinstated',
  'departure.gate.changed',
  'departure.terminal.changed',
  'arrival.gate.changed',
  'arrival.terminal.changed',
  'arrival.baggage.changed',
  'departure.scheduled.changed',
  'departure.estimated.changed',
  'departure.actual.changed',
  'arrival.scheduled.changed',
  'arrival.estimated.changed',
  'arrival.actual.changed',
  'delay.increased',
  'delay.decreased',
  'aircraft.changed',
  'aircraft.tail.changed',
  'route.changed',
  'codeshares.changed',
] as const;

export const SUBSCRIPTION_STATUSES = ['active', 'pending', 'paused', 'completed', 'suspended'] as const;

export type ParamLocation = 'path' | 'query' | 'header' | 'body';

export interface ParamDef {
  in: ParamLocation;
  schema: z.ZodType;
}

export interface ApiToolDef {
  name: string;
  /** The OpenAPI operationId this tool calls; the spec test checks every parameter against it. */
  operationId: string;
  method: HttpMethod;
  /** Path below the API base URL (which already ends in /v1), with {placeholders} for path parameters. */
  path: string;
  title: string;
  description: string;
  /** What a 404 from this endpoint is about. */
  resource: 'flight' | 'subscription';
  annotations: ToolAnnotations;
  /** Input parameters, keyed by their exact OpenAPI name. */
  params: Record<string, ParamDef>;
  /** Lines shown above the JSON of a successful response. */
  notes?: (data: unknown, args: Record<string, unknown>) => string[];
  /** Text for a successful response without a body (204). */
  emptyText?: (args: Record<string, unknown>) => string;
}

// ---------------------------------------------------------------------------
// Shared parameter schemas. Patterns mirror the API's own validation, case-insensitively
// (the API upper-cases codes before validating them).

const carrier = z
  .string()
  .regex(/^[A-Za-z0-9]{2,3}$/)
  .describe(
    'Airline code: the 2-character IATA code (e.g. "TK") or 3-character ICAO code (e.g. "THY"). For flight "TK1848" this is "TK".',
  );

const flightNumber = z
  .string()
  .regex(/^\d{1,4}[A-Za-z]?$/)
  .describe('Flight number without the airline code: 1 to 4 digits and an optional letter suffix. For "TK1848" this is "1848". Leading zeros are ignored.');

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe(
    'Local departure date at the origin airport, YYYY-MM-DD. A flight that leaves at 23:50 and lands the next morning belongs to the day it left. Live records cover a few days back to about two days ahead.',
  );

const origin = z
  .string()
  .regex(/^[A-Za-z0-9]{3,4}$/)
  .describe(
    'Departure airport, IATA code (e.g. "IST"; the upstream code such as "ISL" also works). Picks the leg when the flight number operates more than one leg that day.',
  );

const destination = z
  .string()
  .regex(/^[A-Za-z0-9]{3,4}$/)
  .describe('Arrival airport, IATA code (e.g. "JFK"). Narrows further when several legs leave the same airport.');

const flightId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .describe("Exact leg pick: a providerFlightId from a previous response's `alternates`, or a flightId from an error's list of legs.");

const refresh = z
  .boolean()
  .describe(
    "true skips FlightByte's cache and asks upstream now (counts as a normal request). Leave unset unless the user needs a guaranteed fresh answer.",
  );

const subscriptionId = z
  .string()
  .min(1)
  .max(64)
  .describe('Subscription id, e.g. "sub_7Kd91mQx0Zb2", as returned by create_subscription or list_subscriptions.');

const webhookUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .describe(
    "The user's public http(s) endpoint that receives a signed POST for every change. Addresses that resolve to private, loopback or link-local ranges are refused. Never invent one.",
  );

const events = z
  .array(z.enum(CHANGE_TYPES))
  .min(1)
  .describe(
    'Change types to deliver; omit to deliver all 23. Common picks: "flight.departed", "flight.arrived", "flight.cancelled", "flight.diverted", "departure.gate.changed", "arrival.baggage.changed", "delay.increased".',
  );

const delayThresholdMinutes = z
  .number()
  .int()
  .min(1)
  .max(240)
  .describe('Delay changes smaller than this many minutes are not delivered. 1 to 240; the default is 1.');

const deliveryHeaders = z
  .record(z.string(), z.string())
  .describe('Extra HTTP headers sent with every delivery, e.g. {"Authorization": "Bearer <receiver token>"}.');

const metadata = z
  .record(z.string(), z.string())
  .describe('String map echoed back in every webhook, e.g. {"bookingId": "BK-1042"}. Use it to tie deliveries to your own records.');

const flightSelectors = {
  origin: { in: 'query', schema: origin.optional() },
  destination: { in: 'query', schema: destination.optional() },
} satisfies Record<string, ParamDef>;

const flightKeyPath = {
  carrier: { in: 'path', schema: carrier },
  flightNumber: { in: 'path', schema: flightNumber },
  date: { in: 'path', schema: date },
} satisfies Record<string, ParamDef>;

const idPath = { id: { in: 'path', schema: subscriptionId } } satisfies Record<string, ParamDef>;

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const READ_ACCOUNT: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const SNAPSHOT_SUMMARY =
  "Returns FlightByte's flight snapshot: `status.phase` to branch on (scheduled, boarding, departed, en_route, landed, arrived, cancelled, diverted, redirected, unknown) " +
  'with `delayed`/`cancelled`/`diverted` flags; departure and arrival airports with terminal, gate and baggage carousel; scheduled, estimated and actual gate and runway times in UTC and local time ' +
  '(`bestTimeUtc` is the best single time, `delayMinutes` the gate delay); aircraft, codeshares, the airline timeline, `cached`, and `alternates`: every leg this flight number operates that day.';

// ---------------------------------------------------------------------------

export const API_TOOLS: ApiToolDef[] = [
  {
    name: 'get_flight',
    operationId: 'get-flight',
    method: 'GET',
    path: '/flights/{carrier}/{flightNumber}/{date}',
    title: 'Get a flight',
    resource: 'flight',
    description:
      'Look up the live status of one flight leg by airline code, flight number and local departure date, e.g. TK1848 on 2026-10-18 → carrier "TK", flightNumber "1848", date "2026-10-18". ' +
      `${SNAPSHOT_SUMMARY} ` +
      'Some numbers fly more than one leg a day (TK1 is SAW→AMS in the morning and IST→JFK later): without a selector the default leg is returned, so pass `origin` when the user named a departure airport. ' +
      'For updates over time, create a subscription instead of calling this repeatedly.',
    annotations: { ...READ, title: 'Get a flight' },
    params: {
      ...flightKeyPath,
      ...flightSelectors,
      flightId: { in: 'query', schema: flightId.optional() },
      refresh: { in: 'query', schema: refresh.optional() },
    },
    notes: legNotes,
  },
  {
    name: 'search_flights',
    operationId: 'search-flights',
    method: 'GET',
    path: '/flights/search',
    title: 'Search flights',
    resource: 'flight',
    description:
      'The same lookup as get_flight (same parameters, same snapshot), sent as query parameters to /v1/flights/search. Use either one, not both. ' +
      `${SNAPSHOT_SUMMARY} ` +
      'When the flight number operates several legs that day, pass `origin` (and optionally `destination`) to pick one; without a selector the default leg is returned and every leg is listed under `alternates`.',
    annotations: { ...READ, title: 'Search flights' },
    params: {
      carrier: { in: 'query', schema: carrier },
      flightNumber: { in: 'query', schema: flightNumber },
      date: { in: 'query', schema: date },
      ...flightSelectors,
      flightId: { in: 'query', schema: flightId.optional() },
      refresh: { in: 'query', schema: refresh.optional() },
    },
    notes: legNotes,
  },
  {
    name: 'get_flight_timeline',
    operationId: 'flight-timeline',
    method: 'GET',
    path: '/flights/{carrier}/{flightNumber}/{date}/timeline',
    title: 'Flight timeline',
    resource: 'flight',
    description:
      "The airline's own change history for one flight leg, newest first, as `{flightKey, count, data}`; each entry has `occurredAt`, `title`, `source` and `events` in the airline's words " +
      '(e.g. "Actual Gate Arrival changed to 13:35"). Use it for "what changed" or "why is it late" questions. get_flight already contains the same timeline, so call this only when the history alone is needed.',
    annotations: { ...READ, title: 'Flight timeline' },
    params: { ...flightKeyPath, ...flightSelectors },
  },
  {
    name: 'create_subscription',
    operationId: 'create-subscription',
    method: 'POST',
    path: '/subscriptions',
    title: 'Create a subscription',
    resource: 'flight',
    description:
      'Watch a flight: FlightByte polls it on an adaptive schedule and POSTs a signed webhook to `webhookUrl` for every change (status, gates, terminals, times, delays, departure, arrival, baggage carousel, cancellation, diversion, aircraft, route, codeshares) until the flight is over. ' +
      "Each new subscription counts as a watched flight on the user's plan (Free: 3 per month) and starts outbound requests to the URL, so only call this when the user asked to watch or be notified about a specific flight and gave the webhook URL. " +
      'If the flight number operates more than one leg that day the call is refused with the list of legs: pass `origin`. Flights up to seven days ahead are accepted and wait as `pending` until published. ' +
      'The response includes the signing secret in full; this is the only time it is shown, so relay it to the user to store for webhook signature verification. Pass `Idempotency-Key` to make a retry return the same subscription.',
    annotations: { title: 'Create a subscription', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    params: {
      carrier: { in: 'body', schema: carrier },
      flightNumber: { in: 'body', schema: flightNumber },
      date: { in: 'body', schema: date },
      origin: { in: 'body', schema: origin.optional() },
      destination: { in: 'body', schema: destination.optional() },
      flightId: { in: 'body', schema: flightId.optional() },
      webhookUrl: { in: 'body', schema: webhookUrl },
      events: { in: 'body', schema: events.optional() },
      delayThresholdMinutes: { in: 'body', schema: delayThresholdMinutes.optional() },
      headers: { in: 'body', schema: deliveryHeaders.optional() },
      metadata: { in: 'body', schema: metadata.optional() },
      secret: {
        in: 'body',
        schema: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Bring your own signing secret, only when the user explicitly provides one their receiver already uses. Normally omit it: FlightByte generates one and returns it once.",
          ),
      },
      'Idempotency-Key': {
        in: 'header',
        schema: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Any unique string (e.g. a UUID). Replaying the same key within 24 hours returns the original subscription instead of creating a second one.'),
      },
    },
    notes: (data) => {
      const sub = asRecord(data);
      const lines = [
        'Subscription created.',
        'IMPORTANT: `secret` below is the webhook signing secret, shown in full only in this response; later reads show only `secretHint`. ' +
          'Give it to the user now so they can store it on their webhook receiver (the docs call it FLIGHTBYTE_WEBHOOK_SECRET) and verify the HMAC-SHA256 signature on every delivery. ' +
          'This MCP server cannot reveal or rotate it later; that is done in the FlightByte dashboard or the API.',
      ];
      if (sub?.status === 'pending') {
        lines.push(
          'Status is `pending`: the flight is not published upstream yet. It activates by itself and the receiver gets `subscription.activated` when it does.',
        );
      }
      lines.push('Tip: send_test_event sends a signed test webhook to check the receiver now.');
      return lines;
    },
  },
  {
    name: 'list_subscriptions',
    operationId: 'list-subscriptions',
    method: 'GET',
    path: '/subscriptions',
    title: 'List subscriptions',
    resource: 'subscription',
    description:
      'List the subscriptions owned by this API key, newest first, as `{total, data}`. All filters are optional; page with `limit` and `offset`. ' +
      'Secrets are masked (`secretHint`). Use it to find a subscription id before get, update, pause, resume, delete or log calls.',
    annotations: { ...READ_ACCOUNT, title: 'List subscriptions' },
    params: {
      status: {
        in: 'query',
        schema: z
          .enum(SUBSCRIPTION_STATUSES)
          .optional()
          .describe(
            'Only subscriptions in this state: active (being polled), pending (flight not published yet), paused, completed (flight over) or suspended (20 failed deliveries in a row).',
          ),
      },
      carrier: { in: 'query', schema: carrier.optional() },
      flightNumber: { in: 'query', schema: flightNumber.optional() },
      date: { in: 'query', schema: date.optional() },
      offset: { in: 'query', schema: z.number().int().min(0).optional().describe('How many to skip, for paging. Default 0.') },
      limit: { in: 'query', schema: z.number().int().min(1).max(200).optional().describe('Page size, 1 to 200. Default 25.') },
    },
  },
  {
    name: 'get_subscription',
    operationId: 'get-subscription',
    method: 'GET',
    path: '/subscriptions/{id}',
    title: 'Get a subscription',
    resource: 'subscription',
    description:
      'Fetch one subscription: `status` (active, pending, paused, completed, suspended) and `statusReason`, `flightKey`, `flightResolved`, webhook URL, event filter, delay threshold, ' +
      '`deliveredCount`/`failedCount`, and the last poll, change and delivery times. The secret is masked.',
    annotations: { ...READ_ACCOUNT, title: 'Get a subscription' },
    params: { ...idPath },
  },
  {
    name: 'update_subscription',
    operationId: 'update-subscription',
    method: 'PATCH',
    path: '/subscriptions/{id}',
    title: 'Update a subscription',
    resource: 'subscription',
    description:
      "Change a subscription's `webhookUrl`, `events` filter, `delayThresholdMinutes`, `headers` or `metadata`. Send only the fields to change; `headers` and `metadata` replace the stored maps. " +
      'The flight cannot be changed: create a new subscription for a different flight.',
    annotations: { title: 'Update a subscription', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: {
      ...idPath,
      webhookUrl: { in: 'body', schema: webhookUrl.optional() },
      events: { in: 'body', schema: events.optional() },
      delayThresholdMinutes: { in: 'body', schema: delayThresholdMinutes.optional() },
      headers: { in: 'body', schema: deliveryHeaders.optional() },
      metadata: { in: 'body', schema: metadata.optional() },
    },
  },
  {
    name: 'pause_subscription',
    operationId: 'pause-subscription',
    method: 'POST',
    path: '/subscriptions/{id}/pause',
    title: 'Pause a subscription',
    resource: 'subscription',
    description:
      'Stop polling and webhook deliveries for a subscription without deleting it. Nothing is lost; resume_subscription continues it. Returns the updated subscription.',
    annotations: { title: 'Pause a subscription', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { ...idPath },
  },
  {
    name: 'resume_subscription',
    operationId: 'resume-subscription',
    method: 'POST',
    path: '/subscriptions/{id}/resume',
    title: 'Resume a subscription',
    resource: 'subscription',
    description:
      'Resume a paused subscription, or one that was suspended after 20 consecutive failed deliveries (fix the receiver first; send_test_event checks it). ' +
      'A completed subscription cannot be resumed: create a new one. Returns the updated subscription.',
    annotations: { title: 'Resume a subscription', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    params: { ...idPath },
  },
  {
    name: 'delete_subscription',
    operationId: 'delete-subscription',
    method: 'DELETE',
    path: '/subscriptions/{id}',
    title: 'Delete a subscription',
    resource: 'subscription',
    description:
      'Permanently delete a subscription: its polling and webhook deliveries stop and it cannot be restored. Confirm with the user first, and prefer pause_subscription if they may want it back. ' +
      "Events and deliveries already recorded stay on FlightByte's side for 30 days.",
    annotations: { title: 'Delete a subscription', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    params: { ...idPath },
    emptyText: (args) =>
      `Subscription ${String(args.id)} deleted. Its polling and deliveries have stopped; recorded events and deliveries stay readable for 30 days.`,
  },
  {
    name: 'send_test_event',
    operationId: 'send-test-event',
    method: 'POST',
    path: '/subscriptions/{id}/test',
    title: 'Send a test event',
    resource: 'subscription',
    description:
      "Send a signed `subscription.test` webhook through the real delivery pipeline to the subscription's webhookUrl, signed with its real secret, and return the `eventId`. " +
      'Use it to prove a receiver and its signature check work before the first real change, then call list_deliveries to see how the delivery went.',
    annotations: { title: 'Send a test event', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    params: { ...idPath },
  },
  {
    name: 'list_deliveries',
    operationId: 'list-deliveries',
    method: 'GET',
    path: '/subscriptions/{id}/deliveries',
    title: 'List deliveries',
    resource: 'subscription',
    description:
      'Recent webhook delivery attempts for a subscription, newest first: `eventId`, `attempt`, `status`, `httpStatus`, `error`, `durationMs`, `at` and `changeTypes`. ' +
      'Use it to debug a receiver that is not getting webhooks or is answering with errors. Records are kept for 30 days.',
    annotations: { ...READ_ACCOUNT, title: 'List deliveries' },
    params: {
      ...idPath,
      limit: { in: 'query', schema: z.number().int().min(1).max(100).optional().describe('How many attempts, 1 to 100. Default 25.') },
    },
  },
  {
    name: 'list_events',
    operationId: 'list-events',
    method: 'GET',
    path: '/subscriptions/{id}/events',
    title: 'List sent events',
    resource: 'subscription',
    description:
      'Recent events generated for a subscription, newest first, with the exact webhook payloads that were sent (the list of changes and the flight snapshot at the time). ' +
      'Use it to see what changed and when, or to replay a payload into a local receiver.',
    annotations: { ...READ_ACCOUNT, title: 'List sent events' },
    params: {
      ...idPath,
      limit: { in: 'query', schema: z.number().int().min(1).max(100).optional().describe('How many events, 1 to 100. Default 25.') },
    },
  },
];

/** Codes the API upper-cases anyway; sending them normalised keeps cache keys and logs tidy. */
const UPPERCASE = new Set(['carrier', 'flightNumber', 'origin', 'destination']);

export function buildRequest(def: ApiToolDef, args: Record<string, unknown>): ApiRequest {
  let path = def.path;
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = {};

  for (const [name, param] of Object.entries(def.params)) {
    let value = args[name];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      value = value.trim();
      if (UPPERCASE.has(name)) value = (value as string).toUpperCase();
    }
    switch (param.in) {
      case 'path':
        path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
        break;
      case 'query':
        query[name] = String(value);
        break;
      case 'header':
        headers[name] = String(value);
        break;
      case 'body':
        body[name] = value;
        break;
    }
  }

  const request: ApiRequest = { method: def.method, path, query, headers };
  if (Object.values(def.params).some((p) => p.in === 'body')) request.body = body;
  return request;
}

export function inputSchema(def: ApiToolDef) {
  return z.object(Object.fromEntries(Object.entries(def.params).map(([name, p]) => [name, p.schema])));
}

export async function runApiTool(def: ApiToolDef, client: ApiClient, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!client.hasKey) return missingKeyError(def.name);

  if (def.name === 'update_subscription') {
    const fields = Object.entries(def.params).filter(([name, p]) => p.in === 'body' && args[name] !== undefined);
    if (fields.length === 0) {
      return {
        isError: true,
        content: [
          { type: 'text', text: 'Nothing to update: pass at least one of webhookUrl, events, delayThresholdMinutes, headers or metadata.' },
        ],
      };
    }
  }

  const result = await client.request(buildRequest(def, args));
  if (result.kind !== 'ok') return apiErrorResult(result, { tool: def.name, resource: def.resource });

  if (result.data === undefined) {
    const text = def.emptyText?.(args) ?? `Done (HTTP ${result.status}, no response body).`;
    return { content: [{ type: 'text', text }] };
  }

  const content: CallToolResult['content'] = [];
  const notes = def.notes?.(result.data, args) ?? [];
  if (notes.length > 0) content.push({ type: 'text', text: notes.join('\n') });
  content.push({ type: 'text', text: JSON.stringify(result.data) });

  const out: CallToolResult = { content };
  const record = asRecord(result.data);
  if (record) out.structuredContent = record;
  return out;
}

function legNotes(data: unknown, args: Record<string, unknown>): string[] {
  const snapshot = asRecord(data);
  const alternates = Array.isArray(snapshot?.alternates) ? (snapshot.alternates as Record<string, unknown>[]) : [];
  if (alternates.length < 2) return [];
  const legs = alternates
    .map((leg) => `${String(leg.departureIata)}→${String(leg.arrivalIata)}${leg.selected ? ' (this snapshot)' : ''}`)
    .join(', ');
  const selected = args.origin || args.destination || args.flightId;
  return [
    `This flight number operates ${alternates.length} legs on ${String(snapshot?.date ?? args.date)}: ${legs}. ` +
      (selected
        ? 'The snapshot below is the leg matching the selector.'
        : 'No selector was given, so this is the default leg; if the user meant another one, call again with `origin`.'),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
