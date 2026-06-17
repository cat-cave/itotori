# MVP Definition Of Done

This document freezes what "MVP complete" means for the Itotori suite. Later
integration nodes may add evidence, polish, or engine breadth, but they do not
get to redefine the MVP target after implementation starts.

The MVP is a narrow end-to-end slice with representation of every intended
subsystem. It is not a shortcut architecture. Itotori, Kaifuu, and Utsushi must
remain complementary but separable projects in one monorepo:

- **Itotori** owns localization state, locale branches, drafting, QA, feedback,
  human decisions, benchmark records, provider/cost records, and dashboard read
  models.
- **Kaifuu** owns extraction, patching, verification, adapter capability
  reporting, and `.kaifuu` delta packages.
- **Utsushi** owns runtime evidence: traces, captures, smoke reports, replay or
  playable-review evidence when present, and fidelity-tier wording.

## MVP Scope

The MVP is complete only when the suite can run the same product loop on public
synthetic fixtures and at least one real-engine fixture profile, then demonstrate
that the engine boundary remains generic across the three MVP engine families.

The product loop is:

1. Detect or select an engine profile.
2. Extract source localization surfaces into a bridge bundle.
3. Import the bridge into Itotori project and locale-branch state.
4. Draft target text with fake, recorded, local, or explicitly opted-in live
   provider routing.
5. Run deterministic QA and at least one QA-agent or recorded-agent pass.
6. Export a patchable package from Itotori.
7. Patch, verify, diff, and apply with Kaifuu.
8. Collect Utsushi runtime evidence at the tier available for that engine.
9. Ingest runtime evidence into Itotori without weakening the tier language.
10. Review a dashboard decision or feedback item with source, draft, context,
    findings, runtime evidence, impact, and consequences visible together.
11. Apply one repair or feedback decision and rerun only the affected work when
    the implementation can determine the affected scope.
12. Produce benchmark, quality, and cost reports with hashes and model/provider
    metadata.

## MVP Engine Set

The exact MVP engine set is fixed below.

| Engine id                | MVP role                                                 | Required MVP support                                                                                                                                                           | Runtime evidence bar                                                                    | Not included in MVP                                                                        |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `synthetic-json`         | Public CI control and contract proof                     | `fixtures/hello-game` extraction, drafting, patching, `.kaifuu` delta, apply, verify, Utsushi trace, Utsushi capture, dashboard status                                         | E2 frame capture in CI                                                                  | Real-engine support claim                                                                  |
| `rpg-maker-mv-mz-json`   | First real-engine vertical slice and release demo anchor | RPG Maker MV/MZ JSON project data for map events, common events, choices, database text, UI-like terms, control-code protected spans, patching, verify, and delta package      | E1 trace or E2 capture when the probe can launch/capture; report must state limitations | XP/VX/Ace, encrypted assets, plugin-owned dynamic text not represented in JSON fixtures    |
| `renpy-plaintext-rpy`    | Engine-agnostic breadth proof                            | Plaintext `.rpy` dialogue, menus, labels, interpolation/protected spans, translatable strings, patching, verify, and capability errors for compiled or packed inputs           | E0 static evidence required; E1 route/text probe when available                         | Producing decompiled `.rpy` from `.rpyc`, unpacking `.rpa`, obfuscated scripts             |
| `kirikiri-kag-plaintext` | Engine-agnostic breadth proof                            | Plaintext `.ks` dialogue, speaker/name context, choices, labels, comments, command-heavy lines, protected tag spans, patching, verify, and capability errors for packed inputs | E0 static evidence required; E1 trace probe when available                              | Encrypted `.xp3`, compiled plugins, unsupported macro semantics beyond the fixture profile |

SiglusEngine, Unity, Unreal, Godot, RPG Maker XP/VX/Ace, binary VN engines, OCR
for image-only text, voice/audio localization, and commercial-grade launcher
automation are not MVP engines.

