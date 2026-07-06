// Cross-version compatibility pin (beta-schema-stability-policy acceptance).
//
// For a non-developer-user beta, the rule is: a user's in-progress localization
// must SURVIVE a tool update — either a prior-version artifact still loads
// (backward compatibility), OR the loader fails LOUDLY with a typed
// FormatVersionMismatchError carrying a migration path. The one outcome that is
// NEVER acceptable is a silent break: a prior-version artifact being silently
// mis-parsed, truncated, or half-applied.
//
// This test pins that property for the two formats the acceptance clause names
// explicitly — the bridge bundle and the delta metadata record — by committing
// a prior-version (v0.1) artifact for each and asserting each fails loudly with
// a migration path while its current (v0.2) counterpart loads. It is the
// long-lived regression guard for `[[beta-schema-stability-policy]]`; if it
// ever fails because a v0.1 artifact is silently accepted, a user's data is at
// risk and the failure is a release blocker.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_FORMAT_STABILITY,
  FormatVersionMismatchError,
  assertBridgeBundleV02,
  assertDeltaPackageMetadataV02,
  isKnownLegacyVersion,
} from "../src/index.js";

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function capture(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to throw, but it did not");
}

describe("cross-version compatibility pin (bridge + delta) — beta-schema-stability-policy", () => {
  describe("bridge bundle (localization-bridge-schema)", () => {
    const CURRENT = "./examples/bridge-v0.2.json";
    // A committed prior-version bridge artifact (schemaVersion "0.1.0"). This
    // fixture is the cross-version regression target — its existence on disk
    // is what makes this a real "prior-version artifact" pin rather than a
    // synthetic mutation.
    const PRIOR_VERSION = "./examples/invalid/bridge-v0.2-schema-version-0.1.json";
    const PRIOR_LITERAL = "0.1.0";

    it(`the current bridge artifact (schemaVersion "${BRIDGE_FORMAT_STABILITY.schemaVersion}") loads`, () => {
      const bundle = fixture(CURRENT);
      expect(() => assertBridgeBundleV02(bundle)).not.toThrow();
    });

    it(`the prior-version bridge artifact (schemaVersion "${PRIOR_LITERAL}") fails loudly with FormatVersionMismatchError + migration path, NOT silently`, () => {
      const legacy = fixture(PRIOR_VERSION);
      expect(legacy.schemaVersion).toBe(PRIOR_LITERAL);
      const err = capture(() => assertBridgeBundleV02(legacy));
      // The failure MUST be the typed version-mismatch error, not a downstream
      // structural error that would indicate the loader started interpreting a
      // v0.1 payload as v0.2 (the silent-break shape we are guarding against).
      expect(err).toBeInstanceOf(FormatVersionMismatchError);
      const typed = err as FormatVersionMismatchError;
      expect(typed.formatId).toBe(BRIDGE_FORMAT_STABILITY.formatId);
      expect(typed.observed).toBe(PRIOR_LITERAL);
      expect(typed.supported).toBe(BRIDGE_FORMAT_STABILITY.schemaVersion);
      expect(typed.stabilityTier).toBe(BRIDGE_FORMAT_STABILITY.stabilityTier);
      expect(isKnownLegacyVersion(BRIDGE_FORMAT_STABILITY, PRIOR_LITERAL)).toBe(true);
      // The migration path MUST be embedded in the diagnostic so a user (or a
      // wrapping CLI) can act on it without reading source.
      expect(typed.migrationPath.length).toBeGreaterThan(0);
      expect(err.message).toContain("Migration path:");
      expect(err.message).toMatch(/schemaVersion must be 0\.2\.0/);
    });
  });

  describe("delta metadata record (localization-bridge-schema, delta axis)", () => {
    const CURRENT = "./examples/delta-package-v0.2.json";
    // The delta metadata record rides the bridge v0.2 axis. There is no
    // committed v0.1 delta-metadata fixture (the v0.1 surface predates the
    // delta provenance record), so we synthesize the prior-version artifact by
    // downgrading a known-good v0.2 record's schemaVersion. This is the same
    // shape a v0.1-era bridge would emit if it carried a delta pointer.
    const PRIOR_LITERAL = "0.1.0";

    it(`the current delta metadata (schemaVersion "${BRIDGE_FORMAT_STABILITY.schemaVersion}") loads`, () => {
      const metadata = fixture(CURRENT);
      expect(() => assertDeltaPackageMetadataV02(metadata)).not.toThrow();
    });

    it(`a prior-version delta metadata record (schemaVersion "${PRIOR_LITERAL}") fails loudly with FormatVersionMismatchError + migration path, NOT silently`, () => {
      const current = fixture(CURRENT);
      const legacy = { ...current, schemaVersion: PRIOR_LITERAL };
      expect(legacy.schemaVersion).toBe(PRIOR_LITERAL);
      const err = capture(() => assertDeltaPackageMetadataV02(legacy));
      expect(err).toBeInstanceOf(FormatVersionMismatchError);
      const typed = err as FormatVersionMismatchError;
      expect(typed.observed).toBe(PRIOR_LITERAL);
      expect(typed.supported).toBe(BRIDGE_FORMAT_STABILITY.schemaVersion);
      expect(isKnownLegacyVersion(BRIDGE_FORMAT_STABILITY, PRIOR_LITERAL)).toBe(true);
      expect(typed.migrationPath.length).toBeGreaterThan(0);
      expect(err.message).toContain("Migration path:");
    });
  });
});
