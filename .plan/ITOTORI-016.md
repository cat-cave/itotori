# ITOTORI-016 — Terminology candidate agent

- **Node**: ITOTORI-016
- **Title**: Terminology candidate agent
- **Branch**: `spec/itotori-016`
- **Worktree**: `/scratch/worktrees/itotori-spec-itotori-016`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: planned → ready_for_review (single implementation slice)
- **Dependencies landed**: ITOTORI-013 (scene-summary agent — citation +
  staleness pattern), ITOTORI-014 (character-relationship agent — closed
  enums + multi-table evidence), ITOTORI-012 (provider routing +
  recorded providers), ITOTORI-010 (project workflow), ITOTORI-020
  glossary substrate (existing `terminology-repository.ts` +
  glossary-review-items pipeline), ITOTORI-049 / ITOTORI-052
  (bridge-unit + locale branch foundations).
- **Direct downstream**: glossary review queue (existing reviewer
  workflow consumes the candidates as "needs glossary entry?" items);
  future drafting batches that need a denser glossary excerpt; ALPHA-006
  drafting vertical.

## 1. Goal restatement

ITOTORI-016 is the fourth LLM-using context agent in the ALPHA-006
drafting workflow (after ITOTORI-013 scene-summary, ITOTORI-014
character-relationship, ITOTORI-015 route-choice-map). It produces a
list of **terminology candidates** — surface forms the LLM identifies
as likely glossary entries — for each project's current source
revision, with **every candidate citing the exact `bridge_unit_id`s
that motivated it**, persisted alongside their `source_hash`es so any
later source change marks the candidate stale.

Critically, every candidate is **cross-checked against the existing
glossary**: a surface form whose preferred-source-form already exists
in `itotori_terminology_terms` is rejected at write time as a
duplicate (with the existing term referenced for the reviewer).
Curator-promoted candidates flow into the existing glossary review
queue (`itotori_glossary_review_items`) so the human-in-the-loop
review workflow stays the single point of glossary promotion.

Non-negotiable properties from the assignment + DAG acceptance
criteria:

1. **Citations required.** Every persisted candidate stores the list
   of `bridge_unit_id`s its surface form was extracted from, plus
   their `source_hash`es. Candidates without at least one cited unit
   are rejected at write time.
2. **Existing glossary consulted.** The agent receives the existing
   glossary as input. Any candidate whose surface form already
   matches a term in
   `itotori_terminology_terms` (by exact source form OR a known
   alias in `itotori_terminology_aliases`) is rejected at write time
   with `ExistingGlossaryConflictError`, surfacing the conflicting
   `terminologyTermId` so the reviewer can decide whether to extend
   the existing term or treat it as a new sense.
3. **Rerun invalidation.** On a re-plan (or a direct stale-check
   pass), any candidate whose `cited_unit_hashes` no longer match
   the current `bridge_units.source_hash` for the same
   `bridge_unit_id` is marked `Stale`.
4. **Source-language output.** Candidate surface forms, suggested
   translations (notes), and rationale are emitted in the project's
   `sourceLocale` (surface form) or as bilingual notes (rationale).
   The slice does NOT propose a target-language gloss — that is the
   reviewer's call.
5. **Closed candidate-kind taxonomy.** `candidate.kind` is drawn
   from a closed enum (see §3.2).
6. **Deterministic prompt construction.** Versioned prompt template
   with the units, existing glossary excerpt, and prior candidates
   packed in a stable canonical order. Identical inputs → identical
   prompt bytes → identical recorded-fixture replay.
7. **CI uses fake / recorded providers only.** Live OpenRouter / live
   provider calls are opt-in via `ITOTORI_LIVE_PROVIDER=1`, matching
   ADR 0002 provider routing and the ITOTORI-013 / 014 / 015
   posture.

This node does NOT promote candidates to glossary entries (curator
review does that), does NOT propose target-language translations,
does NOT do scene boundary detection (ITOTORI-018), summarization
(ITOTORI-013), relationship modelling (ITOTORI-014), or branching map
(ITOTORI-015). It surfaces likely glossary entries with cited
evidence so the curator pipeline has a denser inbox.

## 2. Module placement

**Recommendation: new directory
`apps/itotori/src/agents/terminology-candidate/`** inside the
existing Itotori CLI app, sibling to `agents/scene-summary/`,
`agents/character-relationship/`, and `agents/route-choice-map/`.

