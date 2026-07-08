# Repo-Wide Code Audit — 2026-06-26 (15-merge cadence)

**Scope.** Whole-repo cross-cutting audit covering the ~36-hour window
since `e6effb3` (KAIFUU-053 stale-claim release). The 15 merges in scope:
ITOTORI-233/038/081/236/237, KAIFUU-053/193/238, UTSUSHI-211/213/216/221/
214/147/212, plus the qdcli adoption commit (`63f59ce`) and the
fix-CI commit (`b7c0cfb`). Roughly 19,361 insertions and 959 deletions
across 83 files; the bulk landed in `crates/utsushi-reallive/` (the
RealLive substrate buildout: g00, syscall dispatcher, render pipeline,
RLOp families, graphics objects, siglus scaffold) and
`apps/itotori/src/` (cost-cap canonicalisation, repair skeleton,
reviewer-action service, telemetry-by-pair).

**Methodology.** Re-read `feedback_*` and `project_*` auto-memories;
read `justfile`, `.qd/config.toml`, `.qd/agents.md`, `.qd/skills/qd-dag/
SKILL.md`; ran ripgrep sweeps for the smells listed in the audit
charter (typed-vs-boxed errors, `unwrap()` density, secret-leak
vectors, doc drift, magic numbers, schema-version handlers, scratch-dir
read-write violations). Spot-read the biggest files
(`kaifuu-core/src/lib.rs` at 23,110 lines, `utsushi-reallive/src/
rlop/module_str.rs` at 1,758, `openrouter.ts` at 1,738,
`localization-bridge-schema/src/index.ts` at 7,053).

## Executive summary

- **One real cross-cutting tech-debt theme — boxed `KaifuuResult` /
  `UtsushiResult` are still alive at the core**, while every new
  engine-port crate (`kaifuu-reallive`, `utsushi-reallive`,
  `kaifuu-vault-source`, `utsushi-siglus`) uses `thiserror` typed
  errors. 77 sites use `Box<dyn std::error::Error>`. P2.
- **Documentation drift around the qdcli migration.** `qd` is now the
  orchestration ledger (per `.qd/config.toml`, `.qd/agents.md`, and
  `qd-dag` skill), but ZERO files under `docs/` mention `qd` — 51
  invocations of `node scripts/spec-dag.mjs ...` survive in
  `docs/dev/spec-dag.md`, `docs/dev/orchestration-operating-model.md`, and
  `docs/kaifuu-engine-playbook.md`. P2.
- **Two small doc-vs-code lies** introduced by ITOTORI-226 + ITOTORI-231:
  `openrouter.ts:1580` says the DEV_PAIR is `deepseek-v3.2-exp`, but
  ITOTORI-226 corrected it to `deepseek/deepseek-v4-flash` (verified
  via `dev-pair.ts:68`); `dev-pair.ts:34` says the cost cap is
  `$1.00`, but ITOTORI-231 set it to `0.5` (`openrouter.ts:1587`). P3.
- **Two parallel orchestration tools both live in `justfile` and
  `package.json` `scripts`** — `roadmap-validate / roadmap-ready /
roadmap-pop` (legacy `spec-dag.mjs`) and `qd-import` (qdcli). Neither
  is marked deprecated; nothing in code chooses. This is the
  no-legacy-compat memory: pick one, delete the other in the same
  change. P2.
- **One ergonomic surprise**: `crates/kaifuu-core/src/lib.rs` is 23,110
  lines (17,135 of production code + 5,975 of tests) and
  `crates/kaifuu-cli/src/main.rs` is 7,668 lines (1,943 production +
  5,725 tests). Nothing is broken; both compile and both pass tests,
  but maintenance velocity will suffer when the next big refactor lands
  unless the cores adopt the `src/<module>.rs` pattern the engine
  crates already use. P3.
- **Codebase is genuinely clean on the dimensions where a 15-merge wave
  usually accumulates rot** — zero production `unwrap()` in the new
  big files, zero `panic!()` outside `#[cfg(test)]`, zero secrets in
  logs, zero `as any`/`@ts-ignore` in production TS, zero hardcoded
  costs (guarded by `scripts/audit-no-hardcoded-cost.mjs`), zero
  `process.env` reads outside well-marked test gates and one
  `localize-sweetie-hd-stage-command.ts` zdr-downgrade env. No P0/P1
  findings.

## Findings

