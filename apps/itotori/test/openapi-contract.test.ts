import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildItotoriOpenApiDocument,
  type JsonValue,
  serializeItotoriJsonSchemaBundle,
  serializeItotoriOpenApiDocument,
} from "../src/api-contract.js";

const artifacts = [
  ["openapi.json", serializeItotoriOpenApiDocument()],
  ["api-jsonschema.json", serializeItotoriJsonSchemaBundle()],
];

const errorStatusDescriptions = {
  "400": "Malformed request (bad_request).",
  "403": "Permission denied (forbidden).",
  "404": "Route or resource not found (not_found).",
  "405": "Method not allowed (method_not_allowed).",
  "409": "Workflow conflicts with the current state (workflow_failed or run_transition_rejected).",
  "422": "Workflow input or operation cannot be processed (workflow_failed).",
  "429": "Exact cost allowance is exhausted (workflow_failed).",
  "500": "Internal error (internal_error).",
  "503": "Service unavailable (database_unreachable or workflow_failed).",
  "504": "Declared provider deadline reached (workflow_failed).",
};

const apiErrorCodes = [
  "bad_request",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "database_migrations_required",
  "database_unreachable",
  "workflow_failed",
  "run_transition_rejected",
  "internal_error",
];

function jsonObject(
  value: JsonValue | undefined,
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

describe("emitted API contract", () => {
  it.each(artifacts)("keeps %s byte-identical to the schema authority", (name, expected) => {
    const path = resolve(import.meta.dirname, "..", name);
    if (process.env.UPDATE_OPENAPI_CONTRACT === "1") writeFileSync(path, expected, "utf8");
    expect(readFileSync(path, "utf8")).toBe(expected);
  });

  it("declares the exact opaque incident UUID and allowance fields", () => {
    const document = buildItotoriOpenApiDocument();
    const serialized = JSON.stringify(document);

    expect(serialized).toContain("remainingAllowanceMicrosUsd");
    expect(serialized).toContain(
      "^incident:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    );
  });

  it("declares every explicit failure status and public error code on every route", () => {
    const document = jsonObject(buildItotoriOpenApiDocument(), "OpenAPI document");
    const paths = jsonObject(document.paths, "OpenAPI paths");

    for (const [path, pathValue] of Object.entries(paths)) {
      const pathItem = jsonObject(pathValue, `OpenAPI path ${path}`);
      for (const [method, operationValue] of Object.entries(pathItem)) {
        const operation = jsonObject(operationValue, `OpenAPI operation ${method} ${path}`);
        const responses = jsonObject(operation.responses, `OpenAPI responses ${method} ${path}`);
        expect(Object.keys(responses).sort()).toEqual(
          ["200", ...Object.keys(errorStatusDescriptions)].sort(),
        );
        for (const [status, description] of Object.entries(errorStatusDescriptions)) {
          const response = jsonObject(
            responses[status],
            `OpenAPI response ${method} ${path} ${status}`,
          );
          expect(response.description).toBe(description);
        }
      }
    }

    const components = jsonObject(document.components, "OpenAPI components");
    const schemas = jsonObject(components.schemas, "OpenAPI component schemas");
    const errorSchema = jsonObject(schemas.ApiErrorResponse, "ApiErrorResponse schema");
    const properties = jsonObject(errorSchema.properties, "ApiErrorResponse properties");
    const code = jsonObject(properties.code, "ApiErrorResponse code");
    expect(code.enum).toEqual(apiErrorCodes);
  });
});
