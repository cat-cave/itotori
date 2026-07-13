import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DB-backed suites in this package normally MUST fail loud when `DATABASE_URL`
// is missing (the canonical `throw new Error("DATABASE_URL is required for
// DB-backed repository tests")` in db-test-context.ts), never silently skip
// via a conditional describe gate. The iteration North-Star proof is the
// deliberately documented exception: its direct Vitest invocation is useful
// without a local DB, while the canonical `test:db --require-database` runner
// still fails loudly when the DB is absent. Keep that one exact guard narrow;
// every other conditional skip remains a discipline failure.
//
// The forbidden token is assembled from fragments below so that this file
// itself contains no literal occurrence of it (keeping the tree-wide search
// at zero matches, including this guard).
describe("db failure discipline", () => {
  const testDir = new URL("./", import.meta.url);
  const forbiddenSkipGate = "skip" + "If";
  const allowedIterationProofFile = "localization-iteration-repository.test.ts";
  const allowedIterationProofGate = `describe.${forbiddenSkipGate}(!process.env.DATABASE_URL)`;

  function testSourceFiles(): string[] {
    return readdirSync(testDir).filter((file) => file.endsWith(".ts"));
  }

  it("uses no conditional-skip gate except the explicit iteration live-DB proof", () => {
    const offenders: string[] = [];
    for (const file of testSourceFiles()) {
      const source = readFileSync(new URL(file, testDir), "utf8");
      if (source.includes(forbiddenSkipGate)) {
        const allowed =
          file === allowedIterationProofFile &&
          source.split(allowedIterationProofGate).length === 2;
        if (!allowed) offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