### F-001 — P2 — Core crates still use `Box<dyn std::error::Error>` while the engine ports use `thiserror`

- **Evidence.** `crates/kaifuu-core/src/lib.rs:21` declares
  `pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;`.
  `crates/utsushi-core/src/lib.rs:125` declares the symmetric
  `UtsushiResult<T>`. 77 sites of `Box<dyn std::error::Error>` across
  the workspace. Meanwhile the new engine-port crates (`utsushi-reallive`,
  `kaifuu-reallive`, `kaifuu-vault-source`) all consume `thiserror` per
  their Cargo.tomls and emit typed enums (`G00DecodeError`,
  `EnginePortError`, etc.). `kaifuu-core`, `utsushi-core`,
  `kaifuu-delta`, `kaifuu-engine-fixture`, `kaifuu-cli`, `utsushi-cli`,
  `utsushi-fixture`, `utsushi-siglus` do not depend on `thiserror`.
- **Why it matters.** New code can lose typed-error provenance the
  moment it crosses a boxed boundary. Audit-focus items that ask for
  "typed error class on failure" are routinely satisfiable in the
  port crates but become aspirational once they hit the core crate
  boundary.
- **Suggested fix.** Inventory the 77 sites. For each, decide whether
  the caller actually inspects the error class (in which case the box
  is hiding information and the call wants a typed enum) or whether it
  bubbles up unchanged (in which case `Box<dyn Error + Send + Sync>` is
  fine but the type alias should be removed and call sites should write
  the box out explicitly so the no-typed-error posture is grep-pinnable
  at every boundary). Mint as a tech-debt node, do not block real
  work behind it.
- **Suggested mint.** `SHARED-300` — "Replace `KaifuuResult` /
  `UtsushiResult` boxed-error aliases with typed enums or explicit
  boxing per call".

### F-002 — P2 — Docs reference deleted orchestration tooling (`spec-dag.mjs` instead of `qd`)

- **Evidence.** `rg -c "node scripts/spec-dag\\.mjs" docs/` returns 51
  hits across `docs/dev/spec-dag.md`, `docs/dev/orchestration-operating-model.md`,
  `docs/kaifuu-engine-playbook.md`, and several proposal docs.
  `rg -c "qd " docs/` returns 0 — no doc file even mentions the new
  ledger. Yet `.qd/config.toml`, `.qd/agents.md`, `.qd/skills/qd-dag/
SKILL.md`, and the commit `63f59ce: feat(qd): adopt qdcli as
orchestration ledger; import 639-node DAG` make qdcli the canonical
  surface. The `justfile` and `package.json scripts` still expose the
  legacy `roadmap-validate / roadmap-ready / roadmap-pop /
roadmap:issues / roadmap:ready / roadmap:test / roadmap:validate`
  recipes, so onboarding contributors who read docs first will run
  the wrong tool.
- **Why it matters.** A future contributor following the playbook will
  use `node scripts/spec-dag.mjs claim ...` and end up with a
  worktree path that does not register in qd; their work would be
  invisible to `qd ready`/`qd status`. The `feedback_no_legacy_compat`
  memory says "delete the old path in the same change as the new one
  — no shims, no `#[deprecated]`, no dual plumbing".
- **Suggested fix.** Either (a) demote `spec-dag.mjs` to a pure
  validator/exporter (keep only `validate` and `sync-issues`), drop
  the lifecycle commands (`claim`, `worktree`, `complete`,
  `ingest-audit`), drop the corresponding `justfile` recipes
  (`roadmap-pop`, `roadmap-ready` if redundant with qd), drop the
  `package.json` scripts, and rewrite `docs/dev/spec-dag.md` +
  `docs/dev/orchestration-operating-model.md` + the playbook to teach
  `qd` — or (b) explicitly document that the two surfaces co-exist
  during a transition window. Today neither path is chosen.
- **Suggested mint.** `ITOTORI-300` — "Adopt qdcli as the sole
  orchestration surface; delete `spec-dag.mjs` lifecycle commands and
  rewrite `docs/dev/spec-dag.md` + `docs/dev/orchestration-operating-model.md` +
  `kaifuu-engine-playbook.md` to teach `qd`".

### F-003 — P3 — Comment-level doc-vs-code lies (`DEV_PAIR` model id and cost cap)

