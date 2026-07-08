# UTSUSHI-030 — Runtime conformance ingestion fixture

- **Node**: UTSUSHI-030
- **Title**: Runtime conformance ingestion fixture
- **Branch**: `spec/utsushi-030`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-030`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review (single implementation
  slice; mixed Rust + TS + DB cross-cutting)
- **Dependencies landed**: UTSUSHI-026 (`ConformanceManifest` /
  `ConformanceResult` substrate + `codes::ALL` registry), UTSUSHI-027
  (trace/branch checks + codes), UTSUSHI-028 (snapshot check +
  `EvidenceRef::StatePath` additive variant + schema bump to
  `0.2.0-alpha`), UTSUSHI-029 (capture/recording checks + codes).
- **Parallel siblings**: none on the ingestion side; KAIFUU-010 has
  already established the `kaifuu.*` semantic-code prefix that the
  ingest-side whitelist accepts.
- **Direct downstream**: per-port adapter conformance landings
  (UTSUSHI-103 et al.) consume the ingestion path through the CLI
  command introduced here.

## 1. Goal restatement

Wire **already-validated** runtime `ConformanceResult` JSON payloads (and
their paired `ConformanceManifest`) into Itotori's persistence layer
**without raising any evidence or fidelity claim beyond what the source
report already carries**. The slice is plumbing: a TypeScript schema
mirror that re-validates incoming JSON against the same structural rules
the Rust validator enforces, a DB migration for the four new tables, a
repository, a `ProjectWorkflow.ingestConformance` service entry point, a
CLI command (`itotori ingest-conformance`), and the negative fixture set
the schema tests will lean on.

The audit-focus posture is **conservative everywhere**:

- Evidence tier in the stored row is **byte-equal** to the evidence tier
  in the source `ConformanceResult.outcome.evidenceTier`. There is no
  reformatting, no enum widening, no defaulting (`E0`/`E1`/`E2`/`E3`/`E4`
  is the wire alphabet on both sides).
- Fidelity tier is preserved the same way; the ingest layer never
  computes or substitutes a fidelity tier.
- The semantic-code whitelist is enforced by the schema validator
  itself: `^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
  exactly mirrors the Rust regex in
  `crates/utsushi-core/src/conformance/result.rs::is_valid_semantic_code`.
- `Skip` and `Unsupported` are distinct tagged variants on the TS side
  too; they cannot be ingested as a `Pass` because the schema's tagged
  union forbids the shape change at parse time.

The slice ships only the ingestion seam. The engine ports that _produce_
conformance results remain out of scope (each port lands its own
`ConformanceResult`-emitting code separately).

### Acceptance criteria (synthesized from DAG)

1. **Schema validation**: every ingested `ConformanceResult` and
   `ConformanceManifest` is parsed through the TS schema mirror before
   any persistence happens; structural rejects surface as
   `ConformanceIngestionError` with a stable diagnostic code.
2. **Evidence tier preserved verbatim**: the `evidenceTier` field on
   `Pass` outcomes is stored exactly as received. The DB column is
   `text` (no enum widening) and the repository asserts byte-equality
   on round-trip.
3. **Fidelity tier preserved verbatim**: the optional adapter-declared
   fidelity tier (carried in `ConformanceManifest.optionalExtensions`
   or, when present, as a top-level `manifestFidelityTier`) is stored
   without coercion.
4. **Disallowed semantic codes rejected**: the only accepted prefixes
   are `utsushi.conformance.*`, `utsushi.snapshot.*`, and `kaifuu.*`.
   Any other prefix (including `utsushi.sink.*` or `rgss3.*`) is
   rejected at the schema layer with
   `itotori.conformance.semantic_code_not_allowed`.
5. **Skipped/Unsupported never promoted**: the TS tagged union for
   `ResultOutcome` keeps `Pass` / `Fail` / `Skip` / `Unsupported` as
   distinct variants; the repository's `outcome_kind` column is a CHECK
   constraint over the same four strings; loading a `Skip` row back
   never returns a `Pass`.
6. **Itotori-facing output preserves tiers verbatim**: the
   `ingest-conformance` CLI writes the stored shape back to disk on
   request, and the round-trip is byte-equal for the tier fields.

### Hard architectural constraints

- TS schema mirror lives in `packages/localization-bridge-schema/src/`
  (per the brief; the existing patch-result / runtime-evidence mirror
  patterns are the precedent). No new package.