## Fixture Requirements

MVP fixtures must follow [fixtures-and-corpora.md](fixtures-and-corpora.md) and
[kaifuu-fixture-policy.md](kaifuu-fixture-policy.md). Public CI may depend only
on committed public fixtures with manifests and redistributable assets. Private
local corpora may strengthen benchmark credibility, but CI and the demo script
must still pass when `fixtures/private-local/` is absent.

Required public fixtures:

- `fixtures/hello-game` plus its public manifest for `synthetic-json`.
- A public RPG Maker MV/MZ-style JSON fixture with map events, common events,
  choices, database text, UI-like terms, and representative control codes.
- A public Ren'Py plaintext `.rpy` fixture with dialogue, menus, labels,
  interpolation, comments, and translatable strings.
- A public KiriKiri/KAG plaintext `.ks` fixture with dialogue, speaker tags,
  choices, labels, comments, macros, and command-heavy lines.
- Seeded-defect fixture data that can produce known deterministic QA findings
  and QA-agent evaluation results without exposing private source text.

Each fixture used by a release gate must include:

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

## Required Dashboard Workflows

The dashboard does not need final product polish, but MVP completion requires
real workflows backed by state, not static marketing mockups.

Required workflows:

- **Project import status**: show project, engine profile, source revision,
  target locale, import status, extracted surface counts, fixture or corpus
  identity, and blocking capability errors.
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

The MVP must produce reports, not claims. Public wording must continue to follow
[quality-claims.md](quality-claims.md).

Required report names:

- `mvp-benchmark-report`: one run record tying fixtures or private-local corpus
  labels to tool versions, git commit, command line, bridge schema version,
  provider/model/preset identity, prompt or preset hashes, deterministic seed
  when relevant, and artifact hashes.
- `mvp-quality-report`: raw MTL baseline, Itotori draft, deterministic QA,
  QA-agent evaluation, seeded-defect results, human-evaluation sample counts
  when available, quality taxonomy categories, severity distributions, and
  known blind spots.
- `mvp-cost-report`: token counts, estimated or billed cost, provider routing,
  fallback/retry records, latency, local endpoint zero/estimated cost treatment,
  per-engine/per-locale/per-character costs, and missing-cost caveats.
- `mvp-runtime-evidence-report`: Utsushi evidence tiers, adapter names,
  environment details, artifact limits, hashes, screenshots/traces when present,
  and limitations.
- `mvp-release-summary`: README-safe summary that links to the reports and
  avoids unverifiable quality or cost claims.

The "$25 standard indie localization" target is an aspirational cost target to
measure against. It is not an MVP guarantee, pricing claim, or promise that a
complete game can be localized for $25. The MVP cost report must say whether the
measured fixture and private-local runs are above, below, or not comparable to
that target, and why.

## Release Gate Matrix

The table below is intentionally scanner-friendly. Keep the `Gate id` values
stable when editing this document.

