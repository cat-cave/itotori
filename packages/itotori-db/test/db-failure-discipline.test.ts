import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DB-backed suites in this package normally MUST fail loud when `DATABASE_URL`
// is missing (the canonical `throw new Error("DATABASE_URL is required for
// DB-backed repository tests")` in db-test-context.ts), never silently skip
// via a conditional describe gate. The iteration North-Star proof is the
// deliberately documented exception: its direct Vitest invocation is useful
// without a local DB, while the canonical `test:db --require-database` runner
// still fails loudly when the DB is absent. That proof was retired with the
// journal persistence, so every conditional skip is now a discipline failure.
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

  it("uses no conditional-skip gate", () => {
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
