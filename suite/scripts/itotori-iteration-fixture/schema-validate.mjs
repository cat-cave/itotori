/*
 * ITOTORI-028 — shared Ajv 2020 schema validation for the emitted end-to-end
 * iteration-fixture artifacts. Uses the same Ajv 2020 the ITOTORI-095 fixture
 * iteration + the ALPHA-007 public-fixture vertical already depend on.
 *
 * Two roles are owned here: the cross-tool stage artifacts (Kaifuu patch
 * result + Utsushi runtime observation) and the SHARED-025 iteration-fixture
 * result manifest that binds them to the Itotori iteration. The seven Itotori
 * loop stage artifacts are validated by the ITOTORI-095 stage schema (reused
 * verbatim, never re-declared).
 */
"use strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, "schemas");

// role -> schema filename. The cross-tool stage artifacts share one schema
// (stageId discriminates kaifuu/utsushi); the manifest has its own schema.
const SCHEMA_BY_ROLE = {
  "cross-stage": "iteration-fixture-stage.schema.json",
  "iteration-fixture-result": "iteration-fixture-result.schema.json",
};

const ajv = new Ajv2020({ allErrors: true });
const compiled = new Map();

function validatorFor(role) {
  if (compiled.has(role)) return compiled.get(role);
  const filename = SCHEMA_BY_ROLE[role];
  if (filename === undefined) {
    throw new Error(`itotori-iteration-fixture: no schema registered for role '${role}'`);
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
      `itotori-iteration-fixture: emitted '${role}' artifact failed schema validation:\n  ${errors.join("\n  ")}`,
    );
  }
}

export { SCHEMA_BY_ROLE };
