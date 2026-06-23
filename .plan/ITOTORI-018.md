# ITOTORI-018 — Batch planner and context packer

- **Node**: ITOTORI-018
- **Title**: Batch planner and context packer
- **Branch**: `spec/itotori-018`
- **Worktree**: `/scratch/worktrees/itotori-spec-itotori-018`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: planned -> ready_for_review

## 1. Goal restatement

ITOTORI-018 is the workflow entry point for ALPHA-006 drafting. It takes a
project's `BridgeBundle` (engine-neutral source side from KAIFUU) plus the
project's curated glossary, style guide, and (when available) character map,
and emits a deterministic sequence of **translation batches**. Each batch is a
context pack: a small set of `BridgeUnitRef`s plus the specific glossary
entries, style-guide rules, character relationships, scene summary, and prior
translation examples that motivate them — sized to fit inside the target
model's context window with headroom for the prompt and output.

The planner has three non-negotiable properties from the DAG acceptance
criteria:

1. **Scale-neutral.** A 5-unit fixture produces a single batch with cited
   glossary. A simulated 10K-unit project produces N batches that respect the
   model context cap. The planner does not load the entire game into a single
   prompt at any scale.
2. **Cited context only.** Each batch records exactly which bridge units,
   glossary terms, style-guide rules, character relationships, scene
   summary, and prior examples were packed, and why. No whole-game prompt is
   ever assembled.
3. **Token estimates stored.** Each batch carries a deterministic
   `tokenEstimate` (input pack) and a `tokenBudgetCap`, both persisted, so
   later stages (drafting agents, QA invocation, model ledger) can audit
   sizing and detect drift between estimated and real provider token counts.

The auditFocus areas are all sizing-and-completeness traps: context-window
assumptions (we must not hard-code 200K), overlarge batches (cap enforcement
must hold at scale), and missing relevant context (every glossary/style hit on
a unit must be cited). The plan addresses each below.

This node does NOT call any LLM. Planning is deterministic. LLM-driven
drafting belongs to ITOTORI-013+ context agents downstream.

## 2. Module placement

**Recommendation: new module `apps/itotori/src/batch-planner/` inside the
existing Itotori CLI app, alongside `services/` and `agents/`.**

Survey of the existing layout (verified):

```
apps/itotori/src/
  agents/        # LLM agent registry (context-artifact-tools, glossary-search-tools, ...)
  providers/     # openrouter, local-openai-compatible, fake, capability-guard, types
  services/      # project-workflow.ts, database-services.ts, scale-harness.ts, deterministic-pre-export-qa.ts
  cli.ts, cli-handlers.ts, api-handlers.ts, api-schema.ts, main.ts, server.ts
  style-guide-builder.ts
```

A standalone directory (not a single `services/batch-planner.ts`) is justified
because the planner has several cohesive but distinct concerns that should not
crowd `services/`:

```
apps/itotori/src/batch-planner/
  index.ts              # public surface: planBatches(...), shapes re-export
  shapes.ts             # Batch, BatchContext, BridgeUnitRef, GlossaryRef, ...
  planner.ts            # planBatches orchestration
  scene-grouping.ts     # group bridge units by scene/route boundary
  token-estimator.ts    # deterministic token estimation per language
  context-pack.ts       # glossary/style/character/example assembly
  model-profiles.ts     # built-in model context-window profiles + override hook
  persistence.ts        # repository-level read/write of batches (delegates to itotori-db)
  cli.ts                # registers `itotori plan-batches` handler
  __tests__/            # unit tests; DB-backed tests integrate via the shared harness
```

Cross-package touch points (kept thin and additive):

- `packages/itotori-db/src/schema.ts`: add three new tables —
  `itotori_translation_batches`, `itotori_translation_batch_units`,
  `itotori_translation_batch_context_refs`. Generate migration via the
  existing migration tooling. No changes to existing tables.
- `packages/itotori-db/src/repositories/translation-batch-repository.ts`:
  new repository; mirrors the style of `style-guide-repository.ts`.
