// fe-api-openapi-emit — the emitter's determinism + drift + guard-parity suite.
//
// This file IS the emitter's committed-artifact anchor. It (1) proves the
// OpenAPI + JSON-Schema serialization is deterministic (re-emit byte-identical),
// (2) fails on DRIFT — the committed `openapi.json` / `api-jsonschema.json` must
// equal a fresh emit, so a stale or hand-edited contract fails here, and (3)
// proves the emitted JSON-Schema does not FORK from the api-schema.ts guards:
// every real response fixture validates against BOTH the emitted schema AND the
// guard (`assertItotoriApiResponse`), and a dropped/extra top-level key fails
// the schema.
//
// Regenerate the committed artifacts with:
//   UPDATE_OPENAPI_CONTRACT=1 pnpm --filter @itotori/app exec vitest run test/openapi-contract.test.ts
// (or `pnpm --filter @itotori/app run emit:openapi`).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ITOTORI_API_ROUTES,
  ITOTORI_API_ROUTE_IDS,
  buildItotoriJsonSchemaBundle,
  jsonSchemaForApiError,
  jsonSchemaForRoute,
  serializeItotoriJsonSchemaBundle,
  serializeItotoriOpenApiDocument,
  type JsonValue,
} from "../src/api-contract.js";
import {
  assertItotoriApiErrorResponse,
  assertItotoriApiResponse,
  ITOTORI_STRICT_API_BODY_KEYS,
} from "../src/api-schema.js";
import type { ItotoriApiRouteId } from "../src/api-schema.js";
import {
  apiMutationBadRequestResponseFixture,
  benchmarkReportsFixture,
  bridgeImportResponseFixture,
  catalogBenchmarkSeedsFixture,
  catalogCompletenessFixture,
  catalogConflictReviewFixture,
  catalogOpportunitiesFixture,
  costDrilldownFixture,
  costReportFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  projectOverviewFixture,
  draftBranchResponseFixture,
  recordBenchmarkResponseFixture,
  recordDecisionResponseFixture,
  recordFindingResponseFixture,
  runtimeEvidenceIngestResponseFixture,
  runtimeStatusFixture,
  terminologySearchFixture,
} from "./api-fixtures.js";

const OPENAPI_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));
const JSON_SCHEMA_PATH = fileURLToPath(new URL("../api-jsonschema.json", import.meta.url));

const openApi = serializeItotoriOpenApiDocument();
const jsonSchemaBundle = serializeItotoriJsonSchemaBundle();

beforeAll(() => {
  if (process.env.UPDATE_OPENAPI_CONTRACT === "1") {
    writeFileSync(OPENAPI_PATH, openApi);
    writeFileSync(JSON_SCHEMA_PATH, jsonSchemaBundle);
  }
});

/** Round-trip a fixture through JSON so Date values become the wire strings a real HTTP body carries. */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const ajv = new Ajv({ strict: false, allErrors: true });

function validateAgainstRouteSchema(routeId: ItotoriApiRouteId, body: unknown): void {
  const schema = jsonSchemaForRoute(routeId, "response");
  expect(schema, `${routeId} response schema`).not.toBeNull();
  const validate = ajv.compile(schema as object);
  const valid = validate(body);
  expect(
    valid,
    `${routeId} response against emitted schema: ${ajv.errorsText(validate.errors)}`,
  ).toBe(true);
}

// Real response fixtures per route — the SAME committed shapes the HTTP contract
// harness serves. Used to prove schema/guard parity.
const RESPONSE_FIXTURES: Partial<Record<ItotoriApiRouteId, unknown>> = {
  "projects.list": { projects: [dashboardStatusFixture] },
  "projects.overview": projectOverviewFixture,
  "projects.status": dashboardStatusFixture,
  "projects.decisions": dashboardDecisionsFixture,
  "projects.cost": costReportFixture,
  "projects.costDrilldown": costDrilldownFixture,
  "projects.benchmarks": { reports: benchmarkReportsFixture },
  "runtime.status": runtimeStatusFixture,
  "catalog.conflicts": catalogConflictReviewFixture,
  "catalog.completeness": catalogCompletenessFixture,
  "catalog.benchmarkSeeds": catalogBenchmarkSeedsFixture,
  "catalog.opportunities": catalogOpportunitiesFixture,
  "terminology.search": terminologySearchFixture,
  "imports.bridge": bridgeImportResponseFixture,
  "branches.draft": draftBranchResponseFixture,
  "findings.record": recordFindingResponseFixture,
  "decisions.record": recordDecisionResponseFixture,
  "benchmarks.record": recordBenchmarkResponseFixture,
  "runtimeEvidence.ingest": runtimeEvidenceIngestResponseFixture,
};

