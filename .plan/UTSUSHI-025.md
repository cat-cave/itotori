# UTSUSHI-025 — Engine port implementation map validator

- **Node**: UTSUSHI-025
- **Title**: Engine port implementation map validator
- **Branch**: `spec/utsushi-025`
- **Worktree**: `/scratch/worktrees/itotori-spec-utsushi-025`
- **Author**: planning worker (orchestrator)
- **Date**: 2026-06-23
- **Status target**: in_progress → ready_for_review
- **Depends on**: UTSUSHI-020 (VFS) — landed; UTSUSHI-103 (engine-port runner template) — landed.
- **Coordinates with (parallel)**: UTSUSHI-026 (conformance manifest + result schema) — distinct artifact; see §11.
- **Consumers**: UTSUSHI-031–039 (per-engine ports), UTSUSHI-146 (RealLive port). UTSUSHI-025 is a hard dep for them — they cannot land without producing a validated `ImplementationMap`.

## 1. Goal restatement

UTSUSHI-025 builds the **engine-port implementation-map artifact**: a typed,
serializable, validated scaffold that every engine-port worker must produce and
attach to their slice. The map captures, per engine port:

1. Which **engine subsystems** the slice covers and at what status (supported,
   partial with declared limitations, unsupported with semantic reason, or
   research-with-evidence-refs).
2. The **executable fixture** that exercises each covered subsystem, with full
   provenance (public fixture id, content hash, byte count, public/private
   classification).
3. The **validation command(s)** that exercise the fixture and the expected
   outcome (pass / skip-with-reason / fail-with-semantic-code).
4. The **reference behavior** the port is being validated against (engine
   runtime, observable signal, capture method) — what an auditor would compare
   against to falsify the coverage claim.

The map is **engine-neutral**: the same schema validates RealLive, RPG Maker
MV/MZ, KiriKiri/KAG, plain XP3, Siglus, Wolf, BGI/Ethornell, and TyranoScript
slices. Engine-specific shape is encoded as an opaque `engine_family: String`
plus a free-form `capability_list: Vec<String>` per subsystem. The schema MUST
NOT carry XP3/KAG/JSON/RGSS3/`.koe`-shaped fields.

The map is **coverage scaffolding** — it is explicitly forbidden from being
accepted as standalone alpha-readiness evidence, standalone feasibility
evidence, or a substitute for a working slice. It is the structured shape that
engine-port research output MUST land in so it cannot regress into
"unstructured engine notes accepted as coverage."

### Why this exists (auditFocus mapping)

- **"Validated report becoming a decision node"** → the map's `Status::Validated`
  variant means "the schema validates," not "the port is ready." Status
  promotion requires a separately-landed engine-port slice (UTSUSHI-031–039/146)
  citing the map. The validator's success diagnostic MUST embed this disclaimer
  (§4.4) and the type itself MUST surface a typestate that distinguishes
  "schema-valid" from "alpha-ready."
- **"Unstructured engine notes accepted as coverage"** → the schema rejects any
  subsystem entry that lacks a `FixtureRef` AND a `ValidationCommand` id pointing
  at an existing entry. There is no free-text-only subsystem variant.
- **"Missing fixture provenance"** → `FixtureRef` requires id, kind, hash, byte
  count, and public/private classification. Empty / placeholder / sentinel hash
  fails validation with a typed diagnostic.

## 2. Module placement

**Recommendation: new sibling submodule `utsushi_core::port::impl_map`,
alongside `manifest`, `conformance`, `runner`, `trait_`, `diagnostics`.**

Justification:

- The map is conceptually a **sibling** to `PortManifest` (UTSUSHI-103). The
  manifest is the audit-grade _static_ declaration shipped as a `const` by each
  port crate; the impl map is the _coverage_ declaration the engine-port worker
  commits as a serialized artifact alongside their slice. Both live in
  `utsushi-core::port::*` because they share the same audit surface and are both
  engine-neutral types every port consumes.
- Co-locating with `manifest.rs` lets cross-validation (§4.6) reference
  `PortManifest`'s capability set without crossing a crate boundary.
- The map is engine-neutral; it does not belong in any engine port crate.
- It does not belong in `crates/utsushi-core/src/vfs/` because it operates above
  the VFS — it cites assets by VFS asset id but does not implement VFS surface.
- It does not belong in a new `utsushi-impl-map` crate. Every engine port crate
  already depends on `utsushi-core` for the runner template; a new crate would
  force a second dep with no isolation gain.

**Submodule layout under `crates/utsushi-core/src/port/impl_map/`**:

```text
crates/utsushi-core/src/port/impl_map/
├── mod.rs           # public surface; re-exports
├── schema.rs        # Rust types (ImplementationMap, Subsystem, FixtureRef, ...)
├── diagnostics.rs   # ImplMapError + variant docs
├── validator.rs     # validate(&ImplementationMap) -> Result<ValidationReport, Vec<ImplMapError>>
├── serde.rs         # JSON wire form, schema_version pin, camelCase field names
└── status.rs        # Status typestate (Draft / Validated / Outdated) + promotion rules
```

`port::mod.rs` adds `pub mod impl_map;` and `pub use impl_map::{...}` for the
five top-level types (`ImplementationMap`, `Subsystem`, `FixtureRef`,
`ValidationCommand`, `ReferenceBehavior`) plus the error type and
`validate(...)`. Internal sub-types (`SubsystemStatus`,
`ExpectedOutcome`, `Status`) are re-exported through the same path.

## 3. Schema shape

All field names below are Rust identifiers; their JSON wire shape (camelCase)
is specified in §6. All types derive `Clone, Debug, PartialEq, Eq, Serialize,
Deserialize`. `Eq`/`Hash` where IDs are used as map keys (`FixtureRef::id`,
`ValidationCommand::id`, `Subsystem::id`).