- `packages/itotori-db/src/index.ts`: re-export the new repository.
- `apps/itotori/src/services/project-workflow.ts`: optional wire-up to invoke
  `planBatches` from the existing workflow entry — additive, behind a feature
  flag (`--enable-batch-planning`) so this node does not change existing
  workflow semantics for already-shipped slices.

No new pnpm workspace member is required.

## 3. Batch shape

All types live in `apps/itotori/src/batch-planner/shapes.ts`. They are the
contract between the planner, persistence, and downstream drafting/QA stages
(ITOTORI-013+ / ITOTORI-078). The shape is locked to the spec required in the
task — names follow the existing TypeScript camelCase convention for in-memory
types and snake_case for DB columns (matched in §6).

### 3.1 `Batch`

```ts
export type Batch = {
  /** uuid7 — primary key, deterministic given (projectId, localeBranchId, sourceRevisionId, batchOrdinal). */
  id: Uuid7;

  /** Project the batch belongs to. */
  projectId: Uuid7;

  /** Target locale (BCP-47), e.g. "en-US". Sourced from localeBranch. */
  locale: Bcp47Locale;

  /** Locale branch under that project. Allows multiple target locales per project. */
  localeBranchId: Uuid7;

  /** Source revision the planner observed — pins audit. */
  sourceRevisionId: Uuid7;

  /** Ordinal within (projectId, localeBranchId, sourceRevisionId). 1-indexed. */
  batchOrdinal: number;

  /** Bridge units packed into the batch, in stable order (scene/route/sourceUnitKey). */
  units: BridgeUnitRef[];

  /** Cited context that justifies the unit selection. See §3.2. */
  context: BatchContext;

  /**
   * Deterministic token estimate of the full prompt input pack
   * (system + style + glossary + character relationships + scene summary +
   * prior examples + the units themselves). See §5.
   */
  tokenEstimate: number;

  /**
   * Cap used by the planner when it decided to close this batch, derived
   * from `modelProfile.contextWindowTokens * targetFillRatio`. Persisted so
   * audits can replay a "would this batch have fit?" check.
   */
  tokenBudgetCap: number;

  /**
   * If the batch is scene-aligned, the scene id it represents (single scene)
   * or the spanning scene id when one scene was split (with `sceneSplitIndex`).
   * Undefined when the planner had no scene signal.
   */
  sceneId?: string;

  /**
   * Optional split index when a single scene was too large for one batch and
   * was sliced across N batches. 1-indexed; undefined when not split.
   */
  sceneSplitIndex?: number;

  /** Optional route id when present in `RouteContextV02.routeId`. */
  routeId?: string;

  /** Model the planner targeted. Captured so token estimates remain auditable. */
  modelProfile: BatchModelProfile;

  /** RFC3339 instant the planner produced the batch. */
  generatedAt: string;
};
```

### 3.2 `BatchContext`

```ts
export type BatchContext = {
  /** Glossary terms whose surface form (or alias) appears in at least one unit. */
  glossaryTerms: GlossaryRef[];

  /**
   * Style guide rules: always-on rules + category-tagged rules whose
   * category matches at least one unit's textSurface/surfaceKind/policyAction.
   */
  styleGuideRules: StyleRuleRef[];

  /** Characters appearing as speakers in the batch (and their relationships, when known). */
  characterRelationships: CharacterRef[];

  /**
   * Optional scene-level summary (from `contextArtifacts` with
   * `category = "scene_summary"`), keyed by sceneId. May be absent for tiny
   * games or scenes the curator has not yet summarized.
   */
  sceneSummary?: SceneSummaryRef;

  /**
   * Prior translation examples — completed translations of similar units
   * (same speaker / same surfaceKind / same scene). Capped at
   * `priorExampleLimit` (default 5). Sourced from translation memory if
   * available; otherwise empty.
   */
  priorTranslationExamples: ExampleRef[];

  /**
   * Counts and per-source citations recorded so audits can verify "every
   * glossary hit got cited" without re-running the planner.
   */
  citationManifest: BatchCitationManifest;
};
```

### 3.3 Supporting refs

