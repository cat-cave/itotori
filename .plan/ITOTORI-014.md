# ITOTORI-014 — Character relationship agent

- **Node**: ITOTORI-014
- **Title**: Character relationship agent
- **Branch**: `spec/itotori-014`
- **Worktree**: `/scratch/worktrees/itotori-spec-itotori-014`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: planned → ready_for_review (single implementation slice)
- **Dependencies landed**: ITOTORI-013 (scene-summary agent — the pattern
  this slice mirrors), ITOTORI-012 (provider routing + recorded providers),
  ITOTORI-010 (project workflow), ITOTORI-049 / ITOTORI-052 (bridge unit
  + locale branch foundations).
- **Direct downstream**: future drafting batches that need a character bio
  + relationship pack alongside the scene summary; ITOTORI-016 terminology
  mining (relationship surface informs glossary candidate terms).

## 1. Goal restatement

ITOTORI-014 is the second LLM-using context agent in the ALPHA-006
drafting workflow (the first is ITOTORI-013 scene-summary). It produces a
**source-language character bio + relationship artifact** for each
character that appears in the bridge units of a project's current source
revision, with **every claimed bio fact and every claimed relationship
edge citing the exact `bridge_unit_id`s that motivated it**, persisted
alongside their `source_hash`es so any later source change marks the
relationship artifact stale.

Non-negotiable properties from the assignment and the DAG acceptance
criteria:

1. **Citations required.** Every persisted character record stores the
   list of `bridge_unit_id`s its bio facts cite. Every persisted
   relationship edge stores the list of `bridge_unit_id`s that justify
   the edge. Edges without at least one cited unit are rejected at write
   time.
2. **Rerun invalidation.** On a re-plan (or a direct stale-check pass),
   any character record or relationship edge whose
   `cited_unit_hashes` no longer match the current
   `itotori_source_units.source_hash` (or `bridge_units.source_hash`)
   for the same `bridge_unit_id` is marked `Stale`.
3. **Source-language output.** Bio sentences and relationship descriptors
   are emitted in the project's `sourceLocale` (e.g. `ja-JP`). Never the
   target locale.
4. **Deterministic prompt construction.** Versioned prompt template with
   the units, the character roster, and any prior bios packed in a stable
   canonical order. Identical inputs → identical prompt bytes → identical
   recorded-fixture replay.
5. **CI uses fake / recorded providers only.** Live OpenRouter / live
   provider calls are opt-in via `ITOTORI_LIVE_PROVIDER=1`, matching ADR
   0002 provider routing and the ITOTORI-013 posture.

This node does NOT do scene boundary detection (ITOTORI-018), scene
summarization (ITOTORI-013), terminology mining (ITOTORI-016), or
target-language drafting (later in ALPHA-006). It consumes the same
bridge-unit slice the batch planner already grouped, plus the existing
project-level character roster, and converts each character's appearance
footprint into a durable, cited, source-language bio + relationship
artifact that downstream batches reference.

## 2. Module placement

**Recommendation: new directory `apps/itotori/src/agents/character-relationship/`
inside the existing Itotori CLI app, sitting sibling to
`agents/scene-summary/`, `batch-planner/`, and `agents/`.** Verified
layout (mirrors ITOTORI-013 verbatim):

```
apps/itotori/src/
  agents/
    scene-summary/         # ITOTORI-013 (landed)
    character-relationship/  # NEW (this slice)
  batch-planner/           # ITOTORI-018 sceneId-grouped batches
  providers/               # openrouter, fake, recorded, capability-guard
  services/                # project-workflow, database-services
```

The new module:

```
apps/itotori/src/agents/character-relationship/
  index.ts               # public surface: generateCharacterRelationships(...), shapes re-export
  shapes.ts              # CharacterBio, CharacterRelationship, ...Input, ...Output, error classes
  prompt-template.ts     # versioned template builder; pure function over inputs
  agent.ts               # generateCharacterRelationships orchestration (provider invocation)
  staleness.ts           # hash check against bridge_units / source_units; mark stale
  persistence.ts         # repository-level read/write delegating to itotori-db
  cli.ts                 # registers `itotori generate-character-relationships` + `check-character-relationships`
  __tests__/             # unit tests; DB-backed tests via the shared harness
```