- A single new CLI subcommand on the existing `apps/itotori` CLI:
  `itotori ingest-conformance --project --report-file [--manifest-file]
[--output]`. Mirrors the `ingest-runtime` / `ingest-patch-result`
  surface.
- DB persistence: four new tables in a single migration
  (`0028_runtime_conformance_results.sql`). No backfill; this is a
  fresh ingestion path.
- The evidence tier and fidelity tier columns are `text` (never `enum`)
  so the byte-equality invariant cannot be defeated by an enum
  rename.
- Schema rejects unknown semantic codes by **whitelist prefix** plus
  the structural regex; the test plan covers both layers.
- Engine-neutral: no engine-specific fields (no XP3, KAG, RGSS3,
  Tyrano). Adapter id is opaque; profile id is the `ProfileId` enum
  surfaced as a kebab-case string.
- `Skip` / `Unsupported` rows are persisted with the same column shape
  as `Pass` / `Fail`; the `outcome_kind` discriminator is the join key.

## 2. Module placement

### TS surface

`packages/localization-bridge-schema/src/index.ts` already hosts every
existing assertion (`assertRuntimeReport`, `assertPatchResultV02`,
`assertBridgeInput`). The conformance mirror lands as **additive types
plus assertions** in the same file, with a sibling internal module
`packages/localization-bridge-schema/src/conformance.ts` to keep the
single file from growing past the ~7k LOC mark.

New TS surface (re-exported from `index.ts`):

```ts
// packages/localization-bridge-schema/src/conformance.ts

export const CONFORMANCE_SCHEMA_VERSION_V01 = "0.2.0-alpha";

export type ConformanceProfileIdV01 =
  | "text-trace"
  | "branch-capture"
  | "snapshot-restore"
  | "frame-capture"
  | "recording-capture"
  | "deterministic-replay";

export type EvidenceTierV01 = "E0" | "E1" | "E2" | "E3" | "E4";

export type SubsystemRequirementV01 =
  | "asset_access"
  | "input"
  | "clock"
  | "replay_log"
  | "text_sink"
  | "frame_sink"
  | "audio_sink"
  | "artifact_store"
  | "snapshot_primitives";

export type RuntimeArtifactKindV01 =
  | "trace_log"
  | "screenshot"
  | "frame_capture"
  | "recording"
  | "reference_comparison";

export type EvidenceRefV01 =
  | {
      artifactKind: "runtimeArtifact";
      kind: RuntimeArtifactKindV01;
      uri: string;
      artifactId?: string;
    }
  | { artifactKind: "textLine"; lineId: string }
  | { artifactKind: "frameArtifactRef"; frameId: string }
  | { artifactKind: "replayLogRef"; runId: string }
  | { artifactKind: "implMapFixture"; fixtureId: string }
  | { artifactKind: "bridgeUnit"; bridgeUnitId: string }
  | { artifactKind: "statePath"; path: string };

export type ResultOutcomeV01 =
  | { kind: "pass"; evidenceTier: EvidenceTierV01 }
  | { kind: "fail"; semanticCode: string; detail: string }
  | { kind: "skip"; semanticCode: string; reason: string }
  | {
      kind: "unsupported";
      semanticCode: string;
      declaredInManifest: boolean;
    };

export type ConformanceProfileV01 = {
  id: ConformanceProfileIdV01;
  requiredSubsystems: SubsystemRequirementV01[];
  evidenceTierCeiling: EvidenceTierV01;
};

export type ProfileExtensionV01 = {
  profileId: ConformanceProfileIdV01;
  key: string;
  note: string;
};

export type ConformanceManifestV01 = {
  schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION_V01;
  adapterId: string;
  abiVersion: 1;
  supportedProfiles: ConformanceProfileV01[];
  optionalExtensions?: ProfileExtensionV01[];
};

export type ConformanceResultV01 = {
  schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION_V01;
  adapterId: string;
  profileId: ConformanceProfileIdV01;
  outcome: ResultOutcomeV01;
  evidence: EvidenceRefV01[];
  recordedAt: string;
};

export function assertConformanceManifestV01(
  value: unknown,
): asserts value is ConformanceManifestV01;

export function assertConformanceResultV01(value: unknown): asserts value is ConformanceResultV01;

export function assertSemanticCodeAllowedV01(value: string, label: string): void;
```

The TS layer enforces:

- `schemaVersion === "0.2.0-alpha"` exactly (mirrors
  `CONFORMANCE_SCHEMA_VERSION` from `conformance/mod.rs`).