```rust
/// Schema version pin. Bumped on any breaking wire change. UTSUSHI-025 ships
/// `"0.1.0"`. Validator rejects unknown major versions with
/// `ImplMapError::UnsupportedSchemaVersion`.
pub const IMPL_MAP_SCHEMA_VERSION: &str = "0.1.0";

/// Top-level artifact. One per engine-port slice.
pub struct ImplementationMap {
    /// Pinned schema version (matches IMPL_MAP_SCHEMA_VERSION at write time).
    pub schema_version: String,

    /// Stable port id matching the engine port's `PortManifest::id`
    /// (e.g. "utsushi-reallive", "utsushi-rpgmaker-mv"). Validator cross-
    /// checks this against a supplied `PortManifest` when one is provided
    /// (see §4.6) but the map itself is standalone-serializable.
    pub port_id: PortId,

    /// Free-form engine family discriminant. The schema is engine-neutral;
    /// engine-specific shape lives in this string + per-subsystem capability
    /// lists. Allowed values are a stable enum-shaped set:
    /// "reallive" | "rpgmaker-mv" | "rpgmaker-mz" | "rpgmaker-vx-ace" |
    /// "kirikiri-kag" | "xp3" | "siglus" | "renpy" | "wolf-rpg-editor" |
    /// "bgi-ethornell" | "tyranoscript" | "rgss3" | "unity" | "other".
    /// "other" REQUIRES a non-empty `engine_family_notes` field.
    pub engine_family: EngineFamily,

    /// Optional human-readable engine variant context for `EngineFamily::Other`
    /// or for any port that needs to disambiguate (e.g. "rpgmaker-mv" vs
    /// "rpgmaker-mv-pixi-v5"). Validator REQUIRES non-empty when
    /// engine_family == Other.
    pub engine_family_notes: Option<String>,

    /// Coverage scope. Must contain at least one entry. Validator rejects
    /// empty subsystem lists with `ImplMapError::NoSubsystemsDeclared`.
    pub subsystems: Vec<Subsystem>,

    /// Validation commands. The schema-private id is referenced by each
    /// subsystem's `validation_command_id`. Validator rejects empty command
    /// lists with `ImplMapError::NoValidationCommandsDeclared`.
    pub validation_commands: Vec<ValidationCommand>,

    /// Reference-behavior commitments. REQUIRED — the map cannot be a
    /// disembodied list of subsystems; an auditor must be able to ask
    /// "compared against what?".
    pub reference_behavior: ReferenceBehavior,

    /// Lifecycle status. `Draft` / `Validated` / `Outdated`. The validator
    /// promotes Draft → Validated only when ALL invariants hold.
    /// `Validated` carries an audit-visible disclaimer (§4.4) so it cannot
    /// be misread as alpha-readiness.
    pub status: Status,

    /// RFC 3339 timestamp at generation. Validator does not interpret —
    /// downstream "Outdated" checks (UTSUSHI-031+) compare this against
    /// manifest and dep-graph timestamps.
    pub generated_at: String,
}

/// One engine subsystem the slice covers. Every Subsystem MUST link to a
/// FixtureRef AND a ValidationCommand; there is no free-text-only variant.
pub struct Subsystem {
    /// Schema-local id, used by `validation_command_id` cross-refs. Must be
    /// stable, kebab-case, port-unique. Validator rejects duplicates with
    /// `ImplMapError::DuplicateSubsystemId`.
    pub id: SubsystemId,

    /// Human-readable subsystem name (e.g. "Scene/SEEN replay",
    /// "Event Command 101 text box", "KAG message tag handler").
    pub name: String,

    /// Status of coverage for this subsystem.
    pub status: SubsystemStatus,

    /// Fixture provenance. REQUIRED — no Option, no default. Validator
    /// rejects sentinel/placeholder hashes with
    /// `ImplMapError::MissingFixtureProvenance`.
    pub fixture_ref: FixtureRef,

    /// Validation command id (must match a `ValidationCommand::id` in the
    /// same map). REQUIRED. Validator rejects unknown ids with
    /// `ImplMapError::OrphanValidationCommandRef`.
    pub validation_command_id: ValidationCommandId,

    /// Free-form capability tags this subsystem exercises (e.g.
    /// "deterministic-text-trace", "frame-capture-e2",
    /// "shift-jis-decode", "kag-macro-expansion"). Engine-neutral discipline:
    /// these are *capability* labels, not engine-specific field shapes.
    /// Empty list is rejected with `ImplMapError::EmptyCapabilityList`.
    pub capabilities: Vec<String>,

    /// Audit-visible notes. Free text. May be empty.
    pub notes: String,
}

/// Status of a single subsystem's coverage. The schema commits to four
/// shapes; there is NO "Unknown"/"TBD"/free-text-only shape.
pub enum SubsystemStatus {
    /// Covered by an executable fixture + validation command and expected
    /// to pass.
    Supported,

    /// Covered partially. Each declared limitation MUST be non-empty.
    /// Validator rejects empty `limitations` with
    /// `ImplMapError::PartialWithoutLimitations`.
    Partial { limitations: Vec<String> },

    /// Explicitly out of scope. `reason` MUST cite a semantic error code
    /// (e.g. "utsushi.capability.unsupported", "kaifuu.unsupported_layered_transform")
    /// OR a "deferred-to-<NODE-ID>" sentinel referencing a roadmap node.
    /// Validator rejects free-text reasons that match neither shape with
    /// `ImplMapError::UnsupportedReasonNotSemantic`.
    Unsupported { reason: UnsupportedReason },

    /// Research subsystem: not yet covered by a fixture-driven validation,
    /// but documented as research output with cited evidence references.
    /// `evidence_refs` MUST be non-empty AND each ref MUST point to an
    /// in-tree fixture, doc, or roadmap node (validated shape — see
    /// `EvidenceRef` below).
    Research { evidence_refs: Vec<EvidenceRef> },
}

pub enum UnsupportedReason {
    /// "utsushi.capability.unsupported", "kaifuu.unsupported_*", etc.
    /// Matches the `<project>.<category>.<detail>` pattern enforced by
    /// existing `SemanticErrorCode` catalogues.
    SemanticCode(String),
    /// "deferred-to-UTSUSHI-104", "deferred-to-KAIFUU-174", etc.
    /// Validator checks the referenced id matches the project's node id
    /// regex (`^(UTSUSHI|KAIFUU|ITOTORI|ALPHA|SHARED)-\d{3}$`).
    DeferredTo(String),
}

pub struct EvidenceRef {
    /// One of: "fixture", "doc", "roadmap-node", "reference-impl-anchor".
    pub kind: EvidenceKind,
    /// Path or id (e.g. "fixtures/public/reallive-detector/...",
    /// "docs/kaifuu-adapters/reallive.md", "UTSUSHI-146",
    /// "https://dev.haeleth.net/rldev.shtml#license-posture: research-only").
    pub locator: String,
    /// Short audit caption explaining what this evidence proves.
    /// Empty caption is rejected.
    pub caption: String,
}

pub enum EvidenceKind {
    Fixture,
    Doc,
    RoadmapNode,
    ReferenceImplAnchor,
}

/// Fixture provenance. EVERY field is required, validated, and non-sentinel.
pub struct FixtureRef {
    /// Stable fixture id. Public fixtures: must match an entry in
    /// `fixtures/public/manifest.schema.json` (validator cross-checks when a
    /// manifest catalogue is supplied; otherwise the id is checked for
    /// shape only). Private-local: free shape but classification MUST say so.
    pub id: String,

    /// Public-or-private classification. Validator rejects ambiguous /
    /// unclassified fixtures with `ImplMapError::FixtureClassificationMissing`.
    pub classification: FixtureClassification,

    /// Coarse fixture kind. Engine-neutral; validator rejects "other" without
    /// a non-empty `kind_notes` field.
    pub kind: FixtureKind,
    pub kind_notes: Option<String>,

    /// Content hash (SHA-256, hex-lowercase, 64 chars). Validator rejects
    /// any string that doesn't match the regex with
    /// `ImplMapError::FixtureHashMalformed`. Sentinel "0"*64 hashes and
    /// "TODO"/"PLACEHOLDER" tokens are rejected with
    /// `ImplMapError::MissingFixtureProvenance`.
    pub hash: String,

    /// Total byte count of the fixture root (sum of file bytes for
    /// directory fixtures, file size for file fixtures). Validator rejects
    /// zero with `ImplMapError::FixtureByteCountZero`.
    pub byte_count: u64,
}

pub enum FixtureClassification {
    /// Lives under `fixtures/public/`, has a manifest entry, is committed.
    Public,
    /// Lives under `fixtures/private-local/`, NEVER committed. The map
    /// itself may reference it, but downstream public-CI validation flags
    /// any subsystem that depends only on private-local fixtures unless
    /// the slice also has a public fixture covering the same capability.
    PrivateLocal,
    /// Synthetic in-test bytes generated by the test (no on-disk file).
    /// Validator REQUIRES `kind == FixtureKind::SyntheticInline` for this.
    SyntheticInline,
}

pub enum FixtureKind {
    /// Single file (e.g. `SEEN.TXT`).
    File,
    /// Directory tree (e.g. an unpacked RPG Maker MV game root).
    Directory,
    /// Tar/zip/xp3/pck archive bytes.
    Archive,
    /// Bytes generated in-test from a builder.
    SyntheticInline,
    /// Reserved for future fixture kinds. REQUIRES non-empty `kind_notes`.
    Other,
}

pub struct ValidationCommand {
    /// Schema-local id; referenced by `Subsystem::validation_command_id`.
    /// Validator rejects duplicates and orphan refs.
    pub id: ValidationCommandId,

    /// The command line. Engine-neutral discipline: should be either
    /// `cargo test -p <crate> [test-filter]`, `cargo run -p <crate> -- <args>`,
    /// or `just <recipe>`. Validator rejects:
    /// - empty strings
    /// - shell-syntax pipelines/redirections/subshells/backticks/`$(` —
    ///   matched by a deliberately strict char-set check; this guards against
    ///   shell-out smuggling and matches §"No shell-outs" architectural rule.
    /// Diagnostic: `ImplMapError::ValidationCommandUnsafeShape`.
    pub command: String,

    /// What the command is expected to produce.
    pub expected_outcome: ExpectedOutcome,

    /// Audit caption. Required, non-empty. What does this command prove?
    pub caption: String,
}

pub enum ExpectedOutcome {
    /// Exit 0; no semantic skip; all assertions pass.
    Pass,
    /// Command is allowed to skip with the given reason.
    /// `reason` MUST cite a semantic skip code (e.g.
    /// "utsushi.host.browser_unavailable"). Free-text reasons fail
    /// validation with `ImplMapError::SkipReasonNotSemantic`.
    Skip { reason: String },
    /// Command is expected to fail with the given semantic code (negative
    /// tests). `semantic_code` MUST match the
    /// `<project>.<category>.<detail>` pattern.
    Fail { semantic_code: String },
}

pub struct ReferenceBehavior {
    /// What the port is being validated against. Examples:
    /// "rlvm (reference)", "RPG Maker MV browser runtime (NW.js 0.83)",
    /// "synthetic fixture (no reference runtime)".
    /// Empty string is rejected.
    pub engine_runtime: String,

    /// What an auditor can observe to falsify the port's claim. Examples:
    /// "deterministic text trace per scene id",
    /// "headless screenshot at scene-end marker",
    /// "audio event marker count per scene".
    /// Empty is rejected.
    pub observable_signal: String,

    /// How the comparable evidence was/will be captured. Engine-neutral
    /// label set: "trace-log", "screenshot-artifact", "audio-event",
    /// "snapshot-state", "synthetic-self-check", "no-reference-comparison".
    /// "no-reference-comparison" is allowed but flagged in the validator's
    /// ValidationReport (§4.3) as a non-blocking *warning-equivalent* the
    /// caller sees; it does NOT downgrade Status::Validated.
    pub capture_method: CaptureMethod,
}

pub enum Status {
    /// Author has written the map; it has not been validated, or the
    /// validator was run and produced errors.
    Draft,
    /// All schema invariants hold. The validator promotes Draft -> Validated.
    /// Carries a fixed disclaimer string the validator emits in
    /// `ValidationReport::status_disclaimer` so dashboards and reviewers
    /// cannot read "Validated" as "the port is alpha-ready" — it means
    /// "the coverage scaffolding is structurally valid."
    Validated,
    /// A previously-Validated map whose deps have shifted (manifest
    /// version, dep-graph edge changes, schema bump). UTSUSHI-025 ships
    /// only the variant; the *detection* is performed by downstream
    /// consumers (UTSUSHI-031+) — out of scope here.
    Outdated,
}

// Newtype wrappers (transparent serde) for IDs to prevent
// cross-contamination at validator time.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PortId(pub String);
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SubsystemId(pub String);
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ValidationCommandId(pub String);
```

### Engine-neutrality discipline (architectural constraint)

The schema MUST NOT contain any of the following field names or variants in the
public Rust types or wire form: `xp3_*`, `kag_*`, `rgss3_*`, `tjs_*`, `seen_*`,
`gameexe_*`, `scene_pck_*`, `pixi_*`, `nwjs_*`, `unity_*`. All engine-specific
shape lives in (a) `engine_family` discriminant, (b) free-form `capabilities`
list per subsystem (string tags, not typed fields), and (c) audit-visible
`notes`/`caption` strings. Reviewer test: a diff that adds an XP3-named field
fails the standing review checklist in §7.

## 4. Validator

### 4.1 Surface

```rust
pub fn validate(map: &ImplementationMap) -> Result<ValidationReport, Vec<ImplMapError>>;
```

Returns `Vec<ImplMapError>` (NOT a single error) so a Draft map gets every
diagnostic in one pass — the auditor doesn't fix one error, re-run, and
discover the next.

```rust
pub struct ValidationReport {
    pub status_disclaimer: &'static str, // §4.4
    pub warnings: Vec<ValidationWarning>, // capture-method == NoReferenceComparison etc.
    pub schema_version: &'static str,
}

pub enum ValidationWarning {
    NoReferenceComparison,
    OnlyPrivateLocalFixtures { subsystem_id: SubsystemId },
    ResearchSubsystemPresent { subsystem_id: SubsystemId },
}
```

### 4.2 Invariants the validator enforces

1. `schema_version` matches `IMPL_MAP_SCHEMA_VERSION` (major-version
   compatible).
2. `port_id` matches the port-id grammar (§2 of UTSUSHI-103: lowercase
   alphanum + `-`, 8–64 chars).
3. `engine_family` ∈ allowed enum, and `engine_family_notes` is non-empty when
   `Other`.
4. `subsystems` is non-empty.
5. `validation_commands` is non-empty.
6. Every `Subsystem.id` is unique within the map.
7. Every `ValidationCommand.id` is unique within the map.
8. Every `Subsystem.validation_command_id` maps to an existing
   `ValidationCommand.id`.
9. Every `ValidationCommand.id` is referenced by at least one `Subsystem`
   (orphan-command check).
10. Every `Subsystem.fixture_ref` passes:
    - hash matches `^[0-9a-f]{64}$`
    - hash is NOT `"0" * 64` or any documented sentinel (`"TODO"`, `"TBD"`,
      `"PLACEHOLDER"`, case-insensitive substring check)
    - byte_count > 0 UNLESS `classification == SyntheticInline` AND
      `kind == SyntheticInline` (where byte_count documents synthetic-size and
      may be the size of the generated bytes).
    - `classification` is one of the three enum variants (deserializer enforces;
      typed in Rust).
    - `kind == Other` requires non-empty `kind_notes`.
11. `Subsystem.status` per-variant:
    - `Partial::limitations` non-empty, each non-empty trimmed string.
    - `Unsupported::reason` matches the SemanticCode or DeferredTo shape.
    - `Research::evidence_refs` non-empty, each with non-empty `caption` and a
      `locator` matching its `kind`'s shape (RoadmapNode regex, file path for
      Fixture/Doc, URL or URI for ReferenceImplAnchor).
