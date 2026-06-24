# ITOTORI-015 — Route and choice map agent

- **Node**: ITOTORI-015
- **Title**: Route and choice map agent
- **Branch**: `spec/itotori-015`
- **Worktree**: `/scratch/worktrees/itotori-spec-itotori-015`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: planned → ready_for_review (single implementation slice)
- **Dependencies landed**: ITOTORI-013 (scene-summary agent — the pattern
  this slice mirrors), ITOTORI-014 (character-relationship agent — the
  closest precedent for citation + staleness + closed-enum constraints),
  ITOTORI-012 (provider routing + recorded providers), ITOTORI-010
  (project workflow), ITOTORI-018 (batch planner emitting `sceneId` /
  `routeId` groupings), ITOTORI-049 / ITOTORI-052 (bridge-unit + locale
  branch foundations).
- **Direct downstream**: future drafting batches consuming a per-route
  / per-choice context pack; reviewer UIs surfacing branching maps;
  ALPHA-006 vertical slices that need to know which units belong to
  which route.

## 1. Goal restatement

ITOTORI-015 is the third LLM-using context agent in the ALPHA-006
drafting workflow (after ITOTORI-013 scene-summary and ITOTORI-014
character-relationship). It produces a **structured branching
artifact** for each project's current source revision describing:

- the set of named **routes** (story branches) that the source code
  exposes, each citing the exact `bridge_unit_id`s that justify the
  route's boundary;
- the set of **choices** (player-facing decision points), each citing
  the units that surface the choice prompt and the units that the
  choice's options lead to;
- the **route → choice → next-route edges** that connect choices to
  the routes they unlock.

Non-negotiable properties from the assignment + DAG acceptance
criteria:

1. **Citations required.** Every persisted route stores the list of
   `bridge_unit_id`s its boundary draws from. Every persisted choice
   stores the list of `bridge_unit_id`s that surface its prompt + the
   per-option target unit list. Routes or choices without at least
   one cited unit are rejected at write time.
2. **Closed choice taxonomy.** `choice.kind` is drawn from a closed
   enum (see §3.2). The agent cannot mint a new kind without a
   prompt-template version bump.
3. **Rerun invalidation.** On a re-plan (or a direct stale-check
   pass), any route or choice whose `cited_unit_hashes` no longer
   match the current `bridge_units.source_hash` for the same
   `bridge_unit_id` is marked `Stale`.
