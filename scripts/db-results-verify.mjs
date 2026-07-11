// Shared integrity checks for DB-gate verify-only mode.
// Used by permission-denial / catalog-replay / style-guide-fixture-flow gates
// when they consume a shared vitest JSON report from the one full `test:db` run.
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Discover every on-disk DB suite file under packages/itotori-db/test/.
 * @param {string} repoRoot
 * @returns {Promise<string[]>} sorted basenames (e.g. "authorization-matrix.test.ts")
 */
export async function listDbTestFiles(repoRoot) {
  const testDir = path.join(repoRoot, "packages/itotori-db/test");
  const entries = await readdir(testDir);
  return entries.filter((name) => name.endsWith(".test.ts")).sort();
}

/**
 * Normalize a vitest testResults[*].name to the suite basename.
 * @param {string} name
 * @returns {string | null}
 */
export function suiteBasenameFromResultName(name) {
  if (typeof name !== "string") return null;
  const normalized = name.replace(/\\/gu, "/");
  const marker = "/test/";
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;
  const base = normalized.slice(idx + marker.length);
  // Reject nested paths that aren't a single suite file.
  if (!base || base.includes("/")) return null;
  return base.endsWith(".test.ts") ? base : null;
}

/**
 * Assert the shared vitest JSON contains EVERY on-disk DB test file exactly once.
 * A truncated 6-of-72 receipt must fail here — missing files are not coverage.
 *
 * @param {{ testResults?: unknown }} report
 * @param {string} repoRoot
 * @returns {Promise<{ expectedCount: number, observedCount: number, problems: string[] }>}
 */
export async function checkDbResultsCompleteness(report, repoRoot) {
  const expected = await listDbTestFiles(repoRoot);
  const problems = [];
  const results = Array.isArray(report?.testResults) ? report.testResults : null;
  if (!results) {
    return {
      expectedCount: expected.length,
      observedCount: 0,
      problems: ["shared DB results missing testResults array — truncated/unreadable"],
    };
  }

  const observed = [];
  const seen = new Map();
  for (const entry of results) {
    const base = suiteBasenameFromResultName(entry?.name);
    if (!base) {
      problems.push(
        `testResults entry has unrecognizable name (expected .../test/<suite>.test.ts): ${JSON.stringify(entry?.name)}`,
      );
      continue;
    }
    seen.set(base, (seen.get(base) ?? 0) + 1);
    observed.push(base);
  }

  for (const [base, count] of seen) {
    if (count > 1) {
      problems.push(`duplicate testResults entry for ${base} (${count} times)`);
    }
  }

  const observedSet = new Set(seen.keys());
  const expectedSet = new Set(expected);
  const missing = expected.filter((f) => !observedSet.has(f));
  const extra = [...observedSet].filter((f) => !expectedSet.has(f));

  if (missing.length > 0) {
    problems.push(
      `shared DB results are incomplete: missing ${missing.length}/${expected.length} suite file(s) ` +
        `(observed ${observedSet.size} unique path(s)). ` +
        `First missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `shared DB results have unexpected suite file(s): ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""}`,
    );
  }
  if (results.length !== expected.length && missing.length === 0 && extra.length === 0) {
    // Unique basenames match but cardinality differs (shouldn't happen without duplicates).
    problems.push(
      `shared DB results cardinality mismatch: expected ${expected.length} file(s), got ${results.length}`,
    );
  }

  return {
    expectedCount: expected.length,
    observedCount: observedSet.size,
    problems,
  };
}

/**
 * Only status "passed" counts as coverage. todo / skipped / pending / failed /
 * anything else is a hard failure (green-on-skip path closed).
 *
 * @param {Array<{ status?: string }>} assertions
 * @param {string} suite
 * @returns {{ passed: number, nonPassed: number, problems: string[] }}
 */
export function checkAssertionsAllPassed(assertions, suite) {
  const problems = [];
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return {
      passed: 0,
      nonPassed: 0,
      problems: [`suite ${suite} ran 0 tests - skipped != covered`],
    };
  }
  const passed = assertions.filter((a) => a?.status === "passed").length;
  const nonPassed = assertions.length - passed;
  if (nonPassed > 0) {
    const byStatus = new Map();
    for (const a of assertions) {
      const s = typeof a?.status === "string" ? a.status : "(missing)";
      if (s === "passed") continue;
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    }
    const detail = [...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
    problems.push(
      `suite ${suite} has ${nonPassed} non-passed assertion(s) (${detail}) — only status "passed" counts as coverage`,
    );
  }
  return { passed, nonPassed, problems };
}