| Gate id        | Area                     | Required evidence                                                                              | Pass condition                                                                                                                                                                | Blocks MVP release |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `GATE-MVP-001` | Scope freeze             | This document is linked from `docs/README.md` and referenced by MVP integration review         | Later MVP nodes use this scope unless this document is deliberately amended in a separate review                                                                              | Yes                |
| `GATE-MVP-002` | Synthetic loop           | `just hello` or successor command artifacts for `synthetic-json`                               | Extract, draft, export, patch, diff, apply, verify, trace, capture, ingest, and dashboard status pass with E2 evidence                                                        | Yes                |
| `GATE-MVP-003` | RPG Maker vertical slice | MVP-001 artifacts for `rpg-maker-mv-mz-json`                                                   | Full loop runs on public or private-local fixture profile without synthetic engine assumptions                                                                                | Yes                |
| `GATE-MVP-004` | Multi-engine breadth     | MVP-004 matrix for `rpg-maker-mv-mz-json`, `renpy-plaintext-rpy`, and `kirikiri-kag-plaintext` | All three extract and patch through Kaifuu; Itotori state and APIs remain engine-agnostic; evidence tier is explicit                                                          | Yes                |
| `GATE-MVP-005` | Fixture legality         | Public manifests and private-local hash summaries                                              | Public CI uses redistributable fixtures only; private data is cited only through allowed aggregate/hash metadata                                                              | Yes                |
| `GATE-MVP-006` | Protected spans          | Golden extraction/patch/QA artifacts                                                           | Engine control codes, interpolation, variables, tags, and placeholders are represented as protected spans and survive patching                                                | Yes                |
| `GATE-MVP-007` | Dashboard workbench      | Manual dashboard smoke plus API-backed state                                                   | Required dashboard workflows are reachable and backed by current project state, not hard-coded demo data                                                                      | Yes                |
| `GATE-MVP-008` | Human decisions          | Decision queue test or demo artifacts                                                          | A reviewer can resolve at least one contextual decision and see durable consequences plus affected rerun behavior                                                             | Yes                |
| `GATE-MVP-009` | Runtime evidence wording | Utsushi reports and dashboard screenshots                                                      | Every runtime claim shows E0/E1/E2/E3/E4 tier and limitations; weak evidence is not promoted                                                                                  | Yes                |
| `GATE-MVP-010` | Feedback loop            | MVP-002 before/after artifacts                                                                 | Runtime/playable feedback becomes triage, a decision, a repair job, and updated patch output                                                                                  | Yes                |
| `GATE-MVP-011` | Benchmark report         | `mvp-benchmark-report`                                                                         | Report names fixtures/corpora, hashes, schemas, tool versions, command lines, provider/model/preset metadata, and artifacts                                                   | Yes                |
| `GATE-MVP-012` | Quality report           | `mvp-quality-report`                                                                           | Report includes raw MTL baseline, Itotori draft, deterministic QA, QA-agent evaluation, seeded-defect results, and blind spots                                                | Yes                |
| `GATE-MVP-013` | Cost report              | `mvp-cost-report`                                                                              | Report includes token/cost/latency/routing/fallback data and evaluates the $25 target as measurement only                                                                     | Yes                |
| `GATE-MVP-014` | Patch package            | Kaifuu patch, verify, diff, and apply artifacts                                                | `.kaifuu` delta package applies cleanly and verify reports structured failures for unsupported inputs                                                                         | Yes                |
| `GATE-MVP-015` | Release checks           | Validation command output                                                                      | `node scripts/spec-dag.mjs validate`, `pnpm exec vp check`, fixture validation, TypeScript checks, Rust checks, and relevant tests pass or have explicit release-owner waiver | Yes                |
| `GATE-MVP-016` | Public claims            | `mvp-release-summary` and docs audit                                                           | Public summary avoids claims of superiority, guaranteed price, full engine fidelity, or broad engine compatibility                                                            | Yes                |
| `GATE-MVP-017` | Non-goals                | Known non-goals section in this document and release summary                                   | Exclusions are visible before demo and release review                                                                                                                         | Yes                |

## Release Checks

Run these checks before an MVP release candidate is accepted:

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
the required checks. Any skipped command must have an explicit release-owner
waiver that names the command, reason, risk, and follow-up node.

Manual release checks:

- MVP gate review against every `GATE-MVP-*` row.
- Fixture/legal review for all public and private-local inputs.
- Dashboard workflow smoke on a fresh database.
- Artifact review for hashes, environment details, and evidence-tier wording.
- Quality/cost report audit for missing model/provider/cost metadata and
  unverifiable claims.

## Demo Script

The release demo must be repeatable from a clean checkout with documented
private-local prerequisites optional.

1. Start from a clean worktree and record git commit, tool versions, and whether
   private-local corpora are present.
