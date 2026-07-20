// Regression suite for the LLM-layer import-boundary guard.
//
// Proves every rule catches a planted violation and a clean file passes:
// forbidden old-surface import, forbidden domain/decode import, forbidden
// package import, unauthorized dispatcher, and multiple dispatchers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractImportSpecifiers,
  findDispatcherCandidates,
  findDispatcherViolations,
  findDependencyGraphViolations,
  findImportViolations,
} from "./audit-llm-layer-imports.mjs";

const FILE = "apps/itotori/src/llm/dispatch.ts";

function config() {
  return {
    root: "apps/itotori/src/llm/",
    dispatcherModule: "apps/itotori/src/llm/dispatch.ts",
    forbiddenImportRoots: ["../agents/", "../orchestrator/", "../providers/"],
    forbiddenDomainDecodeRoots: ["../extract/", "../structure-export/", "../patch-export/"],
    forbiddenPackageImports: ["localization-journal-repository"],
    forbiddenProductionImportTokens: ["/agents/", "/providers/", "localization-journal-repository"],
  };
}

test("extractImportSpecifiers collects every module-loading source", async () => {
  const ast = (await import("./stable-ts-ast.mjs")).parseTypeScript(
    [
      'import { x } from "./foo.js";',
      'import type { T } from "../types.js";',
      'export { x } from "../compat.js";',
      'export * from "../barrel.js";',
      'await import("../dynamic.js");',
      'require("../commonjs.js");',
    ].join("\n"),
    FILE,
  );
  const specs = extractImportSpecifiers(ast);
  assert.deepEqual(
    specs.map((s) => s.value),
    ["./foo.js", "../types.js", "../compat.js", "../barrel.js", "../dynamic.js", "../commonjs.js"],
  );
});

test("catches a forbidden old-surface import (agents)", () => {
  const source = 'import { foo } from "../agents/registry.js";\n';
  const v = findImportViolations(FILE, source, config());
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "forbidden-old-surface");
  assert.match(v[0].matched, /agents/u);
});

test("catches a forbidden old-surface import (providers)", () => {
  const source = 'import { bar } from "../../providers/openrouter.js";\n';
  // This file is deeper: apps/itotori/src/llm/sub/deep.ts
  const deepFile = "apps/itotori/src/llm/sub/deep.ts";
  const v = findImportViolations(deepFile, source, config());
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "forbidden-old-surface");
});

test("catches a forbidden domain/decode import", () => {
  const source = 'import { decode } from "../extract/kaifuu-extract-seam.js";\n';
  const v = findImportViolations(FILE, source, config());
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "forbidden-domain-decode");
  assert.match(v[0].matched, /extract/u);
});

test("catches a forbidden package import (journal repository)", () => {
  const source =
    'import { JournalRepo } from "@itotori/db/repositories/localization-journal-repository.js";\n';
  const v = findImportViolations(FILE, source, config());
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "forbidden-package");
});

test("allows imports from contracts and schema packages", () => {
  const source = [
    'import { CallSpec } from "../contracts/calls.js";',
    'import { z } from "../contracts/index.js";',
    'import { BridgeUnit } from "@itotori/localization-bridge-schema";',
  ].join("\n");
  const v = findImportViolations(FILE, source, config());
  assert.deepEqual(v, []);
});

test("allows importing a sibling within the LLM layer", () => {
  const source = 'import { dispatch } from "./dispatch.js";\n';
  const v = findImportViolations("apps/itotori/src/llm/tools.ts", source, config());
  assert.deepEqual(v, []);
});

test("does not count comments or strings as imports", () => {
  const source = [
    '// import { x } from "../agents/registry.js";',
    'const note = "import from ../extract/";',
  ].join("\n");
  const v = findImportViolations(FILE, source, config());
  assert.deepEqual(v, []);
});

test("findDispatcherCandidates identifies the single SDK importer", () => {
  const files = [
    {
      path: "apps/itotori/src/llm/dispatch.ts",
      contents: 'import { createClient } from "@openrouter/sdk";\n',
    },
    {
      path: "apps/itotori/src/llm/tools.ts",
      contents: 'import { tool } from "./tool-def.js";\n',
    },
  ];
  const { candidates, dispatcherPath } = findDispatcherCandidates(files, config());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0], "apps/itotori/src/llm/dispatch.ts");
  assert.equal(dispatcherPath, "apps/itotori/src/llm/dispatch.ts");
});

test("findDispatcherCandidates flags multiple SDK importers", () => {
  const files = [
    {
      path: "apps/itotori/src/llm/dispatch.ts",
      contents: 'import { createClient } from "@openrouter/sdk";\n',
    },
    {
      path: "apps/itotori/src/llm/rogue.ts",
      contents: 'import { createClient } from "@openrouter/sdk";\n',
    },
  ];
  const { candidates } = findDispatcherCandidates(files, config());
  assert.equal(candidates.length, 2);
});

test("requires the designated dispatcher to be the sole SDK importer", () => {
  assert.deepEqual(
    findDispatcherViolations([], FILE).map((v) => v.rule),
    ["missing-dispatcher"],
  );
  assert.deepEqual(
    findDispatcherViolations([FILE, "apps/itotori/src/composition/rogue.ts"], FILE).map(
      (v) => v.rule,
    ),
    ["unauthorized-dispatcher", "multiple-dispatchers"],
  );
});

test("catches retired dependency edges outside the LLM layer", () => {
  const files = [
    {
      path: "apps/itotori/src/composition/live.ts",
      contents: 'import { legacy } from "../agents/registry.js";\n',
    },
    {
      path: "packages/itotori-db/src/service.ts",
      contents:
        'import { JournalRepo } from "./repositories/localization-journal-repository.js";\n',
    },
  ];
  const violations = findDependencyGraphViolations(files, config());
  assert.deepEqual(
    violations.map((violation) => violation.matched),
    ["/agents/", "localization-journal-repository"],
  );
});

test("catches re-export and dynamic retired dependency edges", () => {
  const files = [
    {
      path: "apps/itotori/src/composition/barrel.ts",
      contents: 'export * from "../agents/registry.js";\n',
    },
    {
      path: "apps/itotori/src/composition/dynamic.ts",
      contents: 'await import("../providers/openrouter.js");\n',
    },
  ];
  const violations = findDependencyGraphViolations(files, config());
  assert.deepEqual(
    violations.map((violation) => violation.matched),
    ["/agents/", "/providers/"],
  );
});

test("a clean LLM-layer file with no forbidden imports passes", () => {
  const source = [
    'import { CallSpec, CallResult } from "../contracts/calls.js";',
    'import type { ToolAllowlist } from "../contracts/tools.js";',
    'import { dispatch } from "./dispatch.js";',
  ].join("\n");
  const v = findImportViolations("apps/itotori/src/llm/profile.ts", source, config());
  assert.deepEqual(v, []);
});
