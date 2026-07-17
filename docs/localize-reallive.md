# Localizing a RealLive game (getting-started runbook)

This is the end-to-end runbook for a **fresh technical-user agent** — an
external contributor who coordinates through GitHub issues + PRs — to localize a
RealLive game (the reference vertical is **Sweetie HD**, オシオキSweetie＋Sweets!!
HD_DL版) with the shipped Itotori CLI. It maps the exact command flow, names
every flag/env var, and calls out the traps you would otherwise re-derive.

RealLive is the first real-engine vertical. Everything below is verified against
the code, not aspirational: extract + `xor_2` decrypt, 100%-zero-unknown decode,
byte-correct length-changing patchback, live-LLM drafting, and an E2 replay/render
runtime all work on real Sweetie HD bytes.

> **You are not expected to produce a perfect localization on the first run.**
> Engine/coverage gaps are your _workload_. The pipeline is built to fail LOUD
> with triage signal (structured per-stage diagnostics, unknown-opcode
> histograms, `refused:` errors) rather than lie green. When something breaks,
> file a GitHub issue and fix it generically — see
> [Parallel localizer conventions](#parallel-localizer-conventions).

---

## 0. TL;DR command flow

The pipeline is a **multi-command sequence** — each stage is one `itotori`
command that produces the artifact the next stage consumes. There is no longer a
single `localize-game` umbrella command; run the stages in order.

```sh
# one-time onboarding
itotori init                       # OpenRouter key + ZDR + DB + config; prints NEXT STEPS
just doctor                        # preflight: kaifuu/utsushi bins, Postgres, Chromium
just provision-native-deps         # obtain anything doctor reports missing (add --dry-run to preview)
itotori db-migrate                 # apply DB schema (needs DATABASE_URL)

# --- the localization pipeline (each stage feeds the next) -------------------
# Source roots below may be the game root (the dir that DIRECTLY contains
# REALLIVEDATA/) OR a staging parent that wraps it; the extract resolver descends
# into a nested game folder the same way either way.

GAME_ROOT="/scratch/itotori-research/sweetie-hd/min-root/オシオキSweetie＋Sweets!! HD_DL版"
RUN_DIR=/scratch/out/sweetie-hd-run
TARGET=/scratch/out/sweetie-hd-en

# 1. extract  — unpack Seen.txt (+ auto xor_2 decrypt) into a v0.2 BridgeBundle
itotori extract --whole-seen \
  --engine reallive --game-root "$GAME_ROOT" \
  --game-id sweetie-hd --game-version alpha-1 \
  --source-profile-id reallive-sweetie-hd --source-locale ja-JP \
  --bundle-output "$RUN_DIR/bridge.json"

# 2. structure-export  — emit the narrative-structure JSON (scenes/routes/speakers)
itotori structure-export \
  --gameexe "$GAME_ROOT/REALLIVEDATA/Gameexe.ini" \
  --seen     "$GAME_ROOT/REALLIVEDATA/Seen.txt" \
  --bridge   "$RUN_DIR/bridge.json" \
  --output   "$RUN_DIR/structure.json"

# 3. wiki build  — assemble the source-language bible the drafter consults
#    (REQUIRED for --run-mode production|pilot; the run-policy resolver rejects
#    a wiki-less production/pilot run. Only test-dev permits --ablation to skip it.)
itotori wiki build \
  --structure "$RUN_DIR/structure.json" --bridge "$RUN_DIR/bridge.json" \
  --source-locale ja-JP --run-mode production

# 4. localize  — drive the whole-project drafter + QA loop to a finalized result
itotori localize \
  --run-mode production \
  --structure   "$RUN_DIR/structure.json" \
  --bridge      "$RUN_DIR/bridge.json" \
  --output-scope dialogue-only \
  --output      "$RUN_DIR/run-summary.json"

# 5. patch  — apply the byte-correct length-changing patchback to a writable target
itotori patch \
  --source "$GAME_ROOT" --target "$TARGET" \
  --bundle "$RUN_DIR/run-summary.json" --scope dialogue-only

# 6. validate  — replay + render the patched Seen.txt against the real VM
itotori validate \
  --seen "$TARGET/REALLIVEDATA/Seen.txt" --scene 1 \
  --gameexe "$TARGET/REALLIVEDATA/Gameexe.ini" --game-dir "$TARGET/REALLIVEDATA" \
  --replay-log "$RUN_DIR/replay.json" \
  --artifact-root "$RUN_DIR/render" --render-output "$RUN_DIR/render/report.json"
```

> **Flag provenance.** Every flag above is verified against the parser in
> `apps/itotori/src/cli-handlers.ts` (extract / structure-export / patch /
> validate) and `apps/itotori/src/cli/{localize,wiki}-command.ts`. Do not invent
> flags; if a flag is not in the parser, the command refuses with `refused:` or
> `missing required flag`. Run `itotori --help` for the authoritative surface.

---

## 1. Onboarding

### 1.1 `itotori init`

`itotori init` is the guided setup. It writes `~/.config/itotori/config.env`
(mode `0600`), never prints your key, walks you through the OpenRouter key + the
account-wide ZDR assertion + the database footprint, and ends by printing
**NEXT STEPS** (add `ITOTORI_LOCAL_ENV_FILE` to your shell profile → run
`itotori db-migrate` → run the multi-command localize flow: `extract` →
`structure-export` → `wiki build` → `localize` → `patch` → `validate`). If ZDR
is not confirmed it prints a WARNING that live runs will fail until you
configure it.

### 1.2 Native-dependency preflight

Itotori drives but does not bundle four native deps: the `kaifuu-cli` /
`utsushi-cli` Rust binaries, Node, Postgres, and Chromium (render/browser
gates). Provision them deterministically:

```sh
just doctor                  # resolves each dep in a fixed order, reports what's missing
just provision-native-deps   # builds the Rust bins (release), installs pinned Chromium, brings up Postgres
```

Resolution order for the Rust bins (first hit wins): `ITOTORI_KAIFUU_BIN` /
`ITOTORI_UTSUSHI_BIN` → `ITOTORI_LIBEXEC_DIR/<bin>` → `CARGO_TARGET_DIR/{release,debug}` →
`<repo>/target/{release,debug}` → `<bin>` on `PATH`. Full reference:
[`docs/native-deps-provisioning.md`](native-deps-provisioning.md).

### 1.3 Setup prerequisites (a live draft FAILS LOUD without these)

- **Postgres** — `DATABASE_URL` (or `docker-compose.yml` via `just db-up`), then
  `itotori db-migrate`.
- **OpenRouter key + ZDR** — `OPENROUTER_API_KEY` **and**
  `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`. The live path calls
  `assertOpenRouterZdrAccount(process.env)` **before any game byte leaves the
  process** (wired through the composition-root localize entrypoint in
  `apps/itotori/src/composition/localize-entrypoint.ts`), and the OpenRouter
  provider throws `OpenRouterMissingApiKeyError` at construction if the key is
  absent. There is **no** silent fallback to a fake/recorded provider —
  `FakeModelProvider` is deliberately purged from the providers barrel. If you
  run without a key you get a loud error, not a fake green.

---

## 2. The multi-command pipeline

Each stage is one user-facing `itotori` command. Run them in order; the artifact
one stage writes is the input the next stage reads. The kept handlers live in
`apps/itotori/src/cli/localize-command.ts` and `apps/itotori/src/cli/wiki-command.ts`
plus the inline handlers in `apps/itotori/src/cli-handlers.ts`
(`runExtract`, `runStructureExportHandler`, `runPatchCommand`,
`runValidateCommand`).

### 2.1 Per-command flags (verified against the parsers)

#### `itotori extract` — BridgeBundle producer

Required: `--game-id`, `--game-version`, `--source-profile-id`,
`--source-locale`, `--bundle-output <PATH>`, plus exactly one of `--whole-seen`
or `--scene <N>`.

Optional: `--engine reallive` (default; only `reallive` is wired),
`--game-root <PATH>` (raw extract source root; falls back to
`ITOTORI_REAL_GAME_ROOT`), `--vault-canonical-id <ID>` (source by-id through the
read-only vault), `--decompile-report-output <PATH>`.

#### `itotori structure-export` — narrative-structure producer

Required: `--gameexe <PATH>`, `--seen <PATH>`, `--output <PATH>`.

Optional: `--bridge <PATH>` (enables the evidence-complete v2 structure),
`--entry-scene <N>` (override the `SEEN_START` entry scene — gotcha: the
structure keys off the entry scene; if the structure comes back thin, set this
to the game's real entry scene, which is not always `1`),
`--max-scenes <N>` (fail when the archive exceeds N scenes).

#### `itotori wiki build` — source-language bible assembler

Required: `--structure <PATH>`, `--bridge <PATH>`, `--source-locale <LOC>`,
`--run-mode production|pilot|test-dev`.

Optional: `--concurrency <N>` (default `4`), `--roles <a,b,…>` (bounded /
targeted analyst run; unset = full roster), `--portrait-sources <PATH>`,
`--output <PATH>`.

> The wiki-first bible is **required** by the run-policy for `production` and
> `pilot` (`apps/itotori/src/run-policy/mode-profiles.ts`:
> `requiresWikiFirstBible: true`). Only `test-dev` permits skipping it via the
> `--ablation` selector on `localize`.

#### `itotori localize` — whole-project drafter + QA driver

Required: `--run-mode production|pilot|test-dev`, `--structure <PATH>`,
`--bridge <PATH>`.

Optional: `--context-scope <scope>` (default `whole-game`; also
`external-augmented` or `narrowed:<…>`), `--output-scope <scope>` (default
`dialogue-only`; also `dialogue-and-choices`, …),
`--whole-scene-max-units <N>`, `--ablation` (pure-MTL baseline; `test-dev`
only), `--output <PATH>` (else the run summary is printed to stdout).

> **Known dispatcher quirk (being removed).** The `runLocalize` wrapper in
> `cli-handlers.ts` still calls `requiredFlag(args, "--config")` BEFORE
> delegating to `runLocalizeCommand`, even though the kept localize command no
> longer reads `--config`. Until that wrapper check is removed, pass
> `--config <any-path>` to satisfy the dispatcher (the value is ignored). The
> authoritative required flags are the ones above; `--config` is **not** part of
> the new pipeline.

#### `itotori patch` — byte-correct patchback

Required: `--source <PATH>` (read-only game tree), `--target <PATH>` (writable
output root, must be OUTSIDE `--source`), `--bundle <PATH>`,
`--scope dialogue-only|dialogue+choices`.

Optional: `--force`.

#### `itotori validate` — replay + render

Required: `--seen <PATH>`, `--scene <N>`, `--replay-log <PATH>`,
`--gameexe <PATH>`, `--game-dir <PATH>`, `--artifact-root <PATH>`,
`--render-output <PATH>`.

Optional: `--redaction on|off` (default `on`; `off` is for authorized local
review), `--print-textlines`, `--source-seen <PATH>`, `--bg-asset <PATH>`,
`--private-artifact-root <PATH>`, `--run-id <ID>`, `--expect-text-contains <S>`,
`--width <N>`, `--height <N>`.

### 2.2 Where the Sweetie HD parameters come from (don't guess)

The exact identity params and the environment a real run needs are documented by
the env-gated proof test **`apps/itotori/test/localize-real.test.ts`** (see its
header, lines 10-20). Copy-paste templates:

- **Stage-1 output shape**: the env-gated proof test is the concrete example of
  how stage-1 artifacts are produced and asserted (no committed real-run tree is
  kept in-repo — real live output stays out by the ZDR / no-game-bytes policy).
- **The corpus game root** (read-only; the dir that directly contains
  `REALLIVEDATA/`):
  `"/scratch/itotori-research/sweetie-hd/min-root/オシオキSweetie＋Sweets!! HD_DL版"`.
  A parent staging path such as `…/min-root` also works as `--game-root` on
  `extract` — the resolver descends into the nested game folder; pointing at the
  game root directly just skips the descent.

**`xor_2` decryption is automatic.** Sweetie HD's scene bytecode carries a
second-level per-game XOR over a bounded `[256, 513)` segment; the
`kaifuu-reallive` decoder detects and reverses it in-process
(`reallive-xor2-sukara-decryptor`). You do not supply a key.

### 2.3 Running the env-gated real vertical directly

If you want to drive the real-bytes acceptance test rather than the CLI, export
the `ITOTORI_CLI_REAL_LOCALIZE_*` vars (from the test header) and run it — it is
`it.skipIf(gated)` so it SKIPS LOUD (never fake-passes) when the vars are unset:

```sh
export ITOTORI_CLI_REAL_LOCALIZE_SOURCE="/scratch/itotori-research/sweetie-hd/min-root/オシオキSweetie＋Sweets!! HD_DL版"
export ITOTORI_CLI_REAL_LOCALIZE_GAME_ID=sweetie-hd
export ITOTORI_CLI_REAL_LOCALIZE_GAME_VERSION=alpha-1
export ITOTORI_CLI_REAL_LOCALIZE_SOURCE_PROFILE_ID=reallive-sweetie-hd
export ITOTORI_CLI_REAL_LOCALIZE_SOURCE_LOCALE=ja-JP
export ITOTORI_CLI_REAL_LOCALIZE_SCENE=1            # optional, default "1"
# plus OPENROUTER_API_KEY + OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 + DATABASE_URL
```

---

## 3. Stage chain (what each stage does + its CLI subcommand)

The multi-command pipeline runs each of these in turn; the individual
subcommands below let you reproduce a failure in isolation.

| #   | Stage                            | What happens on real bytes                                                                                                                                                                                                    | Subcommand                                                               |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **Extract + decrypt**            | Unpacks the whole `Seen.txt`, reverses Sweetie HD `xor_2`, emits one v0.2 `BridgeBundle`.                                                                                                                                     | `itotori extract --whole-seen`                                           |
| 2   | **Decode / decompile**           | Every populated scene decodes to typed `BytecodeElement`s — **0 unknown opcodes** on Sweetie HD + Kanon. Any unrecognised `(module_type, module_id, opcode)` is emitted as a histogram (your triage signal).                  | part of extract / `kaifuu-reallive`                                      |
| 3   | **Structure context**            | Deterministic `utsushi.narrative-structure.v1` (scenes/routes/speakers/choices) the drafter consumes as per-unit context.                                                                                                     | `itotori structure-export`                                               |
| 4   | **Source-language bible**        | Wiki-first bible assembled over the structure (A1-A10 analyst waves), the cumulative glossary/style/character context the drafter consults.                                                                                   | `itotori wiki build`                                                     |
| 5   | **Live-LLM draft**               | Every in-scope unit drafted against **live OpenRouter** with the pinned pair + structure-informed context.                                                                                                                    | `itotori localize`                                                       |
| 6   | **Deterministic QA**             | Protected-span integrity, Shift-JIS validity, length/overflow, bracket/markup balance — run on the REAL draft. Findings remain attached to the written result as quality annotations.                                         | (in the localize driver)                                                 |
| 7   | **Agentic self-correct**         | Bounded repair loop: call → deterministic checks → 4 live QA judges → bounded re-QA. Cost-bounded, no unbounded recursion.                                                                                                    | (in the localize driver)                                                 |
| 8   | **Written-outcome finalization** | Every in-scope unit receives a non-blank selected result. QA findings and any remaining quality flags travel with that result; they do not withhold a complete patch.                                                         | (in the localize driver)                                                 |
| 9   | **Patchback**                    | Length-CHANGING byte-correct patch: rewrites the 10,000-slot offset table and recalcs every goto-family jump pointer. A jump landing inside an edited body fails loud (`kaifuu.reallive.patchback_goto_target_unresolvable`). | `itotori patch`                                                          |
| 10  | **Replay-validate**              | Replays the patched `Seen.txt` and emits the engine's ACTUALLY-decoded `TextLine` bodies (no planted sentinel).                                                                                                               | `utsushi-cli replay-validate --engine reallive` (via `itotori validate`) |
| 11  | **Render-validate**              | Rasterizes the message stream to a frame (real VM + `render_pipeline.rs` + swash) at evidence tier **E2**; optional `--expect-text-contains` assertion.                                                                       | `utsushi-cli render-validate --engine reallive` (via `itotori validate`) |

Verified subcommand surfaces:

```
itotori extract       --whole-seen --engine reallive --game-root <ro> --game-id <id> --game-version <v> \
                      --source-profile-id <p> --source-locale <loc> --bundle-output <bridge.json>
itotori structure-export --gameexe <PATH> --seen <PATH> --output <structure.json> [--bridge <bridge.json>] [--entry-scene <N>] [--max-scenes <N>]
itotori wiki build    --structure <structure.json> --bridge <bridge.json> --source-locale <locale> --run-mode <mode>
itotori localize      --run-mode <mode> --structure <structure.json> --bridge <bridge.json> [--output-scope <scope>] [--output <run.json>]
itotori patch         --engine reallive --bundle <translated.json> --source <ro> --target <rw> --scope dialogue-only|dialogue+choices
itotori validate      --seen <PATH> --scene <N> --gameexe <PATH> --game-dir <DIR> --replay-log <PATH> \
                      --artifact-root <DIR> --render-output <PATH> [--redaction on|off] [--expect-text-contains <SUBSTR>] [--width <N>] [--height <N>]
```

The `validate replay` step also requires `--gameexe` and (under the hood)
`--g00-dir` (derived from `--game-dir`). Its historical `--snapshot-output`
flag is rejected explicitly: replay validation self-verifies snapshot identity
inside the EnginePort lifecycle but does not publish a snapshot JSON artifact.

`itotori --help` lists the user surface; `itotori help --all` adds the advanced
stage commands.

---

## 4. Honest signposts (read before you trust a green result)

### Note: `--source` / `--game-root` descends into a nested game dir

`--game-root` (on `extract`) and `--source` (on `patch`) may be the game root
(the dir that DIRECTLY contains `REALLIVEDATA/`) **or** a staging parent that
wraps a nested game folder. The extract resolver descends a bounded
single-child chain to the folder that holds `REALLIVEDATA/`. So a path at the
staging parent resolves the same way as the game root — the earlier "passes
extract, fails structure" footgun is gone.

For Sweetie HD either of these works:

```sh
# the game root directly (skips the descent):
"/scratch/itotori-research/sweetie-hd/min-root/オシオキSweetie＋Sweets!! HD_DL版"
# or the staging parent (the resolver descends into the nested game folder):
"/scratch/itotori-research/sweetie-hd/min-root"
```

(quote it — the game folder name has a space and non-ASCII.) When a `--source`
genuinely has no `REALLIVEDATA/` anywhere in the descent bound, the extract
stage fails loud on the missing `REALLIVEDATA/…` path. A title with the classic
pre-`REALLIVEDATA/` layout (asset files directly in the root, e.g. old Kanon) is
not supported by the extract stage — and therefore not by the rest of the
pipeline either — so this is a real, aligned limit.

### Trap: `FIXTURE-ALPHA` artifacts are NOT live output

The committed artifacts under `artifacts/localize-project/*-fixture-alpha/` are
**fixture runs**, not real localizations. Their `run-summary.json` carries
`"enUsSentinel": "FIXTURE-ALPHA-EN-US-SENTINEL"`, `patch-report.finalDraftText:
null`, and no `provider-runs/` directory. Do not read them as proof that a live
localization succeeded. Real live output is kept OUT of the repo by the ZDR /
no-game-bytes privacy policy (ADR-0002) — real proof lives in your run directory
and in `docs/openrouter-integration-evidence/*.json` (real provider-call
records with redacted auth + real `usage.cost`).

### Trap: CI-green ≠ real-bytes-green

Per-gate CI (`just ci`) is **synthetic-only** and touches no real bytes. All the
RealLive real-bytes proofs are `#[ignore]`/env-gated and DO NOT run in `just ci`.
A green `just ci` says nothing about real Sweetie HD bytes. To actually exercise
real bytes:

```sh
# points the gated suites at the real corpora and refuses to pass with zero coverage
just ci-real-bytes
# or the full periodic ground-truth oracle (~30-45 min; nightly / on-demand)
just real-bytes-oracle
```

`ci-real-bytes` defaults `ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd`
and `ITOTORI_REAL_GAME_ROOT_2=/scratch/itotori-research/kanon` (override to point
elsewhere) and **hard-fails if a corpus directory is missing** — it will not go
green on skipped real bytes. The gated Rust suites it runs include
`kaifuu-reallive` (`multi_corpus_real_bytes.rs` = the 100%-zero-unknown gate +
per-corpus coverage report; `patchback_real_bytes.rs`,
`patchback_kidoku_roundtrip_real_bytes.rs`) and `utsushi-reallive`.

Do NOT ask a subagent to run `just real-bytes-oracle` inline — it is the long
(~30-45 min) lane. Run it deliberately, in the background, when you need
ground-truth.

### Trap: the pipeline is multi-command now (no `localize-game` umbrella)

The retired `itotori localize-game --config <preset>` umbrella composed every
stage into one command. That command (and its `localize-fullproject` preset) was
**removed** — there is no single-command whole-game vertical any more. Run the
six stages in §0 explicitly. The older bounded `just localize-project` driver
(`suite/scripts/localize-project/run.mjs`) chains the four binary stages for
stage-level debugging only; it is not the recommended path and does not wire
the wiki-first bible into the drafter.

### Other gotchas you would otherwise re-derive

- **`patch --target` must be outside `--source`.** The patcher refuses to write
  inside the source tree, and the source `Seen.txt` is sha256-checked before AND
  after the run — any drift fails the command.
- **Render fidelity is E2, not E4.** The RealLive runtime is a real VM +
  rasterizer, but its render evidence tier is E2 (frame capture / decoded text),
  not engine-faithful E4. Pixel-exact clipping/fit against the retail renderer
  is the main genuinely-incomplete area — treat E2 evidence as "observed
  rendered text", not "fully verified fidelity", exactly as the fidelity policy
  labels it (`docs/utsushi-fidelity-policy.md`).
- **Unknown-opcode triage.** If a NEW (non-Sweetie/Kanon) title surfaces unknown
  opcodes, the coverage report names each `(module_type, module_id, opcode)`
  with a frequency — start your fix there.

---

## 5. Reviewing results & taking the patched game

Each stage writes into your run directory: the extracted bridge bundle
(`extract`), the narrative structure (`structure-export`), the drafts and QA
findings (`localize`), the patch report (`patch`), and the replay log + render
evidence (`validate`). On success `localize` prints a JSON summary
(`runMode`, `contextScope`, `outputScope`, `shippable`, `sceneCount`,
`finalizedUnitCount`, `patchId`, `buildLqaVerdictCount`, `attemptCount`). The
patched, playable game lands in `patch --target`. The Studio dashboard
(`apps/itotori/`, see [`docs/frontend.md`](frontend.md)) is the browsable review
surface.

---

## Parallel localizer conventions

Multiple localizer agents may run concurrently on **different** games. To keep
them from colliding and to keep fixes generic:

- **One worktree per agent, OUTSIDE the repo, in a protected namespace.** Create
  it under `/scratch/worktrees/<game>-<slug>` (e.g.
  `/scratch/worktrees/sweetie-hd-choices`). Never point two agents at one
  worktree; never share a worktree path across live agents. The `sweetie-hd-real-*`
  worktrees are long-lived — do not prune them in reconciles.
- **Isolated build cache is automatic.** The nix devShell (`flake.nix`) gives
  each worktree its own `CARGO_TARGET_DIR`, so parallel `cargo` builds do not
  contaminate each other. Enter it via direnv / `nix develop`. Run
  `just worktree-setup` once after `cd`-ing into a new worktree (offline pnpm
  install from the shared store).
- **Coordinate through GitHub, not a shared ledger.** File a GitHub **issue**
  for each blocker bug (with the loud diagnostic / unknown-opcode signature /
  failing stage). Claim work via **assignee + label** so two agents don't fix
  the same bug. This localizer track does NOT use qdcli — issues + PRs are the
  coordination surface.
- **Fix GENERICALLY, never per-game.** A bug found while localizing Sweetie HD
  must be fixed game-agnostically (engine-family behavior, not a
  `if game == "sweetie-hd"` hack). Multi-game validation is a standing invariant:
  engine-family specs validate against ≥ 2 real games.
- **Propose, don't dispose.** Open a PR against `main` with a clear title and the
  reproducing diagnostic. **Do NOT self-merge** — the orchestrator is the sole
  merge authority. You may split a large bug into smaller independently-verifiable
  PRs (optionally using your own subagents/shell-agents), but each lands only
  when the orchestrator merges it.
- **Keep the main checkout clean.** All work happens in your worktree; never
  dirty `/home/trevor/projects/itotori` directly.

---

## Reference

- Install + developer paths: [`docs/install.md`](install.md)
- Security posture / ZDR fail-closed: [`docs/security-and-limitations.md`](security-and-limitations.md)
- Native deps: [`docs/native-deps-provisioning.md`](native-deps-provisioning.md)
- RealLive adapter readiness: [`docs/kaifuu-adapters/reallive.md`](kaifuu-adapters/reallive.md)
- Utsushi fidelity tiers: [`docs/utsushi-fidelity-policy.md`](utsushi-fidelity-policy.md)
- Real-bytes oracle cadence: [`docs/real-bytes-periodic-oracle.md`](real-bytes-periodic-oracle.md)
- Product workflow: [`docs/itotori-product-workflow.md`](itotori-product-workflow.md)
