// concurrency-flag — pure CLI parsing and driven-concurrency precedence tests.

import { describe, expect, it } from "vitest";
import { ConcurrencyFlagError, parseConcurrencyFlag } from "../src/cli-handlers.js";
import { resolveDrivenConcurrency } from "../src/orchestrator/localize-fullproject-command.js";
import {
  DEFAULT_DRIVEN_CONCURRENCY,
  MAX_DRIVEN_CONCURRENCY,
} from "../src/orchestrator/project-driven-executor.js";

describe("--concurrency", () => {
  it("parses valid positive integer values through the documented boundaries", () => {
    expect(parseConcurrencyFlag(["--concurrency", "12"])).toBe(12);
    expect(parseConcurrencyFlag(["--concurrency", "1"])).toBe(1);
    expect(parseConcurrencyFlag(["--concurrency", String(MAX_DRIVEN_CONCURRENCY)])).toBe(
      MAX_DRIVEN_CONCURRENCY,
    );
  });

  it("rejects a missing value before it can be mistaken for an absent flag", () => {
    expect(() => parseConcurrencyFlag(["--concurrency"])).toThrow(ConcurrencyFlagError);
    expect(() => parseConcurrencyFlag(["--concurrency", "--run-dir", "x"])).toThrow(
      ConcurrencyFlagError,
    );
  });

  it("rejects non-integer values", () => {
    for (const value of ["8.5", "8x", "abc"]) {
      expect(() => parseConcurrencyFlag(["--concurrency", value])).toThrow(ConcurrencyFlagError);
    }
  });

  it("rejects non-canonical integer spellings (strict digit-only via String(parsed) !== raw)", () => {
    // `Number.parseInt` would silently coerce these to a valid int; the strict
    // `String(parsed) !== raw` guard refuses them so the operator's exact value wins.
    for (const value of ["+8", "08", " 8", "8 ", "Infinity", "0x8"]) {
      expect(() => parseConcurrencyFlag(["--concurrency", value])).toThrow(ConcurrencyFlagError);
    }
  });

  it("rejects values below one", () => {
    for (const value of ["0", "-1"]) {
      expect(() => parseConcurrencyFlag(["--concurrency", value])).toThrow(ConcurrencyFlagError);
    }
  });

  it("rejects values above the imported maximum", () => {
    for (const value of [String(MAX_DRIVEN_CONCURRENCY + 1), "27000"]) {
      expect(() => parseConcurrencyFlag(["--concurrency", value])).toThrow(ConcurrencyFlagError);
    }
  });

  it("leaves concurrency unset when the flag is absent", () => {
    expect(parseConcurrencyFlag([])).toBeUndefined();
    expect(parseConcurrencyFlag(["--run-dir", "x"])).toBeUndefined();
  });

  it("uses the shared ceiling check for both localize CLI surfaces", () => {
    // Both `localize` and `localize-game` call this shared parser, so this
    // assertion covers the ceiling regardless of surrounding argument order.
    expect(() =>
      parseConcurrencyFlag(["--config", "c", "--concurrency", "99", "--run-dir", "r"]),
    ).toThrow(ConcurrencyFlagError);
  });
});

describe("resolveDrivenConcurrency", () => {
  it("gives a CLI override precedence over configuration", () => {
    expect(resolveDrivenConcurrency(4, 8)).toBe(4);
  });

  it("uses configuration when the CLI leaves concurrency unset", () => {
    expect(resolveDrivenConcurrency(undefined, 8)).toBe(8);
  });

  it("leaves both unset for the executor default", () => {
    expect(resolveDrivenConcurrency(undefined, undefined)).toBeUndefined();
    expect(DEFAULT_DRIVEN_CONCURRENCY).toBe(8);
  });
});