```ts
export type BridgeUnitRef = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
};

export type GlossaryRef = {
  termId: Uuid7;
  termKey: string;
  preferredSourceForm: string;
  preferredTargetForm?: string;
  hitBridgeUnitIds: Uuid7[]; // which units triggered this term's inclusion
};

export type StyleRuleRef = {
  ruleId: string;          // stable across versions; see styleGuideVersions schema
  styleGuideVersionId: Uuid7;
  rulePath?: string;       // dotted path inside the version doc, when present
  inclusionReason: "always_on" | "category_match" | "explicit_pin";
};

export type CharacterRef = {
  termId: Uuid7;            // terminology row with kind = "character_name"
  canonicalName: string;
  relationshipNotes?: string; // free-form, sourced from terminology aliases / context artifacts
  appearsInBridgeUnitIds: Uuid7[];
};

export type SceneSummaryRef = {
  contextArtifactId: Uuid7;
  sceneId: string;
  contentHash: string;
};

export type ExampleRef = {
  bridgeUnitId: Uuid7;        // the prior unit
  translationMemorySegmentId?: Uuid7;
  similarityReason: "same_speaker" | "same_scene" | "same_surfaceKind";
};

export type BatchCitationManifest = {
  glossaryTermCount: number;
  styleRuleCount: number;
  characterCount: number;
  exampleCount: number;
  /**
   * Per-unit citation index. For audit it must hold:
   * for each unit u in batch.units, and for each glossary term t whose
   * source form matches u.sourceText, t is referenced here.
   */
  unitCitations: Array<{
    bridgeUnitId: Uuid7;
    glossaryTermIds: Uuid7[];
    styleRuleIds: string[];
    characterTermIds: Uuid7[];
  }>;
};

export type BatchModelProfile = {
  providerFamily: ProviderFamily;        // re-used from providers/types.ts
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  targetFillRatio: number;               // default 0.7
  promptOverheadTokens: number;          // headroom for system prompt + tool defs
  tokenEstimatorId: string;              // pins which estimator was used
};
```

## 4. Planner inputs

`planBatches(input: PlanBatchesInput): Promise<PlanBatchesOutput>`

```ts
export type PlanBatchesInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;

  /** Engine-neutral source. Loaded via existing project-workflow / bridge ingest. */
  bridgeBundle: BridgeBundle;

  /** Glossary terms for this project + locale branch. May be empty. */
  glossary: ReadonlyArray<TerminologyTermSnapshot>;

  /** Style guide latest version for this locale branch. May be undefined if not yet authored. */
  styleGuide?: StyleGuideVersionSnapshot;

  /**
   * Character map — produced by ITOTORI-014, which is not yet ready as of this
   * plan. The planner degrades gracefully when absent: speaker tags from
   * BridgeUnit are still emitted, but relationship notes are omitted.
   */
  characterMap?: CharacterMapSnapshot;

  /** Scene summaries from contextArtifacts, by sceneId. May be empty. */
  sceneSummaries?: ReadonlyMap<string, SceneSummaryRef>;

  /** Prior translations available for example mining. May be empty. */
  translationMemory?: TranslationMemoryQueryFn;

  /** Model profile to plan against. Default resolved from §5.4. */
  modelProfile?: BatchModelProfile;

  /** Optional explicit override of token cap (clamps modelProfile). */
  maxTokensOverride?: number;

  /** Optional limit on prior examples per batch (default 5). */
  priorExampleLimit?: number;

  /** Deterministic clock for `generatedAt`. Test seam. */
  now?: () => Date;
};

export type PlanBatchesOutput = {
  batches: Batch[];
  summary: {
    batchCount: number;
    totalTokenEstimate: number;
    averageTokenEstimatePerBatch: number;
    minTokenEstimate: number;
    maxTokenEstimate: number;
    scenesSplitCount: number;       // scenes that didn't fit in one batch
    unitsWithoutSceneCount: number; // units lacking RouteContextV02.sceneId
    glossaryHitCount: number;
    modelProfile: BatchModelProfile;
  };
};
```

Notes on each input:

- **BridgeBundle** is consumed engine-neutrally via `BridgeUnit` and the v0.2
  `LocalizationUnitV02` shape when available (via `SurfaceContextV02.route`
  for scene/route signals). The planner never reaches into engine-specific
  asset paths.
