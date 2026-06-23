# UTSUSHI-026 — Runtime conformance manifest and result schema

- **Node**: UTSUSHI-026
- **Title**: Runtime conformance manifest and result schema
- **Branch**: `spec/utsushi-026`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-026`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress -> ready_for_review (single implementation slice)
- **Dependency layer landed**: UTSUSHI-020 (VFS), UTSUSHI-021 (input/clock/replay),
  UTSUSHI-022 (sinks), UTSUSHI-103 (engine port runner template) all on main.

## 1. Goal restatement

Define the **runtime conformance contract** that every Utsushi runtime
participant — static probe, launch/capture wrapper, instrumented runtime,
partial VM, or full engine port — uses to declare what it claims to be able
to validate and to report whether each check passed, failed, was skipped, or
is unsupported. Specifically:

1. A **conformance manifest** (Rust `ConformanceManifest`) that adapters
   publish up front, listing the conformance profiles they claim to support
   plus optional extension declarations. This is the audit surface a runner
   (or test harness) checks before driving any conformance lifecycle.
2. A **result schema** (`ConformanceResult` + `ResultOutcome`) that carries
   one outcome per profile with typed Pass / Fail / Skip / Unsupported
   variants. Skip and Unsupported carry semantic reasons; Pass carries the
   actual achieved evidence tier; Fail carries a semantic code and detail.
3. **Validation rules** that make the audit-focus items unrepresentable:
   declared profiles cannot be Skip/Unsupported, Pass cannot exceed the
   manifest's evidence-tier ceiling, evidence references must resolve
   through the existing artifact-store URI policy, and every Skip/Unsupported
   path carries a `utsushi.conformance.*` semantic code.
4. **Engine-neutral schema serialization** (JSON, `camelCase`) suitable for
   the bridge schema package and for `just schema` validation, plus a
   registry-level addition of the `utsushi.conformance.*` allowed-code list
   to the same place UTSUSHI-022 added `utsushi.sink.*` (Rust-side stable
   `pub mod codes::ALL`).
5. **Negative result fixtures** that round-trip through the schema and
   independently validate without any one engine adapter present.

### Downstream constraints that shape this node

- **UTSUSHI-027** (trace and branch conformance, `dependsOn` UTSUSHI-026):
  consumes `ConformanceManifest` to know the adapter claimed `text-trace`
  and/or `branch-capture` profiles, then emits `ConformanceResult` entries
  whose `evidence` cites the `TextSurfaceSink` line ids (UTSUSHI-022) and
  bridge-unit refs.
- **UTSUSHI-028** (snapshot conformance, `dependsOn` UTSUSHI-026 +
  UTSUSHI-023): needs a `snapshot-restore` profile + a way to record
  `state_path` evidence references without requiring a renderer.
- **UTSUSHI-029** (capture and recording artifact conformance, `dependsOn`
  UTSUSHI-026 + UTSUSHI-022): needs evidence references that resolve under
  `RuntimeArtifactRoot` (the existing `validate_runtime_artifact_uri` rule),
  needs `frame-capture` / `recording-capture` profiles, and needs an
  unambiguous `Unsupported` semantic code rather than a missing-field
  signal.
- **UTSUSHI-030** (Itotori ingestion fixture, `dependsOn`
  UTSUSHI-027/028/029): ingests `ConformanceResult` arrays and pipes them
  into dashboards. Requires that `evidenceTier` and the
  declared-but-not-attempted state both stay visible after ingestion. Drives
  the JSON shape decisions for `camelCase`, `schemaVersion`, and the
  outcome discriminator (`outcome.kind`).
- **UTSUSHI-103** (engine port runner template, landed): every engine port
  has a `PortManifest`. The conformance manifest is a **distinct** audit
  surface that sits beside `PortManifest`. They reference each other by id
  but the schemas do not embed each other. See §10.1 risk.

### Distinction from UTSUSHI-025 (coordination note)

UTSUSHI-025 and UTSUSHI-026 are being planned in parallel. The distinction
this plan commits to:

- **UTSUSHI-025 = implementation MAP.** It is the engine-port coverage
  plan: "what subsystems we will cover, what executable fixtures we will
  run, what reference behavior we will compare against." It is consumed by
  workers planning engine work and by reviewers auditing whether claimed
  coverage matches the executable evidence. It is **input artifact** to the
  conformance run, not a runtime output.
- **UTSUSHI-026 = runtime conformance contract.** It is the runtime
  promise + report: "before any run, here is what the adapter declares it
  can validate, and after the run, here is what each declared check
  actually produced." It is **output artifact** consumed by ingestion
  (UTSUSHI-030).

Concretely:

- `ConformanceManifest` MAY name impl-map fixture ids inside
  `EvidenceRef::ImplMapFixture` so a conformance result can cite the
  coverage plan that justified it. But the conformance manifest is NOT the
  impl map: it does not enumerate subsystems, it does not name commands, it
  does not declare reference behavior. UTSUSHI-025 owns those fields.
- The reverse coupling is one-way: the impl map references conformance
  profile ids ("this fixture proves the `text-trace` profile") but does not
  embed `ConformanceManifest` Rust types. UTSUSHI-025 plan is responsible
  for documenting that string-id reference.
- Workers picking up UTSUSHI-025 implementation and UTSUSHI-026
  implementation can land in either order. The only shared artifact is the
  set of well-known conformance profile id strings (e.g. `text-trace`,
  `branch-capture`); they are owned by UTSUSHI-026 and re-exported as
  string constants so UTSUSHI-025 can validate impl-map references against
  them.

This split is the audit-focus "schema coupled to one engine" mitigation:
neither the conformance contract nor the impl map is engine-flavoured;
both are coverage-plan-flavoured.

## 2. Module placement

**Recommendation: keep the conformance substrate in `utsushi-core` as a
new public module `utsushi_core::conformance`, sibling to
`utsushi_core::port` and `utsushi_core::sink`.**

Justification (mirrors the UTSUSHI-020 / UTSUSHI-022 / UTSUSHI-103
placement reasoning):

- `utsushi-core` already owns the shared types this module needs:
  `EvidenceTier`, `FidelityTier`, `RuntimeArtifactKind`,
  `RuntimeArtifactRoot`, `ObservationArtifactRef::validate`,
  `validate_runtime_artifact_uri`, `RUNTIME_ARTIFACT_URI_ROOT`,
  `reject_unredacted_local_paths`, `OBSERVATION_HOOK_SCHEMA_VERSION`,
  `ConformanceReport` artifact kind. A separate `utsushi-conformance` crate
  would have to re-export all of these or take a dep on `utsushi-core` and
  every downstream node would carry two deps.
- Every downstream conformance consumer (UTSUSHI-027/028/029, plus the
  engine port crates that produce conformance results) already depends on
  `utsushi-core`. A new crate produces zero isolation win and one extra
  dep edge.
- The conformance substrate has a small footprint (manifest, result,
  outcome enum, evidence ref, profile id set, semantic codes, validation
  rules, fixture builders). Module-level isolation inside
  `utsushi-core/src/conformance/` is the same shape that worked for
  `sink/` and `port/`.

**Submodule layout under `crates/utsushi-core/src/conformance/`:**

```
crates/utsushi-core/src/conformance/
  mod.rs           # re-exports + crate docs + ProfileId constants
  manifest.rs      # ConformanceManifest, ConformanceProfile,
                   #   ProfileExtension, validate()
  result.rs        # ConformanceResult, ResultOutcome, EvidenceRef,
                   #   cross-validation against manifest
  diagnostics.rs   # ConformanceError, semantic code module (codes::*),
                   #   stable utsushi.conformance.* constants
  fixtures.rs      # Builder helpers + ConformanceFixture::*
                   #   constructors used by negative/positive round-trip
                   #   tests. Gated cfg(any(test, feature =
                   #   "conformance-fixtures")) so downstream test crates
                   #   can opt in via dev-dep.
