use super::*;

/// A structured smoke finding — typed, never a bare string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3SmokeFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub semantic_code: String,
    pub message: String,
}

impl Rgss3SmokeFinding {
    fn redacted(&self) -> Self {
        Self {
            code: self.code.clone(),
            severity: self.severity,
            field: self.field.clone(),
            semantic_code: self.semantic_code.clone(),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// One extracted text unit surfaced in the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3TextUnitReport {
    /// The in-archive entry id the string was extracted from.
    pub entry_id: String,
    /// The Marshal object-graph locator of the string.
    pub locator: String,
    /// A lossy UTF-8 view of the extracted string (synthetic, public).
    pub text: String,
}

/// The identity round-trip proof: rebuild(extract(x)) with no change == x.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3IdentityReport {
    pub byte_identical: bool,
    pub source_hash: ProofHash,
    pub rebuilt_hash: ProofHash,
    pub source_bytes: u64,
    pub rebuilt_bytes: u64,
}

/// The trivial-change proof: the localized string is present, the patched entry
/// diverges at exactly one Marshal path, and every other entry stays
/// byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3PatchReport {
    pub entry_id: String,
    pub locator: String,
    pub old_text: String,
    pub new_text: String,
    /// The rebuilt archive carries the new text and not the old text.
    pub change_applied: bool,
    /// Length delta of the localized string (proves the bounds/offsets were
    /// recomputed, not a same-length in-place poke).
    pub length_delta: i64,
    /// Marshal object-graph paths at which the patched entry diverges from the
    /// source (exactly one for the trivial change).
    pub diverging_paths: Vec<String>,
    /// Every archive entry other than the patched one is byte-identical to the
    /// source (decrypted-payload comparison).
    pub other_entries_byte_identical: bool,
}

/// Per-layer verification outcome — the layered transform metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3LayerVerification {
    /// container=rgssad
    pub container_transform: String,
    pub entry_names_preserved: bool,
    pub entry_count: u64,
    /// crypto=xor
    pub crypto_transform: String,
    /// The rebuilt archive re-applies the XOR keystream (ciphertext!= plaintext)
    /// yet decrypts back to the intended payloads.
    pub keystream_reproduced: bool,
    /// codec=ruby_marshal
    pub codec_transform: String,
    /// patch-back=repack_archive
    pub patch_back_transform: String,
    /// The patch-back dependency tokens this round-trip exercised.
    pub dependencies_exercised: Vec<String>,
}

/// The full RGSS3 smoke report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3SmokeReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    /// The archive entry ids, in archive order.
    pub entry_ids: Vec<String>,
    pub text_units: Vec<Rgss3TextUnitReport>,
    pub identity: Rgss3IdentityReport,
    pub patch: Rgss3PatchReport,
    pub layers: Rgss3LayerVerification,
    /// Typed unsupported diagnostics (negative cases) — explicit, never dropped.
    pub unsupported: Vec<Rgss3UnsupportedReport>,
    pub findings: Vec<Rgss3SmokeFinding>,
}

impl Rgss3SmokeReport {
    fn redacted(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: self.source_node_id.clone(),
            engine_family: self.engine_family.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entry_ids: self.entry_ids.clone(),
            text_units: self.text_units.clone(),
            identity: self.identity.clone(),
            patch: self.patch.clone(),
            layers: self.layers.clone(),
            unsupported: self
                .unsupported
                .iter()
                .map(Rgss3UnsupportedReport::redacted)
                .collect(),
            findings: self
                .findings
                .iter()
                .map(Rgss3SmokeFinding::redacted)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted())
    }

    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}

// Unsupported (negative) cases — explicit typed diagnostics

/// The unsupported class a negative case exercises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rgss3UnsupportedKind {
    /// The container bytes are not a valid RGSSAD v3 archive.
    BadContainer,
    /// A `.rvdata2` payload uses a Marshal type outside the bounded subset.
    UnsupportedMarshalType,
    /// A `Scripts.rvdata2` (zlib-deflated Ruby code) entry is out of scope.
    ScriptsOutOfScope,
    /// A patch targeted a non-text (non-`String`) Marshal node.
    PatchTargetNotText,
}

impl Rgss3UnsupportedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadContainer => "bad_container",
            Self::UnsupportedMarshalType => "unsupported_marshal_type",
            Self::ScriptsOutOfScope => "scripts_out_of_scope",
            Self::PatchTargetNotText => "patch_target_not_text",
        }
    }
}

/// A typed unsupported diagnostic surfaced by a negative case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rgss3UnsupportedReport {
    pub case_id: String,
    pub kind: Rgss3UnsupportedKind,
    /// True when the case was rejected with a typed diagnostic before any rebuild
    /// byte was produced for the offending entry.
    pub rejected_before_rebuild: bool,
    pub semantic_code: String,
    pub message: String,
}

impl Rgss3UnsupportedReport {
    fn redacted(&self) -> Self {
        Self {
            case_id: self.case_id.clone(),
            kind: self.kind,
            rejected_before_rebuild: self.rejected_before_rebuild,
            semantic_code: self.semantic_code.clone(),
            message: redact_for_log_or_report(&self.message),
        }
    }
}