- **Glossary** comes from `itotori_terminology_terms` joined with
  `itotori_terminology_aliases`. Snapshot loader lives in the existing
  `repositories/terminology-repository.ts` — planner consumes a precomputed
  snapshot type to keep `planBatches` pure and testable.
- **Style guide** comes from `itotori_style_guides` /
  `itotori_style_guide_versions`. Latest active version per locale branch.
- **Character map (ITOTORI-014)** absence is a first-class state, not an
  error. The planner sets `characterRelationships` to the speaker-only
  projection (canonical name from terminology, no relationship notes).
- **Scene summaries** are loaded from `itotori_context_artifacts` with
  `category = "scene_summary"`. Already present in the schema (verified at
  line 524).
- **Translation memory** is an optional query function rather than a fixed
  list, so the planner can ask "give me up to K examples for (speaker, scene,
  surfaceKind)" without materializing all of TM into memory at scale.

## 5. Heuristics

The planner is a deterministic pipeline of pure passes over the bridge units.
Each pass has a documented invariant so audits and the test plan in §9 can
target it.

### 5.1 Unit canonical ordering

Bridge units are ordered by `(routeId or "", sceneId or "", sourceUnitKey,
occurrenceId)` before any grouping. This makes the planner output stable
across calls and matches the order an extractor would produce.

### 5.2 Scene boundary grouping

Pass over the ordered units, breaking on:

- `RouteContextV02.sceneId` change (primary).
- `RouteContextV02.routeId` change when no `sceneId` is present (secondary).
- `textSurface` transition between `dialogue` and `system` (tertiary, since
  system-text generally has different style rules).

Units lacking any scene/route signal are grouped by `sourceUnitKey` prefix —
matching the convention KAIFUU emits for engines without explicit scene
markers (RPG Maker map ids, KAG `*.ks` filenames). This is the
graceful-degradation path for "engines without explicit scene markers" in
the risks list.

Invariant: every emitted batch carries a `sceneId` or a `sceneId === undefined,
routeId !== undefined` or both `=== undefined`. A batch with both `=== undefined`
must record `sourceUnitKeyPrefix` in its `citationManifest` so the audit can
explain why grouping defaulted.

### 5.3 Pack-and-cap loop

For each scene/route group:

1. Initialize an empty batch with the prelude tokens (system prompt overhead +
   always-on style rules + scene summary if any).
2. Walk the group's units in canonical order. For each unit:
   - Compute incremental cost: tokens for `sourceText`, plus any glossary
     terms newly cited by this unit, plus any style rules newly pulled in by
     category match, plus any prior-example tokens newly pulled in.
   - If `currentTokens + incremental <= tokenBudgetCap`, add the unit.
   - Otherwise, close the current batch and open a new one, carrying the
     **scene's** prelude (so the next batch is still scene-coherent) and
     incrementing `sceneSplitIndex`.
3. Close the final batch for the group.

This loop yields the "scene boundary preserved when possible" invariant: a
scene is only split when its own pack exceeds the budget.

### 5.4 Model profile resolution

`model-profiles.ts` ships built-in profiles for the providers Itotori already
supports (openrouter, local-openai-compatible, fake). Each profile declares
`contextWindowTokens`, `maxOutputTokens`, `targetFillRatio` (default 0.7),
and `promptOverheadTokens` (default 2000).

Resolution order:

1. Caller-supplied `modelProfile` (CLI `--model` or programmatic).
2. Provider descriptor's `capabilities.contextWindowTokens` (already exists in
   `providers/types.ts` at line 84).
3. Built-in profile by `modelId`.
4. Conservative fallback profile: `contextWindowTokens = 128000`,
   `targetFillRatio = 0.5`. This addresses the "model context limit drift" and
   "context-window assumptions" auditFocus items — the planner never silently
   assumes 200K or 1M.

The fallback is conservative on purpose: we would rather emit too many small
batches against an unknown model than overflow it.

`tokenBudgetCap = floor((contextWindowTokens - promptOverheadTokens -
maxOutputTokens) * targetFillRatio)`. Stored on every batch.

### 5.5 Glossary inclusion

For each unit added to a batch, every glossary term whose `preferredSourceForm`
or any alias appears in the unit's `sourceText` is added to the batch's
`context.glossaryTerms`, with the unit recorded under `hitBridgeUnitIds` and
in `unitCitations`.