```

`utsushi-core/src/lib.rs` re-exports the public surface:

```rust
pub mod conformance;

pub use conformance::{
    ConformanceAbiVersion, ConformanceError, ConformanceFixture,
    ConformanceManifest, ConformanceProfile, ConformanceResult,
    EvidenceRef, ProfileExtension, ProfileId, ResultOutcome,
    SubsystemRequirement, CONFORMANCE_SCHEMA_VERSION,
};
```

**No new workspace member is introduced.** No new third-party dep is
introduced (`serde`, `serde_json` already present).

## 3. Conformance profile id catalog

Profile ids are the audit-stable handle every downstream node refers to.
Owning them here (rather than letting each consumer invent its own string)
is what keeps the contract decoupled from any one engine and keeps the
impl-map → conformance cross-reference (see §1 UTSUSHI-025 split)
machine-checkable.

```rust
/// Stable conformance profile identifier. Lives in `conformance/mod.rs`
/// so consumers do not have to import a manifest type just to name a
/// profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileId {
    /// Adapter can produce a deterministic text trace whose ordering and
    /// bridge-unit linkage UTSUSHI-027 validates.
    TextTrace,
    /// Adapter can enumerate runtime choice / branch points and the
    /// observed traversal matches expected (UTSUSHI-027).
    BranchCapture,
    /// Adapter can take a snapshot at a logical tick and restore it
    /// (UTSUSHI-028).
    SnapshotRestore,
    /// Adapter can emit at least one `FrameArtifactSink::emit_frame`
    /// referenced through `RuntimeArtifactRoot` (UTSUSHI-029).
    FrameCapture,
    /// Adapter can emit a recording artifact referenced through
    /// `RuntimeArtifactRoot::Recording` (UTSUSHI-029).
    RecordingCapture,
    /// Adapter can drive a replay log and replay the recorded trace
    /// (UTSUSHI-021/103 substrate already shipped; the conformance check
    /// rides on top via UTSUSHI-027 or a successor).
    DeterministicReplay,
}

impl ProfileId {
    pub fn as_str(self) -> &'static str { /* kebab-case */ }
    /// Required subsystems the profile depends on at the substrate level.
    pub fn required_subsystems(self) -> &'static [SubsystemRequirement];
    /// Maximum evidence tier this profile may ever claim. Independent of
    /// the adapter's manifest ceiling; the profile itself caps Pass.
    pub fn evidence_tier_ceiling(self) -> EvidenceTier;
}
```

Per-profile ceilings (the audit-focus "skipped features hidden as passing
checks" defense lives partly here):

| Profile                | Subsystems                            | Ceiling |
| ---------------------- | ------------------------------------- | ------- |
| `text-trace`           | TextSink                              | E1      |
| `branch-capture`       | TextSink                              | E1      |
| `snapshot-restore`     | SnapshotPrimitives (reserved for 023) | E1      |
| `frame-capture`        | FrameSink, ArtifactStore              | E2      |
| `recording-capture`    | FrameSink, ArtifactStore              | E2      |
| `deterministic-replay` | ReplayLog, LogicalClock, TextSink     | E1      |

`SubsystemRequirement` is a small enum naming substrate dependencies the
profile rests on, used by `ConformanceManifest::validate` to make a
manifest that claims `frame-capture` but cannot wire a `FrameArtifactSink`
fail validation rather than silently produce empty results.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubsystemRequirement {
    AssetAccess,         // RuntimeVfs (UTSUSHI-020)
    Input,               // InputEvent / ReplayLog (UTSUSHI-021)
    Clock,               // LogicalClock (UTSUSHI-021)
    ReplayLog,           // ReplayLog finalisation (UTSUSHI-021)
    TextSink,            // TextSurfaceSink (UTSUSHI-022)
    FrameSink,           // FrameArtifactSink (UTSUSHI-022)
    AudioSink,           // AudioEventSink (UTSUSHI-022)
    ArtifactStore,       // RuntimeArtifactRoot (utsushi-core)
    SnapshotPrimitives,  // reserved for UTSUSHI-023
}
```

`SnapshotPrimitives` is reserved-but-inert, matching the
`PortCapability::Snapshot` precedent from UTSUSHI-103. Defining it now
keeps the enum stable.

## 4. Conformance manifest schema

### 4.1 `ConformanceManifest`

```rust
pub const CONFORMANCE_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Adapter-published declaration of which conformance profiles it claims
/// to satisfy. Built by an adapter once at registration time, validated
/// by `Runner::validate_conformance_manifest` (sibling to the existing
/// `Runner::validate_manifest` for PortManifest), and shipped alongside
/// the `PortManifest` for the same adapter id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceManifest {
    /// Schema version pin. Validated literally on
    /// `from_json_value`; mismatches return
    /// `ConformanceError::UnsupportedSchemaVersion`.
    pub schema_version: String,

    /// Stable adapter id. Lowercased, matches the `PortManifest::id`
    /// pattern `[a-z][a-z0-9-]{7,63}`. The conformance manifest does NOT
    /// have to live inside the same crate as the PortManifest — workers
    /// can publish a separate adapter id for a separate conformance
    /// surface — but the id pattern is shared so audit tooling can join.
    pub adapter_id: String,

    /// Conformance ABI version. Distinct from `PortManifest::abi_version`
    /// (which gates `EnginePort` lifecycle method shape). Bumped only
    /// when the result schema gains a breaking field.
    pub abi_version: ConformanceAbiVersion,

    /// Declared profiles. Order is not significant; duplicates are
    /// rejected by `validate`.
    pub supported_profiles: Vec<ConformanceProfile>,

    /// Optional, audit-visible extensions a profile may turn on, e.g.
    /// per-frame mode flags or branch-discovery selection rules. Each
    /// extension references a profile by id; orphaned extensions are
    /// rejected.
    pub optional_extensions: Vec<ProfileExtension>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConformanceAbiVersion(pub u32);
```

`ConformanceAbiVersion` is a single `u32` (matches the UTSUSHI-103
`Runner::SUPPORTED_ABI_VERSIONS` precedent — exact membership, not range
comparison).

### 4.2 `ConformanceProfile`

```rust
/// Declared profile commitment. The adapter promises to attempt the
/// profile during the conformance run; producing `Skip` or `Unsupported`
/// for a declared profile is a validation error at result time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceProfile {
    /// Profile identifier (typed enum, not a free-form string).
    pub id: ProfileId,

    /// Subsystems the adapter declares it has wired. Must be a superset
    /// of `ProfileId::required_subsystems`. Extras are accepted and
    /// surfaced in the result so reviewers can see what the adapter
    /// brought.
    pub required_subsystems: Vec<SubsystemRequirement>,

    /// Maximum evidence tier this adapter will ever claim for this
    /// profile. Must satisfy:
    ///   evidence_tier_ceiling <= ProfileId::evidence_tier_ceiling
    /// and
    ///   evidence_tier_ceiling <= adapter's PortManifest.evidence_tier_max
    /// when the two are paired. The second constraint is checked by
    /// `Runner::validate_conformance_manifest_against_port`, NOT by
    /// `ConformanceManifest::validate` alone — keeping the conformance
    /// manifest independently validatable from any port.
    pub evidence_tier_ceiling: EvidenceTier,
}
```