- `abiVersion === 1` exactly.
- `adapterId` matches `^[a-z][a-z0-9-]{7,63}$` (mirrors
  `is_valid_adapter_id`).
- `profileId` is one of the six kebab-case strings.
- `evidenceTier` is one of `E0..E4` (no widening).
- `Pass` outcomes require non-empty `evidence`.
- `Unsupported` outcomes with `declaredInManifest === true` are rejected
  immediately (mirrors `DeclaredProfileReportedAsUnsupported`).
- Semantic codes match `^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
  AND start with one of the allowed prefixes (`utsushi.conformance.`,
  `utsushi.snapshot.`, `kaifuu.`). `utsushi.sink.*` and anything else
  is structurally rejected (criterion 4).
- `recordedAt` is RFC3339-instant-shaped (same parse rules as the Rust
  validator).
- Each `EvidenceRef` variant validates per-tag: `runtimeArtifact.uri`
  must live under `artifacts/utsushi/runtime/` (mirrors
  `validate_runtime_artifact_uri` substring policy already enforced by
  the runtime evidence schema); `statePath.path` rejects whitespace and
  local-path shapes.

### DB surface

Single migration: `packages/itotori-db/migrations/0028_runtime_conformance_results.sql`
(latest migration today is `0027_translation_batches.sql`).

Four tables, polymorphic on `outcome_kind` and `evidence_kind` strings:

```sql
-- One conformance run = one (manifest, result-batch) pair ingested
-- together. Multiple ConformanceResult rows reference the run.
create table if not exists itotori_conformance_runs (
  conformance_run_id text primary key,
  project_id text not null
    references itotori_projects(project_id) on delete cascade,
  locale_branch_id text
    references itotori_locale_branches(locale_branch_id) on delete cascade,
  manifest_artifact_id text
    references itotori_artifacts(artifact_id) on delete set null,
  report_artifact_id text not null
    references itotori_artifacts(artifact_id) on delete cascade,
  adapter_id text not null,
  abi_version integer not null,
  schema_version text not null,
  manifest_fidelity_tier text, -- preserved verbatim from manifest extension
  result_count integer not null default 0,
  pass_count integer not null default 0,
  fail_count integer not null default 0,
  skip_count integer not null default 0,
  unsupported_count integer not null default 0,
  recorded_at timestamptz not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_conformance_runs_counts_check check (
    result_count >= 0
    and pass_count >= 0
    and fail_count >= 0
    and skip_count >= 0
    and unsupported_count >= 0
    and result_count = pass_count + fail_count + skip_count + unsupported_count
  ),
  constraint itotori_conformance_runs_schema_version_check check (
    schema_version = '0.2.0-alpha'
  )
);

create index if not exists itotori_conformance_runs_project_recorded_idx
  on itotori_conformance_runs(project_id, recorded_at);

-- One row per ConformanceResult inside the run.
create table if not exists itotori_conformance_results (
  conformance_result_id text primary key,
  conformance_run_id text not null
    references itotori_conformance_runs(conformance_run_id) on delete cascade,
  project_id text not null
    references itotori_projects(project_id) on delete cascade,
  adapter_id text not null,
  profile_id text not null,
  outcome_kind text not null,
  -- Only populated for Pass; preserved byte-equal from the source.
  pass_evidence_tier text,
  -- Only populated for Fail / Skip / Unsupported.
  semantic_code text,
  -- Detail/reason as carried by the matching variant. Public string.
  outcome_message text,
  -- Only meaningful when outcome_kind = 'unsupported'.
  declared_in_manifest boolean,
  recorded_at timestamptz not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_conformance_results_outcome_kind_check check (
    outcome_kind in ('pass', 'fail', 'skip', 'unsupported')
  ),
  constraint itotori_conformance_results_profile_id_check check (
    profile_id in (
      'text-trace',
      'branch-capture',
      'snapshot-restore',
      'frame-capture',
      'recording-capture',
      'deterministic-replay'
    )
  ),
  -- Pass must carry a tier; non-Pass must not carry a tier.
  constraint itotori_conformance_results_pass_tier_check check (
    (outcome_kind = 'pass' and pass_evidence_tier in ('E0','E1','E2','E3','E4'))
    or (outcome_kind <> 'pass' and pass_evidence_tier is null)
  ),
  -- Non-Pass variants carry a semantic code; Pass does not.
  constraint itotori_conformance_results_semantic_code_check check (
    (outcome_kind = 'pass' and semantic_code is null)
    or (outcome_kind <> 'pass' and semantic_code is not null)
  ),
  -- Whitelist prefix enforced at the DB layer as belt-and-suspenders.
  constraint itotori_conformance_results_semantic_code_prefix_check check (
    semantic_code is null
    or semantic_code like 'utsushi.conformance.%'
    or semantic_code like 'utsushi.snapshot.%'
    or semantic_code like 'kaifuu.%'
  ),
  constraint itotori_conformance_results_declared_flag_check check (
    (outcome_kind = 'unsupported' and declared_in_manifest is not null)
    or (outcome_kind <> 'unsupported' and declared_in_manifest is null)
  )
);