Invariant (covered by §9 test 5): for every unit `u` in `batch.units` and every
glossary term `t` whose source form/alias matches `u.sourceText`, `t` is in
`batch.context.glossaryTerms` and `u.bridgeUnitId` is in `t.hitBridgeUnitIds`.

For tiny games this guarantees a single batch still ships its cited glossary,
matching the §9 test-1 expectation.

### 5.6 Style guide inclusion

Two passes:

1. **Always-on rules.** Every batch unconditionally includes all rules whose
   `applicability` is `always_on` in the style-guide version document.
2. **Category-tagged rules.** A rule whose category matches any of the
   batch's collected `textSurface` values, `SurfaceKindV02` values, or
   `PolicyActionV02` values is included with reason `"category_match"`.

Inclusion reason is recorded on `StyleRuleRef.inclusionReason` so audits can
verify the always-on guarantee even on tiny single-batch games.

### 5.7 Character relationship inclusion

For each unique speaker observed in the batch (from
`BridgeUnit.speaker` or `SpeakerContextV02.displayName`), look up the
canonical terminology row (kind `character_name`). Include:

- Canonical name.
- Relationship notes — from `characterMap` when available, otherwise from
  `terminologyAliases.metadata` (free-form), otherwise empty.

When `characterMap` is undefined (ITOTORI-014 not yet ready), the planner
still emits speaker entries; it just sets `relationshipNotes` to undefined.
The downstream drafting agent will see "speakers are these N characters" but
not relationship context. This is the documented graceful degradation.

### 5.8 Prior-example mining

If `translationMemory` is provided, query for up to `priorExampleLimit`
(default 5) prior translations matching, in priority order: same speaker +
same scene, same speaker, same surfaceKind. Each example's token cost is
included in the pack-and-cap loop in §5.3, so examples count against the
budget and never blow the cap.

## 6. Token estimation

`token-estimator.ts` ships a deterministic estimator with a stable id
recorded in `BatchModelProfile.tokenEstimatorId`. We do not call a real
tokenizer (no LLM dependency, no extra native module on the install
critical path), but we estimate well enough that the §9 tolerance test holds.

### 6.1 Estimator strategy

Per-language heuristic with documented constants:

- Japanese (CJK-dominant text by code-point analysis): `1 token per
  ~2 source characters` (empirically derived for tiktoken cl100k on Japanese
  game dialogue) — closer to 0.5 chars/token, so the constant is `0.5`.
  Implemented as `ceil(charCount / 2)`.
- English / Latin scripts: `1 token per ~4 characters` (the classic OpenAI
  heuristic).
- Mixed / unknown: use a weighted sum based on CJK code-point fraction.

The classifier uses Unicode block tests (Hiragana, Katakana, CJK Unified
Ideographs, Halfwidth/Fullwidth forms) and is locale-aware via `sourceLocale`.

### 6.2 Pack-level estimate

Per batch, the estimator sums:

