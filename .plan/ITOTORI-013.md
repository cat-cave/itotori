# ITOTORI-013 — Scene summary agent

- **Node**: ITOTORI-013
- **Title**: Scene summary agent
- **Branch**: `spec/itotori-013`
- **Worktree**: `/scratch/worktrees/itotori-spec-itotori-013`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: planned -> ready_for_review

## 1. Goal restatement

ITOTORI-013 is the first LLM-using context agent in the ALPHA-006 drafting
workflow. It produces a **source-language scene summary** for each scene id
emitted by the ITOTORI-018 batch planner, with each summary citing the exact
`bridge_unit_id`s that motivated it, persisted alongside their source hashes
so any later source change marks the summary stale.

Non-negotiable properties from the assignment + DAG acceptance criteria:

1. **Citations required.** Every persisted summary stores the list of
   `bridge_unit_id`s it drew from, plus their `source_hash`es.
2. **Rerun invalidation.** On a batch-planner re-plan (or a direct stale-check
   pass), any summary whose `cited_unit_hashes` no longer match the current
   `bridge_units.source_hash` for the same `bridge_unit_id` is marked `Stale`.
3. **Source-language output.** Summary locale equals the project's
   `sourceLocale` (e.g. `ja-JP`). Never the target locale.
4. **Deterministic prompt construction.** Versioned prompt template with the
   units, glossary excerpts, and prior summary (when extending an existing
   scene) packed in a stable canonical order. Identical inputs -> identical
   prompt bytes -> identical recorded-fixture replay.
5. **CI uses fake / recorded providers only.** Live OpenRouter calls are
   opt-in via env (matches ADR 0002 provider routing & recording).

This node does NOT do scene boundary detection (that is ITOTORI-018's
`sceneId` output), character relationship modelling (ITOTORI-014), or
terminology mining (ITOTORI-016). It consumes the scene grouping the batch
planner already computed and converts each grouped slice of units into a
durable, cited, source-language summary that downstream batches reference.

## 2. Module placement

**Recommendation: new directory `apps/itotori/src/agents/scene-summary/`
inside the existing Itotori CLI app, sitting alongside `batch-planner/` and
`agents/` registry.** Verified layout:

```
apps/itotori/src/
  agents/                # registry, examples, glossary-search-tools, etc.
  batch-planner/         # ITOTORI-018 — produces sceneId-grouped batches
  providers/             # openrouter, fake, recorded, capability-guard
  services/              # project-workflow, database-services
```

The new module:

```
apps/itotori/src/agents/scene-summary/
  index.ts               # public surface: generateSceneSummaries(...), shapes re-export
  shapes.ts              # SceneSummary, SceneSummaryInput, SummaryStatus, ...
  prompt-template.ts     # versioned template builder; pure function over inputs
  agent.ts               # generateSceneSummaries orchestration (provider invocation)
  staleness.ts           # hash check against bridge_units; mark stale
  persistence.ts         # repository-level read/write delegating to itotori-db
  cli.ts                 # registers `itotori generate-scene-summaries`
  __tests__/             # unit tests; DB-backed tests via the shared harness
```

Cross-package touch points (kept thin and additive):

- `packages/itotori-db/src/schema.ts`: add two new tables —
  `itotori_scene_summaries` and `itotori_scene_summary_cited_units`. The
  existing `itotori_context_artifacts` table is **not** reused because (a)
  context-artifacts intentionally store free-form curator-authored notes
  with `producedByAgent` provenance and no machine-managed staleness
  lifecycle, and (b) ITOTORI-018's `SceneSummaryRef` already reads
  `contextArtifactId` for curator-authored summaries. Adding a parallel
  agent-managed table keeps the two producers separate while a follow-up
  node can decide whether to project agent summaries into
  `contextArtifacts` for unified reads. New migration via the existing
  tooling. No existing rows touched.
- `packages/itotori-db/src/repositories/scene-summary-repository.ts`: new
  repository; mirrors `style-guide-repository.ts` and
  `translation-batch-repository.ts`.
- `packages/itotori-db/src/index.ts`: re-export the new repository.
- `apps/itotori/src/batch-planner/context-pack.ts`: extend
  `sceneSummaryForGroup` so it prefers an agent-produced summary
  (status=`Fresh`) over a curator artifact when both exist, falls back
  otherwise. Additive change behind no flag — current callers continue
  passing the same `sceneSummaries` map.