Cross-package touch points (kept thin and additive, mirroring
ITOTORI-013's strategy):

- `packages/itotori-db/migrations/0031_character_relationships.sql`: new
  migration adding two tables — `itotori_character_relationships` and
  `itotori_character_relationship_evidence` — and one supporting table
  for the bio side, `itotori_character_bios`. The
  `itotori_context_artifacts` table is **not** reused (mirrors ITOTORI-013's
  reasoning: context-artifacts intentionally store free-form
  curator-authored notes with `producedByAgent` provenance and no
  machine-managed staleness lifecycle). Migration is purely additive; no
  existing rows are touched.
- `packages/itotori-db/src/schema.ts`: add the three new tables.
- `packages/itotori-db/src/repositories/character-relationship-repository.ts`:
  new repository; mirrors `scene-summary-repository.ts` (same auth posture,
  same `loadByProject` / `saveBio` / `saveRelationship` / `markStale`
  shape).
- `packages/itotori-db/src/index.ts`: re-export the new repository and
  the new record types.
- `apps/itotori/src/cli-handlers.ts`: register the two new CLI commands.
- `apps/itotori/src/batch-planner/context-pack.ts`: extend
  `characterContextForGroup` (additive new helper) so the batch planner
  can later opt in to pack character bios + relationships into a batch's
  context. Default behavior unchanged in this slice — the helper exists
  but is not wired into the planner's primary path until a follow-up.

No new pnpm workspace member is required. No new third-party dependency
is introduced.

## 3. Types

All types live in
`apps/itotori/src/agents/character-relationship/shapes.ts`. They are the
contract between the agent, persistence, the batch planner, and the CLI.

### 3.1 `CharacterBio`

```ts
export type CharacterRelationshipStatus = "Fresh" | "Stale";

export type CharacterBio = {
  /** uuid7 — primary key. Deterministic given
   *  (projectId, localeBranchId, sourceRevisionId, characterId, promptTemplateVersion). */
  id: Uuid7;

  /** Project the bio belongs to. */
  projectId: Uuid7;

  /** Locale branch under that project (target side). The bio text is in
   *  the project's source locale, but it is scoped per locale branch so
   *  a re-translation into a different target can have a different bio
   *  drafted with different glossary preferences. */
  localeBranchId: Uuid7;

  /** Source revision the agent observed. Pins audit. */
  sourceRevisionId: Uuid7;

  /** Stable character identifier — typically the canonical speaker key
   *  observed in BridgeUnit.speaker for the character's first
   *  appearance, or a curator-promoted alias. Never a host path. */
  characterId: string;

  /** Locale of `bioText`. MUST equal projects.sourceLocale at write time. */
  bioLocale: Bcp47Locale;

  /** Source-language bio text the agent produced. */
  bioText: string;

  /** Bridge units the agent was given as context (every unit where the
   *  character appeared as speaker or addressee). Canonical order. */
  citedUnitIds: Uuid7[];

  /** Source hashes for citedUnitIds at the moment of generation, indexed
   *  identically. Mismatch on later staleness check → Stale. */
  citedUnitHashes: string[];

  /** Provider + model the agent invoked. */
  modelProfile: CharacterRelationshipModelProfile;

  /** Prompt template version id; bump on any template change. */
  promptTemplateVersion: string;

  /** Hash of the constructed prompt bytes — lets audit re-derive inputs. */
  promptHash: string;

  inputTokenEstimate: number;
  completionTokens: number;

  generatedAt: string;
  status: CharacterRelationshipStatus;
  invalidatedAt?: string;
  invalidatedReason?:
    | "source_hash_drift"
    | "template_version_bump"
    | "manual";
};
```

### 3.2 `CharacterRelationship`

```ts
export type RelationshipDirection = "Symmetric" | "FromAToB";

export type CharacterRelationship = {
  /** uuid7 — primary key. Deterministic given
   *  (projectId, localeBranchId, sourceRevisionId, fromCharacterId,
   *   toCharacterId, kind, promptTemplateVersion). */
  id: Uuid7;

  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;

  /** Stable id of the "from" character. */
  fromCharacterId: string;
  /** Stable id of the "to" character. */
  toCharacterId: string;

  /** Engine-neutral relationship kind, drawn from a closed enum. Adding
   *  a new kind is a prompt-template version bump (or a deliberate
   *  follow-up node) so the wire shape stays auditable. */
  kind:
    | "FamilyRelation"
    | "Romantic"
    | "Friendship"
    | "Mentor"
    | "Rivalry"
    | "Allegiance"
    | "Antagonism"
    | "Other";

  /** Direction: `Symmetric` for kinds that are bi-directional (e.g.
   *  friendship), `FromAToB` for asymmetric ones (e.g. mentor → student). */
  direction: RelationshipDirection;

  /** Source-language descriptor (short phrase) that names the
   *  relationship concretely, e.g. 主人公の妹 / 幼馴染 / 上司. MUST be in
   *  projects.sourceLocale at write time. */
  descriptor: string;

  /** Bridge units that motivated this edge (NOT the union of both
   *  characters' citations; the specific units that established the
   *  relationship). Canonical order. */
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];

  modelProfile: CharacterRelationshipModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  generatedAt: string;
  status: CharacterRelationshipStatus;
  invalidatedAt?: string;
  invalidatedReason?:
    | "source_hash_drift"
    | "template_version_bump"
    | "manual";
};

export type CharacterRelationshipModelProfile = {
  providerFamily: ProviderFamily; // re-used from providers/types.ts
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
};
```

### 3.3 Agent IO

```ts
export type CharacterRelationshipInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;

  /** Bridge units in canonical order — the full slice the agent should
   *  consider when extracting characters and their relationships. */
  units: ReadonlyArray<BridgeUnitForCharacter>;

  /** Curator-promoted character roster (if any). The agent treats these
   *  ids as authoritative — it will not invent aliases that displace
   *  curator names. */
  curatedCharacters: ReadonlyArray<CuratedCharacterRef>;

  /** Glossary slice the planner already cited. Trimmed to terms whose
   *  source form appears in `units`. */
  glossaryExcerpt: ReadonlyArray<GlossaryRef>;

  /** Optional prior bio + relationship pack for the same project — when
   *  extending an existing context across revisions. */
  priorPack?: PriorCharacterPackRef;

  modelProfile: CharacterRelationshipModelProfile;

  /** Test seam — deterministic clock for generatedAt. */
  now?: () => Date;
};

export type BridgeUnitForCharacter = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string;
  /** Optional addressees the bridge layer surfaces (e.g. observed via
   *  the recipient/target field on a unit). The agent does not invent
   *  addressees — it consumes what the bridge layer recorded. */
  addressees?: ReadonlyArray<string>;
};

export type CuratedCharacterRef = {
  characterId: string;
  /** Optional curator-supplied canonical display name (source-locale). */
  displayName?: string;
};

export type PriorCharacterPackRef = {
  bios: ReadonlyArray<{ characterId: string; bioText: string }>;
  relationships: ReadonlyArray<{
    fromCharacterId: string;
    toCharacterId: string;
    kind: CharacterRelationship["kind"];
    descriptor: string;
  }>;
  promptTemplateVersion: string;
};

export type CharacterRelationshipOutput = {
  bios: CharacterBio[];
  relationships: CharacterRelationship[];
  providerRun: ProviderRunRecord;
};
```

Choosing `BridgeUnitForCharacter` (not the full `BridgeUnit`) keeps the
agent engine-neutral — the batch planner has already done the
engine-specific bridge construction upstream. The `addressees` field is
the only new field over `BridgeUnitForSummary` from ITOTORI-013; it is
optional so units without addressee tracking still flow through.

### 3.4 Error classes

```ts
export class CharacterRelationshipLocaleMismatchError extends Error { ... }
export class CharacterRelationshipEmptyInputError extends Error { ... }
export class CharacterRelationshipUncitedEdgeError extends Error { ... }
export class CharacterRelationshipUnknownCharacterError extends Error { ... }
```

The `UncitedEdgeError` defends the audit-focus item "relationships
uncited" structurally: the agent's validation step refuses to persist any
relationship whose `citedUnitIds.length === 0`. The
`UnknownCharacterError` defends against the agent inventing
`fromCharacterId` / `toCharacterId` values that do not appear in either
`curatedCharacters` or the speaker / addressee fields of the input
units.

## 4. Agent service

`generateCharacterRelationships(input: CharacterRelationshipInput,
options: GenerateCharacterRelationshipsOptions):
Promise<CharacterRelationshipOutput>` in `agent.ts`. Pipeline:

1. **Validate locale.** Assert `input.sourceLocale` is non-empty.
   `persistence.saveBio`/`saveRelationship` later assert it matches the
   project's `projects.sourceLocale`. The agent refuses to run if the
   caller passed a target locale by mistake (defends the audit-focus
   "target-language drift" item, mirrors the ITOTORI-013 posture).
2. **Validate input non-empty.** `input.units.length > 0` and at least one
   unit has a non-empty `speaker` or `addressees`. Empty input throws
   `CharacterRelationshipEmptyInputError`.
3. **Compute character roster.** Union of (a) `curatedCharacters` ids,
   (b) every `speaker` value observed in `units`, (c) every `addressees`
   value observed in `units`. Canonicalize ordering by string sort. The
   agent does not invent characters outside this roster.
4. **Canonicalize input.** Sort `units` by `(sourceUnitKey,
   occurrenceId)` to match the planner's ordering; sort
   `glossaryExcerpt` by `termKey`; sort `curatedCharacters` by
   `characterId`.
5. **Build prompt** via `prompt-template.ts` (see §4.1). Hash the prompt
   bytes → `promptHash`. Compute `inputTokenEstimate` using the same
   estimator the batch planner uses (`itotori-batch-estimator-v1`).
6. **Invoke provider** via the existing `ModelProvider` interface from
   `providers/types.ts`. Family is set by `input.modelProfile.providerFamily`
   — in CI tests this is `"fake"` or `"recorded"`; in real runs it can be
   `"openrouter"` or `"local-openai-compatible"`. The provider's
   capability-guard runs as usual.
7. **Parse provider output.** The provider returns a structured JSON
   pack (the prompt instructs JSON output for parseability). Parse into a
   transient `{ bios: ..., relationships: ... }` shape. Failed parse
   throws a typed error.
8. **Validate output.** For every emitted bio:
   - `characterId` must appear in the computed roster — else
     `UnknownCharacterError`.
   - `citedUnitIds.length > 0` and every cited id is in `input.units`.
   For every emitted relationship:
   - Both `fromCharacterId` and `toCharacterId` must appear in the
     roster.
   - `citedUnitIds.length > 0` — else `UncitedEdgeError`.
   - Every cited unit id is in `input.units`.
   - `kind` is one of the closed enum values.
9. **Populate citation hashes.** For each cited unit id, look up the
   matching `BridgeUnitForCharacter.sourceHash` and store it in the
   bio's / relationship's `citedUnitHashes` in matching order.
10. **Construct output records.** With `status = "Fresh"`,
    `generatedAt = (input.now ?? Date.now)().toISOString()`,
    `bioLocale = input.sourceLocale`, `descriptor` rendered in source
    locale, `promptTemplateVersion = PROMPT_TEMPLATE_VERSION_V1`.

`generateCharacterRelationshipsBatch(inputs:
CharacterRelationshipInput[])` is the batch entry point used by the CLI;
it sequences `generateCharacterRelationships` calls one at a time
(provider concurrency is the provider's concern).

### 4.1 Prompt template

`prompt-template.ts` exports `PROMPT_TEMPLATE_VERSION_V1 =
"itotori-character-relationship-v1"` and `buildPrompt(input)`. The
template is a pure function — same input bytes, same output bytes,
byte-for-byte. Composition:

```
[system]
You are a localization context assistant. Read the supplied units and
return a JSON object naming every character who appears and the
relationships between them. Use the SAME LANGUAGE as the source units.
Each bio sentence MUST cite the unit ids it draws from. Each
relationship MUST cite the unit ids that establish it. Do not invent
characters or relationships not justified by the supplied units. Output
JSON only, conforming to the schema in the user message.

[user]
Project source locale: {sourceLocale}
Curator-promoted characters: [{characterId, displayName?}, ...]
{priorPack && "Prior pack (extend, do not contradict):\n" + JSON.stringify(priorPack)}

Glossary excerpts (canonical names; preserve these):
- {termKey}: {preferredSourceForm}
...

Units (canonical order):
[#{idx}] (unitId={bridgeUnitId}, speaker={speaker || "narration"},
addressees={addressees || "—"}) {sourceText}
...

Schema (JSON):
{ "bios": [{ "characterId": "...", "bioText": "...",
"citedUnitIds": ["..."] }, ...],
  "relationships": [{ "fromCharacterId": "...", "toCharacterId": "...",
"kind": "FamilyRelation|Romantic|Friendship|Mentor|Rivalry|Allegiance|Antagonism|Other",
"direction": "Symmetric|FromAToB",
"descriptor": "...",
"citedUnitIds": ["..."] }, ...] }
```

`promptHash = sha256(buildPrompt(input))` — used by tests to confirm
determinism and by audits to spot template drift.

The template version constant lives in `prompt-template.ts` and is
referenced from the schema migration's seed comment so reviewers can
spot template bumps in diffs.

### 4.2 Provider selection

The agent does not import providers directly. The caller (CLI, batch
planner) passes a constructed provider instance via a `provider:
ModelProvider` parameter. Tests inject `FakeModelProvider` or the
recorded-fixture provider (see §9.5). The CLI constructs the provider
from `--model` / env per the existing `cli-handlers.ts` pattern, the
same way ITOTORI-013's scene-summary CLI already wires providers up.

This separation keeps the agent unit-testable without provider state and
keeps **live provider calls out of CI by construction** (defends the
audit-focus item "live LLM calls in CI").

## 5. DB persistence

Migration `0031_character_relationships.sql` adds three tables. (The
migration number assumes `0030_engine_capability_reports.sql` is the
latest committed migration; the implementation worker bumps to the next
free integer at write time.)

### 5.1 `itotori_character_bios`

- `character_bio_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `character_id text not null`
- `bio_locale text not null`
- `bio_text text not null`
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
- `invalidated_reason text check (... 'source_hash_drift' | 'template_version_bump' | 'manual')`
- `generated_at timestamptz not null`
- `created_at timestamptz not null default now()`
- Indexes:
  - `unique (project_id, locale_branch_id, source_revision_id, character_id, prompt_template_version)`
  - `index (project_id, locale_branch_id, source_revision_id, status)`
  - `index (character_id)`

### 5.2 `itotori_character_relationships`

- `character_relationship_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `from_character_id text not null`
- `to_character_id text not null`
- `kind text not null check (kind in ('FamilyRelation', 'Romantic', 'Friendship', 'Mentor', 'Rivalry', 'Allegiance', 'Antagonism', 'Other'))`
- `direction text not null check (direction in ('Symmetric', 'FromAToB'))`
- `descriptor text not null`
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
  - `unique (project_id, locale_branch_id, source_revision_id, from_character_id, to_character_id, kind, prompt_template_version)`
  - `index (project_id, locale_branch_id, source_revision_id, status)`
  - `index (from_character_id)`
  - `index (to_character_id)`

### 5.3 `itotori_character_relationship_evidence`

- `character_relationship_id text not null references itotori_character_relationships(character_relationship_id) on delete cascade`
- `bridge_unit_id text not null`
- `cited_source_hash text not null`
- `cite_ordinal integer not null check (cite_ordinal >= 1)`
- `created_at timestamptz not null default now()`
- Primary key `(character_relationship_id, bridge_unit_id)`
- Index `(bridge_unit_id, cited_source_hash)` — supports the staleness
  scan in §6.

A parallel table `itotori_character_bio_evidence` follows the same shape
keyed on `character_bio_id`. (Two tables rather than one polymorphic
table so foreign-key cascades stay clean.)

### 5.4 Migration

New SQL migration via existing tooling. Additive only. Runs under
`just db-migrate`.

### 5.5 Repository

`packages/itotori-db/src/repositories/character-relationship-repository.ts`:

- `saveBio(actor, bio: CharacterBioRecord)` — single transaction;
  insert into both bio + evidence tables. Upserts on the unique key in
  §5.1.
- `saveRelationship(actor, rel: CharacterRelationshipRecord)` — single
  transaction; insert into both relationship + evidence tables. Upserts
  on the unique key in §5.2.
- `loadBioByCharacter(actor, { projectId, localeBranchId,
sourceRevisionId, characterId })` — returns the latest `Fresh` bio if
  any; otherwise the newest `Stale` bio for fallback reads.
- `loadRelationshipsByProject(actor, { projectId, localeBranchId,
sourceRevisionId })` — list, for staleness scans and CLI status.
- `currentSourceHashesForBridgeUnits(actor, { bridgeUnitIds })` —
  reused from ITOTORI-013's scene-summary repository pattern; the
  shared helper already exists, so this slice imports it.
- `markBioStale(actor, { bioId, reason })`,
  `markRelationshipStale(actor, { relationshipId, reason })` —
  idempotent.
- All operations honour the existing `itotori-db` authorization layer.

## 6. Rerun invalidation

The staleness logic lives in
`apps/itotori/src/agents/character-relationship/staleness.ts` and runs
in two documented places:

1. **At project workflow re-plan** (via `services/project-workflow.ts`,
   the same place ITOTORI-013's `markStaleSummariesForRevision` hook
   runs). The new
   `markStaleCharacterArtifactsForRevision({ projectId,
localeBranchId, sourceRevisionId })` call:
   - Loads all `Fresh` bios + relationships for that triple.
   - For each, loads the current `source_hash` for every cited
     `bridge_unit_id` (bulk query, reused helper from §5.5).
   - For each `Fresh` record, compares `citedUnitHashes[i]` to the
     current hash; on any mismatch, calls the matching
     `markBioStale` / `markRelationshipStale` with reason
     `"source_hash_drift"`.
2. **At explicit `itotori check-character-relationships` invocation**
   (CLI in §7) — same logic, no planner needed, for ops + audit.

The hash check is exact-equality; any drift → Stale. This is the
conservative side of the audit-focus item "stale relationships
surviving source changes".

## 7. CLI surface

Registered in
`apps/itotori/src/agents/character-relationship/cli.ts`, wired through
`cli-handlers.ts`.

### 7.1 Generate

```
itotori generate-character-relationships \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--model <modelId>] \
  [--provider <provider-family>] \
  [--character-id <characterId>] \
  [--include-stale] \
  [--dry-run]
```

Behaviour:

- Resolves the project's `sourceLocale`. Asserts the provider / model
  exists.
- Loads bridge units for `(project, localeBranchId, sourceRevisionId)`.
- Loads the curator character roster from `itotori_projects` / the
  appropriate curator-managed source (if absent, the roster is computed
  from observed speakers).
- Skips characters that already have a `Fresh` bio for the current
  template version unless `--include-stale` is set.
- When `--character-id` is set, restricts to that character only.
- Calls `generateCharacterRelationships` once per project (the agent
  emits the full pack in one call so cross-character relationships can
  be detected).
- When not `--dry-run`, calls `saveBio` and `saveRelationship` per
  emitted record.
- Prints a per-character line and a relationships count summary.

### 7.2 Check

```
itotori check-character-relationships \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--mark-stale]
```

Runs the staleness scan from §6. Without `--mark-stale`, prints a diff
(records whose citations drifted). With `--mark-stale`, applies the
transition.

## 8. Test plan

Tests live under
`apps/itotori/src/agents/character-relationship/__tests__/`. Both
plain-Node tests (via `pnpm exec vp run ts:test`) and DB-backed tests
(via the shared `pg-test` harness, matching the pattern used by
ITOTORI-013).

### 8.1 Fake provider: deterministic pack output round-trip

Use a 6-unit, 2-character fixture (compose inline). Inject
`FakeModelProvider` with a fixed `generate` callback that emits a
deterministic pack JSON. Assert:

- Every `bio.status === "Fresh"` and `relationship.status === "Fresh"`.
- `bio.bioText` and `relationship.descriptor` match the fake provider's
  output.
- `bio.promptHash` and `relationship.promptHash` are byte-stable across
  two calls with the same input (each record carries the same prompt
  hash because they all came from one provider invocation).
- `bio.bioLocale === input.sourceLocale` and the same for the
  relationship `descriptor` locale.

### 8.2 Citations: every bio and every relationship cites at least one unit

Same fixture; assert every `bio.citedUnitIds.length > 0` and every
`relationship.citedUnitIds.length > 0`. Assert
`citedUnitHashes` is index-aligned and non-empty.

Negative: feed a `FakeModelProvider` that emits a relationship with
`citedUnitIds: []` and assert `generateCharacterRelationships` throws
`CharacterRelationshipUncitedEdgeError` before any DB write happens.
**This is the headline defense for the audit-focus item "relationships
uncited".**

### 8.3 Unknown-character rejection

Negative: feed a `FakeModelProvider` that emits a bio for a character
id not present in the input roster (neither curated nor observed in
unit speakers / addressees). Assert
`CharacterRelationshipUnknownCharacterError`.

### 8.4 Stale detection: change one unit, run staleness scan, record marked stale

DB-backed test:

1. Generate and persist a pack at `sourceRevisionId = r1`.
2. Mutate one of the cited bridge units' `source_hash` (simulate a new
   ingest; update the in-DB row directly).
3. Call `markStaleCharacterArtifactsForRevision({...})`.
4. Assert the affected bio + relationship rows are `status === "Stale"`,
   `invalidated_reason === "source_hash_drift"`, `invalidated_at` is set.
5. Untouched records (different character / no shared citations) remain
   `Fresh`.

### 8.5 Source-language: bio + descriptor locale matches project source locale

Construct a project with `sourceLocale = "ja-JP"` and a target locale
branch with `targetLocale = "en-US"`. Run the agent. Assert every
`bio.bioLocale === "ja-JP"`. Then construct an input whose
`sourceLocale` is the target locale by mistake and assert
`generateCharacterRelationships` throws
`CharacterRelationshipLocaleMismatchError` before invoking the provider.

### 8.6 Recorded provider replay (CI default)

Use the `recorded` provider family (per ADR 0002 and ITOTORI-012's
`RecordedFakeProvider`). First run with the recording sink writes a
fixture under `apps/itotori/fixtures/recorded/character-relationship/`.
Second run with the recorded provider replays it. Assert that with no
network access (env-gated `OFFLINE=1`) the replay run still produces a
`Fresh` pack with identical record bytes and identical `promptHash`es.

**Live provider opt-in only.** A test under §8.10 asserts that no real
provider construction happens at import time and that the CI default
`ITOTORI_LIVE_PROVIDER` env is unset; live tests are guarded by
`it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)`. **This is the headline
defense for the audit-focus item "live LLM calls in CI".**

### 8.7 Prompt template version bump

When the active `PROMPT_TEMPLATE_VERSION` changes (simulated via a
test-only constant), assert that saved records at the old version are
treated as effectively absent by `loadBioByCharacter` callers that pass
the new version filter, and that running the agent inserts new rows
(unique key in §5.1 / §5.2 includes the version). Existing rows are not
auto-stale-flagged on a version bump unless the staleness scan is
called with `reason: "template_version_bump"`.

### 8.8 Glossary cited terms appear in prompt

Assert that every `GlossaryRef` in `input.glossaryExcerpt` appears
verbatim in the constructed prompt (by string-search on the rendered
template) and is part of `promptHash`'s input.

### 8.9 Persistence round-trip (DB-backed)

`just db-up && just db-migrate && pnpm exec vp run ts:test`:

- Save, load, assert deep-equality of `CharacterBio` and
  `CharacterRelationship` (modulo timestamps serialized as RFC3339
  strings).
- Re-save the same pack at the same template version: assert upsert
  replaces rows and evidence rows are rewritten cleanly.

### 8.10 CLI smoke

Invoke `itotori generate-character-relationships --project ... --locale
en-US --dry-run` with `--provider fake` against the seeded test
project; assert the per-character summary block matches the snapshot.
Then invoke `itotori check-character-relationships` and assert it
returns no stale records on the fresh fixture.

### 8.11 Live provider opt-in assertion

Add an assertion in the agent module that, when imported, no
real-provider construction happens at import time, and that the CI
default `ITOTORI_LIVE_PROVIDER` env is unset. The test that touches
OpenRouter is guarded by `it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)`
and is not exercised in normal CI. Mirrors how existing OpenRouter
tests in `apps/itotori/src/providers/` are gated.

## 9. Verification commands

- `pnpm exec vp run ts:test` — unit + integration tests for
  character-relationship.
- `cargo test --workspace` — sanity check; this node is TypeScript-only
  but the assignment requires confirming no Rust regression.
- `just check` — repo-wide type/lint/format.
- `just test` — repo-wide test suite (picks up the new tests).
- `just db-up && just db-migrate && pnpm --filter @itotori/db test:db`
  — DB-backed tests (§8.4, §8.9), and verifies the migration applies
  cleanly.

## 10. Risks

1. **LLM determinism in CI.** Real provider completions are not
   byte-stable. Mitigation: CI runs `FakeModelProvider` (deterministic
   by construction) and the `recorded` provider replay path. Live
   OpenRouter calls are opt-in only via `ITOTORI_LIVE_PROVIDER`,
   matching ADR 0002 and ITOTORI-013's posture.
2. **Citation accuracy.** A relationship could cite units that did not
   actually justify it. Mitigation: the agent forces every record to
   cite at least one unit from `input.units`, and the test in §8.2
   makes this a property test. A future audit could tighten this by
   running an LLM-judge verifier; that is a follow-up node, not in
   scope here.
3. **Relationship kind taxonomy drift.** The closed enum of `kind`
   values may need extension as more games are translated. Mitigation:
   the wire shape pins the enum at the DB CHECK constraint and the TS
   type level; extending requires a migration + template version bump.
4. **Cross-character relationships.** The agent emits the full pack in
   one call so it can detect cross-character relationships; this is
   token-expensive at scale. Mitigation: the CLI's `--include-stale`
   default skips characters with `Fresh` records, so re-runs are
   bounded; model selection in `--model` lets the operator dial cost.
5. **Stale relationships surviving source changes.** The §6 hash check
   is exact-equality and runs on every project re-plan. Test 8.4
   covers the round-trip; the staleness scan is also exposed via the
   CLI for ops.
6. **Source-language drift.** §4 validates locale before invocation
   and §8.5 enforces the property in tests; the prompt itself
   instructs the model to emit "in the same language as the source
   units" and the `bioLocale` is persisted, so any drift is observable
   post-hoc.
7. **Live LLM calls in CI.** §4.2 + §8.6 + §8.11 keep live calls
   opt-in. The recorded provider is the CI default.

## 11. Out of scope

- **Actual scene boundary detection** — handled by ITOTORI-018.
- **Scene summarization** — handled by ITOTORI-013.
- **Terminology mining** — handled by ITOTORI-016; this slice does not
  propose glossary terms.
- **Live OpenRouter provider in CI.**
- **Auto-regeneration when records go stale** (operator runs the CLI;
  auto-regen is a follow-up node).
- **LLM-judge citation verifier** for cross-checking that cited units
  actually justify the bio fact or relationship edge.
- **Projecting agent records into `itotori_context_artifacts` for
  unified reads** — deferred to a follow-up that designs the merged
  read model.
- **Reviewer UI for editing bios + relationships.**
- **Multi-character arc-level relationship narratives** — bounded to
  per-edge descriptors here; richer narrative output is a follow-up.
- **Wiring the new `characterContextForGroup` helper into the batch
  planner's primary path** — the helper exists for future use but the
  planner does not consume it in this slice.

## 12. Worker scoping

**One worker.** Scope is bounded:

- One new module directory under
  `apps/itotori/src/agents/character-relationship/`.
- Three new tables + one repository in `packages/itotori-db`.
- One new CLI command pair
  (`generate-character-relationships`,
  `check-character-relationships`) and a small additive helper in
  `batch-planner/context-pack.ts`.
- Tests sized to one focused PR, mirroring ITOTORI-013's PR scope.

No cross-team coordination is required. No parallel slices are needed.

---

## Plan-only confirmation

This document is plan-only. No feature code, no schema migration SQL,
no test files, and no CLI handlers are committed by this PR. The
implementation worker will translate this plan into code, migrations,
and tests in a follow-up branch.