12. `Subsystem.capabilities` non-empty.
13. Every `ValidationCommand.command` is shell-safe (regex: only
    `[A-Za-z0-9._/=:@+\- ]` plus a deliberately-narrow flag-passing set; no
    `|`, `>`, `<`, `;`, `&`, `$`, `` ` ``, `(`, `)`, `\`). Reserved
    prefixes: `cargo `, `just `, `node ` (for `scripts/spec-dag.mjs validate`),
    `pnpm `. Any prefix outside the reserved set fails.
14. `ValidationCommand.expected_outcome` per-variant:
    - `Skip::reason` matches `<project>.<category>.<detail>` semantic shape.
    - `Fail::semantic_code` matches the same shape.
15. `ReferenceBehavior.engine_runtime` and `.observable_signal` non-empty.
16. `Status::Validated` only assigned by the validator itself (typestate-ish
    rule — the deserializer accepts `Validated` on read so a freshly-loaded,
    previously-validated map keeps its status, but the validator re-runs all
    invariants regardless of the input status; `Status::Outdated` is preserved
    as-is and not re-validated).
17. `generated_at` parses as RFC 3339.
18. Cross-validation against a supplied `PortManifest` (when provided — see
    §4.6) does NOT happen as part of `validate(&map)`; it lives in a separate
    `validate_against_manifest(&map, &manifest)` function so the map remains
    standalone-validatable.

### 4.3 What the validator does NOT check (deliberate)

- Whether the validation command actually passes — the validator never runs
  shell commands (§"No shell-outs" rule). Command _execution_ is UTSUSHI-027–
  030's responsibility.
- Whether the fixture hash matches the current on-disk file. The validator is
  string-shape only. A separate `verify_fixture_hashes(&map, &dyn FixtureStore)`
  helper is offered in §4.5 but is not part of `validate()`.
- Whether the port's `PortManifest::capabilities` align with the map's
  subsystem coverage. That's `validate_against_manifest` (§4.6).
- Whether `Status::Outdated` should be re-promoted. Out of scope for this node.

### 4.4 Status disclaimer (audit-load-bearing)

`ValidationReport::status_disclaimer` is a fixed `&'static str`:

```text
"impl_map.status=Validated proves the coverage scaffolding is structurally
valid. It is NOT alpha-readiness evidence, NOT a port readiness signal, and
NOT a substitute for the engine-port slice. Acceptance of the engine port
requires a separately-landed slice (UTSUSHI-031..039, UTSUSHI-146) whose
verification commands produce the evidence this map points to."
```

The disclaimer string is a compile-time constant. Any caller that serializes
or surfaces the map MUST surface the disclaimer when surfacing `Status`. The
JSON wire form (§6) carries the disclaimer in a `statusDisclaimer` field so
downstream consumers (Itotori dashboards, audit ingestion) can render it
without re-querying the validator.

### 4.5 Helpers (out of `validate()` but in this node)

```rust
/// Optional pre-flight that re-hashes referenced public fixtures against
/// on-disk bytes. Engine ports run this from their integration tests.
/// Not part of `validate(&map)` because the validator is pure-data.
pub fn verify_fixture_hashes<F: FixtureStore>(
    map: &ImplementationMap,
    store: &F,
) -> Result<(), Vec<FixtureHashMismatch>>;
```

`FixtureStore` is a small trait — `fn read(&self, id: &str) -> Result<Vec<u8>>`
— that engine port crates can implement against `fixtures/public/`.
`FixtureHashMismatch` carries the fixture id, expected hash, observed hash;
its rendered form passes `looks_like_local_path` redaction.

### 4.6 Cross-validation against `PortManifest`

```rust
pub fn validate_against_manifest(
    map: &ImplementationMap,
    manifest: &crate::port::PortManifest,
) -> Result<(), Vec<ImplMapManifestMismatch>>;
```

Checks:

1. `map.port_id` equals `manifest.id`.
2. Every capability the map's subsystems claim through `capabilities` strings
   that match a known `PortCapability::as_str()` is also declared in
   `manifest.capabilities`. (Free-form capability tags that don't match a
   PortCapability are accepted as engine-specific labels.)
3. `map.engine_family` is consistent with `manifest.id` prefix when the
   prefix is informative (e.g. `utsushi-reallive` → `EngineFamily::RealLive`).
   Inconsistent pairing fails.

This is OFFERED but NOT REQUIRED — keeping the map standalone-validatable is
the chosen architecture (see §10 risks).

## 5. Diagnostics

```rust
#[derive(Debug)]
pub enum ImplMapError {
    UnsupportedSchemaVersion { declared: String, supported: &'static str },
    PortIdMalformed { id: String },
    EngineFamilyOtherWithoutNotes,
    NoSubsystemsDeclared,
    NoValidationCommandsDeclared,
    DuplicateSubsystemId { id: SubsystemId },
    DuplicateValidationCommandId { id: ValidationCommandId },
    OrphanValidationCommandRef {
        subsystem_id: SubsystemId,
        validation_command_id: ValidationCommandId,
    },
    OrphanValidationCommand { id: ValidationCommandId },
    MissingFixtureProvenance { subsystem_id: SubsystemId, field: ProvenanceField },
    FixtureHashMalformed { subsystem_id: SubsystemId, raw: String },
    FixtureByteCountZero { subsystem_id: SubsystemId },
    FixtureClassificationMissing { subsystem_id: SubsystemId },
    FixtureKindOtherWithoutNotes { subsystem_id: SubsystemId },
    SyntheticInlineMismatch { subsystem_id: SubsystemId },
    EmptyCapabilityList { subsystem_id: SubsystemId },
    PartialWithoutLimitations { subsystem_id: SubsystemId },
    UnsupportedReasonNotSemantic { subsystem_id: SubsystemId, raw: String },
    ResearchEvidenceMissing { subsystem_id: SubsystemId },
    ResearchEvidenceCaptionEmpty { subsystem_id: SubsystemId, index: usize },
    ResearchEvidenceLocatorMalformed { subsystem_id: SubsystemId, index: usize, kind: EvidenceKind },
    ValidationCommandEmpty { id: ValidationCommandId },
    ValidationCommandUnsafeShape { id: ValidationCommandId, offending_token: String },
    ValidationCommandPrefixUnknown { id: ValidationCommandId, prefix: String },
    ValidationCommandCaptionEmpty { id: ValidationCommandId },
    SkipReasonNotSemantic { id: ValidationCommandId, raw: String },
    FailSemanticCodeMalformed { id: ValidationCommandId, raw: String },
    ReferenceBehaviorMissing { field: ReferenceField },
    GeneratedAtNotRfc3339 { raw: String },
}

#[derive(Debug, Clone, Copy)]
pub enum ProvenanceField { Id, Hash, ByteCount, Classification }

#[derive(Debug, Clone, Copy)]
pub enum ReferenceField { EngineRuntime, ObservableSignal }
```

`Display` impls are explicit and MUST pass `looks_like_local_path` on their
rendered form (lift the convention from `port::diagnostics`). The `raw:`
fields that echo back user input MUST NOT include host paths — the validator
upstream-redacts before constructing the error (any input that
`looks_like_local_path` is replaced with a fixed placeholder token before
embedding in the diagnostic, matching the redaction pattern in
`EnvFieldSchema::validate_value`).

`std::error::Error` implemented for `ImplMapError`. A separate
`ImplMapManifestMismatch` enum covers §4.6's cross-validation diagnostics so
the two surfaces stay distinct.

## 6. Serialization (JSON wire form)

- **Format**: JSON.
- **Field naming**: camelCase (project convention; see existing
  `RuntimeAdapterDescriptor` JSON in `crates/utsushi-core/src/port/mod.rs::258`).
- **Schema-version field**: `schemaVersion` ALWAYS first key when serialized
  through serde (achieved by `#[serde(rename = "schemaVersion")]` and stable
  struct-field order); deserializer rejects payloads missing the field with
  a typed error before downstream validation.
- **Enum tagging**: `#[serde(tag = "kind", content = "data")]` on enums with
  payload (`SubsystemStatus`, `UnsupportedReason`, `ExpectedOutcome`); plain
  string serialization for unit enums (`Status`, `EngineFamily`,
  `FixtureKind`, `FixtureClassification`, `CaptureMethod`, `EvidenceKind`).
- **Newtypes**: `PortId`, `SubsystemId`, `ValidationCommandId` use
  `#[serde(transparent)]` — they appear as plain strings in JSON.
- **Schema document**: a JSON Schema (Draft 2020-12) is generated under
  `roadmap/impl-map.schema.json` from the Rust types. The schema is validated
  by `just schema` (see §8). Source of truth for the wire form is the Rust
  types — the JSON Schema is a downstream artifact validated by the test
  suite to stay in sync.
- **Disclaimer surfacing**: `statusDisclaimer` field is serialized on the
  top-level object whenever `status == Validated`. The deserializer is
  tolerant (ignores it on input); the serializer always emits it when status
  is Validated. This is the audit "always-on" signal that
  Validated ≠ alpha-ready.

Example minimal valid JSON:

```json
{
  "schemaVersion": "0.1.0",
  "portId": "utsushi-reallive",
  "engineFamily": "reallive",
  "subsystems": [
    {
      "id": "scene-seen-replay",
      "name": "Scene/SEEN deterministic replay",
      "status": { "kind": "Supported" },
      "fixtureRef": {
        "id": "reallive-detector/positive-synthetic-triple",
        "classification": "Public",
        "kind": "Directory",
        "hash": "f0e1d2c3...64hex",
        "byteCount": 4096
      },
      "validationCommandId": "cargo-test-utsushi-reallive",
      "capabilities": ["deterministic-text-trace", "scene-seen-bytecode"],
      "notes": ""
    }
  ],
  "validationCommands": [
    {
      "id": "cargo-test-utsushi-reallive",
      "command": "cargo test -p utsushi-reallive scene_seen_replay",
      "expectedOutcome": { "kind": "Pass" },
      "caption": "Deterministic Scene/SEEN replay smoke."
    }
  ],
  "referenceBehavior": {
    "engineRuntime": "rlvm (research anchor; clean-room; behavior-only)",
    "observableSignal": "deterministic text trace per scene id",
    "captureMethod": "TraceLog"
  },
  "status": "Validated",
  "statusDisclaimer": "impl_map.status=Validated proves the coverage scaffolding is structurally valid. ...",
  "generatedAt": "2026-06-23T17:00:00Z"
}
```

## 7. Test plan

Test names follow the testing-standard.md grammar — observable claims, no
`works_correctly`-style names.

### 7.1 Positive shape

- `validates_well_formed_engine_neutral_impl_map`
- `roundtrips_json_for_well_formed_map_preserving_field_order`
- `accepts_supported_partial_unsupported_and_research_subsystem_variants_in_one_map`
- `promotes_status_to_validated_when_all_invariants_hold`
- `surfaces_status_disclaimer_string_when_status_is_validated`
- `accepts_synthetic_inline_classification_when_kind_is_synthetic_inline`
- `accepts_research_subsystem_with_roadmap_node_evidence_ref`
- `accepts_reference_behavior_no_reference_comparison_as_warning_not_error`

### 7.2 Negative shape (one fixture per error variant)

- `rejects_map_with_empty_subsystems_list_with_no_subsystems_declared`
- `rejects_map_with_empty_validation_commands_list`
- `rejects_subsystem_missing_fixture_hash_as_missing_fixture_provenance`
- `rejects_subsystem_with_placeholder_hash_token_as_missing_fixture_provenance`
- `rejects_subsystem_with_all_zero_hash_as_missing_fixture_provenance`
- `rejects_subsystem_with_zero_byte_count_unless_synthetic_inline`
- `rejects_subsystem_with_malformed_hex_hash_as_fixture_hash_malformed`
- `rejects_subsystem_referring_to_unknown_validation_command_id_as_orphan_ref`
- `rejects_validation_command_unreferenced_by_any_subsystem_as_orphan_command`
- `rejects_duplicate_subsystem_ids`
- `rejects_duplicate_validation_command_ids`
- `rejects_partial_subsystem_with_empty_limitations`
- `rejects_unsupported_subsystem_with_free_text_reason`
- `rejects_research_subsystem_with_empty_evidence_refs`
- `rejects_research_evidence_ref_with_empty_caption`
- `rejects_research_evidence_locator_not_matching_kind_shape`
- `rejects_empty_capability_list_on_subsystem`
- `rejects_engine_family_other_without_engine_family_notes`
- `rejects_fixture_kind_other_without_kind_notes`
- `rejects_reference_behavior_with_empty_engine_runtime`
- `rejects_reference_behavior_with_empty_observable_signal`
- `rejects_validation_command_empty_string`
- `rejects_validation_command_with_shell_pipe`
- `rejects_validation_command_with_subshell_dollar_paren`
- `rejects_validation_command_with_backtick`
- `rejects_validation_command_with_redirection`
- `rejects_validation_command_with_unknown_prefix`
- `rejects_validation_command_with_empty_caption`
- `rejects_skip_outcome_with_non_semantic_reason`
- `rejects_fail_outcome_with_non_semantic_code`
- `rejects_generated_at_not_rfc3339`
- `rejects_unsupported_schema_version_major_bump`
- `rejects_port_id_with_uppercase`

### 7.3 Multi-error aggregation

- `returns_all_validation_errors_in_one_pass_for_a_map_with_three_distinct_violations`
  — confirms the API returns `Vec<ImplMapError>` and the auditor sees
  fixture-provenance + orphan-ref + duplicate-id errors in a single call.

### 7.4 Diagnostic redaction

- `error_display_strings_pass_looks_like_local_path_filter`
  — feeds inputs that would normally embed `/home/...` and confirms the
  rendered error doesn't leak the local path token (mirrors the existing
  `engine_port_error_display_passes_local_path_filter` test).