```
apps/itotori/src/
  agents/
    scene-summary/             # ITOTORI-013
    character-relationship/    # ITOTORI-014
    route-choice-map/          # ITOTORI-015
    terminology-candidate/     # NEW (this slice)
  batch-planner/
  providers/
  services/
```

The new module:

```
apps/itotori/src/agents/terminology-candidate/
  index.ts            # public surface: generateTerminologyCandidates(...),
                      #   shapes re-export
  shapes.ts           # TerminologyCandidate, CandidateEvidence, ...Input,
                      #   ...Output, error classes, CandidateKind closed enum
  prompt-template.ts  # versioned template builder; pure function over inputs
  agent.ts            # generateTerminologyCandidates orchestration
                      #   (provider invocation, conflict check)
  staleness.ts        # hash check against bridge_units; mark stale
  persistence.ts      # repository-level read/write delegating to itotori-db
  cli.ts              # registers `itotori generate-terminology-candidates` +
                      #   `itotori check-terminology-candidates`
  __tests__/          # unit tests; DB-backed tests via the shared harness
```

Cross-package touch points (kept thin and additive, mirroring
ITOTORI-014 / 015 strategy):

- `packages/itotori-db/migrations/0033_terminology_candidates.sql`:
  new migration adding **two tables** —
  `itotori_terminology_candidates` and
  `itotori_terminology_candidate_evidence`. The existing
  `itotori_terminology_terms` table is **NOT** extended — candidates
  stay in a separate table so curator-promoted glossary entries
  remain the authoritative glossary surface; promoting a candidate
  is a downstream review action that writes a new
  `itotori_terminology_terms` row referencing the candidate.
- `packages/itotori-db/src/schema.ts`: add the two new tables and the
  candidate kind / status enums.
- `packages/itotori-db/src/repositories/terminology-candidate-repository.ts`:
  new repository; mirrors `scene-summary-repository.ts` /
  `character-relationship-repository.ts` shape.
- `packages/itotori-db/src/index.ts`: re-export the new repository
  and record types.
- `apps/itotori/src/cli-handlers.ts`: register the two new CLI
  commands.
- `apps/itotori/src/agents/glossary-search-tools.ts`: extend the
  existing tool with an additive helper `findCandidateConflict(...)`
  that the agent calls before persistence. The current export
  surface is preserved.

The existing
`packages/itotori-db/src/repositories/terminology-repository.ts` is
read-only for this slice — the agent consults it via the new
`findCandidateConflict` helper but never writes through it.

No new pnpm workspace member. No new third-party dependency.

## 3. Types

All types live in
`apps/itotori/src/agents/terminology-candidate/shapes.ts`. They are
the contract between the agent, persistence, the glossary
conflict-check, the CLI, and the existing glossary review queue.

### 3.1 `TerminologyCandidate`

```ts
export type TerminologyCandidateStatus =
  | "Fresh" // emitted, never reviewed
  | "Stale" // a citation drifted
  | "Promoted" // accepted by reviewer, written into terminology_terms
  | "RejectedByReviewer"; // explicitly rejected (kept for audit)

export type TerminologyCandidate = {
  /** uuid7 — primary key. Deterministic given
   *  (projectId, localeBranchId, sourceRevisionId, surfaceForm,
   *   kind, promptTemplateVersion). */
  id: Uuid7;

  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;

  /** Closed enum (§3.2 header). */
  kind: CandidateKind;

  /** Source-locale surface form the agent extracted. Verbatim from
   *  the cited units (Validator rejects normalization or
   *  translation). */
  surfaceForm: string;

  /** Locale of `surfaceForm`. MUST equal projects.sourceLocale at
   *  write time. */
  surfaceLocale: Bcp47Locale;

  /** Short source-language rationale: why is this a glossary
   *  candidate? Cited by the same units in `citedUnitIds`. */
  rationale: string;

  /** Optional source-language reading / pronunciation note (e.g. the
   *  furigana for a kanji name). Source-locale only. */
  readingHint?: string;

  /** Bridge units the candidate was extracted from. Canonical
   *  order. */
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];

  /** Conflict reference written when the agent itself observes the
   *  surface form already exists in `itotori_terminology_terms` /
   *  `itotori_terminology_aliases`. The agent REJECTS candidates
   *  that conflict (see §4 step 8) — this field is populated only
   *  by the persistence-layer cross-check that runs as a defense
   *  against race conditions where a curator added the term
   *  between input loading and write time. When set, the candidate
   *  is written with `status = "RejectedByReviewer"` and
   *  `conflictingTerminologyTermId` populated. */
  conflictingTerminologyTermId?: Uuid7;

  modelProfile: TerminologyCandidateModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;

  generatedAt: string;
  status: TerminologyCandidateStatus;
  invalidatedAt?: string;
  invalidatedReason?:
    | "source_hash_drift"
    | "template_version_bump"
    | "glossary_conflict_post_persist"
    | "manual";
};

export type TerminologyCandidateModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
};
```

