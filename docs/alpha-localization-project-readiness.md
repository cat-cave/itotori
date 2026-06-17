# Alpha Localization Project Readiness

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

## Alpha Engine And Readiness Set

The alpha engine/readiness set is fixed below. Text access is a layered
reversible pipeline. Plaintext engines are not a separate architecture; they are
the identity/null-key case of container, crypto, and codec stages. Alpha
evidence must therefore include both positive adapter support and readiness
profiles for packed/encrypted engines.

| Engine id                          | Alpha role                                                | Required alpha support                                                                                                                                                                                                                                                       | Runtime evidence bar                                                                    | Not required before first real project                                                                                       |
| ---------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-json`                   | Public CI control and contract proof                      | `fixtures/hello-game` extraction, drafting, patching, `.kaifuu` delta, apply, verify, Utsushi trace, Utsushi capture, dashboard status                                                                                                                                       | E2 frame capture in CI                                                                  | Real-engine support claim                                                                                                    |
| `rpg-maker-mv-mz-json`             | First positive real-engine vertical slice and demo anchor | RPG Maker MV/MZ JSON project data for map events, common events, choices, database text, UI-like terms, plugin-profiled text, control-code protected spans, patching, verify, delta package, asset inventory, encrypted media detection, and key-profile diagnostics         | E1 trace or E2 capture when the probe can launch/capture; report must state limitations | XP/VX/Ace production patching, full encrypted media patching, plugin-owned dynamic text not represented in profiled fixtures |
| `tyranoscript-null-key`            | High-reach plaintext/null-key breadth proof               | Plaintext TyranoScript scenarios as identity container, null-key crypto, script codec pipeline; dialogue, choices, labels, jumps, variables, comments, common tags, protected spans, patching, verify, and capability errors for packed/mobile/encrypted/custom-plugin cases | E0 static evidence required; E1 route/text probe when available                         | Browser/mobile packed builds, encrypted assets, arbitrary plugin semantics                                                   |
| `kirikiri-xp3-readiness`           | High-value packed/encrypted VN readiness proof            | Capability-leveled XP3 detection and readiness profiles for plaintext KAG, packed XP3, encrypted XP3, protected executable, helper-required, universal dump, and universal patch workflows                                                                                   | E0 readiness evidence required; E1 trace probe only when already extracted/plaintext    | Production encrypted `.xp3` extraction/patching unless separately proven by exact fixtures and helper evidence               |
| `rpg-maker-vx-ace-rgss3-readiness` | Local-backlog packed/binary readiness proof               | RGSSAD/Ruby Marshal readiness record, binary patcher requirements, fixture strategy, and future adapter split for VX Ace/RGSS3 local backlog titles                                                                                                                          | E0 readiness evidence                                                                   | Production RGSS3 extraction/patching until binary patcher and fixtures prove it                                              |

Ren'Py is a useful reference/null-key adapter, but it is not an alpha
readiness driver for Japanese indie backlog coverage. SiglusEngine, Unity,
Unreal, Godot, binary VN engines, OCR for image-only text, voice/audio
localization, and commercial-grade launcher automation are not required as
first-project production adapters. That is a sequencing statement, not a product
ceiling. Kaifuu's long-term goal is to legitimately decrypt, extract, patch, and
validate owned games across supported engine variants. Alpha encrypted corpus
triage, archive/encryption detection, key-profile schema, local-only key
material policy, platform-assisted helper boundaries, redaction tests, layered
access preflight, and engine-specific readiness profiles are required because
they make that production support safe to build without leaking keys or private
assets. See [kaifuu-key-discovery.md](kaifuu-key-discovery.md).

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

Benchmarking, tuning, and testing are pre-alpha requirements. At least one path
must exercise fake or recorded providers for deterministic CI, and at least one
local or explicitly opted-in live provider run must prove that provider
metadata, retries, structured outputs, token/cost accounting, and report
artifacts work with real LLM responses before the first real game begins.

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

| Check id          | Area                      | Required evidence                                                                                                                          | Pass condition                                                                                                                                                                     | Required before first real project |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `ALPHA-CHECK-001` | Scope definition          | This document is linked from `docs/README.md` and referenced by alpha integration review                                                   | Later alpha nodes use this scope unless this document is deliberately amended in a separate review                                                                                 | Yes                                |
| `ALPHA-CHECK-002` | Synthetic loop            | `just hello` or successor command artifacts for `synthetic-json`                                                                           | Extract, draft, export, patch, diff, apply, verify, trace, capture, ingest, and dashboard status pass with E2 evidence                                                             | Yes                                |
| `ALPHA-CHECK-003` | RPG Maker vertical slice  | `ALPHA-001` artifacts for `rpg-maker-mv-mz-json`                                                                                           | Full loop runs on public or private-local fixture profile without synthetic engine assumptions                                                                                     | Yes                                |
| `ALPHA-CHECK-004` | Engine readiness breadth  | `ALPHA-004` matrix for `rpg-maker-mv-mz-json`, `tyranoscript-null-key`, `kirikiri-xp3-readiness`, and `rpg-maker-vx-ace-rgss3-readiness`   | Positive adapters and readiness-only profiles are clearly separated; capability levels are explicit for identify, inventory, extract, and patch                                    | Yes                                |
| `ALPHA-CHECK-005` | Fixture legality          | Public manifests and private-local hash summaries                                                                                          | Public CI uses redistributable fixtures only; private data is cited only through allowed aggregate/hash metadata                                                                   | Yes                                |
| `ALPHA-CHECK-006` | Protected spans           | Golden extraction/patch/QA artifacts                                                                                                       | Engine control codes, interpolation, variables, tags, and placeholders are represented as protected spans and survive patching                                                     | Yes                                |
| `ALPHA-CHECK-007` | Dashboard workbench       | Manual dashboard smoke plus API-backed state                                                                                               | Required dashboard workflows are reachable and backed by current project state, not hard-coded demo data                                                                           | Yes                                |
| `ALPHA-CHECK-008` | Human decisions           | Decision queue test or demo artifacts                                                                                                      | A reviewer can resolve at least one contextual decision and see durable consequences plus affected rerun behavior                                                                  | Yes                                |
| `ALPHA-CHECK-009` | Runtime evidence wording  | Utsushi reports and dashboard screenshots                                                                                                  | Every runtime claim shows E0/E1/E2/E3/E4 tier and limitations; weak evidence is not promoted                                                                                       | Yes                                |
| `ALPHA-CHECK-010` | Feedback loop             | `ALPHA-002` before/after artifacts                                                                                                         | Runtime/playable feedback becomes triage, a decision, a repair job, and updated patch output                                                                                       | Yes                                |
| `ALPHA-CHECK-011` | Benchmark report          | `alpha-readiness-benchmark-report`                                                                                                         | Report names fixtures/corpora, hashes, schemas, tool versions, command lines, provider/model/preset metadata, and artifacts                                                        | Yes                                |
| `ALPHA-CHECK-012` | Quality report            | `alpha-readiness-quality-report`                                                                                                           | Report includes raw MTL baseline, Itotori draft, deterministic QA, QA-agent evaluation, seeded-defect results, and blind spots                                                     | Yes                                |
| `ALPHA-CHECK-013` | Cost report               | `alpha-readiness-cost-report`                                                                                                              | Report includes token/cost/latency/routing/fallback data and evaluates the $25 target as measurement only                                                                          | Yes                                |
| `ALPHA-CHECK-014` | Patch package             | Kaifuu patch, verify, diff, and apply artifacts                                                                                            | `.kaifuu` delta package applies cleanly and verify reports structured failures for unsupported inputs                                                                              | Yes                                |
| `ALPHA-CHECK-015` | Validation checks         | Validation command output                                                                                                                  | `node scripts/spec-dag.mjs validate`, `pnpm exec vp check`, fixture validation, TypeScript checks, Rust checks, and relevant tests pass or have explicit owner waiver              | Yes                                |
| `ALPHA-CHECK-016` | Public claims             | `alpha-readiness-summary` and docs audit                                                                                                   | Public summary avoids claims of superiority, guaranteed price, full engine fidelity, or broad engine compatibility                                                                 | Yes                                |
| `ALPHA-CHECK-017` | Non-goals                 | Known non-goals section in this document and alpha summary                                                                                 | Exclusions are visible before demo and alpha review                                                                                                                                | Yes                                |
| `ALPHA-CHECK-018` | Encrypted local readiness | Kaifuu key discovery docs, redaction tests, detector fixtures, and private-local encrypted readiness report when local corpora are present | Public CI uses only public fixtures; local encrypted validation produces safe aggregate evidence with no raw keys, private assets, helper dumps, decrypted scripts, or local paths | Yes                                |
| `ALPHA-CHECK-019` | Real LLM proof            | Recorded or explicitly opted-in live provider run artifacts                                                                                | Structured outputs, retries, provider/model metadata, token/cost accounting, and QA-agent output are exercised with real LLM responses before a full-game project begins           | Yes                                |

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
```