- **Evidence.**
  1. `apps/itotori/src/providers/openrouter.ts:1580` says the DEV_PAIR
     is `(deepseek-v3.2-exp at fireworks)`. Truth: ITOTORI-226 corrected
     this to `deepseek/deepseek-v4-flash` and that's what `dev-pair.ts:68`
     declares as `modelId`. The comment was not updated when the slug
     was corrected.
  2. `apps/itotori/src/providers/dev-pair.ts:34` says the cost cap is
     `$1.00` ("the ITOTORI-231 DEFAULT_COST_CAP_USD ($1.00)"). Truth:
     `openrouter.ts:1587` exports `DEFAULT_COST_CAP_USD = 0.5`. The
     comment is from before ITOTORI-231 canonicalised to 0.5.
- **Why it matters.** These are exactly the comments a future
  contributor doing OpenRouter wiring will read first. They will form
  wrong mental models about which model id is "the dev pair" and
  what the cap actually buys.
- **Suggested fix.** Trivial one-line edits in two files. Optionally
  pin a CI guard: a tiny `audit-doc-strings.mjs` could check for the
  literal `"$1.00"` near `DEFAULT_COST_CAP_USD` and the literal
  `deepseek-v3.2-exp` anywhere outside `test/fixtures/recorded-bundles/`.
- **Suggested mint.** None — just fix in a chore-grade commit.

### F-004 — P3 — Dual orchestration recipes in `justfile` + `package.json scripts`

- **Evidence.** `justfile` still declares `roadmap-validate`,
  `roadmap-ready`, `roadmap-pop`, `roadmap-dashboard`,
  `roadmap-dashboard-watch` recipes (all wired to `scripts/spec-dag.mjs`).
  `package.json` still declares `roadmap:issues`, `roadmap:ready`,
  `roadmap:test`, `roadmap:validate` npm scripts. The new `qd-import`
  recipe was added in the same commit that introduced qdcli but no
  legacy recipe was deleted. This is the surface aspect of F-002.
- **Why it matters.** Same as F-002 — picks up muscle memory in the
  wrong direction.
- **Suggested fix.** Folded into F-002 (`ITOTORI-300`).

### F-005 — P3 — `crates/kaifuu-core/src/lib.rs` at 23,110 lines

- **Evidence.** `wc -l crates/kaifuu-core/src/lib.rs` is 23,110 (17,135
  production + 5,975 tests). 229 top-level `pub fn/struct/enum/trait/mod`
  declarations live in the same file. Compare:
  - `kaifuu-cli/src/main.rs`: 7,668 lines (1,943 production + 5,725
    tests).
  - `utsushi-reallive/src/rlop/module_str.rs`: 1,758 lines (1,266
    production + 492 tests).
  - `utsushi-reallive/src/lib.rs`: 550 lines.
    The engine-port crates have adopted the `src/<module>.rs` layout
    (e.g., `utsushi-reallive/src/rlop/{mod,module_str,module_mem,
module_sys,...}.rs`); the core crates have not.
- **Why it matters.** Compile time, IDE indexing, navigation, and
  "where does X live" questions all hurt. Not blocking and the file
  passes `cargo check`, `cargo fmt`, and clippy `-D warnings`, so it
  is genuinely a maintainability concern, not a correctness one.
- **Suggested fix.** Mint a decomposition node similar to
  `scripts/history/apply-utsushi-146-decomposition.mjs` (the precedent that
  split the giant utsushi-reallive blob). The natural cut points are
  the `SEMANTIC_*` constants (move to `semantic_codes.rs`), the
  `HelperRegistry*` types (move to `helper_registry/`), the
  `KeyMaterial*` flow (move to `key_material/`), and the
  bridge-bundle plumbing (move to `bridge_bundle.rs`). The 5,975-line
  embedded test module is also a candidate for `tests/` extraction.