create index if not exists itotori_conformance_results_run_idx
  on itotori_conformance_results(conformance_run_id);
create index if not exists itotori_conformance_results_profile_outcome_idx
  on itotori_conformance_results(profile_id, outcome_kind);

-- Polymorphic evidence ref table. Stores all six existing kinds plus
-- the UTSUSHI-028 StatePath additive variant. Fields per kind:
--   runtimeArtifact: artifact_kind, uri, artifact_id
--   textLine:        line_id
--   frameArtifactRef: frame_id
--   replayLogRef:    run_id
--   implMapFixture:  fixture_id
--   bridgeUnit:      bridge_unit_id
--   statePath:       state_path
-- All non-applicable columns NULL.
create table if not exists itotori_conformance_evidence_refs (
  conformance_evidence_ref_id text primary key,
  conformance_result_id text not null
    references itotori_conformance_results(conformance_result_id) on delete cascade,
  evidence_kind text not null,
  artifact_kind text,
  uri text,
  artifact_id text,
  line_id text,
  frame_id text,
  run_id text,
  fixture_id text,
  bridge_unit_id text,
  state_path text,
  ordinal integer not null,
  created_at timestamptz not null default now(),
  constraint itotori_conformance_evidence_refs_kind_check check (
    evidence_kind in (
      'runtimeArtifact',
      'textLine',
      'frameArtifactRef',
      'replayLogRef',
      'implMapFixture',
      'bridgeUnit',
      'statePath'
    )
  ),
  -- Mirror the conformance package's portable-uri policy.
  constraint itotori_conformance_evidence_refs_uri_check check (
    uri is null
    or (
      uri !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and uri !~ '^/'
      and uri !~ '[\\]'
      and uri like 'artifacts/utsushi/runtime/%'
    )
  )
);

create index if not exists itotori_conformance_evidence_refs_result_idx
  on itotori_conformance_evidence_refs(conformance_result_id, ordinal);

-- The optional findings table holds adapter-level cross-validation
-- diagnostics surfaced during ingest (manifest/result join failures
-- short-circuit ingest; this table records soft warnings only).
create table if not exists itotori_conformance_findings (
  conformance_finding_id text primary key,
  conformance_run_id text not null
    references itotori_conformance_runs(conformance_run_id) on delete cascade,
  finding_code text not null,
  severity text not null,
  message text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  constraint itotori_conformance_findings_severity_check check (
    severity in ('info', 'warning', 'error')
  )
);
```

### Repository surface

`packages/itotori-db/src/repositories/conformance-repository.ts`:

```ts
export interface ConformanceRepository {
  saveConformanceRun(input: {
    conformanceRunId: string;
    projectId: string;
    localeBranchId?: string;
    manifestArtifactId?: string;
    reportArtifactId: string;
    manifest: ConformanceManifestV01;
    results: ConformanceResultV01[];
    manifestFidelityTier?: string;
    findings?: ConformanceIngestFinding[];
    metadata: Record<string, unknown>;
  }): Promise<{
    conformanceRunId: string;
    resultIds: string[];
  }>;