Profile equality is by `id` only (validated through a separate dedupe
pass); the validator rejects two `ConformanceProfile` entries with the
same `id` regardless of subsystem differences. This is the audit-focus
"unsupported features reported without semantic reason codes" defense at
the manifest level: an adapter that wants two different shapes for the
same profile must pick one.

### 4.3 `ProfileExtension`

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExtension {
    /// Profile this extension augments. Must match an entry in
    /// `supported_profiles`; orphans are rejected.
    pub profile_id: ProfileId,

    /// Stable, namespaced extension key. Lowercased,
    /// `[a-z][a-z0-9-]{0,63}`. Examples (typed-but-string for forward
    /// compatibility): "rgba8", "monotonic-tick", "lossless-recording".
    pub key: String,

    /// Audit-visible note explaining what the extension changes. Plain
    /// public string; never a host path.
    pub note: String,
}
```

Extensions are intentionally string-keyed because the audit-focus value
is "this adapter claims this thing under this profile," not "we have
typed every capability." A future tightening can promote frequently-used
keys to a typed enum without breaking old manifests (additive on the
deserialize side: keys not in the enum stay as strings).

### 4.4 Manifest validation rules

`ConformanceManifest::validate(&self) -> Result<(), ConformanceError>`
enforces:

1. `schema_version == CONFORMANCE_SCHEMA_VERSION` — strict literal
   match. Failure: `UnsupportedSchemaVersion { observed, expected }`,
   code `utsushi.conformance.unsupported_schema_version`.
2. `adapter_id` matches the id pattern. Failure:
   `AdapterIdMalformed { id }`,
   code `utsushi.conformance.adapter_id_malformed`.
3. `abi_version` is a member of `ConformanceManifest::SUPPORTED_ABI_VERSIONS`
   (initial value `&[1]`). Failure:
   `UnknownAbiVersion { declared, supported }`,
   code `utsushi.conformance.unknown_abi_version`.
4. `supported_profiles` is non-empty. (A manifest that supports nothing
   should not exist; it is a configuration mistake, not a feature.)
   Failure: `ManifestEmpty`,
   code `utsushi.conformance.manifest_empty`.
5. Profile ids are unique across `supported_profiles`. Failure:
   `DuplicateProfile { id }`,
   code `utsushi.conformance.duplicate_profile`.
6. For every profile P:
   - `P.required_subsystems` is a superset of
     `P.id.required_subsystems()`. Failure:
     `MissingSubsystem { profile, missing }`,
     code `utsushi.conformance.missing_subsystem`.
   - `P.required_subsystems` has no duplicates. Failure:
     `DuplicateSubsystem { profile, subsystem }`,
     code `utsushi.conformance.duplicate_subsystem`.
   - `P.evidence_tier_ceiling <= P.id.evidence_tier_ceiling()`. Failure:
     `EvidenceTierAboveProfileCeiling { profile, claimed, ceiling }`,
     code `utsushi.conformance.evidence_tier_above_profile_ceiling`.
7. `optional_extensions`: every extension's `profile_id` is in
   `supported_profiles`. Failure:
   `OrphanedExtension { key, profile_id }`,
   code `utsushi.conformance.orphaned_extension`.
   Extension `key` is unique within `(profile_id, key)`. Failure:
   `DuplicateExtension { profile_id, key }`,
   code `utsushi.conformance.duplicate_extension`.
   Key matches the kebab-case pattern; failure:
   `ExtensionKeyMalformed { key }`,
   code `utsushi.conformance.extension_key_malformed`.

Validation does NOT check against any `PortManifest`. That cross-check
lives in a separate helper that pairs the two (§7.2). The split is
deliberate: it lets a worker validate a conformance manifest fixture in
isolation (acceptance criterion 3).

## 5. Result schema

### 5.1 Types

```rust
/// One outcome per profile attempted in a conformance run. Always
/// produced for every profile the manifest declared; never silently
/// omitted. The runner is responsible for emitting one entry per
/// `manifest.supported_profiles` element.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceResult {
    /// Schema version pin.
    pub schema_version: String,

    /// Adapter id that produced this result. MUST equal
    /// `ConformanceManifest::adapter_id` when the result is paired with
    /// a manifest (validated by the cross-checker, not by
    /// `ConformanceResult::validate` alone).
    pub adapter_id: String,

    /// Profile this outcome reports on.
    pub profile_id: ProfileId,

    /// Outcome discriminator.
    pub outcome: ResultOutcome,

    /// Evidence references. May be empty for Skip/Unsupported variants;
    /// MUST be non-empty for Pass. Validated by
    /// `EvidenceRef::validate()`.
    pub evidence: Vec<EvidenceRef>,

    /// RFC3339 timestamp the runner recorded when finalising this
    /// result. Plain string field; volatility is fine because
    /// determinism is asserted at the trace level (UTSUSHI-021), not at
    /// the report level. Normalised during golden fixture comparison.
    pub recorded_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResultOutcome {
    /// The profile was attempted and satisfied. `evidence_tier` is the
    /// tier actually achieved, capped at the profile's manifest
    /// `evidence_tier_ceiling` (validated cross-tier).
    Pass {
        evidence_tier: EvidenceTier,
    },

    /// The profile was attempted and failed. `semantic_code` is one of
    /// the `utsushi.conformance.*` failure codes (or a downstream
    /// `utsushi.<subsystem>.*` code passed through); `detail` is a
    /// short, public-string description.
    Fail {
        semantic_code: String,
        detail: String,
    },

    /// The profile was deliberately not attempted in this run (e.g.
    /// suite filter excluded it, or required input was absent). Skip is
    /// **forbidden for declared profiles** (cross-validated against the
    /// manifest). When emitted by a runner, the manifest MUST omit this
    /// profile id from `supported_profiles`.
    Skip {
        semantic_code: String,
        reason: String,
    },

    /// The adapter does not implement this profile. **Forbidden** when
    /// the manifest declared the profile (`declared_in_manifest = true`
    /// is the immediate validation reject). `semantic_code` carries an
    /// engine-neutral reason; `declared_in_manifest` echoes the cross-
    /// check input so reviewers can see the manifest state at result
    /// time without joining tables.
    Unsupported {
        semantic_code: String,
        declared_in_manifest: bool,
    },
}
```

The `tag = "kind"` discriminator is what UTSUSHI-030 ingestion expects;
JSON output looks like `{ "kind": "pass", "evidenceTier": "E1" }`. The
discriminator is `kind` and not `outcome` because the parent struct's
field is already named `outcome`.

### 5.2 Evidence references

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "artifactKind", rename_all = "camelCase")]
pub enum EvidenceRef {
    /// Reference to an artifact-store-managed runtime artifact (text
    /// trace, screenshot, frame-capture, recording, conformance report).
    /// `uri` is validated through `validate_runtime_artifact_uri` —
    /// rejects absolute paths, traversal, `file:`/`data:`/`blob:`
    /// schemes, and anything outside `RUNTIME_ARTIFACT_URI_ROOT`.
    RuntimeArtifact {
        kind: RuntimeArtifactKind,
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
    },

    /// Reference to a TextSurfaceSink emission identified by line id.
    /// UTSUSHI-027 uses this for trace order assertions.
    TextLine {
        line_id: String,
    },

    /// Reference to a FrameArtifactSink emission identified by frame id.
    /// UTSUSHI-029 uses this for capture-policy assertions.
    FrameArtifactRef {
        frame_id: String,
    },

    /// Reference to a recorded `ReplayLog` whose `run_id` proves the
    /// replay run (UTSUSHI-021).
    ReplayLogRef {
        run_id: String,
    },

    /// Cross-reference to an impl-map fixture id (UTSUSHI-025). The
    /// fixture id is a public, kebab-case string. This is the **only**
    /// coupling between conformance and impl-map; it is one-way (results
    /// cite an impl-map fixture; the impl map does not embed result
    /// types).
    ImplMapFixture {
        fixture_id: String,
    },

    /// Bridge-unit linkage. The bridge unit id format is checked through
    /// the existing `ObservationBridgeRef::validate` rules.
    BridgeUnit {
        bridge_unit_id: String,
    },
}

impl EvidenceRef {
    pub fn validate(&self) -> Result<(), ConformanceError>;
}
```