describe("fe-api-openapi-emit: deterministic emit", () => {
  it("re-emits byte-identical OpenAPI + JSON-Schema (determinism)", () => {
    expect(serializeItotoriOpenApiDocument()).toBe(openApi);
    expect(serializeItotoriJsonSchemaBundle()).toBe(jsonSchemaBundle);
  });

  it("committed openapi.json matches the emitter (no drift)", () => {
    expect(readFileSync(OPENAPI_PATH, "utf8")).toBe(openApi);
  });

  it("committed api-jsonschema.json matches the emitter (no drift)", () => {
    expect(readFileSync(JSON_SCHEMA_PATH, "utf8")).toBe(jsonSchemaBundle);
  });
});

describe("fe-api-openapi-emit: authority coverage", () => {
  it("registers every route id exactly once and each has a body schema definition", () => {
    const bundle = buildItotoriJsonSchemaBundle() as { definitions: Record<string, JsonValue> };
    const definitions = bundle.definitions;
    expect(ITOTORI_API_ROUTE_IDS.length).toBe(Object.keys(ITOTORI_API_ROUTES).length);
    for (const routeId of ITOTORI_API_ROUTE_IDS) {
      const route = ITOTORI_API_ROUTES[routeId];
      expect(definitions[route.responseSchema], `${routeId} response definition`).toBeDefined();
      if (route.requestSchema !== undefined) {
        expect(definitions[route.requestSchema], `${routeId} request definition`).toBeDefined();
      }
    }
  });

  it("compiles every per-route response + request schema with ajv", () => {
    for (const routeId of ITOTORI_API_ROUTE_IDS) {
      const response = jsonSchemaForRoute(routeId, "response");
      expect(() => ajv.compile(response as object), `${routeId} response compiles`).not.toThrow();
      const request = jsonSchemaForRoute(routeId, "request");
      if (request !== null) {
        expect(() => ajv.compile(request as object), `${routeId} request compiles`).not.toThrow();
      }
    }
  });
});