  loadConformanceRun(conformanceRunId: string): Promise<ConformanceRunRecord | undefined>;
}
```

The repository never coerces tier values; the column types are `text`
and the in-memory shape matches the schema exactly.

### Service / CLI surface

- New service entry on `ProjectWorkflow`:

  ```ts
  ingestConformanceReport(
    project: ProjectState,
    input: ConformanceIngestInput,
  ): Promise<{ project: ProjectState; result: ConformanceIngestResult }>;
  ```

  The service:
  1. Calls `assertConformanceManifestV01` on the manifest (if supplied).
  2. Calls `assertConformanceResultV01` on every result.
  3. Calls the existing UTSUSHI-026 join-checker mirror (TS-only;
     written here to match the Rust
     `cross_validate_results_against_manifest` invariants — declared
     profiles must be reported, declared profiles cannot be Skip,
     Pass tier must not exceed the manifest's per-profile ceiling).
  4. Persists through the new repository.
  5. Returns a `ConformanceIngestResult` summarising counts per
     outcome and listing the persisted ids.

- New CLI command on `apps/itotori`:

  ```
  itotori ingest-conformance \
    --project <project.json> \
    --report-file <conformance-results.json> \
    [--manifest-file <conformance-manifest.json>] \
    [--output <ingest-result.json>]
  ```

  The handler mirrors `runIngestRuntime` exactly: read project, read
  payloads, assert through TS schema, call the workflow, write project +
  optional output. CLI surface is registered in `cli-handlers.ts`
  alongside `case "ingest-conformance":`.

## 3. Module layout summary

```
crates/utsushi-core/...                              # untouched
packages/localization-bridge-schema/
  src/
    conformance.ts                                    # NEW: types + assertions
    index.ts                                          # additive re-exports
packages/itotori-db/
  migrations/
    0028_runtime_conformance_results.sql              # NEW
  src/
    schema.ts                                         # additive table refs
    repositories/
      conformance-repository.ts                       # NEW
apps/itotori/
  src/
    cli-handlers.ts                                   # additive case
    services/
      project-workflow.ts                             # additive method
fixtures/
  utsushi-conformance/                                # NEW dir
    positive-text-trace-pass.json
    positive-snapshot-restore-pass.json
    positive-frame-capture-pass.json
    positive-recording-capture-pass.json
    negative-evidence-tier-promotion.json
    negative-disallowed-semantic-code.json
    negative-skip-as-pass.json
    negative-malformed-recorded-at.json
    manifest-baseline-text-trace.json
    manifest-cross-check-paired.json
