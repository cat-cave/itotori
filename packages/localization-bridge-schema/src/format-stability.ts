// Format stability tiers + version-negotiation for the publishable surface.
//
// The product version (`ITOTORI_PRODUCT_VERSION`) describes the whole product;
// each public format additionally carries a per-format `schemaVersion` marker
// (a distinct axis, see `docs/versioning-and-release-policy.md`). This module
// introduces the THIRD axis — a per-format **stability tier** — and the
// version-negotiation entry point a loader calls on read so that a version
// mismatch is a CLEAR, typed error with a migration path instead of a silent
// break.
//
// Closing DAG node `[[beta-schema-stability-policy]]`. The human-facing policy
// (tier definitions, the backward-compatibility rules, the per-format tier
// assignments, and the worked migration notes) lives in
// `docs/format-stability-and-compatibility-policy.md`.

import { ITOTORI_PRODUCT_VERSION } from "./product-version.js";

// ---------------------------------------------------------------------------
// Stability tiers
// ---------------------------------------------------------------------------

/**
 * The three documented stability tiers a public format can occupy.
 *
 * - **`experimental`** — the format may change incompatibly at any time, even
 *   on a patch. No migration path is promised. A loader MAY accept these
 *   best-effort but must warn. Intended for in-flight research formats that
 *   have not yet been promoted.
 *
 * - **`beta`** — the format is stable within a single product MINOR. Readers
 *   pin a single `schemaVersion` literal exactly (no-legacy-compat); a version
 *   mismatch is a typed {@link FormatVersionMismatchError} carrying a migration
 *   path, raised on load before any filesystem / state work. A user's
 *   in-progress localization survives a tool update by following the migration
 *   path (regenerate the artifact with the current tool), or fails LOUDLY with
 *   a documented remedy rather than silently. Every public format is `beta`
 *   while `ITOTORI_PRODUCT_VERSION` is `0.x`.
 *
 * - **`stable`** — reserved for the post-`1.0.0` public formats. Only
 *   additive, optional changes are permitted; an incompatible change requires
 *   a new `schemaVersion` AND a product major bump. On load, a `stable` format
 *   reader accepts its declared literal and rejects everything else with the
 *   same typed migration-path error.
 *
 * The tier ladder is monotone: a format moves `experimental → beta → stable`
 * as the product matures, and never backwards without a product major bump.
 */
export const FORMAT_STABILITY_TIERS = ["experimental", "beta", "stable"] as const;
export type FormatStabilityTier = (typeof FORMAT_STABILITY_TIERS)[number];

// ---------------------------------------------------------------------------
// Per-format declaration
// ---------------------------------------------------------------------------

/**
 * The stability declaration for one public format. The registry
 * {@link PUBLIC_FORMAT_STABILITY} is the single source of truth for which tier
 * each publishable-surface format occupies and how a reader negotiates its
 * version on load.
 */
export interface FormatStabilityDeclaration {
  /**
   * Stable identifier for the format family (e.g. `"localization-bridge-schema"`).
   * Used in diagnostics and in the policy doc's per-format anchors.
   */
  readonly formatId: string;
  /**
   * The single `schemaVersion` literal the current reader accepts. A loader
   * negotiates by exact equality against this value; anything else is a
   * {@link FormatVersionMismatchError}.
   */
  readonly schemaVersion: string;
  /** Documented stability tier for this format. */
  readonly stabilityTier: FormatStabilityTier;
  /**
   * The product version under which this declaration's `schemaVersion` +
   * `stabilityTier` combination became authoritative. moves only when the
   * declaration changes (bumping `schemaVersion`, promoting the tier, or
   * editing the migration path).
   */
  readonly since: string;
  /**
   * Source-file authority for the `schemaVersion` literal and validator
   * (repo-relative path), mirroring the "Source of truth" convention used in
   * `docs/versioning-and-release-policy.md`.
   */
  readonly authority: string;
  /**
   * Prior `schemaVersion` literals this reader explicitly rejects (no-legacy-
   * compat). Enumerated so a future bump lands an equally precise diagnostic.
   * A loader distinguishes a `knownLegacy` mismatch (follow the migration path)
   * from an unknown mismatch (the producer is newer than this tool).
   */
  readonly knownLegacyVersions: readonly string[];
  /**
   * Human-readable remedy a user follows when their on-disk artifact is a
   * known-legacy version (or produced by a newer tool than this one). Always
   * non-empty for `beta` / `stable` formats. The policy doc holds the long
   * form; this is the short form embedded in the typed error.
   */
  readonly migrationPath: string;
}

// ---------------------------------------------------------------------------
// Registry — the per-format tier assignments
// ---------------------------------------------------------------------------

/**
 * The bridge bundle + delta-metadata v0.2 format. Carries
 * `schemaVersion: "0.2.0"`; v0.1 is the known-legacy literal kept alive ONLY
 * for the hello-world fixture pipeline via the separate `assertBridgeBundle`
 * guard (the v0.2 guard rejects it loudly with a migration path).
 */
