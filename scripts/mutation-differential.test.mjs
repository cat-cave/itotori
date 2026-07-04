// Regression suite for scripts/mutation-differential.mjs — exercises the pure
// harness logic (mutation application, kill/escape/compile-error classification,
// mutation-set well-formedness) WITHOUT invoking cargo, so it runs in the fast
// `just check` lane. The heavy source-level kill-matrix (which recompiles Rust)
// is a separate `just mutation-differential` lane.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  MUTATIONS,
  REAL_GUARDS,
  applyMutation,
  classifyOutcome,
} from "./mutation-differential.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// applyMutation
// ---------------------------------------------------------------------------
test("applyMutation replaces the single find occurrence", () => {
  const src = "let x = a;\nlet y = b;\n";
  const out = applyMutation(src, { id: "t", file: "f", find: "a;", replace: "z;" });
  assert.equal(out, "let x = z;\nlet y = b;\n");
});

test("applyMutation rejects a find token that is absent (0 occurrences)", () => {
  assert.throws(
    () => applyMutation("nothing here", { id: "t", file: "f", find: "MISSING", replace: "x" }),
    /expected exactly 1 occurrence/u,
  );
});

test("applyMutation rejects an ambiguous find token (>1 occurrence)", () => {
  assert.throws(
    () => applyMutation("dup dup", { id: "t", file: "f", find: "dup", replace: "x" }),
    /expected exactly 1 occurrence.*found 2/u,
  );
});

// ---------------------------------------------------------------------------
// classifyOutcome — the fail-loud contract.
// ---------------------------------------------------------------------------
test("classifyOutcome: a red synthetic suite (non-zero status, no compile error) is KILLED", () => {
  assert.equal(
    classifyOutcome({ status: 101, output: "test result: FAILED. 1 failed" }),
    "killed",
  );
});

test("classifyOutcome: a green synthetic suite (status 0) is ESCAPED — the fail-loud case", () => {
  assert.equal(classifyOutcome({ status: 0, output: "test result: ok. 42 passed" }), "escaped");
});

test("classifyOutcome: a non-compiling mutation is INVALID, not a kill", () => {
  for (const output of [
    "error[E0308]: mismatched types",
    "error: could not compile `kaifuu-reallive`",
    "error: expected `;`, found `}`",
    "error: cannot find value `foo` in this scope",
  ]) {
    assert.equal(classifyOutcome({ status: 101, output }), "compile_error", output);
  }
});

// ---------------------------------------------------------------------------
// Mutation-set well-formedness — every mutation must be applyable to its real
// target file exactly once, and cover the required regression classes.
// ---------------------------------------------------------------------------
test("every mutation's find token occurs exactly once in its (real, current) target file", () => {
  for (const m of MUTATIONS) {
    const abs = join(repoRoot, m.file);
    assert.ok(existsSync(abs), `mutation '${m.id}' target file missing: ${m.file}`);
    const src = readFileSync(abs, "utf8");
    // applyMutation throws unless exactly one occurrence — this is the guard.
    assert.doesNotThrow(() => applyMutation(src, m), `mutation '${m.id}' find token not unique`);
    // And the replacement genuinely changes the file.
    assert.notEqual(applyMutation(src, m), src, `mutation '${m.id}' is a no-op`);
  }
});

test("mutation ids are unique and reference a known real-bytes guard family", () => {
  const ids = MUTATIONS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate mutation id");
  for (const m of MUTATIONS) {
    assert.ok(Array.isArray(m.guardCrates) && m.guardCrates.length > 0, `${m.id}: no guardCrates`);
    assert.ok(REAL_GUARDS[m.realFamily], `${m.id}: unknown realFamily ${m.realFamily}`);
  }
});

test("the mutation set covers each representative real-regression class", () => {
  const cats = MUTATIONS.map((m) => m.category).join(" | ").toLowerCase();
  for (const needle of [
    "wrong offset",
    "opcode",
    "off-by-one framing",
    "cipher",
    "avg32",
    "jump-recalc",
    "dropped choice",
  ]) {
    assert.ok(cats.includes(needle), `mutation set missing a '${needle}' class`);
  }
  // Multi-family: at least one non-reallive family is exercised.
  assert.ok(
    MUTATIONS.some((m) => m.realFamily !== "reallive"),
    "mutation set must span >1 engine family",
  );
});
