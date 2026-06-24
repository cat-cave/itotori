# Alpha Localization Project Readiness

> **Alpha milestone redefinition (approved 2026-06-24):** The previous framing
> of this document defined alpha-ready as "end-to-end runtime evidence on
> Sweetie HD via a complete native RealLive port." A 6-angle audit batch
> (`docs/audits/*`, `docs/research/*`) demonstrated that framing collapses a
> ~20–35 KLoC native port spanning ~22 sub-nodes into one DAG node, which
> makes alpha unreachable as a dogfood point.
>
> **Alpha-ready under the redefinition** means: the architecture is proven
> end-to-end on synthetic + real-bytes smoke, with enough of the claimed
> engines exercised to dogfood the suite on a first localization project. The
> first project then surfaces real failure modes that feed new DAG nodes.
> Alpha is **not** "complete product" — it is "usable enough to discover what
> the next pass of nodes should be." The native RealLive runtime port and the
> SiglusEngine port stay in the DAG at continuous tier; their decomposed
> sub-nodes (`docs/research/reallive-engine-dag-proposal.md`, 22 sub-nodes
> 146a–v) drive that work post-alpha, on no external timeline.
>
> **Concrete alpha gates under the redefinition** (cross-ref
> `docs/audits/alpha-scope-honesty.md` §D):
>
> 1. **Substrate extensions M.1–M.3 landed.** Materialised as DAG nodes
>    `UTSUSHI-222` (composite asset package + try-dir-then-archive
>    resolver), `UTSUSHI-223` (snapshot envelope size class), and
>    `UTSUSHI-224` (`EnginePort` → substrate-sinks bridge, legacy
>    `ObservationHookEvent` deleted). Each ships with multi-engine
>    validation against ≥2 real-bytes corpora (RealLive Sweetie HD + one
>    of MV/MZ Lust Memory, plain KiriKiri Bukkake Ranch), and each deletes
>    its legacy path in the same change — no shims, no `#[deprecated]`
>    markers, no compat aliases. M.4 (`UTSUSHI-225`, pixel-bound mouse
>    area input) and M.5 (`UTSUSHI-226`, frame-as-layer-composition sink)
>    are RealLive-specific and live at continuous tier; they unblock the
>    UTSUSHI-2xx runtime decomposition but are not alpha gates themselves.
> 2. **Non-synthetic engine port crate scaffolded.** `UTSUSHI-200`
>    (formerly 146a) exists as a crate that registers conformance against
>    the substrate, with the smallest credible opcode subset
>    (call/return/text-display/wait), and does **not** depend on
>    author-fixture envelopes. Depends on M.1–M.3 landing first.
> 3. **Real-bytes smoke on Sweetie HD.** `kaifuu-cli detect` returns true,
>    `parse_archive` returns a non-empty entry list (no silent zero-state),
>    and the Gameexe parser classifies the dominant key families. Findings
>    captured in `docs/audits/real-bytes-validation-2026-06-24.md` drive
>    the specific follow-up DAG nodes (`KAIFUU-188` 10000-slot envelope,
>    `KAIFUU-189` depth-N detector, `KAIFUU-190` Gameexe key family
>    expansion) that close this gate.
> 4. **Recorded-LLM bundle.** A reproducible recorded-provider run through
>    the full Itotori workflow (draft → QA → patch export) is reachable
>    behind `ITOTORI_LIVE_PROVIDER=0` with deterministic outputs.
> 5. **Dashboard reachable.** The spec-dag-dashboard renders DAG, claims,
>    and audit state from real DB state, not fixtures.
> 6. **Repo hygiene.** `just check` / `just test` / `just ci` / `just hello`
>    green locally; no silenced tests representing real outstanding work
>    (cross-ref `docs/audits/silenced-2026-06-24.md`); no foreign-tool
>    subprocess invocations in production code.
>
> **What remains continuous-tier post-alpha:** the full RealLive runtime
> port (146b–v), the SiglusEngine port, full real-game runtime evidence on
> Sweetie HD, RPG Maker MV/MZ end-to-end on a real game (vs. fixture
> vertical), encrypted XP3 + TJS, and every engine in the
> "Continuous Expansion Candidates" section below. None of these are
> required for the dogfood point; all of them are real DAG work that the
> dogfood point will help prioritize.
>
> **Original goal language preserved below** so the long-term vision stays
> visible. Read it as the project's North Star, not as the alpha gate. The
> sections that follow describe the suite's intended end-state; the gates
> above are the subset needed for the first dogfood pass.