- `promptOverheadTokens` (from profile).
- Style-rule body tokens.
- Glossary entry tokens (term key + source form + target form + alias list).
- Character relationship tokens.
- Scene summary body tokens, if present.
- Per-example tokens.
- Per-unit `sourceText` tokens.
- Bookkeeping/JSON-frame overhead constant per unit (default 8 tokens; covers
  the JSON wrapper the drafting agent's prompt template uses).

The result is stored as `Batch.tokenEstimate`.

### 6.3 Estimator id

`tokenEstimatorId = "itotori-batch-estimator-v1"`. When we eventually swap in
a real tokenizer (tiktoken, etc.), we bump the id, never silently change the
function. This is what makes "actual estimate within tolerance of real token
count" auditable across time.

### 6.4 Approaching-cap flag

When `tokenEstimate / tokenBudgetCap > 0.95`, the planner sets
`Batch.context.citationManifest` plus a `Batch`-level `nearCapWarning` flag
(added to shapes; omitted from the §3.1 listing only for brevity) so audits
can spot batches that are running hot. This addresses the overlarge-batches
auditFocus.

## 7. Persistence

Tables added in `packages/itotori-db/src/schema.ts`:

### 7.1 `itotori_translation_batches`

Columns (snake_case; columns mirror the `Batch` shape in §3.1):

- `batch_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `batch_ordinal integer not null`
- `token_estimate integer not null`
- `token_budget_cap integer not null`
- `scene_id text`
- `scene_split_index integer`
- `route_id text`
- `model_provider_family text not null`
- `model_id text not null`
- `model_context_window_tokens integer not null`
- `model_max_output_tokens integer`
- `model_target_fill_ratio numeric(4,3) not null`
- `model_prompt_overhead_tokens integer not null`
- `token_estimator_id text not null`
- `near_cap_warning boolean not null default false`
- `generated_at timestamptz not null`
- Indexes:
  - `unique (project_id, locale_branch_id, source_revision_id, batch_ordinal)`
  - `index (project_id, locale_branch_id, source_revision_id)`
  - `index (scene_id)` where not null

### 7.2 `itotori_translation_batch_units`

- `batch_id text not null references itotori_translation_batches(batch_id) on delete cascade`
- `bridge_unit_id text not null`
- `source_unit_key text not null`
- `source_hash text not null`
- `unit_ordinal integer not null` — order within the batch
- Primary key `(batch_id, bridge_unit_id)`
- Index `(bridge_unit_id)`

### 7.3 `itotori_translation_batch_context_refs`

Polymorphic citation table — one row per cited item.

- `batch_id text not null references itotori_translation_batches(batch_id) on delete cascade`
- `ref_kind text not null` — one of
  `"glossary_term" | "style_rule" | "character" | "scene_summary" |
  "prior_example"`
- `ref_id text not null` — termId / ruleId / contextArtifactId / etc.
- `ref_secondary_id text` — e.g. styleGuideVersionId for style_rule
- `inclusion_reason text not null` — `"hit" | "always_on" | "category_match" |
  "explicit_pin" | "same_speaker" | "same_scene" | "same_surfaceKind"`
- `hit_bridge_unit_ids jsonb` — array of bridge_unit_ids that triggered hits
  (for `"glossary_term"` and `"character"`)
- `details jsonb not null default '{}'::jsonb`
- Primary key `(batch_id, ref_kind, ref_id, coalesce(ref_secondary_id, ''))`
- Index `(ref_kind, ref_id)`

This polymorphic shape avoids three near-empty tables and matches the existing
project convention (e.g. `itotori_context_artifact_source_units`).

### 7.4 Migration

New SQL migration file via the existing migration tooling. Migration is
additive — no changes to existing rows. The migration runs under
`just db-migrate`.

### 7.5 Repository

`packages/itotori-db/src/repositories/translation-batch-repository.ts`:

- `saveBatches(batches: Batch[]): Promise<void>` — single transaction per
  `(projectId, localeBranchId, sourceRevisionId)`. Deletes prior batches for
  that triple, inserts the new ones. Safe to call repeatedly for a re-plan.
- `loadBatches(query): Promise<Batch[]>` — by project, by locale branch, by
  scene, etc.
- `loadBatchById(batchId): Promise<Batch | undefined>`.
- All operations honour the existing `itotori-db` authorization layer.

## 8. CLI surface

Registered in `apps/itotori/src/batch-planner/cli.ts` and wired through
`cli-handlers.ts`.

```
itotori plan-batches \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--model <modelId>] \
  [--provider <provider-family>] \
  [--max-tokens <n>] \
  [--target-fill-ratio <0.1..0.95>] \
  [--prior-example-limit <n>] \
  [--dry-run]