`just check` may be used when practical because it already includes several of
the required checks. Any skipped command must have an explicit owner waiver that
names the command, reason, risk, and follow-up node.

Manual readiness checks:

- Alpha check review against every `ALPHA-CHECK-*` row.
- Fixture/legal review for all public and private-local inputs.
- Encrypted corpus review for key-profile ids, helper evidence, redaction, and
  private-local aggregate reports when private encrypted corpora are present.
- Dashboard workflow smoke on a fresh database.
- Artifact review for hashes, environment details, and evidence-tier wording.
- Quality/cost report audit for missing model/provider/cost metadata and
  unverifiable claims.

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
5. If private-local encrypted corpora are present, run the encrypted readiness
   lane. Show archive/encryption detection, redacted key-profile ids, helper
   availability, validation proof hashes, semantic failures for unsupported
   protected variants, and confirm no raw keys or private assets appear in
   logs/reports.
6. Open the dashboard workbench. Show project import status, locale branch
   policy, draft/QA run status, runtime evidence, patch/delta status, and cost
   panels.
7. Open one export blocker or style/glossary decision. Show source, draft,
   context, findings, evidence, impact, options, and consequences before taking
   action.
8. Submit one feedback item or correction from runtime/playable review, triage
   it, apply the repair, rerun affected work, and show the updated patch output.
