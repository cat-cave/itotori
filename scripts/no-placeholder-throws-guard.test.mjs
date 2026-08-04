import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findJavaScriptPlaceholderThrows,
  findRustPlaceholderThrows,
  isImplementationAdmission,
  isProductionSource,
} from "./no-placeholder-throws-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, "no-placeholder-throws-guard.mjs");

test("rejects an uninstalled production role binding", () => {
  const violations = findJavaScriptPlaceholderThrows(
    "apps/example/src/bindings.ts",
    'export function bind() { throw new Error("production review role binding has not been installed"); }',
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /role binding/u);
});

test("rejects implementation admissions while allowing caller errors", () => {
  assert.equal(isImplementationAdmission("not implemented"), true);
  assert.equal(
    isImplementationAdmission("facts are not yet settled; factual lanes must finish first"),
    false,
  );
  assert.equal(isImplementationAdmission("port missing"), false);
  assert.equal(isImplementationAdmission("unit dropped protected placeholder"), false);

  const source = [
    'throw new Error("facts are not yet settled; factual lanes must finish first");',
    'throw new Error("port missing");',
    'throw new Error("unit dropped protected placeholder");',
    'throw new Error("not implemented");',
  ].join("\n");
  const violations = findJavaScriptPlaceholderThrows("apps/example/src/service.ts", source);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].message, "not implemented");
});

test("Rust test-only macros are excluded while production macros are rejected", () => {
  const testOnly = `
    #[cfg(test)]
    mod tests {
      fn fake() { unimplemented!() }
    }
  `;
  assert.deepEqual(findRustPlaceholderThrows("crates/example/src/lib.rs", testOnly), []);
  assert.equal(
    findRustPlaceholderThrows("crates/example/src/lib.rs", "pub fn live() { unimplemented!() }")
      .length,
    1,
  );
  assert.equal(
    findRustPlaceholderThrows(
      "crates/example/src/lib.rs",
      "#[cfg(test)] fn test_only_hook() {} pub fn live() { unimplemented!() }",
    ).length,
    1,
  );
});

test("source scope excludes test and dist paths", () => {
  assert.equal(isProductionSource("apps/example/src/service.ts"), true);
  assert.equal(isProductionSource("apps/example/dist/service.js"), false);
  assert.equal(isProductionSource("apps/example/test/service.test.ts"), false);
  assert.equal(isProductionSource("scripts/no-placeholder-throws-guard.mjs"), false);
});

test("CLI proof: an untracked source violation fails, then caller errors and dist pass", () => {
  const root = mkdtempSync(join(tmpdir(), "placeholder-throws-cli-"));
  try {
    const sourceDirectory = join(root, "apps/example/src");
    const source = join(sourceDirectory, "service.ts");
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(join(root, "apps/example/dist"), { recursive: true });
    writeFileSync(source, 'export function live() { throw new Error("not implemented"); }\n');
    writeFileSync(
      join(root, "apps/example/dist/service.js"),
      'export function stale() { throw new Error("not implemented"); }\n',
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });

    const rejected = spawnSync(process.execPath, [guard, "--root", root], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /production placeholder throw/u);

    writeFileSync(
      source,
      [
        'export function facts() { throw new Error("facts are not yet settled; factual lanes must finish first"); }',
        'export function port() { throw new Error("port missing"); }',
        'export function placeholderName() { throw new Error("unit dropped protected placeholder"); }',
      ].join("\n"),
    );
    const accepted = spawnSync(process.execPath, [guard, "--root", root], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /production source files scanned/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
