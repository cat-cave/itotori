use super::*;

// RPG Maker MV/MZ encrypted-media-proof
// `encrypted_media_proof` runs a fixture matrix of RPG Maker MV/MZ media
// assets (encrypted images / audio / movies, plus plaintext), validates the
// asset-key profile against `data/System.json`, and emits a readiness report.
// Posture (load-bearing): RPG Maker MV/MZ is a commercial product.
// is a **research-only** profile — the proof never decrypts an
// encrypted asset, never persists decrypted bytes, never extracts plaintext
// from an encrypted asset, and never claims a "media-key detection implies
// dialogue extraction or script patch support" capability. The proof
// classifies the leading 16-byte RPGMV signature, validates the
// `data/System.json.encryptionKey` shape, and routes per-asset readiness
// diagnostics. Key bytes never appear in the report — only the
// `data/System.json` proof hash and a routing diagnostic.

pub const ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION: &str = "0.1.0";
pub const ENCRYPTED_MEDIA_PROOF_SUPPORT_BOUNDARY: &str = "RPG Maker MV/MZ encrypted-media proof; research-only profile scope: detect encrypted asset suffix + signature; validate System.json key profile; readiness only. No decryption capability is claimed; no media bytes are persisted decrypted; dialogue extraction and script patch support are explicitly out of scope.";

