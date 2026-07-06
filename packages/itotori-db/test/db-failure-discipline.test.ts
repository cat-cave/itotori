import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DB-backed suites in this package MUST fail loud when `DATABASE_URL` is
// missing (the canonical `throw new Error("DATABASE_URL is required for
// DB-backed repository tests")` in db-test-context.ts), never silently skip
// via a `describe.skip-if(!process.env.DATABASE_URL)` gate. This meta-test is
// the discipline gate: it is the in-suite equivalent of searching the DB test
// directory for the silent-skip token and finding ZERO matches, so the
// anti-pattern cannot regress.
//
// The forbidden token is assembled from fragments below so that this file
// itself contains no literal occurrence of it (keeping the tree-wide search
// at zero matches, including this guard).
describe("db failure discipline", () => {
  const testDir = new URL("./", import.meta.url);
  const forbiddenSkipGate = "skip" + "If";

  function testSourceFiles(): string[] {
    return readdirSync(testDir).filter((file) => file.endsWith(".ts"));
  }

  it("uses no conditional-skip gate anywhere in the DB test suite", () => {
    const offenders: string[] = [];
    for (const file of testSourceFiles()) {
      const source = readFileSync(new URL(file, testDir), "utf8");
      if (source.includes(forbiddenSkipGate)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
