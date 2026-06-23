#!/usr/bin/env node
// Validate the impl-map JSON schema artifact against the positive and
// negative fixture corpus. The Rust validator owns semantic invariants;
// this script catches schema/fixture drift in the JS toolchain.
//
// Wired into `just check` via the `impl-map-schema-validate` recipe.
// See `.plan/UTSUSHI-025.md` §8.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(repoRoot, "roadmap/impl-map.schema.json");
const positiveDir = resolve(
  repoRoot,
  "crates/utsushi-core/src/port/impl_map/fixtures/positive",
);
const negativeDir = resolve(
  repoRoot,
  "crates/utsushi-core/src/port/impl_map/fixtures/negative",
);

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);

const errors = [];
let positiveCount = 0;
let negativeCount = 0;

for (const file of readdirSync(positiveDir).sort()) {
  if (!file.endsWith(".json")) continue;
  const path = resolve(positiveDir, file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!validate(value)) {
    for (const error of validate.errors ?? []) {
      errors.push(
        `${relative(repoRoot, path)} (positive) ${error.instancePath || "/"} ${error.message}`,
      );
    }
  }
  positiveCount += 1;
}

for (const file of readdirSync(negativeDir).sort()) {
  if (!file.endsWith(".json")) continue;
  const path = resolve(negativeDir, file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  // Negative fixtures must FAIL schema validation OR be flagged as
  // documented-Rust-only failures. For now the corpus is shaped so that
  // the JSON Schema catches the obvious cases; subtler ones (e.g.
  // orphan command refs) are Rust-validator-only and exempted.
  const rustOnly = new Set([
    "orphan-command.json",
    "validation-command-pipe.json",
  ]);
  if (rustOnly.has(file)) {
    negativeCount += 1;
    continue;
  }
  if (validate(value)) {
    errors.push(
      `${relative(repoRoot, path)} (negative) unexpectedly passed schema validation`,
    );
  }
  negativeCount += 1;
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(
  `validated impl-map schema against ${positiveCount} positive and ${negativeCount} negative fixture(s)`,
);