- `apps/itotori/src/cli-handlers.ts`: register the new CLI command.

No new pnpm workspace member is required.

## 3. Types

All types live in `apps/itotori/src/agents/scene-summary/shapes.ts`. They are
the contract between the agent, persistence, and the batch planner.

### 3.1 `SceneSummary`

```ts
export type SummaryStatus = "Fresh" | "Stale";

export type SceneSummary = {
  /** uuid7 — primary key. Deterministic given
   *  (projectId, localeBranchId, sourceRevisionId, sceneId, promptTemplateVersion). */
  id: Uuid7;

  /** Project the summary belongs to. */
  projectId: Uuid7;

  /** Locale branch under that project (target side). The summary text is in
   *  the project's source locale, but it is scoped per locale branch so a
   *  re-translation into a different target can have a different summary
   *  drafted with different glossary preferences. */
  localeBranchId: Uuid7;

  /** Source revision the agent observed. Pins audit. */
  sourceRevisionId: Uuid7;

  /** Scene id, matching RouteContextV02.sceneId / Batch.sceneId. */
  sceneId: string;

  /** Locale of `summaryText`. MUST equal projects.sourceLocale at write time. */
  summaryLocale: Bcp47Locale;

  /** The source-language summary text the agent produced. */
  summaryText: string;

  /** Bridge units the agent was given as context, in canonical order. */
  citedUnitIds: Uuid7[];

  /** Source hashes for citedUnitIds at the moment of generation, indexed
   *  identically. Mismatch on later staleness check -> Stale. */
  citedUnitHashes: string[];

  /** Provider/model the agent invoked. */
  modelProfile: SceneSummaryModelProfile;

  /** Prompt template version id; bump on any template change. */
  promptTemplateVersion: string;

  /** Hash of the constructed prompt bytes — lets audit re-derive inputs. */
  promptHash: string;

  /** Token estimate of input pack and observed completion tokens. */
  inputTokenEstimate: number;
  completionTokens: number;

  /** RFC3339 generation instant. */
  generatedAt: string;

  /** Status: Fresh on write; Stale when any cited hash drifts. */
  status: SummaryStatus;

  /** Set when status transitions to Stale. */
  invalidatedAt?: string;

  /** Optional reason recorded when marked stale. */
  invalidatedReason?: "source_hash_drift" | "template_version_bump" | "manual";
};

export type SceneSummaryModelProfile = {
  providerFamily: ProviderFamily; // re-used from providers/types.ts
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
};
```

### 3.2 Agent IO

```ts
export type SceneSummaryInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale; // from projects table
  sceneId: string;

  /** Bridge units in canonical order — typically taken from the
   *  corresponding Batch.units list emitted by ITOTORI-018. */
  units: ReadonlyArray<BridgeUnitForSummary>;

  /** Glossary slice already cited for this scene (passed through from the
   *  batch). Trimmed to the terms whose source form appears in `units`. */
  glossaryExcerpt: ReadonlyArray<GlossaryRef>;

  /** Optional prior summary for the same scene — when extending an existing
   *  long scene with additional batches. */
  priorSummary?: { summaryText: string; promptTemplateVersion: string };

  /** Provider + model selection. */
  modelProfile: SceneSummaryModelProfile;

  /** Test seam — deterministic clock for generatedAt. */
  now?: () => Date;
};

export type BridgeUnitForSummary = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string;
};

export type SceneSummaryOutput = {
  summary: SceneSummary;
  providerRunRecord: ProviderRunRecord; // mirrors provider invocation log
};
```

The summary takes `BridgeUnitForSummary` (not the full `BridgeUnit`) so the
agent is engine-neutral — the batch planner has already done engine-specific
work upstream.

## 4. Agent service

`generateSceneSummary(input: SceneSummaryInput): Promise<SceneSummaryOutput>`
in `agent.ts`. Pipeline:

1. **Validate locale.** Assert `input.sourceLocale` matches the project's
   `projects.sourceLocale`. The agent refuses to run if the caller passed a
   target locale by mistake (defends auditFocus "target-language drift").