### 7.5 JSON schema parity

- `json_schema_under_roadmap_validates_the_example_fixture`
- `json_schema_rejects_an_otherwise_well_formed_map_missing_fixture_hash`

### 7.6 Cross-validation (helper surface)

- `validate_against_manifest_rejects_port_id_mismatch`
- `validate_against_manifest_accepts_engine_neutral_capability_tags_not_in_manifest`
- `validate_against_manifest_flags_capability_in_map_absent_from_manifest`

### 7.7 Verify-fixture-hashes helper

- `verify_fixture_hashes_returns_mismatch_when_store_bytes_diverge_from_declared_hash`
- `verify_fixture_hashes_returns_ok_for_byte_for_byte_match`

### 7.8 Engine-neutrality discipline test

- `schema_serialization_contains_no_engine_specific_field_names`
  — serializes a representative map for each `EngineFamily` variant and
  asserts the JSON contains no `xp3`, `kag`, `rgss3`, `tjs`, `seen`,
  `gameexe`, `scene_pck`, `pixi`, `nwjs`, `unity` substrings outside
  string-valued `notes`/`name`/`caption`/`capabilities` payloads.
  (Implemented as field-name extraction, not raw substring on the full
  document.)

### 7.9 Fixture corpus

Negative-fixture JSON documents live under
`crates/utsushi-core/src/port/impl_map/fixtures/negative/`:

- `empty-subsystems.json`
- `missing-fixture-hash.json`
- `orphan-command.json`
- `partial-without-limitations.json`
- `validation-command-pipe.json`
- `engine-family-other-no-notes.json`

Positive fixtures under `.../fixtures/positive/`:

- `minimal-supported.json`
- `mixed-status.json` (supported + partial + unsupported + research)
- `engine-family-other-with-notes.json`
- `synthetic-inline.json`

These fixtures double as the JSON Schema validation corpus (§8).

## 8. Verification commands

```text
cargo test -p utsushi-core port::impl_map
cargo test -p utsushi-core port    # full port surface incl. UTSUSHI-103 manifest tests
cargo fmt --check
cargo clippy -p utsushi-core --all-targets -- -D warnings
just schema       # validates roadmap/impl-map.schema.json against positive + negative fixtures
just check        # full local gate: schema, fixtures, typecheck, fmt, Cargo check
```

`just schema` is extended (in this node) to also validate the new
`roadmap/impl-map.schema.json` against the positive fixture corpus and to
confirm each negative fixture is rejected. If `just schema` does not yet
exist as a separate recipe — confirm in implementation — wire it into the
existing `just check` schema validation step instead.

## 9. Risks and unknowns

1. **How tightly the map couples to `PortManifest`.** The chosen design is
   **standalone but cross-validatable**: the map serializes/validates with no
   reference to a manifest, but `validate_against_manifest(&map, &manifest)`
   is offered as a separate helper. This avoids forcing engine port crates to
   own both artifacts in lock-step while still making it possible for the
   conformance harness to enforce coverage. The risk is that downstream
   nodes (UTSUSHI-031+) may end up requiring cross-validation _de facto_ —
   if so, the manifest cross-check becomes a hard requirement in a future
   node, not in this one.

