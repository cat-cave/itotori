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
import { assertItotoriApiErrorResponse, assertItotoriApiResponse } from "../src/api-schema.js";
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