2. **Canonicalize input.** Sort `units` by `(sourceUnitKey, occurrenceId)` to
   match the planner's ordering; sort `glossaryExcerpt` by `termKey`.
3. **Build prompt** via `prompt-template.ts` (see §4.1). Hash the prompt
   bytes -> `promptHash`. Compute `inputTokenEstimate` using the same
   estimator the batch planner uses (`itotori-batch-estimator-v1`).
4. **Invoke provider** via the existing `ModelProvider` interface from
   `providers/types.ts`. Family is set by `input.modelProfile.providerFamily`
   — in CI tests this is `"fake"` or `"recorded"`; in real runs it can be
   `"openrouter"` or `"local-openai-compatible"`. The provider's
   capability-guard runs as usual. The completion text is taken as
   `summaryText` after `.trim()` (no further postprocessing — the prompt
   instructs the model to emit summary-only output).
5. **Populate citations.** `citedUnitIds = units.map(u => u.bridgeUnitId)`
   and `citedUnitHashes = units.map(u => u.sourceHash)` in matching order.
6. **Construct `SceneSummary`** with `status = "Fresh"`, `generatedAt =
   (input.now ?? Date.now)().toISOString()`, `summaryLocale =
   input.sourceLocale`, `promptTemplateVersion =
   PROMPT_TEMPLATE_VERSION_V1`.

`generateSceneSummaries(inputs: SceneSummaryInput[])` is the batch entry
point used by the CLI; it sequences `generateSceneSummary` calls one at a
time (provider concurrency is the provider's concern, not the agent's).

### 4.1 Prompt template

`prompt-template.ts` exports `PROMPT_TEMPLATE_VERSION_V1` and
`buildPrompt(input)`. The template is a pure function — same input bytes,
same output bytes, byte-for-byte. Composition:

```
[system]
You are a localization context assistant. Summarize the following scene in
the SAME LANGUAGE as the source units. Do not translate. Mention every
character who appears and the salient narrative facts. Keep summary under
~200 source-language characters. Output the summary text only.

[user]
Project source locale: {sourceLocale}
Scene id: {sceneId}
{priorSummary && "Prior summary (extend, do not repeat):\n" + priorSummary.summaryText}

Glossary excerpts (canonical names; preserve these):
- {termKey}: {preferredSourceForm}
...

Units (canonical order):
[#{idx}] ({speaker || "narration"}) {sourceText}
...
```

`promptHash = sha256(buildPrompt(input))` — used by tests to confirm
determinism and by audits to spot template drift.

The template version constant lives in `prompt-template.ts` and is
referenced from the schema migration's seed comment so reviewers can spot
template bumps in diffs.

### 4.2 Provider selection

The agent does not import providers directly. The caller (CLI, batch
planner re-plan) passes a constructed provider instance via a `provider:
ModelProvider` parameter on the `generateSceneSummary` call. Tests inject
`FakeModelProvider` (or the recorded-fixture provider — see §9.5). The CLI
constructs the provider from `--model` / env per the existing
`cli-handlers.ts` pattern, the same way `style-guide-conversation.ts`
already wires providers up.

This separation keeps the agent unit-testable without provider state.

## 5. DB persistence

Tables added in `packages/itotori-db/src/schema.ts`:

### 5.1 `itotori_scene_summaries`

