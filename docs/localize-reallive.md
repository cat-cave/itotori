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

```sh
# one-time onboarding
itotori init                       # OpenRouter key + ZDR + DB + config; prints NEXT STEPS
just doctor                        # preflight: kaifuu/utsushi bins, Postgres, Chromium
just provision-native-deps         # obtain anything doctor reports missing (add --dry-run to preview)
itotori db-migrate                 # apply DB schema (needs DATABASE_URL)

# localize the whole game in one command (extract -> structure -> localize -> patch -> validate)
itotori localize-game \
  --config      <project-config.json> \
  --source      /scratch/itotori-research/sweetie-hd \
  --target      /scratch/out/sweetie-hd-en \
  --run-dir     /scratch/out/sweetie-hd-run \
  --game-id     sweetie-hd --game-version alpha-1 \
  --source-profile-id reallive-sweetie-hd --source-locale ja-JP \
  --scene       1
```

Prefer this **one** command over the older `just localize-project` driver — see
[localize-game vs localize-project](#trap-localize-game-vs-localize-project).

---

## 1. Onboarding

### 1.1 `itotori init`

`itotori init` is the guided setup. It writes `~/.config/itotori/config.env`
(mode `0600`), never prints your key, walks you through the OpenRouter key + the
account-wide ZDR assertion + the database footprint, and ends by printing
**NEXT STEPS** (add `ITOTORI_LOCAL_ENV_FILE` to your shell profile → run
`itotori db-migrate` → run `itotori localize-game --help`). If ZDR is not
confirmed it prints a WARNING that live runs will fail until you configure it.

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
  process** (`apps/itotori/src/orchestrator/localize-fullproject-cli.ts`), and
  the OpenRouter provider throws `OpenRouterMissingApiKeyError` at construction
  if the key is absent (`apps/itotori/src/providers/openrouter.ts`). There is
  **no** silent fallback to a fake/recorded provider — `FakeModelProvider` is
  deliberately purged from the providers barrel
  (`apps/itotori/src/providers/index.ts`). If you run without a key you get a
  loud error, not a fake green.

---

## 2. The one-command pipeline: `itotori localize-game`

`itotori localize-game` composes the five gated stages into one whole-game
vertical (`apps/itotori/src/orchestrator/localize-game-command.ts`). Every stage
seam binds to the production seam; a stage failure is surfaced on stderr as
`[localize-game] STAGE FAILED: stage=<name> …` and rethrown as a structured
pipeline diagnostic.

### 2.1 Flags (verified against `apps/itotori/src/cli-handlers.ts`)

Required:

| Flag                                               | Meaning                                                                                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <PATH>`                                  | Base localize-fullproject config (v0) JSON. Carries project/locale identity, `translationScope`, and `pairPolicyPath`. Its `bridgePath` / `structureJsonPath` are OVERRIDDEN by this run's fresh stage-1/stage-2 artifacts. |
| `--source <PATH>`                                  | Read-only source game root (contains `REALLIVEDATA/Seen.txt`). Never mutated.                                                                                                                                               |
| `--target <PATH>`                                  | Writable output root the byte-correct patched game lands in. Must be OUTSIDE `--source`.                                                                                                                                    |
| `--run-dir <PATH>`                                 | Per-run artifact directory (bridge bundle, structure, drafts, QA findings, patch report, replay log, render evidence).                                                                                                      |
| `--game-id <ID>` `--game-version <VER>`            | RealLive identity for the whole-Seen extract.                                                                                                                                                                               |
| `--source-profile-id <ID>` `--source-locale <LOC>` | Source profile + locale (e.g. `ja-JP`).                                                                                                                                                                                     |
| `--scene <N>`                                      | Scene the validate stage replays + renders.                                                                                                                                                                                 |

Optional:

| Flag                                 | Meaning                                                                                                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vault-canonical-id <ID>`          | Source by-id through the read-only vault instead of `--source`.                                                                                                                                                       |
| `--game-root <PATH>`                 | Raw extract source root (defaults to `--source`).                                                                                                                                                                     |
| `--gameexe <PATH>` / `--seen <PATH>` | Structure inputs (default `<source>/REALLIVEDATA/Gameexe.ini` + `Seen.txt`).                                                                                                                                          |
| `--entry-scene <N>`                  | Structure dispatch-order entry-scene override. **Gotcha:** the narrative-structure export keys off the entry scene; if the structure comes back thin, set this to the game's real entry scene (it is not always `1`). |
| `--expect-text <TEXT>`               | Localized text the render frame must contain (render assertion).                                                                                                                                                      |
| `--redaction on\|off`                | Render-frame redaction posture (default `on`; committed proof stays redacted, `off` is for authorized local review).                                                                                                  |
| `--cost-cap-usd <decimal>`           | Per-process OpenRouter budget cap.                                                                                                                                                                                    |

### 2.2 Where the Sweetie HD parameters come from (don't guess)

The exact identity params and the environment a real run needs are documented by
the env-gated proof test **`apps/itotori/test/localize-game-real.test.ts`** (see
its header, lines 10-20). Copy-paste templates:

- **Config + pair-policy**: `presets/localize-project.alpha-target-data.json`
  and `presets/localize-project.pair-policy.json` (the `(modelId, providerId)`
  pair is pinned in the pair-policy — it is REQUIRED; a missing/malformed
  pair-policy halts the run).
- **Prior real runs**: `artifacts/localize-sweetie-hd/*` holds ten timestamped
  `sweetie-hd-alpha-1` runs whose `bridge-bundle.json` is a concrete example of
  the stage-1 output shape.
- **The corpus itself**: `/scratch/itotori-research/sweetie-hd` (read-only).

**`xor_2` decryption is automatic.** Sweetie HD's scene bytecode carries a
second-level per-game XOR over a bounded `[256, 513)` segment; the
`kaifuu-reallive` decoder detects and reverses it in-process
(`reallive-xor2-sukara-decryptor`). You do not supply a key.

### 2.3 Running the env-gated real vertical directly

If you want to drive the real-bytes acceptance test rather than the CLI, export
the `ITOTORI_CLI_REAL_LGAME_*` vars (from the test header) and run it — it is
`it.skipIf(gated)` so it SKIPS LOUD (never fake-passes) when the vars are unset:

```sh
export ITOTORI_CLI_REAL_LGAME_CONFIG=presets/localize-project.alpha-target-data.json
export ITOTORI_CLI_REAL_LGAME_SOURCE=/scratch/itotori-research/sweetie-hd
export ITOTORI_CLI_REAL_LGAME_GAME_ID=sweetie-hd
export ITOTORI_CLI_REAL_LGAME_GAME_VERSION=alpha-1
export ITOTORI_CLI_REAL_LGAME_SOURCE_PROFILE_ID=reallive-sweetie-hd
export ITOTORI_CLI_REAL_LGAME_SOURCE_LOCALE=ja-JP
export ITOTORI_CLI_REAL_LGAME_SCENE=1            # optional, default "1"
# plus OPENROUTER_API_KEY + OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 + DATABASE_URL
```

---

## 3. Stage chain (what each stage does + its CLI subcommand)

`itotori localize-game` runs all of these for you; the individual subcommands
below let you run a single stage or reproduce a failure in isolation.

| #   | Stage                    | What happens on real bytes                                                                                                                                                                                                    | Subcommand                                                               |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **Extract + decrypt**    | Unpacks the whole `Seen.txt`, reverses Sweetie HD `xor_2`, emits one v0.2 `BridgeBundle`.                                                                                                                                     | `kaifuu-cli extract --engine reallive` (via `itotori extract`)           |
| 2   | **Decode / decompile**   | Every populated scene decodes to typed `BytecodeElement`s — **0 unknown opcodes** on Sweetie HD + Kanon. Any unrecognised `(module_type, module_id, opcode)` is emitted as a histogram (your triage signal).                  | part of extract / `kaifuu-reallive`                                      |
| 3   | **Structure context**    | Deterministic `utsushi.narrative-structure.v1` (scenes/routes/speakers/choices) the drafter consumes as per-unit context.                                                                                                     | `utsushi-cli structure` (via `itotori structure-export`)                 |
| 4   | **Live-LLM draft**       | Every in-scope unit drafted against **live OpenRouter** with the pinned pair + structure-informed context.                                                                                                                    | `itotori localize` / `localize-project-stage`                            |
| 5   | **Deterministic QA**     | Protected-span integrity, Shift-JIS validity, length/overflow, bracket/markup balance — run on the REAL draft, fail-closed.                                                                                                   | (in the localize driver)                                                 |
| 6   | **Agentic self-correct** | Bounded repair loop: call → deterministic checks → 4 live QA judges → route → bounded re-QA. Cost-bounded, no unbounded recursion.                                                                                            | (in the localize driver)                                                 |
| 7   | **Human review queue**   | Decisions needing judgment become real Postgres `reviewerQueueItems` (`needs_context` vs `ready_for_human`), browsable in the Studio dashboard.                                                                               | Studio dashboard / reviewer API                                          |
| 8   | **Patchback**            | Length-CHANGING byte-correct patch: rewrites the 10,000-slot offset table and recalcs every goto-family jump pointer. A jump landing inside an edited body fails loud (`kaifuu.reallive.patchback_goto_target_unresolvable`). | `kaifuu-cli patch --engine reallive` (via `itotori patch`)               |
| 9   | **Replay-validate**      | Replays the patched `Seen.txt` and emits the engine's ACTUALLY-decoded `TextLine` bodies (no planted sentinel).                                                                                                               | `utsushi-cli replay-validate --engine reallive` (via `itotori validate`) |
| 10  | **Render-validate**      | Rasterizes the message stream to a frame (real VM + `render_pipeline.rs` + swash) at evidence tier **E2**; optional `--expect-text-contains` assertion.                                                                       | `utsushi-cli render-validate --engine reallive` (via `itotori validate`) |

Verified subcommand surfaces:

```
kaifuu-cli extract  --engine reallive ...      kaifuu-cli patch --engine reallive --source <ro> --target <rw> --bundle <translated.json>
utsushi-cli replay-validate --engine reallive --seen <PATH> --scene <N> --print-replay-log <PATH> [--print-textlines] [--dispatch-report <PATH>] [--require-semantic-reached-path]
utsushi-cli render-validate --engine reallive --seen <PATH> --scene <N> --gameexe <PATH> --game-dir <DIR> --artifact-root <DIR> [--redaction on|off] [--expect-text-contains <SUBSTR>] [--width <N>] [--height <N>]
```

`itotori --help` lists the user surface; `itotori help --all` adds the advanced
stage commands.

---

## 4. Honest signposts (read before you trust a green result)

### Trap: `FIXTURE-ALPHA` artifacts are NOT live output

The committed artifacts under `artifacts/localize-project/*-fixture-alpha/` are
**fixture runs**, not real localizations. Their `run-summary.json` carries
`"enUsSentinel": "FIXTURE-ALPHA-EN-US-SENTINEL"`, `patch-report.finalDraftText:
null`, and no `provider-runs/` directory. Do not read them as proof that a live
localization succeeded. Real live output is kept OUT of the repo by the ZDR /
no-game-bytes privacy policy (ADR-0002) — real proof lives in your `--run-dir`
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

### Trap: `localize-game` vs `localize-project`

Use **`itotori localize-game`**. The older bounded `just localize-project`
driver (`suite/scripts/localize-project/run.mjs`) does NOT pass
`--structure-json` / glossary / style-guide to the agentic-loop stage, so it
runs the drafter with an **empty structure slice** (it degrades to empty rather
than erroring). `itotori localize-game` wires the fresh stage-2 structure export
into the drafter, so the model gets the known scene/route/speaker structure —
the core context advantage. `localize-project` remains useful for stage-level
debugging, but it is not the recommended whole-game path.

### Other gotchas you would otherwise re-derive

- **`--target` must be outside `--source`.** The driver refuses to write inside
  the source tree, and the source `Seen.txt` is sha256-checked before AND after
  the run — any drift fails the command.
- **Pair-policy is required and pinned.** The `(modelId, providerId)` pair is
  read from the pair-policy file, not defaulted. A missing entry for a
  stage/agent pair is a loud `agentic-loop refused:` error.
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

The run writes into `--run-dir`: the extracted bridge bundle, the narrative
structure, the drafts, the QA findings, the patch report, the replay log, and
the render evidence (screenshots). On success `localize-game` prints a JSON
summary (`acceptedDraftCount`, `totalUsageCostUsd`, `patchApplied`,
`replayLogPath`, `renderEvidencePath`). The patched, playable game lands in
`--target`. The Studio dashboard (`apps/itotori/`, see
[`docs/frontend.md`](frontend.md)) is the browsable review surface.

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
