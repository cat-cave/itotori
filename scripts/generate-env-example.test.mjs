import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readEnvironmentRegistry, renderEnvironmentExample } from "./generate-env-example.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in environment example is generated from the sole registry", () => {
  const generated = renderEnvironmentExample(readEnvironmentRegistry());
  assert.equal(readFileSync(path.join(root, ".env.example"), "utf8"), generated);
});
