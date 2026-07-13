// Format stability tiers + version-negotiation unit tests.
//
// Scope (beta-schema-stability-policy):
//   - Every publishable-surface format has a stability declaration in the
//     registry, and each declaration is well-formed (tier in TIERS,
//     schemaVersion non-empty, since matches the product SEMVER shape,
//     migrationPath non-empty for beta/stable).
//   - negotiateFormatVersion / assertFormatVersion accept the supported
//     literal and reject everything else with FormatVersionMismatchError.
//   - The typed error carries formatId / observed / supported / stabilityTier
//     / knownLegacyVersions / migrationPath, and its message embeds the
//     migration path so a wrapping CLI surfaces a CLEAR diagnostic.
//   - A known-legacy observed literal is distinguishable from an unknown
//     (possibly newer) one via isKnownLegacyVersion.
//   - The bridge + delta asserters route their schemaVersion check through
//     assertFormatVersion (typed migration-path error, not a silent break).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_FORMAT_STABILITY,
  FORMAT_STABILITY_TIERS,
  type FormatStabilityDeclaration,
  FormatVersionMismatchError,
  KAIFUU_DELTA_FORMAT_STABILITY,
  PAIR_POLICY_FORMAT_STABILITY,
  PUBLIC_FORMAT_STABILITY,
  assertBridgeBundleV02,
  assertDeltaPackageMetadataV02,
  assertFormatVersion,
  isKnownLegacyVersion,
  negotiateFormatVersion,
} from "../src/index.js";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("PUBLIC_FORMAT_STABILITY registry (beta-schema-stability-policy acceptance: tiers declared)", () => {
  const EXPECTED_FORMAT_IDS = [
    "localization-bridge-schema",
    "kaifuu-delta-package",
    "pair-policy",
    "itotori-api-contract",
    "itotori-db-schema",
  ] as const;

  it("declares a tier for every publishable-surface format named in the policy doc", () => {
    for (const formatId of EXPECTED_FORMAT_IDS) {
      expect(
        PUBLIC_FORMAT_STABILITY[formatId],
        `missing declaration for ${formatId}`,
      ).toBeDefined();
    }
  });

  it("every declaration is well-formed", () => {
    for (const decl of Object.values(PUBLIC_FORMAT_STABILITY)) {
      assertDeclarationWellFormed(decl);
    }
  });

  it("every beta/stable format carries a non-empty migration path", () => {
    for (const decl of Object.values(PUBLIC_FORMAT_STABILITY)) {
      if (decl.stabilityTier === "experimental") continue;
      expect(decl.migrationPath.length, `${decl.formatId} migrationPath`).toBeGreaterThan(0);
    }
  });

  it("the bridge and .kaifuu delta formats enumerate their known legacy versions", () => {
    expect(BRIDGE_FORMAT_STABILITY.knownLegacyVersions).toContain("0.1.0");
    expect(KAIFUU_DELTA_FORMAT_STABILITY.knownLegacyVersions).toContain("0.2.0");
    expect(PAIR_POLICY_FORMAT_STABILITY.knownLegacyVersions).toEqual(
      expect.arrayContaining([
        "0.1",
        "itotori.pair-policy.v0.1",
        "0.2",
        "itotori.pair-policy.v0.2",
      ]),
    );
  });

  it("FORMAT_STABILITY_TIERS enumerates the documented tier ladder in order", () => {
    expect(FORMAT_STABILITY_TIERS).toEqual(["experimental", "beta", "stable"]);
  });
});

function assertDeclarationWellFormed(decl: FormatStabilityDeclaration): void {
  expect(decl.formatId.length).toBeGreaterThan(0);
  expect(decl.schemaVersion.length).toBeGreaterThan(0);
  expect(FORMAT_STABILITY_TIERS).toContain(decl.stabilityTier);
  expect(decl.since).toMatch(SEMVER_RE);
  expect(decl.authority.length).toBeGreaterThan(0);
  expect(Array.isArray(decl.knownLegacyVersions)).toBe(true);
  for (const v of decl.knownLegacyVersions) {
    expect(typeof v).toBe("string");
    expect(v).not.toBe(decl.schemaVersion);
  }
}