2. Run the synthetic hello-world loop and show final dashboard status,
   `.kaifuu` package, Utsushi E2 evidence, and report hashes.
3. Run the RPG Maker MV/MZ vertical slice. Show extraction counts, protected
   spans, Itotori import, draft run, deterministic QA findings, QA-agent or
   recorded-agent findings, patch export, Kaifuu verify, delta apply, runtime
   evidence tier, and dashboard status.
4. Open the dashboard workbench. Show project import status, locale branch
   policy, draft/QA run status, runtime evidence, patch/delta status, and cost
   panels.
5. Open one export blocker or style/glossary decision. Show source, draft,
   context, findings, evidence, impact, options, and consequences before taking
   action.
6. Submit one feedback item or correction from runtime/playable review, triage
   it, apply the repair, rerun affected work, and show the updated patch output.
7. Run or open the multi-engine matrix for RPG Maker MV/MZ, Ren'Py plaintext,
   and KAG plaintext. Show that Kaifuu handles engine-specific parsing/patching
   while Itotori remains engine-agnostic.
8. Open `mvp-benchmark-report`, `mvp-quality-report`, `mvp-cost-report`, and
   `mvp-runtime-evidence-report`. Point out raw MTL baseline, Itotori draft
   results, QA-agent evaluation, seeded-defect metrics, token/cost data,
   provider/model metadata, fixture hashes, evidence tiers, and limitations.
9. Show the `mvp-release-summary` wording and confirm it does not claim
   guaranteed price, engine-perfect fidelity, or broad commercial game support.
10. End with the release gate matrix and mark each `GATE-MVP-*` row pass, fail,
    or waived with owner and follow-up.

## Known Non-Goals

These exclusions are part of the MVP definition:

- No guarantee that a complete commercial game can be localized for $25. The
  MVP measures against that aspirational target only.
- No public claim that Itotori quality beats human localization, raw MTL, or
  generic LLM translation.
- No support claim for engines outside `synthetic-json`, `rpg-maker-mv-mz-json`,
  `renpy-plaintext-rpy`, and `kirikiri-kag-plaintext`.
- No claim of engine-perfect, pixel-perfect, or reference-runtime fidelity
  unless a specific E4 report exists for the covered feature scope.
- No extraction from encrypted, packed, compiled, obfuscated, or DRM-protected
  game assets unless an engine profile explicitly supports that case.
- No SiglusEngine production adapter in MVP.
- No image-text OCR, font editing, voice/audio localization, video subtitling,
  save migration, controller automation, installer patching, storefront
  packaging, or translation memory import/export as a release blocker.
- No live provider calls in public CI and no live-call requirement for the demo.
  Recorded, fake, local, or explicitly opted-in live providers are acceptable
  when their metadata and limitations are recorded.
- No hidden private corpus dependency. Private-local data may improve reports,
  but absence of private data cannot break the public MVP demo path.
- No final UX polish requirement. The dashboard must be coherent and backed by
  state, but visual polish beyond workflow clarity is post-MVP.

## P2 And P3 Follow-Up Candidates

These are useful after MVP but must not block MVP release unless a release owner
promotes them through the DAG:

- More engines and variants: SiglusEngine, Unity, Unreal, Godot, RPG Maker
  XP/VX/Ace, packed Ren'Py projects, encrypted KiriKiri archives, and binary VN
  formats.
- Stronger Utsushi evidence: E3 replay review, E4 reference comparison,
  browser/WASM playback, remote Windows probe hosts, and GPU/native capture
  matrices.
- Broader localization assets: image text, fonts, audio, video, subtitle timing,
  UI layout synthesis, and asset replacement pipelines.
- Production ergonomics: project templates, hosted collaboration, permissions,
  billing, long-term artifact storage, and marketplace packaging.
- Expanded benchmarks: more private-local corpora, human evaluation panels,
  provider experiments, local-model comparisons, and larger cost studies.