export const BRIDGE_FORMAT_STABILITY: FormatStabilityDeclaration = {
  formatId: "localization-bridge-schema",
  schemaVersion: "0.2.0",
  stabilityTier: "beta",
  since: ITOTORI_PRODUCT_VERSION,
  authority: "packages/localization-bridge-schema/src/index.ts",
  knownLegacyVersions: ["0.1.0"],
  migrationPath:
    "Regenerate the bridge bundle with a v0.2-capable extractor (kaifuu >= product 0.1.0); " +
    "v0.1 bundles are rejected by the v0.2 reader. See " +
    "docs/format-stability-and-compatibility-policy.md#localization-bridge-schema.",
};

/**
 * The `.kaifuu` engine delta package format (Rust; `crates/kaifuu-delta`).
 * `schemaVersion: "0.3.0"`; the v0.2 loader was deleted in KAIFUU-238
 * (no-legacy-compat — there is no compatibility shim for packages without
 * `sourceProvenance`). The TS metadata record (`DeltaPackageMetadataV02`)
 * is a provenance pointer that rides the bridge v0.2 axis and is negotiated
 * separately via {@link BRIDGE_FORMAT_STABILITY}.
 */
export const KAIFUU_DELTA_FORMAT_STABILITY: FormatStabilityDeclaration = {
  formatId: "kaifuu-delta-package",
  schemaVersion: "0.3.0",
  stabilityTier: "beta",
  since: ITOTORI_PRODUCT_VERSION,
  authority: "crates/kaifuu-delta/src/lib.rs",
  knownLegacyVersions: ["0.2.0"],
  migrationPath:
    "Re-run `kaifuu diff` with the current tool to emit a 0.3.0 package; the 0.2.0 reader " +
    "was deleted (KAIFUU-238, no-legacy-compat). See " +
    "docs/format-stability-and-compatibility-policy.md#kaifuu-delta-package.",
};

/**
 * The pair-policy wire format (the canonical no-legacy-compat precedent). The
 * v0.3 parser was the first loader in the monorepo to enumerate its known
 * legacy literals and reject each with a typed error; it is included in the
 * registry so the cross-format tier map is complete.
 */
export const PAIR_POLICY_FORMAT_STABILITY: FormatStabilityDeclaration = {
  formatId: "pair-policy",
  schemaVersion: "itotori.pair-policy.v0.3",
  stabilityTier: "beta",
  since: ITOTORI_PRODUCT_VERSION,
  authority: "packages/localization-bridge-schema/src/pair-policy.v0.3.ts",
  knownLegacyVersions: ["0.1", "itotori.pair-policy.v0.1", "0.2", "itotori.pair-policy.v0.2"],
  migrationPath:
    "Rewrite the pair-policy file to the v0.3 shape (single primary pair + OpenRouter-side " +
    "resilience). See docs/format-stability-and-compatibility-policy.md#pair-policy.",
};

/**
 * The public HTTP API contract (the dashboard / SPA REST surface). There is no
 * single umbrella literal — each read model carries its own `*.v0.1`
 * `schemaVersion`, asserted verbatim by `assertItotoriApiResponse` on BOTH the
 * server (before sending) and the SPA (before rendering). The `schemaVersion`
 * field here is the family suffix; see the policy doc for the per-route list.
 */
export const API_CONTRACT_FORMAT_STABILITY: FormatStabilityDeclaration = {
  formatId: "itotori-api-contract",
  schemaVersion: "*.v0.1",
  stabilityTier: "beta",
  since: ITOTORI_PRODUCT_VERSION,
  authority: "apps/itotori/src/api-schema.ts",
  knownLegacyVersions: [],
  migrationPath:
    "Server and SPA validate the contract against each other via assertItotoriApiResponse; " +
    "a version mismatch is a hard reject on both sides. Redeploy the server and SPA from the " +
    "same product version. See docs/format-stability-and-compatibility-policy.md#itotori-api-contract.",
};

/**
 * The Postgres database schema + migration registry. The "version" is the
 * migration head (`packages/itotori-db/src/migrations.ts`); forward-only
 * migrations are applied by `itotori db-migrate`, and the checksum-immutability
 * guard rejects any edit to an applied migration as `migration ${id} checksum
 * mismatch`. There is no rollback path by design.
 */
export const DB_SCHEMA_FORMAT_STABILITY: FormatStabilityDeclaration = {
  formatId: "itotori-db-schema",
  schemaVersion: "0057",
  stabilityTier: "beta",
  since: ITOTORI_PRODUCT_VERSION,
  authority: "packages/itotori-db/src/migrations.ts",
  knownLegacyVersions: [],
  migrationPath:
    "Run `itotori db-migrate` to apply forward-only migrations up to the head; the migration " +
    "registry is the version source. An edited applied migration fails loudly with " +
    "`migration ${id} checksum mismatch`. See " +
    "docs/format-stability-and-compatibility-policy.md#itotori-db-schema.",
};

/**
 * The authoritative registry of stability declarations for every publishable-
 * surface format. The policy doc renders this as its per-format tier table;
 * the test `format-stability.test.ts` pins its shape so a new format cannot
 * land without declaring a tier + migration path.
 */