```

Behaviour:

- Loads bridge bundle for `(project, locale's localeBranchId, sourceRevisionId)`
  via the existing project-workflow loader; refuses to run if no current
  source revision exists.
- Loads glossary, style guide, scene summaries, character map.
- Resolves model profile per §5.4.
- Calls `planBatches`.
- When not `--dry-run`, persists batches via the repository.
- Prints the summary block from `PlanBatchesOutput.summary`:

  ```
  Batches planned: 42
  Total tokens (estimated input): 1,830,000
  Average tokens/batch: 43,571
  Min / max tokens: 12,300 / 85,400
  Scenes split across batches: 3
  Units without scene metadata: 0
  Glossary citations: 217
  Model: openrouter / anthropic/claude-haiku  (ctx 200000, cap 134000)
  ```

- Exits non-zero when any batch exceeds `tokenBudgetCap` (defensive — should
  never happen since the loop in §5.3 enforces it, but the CLI verifies).

Programmatic entry: `apps/itotori/src/batch-planner/index.ts` re-exports
`planBatches` and the shapes so the workflow service can call it directly when
the feature flag in §2 is set.

## 9. Test plan

Tests live under `apps/itotori/src/batch-planner/__tests__/`. Both
plain-Node tests (via `pnpm exec vp run ts:test`) and DB-backed tests (via the
existing `pg-test` harness — see how
`apps/itotori/src/services/scale-harness.ts` consumes the shared harness).

### 9.1 Tiny game: 1 batch with cited glossary

Use `fixtures/hello-game/` (5 source units). Assert:

- `batches.length === 1`.
- `batches[0].units.length === 5`.
- `batches[0].context.glossaryTerms` includes every term the fixture's
  glossary has a hit for.
- `batches[0].tokenEstimate < batches[0].tokenBudgetCap`.
- `batches[0].context.styleGuideRules.some(r => r.inclusionReason ===
  "always_on")` — always-on rules are present.

### 9.2 Large game: 10K units respect cap, scene-aware

Use `synthetic-large-project.ts` from `localization-bridge-schema` to generate
a synthetic 10K-unit bridge with explicit scene ids. Assert:

- `batches.length >= 5`.
- For every `b in batches`, `b.tokenEstimate <= b.tokenBudgetCap`.
- For every `b in batches`, `b.context.glossaryTerms.length === 0 ||
  every term has a non-empty hitBridgeUnitIds`.
- Per-scene continuity: when a scene is split, the consecutive batches with
  that `sceneId` share an unbroken `sceneSplitIndex` sequence 1..N.

### 9.3 Scene boundary preserved when possible

Construct a 50-unit fixture with 5 scenes of 10 units each, sized so each
scene fits in a single batch. Assert: 5 batches, one per scene, none split.

### 9.4 Scene split when necessary

Construct one oversized scene (200 units of long text) so the budget forces a
split. Assert:

- All batches for that scene share `sceneId`.
- `sceneSplitIndex` is 1..N strictly increasing.
- All batches respect the cap.
- Each split batch still cites the scene summary and glossary.

### 9.5 Token estimate tolerance (vs real tokenizer)

When `OPENAI_TOKENIZER_AVAILABLE` (gated behind an opt-in env so CI without
the tokenizer still passes), tokenize a sample of batches with `tiktoken
cl100k` and assert `|estimate - actual| / actual <= 0.25`. The plan flags
estimator improvements (real tokenizer) as a follow-up, not blocking ALPHA.

### 9.6 Glossary citation completeness

Property-style test: random bridge with random glossary; for every (unit u,
term t) pair where t's source form appears in u.sourceText, assert that the
batch containing u also contains t in its `glossaryTerms`. Run 100 seeded
randomized cases.

### 9.7 Style rule citation: always-on + category match

Style guide with two always-on rules + two `dialogue`-only rules + two
`system`-only rules. Generate a batch with only `dialogue` units. Assert:

- Both always-on rules present.
- Both `dialogue` rules present, each with `inclusionReason ===
  "category_match"`.
- No `system`-only rules present.

### 9.8 Character map absence (ITOTORI-014 not ready)

Run the planner with `characterMap = undefined`. Assert:

- `characterRelationships` still contains speaker entries (canonical name
  from terminology).
- `relationshipNotes` is undefined for every entry.
- No crash, no warning that is not also recorded in `citationManifest`.

### 9.9 Model profile fallback

Run with a `modelId` not in any profile and no provider descriptor override.
Assert: profile resolves to the conservative 128K / 0.5 fallback, and that
choice is captured in `Batch.modelProfile` so audits can see it.

### 9.10 Persistence round-trip (DB-backed)

`just db-up && just db-migrate && pnpm exec vp run ts:test`:

- Plan, save, load, assert the loaded batches deep-equal the saved batches
  (modulo ordering of context refs, which is stable but documented).
- Re-plan with new bridge: assert prior batches for that triple are deleted
  before insert and the new set replaces them.

### 9.11 CLI smoke

Invoke `itotori plan-batches --project ... --locale en-US --dry-run` against
the seeded test project; assert the summary block matches the snapshot.

## 10. Verification commands

- `pnpm exec vp run ts:test` — unit + integration tests for the batch planner
  module.
- `just check` — repo-wide type/lint/format.
- `just test` — repo-wide test suite (runs the batch-planner tests as part of
  the workspace).
- `just db-up && just db-migrate && pnpm exec vp run ts:test` — DB-backed
  tests (§9.10) against a freshly migrated database. This also verifies the
  migration applies cleanly to a fresh schema.

## 11. Risks

1. **Token estimation accuracy across languages.** The 4-chars/token and
   2-chars/token constants are heuristics. Drift between estimate and real
   provider token counts can push batches over the actual model cap.
   Mitigation: conservative `targetFillRatio = 0.7` default, conservative
   `0.5` fallback for unknown models, `nearCapWarning` flag, and §9.5
   tolerance test gated by tokenizer availability. Long-term follow-up:
   bundle a real tokenizer behind the `tokenEstimatorId` versioning.

2. **Scene boundary detection for engines without explicit scene markers.**
   Some KAIFUU adapters (KAG, RealLive) currently emit `sourceUnitKey` but no
   `RouteContextV02.sceneId`. Mitigation: §5.2 falls back to
   `sourceUnitKey` prefix grouping and records the basis in
   `citationManifest`, so the audit can see which engine left scene metadata
   off. Upstream fix is KAIFUU's responsibility, not this node's.

3. **Character map dependency (ITOTORI-014 not yet ready).** Mitigation: §5.7
   degrades gracefully to speaker-only entries; §9.8 covers the absence path
   as a first-class test. When ITOTORI-014 lands, no schema change is needed
   here — only `relationshipNotes` populates.

4. **Model context limit drift.** Providers change context windows
   (OpenRouter model catalog updates). Mitigation: §5.4 resolution order
   prefers caller-supplied profile, then provider descriptor, then built-in,
   then a conservative fallback — and every batch records the profile it was
   planned against, so audits can replay sizing decisions even after the
   provider catalog changes.

5. **Cited-context completeness regressions under refactors.** The
   §9.6 property test plus the `citationManifest.unitCitations` field make
   missing citations detectable as test failures rather than silent omissions.

6. **Over-eager scene splits inflate batch count.** If a scene barely
   exceeds the cap, naive splitting produces an awkward (large + tiny) pair.
   Mitigation deferred — the simple pack-and-cap loop is enough for ALPHA-006
   and the §11-noted follow-up "balance scene splits" is logged in the
   plan-stage risks register, not implemented here.

## 12. Out of scope

- Actual LLM drafting against a batch. ITOTORI-013+ (context agents) consume
  these batches.
- QA invocation per batch. ITOTORI-078 will read batches and produce QA
  findings.
- UI for batch review / re-plan. Reviewer UI is not part of ALPHA-006.
- Real tokenizer integration. Deferred to a follow-up node that bumps
  `tokenEstimatorId`.
- Batch repair / re-plan in response to QA findings. Belongs to the repair
  loop downstream.
- Cross-project batch reuse (translation memory mining beyond the
  per-batch query function in §5.8). The TM ingest path is its own node.
- ITOTORI-014 character map production. This plan depends on its eventual
  output shape but does not produce it.

## 13. Worker scoping

**One worker.** The scope is bounded:

- One new module directory under `apps/itotori/src/batch-planner/`.
- Three new tables + one repository in `packages/itotori-db`.
- One new CLI command and one optional workflow wire-up flag.
- Tests are sized to one focused PR.

No cross-team coordination is required. No parallel slices are needed.

---

## Plan-only confirmation

This document is plan-only. No feature code, no schema migration SQL, no test
files, and no CLI handlers are committed by this PR. The implementation
worker will translate this plan into code, migrations, and tests in a
follow-up branch.