9. Run or open the engine readiness matrix for RPG Maker MV/MZ, TyranoScript,
   KiriKiri/XP3, and RPG Maker VX Ace/RGSS3. Show that Kaifuu distinguishes
   positive patch support from readiness-only packed/encrypted profiles while
   Itotori remains engine-agnostic.
10. Open `alpha-readiness-benchmark-report`,
    `alpha-readiness-quality-report`, `alpha-readiness-cost-report`, and
    `alpha-readiness-runtime-evidence-report`. Point out raw MTL baseline,
    Itotori draft results, QA-agent evaluation, seeded-defect metrics,
    token/cost data, provider/model metadata, fixture hashes, evidence tiers,
    and limitations.
11. Show the `alpha-readiness-summary` wording and confirm it does not claim
    guaranteed price, engine-perfect fidelity, or broad commercial game
    support.
12. End with the readiness check matrix and mark each `ALPHA-CHECK-*` row pass,
    fail, or waived with owner and follow-up.

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
  when their metadata and limitations are recorded. At least one pre-alpha real
  LLM proof must exist outside public CI.
- No hidden private corpus dependency. Private-local data may improve reports,
  but absence of private data cannot break the public demo path. Presence of
  private encrypted data should strengthen the local readiness lane without
  changing public CI requirements.
- No final UX polish requirement. The dashboard must be coherent and backed by
  state, but visual polish beyond workflow clarity is continuous expansion.

## Continuous Expansion Candidates

These are useful after alpha readiness but must not block the first real
localization project unless an owner promotes them through the DAG:

- More production adapters and variants: production SiglusEngine extraction and
  patching, production encrypted KiriKiri/XP3 patching, production RPG Maker VX
  Ace/RGSS3 patching, Unity, Unreal, Godot, packed Ren'Py projects, and binary
  VN formats. Alpha still includes layered access modeling, encrypted-input
  detection, key-profile policy, helper boundaries, and local encrypted corpus
  readiness. Once Kaifuu claims a specific engine variant and capability level,
  failures inside that declared support profile should be treated as bugs or
  compatibility regressions, not as new feature requests.
- Stronger Utsushi evidence: E3 replay review, E4 reference comparison,
  browser/WASM playback, remote Windows probe hosts, and GPU/native capture
  matrices.
- Broader localization assets: image text, fonts, audio, video, subtitle timing,
  UI layout synthesis, and asset replacement pipelines.
- Production ergonomics: project templates, hosted collaboration, permissions,
  billing, long-term artifact storage, and marketplace packaging.
- Expanded benchmarks: more private-local corpora, human evaluation panels,
  provider experiments, local-model comparisons, and larger cost studies.
