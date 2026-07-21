// UNIV-011 — TypeScript mutation-survivor thresholds and case table.
//
// A "mutation-survivor guard" proves that the highest-risk schema invariants
// have TEETH: for each selected invariant we commit a deliberately-mutated
// INVALID fixture (a single, well-understood mutation of an otherwise-valid
// artifact) and assert the validator REJECTS it with a specific diagnostic.
//
// A "survivor" is a mutation the validator FAILS to reject — i.e. a gap in
// coverage. The guard collects survivors and asserts the count equals
// `MUTATION_SURVIVOR_THRESHOLD` (0). Any survivor names the invariant, the
// fixture, and the mutation, so a failure is directly actionable.
//
// The thresholds are documented constants (not magic numbers inline in the
// test) so the intended bar is reviewable in one place.

/** The selected highest-risk invariants covered by the survivor guard. */
export type MutationInvariant = "schema" | "delta" | "protected_span" | "permission";

/** All invariants the guard is REQUIRED to cover with at least one case. */
export const REQUIRED_MUTATION_INVARIANTS: readonly MutationInvariant[] = [
  "schema",
  "delta",
  "protected_span",
  "permission",
] as const;

/**
 * Maximum number of surviving mutations tolerated across the whole guard.
 * Zero: every committed invalid fixture MUST be rejected by its validator.
 */
export const MUTATION_SURVIVOR_THRESHOLD = 0;

/**
 * Minimum committed invalid fixtures required per selected invariant. The
 * acceptance bar is "at least one committed invalid fixture per invariant".
 */
export const MIN_COMMITTED_FIXTURES_PER_INVARIANT = 1;

export interface MutationCase {
  /** The invariant this mutation attacks. */
  readonly invariant: MutationInvariant;
  /** Human-readable id used in actionable diagnostics. */
  readonly id: string;
  /** Committed fixture path, relative to this test directory. */
  readonly fixture: string;
  /** The single deliberate mutation applied to an otherwise-valid artifact. */
  readonly mutation: string;
  /** Name of the validator that MUST reject the fixture. */
  readonly validator: string;
  /** The typed diagnostic the validator MUST emit (regex over the thrown message). */
  readonly expectedDiagnostic: RegExp;
}

/**
 * The committed mutation-survivor corpus. Each entry is a real JSON fixture on
 * disk; the guard loads it, runs `validator`, and requires the throw to match
 * `expectedDiagnostic`. Reuses the already-committed `examples/invalid` corpus
 * where a clean per-invariant mutation already exists, and adds a dedicated
 * protected-span identity-collision fixture.
 */
export const MUTATION_CASES: readonly MutationCase[] = [
  {
    invariant: "schema",
    id: "schema.bridge-schema-version-downgrade",
    fixture: "./examples/invalid/bridge-v0.2-schema-version-0.1.json",
    mutation: "bridge bundle schemaVersion mutated from 0.2.0 to 0.1.0",
    validator: "assertBridgeBundleV02",
    expectedDiagnostic: /schemaVersion must be 0\.2\.0/,
  },
  {
    invariant: "schema",
    id: "schema.bridge-malformed-hash",
    fixture: "./examples/invalid/bridge-v0.2-malformed-hash.json",
    mutation: "sourceBundleHash mutated to a non-canonical sha256 string",
    validator: "assertBridgeBundleV02",
    expectedDiagnostic: /sha256/,
  },
  {
    invariant: "delta",
    id: "delta.source-revision-hash-mismatch",
    fixture: "./examples/invalid/delta-package-v0.2-source-revision-mismatch.json",
    mutation: "sourceBundleRevision.value diverged from sourceBundleHash",
    validator: "assertDeltaPackageMetadataV02",
    expectedDiagnostic: /sourceBundleRevision\.value must equal the matching content hash/,
  },
  {
    invariant: "protected_span",
    id: "protected_span.duplicate-source-span-identity",
    fixture: "./examples/invalid/patch-export-v0.2-duplicate-source-span-identity.json",
    mutation:
      "a second protectedSpanMappings entry reuses the first entry's sourceSpanId (identity collision)",
    validator: "assertPatchExportV02",
    expectedDiagnostic: /kaifuu\.patch_export\.duplicate_source_span_identity/,
  },
  {
    invariant: "permission",
    id: "permission.missing-required-grant",
    fixture: "./examples/invalid/permission-local-user-v0.2-missing-grant.json",
    mutation: "required local-user grants dropped from the exact grant set",
    validator: "assertPermissionLocalUserFixtureV02",
    expectedDiagnostic: /grants must include/,
  },
] as const;