2. **Engine subsystem taxonomy varies wildly per engine.** Solved by
   `EngineFamily` discriminant + free-form `capabilities: Vec<String>`
   per subsystem. The risk is that without a controlled vocabulary, two
   engine ports may use different capability tags for the same idea
   (`"frame-capture-e2"` vs `"capture-headless-screenshot"`). UTSUSHI-025
   intentionally accepts this — a controlled-vocabulary effort would be a
   separate node and would over-constrain early engine research.

3. **Schema-version evolution.** Strategy: semver-shaped
   `schemaVersion` field; major bumps rejected by the validator (typed
   `UnsupportedSchemaVersion`). Minor bumps within `0.1.x` are additive only.
   First breaking change targets `0.2.0` and is owned by a future node; until
   then the version pin is `"0.1.0"`.

4. **Drift between `roadmap/impl-map.schema.json` and the Rust types.**
   Mitigation: schema is generated FROM the Rust types (e.g. via `schemars`
   or a hand-rolled emit) at test time, and `just schema` validates both
   the positive corpus passes and the schema document matches a checked-in
   snapshot. Choosing the generation strategy (schemars vs hand-rolled) is
   an implementation decision; the plan commits to schema-from-types as the
   direction. If `schemars` is already a workspace dep, prefer it; otherwise
   the hand-rolled emit is acceptable and is unit-tested for parity.

