/*
 * ITOTORI-095 — shared Ajv 2020 schema validation for the emitted fixture
 * iteration artifacts. Uses the same Ajv 2020 the alpha public fixture
 * vertical + the public manifest validator already depend on.
 */
"use strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, "schemas");

// role -> schema filename. Every emitted per-stage artifact is validated by
// the single shared stage-result schema (stageId discriminates the stage);
// the final FixtureIterationResult manifest has its own schema.
const SCHEMA_BY_ROLE = {
  "stage-result": "fixture-iteration-stage.schema.json",
  "iteration-result": "fixture-iteration-result.schema.json",
};

const ajv = new Ajv2020({ allErrors: true });
const compiled = new Map();

function validatorFor(role) {
  if (compiled.has(role)) return compiled.get(role);
  const filename = SCHEMA_BY_ROLE[role];
  if (filename === undefined) {
    throw new Error(`itotori-fixture-iteration: no schema registered for role '${role}'`);
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
      `itotori-fixture-iteration: emitted '${role}' artifact failed schema validation:\n  ${errors.join("\n  ")}`,
    );
  }
}

export { SCHEMA_BY_ROLE };