`EvidenceRef::validate` rules:

- `RuntimeArtifact` calls `validate_runtime_artifact_uri(&self.uri)` and
  rejects on failure with
  `EvidenceRefInvalid { artifact_kind: "runtime_artifact", reason }`,
  code `utsushi.conformance.evidence_ref_invalid`.
- `TextLine.line_id`, `FrameArtifactRef.frame_id`,
  `ReplayLogRef.run_id`, `ImplMapFixture.fixture_id`,
  `BridgeUnit.bridge_unit_id`: non-empty, no whitespace, no
  newline characters; checked through `reject_unredacted_local_paths`
  so a leaked host path can't enter the schema.

### 5.3 Result validation rules

`ConformanceResult::validate(&self) -> Result<(), ConformanceError>`
enforces the **standalone** result rules — what is checkable without the
manifest:

1. `schema_version == CONFORMANCE_SCHEMA_VERSION`. Failure:
   `UnsupportedSchemaVersion`.
2. `adapter_id` matches the id pattern.
3. `recorded_at` parses as RFC3339. Failure:
   `RecordedAtMalformed`,
   code `utsushi.conformance.recorded_at_malformed`.
4. For every `EvidenceRef`, call `validate`.
5. Outcome-specific rules:
   - `Pass`: `evidence` MUST be non-empty (no Pass without proof).
     Failure: `PassWithoutEvidence`,
     code `utsushi.conformance.pass_without_evidence`.
   - `Pass.evidence_tier <= profile_id.evidence_tier_ceiling()`.
     Failure: `EvidenceTierAboveProfileCeiling`,
     code `utsushi.conformance.evidence_tier_above_profile_ceiling`.
   - `Fail.semantic_code` is non-empty, matches `^utsushi\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
     (allows pass-through of `utsushi.sink.*`, `utsushi.input.*`,
     `utsushi.replay.*`, `utsushi.conformance.*`). Failure:
     `MalformedSemanticCode { code }`,
     code `utsushi.conformance.malformed_semantic_code`.
   - `Skip.semantic_code` and `Unsupported.semantic_code` follow the
     same pattern check.
   - `Unsupported.declared_in_manifest = true` is **always** an
     immediate reject: a manifest-declared profile cannot be Unsupported.
     Failure: `DeclaredProfileReportedAsUnsupported`,
     code `utsushi.conformance.declared_profile_reported_as_unsupported`.
     (This rule is enforceable on the result alone because the value of
     `declared_in_manifest` is a property of the result payload itself.
     The cross-check in §7.2 catches the symmetric Skip case which needs
     the manifest.)

`ConformanceResult` validation does **not** check whether the manifest
omitted the profile (Skip case) — that requires the manifest. The
cross-validation in §7.2 does.

## 6. Validation rules summary

| Rule                                           | Where checked                                    | Code                                                           |
| ---------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Manifest schema version literal                | `ConformanceManifest::validate`                  | `utsushi.conformance.unsupported_schema_version`               |
| Manifest adapter id pattern                    | `ConformanceManifest::validate`                  | `utsushi.conformance.adapter_id_malformed`                     |
| Manifest ABI version known                     | `ConformanceManifest::validate`                  | `utsushi.conformance.unknown_abi_version`                      |
| Manifest non-empty profile list                | `ConformanceManifest::validate`                  | `utsushi.conformance.manifest_empty`                           |
| Profile ids unique                             | `ConformanceManifest::validate`                  | `utsushi.conformance.duplicate_profile`                        |
| Profile required subsystems superset           | `ConformanceManifest::validate`                  | `utsushi.conformance.missing_subsystem`                        |
| Profile subsystem duplicates                   | `ConformanceManifest::validate`                  | `utsushi.conformance.duplicate_subsystem`                      |
| Profile evidence ceiling <= profile id ceiling | `ConformanceManifest::validate`                  | `utsushi.conformance.evidence_tier_above_profile_ceiling`      |
| Extension key kebab pattern                    | `ConformanceManifest::validate`                  | `utsushi.conformance.extension_key_malformed`                  |
| Extension references a declared profile        | `ConformanceManifest::validate`                  | `utsushi.conformance.orphaned_extension`                       |
| Extension key unique per profile               | `ConformanceManifest::validate`                  | `utsushi.conformance.duplicate_extension`                      |
| Result schema version literal                  | `ConformanceResult::validate`                    | `utsushi.conformance.unsupported_schema_version`               |
| Result recorded_at RFC3339                     | `ConformanceResult::validate`                    | `utsushi.conformance.recorded_at_malformed`                    |
| Evidence ref URI/format                        | `EvidenceRef::validate`                          | `utsushi.conformance.evidence_ref_invalid`                     |
| Pass has non-empty evidence                    | `ConformanceResult::validate`                    | `utsushi.conformance.pass_without_evidence`                    |
| Pass tier <= profile ceiling                   | `ConformanceResult::validate`                    | `utsushi.conformance.evidence_tier_above_profile_ceiling`      |
| Outcome semantic code shape                    | `ConformanceResult::validate`                    | `utsushi.conformance.malformed_semantic_code`                  |
| Unsupported with `declared_in_manifest=true`   | `ConformanceResult::validate`                    | `utsushi.conformance.declared_profile_reported_as_unsupported` |
| Result adapter id matches manifest             | `cross_validate_results_against_manifest` (§7.2) | `utsushi.conformance.adapter_id_mismatch`                      |
| Declared profile reported as Skip              | `cross_validate_results_against_manifest`        | `utsushi.conformance.declared_profile_skipped`                 |
| Declared profile reported as Unsupported       | `cross_validate_results_against_manifest`        | `utsushi.conformance.declared_profile_not_declared` (sym)      |
| Pass tier <= manifest profile ceiling          | `cross_validate_results_against_manifest`        | `utsushi.conformance.pass_above_manifest_ceiling`              |
| Manifest profile missing from results          | `cross_validate_results_against_manifest`        | `utsushi.conformance.profile_not_reported`                     |
| Result profile not in manifest                 | `cross_validate_results_against_manifest`        | `utsushi.conformance.profile_not_declared`                     |

The hard-constraint "Skipped ≠ Pass" lives in the type system itself
(separate `Pass` and `Skip` variants), but the audit-focus item is also
enforced procedurally: an adapter that declares a profile in its manifest
and then emits `Skip` for it is rejected with
`utsushi.conformance.declared_profile_skipped`.

## 7. Cross-validation surface

### 7.1 Standalone vs paired validation

The split is deliberate:

- `ConformanceManifest::validate()` checks manifest-internal rules.
- `ConformanceResult::validate()` checks result-internal rules.
- `cross_validate_results_against_manifest(manifest, results)` checks
  the join rules: declared profiles attempted, no orphan results,
  outcome-vs-manifest tier ceilings.

This gives acceptance criterion 3 ("Result fixtures validate
independently of any one engine adapter") for free: a downstream test
crate can validate a manifest fixture or a result fixture without
pulling in the other half. UTSUSHI-027/028/029 will use both halves;
UTSUSHI-030 ingestion will use both halves at the dashboard boundary.

### 7.2 `cross_validate_results_against_manifest`

```rust
pub fn cross_validate_results_against_manifest(
    manifest: &ConformanceManifest,
    results: &[ConformanceResult],
) -> Result<(), ConformanceError>;
```

Enforces:

1. Every `ConformanceResult` has `adapter_id == manifest.adapter_id`.
   Failure: `AdapterIdMismatch { manifest, result }`.
2. The set of `result.profile_id` covers every
   `manifest.supported_profiles.id`. Missing profiles:
   `ProfileNotReported { profile }`.
3. No result reports a profile id absent from `supported_profiles`:
   `ProfileNotDeclared { profile }`.
4. For results where `outcome == Skip`, the profile MUST NOT be in
   `supported_profiles`. Already covered by rule 3.
5. For results where `outcome == Unsupported`,
   `declared_in_manifest` MUST equal whether the profile id is in
   `manifest.supported_profiles`. Specifically: if the profile is
   declared, `declared_in_manifest = true` is already rejected by
   `ConformanceResult::validate` (immediate Unsupported reject); if the
   profile is not declared, the result is allowed but
   `declared_in_manifest = true` would be a false claim and is rejected
   here.
6. For results where `outcome == Pass { evidence_tier }`, the tier MUST
   be `<= manifest.supported_profiles[profile].evidence_tier_ceiling`.
   Failure: `PassAboveManifestCeiling`.

### 7.3 Optional cross-check with `PortManifest`

Exposed but **not** part of every consumer's required flow:

```rust
pub fn cross_validate_conformance_manifest_against_port_manifest(
    conformance: &ConformanceManifest,
    port: &PortManifest,
) -> Result<(), ConformanceError>;
```

Enforces (when both are present):

1. `conformance.adapter_id == port.id`.
   Failure: `AdapterIdMismatch`.
2. Every profile's `evidence_tier_ceiling <= port.evidence_tier_max`.
3. Subsystem requirements are consistent with `PortCapability`:
   - `SubsystemRequirement::TextSink` implies `PortCapability::Observe`
     (text traces come from the observe stage).
   - `SubsystemRequirement::FrameSink` implies `PortCapability::Capture`.
   - `SubsystemRequirement::ReplayLog` implies
     `PortCapability::DeterministicReplay` (reserved capability).
   - `SubsystemRequirement::SnapshotPrimitives` implies
     `PortCapability::Snapshot`.

This helper is the one place the two manifests touch. It is opt-in
because UTSUSHI-026 wants to leave room for adapters that ship without a
`PortManifest` (e.g. a launch-host wrapper that is not yet an
`EnginePort`). The function returns `Ok(())` if either side is missing
information rather than implicit failure.

## 8. Semantic codes

All conformance semantic codes live in
`conformance::diagnostics::codes`. They mirror the
`vfs::diagnostics::codes::ALL` and `sink::errors::codes::ALL` shape so
the downstream allowed-code validator can not silently drop a variant.

```rust
pub mod codes {
    pub const UNSUPPORTED_SCHEMA_VERSION: &str =
        "utsushi.conformance.unsupported_schema_version";
    pub const ADAPTER_ID_MALFORMED: &str =
        "utsushi.conformance.adapter_id_malformed";
    pub const UNKNOWN_ABI_VERSION: &str =
        "utsushi.conformance.unknown_abi_version";
    pub const MANIFEST_EMPTY: &str = "utsushi.conformance.manifest_empty";
    pub const DUPLICATE_PROFILE: &str =
        "utsushi.conformance.duplicate_profile";
    pub const MISSING_SUBSYSTEM: &str =
        "utsushi.conformance.missing_subsystem";
    pub const DUPLICATE_SUBSYSTEM: &str =
        "utsushi.conformance.duplicate_subsystem";
    pub const EVIDENCE_TIER_ABOVE_PROFILE_CEILING: &str =
        "utsushi.conformance.evidence_tier_above_profile_ceiling";
    pub const ORPHANED_EXTENSION: &str =
        "utsushi.conformance.orphaned_extension";
    pub const DUPLICATE_EXTENSION: &str =
        "utsushi.conformance.duplicate_extension";
    pub const EXTENSION_KEY_MALFORMED: &str =
        "utsushi.conformance.extension_key_malformed";
    pub const RECORDED_AT_MALFORMED: &str =
        "utsushi.conformance.recorded_at_malformed";
    pub const EVIDENCE_REF_INVALID: &str =
        "utsushi.conformance.evidence_ref_invalid";
    pub const PASS_WITHOUT_EVIDENCE: &str =
        "utsushi.conformance.pass_without_evidence";
    pub const MALFORMED_SEMANTIC_CODE: &str =
        "utsushi.conformance.malformed_semantic_code";
    pub const DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED: &str =
        "utsushi.conformance.declared_profile_reported_as_unsupported";
    pub const DECLARED_PROFILE_SKIPPED: &str =
        "utsushi.conformance.declared_profile_skipped";
    pub const PROFILE_NOT_DECLARED: &str =
        "utsushi.conformance.profile_not_declared";
    pub const PROFILE_NOT_REPORTED: &str =
        "utsushi.conformance.profile_not_reported";
    pub const ADAPTER_ID_MISMATCH: &str =
        "utsushi.conformance.adapter_id_mismatch";
    pub const PASS_ABOVE_MANIFEST_CEILING: &str =
        "utsushi.conformance.pass_above_manifest_ceiling";

