use super::*;

pub const XP3_PROFILE_PROOF_SCHEMA_VERSION: &str = "0.1.0";
pub const XP3_PROFILE_PROOF_SUPPORT_BOUNDARY: &str = "KiriKiri XP3 profile proof scoped to plain XP3 as the claimed-support concern (detect, extract, patch_back); encrypted, compressed, helper-required, and unsupported-protected-executable cases are routing diagnostics only and never claim extract or patch_back.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3ProfileClassification {
    Plain,
    Encrypted,
    Compressed,
    HelperRequired,
    UnsupportedProtectedExecutable,
}

impl Xp3ProfileClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Encrypted => "encrypted",
            Self::Compressed => "compressed",
            Self::HelperRequired => "helper_required",
            Self::UnsupportedProtectedExecutable => "unsupported_protected_executable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3PatchCapabilityLevel {
    /// Classification only; no extract / patch capability claimed.
    Detect,
    /// Inventory is exposable; payloads are not modified.
    Extract,
    /// Plain XP3 patch-back is claimed (only valid for the `plain` variant).
    PatchBack,
    /// Variant is routed for diagnostics only; no extract or patch-back claim.
    Unsupported,
}

impl Xp3PatchCapabilityLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::Extract => "extract",
            Self::PatchBack => "patch_back",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3CryptProfileStatus {
    /// No crypt profile is required (plain archives, unsupported protected
    /// executables that have no decryption claim at all).
    NotRequired,
    /// The fixture declares a crypt profile id and key-ref requirement
    /// that satisfy the encrypted-or-helper-required routing diagnostics.
    /// This status does not imply decryption capability; it only confirms
    /// the routing surface is wired.
    Satisfied,
    /// The fixture declares an encrypted or helper-required classification
    /// but supplies no crypt profile id at all.
    Missing,
    /// The fixture declares a crypt profile id that is not present in the
    /// recognized encryption-plugin set (e.g. an unknown KiriKiri plugin).
    UnknownPlugin,
}

impl Xp3CryptProfileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Satisfied => "satisfied",
            Self::Missing => "missing",
            Self::UnknownPlugin => "unknown_plugin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3HelperRequirement {
    NotRequired,
    Required,
}

impl Xp3HelperRequirement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Required => "required",
        }
    }
}

/// Set of crypt profile ids the routing diagnostics recognize. This is
/// **not** a decryption-capability claim — recognition here only means the
/// fixture's declared encryption plugin id matches a known KiriKiri
/// crypt-profile vocabulary entry, so the proof can route the case to
/// `Encrypted` / `HelperRequired` without claiming `UnknownPlugin`. Adding
/// an entry to this set adds zero decryption capability; it only widens
/// the routing taxonomy.
pub const XP3_RECOGNIZED_CRYPT_PROFILE_IDS: &[&str] = &[
    "kirikiri-xp3-null-key",
    "kirikiri-xp3-fixture-key-profile",
    "kirikiri-xp3-helper-required-key-profile",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub archive: Xp3ProfileProofFixtureArchive,
    pub expected_classification: Xp3ProfileClassification,
    pub patch_capability_level: Xp3PatchCapabilityLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypt_profile: Option<Xp3ProfileProofFixtureCryptProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixtureArchive {
    pub archive_id: String,
    /// Archive path **relative to the fixture file's directory**. Absolute
    /// paths, drive-letter paths, parent traversal (`..`), and home
    /// prefixes are rejected by `xp3_profile_proof` — they cannot appear
    /// in the report (acceptance criterion: "Private archive paths, raw
    /// keys, and decrypted text cannot appear in the report.").
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixtureCryptProfile {
    pub crypt_profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref_requirement: Option<Xp3ProfileProofFixtureKeyRefRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixtureKeyRefRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub classification: Xp3ProfileClassification,
    pub support_boundary: String,
    pub patch_capability_level: Xp3PatchCapabilityLevel,
    pub helper_requirement: Xp3HelperRequirement,
    pub patch_write_attempted: bool,
    pub archive: Xp3ProfileProofArchive,
    pub crypt_profile: Xp3ProfileProofCryptProfile,
    pub diagnostics: Vec<Xp3ProfileProofDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_remediation: Option<String>,
}

impl Xp3ProfileProofReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            classification: self.classification,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            patch_capability_level: self.patch_capability_level,
            helper_requirement: self.helper_requirement,
            patch_write_attempted: self.patch_write_attempted,
            archive: self.archive.redacted_for_report(),
            crypt_profile: self.crypt_profile.redacted_for_report(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(Xp3ProfileProofDiagnostic::redacted_for_report)
                .collect(),
            semantic_remediation: self
                .semantic_remediation
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofArchive {
    pub archive_id: String,
    pub archive_hash: ProofHash,
    pub declared_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<u64>,
}

impl Xp3ProfileProofArchive {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            archive_id: redact_for_log_or_report(&self.archive_id),
            archive_hash: self.archive_hash.clone(),
            // declared_path is the fixture-relative path (already
            // guard-railed away from absolute / traversal / home prefixes)
            // — but we still funnel it through redact_for_log_or_report
            // so any redaction-bearing substring is scrubbed.
            declared_path: redact_for_log_or_report(&self.declared_path),
            entry_count: self.entry_count,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofCryptProfile {
    pub status: Xp3CryptProfileStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypt_profile_id: Option<String>,
    pub key_ref_requirement_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<SecretRef>,
}

impl Xp3ProfileProofCryptProfile {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status,
            crypt_profile_id: self
                .crypt_profile_id
                .as_deref()
                .map(redact_for_log_or_report),
            key_ref_requirement_present: self.key_ref_requirement_present,
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref: self.secret_ref.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl Xp3ProfileProofDiagnostic {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Xp3ProfileProofRequest<'a> {
    pub fixture: &'a Xp3ProfileProofFixture,
    /// Directory the fixture file lives in. Archive paths declared in the
    /// fixture are resolved relative to this directory.
    pub fixture_dir: &'a Path,
}

/// XP3 magic the encrypted-or-compressed routing path keys off. Plain
/// XP3 archives match the full [`XP3_PLAIN_MAGIC`] prefix; encrypted
/// archives carry the leading `XP3\r\n` magic followed by a non-plain
/// header signature that `read_plain_xp3_inventory` rejects with
/// `UnsupportedEncrypted`.
pub(crate) const XP3_HEADER_MAGIC: &[u8] = b"XP3\r\n";