### 3.2 `CandidateKind` (closed enum)

```ts
export type CandidateKind =
  | "ProperNoun" // character / place / brand name
  | "TitleOrHonorific" // 先輩 / 様 / 先生
  | "TechnicalTerm" // domain jargon
  | "Catchphrase" // recurring stylized phrase
  | "SoundEffect" // SFX / onomatopoeia
  | "WrittenSign" // text overlay seen as in-world signage
  | "Other";
```

Adding a new kind requires a prompt-template version bump (or a
deliberate follow-up node) so the wire shape stays auditable.

### 3.3 Agent IO

```ts
export type TerminologyCandidateInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;

  /** Bridge units in canonical order — full slice the agent should
   *  consider. */
  units: ReadonlyArray<BridgeUnitForTerminology>;

  /** EXISTING glossary excerpt (the load-bearing defense for the
   *  "doesn't consult existing glossary" auditFocus). The agent
   *  receives every term + alias whose source form appears in any
   *  of the input units. The conflict-check helper (§4 step 8)
   *  consults this excerpt before persistence. */
  existingGlossary: ReadonlyArray<ExistingGlossaryEntry>;

  /** Optional prior candidate batch for the same project — when
   *  extending an existing context across revisions. */
  priorCandidates?: ReadonlyArray<PriorCandidateRef>;

  modelProfile: TerminologyCandidateModelProfile;

  /** Test seam — deterministic clock for generatedAt. */
  now?: () => Date;
};

export type BridgeUnitForTerminology = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string;
};

export type ExistingGlossaryEntry = {
  terminologyTermId: Uuid7;
  /** Preferred source form (verbatim). */
  preferredSourceForm: string;
  /** All known aliases (for the same terminologyTermId). Includes
   *  the preferred form itself for convenient set membership. */
  aliases: ReadonlyArray<string>;
  kind?: string; // mapped from terminology_term_kind for context
};

export type PriorCandidateRef = {
  candidateId: Uuid7;
  surfaceForm: string;
  kind: CandidateKind;
};

export type TerminologyCandidateOutput = {
  candidates: TerminologyCandidate[];
  providerRun: ProviderRunRecord;
};
```

`BridgeUnitForTerminology` is a strict subset of
`BridgeUnitForCharacter` (ITOTORI-014). The agent stays
engine-neutral.

### 3.4 Error classes

```ts
export class TerminologyCandidateUncitedError extends Error { ... }
export class ExistingGlossaryConflictError extends Error { ... }
export class TerminologyCandidateLocaleMismatchError extends Error { ... }
export class TerminologyCandidateEmptyInputError extends Error { ... }
export class TerminologyCandidateInvalidKindError extends Error { ... }
export class TerminologyCandidateNotInUnitsError extends Error { ... }
```

- `TerminologyCandidateUncitedError` — defends "candidates uncited".
  Raised when `candidate.citedUnitIds.length === 0`.
- `ExistingGlossaryConflictError` — defends "existing glossary not
  consulted". Raised when the agent's pre-persist conflict check
  finds the surface form already exists in the supplied
  `existingGlossary` set (preferred form OR alias). Carries the
  conflicting `terminologyTermId` for review-time linking.
- `TerminologyCandidateNotInUnitsError` — defends "candidates
  hallucinated". Raised when `candidate.surfaceForm` does not
  appear as a substring of any cited unit's `sourceText`. This
  catches the case where the LLM invented a surface form not
  literally present in the input.

Each error class carries a `code` field whose value matches a
semantic constant (`itotori.terminology_candidate.*`) so the
DAG-level grep returns all error paths uniformly.

## 4. Agent service

`generateTerminologyCandidates(input: TerminologyCandidateInput,
options: GenerateTerminologyCandidatesOptions):
Promise<TerminologyCandidateOutput>` in `agent.ts`. Pipeline:

1. **Validate locale.** Assert `input.sourceLocale` is non-empty.
   `persistence.saveCandidate` later asserts it matches the
   project's `projects.sourceLocale`. Throws
   `TerminologyCandidateLocaleMismatchError` on mismatch.
