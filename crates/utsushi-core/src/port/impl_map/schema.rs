//! Typed schema for the engine-port implementation map ().
//!
//! The implementation map is a coverage scaffolding artifact every engine
//! port slice produces. The schema is **engine-neutral**: no XP3, KAG
//! RGSS3, `.koe`, or similar engine-specific field names appear here.
//! Engine-specific shape lives entirely in (a) the
//! [`EngineFamily`] discriminant, (b) free-form
//! [`Subsystem::capabilities`] tags, and (c) audit-visible `notes`
//! `caption` strings.
//!
//! See `.plan/.md` for the design rationale.

use serde::{Deserialize, Serialize};

/// Pinned wire-format schema version. Bumped on any breaking JSON change.
/// The validator rejects major-version mismatches with
/// [`ImplMapError::UnsupportedSchemaVersion`](super::ImplMapError::UnsupportedSchemaVersion).
pub const IMPL_MAP_SCHEMA_VERSION: &str = "0.1.0";

/// Top-level artifact. One per engine-port slice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImplementationMap {
    /// Pinned schema version (matches [`IMPL_MAP_SCHEMA_VERSION`] at write time).
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,

    /// Stable port id matching the engine port's `PortManifest::id`.
    #[serde(rename = "portId")]
    pub port_id: PortId,

    /// Free-form engine family discriminant. The schema is engine-neutral;
    /// engine-specific shape lives in this discriminant + per-subsystem
    /// capability lists.
    #[serde(rename = "engineFamily")]
    pub engine_family: EngineFamily,

    /// Required when `engine_family == Other` — disambiguates what
    /// "other" means for auditors.
    #[serde(
        rename = "engineFamilyNotes",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub engine_family_notes: Option<String>,

    /// Coverage scope. Validator rejects empty lists.
    pub subsystems: Vec<Subsystem>,

    /// Validation commands. Their `id`s are referenced by subsystems.
    #[serde(rename = "validationCommands")]
    pub validation_commands: Vec<ValidationCommand>,

    /// Reference-behavior commitments. The map cannot be a disembodied list
    /// of subsystems; an auditor must be able to ask "compared against what?".
    #[serde(rename = "referenceBehavior")]
    pub reference_behavior: ReferenceBehavior,

    /// Lifecycle status. `Validated` is promoted only by the validator;
    /// callers may persist a previously-validated map and reload it.
    pub status: Status,

    /// Audit-visible disclaimer string. Always emitted by the validator on
    /// promotion to [`Status::Validated`]; deserializer tolerates its
    /// presence on input.
    #[serde(
        rename = "statusDisclaimer",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub status_disclaimer: Option<String>,

    /// RFC 3339 timestamp at generation. Validator does not interpret
    /// freshness; downstream consumers (+) compare against
    /// manifest and dep-graph timestamps.
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

/// One engine subsystem the slice covers. EVERY subsystem MUST link to a
/// [`FixtureRef`] AND a [`ValidationCommand`]; there is no free-text-only
/// shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subsystem {
    /// Schema-local id (kebab-case, port-unique). Used by
    /// [`Subsystem::validation_command_id`] cross-refs.
    pub id: SubsystemId,

    /// Human-readable subsystem name.
    pub name: String,

    /// Coverage status of this subsystem.
    pub status: SubsystemStatus,

    /// Fixture provenance. REQUIRED — no Option, no default.
    #[serde(rename = "fixtureRef")]
    pub fixture_ref: FixtureRef,

    /// Validation command id. Must match a [`ValidationCommand::id`] in the
    /// same map.
    #[serde(rename = "validationCommandId")]
    pub validation_command_id: ValidationCommandId,

    /// Free-form capability tags. Engine-neutral discipline: these are
    /// capability labels, not engine-specific field shapes. Empty list is
    /// rejected.
    pub capabilities: Vec<String>,

    /// Audit-visible notes. Free text. May be empty.
    #[serde(default)]
    pub notes: String,
}