    pub const ALL: &[&str] = &[
        UNSUPPORTED_SCHEMA_VERSION,
        ADAPTER_ID_MALFORMED,
        UNKNOWN_ABI_VERSION,
        MANIFEST_EMPTY,
        DUPLICATE_PROFILE,
        MISSING_SUBSYSTEM,
        DUPLICATE_SUBSYSTEM,
        EVIDENCE_TIER_ABOVE_PROFILE_CEILING,
        ORPHANED_EXTENSION,
        DUPLICATE_EXTENSION,
        EXTENSION_KEY_MALFORMED,
        RECORDED_AT_MALFORMED,
        EVIDENCE_REF_INVALID,
        PASS_WITHOUT_EVIDENCE,
        MALFORMED_SEMANTIC_CODE,
        DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED,
        DECLARED_PROFILE_SKIPPED,
        PROFILE_NOT_DECLARED,
        PROFILE_NOT_REPORTED,
        ADAPTER_ID_MISMATCH,
        PASS_ABOVE_MANIFEST_CEILING,
    ];
}
```

A `#[cfg(test)]` assertion confirms every `ConformanceError::semantic_code()`
output is a member of `codes::ALL`, mirroring the `sink::errors` test
precedent.

### 8.1 Mapping to kaifuu.\* codes

The audit focus mentions mapping `utsushi.conformance.*` to
`kaifuu.*` where applicable. The mapping is documented (not codified)
in this slice because no `kaifuu.*` code is consumed at the runtime
boundary today. The mapping policy:

- A conformance failure caused by an upstream Kaifuu issue
  (e.g. unknown key/profile, schema mismatch in a bridge bundle) is
  reported as `ResultOutcome::Fail` with `semantic_code` set to the
  upstream `kaifuu.*` code rather than `utsushi.conformance.*`. The
  shape check (`utsushi.<subsystem>.<reason>`) is relaxed at the
  validation layer to allow any matching `^<provider>\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
  prefix where `<provider>` is one of `utsushi` or `kaifuu`. A test
  pins this allowance.

The decision not to codify a `kaifuu.*` constant list here is the
audit-friendly choice: UTSUSHI-026 should not be the place that lists
Kaifuu codes (KAIFUU project owns its own code registry). The schema
just has to permit them.

## 9. Schema serialization and registry update

### 9.1 JSON wire format

- `serde` with `#[serde(rename_all = "camelCase")]` on every type. This
  matches `RuntimeEvidenceReportV02` and the existing observation hook
  payload conventions in `utsushi-core::lib.rs`.
- `ResultOutcome` uses `#[serde(tag = "kind", rename_all = "camelCase")]`.
  Wire form: `{ "kind": "pass", "evidenceTier": "E1" }`,
  `{ "kind": "fail", "semanticCode": "...", "detail": "..." }`,
  `{ "kind": "skip", "semanticCode": "...", "reason": "..." }`,
  `{ "kind": "unsupported", "semanticCode": "...", "declaredInManifest": false }`.
- `EvidenceRef` uses `#[serde(tag = "artifactKind", rename_all = "camelCase")]`.
- `ProfileId`, `SubsystemRequirement` use `rename_all = "kebab-case"`
  (id-shaped) and `"snake_case"` (subsystem-shaped) respectively. The
  difference matches the precedent: ids that downstream packages use as
  string keys are kebab-case (e.g. `text-trace`); enum subsystem names
  follow the Rust snake_case mapping.

### 9.2 Round-trip helpers

```rust
impl ConformanceManifest {
    pub fn to_json_value(&self) -> UtsushiResult<serde_json::Value>;
    pub fn from_json_value(value: serde_json::Value) -> UtsushiResult<Self>;
}

impl ConformanceResult {
    pub fn to_json_value(&self) -> UtsushiResult<serde_json::Value>;
    pub fn from_json_value(value: serde_json::Value) -> UtsushiResult<Self>;
}
```

The helpers call `validate()` after deserialization and before returning,
so a parsed manifest/result is structurally valid by construction.

### 9.3 `just schema` integration

`just schema` runs the bridge-schema TypeScript package's typecheck +
tests + build (`pnpm --filter @itotori/localization-bridge-schema ...`).
The UTSUSHI-026 wire-format types live on the Rust side; the schema
package validates the runtime evidence report shape. UTSUSHI-026 does
NOT introduce a new TypeScript schema in this node — UTSUSHI-030 owns
the ingestion side. The contribution `just schema` enforces here is:

- The `RUNTIME_REFERENCE_COMPARISON_KINDS_V02` constant already lists
  `"conformance_fixture"`. UTSUSHI-026 does NOT need to add a new
  reference-comparison kind: results are referenced from runtime
  evidence reports through the existing `"conformance_fixture"` shape.
  This plan adds a fixture in
  `packages/localization-bridge-schema/test/examples/` that demonstrates
  a runtime evidence report citing a conformance result via the existing
  field. The fixture references a conformance result JSON file under
  `crates/utsushi-core/tests/fixtures/conformance/` (kept in the Rust
  test tree) by hash; cross-package integration of TypeScript-side
  validation of the conformance JSON shape is deferred to UTSUSHI-030.
- The Rust-side `pub mod codes::ALL` registry is the **authoritative**
  source of allowed conformance codes for this slice. UTSUSHI-030 will
  mirror it into the TypeScript schema package; here we only commit to
  exposing it in `utsushi-core` so a future TypeScript mirror has a
  single source of truth.

### 9.4 Where the UTSUSHI-022 precedent applies

UTSUSHI-022 added `utsushi.sink.*` semantic codes; UTSUSHI-021 added
`utsushi.input.*`, `utsushi.clock.*`, `utsushi.replay.*`. The pattern in
all three: a stable `pub mod codes` in the owning module + an `ALL: &[&str]`
slice + a `#[cfg(test)]` parity test asserting every variant's
`semantic_code()` is in `ALL`. UTSUSHI-026 follows that pattern exactly
in `conformance::diagnostics::codes`. The "allowed-code list" the brief
mentions is this Rust-side `ALL` slice; UTSUSHI-022 set the same
precedent. There is no separate JSON allowed-code file in this slice.

## 10. Risks and unknowns

### 10.1 Tight coupling with UTSUSHI-103 `PortManifest`

The two manifests serve different audiences:

- `PortManifest` (UTSUSHI-103) audits the engine port's
  lifecycle/capability surface. Its `id` and `version` describe the
  Rust crate.
- `ConformanceManifest` (UTSUSHI-026) audits the adapter's conformance
  surface. Its `adapter_id` describes the conformance-publishing entity,
  which usually equals the port id but may diverge (e.g. a launch-host
  wrapper that does not have a `PortManifest`).

This plan commits to:

- No structural embedding. `ConformanceManifest` does not contain a
  `PortManifest` field, and vice versa.
- Cross-check helper (§7.3) is optional and lives in
  `conformance::manifest`. Adapters with no `PortManifest` skip it.
- Profile id pattern matches the port id pattern. Both are
  `[a-z][a-z0-9-]{7,63}`.