2. **Validate input non-empty.** `input.units.length > 0`. Throws
   `TerminologyCandidateEmptyInputError`.
3. **Build the conflict index.** Construct a `Set<string>` of every
   alias (including `preferredSourceForm`) in
   `input.existingGlossary`. This is the load-bearing pre-persist
   conflict check (§4 step 8).
4. **Canonicalize input.** Sort `units` by `(sourceUnitKey,
occurrenceId)` to match the planner's ordering; sort
   `existingGlossary` by `(preferredSourceForm, terminologyTermId)`.
5. **Build prompt** via `prompt-template.ts` (see §4.1). Hash the
   prompt bytes → `promptHash`. Compute `inputTokenEstimate` using
   `itotori-batch-estimator-v1`.
6. **Invoke provider** via the `ModelProvider` interface. Tests
   inject `FakeModelProvider` (or recorded). Returns a structured
   JSON `{ candidates: [...] }`.
7. **Parse provider output.** Failed JSON parse throws a typed
   error.
8. **Validate output.** For every emitted candidate:
   - `kind` is one of the closed enum values — else
     `TerminologyCandidateInvalidKindError`.
   - `citedUnitIds.length > 0` — else
     `TerminologyCandidateUncitedError`.
   - Every cited unit id is in `input.units`.
   - `surfaceForm` is non-empty and appears as a substring of at
     least one cited unit's `sourceText` (case-sensitive
     verbatim match) — else
     `TerminologyCandidateNotInUnitsError`.
   - `surfaceForm` is NOT in the conflict index (§4 step 3) — else
     `ExistingGlossaryConflictError` with the conflicting
     `terminologyTermId` resolved from `existingGlossary`.
9. **Populate citation hashes.** For each cited unit id, look up the
   matching `BridgeUnitForTerminology.sourceHash` and store in
   `citedUnitHashes` in matching order.
10. **Construct candidates.** With `status = "Fresh"`,
    `generatedAt = (input.now ?? Date.now)().toISOString()`,
    `surfaceLocale = input.sourceLocale`,
    `promptTemplateVersion = PROMPT_TEMPLATE_VERSION_V1`.

`generateTerminologyCandidatesBatch(inputs:
TerminologyCandidateInput[])` is the batch entry point used by the
CLI; it sequences calls one at a time.

### 4.1 Prompt template

`prompt-template.ts` exports `PROMPT_TEMPLATE_VERSION_V1 =
"itotori-terminology-candidate-v1"` and `buildPrompt(input)`. Pure
function — same input bytes, same output bytes, byte-for-byte.
Composition:

```
[system]
You are a localization context assistant. Read the supplied units
and surface forms that should become glossary entries. Use the
SAME LANGUAGE as the source units for surface forms and rationale.
Each candidate MUST cite the unit ids it appears in. Each surface
form MUST be a verbatim substring of at least one cited unit.
Candidate kind MUST be one of the closed values in the schema. Do
NOT propose any surface form that already appears in the existing
glossary block. Output JSON only, conforming to the schema in the
user message.

[user]
Project source locale: {sourceLocale}
Existing glossary (do NOT re-propose):
- {preferredSourceForm} (aliases: {aliases.join(", ")}) [{kind}]
...

{priorCandidates && "Prior candidates (extend, do not repeat):\n" +
  priorCandidates.map(c => "- " + c.surfaceForm + " [" + c.kind + "]").join("\n")}

Units (canonical order):
[#{idx}] (unitId={bridgeUnitId}, speaker={speaker || "narration"})
{sourceText}
...

Schema (JSON):
{ "candidates": [{ "kind": "ProperNoun|TitleOrHonorific|TechnicalTerm|
Catchphrase|SoundEffect|WrittenSign|Other",
"surfaceForm": "...",
"rationale": "...",
"readingHint": "...?optional",
"citedUnitIds": ["..."] }, ...] }
```

`promptHash = sha256(buildPrompt(input))` — used by tests to confirm
determinism and by audits to spot template drift.

### 4.2 Provider selection

The agent does not import providers directly. The caller (CLI, batch
planner) passes a constructed provider instance via a `provider:
ModelProvider` parameter. Tests inject `FakeModelProvider` or the
recorded-fixture provider. The CLI constructs the provider from
`--model` / env per the existing `cli-handlers.ts` pattern.