export const PUBLIC_FORMAT_STABILITY: Readonly<Record<string, FormatStabilityDeclaration>> = {
  [BRIDGE_FORMAT_STABILITY.formatId]: BRIDGE_FORMAT_STABILITY,
  [KAIFUU_DELTA_FORMAT_STABILITY.formatId]: KAIFUU_DELTA_FORMAT_STABILITY,
  [PAIR_POLICY_FORMAT_STABILITY.formatId]: PAIR_POLICY_FORMAT_STABILITY,
  [API_CONTRACT_FORMAT_STABILITY.formatId]: API_CONTRACT_FORMAT_STABILITY,
  [DB_SCHEMA_FORMAT_STABILITY.formatId]: DB_SCHEMA_FORMAT_STABILITY,
};

// ---------------------------------------------------------------------------
// Version-negotiation
// ---------------------------------------------------------------------------

/**
 * Typed error raised by {@link negotiateFormatVersion} /
 * {@link assertFormatVersion} when an on-disk artifact's `schemaVersion` does
 * not match the loader's supported literal. Carries everything a user (or a
 * wrapping CLI) needs to surface a CLEAR diagnostic with a migration path:
 *
 * - `formatId` — which format family rejected the artifact.
 * - `observed` — the offending literal (or `"<absent>"` if missing / non-string).
 * - `supported` — the single literal this loader accepts.
 * - `stabilityTier` — the declared tier (governs what a mismatch means).
 * - `knownLegacyVersions` — the explicit reject-list, so the caller can tell a
 *   user "this file is from an older tool" vs "this file is from a newer tool".
 * - `migrationPath` — the short-form remedy; the policy doc has the long form.
 *
 * This mirrors {@link import("./pair-policy.v0.3.js").PairPolicyVersionMismatchError},
 * generalized across every public format.
 */
export class FormatVersionMismatchError extends Error {
  constructor(
    public readonly formatId: string,
    public readonly observed: string,
    public readonly supported: string,
    public readonly stabilityTier: FormatStabilityTier,
    public readonly knownLegacyVersions: readonly string[],
    public readonly migrationPath: string,
    label: string,
  ) {
    const isLegacy = knownLegacyVersions.includes(observed);
    const isFuture = !isLegacy && observed !== "<absent>";
    const flavor = isLegacy
      ? `'${observed}' is a known legacy version of ${formatId}.`
      : isFuture
        ? `'${observed}' is newer than what this tool understands (this tool was built against product ${ITOTORI_PRODUCT_VERSION}); upgrade itotori.`
        : `the schemaVersion field is absent or non-string.`;
    super(
      `${label} must be ${supported}, got ${observed}. ` +
        `[stability tier: ${stabilityTier}] ${flavor} ` +
        `Migration path: ${migrationPath}`,
    );
    this.name = "FormatVersionMismatchError";
  }
}

/**
 * Read-side version negotiation. Returns normally iff `observed` is the single
 * supported literal for `decl`. Throws {@link FormatVersionMismatchError}
 * otherwise — the thrown diagnostic always names the format, the observed +
 * supported literals, whether the observed value is a known-legacy literal or
 * an unknown (possibly newer) one, and the migration path.
 *
 * `observed` is typed `unknown` so a loader can pass a raw field value
 * straight through; non-string values are normalized to `"<absent>"` so a
 * missing / malformed `schemaVersion` produces the same typed error shape as
 * a version mismatch (no silent acceptance, no separate code path).
 */
export function negotiateFormatVersion(decl: FormatStabilityDeclaration, observed: unknown): void {
  const observedText = typeof observed === "string" && observed.length > 0 ? observed : "<absent>";
  if (observedText === decl.schemaVersion) return;
  throw new FormatVersionMismatchError(
    decl.formatId,
    observedText,
    decl.schemaVersion,
    decl.stabilityTier,
    decl.knownLegacyVersions,
    decl.migrationPath,
    `${decl.formatId}.schemaVersion`,
  );
}

/**
 * Labeled variant of {@link negotiateFormatVersion} for use inside a guard
 * (`asserts`), so the typed error's message embeds the validator's field
 * label (e.g. `"BridgeBundleV02.schemaVersion"`) and existing pinned-regex
 * tests that match on `<label> ... must be <version>` keep working.
 */
export function assertFormatVersion(
  decl: FormatStabilityDeclaration,
  observed: unknown,
  label: string,
): void {
  const observedText = typeof observed === "string" && observed.length > 0 ? observed : "<absent>";
  if (observedText === decl.schemaVersion) return;
  throw new FormatVersionMismatchError(
    decl.formatId,
    observedText,
    decl.schemaVersion,
    decl.stabilityTier,
    decl.knownLegacyVersions,
    decl.migrationPath,
    label,
  );
}

/**
 * `true` iff `observed` is one of `decl.knownLegacyVersions`. Convenience for
 * callers / tests that want to distinguish "older tool produced this" from
 * "newer tool produced this" without catching.
 */
export function isKnownLegacyVersion(decl: FormatStabilityDeclaration, observed: unknown): boolean {
  return typeof observed === "string" && decl.knownLegacyVersions.includes(observed);
}