This is the **smallest** acceptable coupling that meets acceptance
criterion 3 ("Result fixtures validate independently of any one engine
adapter") while keeping audit tooling able to join the two manifests at
the id level.

### 10.2 Profile granularity

How fine-grained should `ProfileId` be? Two ends of the spectrum:

- **Too coarse**: one `Conformance` profile. Easy to pass but says
  nothing about which check actually fired. Defeats the audit focus.
- **Too fine**: one profile per assertion (e.g. `text-trace-order`,
  `text-trace-bridge-link`). Maintenance hell, every UTSUSHI-027 test
  becomes its own profile id.

Decision: **the six profile ids in §3 are the canonical set for the
alpha track**. They map 1:1 to the UTSUSHI-027/028/029 nodes (with
DeterministicReplay reserved for a follow-up). Adding a profile is
additive (enum variant); removing one is a breaking change. UTSUSHI-026
does NOT add `audio-event-trace` because UTSUSHI-022 already capped
audio at E0 metadata; a conformance-side `audio-event` profile would
only confirm "metadata was emitted," which is structurally trivial. If
a future node needs an audio profile it can add the variant with the
same `evidence_tier_ceiling = E0`.

### 10.3 Schema evolution and version bump policy

`CONFORMANCE_SCHEMA_VERSION = "0.1.0-alpha"` is the initial value.
`ConformanceAbiVersion(1)` is the initial ABI.

Policy:

- **Adding a `ProfileId` variant**: schema bumps to `0.2.0-alpha`.
  Deserialization rejects unknown variants by default (Rust serde
  default for non-`untagged` enums). To allow forward compatibility,
  `from_json_value` for `ConformanceManifest` and `ConformanceResult`
  uses a custom deserializer that converts unknown profile ids into a
  reserved `ProfileId::Unknown(String)` variant — **NOT** in this slice;
  see Out of Scope §11. For now, unknown profile ids are an error,
  matching the strictness UTSUSHI-021's replay-log version-pinning takes.
- **Adding a `ResultOutcome` variant**: same; schema bump + strict reject
  in this slice; lenient deserialization a later choice.
- **Adding an `EvidenceRef` variant**: same.
- **Adding an `optional_extensions[].key`**: free; extension keys are
  strings.

The version field is required (per acceptance criterion 1 — the contract
is declarative and audit-stable). The ABI version exists because
profile-id additions are visible at the type system level, while ABI
additions (e.g. a new mandatory result field) require a coordinated
bump.

### 10.4 Skip semantics for not-declared profiles

The schema permits `Skip` only for profiles **not** in the manifest's
`supported_profiles`. A runner that wants to surface "this run did not
exercise the `frame-capture` profile because the suite filter excluded
it" emits a `Skip` result for that profile. The declared-set discipline
means the manifest doesn't have to be re-published per run; the result
is the audit trail of what was actually attempted.

The risk is "runner forgets to emit Skip for an undeclared profile."
That is not a result-schema concern: the manifest declares zero
expectations for undeclared profiles. UTSUSHI-027/028/029 own the
suite-completeness contract on the runner side.

### 10.5 RFC3339 string for `recorded_at` is volatile

`recorded_at` is volatile by design; golden fixtures normalise it. This
matches the existing runtime evidence report shape, which also carries a
volatile timestamp. The tradeoff is reviewers see when a result was
produced; determinism for replay is asserted via the trace + replay log,
not the conformance report timestamp.

### 10.6 Kaifuu code pass-through

The `^<provider>\.[a-z0-9_]+\.[a-z0-9_]+$` relaxation lets `kaifuu.*`
codes appear inside `ResultOutcome::Fail.semantic_code`. The risk is an
unbounded provider list. Mitigation: the validation regex limits the
provider prefix to `utsushi` or `kaifuu` (literal alternation), not any
identifier. Adding a third provider is a deliberate schema bump.

### 10.7 No optionality in cross-validation

The cross-validator is **mandatory** for any runner emitting paired
manifest+results. UTSUSHI-027/028/029 must call it. This plan
intentionally does NOT provide an "ignore mismatches" mode or a "warn
only" flag. The hard architectural constraint "no optionality" forbids
it.

### 10.8 No new TypeScript schema in this node

UTSUSHI-030 owns the TypeScript-side schema mirror for ingestion. This
plan does NOT add TS types for `ConformanceManifest`/`ConformanceResult`.
The Rust JSON wire format is the contract; UTSUSHI-030 deserialises it.
Keeping the TS schema out of UTSUSHI-026 keeps the slice reviewable and
avoids cross-package coordination on the alpha track.

## 11. Out of scope

- **Actual conformance checks**: UTSUSHI-027 (trace + branch),
  UTSUSHI-028 (snapshot), UTSUSHI-029 (capture + recording),
  UTSUSHI-030 (Itotori ingestion). UTSUSHI-026 produces only types,
  validators, semantic codes, and round-trip + negative-case fixtures.
- **Engine ports** consuming the conformance manifest. The fixture
  adapter is NOT modified by this slice. The first port to publish a
  `ConformanceManifest` is a follow-up sibling slice; this slice ships
  with synthetic test-crate-only ports.
- **Lenient forward-compat deserialization** (unknown-profile-id
  fallback): documented in §10.3 as a deferred decision; this slice is
  strict.
- **TypeScript schema mirror**: UTSUSHI-030 ingestion node.
- **TS-side allowed-code validator** for `utsushi.conformance.*` codes
  in JSON fixtures committed to
  `packages/localization-bridge-schema/test/examples/`. This slice adds
  Rust-side `codes::ALL` and a test against it; the TS mirror is
  UTSUSHI-030.
- **Snapshot primitives** (UTSUSHI-023). `SnapshotPrimitives` is a
  reserved enum variant; nothing wires it.
- **Audio-event conformance profile**. Documented as deferred in §10.2.
- **Pairing with `PortManifest` in production runners**. The cross-check
  helper is shipped but not consumed by any production code path in
  this slice; UTSUSHI-031+ engine ports will start calling it.
- **Reference-runtime comparison evidence** (E4). The schema supports
  `EvidenceTier::E4` mechanically (it's in the enum), but no profile in
  the canonical set in §3 has a ceiling above E2. The reference
  comparison path is a future profile addition.
- **Branch frontier scheduler integration** (UTSUSHI-106). Conformance
  manifests do not feed the scheduler; the scheduler consumes
  observation events. Decoupled.

## 12. Test plan

All tests follow `docs/testing-standard.md`. Unit tests live with the
modules under `crates/utsushi-core/src/conformance/`; integration tests
under `crates/utsushi-core/tests/conformance_*.rs`. All tests are
falsifiable, behavior-named, and use synthetic inline fixtures (no
private corpora, no live providers).

### 12.1 Profile id catalog

In `conformance/mod.rs::tests`:

- `profile_id_required_subsystems_text_trace_includes_text_sink()`.
- `profile_id_required_subsystems_frame_capture_includes_frame_sink_and_artifact_store()`.
- `profile_id_required_subsystems_snapshot_restore_includes_snapshot_primitives()`.
- `profile_id_required_subsystems_deterministic_replay_includes_replay_log_and_clock()`.
- `profile_id_evidence_tier_ceiling_text_trace_is_e1()`.
- `profile_id_evidence_tier_ceiling_frame_capture_is_e2()`.
- `profile_id_as_str_is_kebab_case_for_every_variant()`.
- `profile_id_round_trips_through_serde_in_kebab_case()`.

### 12.2 Manifest validation (in `conformance/manifest.rs::tests`)

Round-trip:

- `manifest_round_trips_through_serde_json()`.
- `manifest_to_json_value_uses_camel_case_keys()`.

Acceptance:

- `manifest_validate_accepts_well_formed_text_trace_manifest()`.
- `manifest_validate_accepts_manifest_with_optional_extension()`.

Rejection (one test per `codes::*` constant):

- `manifest_validate_rejects_mismatched_schema_version()`.
- `manifest_validate_rejects_adapter_id_with_uppercase()`.
- `manifest_validate_rejects_unknown_abi_version()`.
- `manifest_validate_rejects_empty_profile_list()`.
- `manifest_validate_rejects_duplicate_profile_id()`.
- `manifest_validate_rejects_profile_missing_required_subsystem()`.
- `manifest_validate_rejects_profile_with_duplicate_subsystem()`.
- `manifest_validate_rejects_profile_evidence_tier_above_profile_ceiling()`.
- `manifest_validate_rejects_extension_with_unknown_profile_id()`.
- `manifest_validate_rejects_duplicate_extension_key_per_profile()`.
- `manifest_validate_rejects_extension_key_with_uppercase()`.

### 12.3 Result validation (in `conformance/result.rs::tests`)

Round-trip:

- `result_pass_round_trips_through_serde_json()`.
- `result_fail_round_trips_through_serde_json()`.
- `result_skip_round_trips_through_serde_json()`.
- `result_unsupported_round_trips_through_serde_json()`.
- `result_outcome_kind_discriminator_serializes_as_camel_case()`.

Acceptance:

- `result_validate_accepts_pass_with_runtime_artifact_evidence()`.
- `result_validate_accepts_fail_with_utsushi_sink_semantic_code()`.
- `result_validate_accepts_fail_with_kaifuu_provider_semantic_code()`.
- `result_validate_accepts_skip_for_undeclared_profile()`.

Rejection:

- `result_validate_rejects_pass_without_evidence()`.
- `result_validate_rejects_pass_with_tier_above_profile_ceiling()`.
- `result_validate_rejects_outcome_with_malformed_semantic_code()`.
- `result_validate_rejects_outcome_with_unknown_provider_prefix()`.
- `result_validate_rejects_unsupported_when_declared_in_manifest_true()`.
- `result_validate_rejects_recorded_at_not_rfc3339()`.
- `result_validate_rejects_evidence_ref_runtime_artifact_with_file_scheme()`.
- `result_validate_rejects_evidence_ref_runtime_artifact_outside_managed_root()`.
- `result_validate_rejects_evidence_ref_text_line_with_whitespace_id()`.
- `result_validate_rejects_evidence_ref_bridge_unit_with_local_path_substring()`.

### 12.4 Cross-validation (in

`crates/utsushi-core/tests/conformance_cross_validation.rs`)

- `cross_validate_accepts_manifest_and_matching_pass_result()`.
- `cross_validate_rejects_declared_profile_reported_as_skip()` —
  the headline audit-focus defense.
- `cross_validate_rejects_declared_profile_reported_as_unsupported_via_result_validate()`.
- `cross_validate_rejects_undeclared_profile_with_unsupported_declared_in_manifest_true()`.
- `cross_validate_rejects_result_with_adapter_id_not_matching_manifest()`.
- `cross_validate_rejects_pass_tier_above_manifest_profile_ceiling()`.
- `cross_validate_rejects_manifest_profile_missing_from_results()`.
- `cross_validate_rejects_result_profile_not_in_manifest()`.
- `cross_validate_with_port_manifest_rejects_evidence_tier_above_port_max()`.
- `cross_validate_with_port_manifest_returns_ok_when_port_manifest_absent()`.

### 12.5 Diagnostics (in `conformance/diagnostics.rs::tests`)

- `every_conformance_error_variant_returns_a_code_in_codes_all()`.
- `conformance_error_display_does_not_leak_host_paths()` — pattern
  match against `/home/`, `/tmp/`, `/Users/`, `/var/folders/`, `file://`.
- `conformance_error_implements_std_error()`.

### 12.6 Negative fixtures (integration,

`crates/utsushi-core/tests/conformance_fixtures.rs`)

