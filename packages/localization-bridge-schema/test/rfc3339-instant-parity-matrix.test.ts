import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertRfc3339Instant,
  RFC3339_INSTANT_MALFORMED_CODE,
  Rfc3339InstantValidationError,
} from "../src/index.js";

type MatrixRow = {
  id: string;
  value: unknown;
  expected: "accept" | "reject";
  reason?: string;
  note?: string;
};

type ParityMatrix = {
  schemaVersion: string;
  semanticCode: string;
  canonicalRule: string;
  rows: MatrixRow[];
};

const matrix = JSON.parse(
  readFileSync(new URL("./rfc3339-instant-parity-matrix.v0.2.json", import.meta.url), "utf8"),
) as ParityMatrix;

describe("RFC3339 instant parity matrix (TypeScript contract validator)", () => {
  it("pins the shared cross-language semantic code", () => {
    expect(matrix.semanticCode).toBe(RFC3339_INSTANT_MALFORMED_CODE);
  });

  it("has both accept and reject coverage", () => {
    expect(matrix.rows.some((row) => row.expected === "accept")).toBe(true);
    expect(matrix.rows.some((row) => row.expected === "reject")).toBe(true);
  });

  for (const row of matrix.rows) {
    if (row.expected === "accept") {
      it(`accepts ${row.id} (${JSON.stringify(row.value)})`, () => {
        expect(() => {
          assertRfc3339Instant(row.value, "matrix");
        }).not.toThrow();
      });
    } else {
      it(`rejects ${row.id} (${JSON.stringify(row.value)}) with a semantic error`, () => {
        let captured: unknown;
        try {
          assertRfc3339Instant(row.value, "matrix");
        } catch (error) {
          captured = error;
        }
        expect(captured).toBeInstanceOf(Rfc3339InstantValidationError);
        expect((captured as Rfc3339InstantValidationError).code).toBe(
          RFC3339_INSTANT_MALFORMED_CODE,
        );
      });
    }
  }
});