This separation keeps the agent unit-testable without provider state
and keeps **live provider calls out of CI by construction** (defends
the audit-focus item "live LLM calls in CI").

## 5. DB persistence

Migration `0033_terminology_candidates.sql` adds two tables.

### 5.1 `itotori_terminology_candidates`

- `terminology_candidate_id text primary key`
- `project_id text not null references itotori_projects(project_id) on delete cascade`
- `locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade`
- `source_revision_id text not null references itotori_source_revisions(source_revision_id) on delete restrict`
- `kind text not null check (kind in ('ProperNoun', 'TitleOrHonorific', 'TechnicalTerm', 'Catchphrase', 'SoundEffect', 'WrittenSign', 'Other'))`
- `surface_form text not null`
- `surface_locale text not null`
- `rationale text not null`
- `reading_hint text`
- `conflicting_terminology_term_id text references itotori_terminology_terms(terminology_term_id) on delete set null`
- `model_provider_family text not null`
- `model_id text not null`
- `model_context_window_tokens integer not null`
- `model_max_output_tokens integer`
- `prompt_template_version text not null`
- `prompt_hash text not null`
- `input_token_estimate integer not null`
- `completion_tokens integer not null`
- `status text not null check (status in ('Fresh', 'Stale', 'Promoted', 'RejectedByReviewer'))`
- `invalidated_at timestamptz`
- `invalidated_reason text check (... 'source_hash_drift' | 'template_version_bump' | 'glossary_conflict_post_persist' | 'manual')`
- `generated_at timestamptz not null`
- `created_at timestamptz not null default now()`
- Indexes:
  - `unique (project_id, locale_branch_id, source_revision_id, surface_form, kind, prompt_template_version)`
  - `index (project_id, locale_branch_id, source_revision_id, status)`
  - `index (surface_form)`
  - `index (conflicting_terminology_term_id)` — partial index where
    NOT NULL; supports the post-persist conflict scan.

### 5.2 `itotori_terminology_candidate_evidence`

- `terminology_candidate_id text not null references itotori_terminology_candidates(terminology_candidate_id) on delete cascade`
- `bridge_unit_id text not null`
- `cited_source_hash text not null`
- `cite_ordinal integer not null check (cite_ordinal >= 1)`
- `created_at timestamptz not null default now()`
- Primary key `(terminology_candidate_id, bridge_unit_id)`
- Index `(bridge_unit_id, cited_source_hash)` — supports the
  staleness scan.

### 5.3 Migration

New SQL migration via existing tooling. Additive only. Runs under
`just db-migrate`.

### 5.4 Repository

`packages/itotori-db/src/repositories/terminology-candidate-repository.ts`:

- `saveCandidate(actor, candidate: TerminologyCandidateRecord)` —
  single transaction; insert into both candidate + evidence tables.
  Upserts on §5.1's unique key.

  **Pre-persist cross-check** (defense in depth against race
  conditions):
  - Within the same transaction, the repository calls a new helper
    `existsTerminologyTermBySurfaceForm(actor, tx, { projectId,
surfaceForm })` (added to
    `terminology-repository.ts`).
  - If the helper returns a `terminologyTermId`, the repository
    writes the candidate row with
    `conflicting_terminology_term_id` populated and
    `status = "RejectedByReviewer"`, `invalidated_reason =
"glossary_conflict_post_persist"`.
  - This catches the case where a curator created the term in
    `itotori_terminology_terms` between the agent loading
    `existingGlossary` and persisting candidates.

- `loadCandidatesByProject(actor, { projectId, localeBranchId,
sourceRevisionId, [statusFilter] })`.
- `currentSourceHashesForBridgeUnits(actor, { bridgeUnitIds })` —
  reused helper from ITOTORI-013 / 014 / 015 repositories.