```

## 4. TS schema mirror — detailed invariants

The new `assertConformanceResultV01` validator enforces, in this order:

1. `schemaVersion` literal check.
2. `adapterId` regex `^[a-z][a-z0-9-]{7,63}$`.
3. `profileId` enum membership.
4. `outcome.kind` tagged-union dispatch:
   - `pass`: `evidenceTier` ∈ `{E0..E4}`; tier must satisfy the
     per-`profileId` ceiling (mirrors
     `ProfileId::evidence_tier_ceiling`); `evidence.length > 0`.
   - `fail`: `semanticCode` validated through
     `assertSemanticCodeAllowedV01`; `detail` non-empty.
   - `skip`: `semanticCode` validated; `reason` non-empty.
   - `unsupported`: `semanticCode` validated; `declaredInManifest`
     is boolean; `declaredInManifest === true` is an immediate
     rejection (no orphan unsupported claims).
5. `evidence[i]` validated per-tag (six existing kinds + `statePath`).
6. `recordedAt` parsed through the same RFC3339 instant rules as the
   Rust validator (date+time+offset).

`assertSemanticCodeAllowedV01` enforces the whitelist:

```ts
function assertSemanticCodeAllowedV01(value: string, label: string): void {
  const NAMESPACED = /^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;
  if (!NAMESPACED.test(value)) {
    throw new ConformanceIngestionError({
      code: "itotori.conformance.semantic_code_malformed",
      message: `${label} (${value}) is not <provider>.<subsystem>.<reason>`,
    });
  }
  const ALLOWED_PREFIXES = ["utsushi.conformance.", "utsushi.snapshot.", "kaifuu."];
  if (!ALLOWED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new ConformanceIngestionError({
      code: "itotori.conformance.semantic_code_not_allowed",
      message: `${label} (${value}) prefix not in whitelist`,
    });
  }
}
```

The whitelist intentionally excludes `utsushi.sink.*` and
`utsushi.port.*`. Adapter-internal codes from those namespaces are not
ingested into Itotori; they stay inside the engine port crate.

`assertConformanceManifestV01` runs the manifest-internal rules
(schema version, adapter id, abi version, profile uniqueness, subsystem
superset, ceiling discipline, extension orphan check) by walking the
same control flow as the Rust validator. The TS implementation never
runs an executable regex over untrusted input without a bounded length
check first (max 64 bytes per id, 4 KiB per detail string).

## 5. Negative fixture set

Six negative fixtures plus four positive ones live in
`fixtures/utsushi-conformance/`:

1. **negative-evidence-tier-promotion.json** — `Pass` outcome on
   `text-trace` with `evidenceTier: "E3"`. Expected reject:
   `itotori.conformance.evidence_tier_above_profile_ceiling`.
2. **negative-disallowed-semantic-code.json** — `Fail` outcome with
   `semanticCode: "utsushi.sink.unsupported_kind"`. Expected reject:
   `itotori.conformance.semantic_code_not_allowed`.
3. **negative-skip-as-pass.json** — synthetic JSON where
   `outcome.kind === "pass"` but `outcome.semanticCode` is set
   (someone copy-pasted a `skip` shape into a `pass` envelope).
   Expected reject: `itotori.conformance.unknown_field` or, if the
   parser is strict on shape, `itotori.conformance.pass_carries_semantic_code`.
4. **negative-malformed-recorded-at.json** — `recordedAt: "not-a-time"`.
   Expected reject: `itotori.conformance.recorded_at_malformed`.
5. **negative-pass-without-evidence.json** — `Pass` outcome with
   `evidence: []`. Expected reject:
   `itotori.conformance.pass_without_evidence`.
6. **negative-orphan-result.json** — manifest declares only
   `text-trace`; results carry a `frame-capture` Pass. Expected reject
   at the join step: `itotori.conformance.profile_not_declared`.

Positive fixtures cover one outcome per profile id at the profile's
declared evidence tier ceiling, plus a recording fixture that exercises
the new `statePath` and `runtimeArtifact` evidence ref shapes.

## 6. Audit-focus defenses

| Audit focus                                   | Structural defense                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Evidence promotion during ingest              | TS validator + DB `pass_evidence_tier` column are text; round-trip test compares byte-equal.          |
| Fidelity overclaiming during ingest           | `manifest_fidelity_tier` column is text; service never substitutes when absent.                       |
| Schema gaps allowing arbitrary semantic codes | TS whitelist + DB `LIKE` CHECK constraint enforce the same allow list; both layers must pass.         |
| Skipped/Unsupported promoted to Pass          | TS tagged union enforces variant shape; DB `outcome_kind` CHECK constraint + `pass_tier_check` block. |

## 7. Test plan

Tests follow `docs/dev/testing-standard.md` — falsifiable, behavior-named,
synthetic fixtures only, no live providers.

### 7.1 Bridge schema (`packages/localization-bridge-schema/test/schema.test.ts`, additive block)

Positive:

- `assert_conformance_result_v01_accepts_text_trace_pass()`.
- `assert_conformance_result_v01_accepts_snapshot_restore_pass_with_state_path_evidence()`.
- `assert_conformance_result_v01_accepts_recording_capture_pass_at_e2()`.
- `assert_conformance_manifest_v01_accepts_baseline_text_trace_manifest()`.
- `assert_conformance_result_v01_round_trips_every_evidence_ref_variant()`
  (asserts the six existing kinds plus `statePath` all survive
  serialize → assert → deep equal).

Negative (one per code; each fixture from §5 has its own test):

- `assert_conformance_result_v01_rejects_pass_above_profile_ceiling()`.
- `assert_conformance_result_v01_rejects_pass_without_evidence()`.
- `assert_conformance_result_v01_rejects_semantic_code_outside_whitelist()`.
- `assert_conformance_result_v01_rejects_skip_shape_in_pass_envelope()`.
- `assert_conformance_result_v01_rejects_malformed_recorded_at()`.
- `assert_conformance_result_v01_rejects_unsupported_with_declared_in_manifest_true()`.
- `assert_conformance_result_v01_rejects_evidence_ref_state_path_with_local_path_shape()`.
- `assert_conformance_result_v01_rejects_evidence_ref_runtime_artifact_outside_managed_root()`.
- `assert_conformance_manifest_v01_rejects_schema_version_drift()`.
- `assert_conformance_manifest_v01_rejects_unknown_abi_version()`.

### 7.2 Repository (`packages/itotori-db/test:db` — Postgres integration)

- `conformance_repository_round_trips_a_pass_result_with_evidence_tier_byte_equal()` —
  the headline criterion: serialize a `ConformanceResultV01` with
  `evidenceTier: "E2"`, persist, reload, assert `===`.
- `conformance_repository_round_trips_a_skip_result_without_evidence_tier()`.
- `conformance_repository_round_trips_a_fail_result_with_semantic_code()`.
- `conformance_repository_round_trips_an_unsupported_result_with_declared_in_manifest_false()`.
- `conformance_repository_persists_every_evidence_ref_kind()` (seven
  rows, one per kind).
- `conformance_repository_rejects_pass_row_with_semantic_code_set()`
  (DB CHECK constraint fires; the repository surface should not allow
  this construction, but the constraint is belt-and-suspenders).
- `conformance_repository_rejects_evidence_ref_with_absolute_uri()`.
- `conformance_repository_run_counts_match_sum_of_outcome_kind_rows()`.

### 7.3 Service (`apps/itotori`, Vitest)

- `ingest_conformance_report_persists_pass_with_byte_equal_evidence_tier()`.
- `ingest_conformance_report_rejects_disallowed_semantic_code_at_schema_layer()`.
- `ingest_conformance_report_rejects_promoted_skip_at_schema_layer()`.
- `ingest_conformance_report_rejects_orphan_result_not_declared_in_manifest()`.
- `ingest_conformance_report_summary_counts_match_input_outcomes()`.

### 7.4 CLI handler

- `cli_ingest_conformance_writes_byte_equal_output_when_output_flag_passed()`.
- `cli_ingest_conformance_throws_when_report_file_missing()`.
- `cli_ingest_conformance_throws_when_manifest_schema_version_mismatch()`.

### 7.5 Rust-side parity sanity check

No Rust code changes ship in this slice. A single read-only parity test
lands in
`packages/localization-bridge-schema/test/schema.test.ts` to catch
schema drift: it loads
`crates/utsushi-core/src/conformance/mod.rs` as a text file and
asserts the literal `CONFORMANCE_SCHEMA_VERSION = "0.2.0-alpha"` is
the same string `CONFORMANCE_SCHEMA_VERSION_V01` declares on the TS
side. Cheap structural fence; cost: one test, no Rust build dependency.

## 8. Verification commands

Run from the worktree root:

```
pnpm exec vp run ts:test         # bridge schema + service unit tests
pnpm exec vp run ts:typecheck    # TS surface compiles
cargo test -p utsushi-core       # confirms substrate unaffected
just db-up                       # boots Postgres dev db
just db-migrate                  # applies 0028_runtime_conformance_results.sql
pnpm --filter @itotori/db test:db   # repository integration tests
just check                       # full local gate (fmt, clippy, ts)
just test                        # workspace test gate
```

`pnpm exec vp run ts:test` is the headline gate for criteria 1, 2, 3, 4,
5; `pnpm --filter @itotori/db test:db` is the headline gate for the
byte-equal tier round-trip; `just check` and `just test` are the final
fences before PR ready-for-review.

## 9. Risks and unknowns

### 9.1 TS / Rust schema drift

The TS validator mirrors the Rust validator by hand. If the Rust side
adds an enum variant (e.g. a new `ProfileId`) without the TS side
catching up, the ingest path rejects valid reports. Mitigation: the
parity test in §7.5 pins the schema version string; any Rust-side bump
of `CONFORMANCE_SCHEMA_VERSION` fails the TS test until the TS mirror
is updated. The mirror is single-sourced inside
`packages/localization-bridge-schema/src/conformance.ts` (no scattered
copies), so a drift fix is one PR.

### 9.2 DB schema evolution

The four new tables ship with `text` tier columns and a CHECK constraint
whitelist on semantic-code prefixes. Adding a new allowed prefix (e.g.
`kaifuu.snapshot.*` becomes its own bucket) needs both the TS validator
and the DB CHECK constraint updated. Mitigation: the constraint is
named (`itotori_conformance_results_semantic_code_prefix_check`) so
`alter table ... drop constraint ... add constraint ...` is the
documented migration shape; the test-plan covers the whitelist
explicitly so any future change must update one focused test list.

### 9.3 Semantic-code whitelist evolution

The brief pins three prefixes (`utsushi.conformance.*`,
`utsushi.snapshot.*`, `kaifuu.*`). The downstream engine ports
(UTSUSHI-103 et al.) may want to surface sink-level diagnostics through
the conformance ingest path. Mitigation: this slice **does not** widen
the whitelist; a future RFC + slice can add `utsushi.sink.*` if there
is a falsifiable demand. Documented in §11 out-of-scope.

### 9.4 Evidence ref polymorphic table

The `itotori_conformance_evidence_refs` table is polymorphic by NULL
columns rather than separate tables per kind. This keeps the migration
simple and the repository ergonomic, at the cost of seven NULL-able
columns. A future slice that adds an eighth `EvidenceRef` variant must
add a NULL-able column and a CHECK-constraint update; the alternative
(separate tables per kind) would mean five migrations instead of one
per ref-kind addition. The trade-off is documented; the test plan
covers every kind explicitly.

### 9.5 Round-trip byte-equality

The TS-side `JSON.stringify` is not deterministic for object key order.
The byte-equal acceptance criterion (§criterion 5) is enforced on
**field values**, not on serialized JSON byte streams: the test asserts
`stored.outcome.evidenceTier === source.outcome.evidenceTier` and
similar for fidelity tier, never `JSON.stringify(stored) ===
JSON.stringify(source)`. Documented here so the implementation does not
accidentally pivot to whole-document byte-equality and fail on key
ordering noise.

## 10. Out of scope

- **Actual conformance result generation by engine ports.** Per-port
  adapters that emit `ConformanceResult` JSON land in their own slices
  (UTSUSHI-103 and follow-ups). This slice consumes; it does not
  produce.
- **Snapshot / replay re-execution from ingested results.** The ingest
  path stores the record; it does not re-run the check.
- **Cross-run trend reporting.** Surfacing pass/fail counts across runs
  is dashboard work, not ingest work. The repository exposes the raw
  rows; downstream code can read them.
- **Widening the semantic-code whitelist** beyond
  `utsushi.conformance.*`, `utsushi.snapshot.*`, `kaifuu.*`.
- **New evidence ref kinds.** Seven kinds (six from UTSUSHI-026 plus
  `statePath` from UTSUSHI-028) are supported; an eighth is a future
  additive slice.
- **Manifest-fidelity-tier inference.** When the manifest does not
  declare a fidelity tier (no `optionalExtensions` entry with key
  `"manifest-fidelity-tier"`), the column is NULL. The ingest never
  defaults it.
- **Rust-side ingestion code.** The Rust crate already owns the
  validator and emits the JSON; the ingest path is TS-only.
- **TS-side `cross_validate_conformance_manifest_against_port_manifest`
  mirror.** The PortManifest cross-check is a runner-side concern,
  not an ingest-side concern; the manifest <-> result join check is
  enough for the ingest seam.

## 11. Worker scoping

**One worker**, single PR onto `spec/utsushi-030`. The slice is
cross-cutting (TS schema mirror + DB migration + repository + service +
CLI + fixtures) but each layer is small and the seam between layers is
narrow:

- TS schema mirror: ~600 LOC (`conformance.ts`) + ~400 LOC test
  additions.
- DB migration: ~200 LOC SQL.
- Repository: ~250 LOC TS.
- Service / CLI handler additions: ~150 LOC.
- Fixtures: ~10 JSON files, ~300 LOC total.
- Test additions across schema / repo / service / CLI: ~600 LOC.

Estimated total: ~2,500 LOC inside one PR. Within single-worker scope per
the UTSUSHI-026 / UTSUSHI-029 precedent (which ran ~1,200-1,400 LOC each
in a single PR, but those slices were Rust-only; the cross-cutting
nature here adds line count without adding architectural complexity).

A second worker is not required because:

- The seams are read-only across layers (TS validator does not import
  from `itotori-db`; the repository does not import from
  `apps/itotori`).
- The fixtures are static JSON; no engine port dependency.
- The migration is single-file and reversible by dropping the four
  tables (no data backfill).

## 12. Coordination summary

- **UTSUSHI-026 (landed)** is the structural authority for the schema
  version, the four-variant outcome union, the semantic-code regex, the
  six existing evidence ref kinds, and the join-checker invariants. The
  TS mirror reproduces all four pieces.
- **UTSUSHI-027 (landed)** added trace + branch check codes; ingest
  accepts them through the `utsushi.conformance.*` prefix rule.
- **UTSUSHI-028 (landed)** bumped `CONFORMANCE_SCHEMA_VERSION` to
  `0.2.0-alpha` and added `EvidenceRef::StatePath`. The TS mirror pins
  the new version exactly and includes the seventh evidence ref kind.
- **UTSUSHI-029 (landed)** added capture + recording check codes; ingest
  accepts them through the same `utsushi.conformance.*` prefix.
- **KAIFUU-010 (landed)** established `kaifuu.*` as a valid provider
  prefix; the whitelist allows the full namespace, not a specific
  subprefix.
- **No downstream coordination required for this PR.** Engine ports that
  produce `ConformanceResult` JSON consume the CLI ingest path; their
  PRs will add per-adapter integration tests but do not modify the
  ingest seam.
