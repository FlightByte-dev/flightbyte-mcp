/**
 * Drift check: every API tool must line up with the vendored OpenAPI document (spec/openapi.json).
 * Refresh the copy with `npm run sync:openapi`; if the API renamed or moved anything, these tests fail.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_TOOLS, CHANGE_TYPES, SUBSCRIPTION_STATUSES, type ApiToolDef } from '../src/tools/api-tools.js';

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: { enum?: string[] };
}
interface Schema {
  $ref?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: string[];
}
interface Operation {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
}

const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8')) as {
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

/** Operations deliberately left out of v1, and why. Anything else in the spec needs a tool. */
const NOT_EXPOSED: Record<string, string> = {
  'reveal-secret': 'would put a webhook signing secret into the model context',
  'rotate-secret': 'would put a webhook signing secret into the model context',
  'list-countries': 'reference data, not needed for flight status or webhooks in v1',
  'get-country': 'reference data, not needed for flight status or webhooks in v1',
  'get-flag': 'returns an SVG image, not useful to a model',
};

const operations = new Map<string, { method: string; path: string; op: Operation }>();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (op && typeof op === 'object' && 'operationId' in op) operations.set(op.operationId, { method: method.toUpperCase(), path, op });
  }
}

function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const target = spec.components.schemas[name];
  if (!target) throw new Error(`Unresolvable $ref ${schema.$ref}`);
  return resolve(target);
}

function bodySchema(op: Operation): Schema | undefined {
  const json = op.requestBody?.content['application/json'];
  return json ? resolve(json.schema) : undefined;
}

function paramsIn(def: ApiToolDef, location: string): string[] {
  return Object.entries(def.params)
    .filter(([, p]) => p.in === location)
    .map(([name]) => name);
}

describe('API tools match the OpenAPI document', () => {
  it('the vendored spec serves /v1 paths from api.flightbyte.dev', () => {
    expect(spec.servers?.[0]?.url).toBe('https://api.flightbyte.dev');
    expect(Object.keys(spec.paths).every((p) => p.startsWith('/v1/'))).toBe(true);
  });

  it('every operation in the spec is either a tool or deliberately left out', () => {
    const covered = new Set(API_TOOLS.map((t) => t.operationId));
    const missing = [...operations.keys()].filter((id) => !covered.has(id) && !(id in NOT_EXPOSED));
    expect(missing, `New API operations without a tool: add one to src/tools/api-tools.ts or to NOT_EXPOSED here`).toEqual([]);
    const stale = Object.keys(NOT_EXPOSED).filter((id) => !operations.has(id));
    expect(stale, 'NOT_EXPOSED lists operations the spec no longer has').toEqual([]);
  });

  it('tool names and operationIds are unique', () => {
    expect(new Set(API_TOOLS.map((t) => t.name)).size).toBe(API_TOOLS.length);
    expect(new Set(API_TOOLS.map((t) => t.operationId)).size).toBe(API_TOOLS.length);
  });

  describe.each(API_TOOLS.map((def) => [def.name, def] as const))('%s', (_name, def) => {
    const entry = operations.get(def.operationId);

    it(`calls ${def.operationId} with the same method and path`, () => {
      expect(entry, `operationId ${def.operationId} is not in spec/openapi.json`).toBeDefined();
      expect(def.method).toBe(entry!.method);
      expect(`/v1${def.path}`).toBe(entry!.path);
    });

    it('uses parameter names that exist in the spec, in the same place', () => {
      const params = entry!.op.parameters ?? [];
      for (const location of ['path', 'query', 'header'] as const) {
        const specNames = params.filter((p) => p.in === location).map((p) => p.name);
        for (const name of paramsIn(def, location)) {
          expect(specNames, `${def.name}.${name} is not a ${location} parameter of ${def.operationId}`).toContain(name);
        }
      }
      const bodyNames = paramsIn(def, 'body');
      if (bodyNames.length > 0) {
        const schema = bodySchema(entry!.op);
        expect(schema, `${def.operationId} has no JSON request body`).toBeDefined();
        for (const name of bodyNames) {
          expect(Object.keys(schema!.properties ?? {}), `${def.name}.${name} is not a body field of ${def.operationId}`).toContain(name);
        }
      }
    });

    it('exposes every required spec parameter and body field, as required', () => {
      const required = (entry!.op.parameters ?? []).filter((p) => p.required && p.in !== 'cookie').map((p) => p.name);
      const body = bodySchema(entry!.op);
      if (body && entry!.op.requestBody?.required) required.push(...(body.required ?? []));
      for (const name of required) {
        const param = def.params[name];
        expect(param, `${def.name} lacks required ${name}`).toBeDefined();
        expect(param!.schema.safeParse(undefined).success, `${def.name}.${name} should be required`).toBe(false);
      }
    });
  });

  it('the events enum matches the spec, for create and update', () => {
    for (const dto of ['CreateSubscriptionDto', 'UpdateSubscriptionDto']) {
      const events = spec.components.schemas[dto]?.properties?.events;
      expect(events?.items?.enum, dto).toEqual([...CHANGE_TYPES]);
    }
  });

  it('the subscription status enum matches the spec', () => {
    const status = operations.get('list-subscriptions')!.op.parameters!.find((p) => p.name === 'status');
    expect(status?.schema?.enum).toEqual([...SUBSCRIPTION_STATUSES]);
    expect(spec.components.schemas.Subscription?.properties?.status?.enum).toEqual([...SUBSCRIPTION_STATUSES]);
  });
});