- `scene_summary_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `scene_id text not null`
- `summary_locale text not null`
- `summary_text text not null`
- `model_provider_family text not null`
- `model_id text not null`
- `model_context_window_tokens integer not null`
- `model_max_output_tokens integer`
- `prompt_template_version text not null`
- `prompt_hash text not null`
- `input_token_estimate integer not null`
- `completion_tokens integer not null`
- `status text not null` — `"Fresh" | "Stale"`
- `invalidated_at timestamptz`
- `invalidated_reason text`
- `generated_at timestamptz not null`
- Indexes:
  - `unique (project_id, locale_branch_id, source_revision_id, scene_id, prompt_template_version)`
  - `index (project_id, locale_branch_id, source_revision_id, status)`
  - `index (scene_id)`

### 5.2 `itotori_scene_summary_cited_units`

- `scene_summary_id text not null references itotori_scene_summaries(scene_summary_id) on delete cascade`
- `bridge_unit_id text not null`
- `cited_source_hash text not null`
- `cite_ordinal integer not null` — order within the summary's citation list
- Primary key `(scene_summary_id, bridge_unit_id)`
- Index `(bridge_unit_id, cited_source_hash)` — supports the staleness scan
  in §6, which needs to find every summary citing a given bridge unit
  efficiently.

### 5.3 Migration

New SQL migration via existing tooling. Additive only. Runs under `just
db-migrate`.

### 5.4 Repository

`packages/itotori-db/src/repositories/scene-summary-repository.ts`:

- `saveSummary(summary: SceneSummary)` — single transaction; insert into
  both tables. Upserts on the unique key in §5.1 (replacing a prior summary
  for the same scene + template version).
- `loadSummaryByScene({ projectId, localeBranchId, sourceRevisionId,
sceneId })` — returns the latest `Fresh` summary for that scene, or the
  newest `Stale` summary if no `Fresh` exists (so reads still find
  *something* even pre-rerun).
- `loadSummariesByProject(...)` — list, for staleness scans and CLI status.
- `markStale({ summaryId, reason })` — sets `status = 'Stale'`,
  `invalidated_at = now()`, `invalidated_reason = reason`. Idempotent.
- All operations honour the existing `itotori-db` authorization layer.

## 6. Rerun invalidation

The staleness logic lives in
`apps/itotori/src/agents/scene-summary/staleness.ts` and runs in two
documented places:

1. **At batch-planner re-plan.** ITOTORI-018's planner already loads
   `bridge_units` for the current `sourceRevisionId`. We add a single call
   `markStaleSummariesForRevision({ projectId, localeBranchId,
sourceRevisionId })` from the planner's pre-flight step (or, equivalently,
   from `services/project-workflow.ts` immediately before the planner runs).
   The call:
   - Loads all `Fresh` summaries for that triple.
   - For each, loads the current `source_hash` for every `bridge_unit_id`
     in its citation list (a single bulk query).
   - For each `Fresh` summary, compares `citedUnitHashes[i]` to the current
     hash; on any mismatch, calls `markStale({ summaryId, reason:
"source_hash_drift" })`.
2. **At explicit `itotori check-scene-summaries` invocation** (CLI in
   §7) — same logic, no planner needed, for ops/audit.

The hash check is exact-equality; we do not try to "lightly stale" a summary
(e.g. only one unit changed). Any drift -> Stale. This is the conservative
side of "stale summaries surviving source changes" in auditFocus.

When `Batch.context.sceneSummary` is later resolved by the batch planner's
context pack, it must filter to `status = "Fresh"`. If only `Stale` is
available, the planner records the situation in `BatchCitationManifest` as
`details: { sceneSummaryStale: true }` so audits can flag batches whose
scene summary is known stale. (Patch is in `context-pack.ts` — already
listed in §2 as additive.)

We do not auto-regenerate from `markStaleSummariesForRevision`; the operator
re-runs the agent via the CLI (§7). Auto-regeneration is a follow-up node
to keep this PR focused.

## 7. CLI surface

Registered in `apps/itotori/src/agents/scene-summary/cli.ts`, wired
through `cli-handlers.ts`.

### 7.1 Generate

```
itotori generate-scene-summaries \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--model <modelId>] \
  [--provider <provider-family>] \
  [--scene-id <sceneId>] \
  [--include-stale] \
  [--dry-run]