This document defines the feature set that makes the Itotori suite ready to
start a first real localization project. It does not define a terminal product
state for the monorepo. The projects keep moving after this milestone; the first
real game is a stress test that generates new DAG work, not a reason to stop.

Alpha readiness means the suite has already proven the theory on public
fixtures, real-engine fixture profiles, and recorded or explicitly opted-in live
LLM runs. The first full-game localization project should discover scale,
content, engine-variant, and workflow issues. It should not be the first time
the suite proves extraction, patching, provider routing, QA, cost accounting,
benchmarking, dashboard state, or runtime evidence.

Itotori, Kaifuu, and Utsushi remain complementary but separable projects in one
monorepo:

- **Itotori** owns localization state, locale branches, drafting, QA, feedback,
  human decisions, benchmark records, provider/cost records, and dashboard read
  models.
- **Kaifuu** owns extraction, patching, verification, adapter capability
  reporting, and `.kaifuu` delta packages.
- **Utsushi** owns runtime evidence: traces, captures, smoke reports, replay or
  playable-review evidence when present, and fidelity-tier wording.

> **Read with the redefinition above.** This section's product loop is the
> long-term shape of the suite. The alpha gate is the 6-item list at the top
> of this doc, not the totality of the 13-step loop below.

## Readiness Scope

Alpha readiness is achieved when the suite can run the same product loop on
public synthetic fixtures and at least one real-engine fixture profile, then
show that the engine boundary remains generic across the alpha engine/readiness
set.

The product loop is:

1. Identify a work, local install, corpus entry, or engine profile.
2. Inventory localization surfaces and engine capability/readiness.
3. Extract source localization surfaces into a bridge bundle.
4. Import the bridge into Itotori project and locale-branch state.
5. Draft target text with fake, recorded, local, or explicitly opted-in live
   provider routing.
6. Run deterministic QA and at least one QA-agent or recorded-agent pass.
7. Export a patchable package from Itotori.
8. Patch, verify, diff, and apply with Kaifuu.
9. Collect Utsushi runtime evidence at the tier available for that engine.
10. Ingest runtime evidence into Itotori without weakening the tier language.
11. Review a dashboard decision or feedback item with source, draft, context,
    findings, runtime evidence, impact, and consequences visible together.
12. Apply one repair or feedback decision and rerun only affected work when the
    implementation can determine the affected scope.
13. Produce benchmark, quality, and cost reports with hashes, model/provider
    metadata, prompts or preset hashes, and reproducible command lines.

> **Read with the redefinition above.** The engines and readiness profiles
> below describe the suite's long-term claimed-support set. The alpha gate
> is the 6-item list at the top of this doc; the full per-engine chain (the
> `detect → extract → decrypt → decompile → patch → verify → delta-apply`
> language) is continuous-tier work, not an alpha blocker.

## Alpha Engine And Readiness Set

### First real-engine vertical

The first real-engine end-to-end vertical is Sukara's _Oshioki Sweetie HD
Remaster + Sweets fandisc_ (RealLive engine), sourced from the vault-curation
catalog at `/archive/vault/` via the read-only contract in
[itotori-vault-source-adapter.md](itotori-vault-source-adapter.md). That
vertical is what proves the suite on real owned content: detect, extract,
decrypt, decompile, patch, verify, delta-apply, and Utsushi runtime evidence
through a native RealLive port.

Synthetic encrypted-XP3 work continues as CI scaffolding under `KAIFUU-171` and
remains useful for redaction tests, schema validation, helper-unavailable
diagnostics, and contract proofs that do not require shipping a real-game
artifact through public CI. It is no longer the alpha proof. References below
to a "synthetic encrypted-XP3 vertical" should be read as CI scaffolding, not as
the alpha milestone.

### Claimed-support engine families for alpha

Alpha claimed-support engines (end-to-end, by the operating commitments in
[subprojects-kaifuu.md](subprojects-kaifuu.md)) are:

- **SiglusEngine + RealLive** — single Rust port scope. RealLive carries the
  first real-engine vertical; Siglus shares the port substrate.
