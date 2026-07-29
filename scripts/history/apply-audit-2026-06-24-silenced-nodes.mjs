/** @type {Array<object>} */
export const SILENCED_NODES = [
  // ---- Silenced-tests audit (§4) -------------------------------------------
  {
    id: "capability_kaifuu_207",
    title: "binary-patch-smoke helper reconciliation",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: ["capability_kaifuu_011"],
    summary:
      "Reconcile every `#[allow(dead_code)]` symbol in `crates/kaifuu-cli/src/binary_patch_smoke.rs`. Drop the stale silences on `parse` (line 45), `BinarySmokeOutcome` enum (line 80), and `write_smoke_summary` (line 492) since the symbols are called from `main.rs:208`, `:224-228`, and `:221`. Either delete or wire the four genuinely-dead helpers (`exit_code` line 91, `patch_result_filename` line 506, `output_seen_filename` line 511, `fixture_path_for` line 516).",
    deliverables: [
      "Edits to `crates/kaifuu-cli/src/binary_patch_smoke.rs` removing all six `#[allow(dead_code)]` attributes; replaced with either deletion or active wiring.",
      "If retained: at least one external caller per remaining helper, callable from `main.rs` or another module.",
      "Regression test `crates/kaifuu-cli/tests/binary_patch_smoke_allowlist.rs` invoking `rg` (via `std::process::Command`) to assert zero `#[allow(dead_code)]` attributes remain.",
      "Updated capability_kaifuu_011 runtime README cross-reference if a CLI flag is added or removed.",
    ],
    acceptanceCriteria: [
      "`rg '#\\[allow\\(dead_code\\)\\]' crates/kaifuu-cli/src/binary_patch_smoke.rs` returns zero matches.",
      "`cargo build -p kaifuu-cli` succeeds without re-introducing the `dead_code` lint.",
      "Any retained helper has >= 1 external caller verified by `rg` for the helper name across `crates/kaifuu-cli/src/`.",
      "`cargo test -p kaifuu-cli --test binary_patch_smoke_allowlist` passes deterministically.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo build -p kaifuu-cli",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-cli --test binary_patch_smoke_allowlist",
      },
    ],
    auditFocus: [
      "No `#[allow(dead_code)]` may be replaced with `#[allow(unused)]` or `#[cfg(test)]` as a silencer; either delete or wire.",
      "Deleted helpers must not be re-introduced by capability_kaifuu_011 follow-up work.",
      "Regression test must hold even after future refactors of `binary_patch_smoke.rs`.",
    ],
  },
  {
    id: "capability_itotori_202",
    title: "Uniform DB-suite failure discipline on missing DATABASE_URL",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["itotori"],
    parallelGroup: "itotori-core",
    dependsOn: [],
    summary:
      "Make `packages/itotori-db/test/authorization-matrix.test.ts:976` follow the same fail-loud-on-missing-`DATABASE_URL` pattern as the rest of the package's DB tests (`db-test-context.ts:48`, `repository.test.ts:3923`). Either standardize the whole package on `skipIf` or standardize on `throw new Error('DATABASE_URL is required …')` — remove the inconsistency that lets contributors running the DB suite without the env var pass this file while the others crash.",
    deliverables: [
      "Edit to `packages/itotori-db/test/authorization-matrix.test.ts:976` replacing `describe.skipIf(!process.env.DATABASE_URL)(...)` with the package's canonical `throw new Error(...)` pattern (matching `db-test-context.ts:48`).",
      "Regression test `packages/itotori-db/test/db-failure-discipline.test.ts` asserting `rg 'skipIf' packages/itotori-db/test/` returns zero matches (or migrates all DB tests to a single canonical pattern).",
      "Documentation update in `packages/itotori-db/README.md` naming the required env var.",
      "CI lane confirmation that `.github/workflows/ci.yml` still sets `DATABASE_URL` so the suite never falls through.",
    ],
    acceptanceCriteria: [
      "`rg 'skipIf' packages/itotori-db/test/` returns zero matches.",
      "`pnpm --filter @itotori/db test` without `DATABASE_URL` fails loud with the canonical error message before any test body runs (no silent skip).",
      "`pnpm --filter @itotori/db test` with `DATABASE_URL` set passes the authorization-matrix suite.",
      "Documentation in `packages/itotori-db/README.md` cites the canonical failure-on-missing-env-var contract.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . pnpm --filter @itotori/db test",
      },
      {
        type: "command",
        value: "rg 'skipIf' packages/itotori-db/test/",
      },
    ],
    auditFocus: [
      "All DB-touching tests must use the same canonical failure pattern; no silent skip.",
      "CI must still set `DATABASE_URL`; the change must not break the CI lane.",
      "Local developers must get the same loud failure across every DB test file.",
    ],
  },
  {
    id: "capability_kaifuu_208",
    title: "deny.toml strictness pass on bans.multiple-versions and bans.wildcards",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: [],
    summary:
      'Move `bans.multiple-versions` from `"warn"` to `"deny"`, flip `bans.wildcards` from `"allow"` to `"deny"` in `deny.toml`, and add a documented `skip = [...]` allowlist for any duplicate-version pair we accept (with a one-line `# reason:` justification each).',
    deliverables: [
      'Edit to `deny.toml` setting `bans.multiple-versions = "deny"` and `bans.wildcards = "deny"`.',
      "If duplicates remain unavoidable: `skip` table entries in `deny.toml` listing each crate name + version, each preceded by a `# reason: …` comment line.",
      'Regression test (`scripts/verify-deny-strict.mjs` or equivalent) asserting `bans.multiple-versions == "deny"` and `bans.wildcards == "deny"`.',
      "Updated `docs/dependency-policy.md` (or new section in the kaifuu policy doc) describing the new strictness.",
    ],
    acceptanceCriteria: [
      "`grep -E '^(multiple-versions|wildcards) = \"deny\"' deny.toml` returns both lines.",
      "`cargo deny check bans` exits 0 on `main` after the change.",
      "Every `skip` entry in `deny.toml` has a `# reason:` comment on the immediately preceding line.",
      "`node scripts/verify-deny-strict.mjs` exits 0.",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo deny check bans",
      },
      {
        type: "command",
        value: "direnv exec . node scripts/verify-deny-strict.mjs",
      },
    ],
    auditFocus: [
      "`skip` entries must not absorb arbitrary duplicate pairs; each must have a documented reason.",
      '`bans.wildcards = "deny"` must catch `version = "*"` slips at the next dependency add.',
      "Strictness flip must not regress an existing crate transitively (audit the diff).",
    ],
  },
  {
    id: "capability_kaifuu_209",
    title: "run_golden_patch_phase signature refactor to GoldenPatchPhaseArgs struct",
    status: "planned",
    priority: "P2",
    target: "continuous",
    projects: ["kaifuu"],
    parallelGroup: "kaifuu-core",
    dependsOn: [],
    summary:
      "Replace the eleven-parameter signature of `run_golden_patch_phase` (crates/kaifuu-core/src/lib.rs:15758) with a single `GoldenPatchPhaseArgs` struct, removing the `#[allow(clippy::too_many_arguments)]` attribute and letting clippy enforce the boundary going forward.",
    deliverables: [
      "New `GoldenPatchPhaseArgs` struct in `crates/kaifuu-core/src/lib.rs` carrying the eleven prior positional parameters as named fields.",
      "Refactored `run_golden_patch_phase` accepting `GoldenPatchPhaseArgs` by value.",
      "All call sites updated to struct-literal form.",
      "Removal of the `#[allow(clippy::too_many_arguments)]` attribute at line 15758.",
    ],
    acceptanceCriteria: [
      "`rg 'clippy::too_many_arguments' crates/kaifuu-core/src/lib.rs` returns zero matches.",
      "`cargo clippy -p kaifuu-core --tests -- -D warnings` succeeds.",
      "All call sites of `run_golden_patch_phase` use the `GoldenPatchPhaseArgs { ... }` struct-literal form (grep verifies).",
      "`cargo test -p kaifuu-core` passes deterministically (no behavioural regression).",
    ],
    verification: [
      {
        type: "command",
        value: "direnv exec . cargo clippy -p kaifuu-core --tests -- -D warnings",
      },
      {
        type: "command",
        value: "direnv exec . cargo test -p kaifuu-core",
      },
    ],
    auditFocus: [
      "Field order in the struct should match a documented grouping (input vs output vs context), not the prior positional order.",
      "Struct must derive `Debug` so trace logs remain informative.",
      "No clippy `too_many_arguments` re-allow may be reintroduced elsewhere in the crate as a workaround.",
    ],
  },
];
