/*
 * ALPHA-007 — shared Ajv 2020 schema validation for the emitted public
 * fixture vertical artifacts. Uses the same Ajv 2020 the public manifest
 * validator already depends on (fixtures/validate-public-manifests.mjs).
 */
"use strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, "schemas");

// role -> schema filename. The benchmark-report.json envelope is validated by
// ITOTORI-026's own harness (it composes + validates BenchmarkReportV02); here
// we structurally gate it via the vertical manifest's producedBy/hash binding.
const SCHEMA_BY_ROLE = {
  "runtime-observation-proof": "runtime-observation-proof.schema.json",
  "provider-proof": "provider-proof.schema.json",
  "read-model-ingestion": "read-model-ingestion.schema.json",
  "shared-025-manifest-linkage": "shared-025-manifest-linkage.schema.json",
  "vertical-manifest": "vertical-manifest.schema.json",
};

const ajv = new Ajv2020({ allErrors: true });
const compiled = new Map();

function validatorFor(role) {
  if (compiled.has(role)) return compiled.get(role);
  const filename = SCHEMA_BY_ROLE[role];
  if (filename === undefined) {
    throw new Error(`alpha-public-fixture: no schema registered for role '${role}'`);
  }
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, filename), "utf8"));
  const validate = ajv.compile(schema);
  compiled.set(role, validate);
  return validate;
}

/** Returns [] when valid, else an array of "instancePath message" strings. */
export function schemaErrors(role, value) {
  const validate = validatorFor(role);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

export function assertSchemaValid(role, value) {
  const errors = schemaErrors(role, value);
  if (errors.length > 0) {
    throw new Error(
      `alpha-public-fixture: emitted '${role}' artifact failed schema validation:\n  ${errors.join("\n  ")}`,
    );
  }
}

export { SCHEMA_BY_ROLE };