/// Status of a single subsystem's coverage. There is intentionally no
/// `Unknown` / `TBD` / free-text-only shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SubsystemStatus {
    /// Covered by an executable fixture + validation command, expected to
    /// pass.
    Supported,
    /// Covered partially. Each limitation must be non-empty.
    Partial { limitations: Vec<String> },
    /// Explicitly out of scope. The reason MUST cite a semantic error code
    /// or a `deferred-to-<NODE-ID>` sentinel.
    Unsupported { reason: UnsupportedReason },
    /// Research subsystem: not yet covered by a fixture-driven validation
    /// but documented with cited evidence references.
    Research {
        #[serde(rename = "evidenceRefs")]
        evidence_refs: Vec<EvidenceRef>,
    },
}

/// Reason for [`SubsystemStatus::Unsupported`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum UnsupportedReason {
    /// `<project>.<category>.<detail>` semantic error code.
    SemanticCode(String),
    /// `deferred-to-<NODE-ID>` sentinel.
    DeferredTo(String),
}

/// An evidence reference for [`SubsystemStatus::Research`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub kind: EvidenceKind,
    /// Path, id, or URL depending on `kind`. See [`EvidenceKind`] for the
    /// per-variant shape rules enforced by the validator.
    pub locator: String,
    /// Short audit caption explaining what this evidence proves.
    pub caption: String,
}

/// Kind discriminant for [`EvidenceRef`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EvidenceKind {
    Fixture,
    Doc,
    RoadmapNode,
    ReferenceImplAnchor,
}

/// Fixture provenance. EVERY field is required, validated, and non-sentinel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureRef {
    /// Stable fixture id.
    pub id: String,

    /// Public-or-private classification.
    pub classification: FixtureClassification,

    /// Coarse fixture kind.
    pub kind: FixtureKind,

    /// Required when `kind == Other`.
    #[serde(rename = "kindNotes", default, skip_serializing_if = "Option::is_none")]
    pub kind_notes: Option<String>,

    /// Content hash (SHA-256, hex-lowercase, 64 chars). For directory
    /// fixtures: SHA-256 of a canonicalized manifest of
    /// `(relative-path, file-hash, byte-count)` tuples sorted by path.
    pub hash: String,

    /// Total byte count of the fixture root (sum of file bytes for directory
    /// fixtures, file size for file fixtures). Must be > 0 unless
    /// `kind == SyntheticInline` AND `classification == SyntheticInline`.
    #[serde(rename = "byteCount")]
    pub byte_count: u64,
}

/// Public-vs-private classification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FixtureClassification {
    Public,
    PrivateLocal,
    SyntheticInline,
}

/// Coarse fixture kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FixtureKind {
    File,
    Directory,
    Archive,
    SyntheticInline,
    Other,
}

/// A validation command the engine port runs to exercise a subsystem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationCommand {
    /// Schema-local id; referenced by [`Subsystem::validation_command_id`].
    pub id: ValidationCommandId,

    /// The command line. Engine-neutral discipline: must use one of the
    /// reserved shell-safe prefixes (`cargo `, `just `, `node `, `pnpm `).
    /// No pipes, redirections, subshells, backticks, or env-var expansion.
    pub command: String,

    /// What the command is expected to produce.
    #[serde(rename = "expectedOutcome")]
    pub expected_outcome: ExpectedOutcome,

    /// Audit caption: what does this command prove?
    pub caption: String,
}

/// Expected outcome of a [`ValidationCommand`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ExpectedOutcome {
    Pass,
    Skip {
        /// MUST cite a `<project>.<category>.<detail>` semantic skip code.
        reason: String,
    },
    Fail {
        /// MUST cite a `<project>.<category>.<detail>` semantic code.
        #[serde(rename = "semanticCode")]
        semantic_code: String,
    },
}

/// What the engine port is being validated against.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceBehavior {
    /// What the port is being validated against. Example:
    /// `"rlvm (reference)"`.
    #[serde(rename = "engineRuntime")]
    pub engine_runtime: String,

    /// What an auditor can observe to falsify the port's claim.
    #[serde(rename = "observableSignal")]
    pub observable_signal: String,

    /// How the comparable evidence was/will be captured.
    #[serde(rename = "captureMethod")]
    pub capture_method: CaptureMethod,
}

/// How reference-behavior evidence was captured. Engine-neutral label set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaptureMethod {
    TraceLog,
    ScreenshotArtifact,
    AudioEvent,
    SnapshotState,
    SyntheticSelfCheck,
    NoReferenceComparison,
}