- **RPG Maker MV/MZ** — JSON-text adapter plus encrypted asset decrypt/replace,
  with browser/NW.js instrumentation as the runtime path (the engine's own
  runtime is a web app).
- **Plain XP3 + KAG plaintext** — the unencrypted KiriKiri case as the
  null-key/identity-container slice of the layered pipeline.

The following engines are **not claimed for alpha**. They remain in the roadmap
as research-tier or continuous work; readiness records, detector matrices, and
fixture work may exist, but no end-to-end support claim is made for the alpha
milestone:

- Ren'Py
- Wolf RPG Editor
- BGI/Ethornell
- RPG Maker VX Ace / RGSS3
- TyranoScript
- Unity (and Unreal, Godot)
- Encrypted krkrz and TJS-heavy KiriKiri variants beyond plain XP3 + KAG
  plaintext

The alpha engine/readiness set table below is fixed. Text access is a layered
reversible pipeline. Plaintext engines are not a separate architecture; they are
the identity/null-key case of container, crypto, and codec stages. Alpha
evidence must therefore include both positive adapter support and readiness
profiles for packed/encrypted engines.

| Engine id                          | Alpha role                                                                  | Required alpha support                                                                                                                                                                                                                                                                                                            | Runtime evidence bar                                                                                                                                             | Not required before first real project                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-json`                   | Public CI control and contract proof                                        | `fixtures/hello-game` extraction, drafting, patching, `.kaifuu` delta, apply, verify, Utsushi trace, Utsushi capture, dashboard status                                                                                                                                                                                            | E2 frame capture in CI                                                                                                                                           | Real-engine support claim                                                                                                    |
| `rpg-maker-mv-mz-json`             | First positive real-engine vertical slice and demo anchor                   | RPG Maker MV/MZ JSON project data for map events, common events, choices, database text, UI-like terms, plugin-profiled text, control-code protected spans, patching, verify, delta package, asset inventory, encrypted media detection, and key-profile diagnostics                                                              | E1 trace or E2 capture; Chromium browser launch is required and environmental misconfiguration is a hard utsushi.browser.\* error; report must state limitations | XP/VX/Ace production patching, full encrypted media patching, plugin-owned dynamic text not represented in profiled fixtures |
| `tyranoscript-null-key`            | High-reach plaintext/null-key breadth proof                                 | Plaintext TyranoScript scenarios as identity container, null-key crypto, script codec pipeline; dialogue, choices, labels, jumps, variables, comments, common tags, protected spans, patching, verify, and capability errors for packed/mobile/encrypted/custom-plugin cases                                                      | E0 static evidence required; E1 route/text probe when available                                                                                                  | Browser/mobile packed builds, encrypted assets, arbitrary plugin semantics                                                   |
| `kirikiri-xp3-readiness`           | High-value packed/encrypted VN readiness and first encrypted vertical proof | Capability-leveled XP3 detection and readiness profiles for plaintext KAG, packed XP3, encrypted XP3, protected executable, helper-required, universal dump, and universal patch workflows; one declared synthetic encrypted XP3 profile must run detect, key/profile resolution, extract, trivial patch, verify, and delta apply | E0 readiness evidence required; E1 trace probe only when already extracted/plaintext                                                                             | Broad production encrypted `.xp3` extraction/patching beyond the first declared profile                                      |
| `rpg-maker-vx-ace-rgss3-readiness` | Local-backlog packed/binary readiness proof                                 | RGSSAD/Ruby Marshal readiness record, binary patcher requirements, fixture strategy, and future adapter split for VX Ace/RGSS3 local backlog titles                                                                                                                                                                               | E0 readiness evidence                                                                                                                                            | Production RGSS3 extraction/patching until binary patcher and fixtures prove it                                              |
| `bgi-ethornell-readiness`          | BGI/Ethornell detector and profile readiness proof                          | BGI/Ethornell container, compression, layered-transform, header/no-header bytecode profile, unknown-variant, and semantic-negative detector/profile evidence; support boundaries must state that parser, extraction, and patch support are not claimed by this readiness row                                                      | E0 detector/profile readiness evidence                                                                                                                           | Production BGI/Ethornell archive parsing, extraction, bytecode patching, or repacking                                        |

Ren'Py is a useful reference/null-key adapter, but it is not an alpha
readiness driver for Japanese indie backlog coverage. SiglusEngine, Unity,
Unreal, Godot, binary VN engines, OCR for image-only text, voice/audio
localization, and commercial-grade launcher automation are not required as
first-project production adapters. That is a sequencing statement, not a product
ceiling. Kaifuu's long-term goal is to legitimately decrypt, extract, patch, and
validate owned games across supported engine variants. Alpha encrypted corpus
triage, archive/encryption detection, key-profile schema, local-only key
material policy, platform-assisted helper boundaries, redaction tests, layered
access preflight, engine-specific readiness profiles, and one encrypted-profile
vertical are required because they make that production support safe to build
without leaking keys or private assets. See
[kaifuu-key-discovery.md](kaifuu-key-discovery.md).

## Fixture And Corpus Requirements

Alpha fixtures must follow [fixtures-and-corpora.md](fixtures-and-corpora.md)
and [kaifuu-fixture-policy.md](kaifuu-fixture-policy.md). Public CI may depend
only on committed public fixtures with manifests and redistributable assets.
Private local corpora may strengthen benchmark credibility, but CI and the demo
script must still pass when `fixtures/private-local/` is absent.

Required public fixtures:

- `fixtures/hello-game` plus its public manifest for `synthetic-json`.
- A public RPG Maker MV/MZ-style JSON fixture with map events, common events,
  choices, database text, UI-like terms, plugin-profiled text, representative
  control codes, asset inventory, and encrypted-media detector cases.
- A public TyranoScript plaintext/null-key fixture with dialogue, choices,
  labels, jumps, variables, comments, common tags, and plugin-like unknown tags.
- Synthetic public detector/readiness fixtures for KiriKiri/XP3 and RGSS3/VX
  Ace that prove capability levels, missing-key/helper-required outcomes, and
  unsupported patch paths without retail bytes.
- A synthetic public encrypted XP3 fixture with fixture-only key material for
  the first declared encrypted-profile vertical: detect, key/profile resolution,
  extract, trivial patch, verify, and `.kaifuu` delta apply.
- Seeded-defect fixture data that can produce known deterministic QA findings
  and QA-agent evaluation results without exposing private source text.

Each fixture used by an alpha readiness check must include:

- fixture id, engine id, source locale, target locale, license, schema version,
  raw file hashes, byte counts, and aggregate stats;
- expected extracted surface counts by surface kind;
- expected protected-span counts by span kind;
- expected patch export, patch result, delta package, verify report, runtime
  report when applicable, benchmark report, and quality finding artifacts;
- semantic unsupported-input cases for encrypted, compiled, packed, obfuscated,
  or unknown-variant inputs in that engine family.

Private-local benchmark inputs may be cited only by aggregate stats, private
manifest hash, hash-list hash, tool versions, and command lines. Reports must
not publish raw private strings, screenshots, filenames that reveal story
content, or local paths.

Private-local encrypted validation is a first-class alpha evidence lane. When a
developer has owned or licensed encrypted corpora available, alpha readiness
evidence should include redacted engine triage, key-profile readiness, helper
availability, key-validation proof hashes, and safe aggregate reports for those
corpora. Public CI and public demo paths must still pass when
`fixtures/private-local/` is absent.

> **Read with the redefinition above.** The workflows below describe the
> dashboard's long-term shape. The alpha gate (top of this doc) only
> requires that the spec-dag-dashboard render DAG, claims, and audit state
> from real DB state — the full workflow set below is continuous-tier.

## Required Dashboard Workflows

The dashboard does not need final product polish, but alpha readiness requires
real workflows backed by state, not static marketing mockups.

Required workflows:

- **Project and corpus intake**: show work identity, local install/corpus
  identity, engine profile, source revision, target locale, import status,
  extracted surface counts, fixture or corpus identity, and blocking capability
  errors.
- **Locale branch setup**: show style guide, glossary, do-not-translate rules,
  romanization/preserve choices, and their versions for the target branch.
- **Draft and QA run status**: show draft status, deterministic QA findings,
  QA-agent or recorded-agent findings, provider/model/preset identity, token
  counts, cost, latency, and retry/fallback metadata when applicable.
- **Decision queue**: include export blockers, style/glossary decisions, draft
  review, runtime evidence issues, feedback triage, and deferred items. A
  reviewer action that changes draft, policy, glossary, feedback, export state,
  or rerun scheduling must reveal source, draft, context, evidence, reasoning,
  impact, options, and consequences together.
- **Runtime evidence review**: show Utsushi evidence tier, adapter, environment,
  artifact hashes/paths, limitations, screenshots or traces when present, and
  wording that never promotes E0/E1/E2 evidence into engine-perfect claims.
- **Patch and delta status**: show patch export, Kaifuu patch result, verify
  result, `.kaifuu` delta package, apply result, and structured failures.
- **Feedback and repair loop**: allow a typo correction or style dispute from a
  playable/runtime-reviewed slice to become a triaged decision, repair job, and
  updated patch output.
- **Cost and quality dashboard**: show benchmark runs, raw MTL baseline, Itotori
  draft results, deterministic QA output, QA-agent evaluation, seeded-defect
  recall/precision where available, token/cost data, provider/model changes,
  fixture hashes, and report drilldown.

## Quality, Cost, And Benchmark Reports

Alpha readiness must produce reports, not claims. Public wording must continue
to follow [quality-claims.md](quality-claims.md).

Benchmarking, tuning, and testing are required before the first real
localization project starts. At least one path must exercise fake or recorded
providers for deterministic CI, and at least one local or explicitly opted-in
live provider run must prove that provider metadata, retries, structured
outputs, token/cost accounting, and report artifacts work with real LLM
responses before the first real game begins. This is part of alpha readiness,
not a vague earlier milestone.

Required report names:

- `alpha-readiness-benchmark-report`: one run record tying fixtures or
  private-local corpus labels to tool versions, git commit, command line,
  bridge schema version, provider/model/preset identity, prompt or preset
  hashes, deterministic seed when relevant, and artifact hashes.
- `alpha-readiness-quality-report`: raw MTL baseline, Itotori draft,
  deterministic QA, QA-agent evaluation, seeded-defect results,
  human-evaluation sample counts when available, quality taxonomy categories,
  severity distributions, and known blind spots.
- `alpha-readiness-cost-report`: token counts, estimated or billed cost,
  provider routing, fallback/retry records, latency, local endpoint
  zero/estimated cost treatment, per-engine/per-locale/per-character costs, and
  missing-cost caveats.
- `alpha-readiness-runtime-evidence-report`: Utsushi evidence tiers, adapter
  names, environment details, artifact limits, hashes, screenshots/traces when
  present, and limitations.
- `alpha-readiness-summary`: README-safe summary that links to the reports and
  avoids unverifiable quality, cost, or engine-support claims.

The "$25 standard indie localization" target is an aspirational cost target to
measure against. It is not an alpha guarantee, pricing claim, or promise that a
complete game can be localized for $25. The alpha cost report must say whether
the measured fixture and private-local runs are above, below, or not comparable
to that target, and why.

## Alpha Readiness Check Matrix

The table below is intentionally scanner-friendly. Keep the `Check id` values
stable when editing this document.

| Check id          | Area                      | Required evidence                                                                                                                                                   | Pass condition                                                                                                                                                                                                      | Required before first real project |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `ALPHA-CHECK-001` | Scope definition          | This document is linked from `docs/README.md` and referenced by alpha integration review                                                                            | Later alpha nodes use this scope unless this document is deliberately amended in a separate review                                                                                                                  | Yes                                |
| `ALPHA-CHECK-002` | Synthetic loop            | `just hello` or successor command artifacts for `synthetic-json`                                                                                                    | Extract, draft, export, patch, diff, apply, verify, trace, capture, ingest, and dashboard status pass with E2 evidence                                                                                              | Yes                                |
| `ALPHA-CHECK-003` | RPG Maker vertical slice  | `ALPHA-001` and `UTSUSHI-119` artifacts for `rpg-maker-mv-mz-json`                                                                                                  | Full loop runs on public or private-local fixture profile, observes patched output at runtime, and does not rely on synthetic engine assumptions                                                                    | Yes                                |
| `ALPHA-CHECK-004` | Engine readiness breadth  | `ALPHA-004` matrix for `rpg-maker-mv-mz-json`, `tyranoscript-null-key`, `kirikiri-xp3-readiness`, `rpg-maker-vx-ace-rgss3-readiness`, and `bgi-ethornell-readiness` | Positive adapters and readiness-only profiles are clearly separated; capability levels are explicit for identify, inventory, extract, and patch                                                                     | Yes                                |
| `ALPHA-CHECK-005` | Fixture legality          | Public manifests and private-local hash summaries                                                                                                                   | Public CI uses redistributable fixtures only; private data is cited only through allowed aggregate/hash metadata                                                                                                    | Yes                                |
| `ALPHA-CHECK-006` | Protected spans           | Golden extraction/patch/QA artifacts                                                                                                                                | Engine control codes, interpolation, variables, tags, and placeholders are represented as protected spans and survive patching                                                                                      | Yes                                |
| `ALPHA-CHECK-007` | Dashboard workbench       | Manual dashboard smoke plus API-backed state                                                                                                                        | Required dashboard workflows are reachable and backed by current project state, not hard-coded demo data                                                                                                            | Yes                                |
| `ALPHA-CHECK-008` | Human decisions           | Decision queue test or demo artifacts                                                                                                                               | A reviewer can resolve at least one contextual decision and see durable consequences plus affected rerun behavior                                                                                                   | Yes                                |
| `ALPHA-CHECK-009` | Runtime evidence wording  | Utsushi reports and dashboard screenshots                                                                                                                           | Every runtime claim shows E0/E1/E2/E3/E4 tier and limitations; weak evidence is not promoted                                                                                                                        | Yes                                |
| `ALPHA-CHECK-010` | Feedback loop             | `ALPHA-002` before/after artifacts                                                                                                                                  | Runtime/playable feedback becomes triage, a decision, a repair job, and updated patch output                                                                                                                        | Yes                                |
| `ALPHA-CHECK-011` | Benchmark report          | `alpha-readiness-benchmark-report`                                                                                                                                  | Report names fixtures/corpora, hashes, schemas, tool versions, command lines, provider/model/preset metadata, and artifacts                                                                                         | Yes                                |
| `ALPHA-CHECK-012` | Quality report            | `alpha-readiness-quality-report`                                                                                                                                    | Report includes raw MTL baseline, Itotori draft, deterministic QA, QA-agent evaluation, seeded-defect results, and blind spots                                                                                      | Yes                                |
| `ALPHA-CHECK-013` | Cost report               | `alpha-readiness-cost-report`                                                                                                                                       | Report includes token/cost/latency/routing/fallback data and evaluates the $25 target as measurement only                                                                                                           | Yes                                |
| `ALPHA-CHECK-014` | Patch package             | Kaifuu patch, verify, diff, and apply artifacts                                                                                                                     | `.kaifuu` delta package applies cleanly and verify reports structured failures for unsupported inputs                                                                                                               | Yes                                |
| `ALPHA-CHECK-015` | Validation checks         | Validation command output                                                                                                                                           | `node scripts/spec-dag.mjs validate`, `pnpm exec vp check`, fixture validation, TypeScript checks, Rust checks, and relevant tests pass or have explicit owner waiver                                               | Yes                                |
| `ALPHA-CHECK-016` | Public claims             | `alpha-readiness-summary` and docs audit                                                                                                                            | Public summary avoids claims of superiority, guaranteed price, full engine fidelity, or broad engine compatibility                                                                                                  | Yes                                |
| `ALPHA-CHECK-017` | Non-goals                 | Known non-goals section in this document and alpha summary                                                                                                          | Exclusions are visible before demo and alpha review                                                                                                                                                                 | Yes                                |
| `ALPHA-CHECK-018` | Encrypted local readiness | Kaifuu key discovery docs, redaction tests, detector fixtures, and private-local encrypted readiness report when local corpora are present                          | Public CI uses only public fixtures; local encrypted validation produces safe aggregate evidence with no raw keys, private assets, helper dumps, decrypted scripts, or local paths                                  | Yes                                |
| `ALPHA-CHECK-019` | Real LLM proof            | `ALPHA-008`, `ITOTORI-116`, and `ITOTORI-117` recorded or explicitly opted-in live provider artifacts                                                               | Structured Itotori draft/QA output and degenerate raw MTL baseline output both exercise retries, provider/model metadata, token/cost accounting, and quality scoring before a full-game project begins              | Yes                                |
| `ALPHA-CHECK-020` | Encrypted patch vertical  | `ALPHA-006` and `SHARED-025` artifacts for the declared synthetic encrypted XP3 profile                                                                             | Kaifuu runs detect, key/profile resolution, extract, trivial patch, verify, `.kaifuu` delta apply, and manifest-bound artifact linkage without leaking keys, helper dumps, private paths, or decrypted private text | Yes                                |

> **Read with the redefinition above.** The check matrix and command list
> below describe the suite's long-term validation set. The alpha gate's
> repo-hygiene line maps to `just check` / `just test` / `just ci` /
> `just hello` plus no silenced real work; the rest of the matrix below is
> continuous-tier expansion, not an alpha blocker.

## Validation Checks

Run these checks before alpha readiness is accepted:

```sh
node scripts/spec-dag.mjs validate
pnpm exec vp check
just fixtures-validate
pnpm exec vp run ts:typecheck
cargo fmt --check
cargo check --workspace
cargo test --workspace
just ci-itotori
just itotori-scale-smoke
env -u DATABASE_URL pnpm --filter @itotori/db test
```

`just check` may be used when practical because it already includes several of
the required checks. Any skipped command must have an explicit owner waiver that
names the command, reason, risk, and follow-up node.

The Itotori database readiness path uses a disposable local Postgres by default:

```sh
DATABASE_URL=postgres://itotori:itotori@127.0.0.1:55433/itotori
COMPOSE_PROJECT_NAME=itotori
ITOTORI_SCALE_SCHEMA=itotori_scale_review
```

The default values above are public CI-safe and contain no secrets. Developers
running multiple worktrees should set `COMPOSE_PROJECT_NAME` to a unique value;
when it is unset locally, `just db-up` derives one from the worktree directory.
`just db-up`, `just db-wait`, `just db-migrate`, and `just db-reset` are the
supported local database lifecycle commands. The scale smoke report is written
to `.tmp/itotori-scale-harness/smoke/summary.json`, and the no-database DB-test
skip report is written to `.tmp/itotori-db/no-database-skipped.json`.

Manual readiness checks:

- Alpha check review against every `ALPHA-CHECK-*` row.
- Fixture/legal review for all public and private-local inputs.
- Encrypted corpus review for key-profile ids, helper evidence, redaction, and
  private-local aggregate reports when private encrypted corpora are present.
- Dashboard workflow smoke on a fresh database.
- Artifact review for hashes, environment details, and evidence-tier wording.
- Quality/cost report audit for missing model/provider/cost metadata and
  unverifiable claims.

> **Read with the redefinition above.** The demo script below describes the
> suite's long-term dogfood storyline. The alpha gate is the 6-item list at
> the top of this doc; demoing the full 13-step script is the **post-alpha
> dogfood project**, not the alpha gate itself.

## Demo Script

The alpha readiness demo must be repeatable from a clean checkout with
documented private-local prerequisites optional.

1. Start from a clean worktree and record git commit, tool versions, and whether
   private-local corpora are present.
2. Run the synthetic hello-world loop and show final dashboard status,
   `.kaifuu` package, Utsushi E2 evidence, and report hashes.
3. Run the RPG Maker MV/MZ vertical slice. Show extraction counts, protected
   spans, Itotori import, draft run, deterministic QA findings, QA-agent or
   recorded-agent findings, patch export, Kaifuu verify, delta apply, runtime
   evidence tier, and dashboard status.
4. Run or open at least one recorded or live-provider proof that exercises real
   LLM response parsing, structured output validation, retries, cost accounting,
   deterministic QA, and QA-agent findings.
5. Run the encrypted-profile vertical on the synthetic XP3 fixture. Show
   archive/encryption detection, key/profile resolution, extraction, trivial
   patch, verify, `.kaifuu` delta apply, and redacted failure paths.
6. If private-local encrypted corpora are present, run the encrypted readiness
   lane. Show archive/encryption detection, redacted key-profile ids, helper
   availability, validation proof hashes, semantic failures for unsupported
   protected variants, and confirm no raw keys or private assets appear in
   logs/reports.
7. Open the dashboard workbench. Show project import status, locale branch
   policy, draft/QA run status, runtime evidence, patch/delta status, and cost
   panels.
8. Open one export blocker or style/glossary decision. Show source, draft,
   context, findings, evidence, impact, options, and consequences before taking
   action.
9. Submit one feedback item or correction from runtime/playable review, triage
   it, apply the repair, rerun affected work, and show the updated patch output.
10. Run or open the engine readiness matrix for RPG Maker MV/MZ, TyranoScript,
    KiriKiri/XP3, RPG Maker VX Ace/RGSS3, and BGI/Ethornell detector/profile
    readiness. Show that Kaifuu distinguishes positive patch support from
    readiness-only packed/encrypted profiles while Itotori remains
    engine-agnostic.
11. Open `alpha-readiness-benchmark-report`,
    `alpha-readiness-quality-report`, `alpha-readiness-cost-report`, and
    `alpha-readiness-runtime-evidence-report`. Point out raw MTL baseline,
    Itotori draft results, QA-agent evaluation, seeded-defect metrics,
    token/cost data, provider/model metadata, fixture hashes, evidence tiers,
    and limitations.
12. Show the `alpha-readiness-summary` wording and confirm it does not claim
    guaranteed price, engine-perfect fidelity, or broad commercial game
    support.
13. End with the readiness check matrix and mark each `ALPHA-CHECK-*` row pass,
    fail, or waived with owner and follow-up.

> **Read with the redefinition above.** These exclusions remain valid
> non-goals, but read them against the redefined alpha gate (6-item list at
> the top of this doc) rather than the full North-Star scope below.

## Known Non-Goals

These exclusions apply to the alpha readiness milestone:

- No guarantee that a complete commercial game can be localized for $25. The
  suite measures against that aspirational target only.
- No public claim that Itotori quality beats human localization, raw MTL, or
  generic LLM translation.
- No support claim for engines outside the named positive adapters and
  readiness profiles.
- No claim of engine-perfect, pixel-perfect, or reference-runtime fidelity
  unless a specific E4 report exists for the covered feature scope.
- No universal extraction from encrypted, packed, compiled, obfuscated, or
  DRM-protected game assets. Alpha requires detection, key-profile, redaction,
  and local helper boundaries; extraction or patching is allowed only when an
  engine profile explicitly supports the exact case and required key material is
  supplied locally.
- No SiglusEngine production adapter before the first real localization
  project.
- No image-text OCR, font editing, voice/audio localization, video subtitling,
  save migration, controller automation, installer patching, storefront
  packaging, or translation memory import/export as an alpha blocker.
- No live provider calls in public CI and no live-call requirement for the demo.
  Recorded, fake, local, or explicitly opted-in live providers are acceptable
  when their metadata and limitations are recorded. At least one real LLM proof
  must exist outside public CI before the first real localization project starts.
- No hidden private corpus dependency. Private-local data may improve reports,
  but absence of private data cannot break the public demo path. Presence of
  private encrypted data should strengthen the local readiness lane without
  changing public CI requirements.
- No final UX polish requirement. The dashboard must be coherent and backed by
  state, but visual polish beyond workflow clarity is continuous expansion.

> **Read with the redefinition above.** Under the redefined alpha, the items
> below are joined by the full RealLive runtime port (`UTSUSHI-201..221`),
> the SiglusEngine port, RPG Maker MV/MZ end-to-end on a real game (vs
> fixture vertical), and encrypted XP3 + TJS as continuous-tier work — none
> of which are alpha blockers. The dogfood point feeds back into prioritizing
> this list.

## Continuous Expansion Candidates

These are useful after alpha readiness but must not block the first real
localization project unless an owner promotes them through the DAG:

- More production adapters and variants: broader production SiglusEngine
  extraction and patching beyond the alpha known-key smoke, encrypted KiriKiri
  XP3 variants beyond the first declared profile, production RPG Maker VX
  Ace/RGSS3 patching, Unity, Unreal, Godot, packed Ren'Py projects, and binary
  VN formats. Alpha still includes layered access modeling, encrypted-input
  detection, key-profile policy, helper boundaries, local encrypted corpus
  readiness, and one encrypted-profile patch vertical. Once Kaifuu claims a
  specific engine variant and capability level, failures inside that declared
  support profile should be treated as bugs or compatibility regressions, not as
  new feature requests.
- Stronger Utsushi evidence: E3 replay review, E4 reference comparison,
  browser/WASM playback, remote Windows probe hosts, and GPU/native capture
  matrices.
- Broader localization assets: image text, fonts, audio, video, subtitle timing,
  UI layout synthesis, and asset replacement pipelines.
- Production ergonomics: project templates, hosted collaboration, permissions,
  billing, long-term artifact storage, and marketplace packaging.
- Expanded benchmarks: more private-local corpora, human evaluation panels,
  provider experiments, local-model comparisons, and larger cost studies.