/// 16-byte RPGMV header magic that fronts every encrypted.rpgmvp /
/// .rpgmvo /.rpgmvm /.rpgmvu /.png_ /.ogg_ /.m4a_ asset. Bytes 0..5 are
/// `RPGMV`, bytes 5..8 are zero, byte 8 is the header version (0x00),
/// bytes 9..10 carry the format version (0x03 0x01), bytes 10..16 are
/// reserved. We treat the full 16 bytes as the routing signature so a
/// fixture cannot pass the proof with a malformed or partially-zeroed
/// header.
pub const RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER: &[u8; 16] = &[
    b'R', b'P', b'G', b'M', b'V', 0, 0, 0, 0, 0x03, 0x01, 0, 0, 0, 0, 0,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaAssetKind {
    Image,
    Audio,
    Video,
}

impl EncryptedMediaAssetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaClassification {
    /// Bytes carry the RPGMV header magic and the fixture declared an
    /// encrypted asset suffix (.rpgmvp /.rpgmvo /.rpgmvm /.rpgmvu /
    /// .png_ /.ogg_ /.m4a_).
    Encrypted,
    /// Asset is declared and present plaintext (e.g..png,.ogg,.webm) —
    /// no encryption signature, no key requirement.
    Plaintext,
    /// Asset is declared encrypted but the header magic is missing, the
    /// file is shorter than 16 bytes, or the bytes carry an unknown
    /// header. Routed to readiness=`unsupported`; no decryption attempt.
    MalformedHeader,
    /// Asset is declared encrypted but cannot be read off disk.
    MissingAsset,
    /// Asset suffix is recognised as an RPG Maker-family extension but the
    /// suffix has no profiled crypto / codec mapping (e.g. `.rpgmvu`,
    /// `.webp_`). Routed to `unsupported`; no key requirement.
    UnknownSuffix,
}

impl EncryptedMediaClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Encrypted => "encrypted",
            Self::Plaintext => "plaintext",
            Self::MalformedHeader => "malformed_header",
            Self::MissingAsset => "missing_asset",
            Self::UnknownSuffix => "unknown_suffix",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaDecryptability {
    /// Asset is plaintext; nothing to decrypt.
    NotApplicable,
    /// Encrypted asset has a present, key-shape-valid `System.json`
    /// encryption key. The proof still does **not** decrypt — this status
    /// only indicates the key profile is wired.
    KeyProfileSatisfied,
    /// Encrypted asset is missing a `data/System.json` encryption key.
    KeyMissing,
    /// `data/System.json` encryption key value is malformed (wrong length,
    /// not lowercase hex). The proof does not attempt to decrypt with the
    /// candidate key.
    KeyMalformed,
    /// `data/System.json` carries a well-formed 32-hex key, but its hash
    /// does not match the fixture's expected public proof hash.
    KeyMismatch,
    /// Asset declares a media kind whose key profile recognition is out of
    /// scope for the research-only readiness command.
    OutOfScope,
}

impl EncryptedMediaDecryptability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::KeyProfileSatisfied => "key_profile_satisfied",
            Self::KeyMissing => "key_missing",
            Self::KeyMalformed => "key_malformed",
            Self::KeyMismatch => "key_mismatch",
            Self::OutOfScope => "out_of_scope",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaPatchCapability {
    /// Plaintext asset; no patch capability is claimed in this proof. This
    /// command is research-only — even plaintext media is not surfaced as
    /// a patchable artifact here.
    NotClaimed,
    /// Asset is routed for diagnostics only; no patch capability is or
    /// will be claimed by for any encrypted media asset.
    Unsupported,
}

impl EncryptedMediaPatchCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotClaimed => "not_claimed",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaKeyRefStatus {
    /// Fixture is plaintext or out-of-scope; no keyRef is required.
    NotRequired,
    /// Fixture declared an encrypted asset and supplied a key-profile id +
    /// secret ref; recognition is routing-only (does **not** imply a
    /// decryption capability claim).
    Present,
    /// Fixture declared an encrypted asset but supplied no keyRef.
    Missing,
}

impl EncryptedMediaKeyRefStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Present => "present",
            Self::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaReadiness {
    /// Encrypted asset is detected, key profile is wired, no script
    /// capability is claimed — research-ready.
    Ready,
    /// Plaintext asset is plumbed as evidence; readiness is informational
    /// only (no patch claim, no script capability).
    PlaintextEvidence,
    /// Asset is routed for diagnostics only (malformed, missing, unknown
    /// suffix, missing key, malformed key, key/asset mismatch); the proof
    /// claims **no** decryption or patch capability.
    Unsupported,
}

impl EncryptedMediaReadiness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::PlaintextEvidence => "plaintext_evidence",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Set of asset-key profile ids the routing diagnostics recognize. This
/// is **not** a decryption-capability claim — recognition here only means
/// the fixture's declared profile id matches a known KAIFUU MV/MZ
/// asset-key vocabulary entry, so the proof can route the case without
/// emitting an `unknown_plugin`-shaped diagnostic. Adding an entry adds
/// zero decryption capability; it only widens the routing taxonomy.
pub const RPG_MAKER_MV_MZ_RECOGNIZED_KEY_PROFILE_IDS: &[&str] = &[
    "rpg-maker-mv-mz-asset-key",
    "rpg-maker-mv-mz-fixture-asset-key",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub game_dir: String,
    pub assets: Vec<EncryptedMediaProofFixtureAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_profile: Option<EncryptedMediaProofFixtureKeyProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixtureAsset {
    pub asset_id: String,
    /// Path **relative to `game_dir`**. Absolute / drive-letter / parent
    /// traversal / home-prefixed paths are rejected up front and never
    /// echoed into the report.
    pub path: String,
    pub expected_kind: EncryptedMediaAssetKind,
    pub expected_classification: EncryptedMediaClassification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixtureKeyProfile {
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_system_json_key_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref_requirement: Option<EncryptedMediaProofFixtureKeyRefRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixtureKeyRefRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub support_boundary: String,
    pub readiness: EncryptedMediaReadiness,
    pub patch_capability_level: EncryptedMediaPatchCapability,
    pub script_capability_claimed: bool,
    pub decrypted_bytes_persisted: bool,
    pub assets: Vec<EncryptedMediaProofAsset>,
    pub key_profile: EncryptedMediaProofKeyProfile,
    pub diagnostics: Vec<EncryptedMediaProofDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_remediation: Option<String>,
}

impl EncryptedMediaProofReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            readiness: self.readiness,
            patch_capability_level: self.patch_capability_level,
            script_capability_claimed: self.script_capability_claimed,
            decrypted_bytes_persisted: self.decrypted_bytes_persisted,
            assets: self
                .assets
                .iter()
                .map(EncryptedMediaProofAsset::redacted_for_report)
                .collect(),
            key_profile: self.key_profile.redacted_for_report(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(EncryptedMediaProofDiagnostic::redacted_for_report)
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
pub struct EncryptedMediaProofAsset {
    pub asset_id: String,
    pub declared_path: String,
    pub kind: EncryptedMediaAssetKind,
    pub classification: EncryptedMediaClassification,
    pub readiness: EncryptedMediaReadiness,
    pub patch_capability_level: EncryptedMediaPatchCapability,
    pub key_ref_status: EncryptedMediaKeyRefStatus,
    pub decryptability: EncryptedMediaDecryptability,
    pub asset_evidence_hash: ProofHash,
    pub suffix: String,
}

impl EncryptedMediaProofAsset {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            asset_id: redact_for_log_or_report(&self.asset_id),
            declared_path: redact_for_log_or_report(&self.declared_path),
            kind: self.kind,
            classification: self.classification,
            readiness: self.readiness,
            patch_capability_level: self.patch_capability_level,
            key_ref_status: self.key_ref_status,
            decryptability: self.decryptability,
            asset_evidence_hash: self.asset_evidence_hash.clone(),
            suffix: self.suffix.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofKeyProfile {
    pub status: EncryptedMediaKeyRefStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<SecretRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_json_proof_hash: Option<ProofHash>,
    pub system_json_present: bool,
    pub system_json_key_present: bool,
    pub system_json_key_well_formed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_system_json_key_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_json_key_hash: Option<ProofHash>,
    pub has_encrypted_images_flag: Option<bool>,
    pub has_encrypted_audio_flag: Option<bool>,
}

impl EncryptedMediaProofKeyProfile {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status,
            key_profile_id: self.key_profile_id.as_deref().map(redact_for_log_or_report),
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref: self.secret_ref.clone(),
            system_json_proof_hash: self.system_json_proof_hash.clone(),
            system_json_present: self.system_json_present,
            system_json_key_present: self.system_json_key_present,
            system_json_key_well_formed: self.system_json_key_well_formed,
            expected_system_json_key_hash: self.expected_system_json_key_hash.clone(),
            system_json_key_hash: self.system_json_key_hash.clone(),
            has_encrypted_images_flag: self.has_encrypted_images_flag,
            has_encrypted_audio_flag: self.has_encrypted_audio_flag,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl EncryptedMediaProofDiagnostic {
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