/// Lifecycle status of the [`ImplementationMap`] itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Status {
    /// Author has written the map; it has not yet been validated, or
    /// validation produced errors.
    Draft,
    /// All schema invariants hold. Carries an audit-visible disclaimer
    /// (see [`crate::port::impl_map::STATUS_VALIDATED_DISCLAIMER`]).
    Validated,
    /// A previously-validated map whose dependencies have shifted.
    /// ships only the variant; downstream consumers own
    /// detection.
    Outdated,
}

/// Free-form engine family discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EngineFamily {
    #[serde(rename = "reallive")]
    RealLive,
    #[serde(rename = "rpgmaker-mv")]
    RpgmakerMv,
    #[serde(rename = "rpgmaker-mz")]
    RpgmakerMz,
    #[serde(rename = "rpgmaker-vx-ace")]
    RpgmakerVxAce,
    #[serde(rename = "kirikiri-kag")]
    KirikiriKag,
    #[serde(rename = "xp3")]
    Xp3,
    #[serde(rename = "siglus")]
    Siglus,
    #[serde(rename = "renpy")]
    RenPy,
    #[serde(rename = "wolf-rpg-editor")]
    WolfRpgEditor,
    #[serde(rename = "bgi-ethornell")]
    BgiEthornell,
    #[serde(rename = "tyranoscript")]
    TyranoScript,
    #[serde(rename = "rgss3")]
    Rgss3,
    #[serde(rename = "unity")]
    Unity,
    #[serde(rename = "other")]
    Other,
}

impl EngineFamily {
    /// Wire name (matches the serde rename).
    pub fn as_wire_name(self) -> &'static str {
        match self {
            Self::RealLive => "reallive",
            Self::RpgmakerMv => "rpgmaker-mv",
            Self::RpgmakerMz => "rpgmaker-mz",
            Self::RpgmakerVxAce => "rpgmaker-vx-ace",
            Self::KirikiriKag => "kirikiri-kag",
            Self::Xp3 => "xp3",
            Self::Siglus => "siglus",
            Self::RenPy => "renpy",
            Self::WolfRpgEditor => "wolf-rpg-editor",
            Self::BgiEthornell => "bgi-ethornell",
            Self::TyranoScript => "tyranoscript",
            Self::Rgss3 => "rgss3",
            Self::Unity => "unity",
            Self::Other => "other",
        }
    }

    /// Single source of truth for the manifest-id prefix each engine family's
    /// substrate manifest must carry (`None` for `Other`, which has no
    /// dedicated substrate). The `match self` below is intentionally
    /// EXHAUSTIVE with NO `_ =>` wildcard arm: adding a new `EngineFamily`
    /// variant is a compile error here until its manifest prefix is declared
    /// keeping the prefix surface in lockstep with the variant set.
    pub fn manifest_prefix(self) -> Option<&'static str> {
        match self {
            Self::RealLive => Some("utsushi-reallive"),
            Self::RpgmakerMv => Some("utsushi-rpgmaker-mv"),
            Self::RpgmakerMz => Some("utsushi-rpgmaker-mz"),
            Self::RpgmakerVxAce => Some("utsushi-rpgmaker-vx-ace"),
            Self::KirikiriKag => Some("utsushi-kirikiri"),
            Self::Xp3 => Some("utsushi-xp3"),
            Self::Siglus => Some("utsushi-siglus"),
            Self::RenPy => Some("utsushi-renpy"),
            Self::WolfRpgEditor => Some("utsushi-wolf"),
            Self::BgiEthornell => Some("utsushi-bgi"),
            Self::TyranoScript => Some("utsushi-tyrano"),
            Self::Rgss3 => Some("utsushi-rgss3"),
            Self::Unity => Some("utsushi-unity"),
            Self::Other => None,
        }
    }
}

// Newtype id wrappers. Transparent serde so they appear as plain strings in
// JSON; typed in Rust so they cannot cross-contaminate at validator time.

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PortId(pub String);

impl PortId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SubsystemId(pub String);

impl SubsystemId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ValidationCommandId(pub String);

impl ValidationCommandId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}