describe("negotiateFormatVersion / assertFormatVersion", () => {
  it("returns normally when observed equals the supported literal", () => {
    expect(() => negotiateFormatVersion(BRIDGE_FORMAT_STABILITY, "0.2.0")).not.toThrow();
    expect(() =>
      assertFormatVersion(BRIDGE_FORMAT_STABILITY, "0.2.0", "BridgeBundleV02.schemaVersion"),
    ).not.toThrow();
  });

  it("throws FormatVersionMismatchError for a known-legacy literal (with migration path)", () => {
    const err = capture(() => negotiateFormatVersion(BRIDGE_FORMAT_STABILITY, "0.1.0"));
    expect(err).toBeInstanceOf(FormatVersionMismatchError);
    if (!(err instanceof FormatVersionMismatchError)) throw new Error("unreachable");
    expect(err.formatId).toBe("localization-bridge-schema");
    expect(err.observed).toBe("0.1.0");
    expect(err.supported).toBe("0.2.0");
    expect(err.stabilityTier).toBe("beta");
    expect(err.knownLegacyVersions).toContain("0.1.0");
    expect(err.migrationPath.length).toBeGreaterThan(0);
    // The message MUST carry the migration path verbatim and the supported
    // literal (pinned-regex tests across the suite match on "must be 0.2.0").
    expect(err.message).toContain("must be 0.2.0");
    expect(err.message).toContain("Migration path:");
    expect(err.message).toContain("known legacy version");
    expect(isKnownLegacyVersion(BRIDGE_FORMAT_STABILITY, "0.1.0")).toBe(true);
  });

  it("throws FormatVersionMismatchError for an unknown (possibly newer) literal", () => {
    const err = capture(() => negotiateFormatVersion(BRIDGE_FORMAT_STABILITY, "9.9.9"));
    expect(err).toBeInstanceOf(FormatVersionMismatchError);
    if (!(err instanceof FormatVersionMismatchError)) throw new Error("unreachable");
    expect(err.observed).toBe("9.9.9");
    expect(isKnownLegacyVersion(BRIDGE_FORMAT_STABILITY, "9.9.9")).toBe(false);
    expect(err.message).toContain("newer than what this tool understands");
    expect(err.message).toContain("Migration path:");
  });

  it("treats a missing / non-string schemaVersion as '<absent>' (not silent)", () => {
    for (const observed of [undefined, null, 42, "", { not: "a string" }]) {
      const err = capture(() => negotiateFormatVersion(BRIDGE_FORMAT_STABILITY, observed));
      expect(err).toBeInstanceOf(FormatVersionMismatchError);
      if (!(err instanceof FormatVersionMismatchError)) throw new Error("unreachable");
      expect(err.observed).toBe("<absent>");
    }
  });

  it("assertFormatVersion embeds the caller-supplied label in the message", () => {
    const err = capture(() =>
      assertFormatVersion(BRIDGE_FORMAT_STABILITY, "0.1.0", "BridgeBundleV02.schemaVersion"),
    );
    expect(err.message).toContain("BridgeBundleV02.schemaVersion must be 0.2.0");
  });
});

describe("assertBridgeBundleV02 + assertDeltaPackageMetadataV02 route through version negotiation", () => {
  it("a current v0.2 bridge bundle loads", () => {
    const bundle = fixture("./examples/bridge-v0.2.json");
    expect(() => assertBridgeBundleV02(bundle)).not.toThrow();
  });

  it("a current v0.2 delta metadata record loads", () => {
    const metadata = fixture("./examples/delta-package-v0.2.json");
    expect(() => assertDeltaPackageMetadataV02(metadata)).not.toThrow();
  });

  it("a prior-version (v0.1) bridge bundle fails with FormatVersionMismatchError + migration path, not silently", () => {
    const legacy = fixture("./examples/invalid/bridge-v0.2-schema-version-0.1.json");
    const err = capture(() => assertBridgeBundleV02(legacy));
    expect(err).toBeInstanceOf(FormatVersionMismatchError);
    if (!(err instanceof FormatVersionMismatchError)) throw new Error("unreachable");
    expect(err.observed).toBe("0.1.0");
    expect(err.supported).toBe("0.2.0");
    expect(err.message).toContain("Migration path:");
    expect(err.message).toMatch(/schemaVersion must be 0\.2\.0/);
  });

  it("a prior-version (v0.1) delta metadata record fails with FormatVersionMismatchError + migration path", () => {
    const current = fixture("./examples/delta-package-v0.2.json");
    const legacy = { ...current, schemaVersion: "0.1.0" };
    const err = capture(() => assertDeltaPackageMetadataV02(legacy));
    expect(err).toBeInstanceOf(FormatVersionMismatchError);
    if (!(err instanceof FormatVersionMismatchError)) throw new Error("unreachable");
    expect(err.observed).toBe("0.1.0");
    expect(err.message).toContain("Migration path:");
  });

  it("an unknown (future) bridge schemaVersion fails as a newer-tool mismatch", () => {
    const current = fixture("./examples/bridge-v0.2.json");
    const future = { ...current, schemaVersion: "0.3.0" };
    const err = capture(() => assertBridgeBundleV02(future));
    expect(err).toBeInstanceOf(FormatVersionMismatchError);
    if (!(err instanceof FormatVersionMismatchError)) throw new Error("unreachable");
    expect(err.observed).toBe("0.3.0");
    expect(isKnownLegacyVersion(BRIDGE_FORMAT_STABILITY, "0.3.0")).toBe(false);
    expect(err.message).toContain("newer than what this tool understands");
  });
});

function capture(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to throw, but it did not");
}