4. **Unknown route rejection.** A `choice.option.targetRouteId` that
   does not match any emitted route id is rejected at write time
   (defends the audit-focus item "routes referenced but never
   defined").
5. **Source-language output.** Route titles, route summaries, choice
   prompt summaries, and option labels are emitted in the project's
   `sourceLocale`. Never the target locale.
6. **Deterministic prompt construction.** Versioned prompt template
   with the units, prior route map, and curator-declared routes
   (when present) packed in a stable canonical order. Identical
   inputs → identical prompt bytes → identical recorded-fixture
   replay.
7. **CI uses fake / recorded providers only.** Live OpenRouter / live
   provider calls are opt-in via `ITOTORI_LIVE_PROVIDER=1`, matching
   ADR 0002 provider routing and the ITOTORI-013 / 014 posture.

This node does NOT do scene boundary detection (ITOTORI-018), scene
summarization (ITOTORI-013), character modelling (ITOTORI-014),
terminology mining (ITOTORI-016), or target-language drafting. It
consumes the same bridge-unit slice the batch planner already
grouped, plus the planner's `RouteContextV02.routeId` / `sceneId` /
`choiceContext` annotations, and produces a durable, cited,
source-language map of the project's branching structure that
downstream batches reference.

## 2. Module placement

**Recommendation: new directory
`apps/itotori/src/agents/route-choice-map/`** inside the existing
Itotori CLI app, sibling to `agents/scene-summary/` and
`agents/character-relationship/`. Verified layout (mirrors
ITOTORI-013 / 014 verbatim):

```
apps/itotori/src/
  agents/
    scene-summary/             # ITOTORI-013 (landed)
    character-relationship/    # ITOTORI-014 (landed)
    route-choice-map/          # NEW (this slice)
  batch-planner/               # ITOTORI-018 sceneId-grouped batches
  providers/                   # openrouter, fake, recorded, capability-guard
  services/                    # project-workflow, database-services
```

The new module:

```
apps/itotori/src/agents/route-choice-map/
  index.ts            # public surface: generateRouteChoiceMap(...), shapes re-export
  shapes.ts           # RouteMap, RouteChoice, RouteEvidence, ...Input, ...Output,
                      #   error classes, ChoiceKind closed enum
  prompt-template.ts  # versioned template builder; pure function over inputs
  agent.ts            # generateRouteChoiceMap orchestration (provider invocation)
  staleness.ts        # hash check against bridge_units; mark stale
  persistence.ts      # repository-level read/write delegating to itotori-db
  cli.ts              # registers `itotori generate-route-maps` +
                      #   `itotori check-route-maps`
  __tests__/          # unit tests; DB-backed tests via the shared harness
```

Cross-package touch points (kept thin and additive, mirroring
ITOTORI-014's strategy):

- `packages/itotori-db/migrations/0032_route_choice_maps.sql`: new
  migration adding **three tables** — `itotori_route_maps`,
  `itotori_route_choices`, and `itotori_route_evidence`. The
  `itotori_context_artifacts` table is **not** reused (mirrors the
  ITOTORI-013 / 014 reasoning). Migration is purely additive.
- `packages/itotori-db/src/schema.ts`: add the three new tables and
  their enums (`route_map_status`, `route_choice_kind`,
  `route_invalidated_reason`).
- `packages/itotori-db/src/repositories/route-choice-map-repository.ts`:
  new repository; mirrors
  `character-relationship-repository.ts` (same auth posture, same
  `loadByProject` / `saveRoute` / `saveChoice` / `markStale` shape).
- `packages/itotori-db/src/index.ts`: re-export the new repository
  and the new record types.
- `apps/itotori/src/cli-handlers.ts`: register the two new CLI
  commands.
- `apps/itotori/src/batch-planner/context-pack.ts`: extend with a new
  additive helper `routeContextForGroup(...)` so the batch planner
  can later opt in to pack route + choice context into a batch.
  Default behavior unchanged in this slice; the helper exists for
  future use.

No new pnpm workspace member. No new third-party dependency.

## 3. Types

All types live in
`apps/itotori/src/agents/route-choice-map/shapes.ts`. They are the
contract between the agent, persistence, the batch planner, and the
CLI.

### 3.1 `RouteMap`

```ts
export type RouteMapStatus = "Fresh" | "Stale";

export type RouteMap = {
  /** uuid7 — primary key. Deterministic given
   *  (projectId, localeBranchId, sourceRevisionId, routeKey,
   *   promptTemplateVersion). */
  id: Uuid7;

  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;

  /** Stable route key (kebab-style ASCII; e.g. `"true-route"`,
   *  `"sayuri-route"`). Typically the canonical `RouteContextV02.routeKey`
   *  observed in the planner; for curator-added routes, the curator
   *  supplies the key and the agent honors it. Validator rejects
   *  keys that look like local paths. */
  routeKey: string;

  /** Source-language display title (e.g. `"沙友里ルート"`). */
  routeTitle: string;

  /** Locale of `routeTitle` / `routeSummary` / option labels. MUST
   *  equal projects.sourceLocale at write time. */
  mapLocale: Bcp47Locale;

  /** Short source-language description of the route's narrative
   *  span. Cited by the same units in `citedUnitIds`. */
  routeSummary: string;

  /** Bridge units that establish the route's boundary (the units
   *  whose `RouteContextV02.routeKey` matches this route, plus any
   *  units the agent cites as motivating the route name / scope). */
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];

  modelProfile: RouteChoiceMapModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;

  generatedAt: string;
  status: RouteMapStatus;
  invalidatedAt?: string;
  invalidatedReason?:
    | "source_hash_drift"
    | "template_version_bump"
    | "unknown_route_target"
    | "manual";
};
```

### 3.2 `RouteChoice`

```ts
export type ChoiceKind =
  | "RouteBranch"      // selects a route
  | "FlagToggle"       // sets a flag that influences later branching
  | "SceneSelector"    // jumps to a scene within the current route
  | "Cosmetic"         // no narrative effect (e.g. menu reorder)
  | "Other";

export type RouteChoiceOption = {
  /** uuid7 — primary key within the choice. */
  optionId: Uuid7;

  /** Zero-based index in source order. */
  optionIndex: number;

  /** Source-language option label as it appears in the game UI. */
  optionLabel: string;

  /** Optional: the routeKey this option unlocks (when kind ===
   *  "RouteBranch"). MUST match an emitted RouteMap.routeKey for
   *  the same project / locale branch / source revision — agent
   *  validation enforces this. */
  targetRouteKey?: string;

  /** Bridge units the agent cites as the option's narrative
   *  destination (units the player sees after picking this
   *  option). At least one required when kind === "RouteBranch" or
   *  kind === "SceneSelector". */
  targetUnitIds: Uuid7[];
  targetUnitHashes: string[];
};

export type RouteChoice = {
  /** uuid7 — primary key. Deterministic given
   *  (projectId, localeBranchId, sourceRevisionId, choiceKey,
   *   promptTemplateVersion). */
  id: Uuid7;

  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;

  /** Stable choice key — typically `RouteContextV02.choiceContext.choiceKey`
   *  from the planner, or the agent's deterministic derivation
   *  `route:<routeKey>:choice:<index>` when the planner did not
   *  annotate the choice. */
  choiceKey: string;

  /** Closed enum (§3.2 header). */
  kind: ChoiceKind;

  /** Route this choice is offered from. NULL only for "Cosmetic"
   *  choices that appear outside any route. */
  fromRouteKey?: string;

  /** Source-language summary of the choice prompt (what the player
   *  sees + immediate context). */
  promptSummary: string;

  /** Locale of `promptSummary` / option labels. MUST equal
   *  projects.sourceLocale at write time. */
  mapLocale: Bcp47Locale;

  /** Bridge units that surface the choice prompt to the player. */
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];

  /** Options in source order. Length >= 1. */
  options: RouteChoiceOption[];

  modelProfile: RouteChoiceMapModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  generatedAt: string;
  status: RouteMapStatus;
  invalidatedAt?: string;
  invalidatedReason?:
    | "source_hash_drift"
    | "template_version_bump"
    | "unknown_route_target"
    | "manual";
};

export type RouteChoiceMapModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
};
```

### 3.3 Agent IO

```ts
export type RouteChoiceMapInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;

  /** Bridge units in canonical order — full slice the agent should
   *  consider. */
  units: ReadonlyArray<BridgeUnitForRouteMap>;

  /** Curator-declared routes (if any). The agent treats these
   *  routeKeys as authoritative — it never invents a routeKey that
   *  displaces a curator key, and it includes every curator-declared
   *  route in its output (even if the agent finds no cited units —
   *  in which case the agent emits an empty-citation diagnostic and
   *  refuses to persist that route; see §4 step 8). */
  curatedRoutes: ReadonlyArray<CuratedRouteRef>;

  /** Optional prior route + choice map for the same project — when
   *  extending an existing context across revisions. */
  priorMap?: PriorRouteMapRef;

  modelProfile: RouteChoiceMapModelProfile;

  /** Test seam — deterministic clock for generatedAt. */
  now?: () => Date;
};

export type BridgeUnitForRouteMap = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string;

  /** Planner-annotated route context for this unit, if any. */
  routeKey?: string;
  sceneKey?: string;
  choiceContext?: {
    /** Stable choice key from RouteContextV02. */
    choiceKey: string;
    optionIndex?: number;
    routeTargetRef?: string;
  };
};

export type CuratedRouteRef = {
  routeKey: string;
  /** Optional curator-supplied canonical title (source-locale). */
  routeTitle?: string;
};

export type PriorRouteMapRef = {
  routes: ReadonlyArray<{
    routeKey: string;
    routeTitle: string;
    routeSummary: string;
  }>;
  choices: ReadonlyArray<{
    choiceKey: string;
    kind: ChoiceKind;
    promptSummary: string;
    options: ReadonlyArray<{
      optionLabel: string;
      targetRouteKey?: string;
    }>;
  }>;
  promptTemplateVersion: string;
};

export type RouteChoiceMapOutput = {
  routes: RouteMap[];
  choices: RouteChoice[];
  providerRun: ProviderRunRecord;
};
```

`BridgeUnitForRouteMap` extends `BridgeUnitForCharacter` (ITOTORI-014)
with the planner's `routeKey` / `sceneKey` / `choiceContext`
annotations — these are the load-bearing inputs that let the agent
emit cited routes/choices without re-deriving structure from text.

### 3.4 Error classes

```ts
export class RouteUncitedError extends Error { ... }
export class ChoiceUncitedError extends Error { ... }
export class UnknownRouteError extends Error { ... }
export class RouteMapLocaleMismatchError extends Error { ... }
export class RouteMapEmptyInputError extends Error { ... }
export class ChoiceOptionOutOfOrderError extends Error { ... }
```

- `RouteUncitedError` — defends "routes uncited". The agent refuses
  to persist any route whose `citedUnitIds.length === 0`.
- `ChoiceUncitedError` — defends "choices uncited". Same shape, for
  `RouteChoice.citedUnitIds.length === 0`. Also covers the
  per-option case: any `RouteChoiceOption.targetUnitIds.length === 0`
  on a `RouteBranch` / `SceneSelector` kind.
- `UnknownRouteError` — defends "routes referenced but never
  defined". Raised when an option's `targetRouteKey` does not match
  any emitted route in the same generation pass (or any persisted
  Fresh route for the same project / locale / revision).
- `ChoiceOptionOutOfOrderError` — raised when `options[i].optionIndex !== i`
  (forces canonical source order; defends against silently
  re-ordered options causing downstream batch context drift).

Each error class carries a `code` field whose value matches a
semantic constant exported alongside the schema migration so the
DAG-level grep ("itotori.route_choice_map.*") returns all error
paths.

## 4. Agent service

`generateRouteChoiceMap(input: RouteChoiceMapInput, options:
GenerateRouteChoiceMapOptions): Promise<RouteChoiceMapOutput>` in
`agent.ts`. Pipeline:

1. **Validate locale.** Assert `input.sourceLocale` is non-empty.
   `persistence.saveRoute` / `saveChoice` later assert it matches the
   project's `projects.sourceLocale`. Throws
   `RouteMapLocaleMismatchError` on mismatch.
2. **Validate input non-empty.** `input.units.length > 0`. Throws
   `RouteMapEmptyInputError`.
3. **Compute the route set.** Union of (a) `curatedRoutes` keys,
   (b) every `unit.routeKey` observed in `input.units`. Canonicalize
   ordering by string sort. The agent does not invent routeKeys
   outside this set.
4. **Compute the choice set.** From every unit's `choiceContext`,
   collect the unique `choiceKey`s. The agent does not invent
   choiceKeys.
5. **Canonicalize input.** Sort `units` by `(sourceUnitKey,
   occurrenceId)` to match the planner's ordering; sort
   `curatedRoutes` by `routeKey`.
6. **Build prompt** via `prompt-template.ts` (see §4.1). Hash the
   prompt bytes → `promptHash`. Compute `inputTokenEstimate` using
   `itotori-batch-estimator-v1`.
7. **Invoke provider** via the `ModelProvider` interface from
   `providers/types.ts`. Tests inject `FakeModelProvider` (or
   recorded). The provider returns a structured JSON pack
   `{ routes: [...], choices: [...] }`.
8. **Validate output.** For every emitted route:
   - `routeKey` must appear in the computed route set.
   - `citedUnitIds.length > 0` — else `RouteUncitedError`.
   - Every cited unit id is in `input.units`.
   - Every curated route is emitted (curator's routes are
     authoritative); a curated route whose agent-emitted citation
     list is empty raises `RouteUncitedError` BEFORE the persistence
     step.
   For every emitted choice:
   - `choiceKey` must appear in the computed choice set.
   - `kind` is one of the closed enum values.
   - `citedUnitIds.length > 0` — else `ChoiceUncitedError`.
   - `options.length >= 1` and every `options[i].optionIndex === i`.
   - When `kind === "RouteBranch"`: every option's `targetRouteKey`
     must match an emitted route in this pass or a persisted Fresh
     route — else `UnknownRouteError`.
   - When `kind === "RouteBranch"` or `kind === "SceneSelector"`:
     every option's `targetUnitIds.length > 0` — else
     `ChoiceUncitedError`.
9. **Populate citation hashes.** For each cited unit id, look up the
   matching `BridgeUnitForRouteMap.sourceHash` and store in
   `citedUnitHashes` (and `targetUnitHashes` for option targets) in
   matching order.
10. **Construct output records.** With `status = "Fresh"`,
    `generatedAt = (input.now ?? Date.now)().toISOString()`,
    `mapLocale = input.sourceLocale`,
    `promptTemplateVersion = PROMPT_TEMPLATE_VERSION_V1`.

`generateRouteChoiceMaps(inputs: RouteChoiceMapInput[])` is the
batch entry point used by the CLI; it sequences calls one at a time
(provider concurrency is the provider's concern).

### 4.1 Prompt template

`prompt-template.ts` exports `PROMPT_TEMPLATE_VERSION_V1 =
"itotori-route-choice-map-v1"` and `buildPrompt(input)`. The template
is a pure function — same input bytes, same output bytes,
byte-for-byte. Composition:

```
[system]
You are a localization context assistant. Read the supplied units and
return a JSON object naming the routes (story branches) and choices
(player-facing decisions). Use the SAME LANGUAGE as the source units.
Every route MUST cite the unit ids that establish its boundary.
Every choice MUST cite the unit ids that surface the prompt. Every
RouteBranch / SceneSelector option MUST cite the target unit ids.
Choice.kind MUST be one of the closed values in the schema. Do not
invent route keys or choice keys not justified by the supplied
units. Output JSON only, conforming to the schema in the user
message.

[user]
Project source locale: {sourceLocale}
Curated routes: [{routeKey, routeTitle?}, ...]
{priorMap && "Prior map (extend, do not contradict):\n" + JSON.stringify(priorMap)}

Units (canonical order):
[#{idx}] (unitId={bridgeUnitId}, speaker={speaker || "narration"},
routeKey={routeKey || "—"}, sceneKey={sceneKey || "—"},
choiceKey={choiceContext.choiceKey || "—"},
optionIndex={choiceContext.optionIndex || "—"}) {sourceText}
...

Schema (JSON):
{ "routes": [{ "routeKey": "...", "routeTitle": "...",
"routeSummary": "...", "citedUnitIds": ["..."] }, ...],
  "choices": [{ "choiceKey": "...",
"kind": "RouteBranch|FlagToggle|SceneSelector|Cosmetic|Other",
"fromRouteKey": "...", "promptSummary": "...",
"citedUnitIds": ["..."],
"options": [{ "optionIndex": 0, "optionLabel": "...",
"targetRouteKey": "...", "targetUnitIds": ["..."] }, ...] }, ...] }
```

`promptHash = sha256(buildPrompt(input))` — used by tests to confirm
determinism and by audits to spot template drift.

### 4.2 Provider selection

The agent does not import providers directly. The caller (CLI, batch
planner) passes a constructed provider instance via a `provider:
ModelProvider` parameter. Tests inject `FakeModelProvider` or the
recorded-fixture provider. The CLI constructs the provider from
`--model` / env per the existing `cli-handlers.ts` pattern, the same
way ITOTORI-013 / 014 CLIs wire providers up.

This separation keeps the agent unit-testable without provider state
and keeps **live provider calls out of CI by construction** (defends
the audit-focus item "live LLM calls in CI").

## 5. DB persistence

Migration `0032_route_choice_maps.sql` adds three tables.

### 5.1 `itotori_route_maps`

- `route_map_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `route_key text not null`
- `route_title text not null`
- `map_locale text not null`
- `route_summary text not null`
- `model_provider_family text not null`
- `model_id text not null`
- `model_context_window_tokens integer not null`
- `model_max_output_tokens integer`
- `prompt_template_version text not null`
- `prompt_hash text not null`
- `input_token_estimate integer not null`
- `completion_tokens integer not null`
- `status text not null check (status in ('Fresh', 'Stale'))`
- `invalidated_at timestamptz`
- `invalidated_reason text check (... 'source_hash_drift' | 'template_version_bump' | 'unknown_route_target' | 'manual')`
- `generated_at timestamptz not null`
- `created_at timestamptz not null default now()`
- Indexes:
  - `unique (project_id, locale_branch_id, source_revision_id, route_key, prompt_template_version)`
  - `index (project_id, locale_branch_id, source_revision_id, status)`
  - `index (route_key)`

### 5.2 `itotori_route_choices`

- `route_choice_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `choice_key text not null`
- `kind text not null check (kind in ('RouteBranch', 'FlagToggle', 'SceneSelector', 'Cosmetic', 'Other'))`
- `from_route_key text`
- `prompt_summary text not null`
- `map_locale text not null`
- `options jsonb not null` — array of `RouteChoiceOption` records;
  the per-option `targetUnitIds` / `targetUnitHashes` lists live in
  the JSONB blob plus a normalized projection into
  `itotori_route_evidence` (see §5.3) for the staleness scan.
- `model_provider_family text not null`
- `model_id text not null`
- `model_context_window_tokens integer not null`
- `model_max_output_tokens integer`
- `prompt_template_version text not null`
- `prompt_hash text not null`
- `status text not null check (status in ('Fresh', 'Stale'))`
- `invalidated_at timestamptz`
- `invalidated_reason text check (...)`
- `generated_at timestamptz not null`
- `created_at timestamptz not null default now()`
- Indexes:
  - `unique (project_id, locale_branch_id, source_revision_id, choice_key, prompt_template_version)`
  - `index (project_id, locale_branch_id, source_revision_id, status)`
  - `index (choice_key)`
  - `index (from_route_key)`

### 5.3 `itotori_route_evidence`

The shared per-citation evidence table that supports the staleness
scan for both routes and choices (single table because the scan logic
is identical; the polymorphic shape mirrors
`itotori_character_relationship_evidence`).

- `route_evidence_id text primary key`
- `subject_kind text not null check (subject_kind in ('route', 'choice', 'choice_option'))`
- `route_map_id text references itotori_route_maps(route_map_id) on delete cascade`
- `route_choice_id text references itotori_route_choices(route_choice_id) on delete cascade`
- `choice_option_id text` — references a `RouteChoiceOption.optionId`
  embedded in the JSONB; not a FK because options live inside the
  parent row's JSON blob. Index-only.
- `bridge_unit_id text not null`
- `cited_source_hash text not null`
- `cite_ordinal integer not null check (cite_ordinal >= 1)`
- `created_at timestamptz not null default now()`
- Constraint: exactly one of `route_map_id` / `route_choice_id` is
  non-NULL.
- Indexes:
  - `index (route_map_id, bridge_unit_id)`
  - `index (route_choice_id, bridge_unit_id)`
  - `index (bridge_unit_id, cited_source_hash)` — supports the
    staleness scan.

### 5.4 Migration

New SQL migration via existing tooling. Additive only. Runs under
`just db-migrate`.

### 5.5 Repository

`packages/itotori-db/src/repositories/route-choice-map-repository.ts`:

- `saveRoute(actor, route: RouteMapRecord)` — single transaction;
  insert into `itotori_route_maps` + `itotori_route_evidence` rows
  for the route's citations. Upserts on §5.1's unique key.
- `saveChoice(actor, choice: RouteChoiceRecord)` — single
  transaction; insert into `itotori_route_choices` + per-citation +
  per-option-target `itotori_route_evidence` rows. Upserts on §5.2.
- `loadRoutesByProject(actor, { projectId, localeBranchId,
sourceRevisionId })` — list, for staleness scans, CLI status, and
  context-pack lookups.
- `loadChoicesByProject(actor, { ... })` — same.
- `currentSourceHashesForBridgeUnits(actor, { bridgeUnitIds })` —
  reused helper from ITOTORI-013 / 014 repositories; the slice
  imports it.
- `markRouteStale(actor, { routeMapId, reason })`,
  `markChoiceStale(actor, { routeChoiceId, reason })` — idempotent.
- All operations honour the existing `itotori-db` authorization
  layer.

## 6. Rerun invalidation

The staleness logic lives in
`apps/itotori/src/agents/route-choice-map/staleness.ts` and runs in
two documented places:

1. **At project workflow re-plan** (via
   `services/project-workflow.ts`, alongside ITOTORI-013 / 014
   stale-mark hooks). The new
   `markStaleRouteChoiceArtifactsForRevision({ projectId,
localeBranchId, sourceRevisionId })` call:
   - Loads all `Fresh` routes + choices for that triple.
   - For each, loads the current `source_hash` for every cited
     `bridge_unit_id` (reuses the bulk helper).
   - For each `Fresh` record, compares `citedUnitHashes[i]` (and
     per-option `targetUnitHashes[i]`) to the current hash; on any
     mismatch, calls `markRouteStale` / `markChoiceStale` with
     reason `"source_hash_drift"`.
   - Additionally, runs the cross-reference scan: for every Fresh
     choice option with `targetRouteKey` set, asserts a Fresh route
     with that `routeKey` exists for the same triple. If absent,
     marks the choice `Stale` with reason `"unknown_route_target"`.
2. **At explicit `itotori check-route-maps` invocation** (CLI in §7).

The hash check is exact-equality; any drift → Stale. The
cross-reference scan is the structural defense for
"routes referenced but never defined surviving as Fresh after a
re-plan".

## 7. CLI surface

Registered in `apps/itotori/src/agents/route-choice-map/cli.ts`,
wired through `cli-handlers.ts`.

### 7.1 Generate

```
itotori generate-route-maps \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--model <modelId>] \
  [--provider <provider-family>] \
  [--route-key <routeKey>] \
  [--include-stale] \
  [--dry-run]
```

Behaviour:

- Resolves the project's `sourceLocale`. Asserts the provider /
  model exists.
- Loads bridge units for `(project, localeBranchId,
sourceRevisionId)` with planner annotations attached.
- Loads the curator route roster from `itotori_projects` / curator
  source (if absent, the agent infers from observed planner
  `routeKey`s).
- Skips routes / choices that already have a `Fresh` record for the
  current template version unless `--include-stale` is set.
- When `--route-key` is set, restricts to that route (only that
  route + the choices whose `fromRouteKey` matches).
- Calls `generateRouteChoiceMap` once per project (the agent emits
  the full pack in one call so cross-route option-target validation
  can fire on the same generation).
- When not `--dry-run`, calls `saveRoute` and `saveChoice` per
  emitted record.
- Prints a per-route line + a choices count summary.

### 7.2 Check

```
itotori check-route-maps \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--mark-stale]
```

Runs the staleness scan from §6 (hash check + cross-reference scan).
Without `--mark-stale`, prints a diff (records whose citations
drifted, choices with dangling `targetRouteKey`). With
`--mark-stale`, applies the transitions.

## 8. Test plan

Tests live under
`apps/itotori/src/agents/route-choice-map/__tests__/`. Both
plain-Node tests (via `pnpm exec vp run ts:test`) and DB-backed
tests (via the shared `pg-test` harness, matching ITOTORI-013 / 014).

### 8.1 Fake provider: deterministic pack output round-trip

Use an 8-unit, 2-route, 1-choice fixture (compose inline). Inject
`FakeModelProvider` with a fixed `generate` callback that emits a
deterministic pack JSON. Assert:

- Every `route.status === "Fresh"` and `choice.status === "Fresh"`.
- `route.routeSummary`, `choice.promptSummary`, option labels match
  the fake provider's output.
- `route.promptHash` byte-stable across two calls with the same
  input.
- `route.mapLocale === input.sourceLocale` and same for the choice.

### 8.2 Citations: every route and every choice cites at least one unit

Same fixture; assert every `route.citedUnitIds.length > 0` and every
`choice.citedUnitIds.length > 0`. Assert `citedUnitHashes` is
index-aligned and non-empty.

Negative: feed a `FakeModelProvider` that emits a route with
`citedUnitIds: []` and assert `generateRouteChoiceMap` throws
`RouteUncitedError` before any DB write. Same for an empty-cited
choice → `ChoiceUncitedError`. **Headline defense for the
audit-focus items "routes uncited" and "choices uncited".**

### 8.3 Unknown-route rejection

Negative: feed a `FakeModelProvider` that emits a choice option with
`targetRouteKey: "missing-route"` not present in the route output
nor in any persisted Fresh route. Assert `UnknownRouteError`.
**Headline defense for "routes referenced but never defined".**

### 8.4 Closed choice-kind enum rejection

Negative: feed a `FakeModelProvider` that emits a choice with
`kind: "DialogueChoice"` (not in the closed enum). Assert a typed
error before any DB write.

### 8.5 Option ordering

Negative: feed a `FakeModelProvider` that emits a choice with
`options[0].optionIndex === 1`. Assert `ChoiceOptionOutOfOrderError`.

### 8.6 Stale detection: change one unit, run staleness scan, record marked stale

DB-backed test:

1. Generate and persist a pack at `sourceRevisionId = r1`.
2. Mutate one of the cited bridge units' `source_hash` (simulate a
   new ingest; update the DB row directly).
3. Call `markStaleRouteChoiceArtifactsForRevision({...})`.
4. Assert the affected route + choice rows are `status === "Stale"`,
   `invalidated_reason === "source_hash_drift"`,
   `invalidated_at` set.
5. Untouched records (different route / no shared citations) remain
   `Fresh`.

### 8.7 Stale detection: dangling route target

DB-backed test:

1. Generate and persist a pack with a `RouteBranch` choice whose
   option targets `routeKey: "true-route"`.
2. Mark the `"true-route"` `RouteMap` as `Stale` (simulating a
   curator deletion or a re-run that removed the route).
3. Call `markStaleRouteChoiceArtifactsForRevision({...})`.
4. Assert the choice transitions to `Stale` with reason
   `"unknown_route_target"`.

### 8.8 Source-language: route + choice labels match project source locale

Construct a project with `sourceLocale = "ja-JP"`. Run the agent.
Assert every `route.mapLocale === "ja-JP"` and every
`choice.mapLocale === "ja-JP"`. Then construct an input whose
`sourceLocale` is the target locale by mistake and assert
`generateRouteChoiceMap` throws `RouteMapLocaleMismatchError`
before invoking the provider.

### 8.9 Recorded provider replay (CI default)

Use the `recorded` provider family. First run with the recording
sink writes a fixture under
`apps/itotori/fixtures/recorded/route-choice-map/`. Second run with
the recorded provider replays it. Assert that with no network access
(env-gated `OFFLINE=1`) the replay run still produces a `Fresh` pack
with identical record bytes and identical `promptHash`es.

**Live provider opt-in only.** A test under §8.13 asserts that no
real provider construction happens at import time and that the CI
default `ITOTORI_LIVE_PROVIDER` env is unset; live tests are guarded
by `it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)`. **Headline
defense for the audit-focus item "live LLM calls in CI".**

### 8.10 Prompt template version bump

When the active `PROMPT_TEMPLATE_VERSION` changes (simulated via a
test-only constant), assert that saved records at the old version
are treated as effectively absent by `loadRoutesByProject` /
`loadChoicesByProject` callers that pass the new version filter, and
that running the agent inserts new rows (unique key in §5.1 / §5.2
includes the version).

### 8.11 Persistence round-trip (DB-backed)

`just db-up && just db-migrate && pnpm exec vp run ts:test`:

- Save, load, assert deep-equality of `RouteMap` and `RouteChoice`
  (modulo timestamps serialized as RFC3339 strings).
- Re-save the same pack at the same template version: assert upsert
  replaces rows and evidence rows are rewritten cleanly.

### 8.12 CLI smoke

Invoke `itotori generate-route-maps --project ... --locale ja-JP
--dry-run` with `--provider fake` against the seeded test project;
assert the per-route summary block matches the snapshot. Then invoke
`itotori check-route-maps` and assert it returns no stale records
on the fresh fixture.

### 8.13 Live provider opt-in assertion

Add an assertion in the agent module that, when imported, no
real-provider construction happens at import time, and that the CI
default `ITOTORI_LIVE_PROVIDER` env is unset. The test that touches
OpenRouter is guarded by
`it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)` and is not
exercised in normal CI.

## 9. Verification commands

- `pnpm exec vp run ts:test` — unit + integration tests for
  route-choice-map.
- `cargo test --workspace` — sanity check; this node is
  TypeScript-only but the assignment requires confirming no Rust
  regression.
- `just check` — repo-wide type/lint/format.
- `just test` — repo-wide test suite (picks up the new tests).
- `just db-up && just db-migrate && pnpm --filter @itotori/db
test:db` — DB-backed tests (§8.6, §8.7, §8.11), and verifies the
  migration applies cleanly.

## 10. Risks

1. **LLM determinism in CI.** Real provider completions are not
   byte-stable. Mitigation: CI runs `FakeModelProvider` +
   `recorded` replay. Live calls opt-in only via
   `ITOTORI_LIVE_PROVIDER`. Mirrors ITOTORI-013 / 014 posture.
2. **Citation accuracy.** A route / choice could cite units that
   did not actually justify it. Mitigation: §4 step 8 forces every
   record to cite at least one unit from `input.units`; §8.2 makes
   this a property test. A future LLM-judge verifier is a follow-up.
3. **Dangling route targets.** A choice option could point at a
   `targetRouteKey` that does not exist. Mitigation: §4 step 8
   rejects at write time (`UnknownRouteError`); §6 staleness scan
   catches the drift case where a route was removed after the
   choice was persisted.
4. **Closed enum taxonomy drift.** `ChoiceKind` may need extension
   (e.g. `MiniGameOutcome`). Mitigation: enum pinned at the DB
   CHECK constraint + TS type; extension requires a migration +
   template version bump. The slice's posture: keep it small now,
   widen later under per-evidence justification.
5. **Choice key drift across revisions.** Planner-derived
   `choiceKey`s may change if `RouteContextV02` annotations
   change shape. Mitigation: the schema pins `choiceKey` as opaque
   text; the unique key includes `(sourceRevisionId,
   promptTemplateVersion)` so different revisions coexist; the
   staleness scan flags Fresh records whose underlying units
   drifted.
6. **Stale records surviving source changes.** §6 hash check is
   exact-equality and runs on every project re-plan. Tests 8.6 and
   8.7 cover the round-trip; the staleness scan is also exposed
   via the CLI for ops.
7. **Source-language drift.** §4 validates locale before
   invocation; §8.8 enforces the property in tests; the prompt
   itself instructs the model to emit "in the same language as the
   source units" and `mapLocale` is persisted, so any drift is
   observable post-hoc.
8. **Live LLM calls in CI.** §4.2 + §8.9 + §8.13 keep live calls
   opt-in. The recorded provider is the CI default.

## 11. Out of scope

- **Actual scene boundary detection** — ITOTORI-018.
- **Scene summarization** — ITOTORI-013.
- **Character bios + relationships** — ITOTORI-014.
- **Terminology mining** — ITOTORI-016.
- **Target-language drafting.**
- **Live OpenRouter provider in CI.**
- **Auto-regeneration when records go stale** (operator runs the
  CLI; auto-regen is a follow-up node).
- **LLM-judge citation verifier.**
- **Projecting agent records into `itotori_context_artifacts` for
  unified reads.**
- **Reviewer UI for editing routes + choices.**
- **Multi-route narrative arc summaries.**
- **Wiring the new `routeContextForGroup` helper into the batch
  planner's primary path** — helper exists for future use; planner
  does not consume it in this slice.

## 12. Worker scoping

**One worker.** Scope is bounded:

- One new module directory under
  `apps/itotori/src/agents/route-choice-map/`.
- Three new tables + one repository in `packages/itotori-db`.
- One new CLI command pair (`generate-route-maps`,
  `check-route-maps`) and a small additive helper in
  `batch-planner/context-pack.ts`.
- Tests sized to one focused PR, mirroring ITOTORI-013 / 014 PR
  scope.

No cross-team coordination is required. No parallel slices are
needed.

---

## Plan-only confirmation

This document is plan-only. No feature code, no schema migration
SQL, no test files, and no CLI handlers are committed by this PR.
The implementation worker will translate this plan into code,
migrations, and tests in a follow-up branch.