- `markCandidateStale(actor, { candidateId, reason })` — idempotent.
- `markCandidatePromoted(actor, { candidateId, terminologyTermId })`
  — called by the existing glossary review queue when a reviewer
  promotes the candidate (out-of-band wiring done by the curator
  workflow, not by this slice's CLI).
- All operations honour the existing `itotori-db` authorization
  layer.

### 5.5 Glossary review queue wiring

The existing `itotori_glossary_review_items` table receives a new
row for every persisted `Fresh` candidate, with:

- `review_item_kind: "TerminologyCandidate"`
- `subject_id: <terminology_candidate_id>`
- `state: "Pending"`
- payload referencing the candidate's `surfaceForm` + `rationale`.

The wiring is **additive** in the persistence layer
(`saveCandidate` calls
`glossary-review-items-repository.enqueueCandidate(...)` on insert).
The existing reviewer UI consumes the items as-is; no UI change is
in scope.

## 6. Rerun invalidation

The staleness logic lives in
`apps/itotori/src/agents/terminology-candidate/staleness.ts` and
runs in two documented places:

1. **At project workflow re-plan** (via
   `services/project-workflow.ts`, alongside ITOTORI-013 / 014 / 015
   stale-mark hooks). The new
   `markStaleTerminologyCandidatesForRevision({ projectId,
localeBranchId, sourceRevisionId })` call:
   - Loads all `Fresh` candidates for that triple.
   - For each, loads the current `source_hash` for every cited
     `bridge_unit_id` (reused bulk helper).
   - For each `Fresh` candidate, compares `citedUnitHashes[i]` to
     the current hash; on any mismatch, calls
     `markCandidateStale` with reason `"source_hash_drift"`.
   - Additionally, runs a post-persist conflict scan: for every
     `Fresh` candidate, calls
     `existsTerminologyTermBySurfaceForm` and, if a term exists,
     transitions the candidate to `RejectedByReviewer` with reason
     `"glossary_conflict_post_persist"`.
2. **At explicit `itotori check-terminology-candidates`
   invocation** (CLI in §7).

The hash check is exact-equality; any drift → Stale. The
conflict re-scan is the structural defense for "candidates that
conflict with newly-added glossary entries surviving as Fresh after
a re-plan".

## 7. CLI surface

Registered in
`apps/itotori/src/agents/terminology-candidate/cli.ts`, wired
through `cli-handlers.ts`.

### 7.1 Generate

```
itotori generate-terminology-candidates \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--model <modelId>] \
  [--provider <provider-family>] \
  [--include-stale] \
  [--dry-run]
```

Behaviour:

- Resolves the project's `sourceLocale`. Asserts the provider /
  model exists.
- Loads bridge units for `(project, localeBranchId,
sourceRevisionId)`.
- Loads the existing glossary excerpt for the same project — every
  term + alias whose source form appears in any of the loaded
  units. Uses the existing `terminology-repository.ts`
  `searchAliasesContainedInTexts(...)` helper (or a new additive
  variant if missing).
- Skips candidates already persisted at the current template
  version (by unique key) unless `--include-stale` is set.
- Calls `generateTerminologyCandidates` once per project (the
  agent emits the full pack in one call so the conflict check fires
  in a single pass).
- When not `--dry-run`, calls `saveCandidate` per emitted record.
- Prints a per-candidate line: `surfaceForm | kind | citedUnits |
status`.

### 7.2 Check

```
itotori check-terminology-candidates \
  --project <projectId> \
  --locale <bcp47-locale> \
  [--mark-stale]
```

Runs the staleness + conflict scan from §6. Without `--mark-stale`,
prints a diff (candidates whose citations drifted, candidates that
now conflict with the glossary). With `--mark-stale`, applies the
transitions.

## 8. Test plan

Tests live under
`apps/itotori/src/agents/terminology-candidate/__tests__/`. Both
plain-Node tests (via `pnpm exec vp run ts:test`) and DB-backed
tests (via the shared `pg-test` harness, matching
ITOTORI-013 / 014 / 015).

### 8.1 Fake provider: deterministic candidate output round-trip

Use a 6-unit fixture with 3 distinct named entities (compose
inline). Inject `FakeModelProvider` with a fixed `generate` callback
that emits a deterministic candidate JSON. Assert:

- Every `candidate.status === "Fresh"`.
- `candidate.surfaceForm`, `kind`, `rationale` match the fake
  provider's output.
- `candidate.promptHash` byte-stable across two calls with the same
  input.
- `candidate.surfaceLocale === input.sourceLocale`.

### 8.2 Citations: every candidate cites at least one unit

Same fixture; assert every `candidate.citedUnitIds.length > 0` and
`citedUnitHashes` is index-aligned and non-empty.

Negative: feed a `FakeModelProvider` that emits a candidate with
`citedUnitIds: []` and assert `generateTerminologyCandidates` throws
`TerminologyCandidateUncitedError` before any DB write. **Headline
defense for "candidates uncited".**

### 8.3 Existing-glossary conflict rejection (input-side)

Negative: feed a `FakeModelProvider` that emits a candidate whose
`surfaceForm` is already in `input.existingGlossary` (as a preferred
form OR as an alias). Assert `ExistingGlossaryConflictError` with
the conflicting `terminologyTermId` populated. **Headline defense
for "existing glossary not consulted".**

### 8.4 Existing-glossary conflict rejection (post-persist race)

DB-backed test:

1. Persist a candidate at `sourceRevisionId = r1`.
2. Curator-style INSERT into `itotori_terminology_terms` for the
   same surface form (simulating a race where a curator added the
   term between input load and write).
3. Call `markStaleTerminologyCandidatesForRevision({...})`.
4. Assert the candidate transitions to `RejectedByReviewer` with
   `invalidated_reason === "glossary_conflict_post_persist"` and
   `conflicting_terminology_term_id` populated.

### 8.5 Hallucination rejection (surface form not in units)

Negative: feed a `FakeModelProvider` that emits a candidate whose
`surfaceForm` is not a substring of any cited unit's `sourceText`.
Assert `TerminologyCandidateNotInUnitsError`.

### 8.6 Closed candidate-kind enum rejection

Negative: feed a `FakeModelProvider` that emits a candidate with
`kind: "Nickname"` (not in the closed enum). Assert
`TerminologyCandidateInvalidKindError`.

### 8.7 Stale detection: change one unit, run staleness scan, candidate marked stale

DB-backed test:

1. Generate and persist candidates at `sourceRevisionId = r1`.
2. Mutate one of the cited bridge units' `source_hash`.
3. Call `markStaleTerminologyCandidatesForRevision({...})`.
4. Assert the affected candidate rows are `status === "Stale"`,
   `invalidated_reason === "source_hash_drift"`,
   `invalidated_at` set.
5. Untouched candidates remain `Fresh`.

### 8.8 Source-language: surface form locale matches project source locale

Construct a project with `sourceLocale = "ja-JP"`. Run the agent.
Assert every `candidate.surfaceLocale === "ja-JP"`. Then construct
an input whose `sourceLocale` is the target locale by mistake and
assert `generateTerminologyCandidates` throws
`TerminologyCandidateLocaleMismatchError` before invoking the
provider.

### 8.9 Recorded provider replay (CI default)

Use the `recorded` provider family. First run with the recording
sink writes a fixture under
`apps/itotori/fixtures/recorded/terminology-candidate/`. Second
run with the recorded provider replays it. Assert that with no
network access (env-gated `OFFLINE=1`) the replay run still
produces a `Fresh` pack with identical record bytes and identical
`promptHash`es.

**Live provider opt-in only.** A test under §8.13 asserts that no
real provider construction happens at import time and that the CI
default `ITOTORI_LIVE_PROVIDER` env is unset; live tests are
guarded by `it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)`.
**Headline defense for "live LLM calls in CI".**

### 8.10 Prompt template version bump

When the active `PROMPT_TEMPLATE_VERSION` changes (simulated via a
test-only constant), assert that saved candidates at the old
version are treated as effectively absent by
`loadCandidatesByProject` callers that pass the new version filter,
and that running the agent inserts new rows (unique key in §5.1
includes the version).

### 8.11 Persistence round-trip + glossary review enqueue (DB-backed)

`just db-up && just db-migrate && pnpm exec vp run ts:test`:

- Save, load, assert deep-equality of `TerminologyCandidate`.
- Re-save the same surface form at the same template version:
  assert upsert replaces the row and evidence rows are rewritten
  cleanly.
- Assert that every persisted `Fresh` candidate produced a
  corresponding `itotori_glossary_review_items` row with
  `state = "Pending"`.

### 8.12 CLI smoke

Invoke `itotori generate-terminology-candidates --project ...
--locale ja-JP --dry-run` with `--provider fake` against the
seeded test project; assert the per-candidate summary block matches
the snapshot. Then invoke `itotori check-terminology-candidates`
and assert it returns no stale records on the fresh fixture.

### 8.13 Live provider opt-in assertion

Add an assertion in the agent module that, when imported, no
real-provider construction happens at import time, and that the CI
default `ITOTORI_LIVE_PROVIDER` env is unset. The test that touches
OpenRouter is guarded by
`it.skipIf(!process.env.ITOTORI_LIVE_PROVIDER)` and is not
exercised in normal CI.

### 8.14 Existing-glossary consultation property test

Property: for every candidate the agent emits, the agent MUST have
been called with an `existingGlossary` set that does NOT contain
the surface form. Encoded as a test that constructs an input where
`existingGlossary` includes a surface form and asserts the agent's
output excludes it. Pair with §8.3's input-side rejection so the
property is enforced from both directions.

## 9. Verification commands

- `pnpm exec vp run ts:test` — unit + integration tests for
  terminology-candidate.
- `cargo test --workspace` — sanity check; this node is
  TypeScript-only.
- `just check` — repo-wide type/lint/format.
- `just test` — repo-wide test suite (picks up the new tests).
- `just db-up && just db-migrate && pnpm --filter @itotori/db
test:db` — DB-backed tests (§8.4, §8.7, §8.11), and verifies the
  migration applies cleanly.

## 10. Risks

1. **LLM determinism in CI.** Real provider completions are not
   byte-stable. Mitigation: CI runs `FakeModelProvider` +
   `recorded` replay. Live calls opt-in only via
   `ITOTORI_LIVE_PROVIDER`. Mirrors ITOTORI-013 / 014 / 015.
2. **Citation accuracy.** A candidate could cite units that did
   not actually contain the surface form. Mitigation: §4 step 8
   forces the `surfaceForm` to be a verbatim substring of at least
   one cited unit (`TerminologyCandidateNotInUnitsError`). §8.5
   makes this a property test.
3. **Glossary conflict surviving race conditions.** A curator may
   add a glossary entry between the agent loading
   `existingGlossary` and persisting candidates. Mitigation: §5.4
   pre-persist cross-check runs in the same transaction as the
   write; §6 staleness scan re-checks Fresh candidates on every
   re-plan. §8.4 covers the race.
4. **Candidate explosion at scale.** A long source revision could
   produce thousands of candidates per LLM call. Mitigation:
   `--include-stale` default skips already-persisted candidates;
   model selection lets the operator pick a cheap default; the
   candidate kind enum keeps the surface bounded.
5. **Closed kind taxonomy drift.** `CandidateKind` may need
   extension (e.g. `DialectalForm`). Mitigation: enum pinned at
   the DB CHECK constraint + TS type; extension requires a
   migration + template version bump.
6. **Stale candidates surviving source changes.** §6 hash check
   is exact-equality and runs on every project re-plan. Tests 8.7
   and 8.4 cover the round-trip; the staleness scan is also
   exposed via the CLI for ops.
7. **Source-language drift.** §4 validates locale before
   invocation; §8.8 enforces the property in tests; the prompt
   itself instructs the model to emit "in the same language as
   the source units" and `surfaceLocale` is persisted, so any
   drift is observable post-hoc.
8. **Live LLM calls in CI.** §4.2 + §8.9 + §8.13 keep live calls
   opt-in. The recorded provider is the CI default.

## 11. Out of scope

- **Glossary entry promotion.** Reviewer workflow promotes
  candidates; this slice surfaces them only.
- **Target-language gloss proposals.** The agent emits source-locale
  surface forms only; translation is the reviewer's call.
- **Scene boundary detection** — ITOTORI-018.
- **Scene summarization** — ITOTORI-013.
- **Character bios + relationships** — ITOTORI-014.
- **Route + choice map** — ITOTORI-015.
- **Live OpenRouter provider in CI.**
- **Auto-regeneration when candidates go stale** (operator runs
  the CLI; auto-regen is a follow-up node).
- **LLM-judge citation verifier.**
- **Projecting agent candidates into `itotori_context_artifacts`
  for unified reads.**
- **Reviewer UI for editing candidates** (the existing review
  queue UI consumes the items as-is).
- **Bulk import of candidates from external glossaries.**

## 12. Worker scoping

**One worker.** Scope is bounded:

- One new module directory under
  `apps/itotori/src/agents/terminology-candidate/`.
- Two new tables + one repository in `packages/itotori-db`.
- One new helper added to the existing
  `terminology-repository.ts` (`existsTerminologyTermBySurfaceForm`).
- One additive helper in `glossary-search-tools.ts`
  (`findCandidateConflict`).
- One new CLI command pair (`generate-terminology-candidates`,
  `check-terminology-candidates`).
- Tests sized to one focused PR, mirroring
  ITOTORI-013 / 014 / 015 PR scope.

No cross-team coordination is required. No parallel slices are
needed.

---

## Plan-only confirmation

This document is plan-only. No feature code, no schema migration
SQL, no test files, and no CLI handlers are committed by this PR.
The implementation worker will translate this plan into code,
migrations, and tests in a follow-up branch.