describe("fe-api-openapi-emit: schema/guard parity (no fork)", () => {
  for (const [routeId, fixture] of Object.entries(RESPONSE_FIXTURES) as [
    ItotoriApiRouteId,
    unknown,
  ][]) {
    it(`${routeId}: the wire fixture satisfies BOTH the guard and the emitted schema`, () => {
      const body = wire(fixture);
      // The api-schema.ts guard (deep authority) accepts it...
      expect(() => assertItotoriApiResponse(routeId, body)).not.toThrow();
      // ...and so does the emitted JSON-Schema (wire envelope) — they agree.
      validateAgainstRouteSchema(routeId, body);
    });
  }

  it("the typed error body satisfies both the guard and the emitted error schema", () => {
    const body = wire(apiMutationBadRequestResponseFixture);
    expect(() => assertItotoriApiErrorResponse(body)).not.toThrow();
    const validate = ajv.compile(jsonSchemaForApiError() as object);
    expect(validate(body), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("the emitted schema has teeth: a dropped required key + a leaked field fail", () => {
    // Missing a required top-level key.
    const missingKey = wire(dashboardStatusFixture) as Record<string, unknown>;
    delete missingKey.projectId;
    const statusValidate = ajv.compile(jsonSchemaForRoute("projects.status", "response") as object);
    expect(statusValidate(missingKey)).toBe(false);

    // A leaked/extra top-level key on a strict (additionalProperties:false) body.
    const leaked = { ...(wire(catalogConflictReviewFixture) as object), leakedSecret: "x" };
    const conflictsValidate = ajv.compile(
      jsonSchemaForRoute("catalog.conflicts", "response") as object,
    );
    expect(conflictsValidate(leaked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fe-openapi-parity-all-routes — parity teeth for EVERY route, not just the
// subset with a real response fixture. Two mechanisms:
//   (1) STRICT bodies: the emitted `required` + `additionalProperties:false`
//       are GENERATED from `ITOTORI_STRICT_API_BODY_KEYS` — the very array the
//       guard passes to `asStrictRecord`. The "no fork" block asserts the
//       emitted envelope equals that guard authority key-list, so a strict body
//       cannot drift from its guard even without a fixture.
//   (2) ALL 34 routes (request + response bodies): a schema-driven teeth block
//       builds a minimal instance FROM the emitted schema, then proves the
//       schema rejects a body that drops any single required top-level key, and
//       (for strict bodies) rejects a leaked top-level field.
// ---------------------------------------------------------------------------

const jsonSchemaBundleDoc = buildItotoriJsonSchemaBundle() as {
  definitions: Record<string, JsonValueRecord>;
};
type JsonValueRecord = { readonly [key: string]: JsonValue };
const DEFINITIONS = jsonSchemaBundleDoc.definitions;

/** Resolve a `#/definitions/…` `$ref` (one hop) against the emitted bundle. */
function resolveSchema(schema: JsonValue): JsonValueRecord {
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    const ref = (schema as JsonValueRecord).$ref;
    if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
      return DEFINITIONS[ref.slice("#/definitions/".length)];
    }
    return schema as JsonValueRecord;
  }
  return {};
}

/**
 * Build a minimal instance that SATISFIES an envelope-level emitted schema:
 * fill every `required` key (recursing into `$ref` sub-schemas + typed
 * properties), honour `const`/`enum`, and default `any`/untyped to a string.
 * The envelope schemas are shallow (top-level required keys + primitive / array
 * / object / one-hop-`$ref` properties) so this terminates and yields a body
 * ajv accepts — the anchor the drop/leak teeth mutate.
 */
function minimalInstance(schema: JsonValue): unknown {
  const s = resolveSchema(schema);
  if (s.const !== undefined) {
    return s.const;
  }
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum[0];
  }
  switch (s.type) {
    case "array":
      return [];
    case "boolean":
      return true;
    case "number":
    case "integer":
      return 1;
    case "string":
      return "x";
    default:
      break;
  }
  if (s.type === "object" || s.properties !== undefined || s.required !== undefined) {
    const out: Record<string, unknown> = {};
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const properties = (s.properties ?? {}) as JsonValueRecord;
    for (const key of required) {
      out[key] = key in properties ? minimalInstance(properties[key]) : "x";
    }
    return out;
  }
  return "x";
}

describe("fe-openapi-parity-all-routes: strict envelope == guard authority (no fork)", () => {
  for (const [name, keys] of Object.entries(ITOTORI_STRICT_API_BODY_KEYS)) {
    it(`${name}: emitted required + additionalProperties match the guard key-list`, () => {
      const def = DEFINITIONS[name];
      expect(def, `${name} definition emitted`).toBeDefined();
      // Strict bodies pin additionalProperties:false so a leaked field fails.
      expect(def.additionalProperties, `${name} additionalProperties`).toBe(false);
      // The emitted required set is EXACTLY the array the guard asStrictRecord
      // enforces — one source, so the schema cannot fork from the guard.
      expect([...(def.required as string[])].sort()).toEqual([...keys].sort());
    });
  }
});

describe("fe-openapi-parity-all-routes: per-route teeth (all 34 routes, request + response)", () => {
  let bodyCount = 0;
  for (const routeId of ITOTORI_API_ROUTE_IDS) {
    const route = ITOTORI_API_ROUTES[routeId];
    const bodies: ReadonlyArray<readonly ["response" | "request", string]> = [
      ["response", route.responseSchema],
      ...(route.requestSchema !== undefined ? ([["request", route.requestSchema]] as const) : []),
    ];
    for (const [kind, componentName] of bodies) {
      bodyCount += 1;
      it(`${routeId} (${kind}/${componentName}): enforces each required key + rejects strict leaks`, () => {
        const schema = jsonSchemaForRoute(routeId, kind);
        expect(schema, `${routeId} ${kind} schema`).not.toBeNull();
        const validate = ajv.compile(schema as object);
        const def = DEFINITIONS[componentName];
        const required = (def.required ?? []) as string[];
        expect(required.length, `${componentName} has required keys`).toBeGreaterThan(0);

        // A minimal complete body validates (the teeth anchor).
        const valid = minimalInstance({ $ref: `#/definitions/${componentName}` }) as Record<
          string,
          unknown
        >;
        expect(
          validate(valid),
          `${componentName} minimal body valid: ${ajv.errorsText(validate.errors)}`,
        ).toBe(true);

        // Teeth: dropping ANY single required top-level key fails.
        for (const key of required) {
          const dropped = { ...valid };
          delete dropped[key];
          expect(validate(dropped), `${componentName} without "${key}" must be rejected`).toBe(
            false,
          );
        }

        // Teeth: a leaked top-level field fails on a strict body.
        if (def.additionalProperties === false) {
          const leaked = { ...valid, __itotori_leaked_field__: "x" };
          expect(validate(leaked), `${componentName} with a leaked field must be rejected`).toBe(
            false,
          );
        }
      });
    }
  }

  it("covers a body for every one of the 34 routes (no route left un-teethed)", () => {
    // 34 routes: each has a response body; the 8 mutation + reviewer/workspace
    // POST routes add a request body. This asserts the loop above actually
    // iterated a body per route so no route is silently skipped.
    const routesWithRequest = ITOTORI_API_ROUTE_IDS.filter(
      (id) => ITOTORI_API_ROUTES[id].requestSchema !== undefined,
    ).length;
    expect(ITOTORI_API_ROUTE_IDS.length).toBe(34);
    expect(bodyCount).toBe(ITOTORI_API_ROUTE_IDS.length + routesWithRequest);
  });
});