Stand-alone JSON fixtures committed under
`crates/utsushi-core/tests/fixtures/conformance/` that demonstrate each
rejection variant independently of any engine adapter (acceptance
criterion 3):

- `negative_fixture_declared_profile_skipped.json` —
  `from_json_value` parses, `cross_validate` rejects.
- `negative_fixture_pass_without_evidence.json` —
  `ConformanceResult::from_json_value` rejects.
- `negative_fixture_pass_above_profile_ceiling.json` —
  `ConformanceResult::from_json_value` rejects.
- `negative_fixture_unsupported_declared_in_manifest_true.json` —
  `ConformanceResult::from_json_value` rejects.
- `negative_fixture_evidence_ref_file_scheme.json` —
  `ConformanceResult::from_json_value` rejects.
- `negative_fixture_duplicate_profile.json` —
  `ConformanceManifest::from_json_value` rejects.
- `negative_fixture_orphaned_extension.json` —
  `ConformanceManifest::from_json_value` rejects.
- `positive_fixture_text_trace_pass.json` — `from_json_value` plus
  `cross_validate` both accept.
- `positive_fixture_frame_capture_pass.json` — same.

Each fixture is loaded by a separate `#[test]` whose name matches the
fixture file. The fixtures are stored as JSON files (not inline `json!`
macros) so reviewers can read them as JSON and so a future TypeScript
mirror has a clear input.

### 12.7 Bridge-schema integration smoke (in

`packages/localization-bridge-schema/test/`)

A single TS test:

- `runtime evidence report referencing a conformance fixture validates
through assertRuntimeEvidenceReportV02` —
  builds a runtime evidence report that references a conformance
  fixture by hash through the existing `conformance_fixture` reference
  comparison kind. This proves the existing bridge schema already
  accommodates conformance reports; no new TS code is added.

### 12.8 No `compile_fail` doctests

Following the precedent from UTSUSHI-103 and UTSUSHI-020, this slice
does NOT add `trybuild` / `compile_fail` tests. The type-system "Skip
cannot be Pass" claim is structural (separate enum variants); the
"declared profile cannot be Skip/Unsupported" claim is enforced through
the validators, asserted in §12.4.

## 13. Verification commands

Per the DAG node (`UTSUSHI-026.verification`):

```
cargo test -p utsushi-core
just schema
```

Recommended local additions:

```
cargo test -p utsushi-core conformance     # focused crate filter
cargo test -p utsushi-fixture              # no-regression bar; fixture
                                           # adapter is not modified
just check                                 # workspace gate
node scripts/spec-dag.mjs validate         # DAG self-check
```

Reasoning:

- `cargo test -p utsushi-core` exercises every unit + integration test
  in §12 (including the JSON fixtures in §12.6).
- `cargo test -p utsushi-fixture` must pass unchanged — UTSUSHI-026 does
  not touch the fixture adapter or its descriptor. The new module is
  additive at `utsushi_core::conformance::*`.
- `just schema` runs the bridge-schema TypeScript suite. The slice does
  not introduce a new TS schema, but §12.7 adds one TS test that
  exercises the existing `conformance_fixture` reference comparison
  kind. `just schema` will pick it up automatically.
- `just check` is the workspace gate (fmt, clippy, schema lint,
  toolchain policy). Recommended pre-PR.

## 14. Worker scoping

Recommendation: **one worker, one implementation slice.**

Rationale:

- The substrate is tightly coupled. `ConformanceManifest`,
  `ConformanceResult`, `ResultOutcome`, `EvidenceRef`,
  `cross_validate_*`, and the semantic-code registry share validation
  helpers, fixture builders, and serde plumbing. Splitting into two PRs
  (e.g. manifest-only then result-only) would create cross-PR coupling
  on the shared `ConformanceError` enum and the `codes::ALL` test.
- The fixture adapter is **not** modified. Conformance manifests are a
  separate audit surface; the first adapter to publish one is a
  follow-up slice tracked outside UTSUSHI-026.
- Test surface is moderate but well-bounded: ~35 unit tests, 2
  integration test files, 9 JSON fixture files, 1 TS smoke test.
- The slice depends only on already-landed substrate (UTSUSHI-020,
  UTSUSHI-021, UTSUSHI-022, UTSUSHI-103). No coordination with a
  parallel UTSUSHI-026 sub-slice is needed.

Coordination check with UTSUSHI-025 (parallel-planned): the only shared
output is the `ProfileId::as_str()` kebab-case constant set. UTSUSHI-025
implementation reads those strings; UTSUSHI-026 owns them. There is no
shared mutable state.

Estimated worker time: medium. The bulk of effort is the validator rules
(20+ named diagnostics) and the negative-fixture authoring; the
serialization is mechanical.

### 14.1 Implementation slice — `UTSUSHI-026-conformance-substrate`

Single PR owns:

- `utsushi_core::conformance::{mod, manifest, result, diagnostics,
fixtures}` modules.
- Public re-exports at the crate root.
- Round-trip helpers (`to_json_value` / `from_json_value`) for
  manifest and result.
- Standalone `validate()` for manifest, result, evidence ref.
- `cross_validate_results_against_manifest` and
  `cross_validate_conformance_manifest_against_port_manifest`.
- `pub mod codes` with `ALL: &[&str]` parity test.
- Integration test
  `crates/utsushi-core/tests/conformance_cross_validation.rs`.
- Integration test
  `crates/utsushi-core/tests/conformance_fixtures.rs` plus the 9 JSON
  fixtures under
  `crates/utsushi-core/tests/fixtures/conformance/`.
- One TypeScript smoke test under
  `packages/localization-bridge-schema/test/` proving the existing
  `conformance_fixture` reference comparison kind accommodates the
  shape (§12.7).

Verification: `cargo test -p utsushi-core`, `cargo test -p utsushi-fixture`,
`just schema`, `just check`, `node scripts/spec-dag.mjs validate`.

## Plan ends here.