5. **What "fixture hash" means for a directory fixture.** The plan commits
   to: directory fixtures use the SHA-256 of a canonicalized manifest of
   `(relative-path, file-hash, byte-count)` tuples sorted by path. This is
   the same shape `fixtures/public/manifest.schema.json` already uses; if
   that shape diverges, the implementation worker must reconcile and the
   plan notes the choice in the implementation PR description.

6. **`looks_like_local_path` echoing back user input in diagnostics.** A
   malformed `command` field that contains `/home/...` could leak through
   `ImplMapError::ValidationCommandUnsafeShape::offending_token`. The
   validator MUST upstream-redact any echoed-back string segment that would
   trip `looks_like_local_path` before embedding it in the diagnostic.
   Test 7.4 covers this.

## 10. Out of scope

- Implementation of any engine port itself (`utsushi-reallive`,
  `utsushi-rpgmaker-mv`, `utsushi-kirikiri-kag`, `utsushi-siglus`,
  etc.). UTSUSHI-025 ships only the engine-neutral substrate.
- The conformance manifest and result schema. That is UTSUSHI-026 (parallel
  planning; see §11 for the distinction).
- Trace-event check, branch check, snapshot check, capture/recording check
  implementations. Those are UTSUSHI-027/028/029.
- Itotori ingestion of the impl map. That is UTSUSHI-030's territory.
- Executing the validation commands. The map declares them; UTSUSHI-027–030
  schedule and consume them. This node does not shell out.