- **Suggested mint.** `KAIFUU-300` — "Decompose `kaifuu-core/src/
lib.rs` (23,110 lines) into module files matching the engine-port
  pattern".

### F-006 — P3 — Mild dep-declaration shape inconsistency in Cargo.tomls

- **Evidence.** `kaifuu-core/Cargo.toml:tempfile.workspace = true` vs
  `kaifuu-cli/Cargo.toml:tempfile = { workspace = true }`. Same effect
  but different shape. Three other crates use the long form; rest use
  the short form. No technical issue.
- **Why it matters.** Cosmetic. Won't ever cause a bug.
- **Suggested fix.** Pick one form (short is canonical in
  `Cargo.toml`/`workspace.dependencies` ecosystems) and normalise once.
- **Suggested mint.** None.

## What's healthy

A 15-merge wave that lands ~20k LOC and surfaces only one P2 tech-debt
finding, one P2 doc-drift finding, and a handful of P3s is a notably
clean codebase. Specifically:

1. **Zero production `unwrap()` or `expect()` in the new big files**
   (g00.rs, syscall.rs, module_str/mem/sys/sel, graphics_objects,
   render_pipeline). The 567/226/174/106/106 unwrap counts ripgrep
   reports are 100% inside `#[cfg(test)]` modules or `///` doc
   examples — verified by `awk` cuts at the first `#[cfg(test)]`.
2. **Zero `panic!()` outside test modules** — every panic site in
   `g00.rs`, `syscall.rs`, `gameexe.rs`, `protected_spans.rs`,
   `opcode.rs` is past the cfg-test marker.
3. **Zero secret-leak vectors.** `Authorization: Bearer ${apiKey}`
   stays inside the fetch call; `providerExceptionMessage(error)`
   returns only `error.message`, which Node's undici does not populate
   with the Authorization header; no `console.log(...key...)`
   anywhere; `.env` is gitignored and the only `process.env` read in
   production code is `OPENROUTER_API_KEY` (via a typed accessor with
   `OpenRouterMissingApiKeyError`) and the documented
   `OPENROUTER_ZDR_DOWNGRADE` posture flag.
4. **Zero `as any` / `@ts-ignore` in production TS.** The `as unknown
as` casts are all either (a) in the `spec-dag-dashboard` client-side
   DOM-traversal code (legitimate type-narrowing across runtime
   boundaries), (b) at structured-output `as unknown as JsonObject`
   sites in the agent files (legitimate JSON-schema -> runtime shape
   coercion), or (c) in the in-process queue executor seam where the
   drizzle `DB` and `SqlExecutor` types differ.
5. **`scripts/audit-no-hardcoded-cost.mjs` is wired into `just check`.**
   The "no hardcoded model cost, no `unknown`/`provider_estimate`/
   `local_estimate` cost shape" rule is enforced mechanically.
6. **DEV_PAIR posture is exemplary.** `dev-pair.ts` carries a 65-line
   evidence-grounded comment block recording the OpenRouter catalog
   snapshot timestamp, the live HTTP-200 call that validated routing,
   the JSON-schema acceptance bit, and the ZDR allow-list rationale.
   Exactly the shape `feedback_no_optionality_evidence_first` asks for.
7. **The `utsushi-siglus` scaffold is a model for clean-room
   provenance.** Its `Cargo.toml` carries a structured
   `package.metadata.research-anchor` block; its `lib.rs` doc preface
   lays out the no-vendoring/no-derivation boundary precisely; the
   crate intentionally has no `siglus_rs` dep. Future engine ports
   should copy this template verbatim.
8. **DAG is healthy** — 674 nodes total, 236 done, 433 ready, 3
   claimed (all claimed within the last 8 hours; not stale), 0 open
   P0/P1 findings (per `qd status --json`).
9. **`#[ignore]` + env-gate pattern is consistent** across all
   real-bytes tests (`ITOTORI_REAL_GAME_ROOT` is the single
   variable; the unset-env error message is identical across all 11
   real-bytes test files I sampled).
10. **No CI parity gaps observed.** Every env-gated test path I
    sampled is documented either in `feedback_ci_parity_before_push`
    or in the `#[ignore]`-test's preamble; `just ci` is the single
    canonical gate; the recent CI fix for the 7z fixture (KAIFUU-236)
    - the catalog-schema-unsupported ignore (KAIFUU-237) were both
      minted as DAG nodes, not silently `#[ignore]`d.

## Counted findings

- P0: 0
- P1: 0
- P2: 2 (F-001 boxed-errors, F-002 qd-doc-drift)
- P3: 4 (F-003 comment-lies, F-004 dual-recipes, F-005 lib.rs-size,
  F-006 cargo-shape)

## Mintable nodes

Three mints proposed in `code-audit-2026-06-26-mints.json`:
`ITOTORI-300` (P2), `SHARED-300` (P2), `KAIFUU-300` (P3).

The other findings (F-003, F-004, F-006) are trivial enough to fold
into a chore commit; minting them as DAG nodes would be ceremony.