```

Behaviour:

- Resolves the project's `sourceLocale`. Asserts the provider/model exists.
- Loads bridge units for `(project, localeBranchId, sourceRevisionId)`.
- Loads ITOTORI-018 batches for the same triple (the planner is the source
  of truth for scene groupings). For each scene id present in batches:
  - Skips if a `Fresh` summary already exists for that scene + template
    version, unless `--include-stale` is set.
  - When `--scene-id` is set, restricts to that scene id only.
  - Constructs `SceneSummaryInput` from the batch's `units` + the batch's
    `context.glossaryTerms` (already cited there). When a scene spans
    multiple batches (`sceneSplitIndex` > 1), unions their units in batch
    order and passes the prior batch's summary (if any) as `priorSummary`.
- For each input, calls `generateSceneSummary`.
- When not `--dry-run`, calls `saveSummary` per result.
- Prints a per-scene line: `sceneId | unitCount | citedUnits | tokens |
status`.

### 7.2 Check

```
itotori check-scene-summaries \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--mark-stale]
```

Runs the staleness scan from §6. Without `--mark-stale`, prints a diff (lists
summaries whose citations drifted). With `--mark-stale`, applies the
transition.

## 8. Test plan

Tests live under `apps/itotori/src/agents/scene-summary/__tests__/`. Both
plain-Node tests (via `pnpm exec vp run ts:test`) and DB-backed tests (via
the shared `pg-test` harness, matching the pattern used by
`apps/itotori/src/services/scale-harness.ts`).

### 8.1 Fake provider: deterministic summary output round-trip

Use a 5-unit, 1-scene fixture (extend `fixtures/hello-game/` or compose
inline). Inject `FakeModelProvider` with a fixed `generate` callback that
echoes a deterministic summary. Assert:

- `summary.status === "Fresh"`.
- `summary.summaryText` matches the fake provider's output.
- `summary.promptHash` is byte-stable across two calls with the same input.
- `summary.summaryLocale === input.sourceLocale`.

### 8.2 Citations: every summary has cited_unit_ids

Same fixture; assert `summary.citedUnitIds.length === units.length` and
that the ids match the input units' ids in order. Assert
`summary.citedUnitHashes` is index-aligned and non-empty.

### 8.3 Stale detection: change one unit, regenerate batch, summary marked stale

DB-backed test:

1. Generate and persist a summary at `sourceRevisionId = r1`.
2. Mutate one of the cited bridge units' `source_hash` (simulate a new
   ingest; do this by updating the in-DB row directly to model the case
   where the planner re-ran but the summary did not).
3. Call `markStaleSummariesForRevision({...})`.
4. Assert the summary row's `status === "Stale"`, `invalidated_reason ===
"source_hash_drift"`, `invalidated_at` is set.
5. Untouched summaries (different scene) remain `Fresh`.

### 8.4 Source-language: summary locale matches project source locale

Construct a project with `sourceLocale = "ja-JP"` and a target locale
branch with `targetLocale = "en-US"`. Run the agent. Assert
`summary.summaryLocale === "ja-JP"`. Then construct an input whose
`sourceLocale` is the *target* locale by mistake and assert
`generateSceneSummary` throws a typed error before invoking the provider.

### 8.5 Recorded provider replay

Use the `recorded` provider family (per ADR 0002). First run with the
recording sink writes a fixture under `apps/itotori/fixtures/recorded/`.
Second run with the recorded provider replays it. Assert that with no
network access (env-gated `OFFLINE=1`) the replay run still produces a
`Fresh` summary with identical `summaryText` and `promptHash`.

### 8.6 Prompt template version bump invalidates

When the active `PROMPT_TEMPLATE_VERSION` changes (simulated via a
test-only constant), assert that a saved summary at the old version is
treated as effectively absent by `loadSummaryByScene` callers that pass
the new version filter, and that running the agent inserts a *new* row
(unique key in §5.1 includes the version). Existing rows are not
auto-stale-flagged on a version bump unless the staleness scan is called
with `reason: "template_version_bump"`.

### 8.7 Scene spans multiple batches

Use the 200-unit single-scene fixture from ITOTORI-018 §9.4 (or compose
similar). Drive the CLI's generate path: assert the agent is called with
the union of units across the scene's batches in batch order, and that
`priorSummary` is threaded through on the second and later calls.

### 8.8 Glossary cited terms appear in prompt

Assert that every `GlossaryRef` in `input.glossaryExcerpt` appears
verbatim in the constructed prompt (by string-search on the rendered
template) and is part of `promptHash`'s input. Defends "citation
accuracy" (auditFocus).

### 8.9 Persistence round-trip (DB-backed)

`just db-up && just db-migrate && pnpm exec vp run ts:test`:

- Save, load, assert deep-equality of `SceneSummary` (modulo timestamps
  serialized as RFC3339 strings).
- Re-save the same scene at the same template version: assert upsert
  replaces the row and citation rows are rewritten cleanly.

### 8.10 CLI smoke

Invoke `itotori generate-scene-summaries --project ... --locale en-US
--dry-run` with `--provider fake` against the seeded test project; assert
the per-scene status block matches the snapshot. Then invoke `itotori
check-scene-summaries` and assert it returns no stale summaries on the
fresh fixture.

### 8.11 Live provider opt-in only

Add an assertion in the agent module that, when imported, no real-provider
construction happens at import time, and that the CI default
`ITOTORI_LIVE_PROVIDER` env is unset. The test that touches OpenRouter is
guarded by `it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)` and is not
exercised in normal CI. Mirrors how existing OpenRouter tests in
`apps/itotori/src/providers/` are gated.

## 9. Verification commands

- `pnpm exec vp run ts:test` — unit + integration tests for scene-summary.
- `cargo test --workspace` — sanity check; this node is TypeScript-only but
  the assignment requires confirming no Rust regression.
- `just check` — repo-wide type/lint/format.
- `just test` — repo-wide test suite (picks up the new tests).
- `just db-up && just db-migrate && pnpm exec vp run ts:test` — DB-backed
  tests (§8.3, §8.9), and verifies the migration applies cleanly.

## 10. Risks

1. **LLM determinism in CI.** Real provider completions are not byte-stable.
   Mitigation: CI runs `FakeModelProvider` (deterministic by construction)
   and the `recorded` provider replay path. Live OpenRouter calls are
   opt-in only via `ITOTORI_LIVE_PROVIDER`, matching ADR 0002.
2. **Citation accuracy.** A summary could cite units that did not actually
   inform its content. Mitigation: the agent *always* cites the exact
   units it was given as input — `citedUnitIds` is the input set, not a
   model self-report. Test 8.2 makes this a property test.
3. **Prompt template evolution.** Future template changes risk silently
   stale-flagging large numbers of summaries. Mitigation: template version
   is part of the unique key, so a new version coexists with old until
   explicitly invalidated. The staleness scan accepts an explicit
   `reason: "template_version_bump"` so the operator opts in to a sweep.
4. **Provider cost.** Generating summaries per scene at scale costs real
   money. Mitigation: CLI skips scenes that already have a `Fresh`
   summary unless `--include-stale`, and the model profile resolution
   prefers cheap default models. Token estimates are persisted for audit.
5. **Stale summaries surviving source changes.** The §6 hash check is
   exact-equality and runs on every planner re-plan. Test 8.3 covers the
   round-trip; the staleness scan is also exposed via the CLI for ops.
6. **Source-language drift.** §4 validates locale before invocation and
   §8.4 enforces the property in tests; the prompt itself instructs the
   model to summarize "in the same language as the source units" and the
   `summaryLocale` is persisted, so any drift is observable post-hoc.

## 11. Out of scope

- Actual scene boundary detection — handled by ITOTORI-018 via
  `RouteContextV02.sceneId` / fallback grouping.
- ITOTORI-014 character relationships — `BridgeUnitForSummary` carries
  `speaker` so the prompt can name participants, but no relationship
  modelling happens here.
- ITOTORI-016 terminology mining — the agent consumes the glossary excerpt
  the batch planner already cited; it does not propose new terms.
- Live OpenRouter provider in CI.
- Auto-regeneration when summaries go stale (operator runs the CLI;
  auto-regen is a follow-up node).
- Projecting agent summaries into `itotori_context_artifacts` for unified
  reads — deferred to a follow-up that designs the merged read model.
- Reviewer UI for editing summaries.
- Multi-scene cross-references / arc-level summaries.

## 12. Worker scoping

**One worker.** Scope is bounded:

- One new module directory under `apps/itotori/src/agents/scene-summary/`.
- Two new tables + one repository in `packages/itotori-db`.
- One new CLI command pair (`generate-scene-summaries`,
  `check-scene-summaries`) and a small additive patch to
  `batch-planner/context-pack.ts`.
- Tests sized to one focused PR.

No cross-team coordination is required. No parallel slices are needed.

---

## Plan-only confirmation

This document is plan-only. No feature code, no schema migration SQL, no
test files, and no CLI handlers are committed by this PR. The
implementation worker will translate this plan into code, migrations, and
tests in a follow-up branch.