- Outdated-detection algorithm (`Status::Outdated` promotion logic). The
  variant exists; the _detection_ is an open downstream concern (engine port
  nodes own it).
- Controlled-vocabulary for `capabilities: Vec<String>` (see risk #2).
- A CLI surface (e.g. `utsushi impl-map validate <file>`). The Rust library
  surface is enough for this node; a CLI is a possible follow-up if
  UTSUSHI-027–030 want one.

## 11. Distinction from UTSUSHI-026 (coordination)

UTSUSHI-025 and UTSUSHI-026 are being planned in parallel. They are two
distinct artifacts and MUST NOT overlap:

| Artifact                         | UTSUSHI-025 (this node)                                                                    | UTSUSHI-026 (parallel)                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| What it declares                 | "Here's what subsystems we cover, with which fixtures, and how the coverage is exercised." | "Here are the conformance checks the port MUST satisfy, and the result schema for those checks."  |
| Type                             | `ImplementationMap` (coverage plan + fixture provenance + validation commands).            | Conformance profile manifest + result schema (pass/fail/skipped/unsupported semantics).           |
| Module                           | `utsushi_core::port::impl_map`                                                             | `utsushi_core::port::conformance` (already partially exists for UTSUSHI-103's harness; extended). |
| Validator surface                | `validate(&ImplementationMap) -> Result<ValidationReport, Vec<ImplMapError>>`              | Conformance-profile validator + result-schema validator.                                          |
| Owns "what we plan to cover"     | YES                                                                                        | NO                                                                                                |
| Owns "what we actually checked"  | NO                                                                                         | YES                                                                                               |
| Owns fixture provenance          | YES                                                                                        | References fixtures but does not define provenance shape.                                         |
| Owns pass/fail/skipped semantics | Defines `ExpectedOutcome` for the _declared_ command only (Pass/Skip/Fail-semantic-code).  | Defines the _runtime_ result enum (Pass/Fail/Skipped/Unsupported with semantic reason codes).     |
| Consumed by engine ports         | YES (every port ships an `ImplementationMap` artifact alongside their slice).              | YES (every port emits conformance results into the result schema).                                |
| Standalone-readable              | YES                                                                                        | YES                                                                                               |

The two artifacts cross-reference at the _port_ level (both cite
`PortManifest::id`) but their Rust types are disjoint — no shared enum, no
shared struct. The implementation worker for UTSUSHI-025 MUST NOT add
`ConformanceResult`-shaped fields; the worker for UTSUSHI-026 MUST NOT
re-introduce a fixture-provenance field. If a future node wants to fuse
them (e.g. an audit ingestion layer), it does so as a separate consumer of
both, not by merging the schemas.

Concretely, if planning for UTSUSHI-026 lands a `ConformanceCheck` type, this
plan reserves no namespace for it; if UTSUSHI-026 lands first and adds
`port::conformance::ResultSchema`, this node imports nothing from it. Both
plans must be reviewable independently.

## 12. Worker scoping

**One worker, internally cohesive.** The deliverable is one engine-neutral
module (`utsushi_core::port::impl_map`) with the schema, validator,
diagnostics, serde, and the helper surfaces (`verify_fixture_hashes`,
`validate_against_manifest`). The test corpus + JSON Schema artifact are
part of the same slice. No engine port code is touched.

Estimated touch points:

- `crates/utsushi-core/src/port/mod.rs` — `pub mod impl_map;` and re-exports.
- `crates/utsushi-core/src/port/impl_map/{mod,schema,diagnostics,validator,serde,status}.rs` — new.
- `crates/utsushi-core/src/port/impl_map/fixtures/{positive,negative}/*.json` — new fixture corpus.
- `roadmap/impl-map.schema.json` — new JSON Schema artifact.
- `justfile` — possibly extend `just schema` to cover the new artifact;
  alternatively wire into existing schema validation step.
- `crates/utsushi-core/Cargo.toml` — possibly add `schemars` if chosen for
  schema generation (alternative: hand-rolled).

No changes to engine port crates, no changes to the runner, no changes to
the VFS. A reviewer can read the diff start-to-finish without context-
switching between engine boundaries.
