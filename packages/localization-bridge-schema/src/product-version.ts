/**
 * The single source-of-truth PRODUCT version for the itotori CLI and the
 * publishable surface (the bridge bundle, patch-export / delta formats, and
 * the API contract).
 *
 * `itotori --version` reports this value, and every format-level
 * `schemaVersion` marker in this package evolves under the release policy
 * documented in `docs/versioning-and-release-policy.md`.
 *
 * Determinism: this is a source literal (NOT derived at build time from git,
 * timestamps, or the environment), so any checkout of a given commit builds
 * and reports exactly the same version. Bump it on the release cut per the
 * policy doc; the CLI test in `apps/itotori/test/version.test.ts` pins the
 * reported value so a 0.0.0 regression fails CI.
 *
 * Pre-1.0 (`0.x.y`): the public formats may change incompatibly between minor
 * bumps. See the policy doc for the full rules.
 */
export const ITOTORI_PRODUCT_VERSION = "0.1.0" as const;
