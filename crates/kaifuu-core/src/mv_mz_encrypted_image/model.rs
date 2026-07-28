//! RPG Maker MV/MZ encrypted-image fixture and evidence model.

use serde::{Deserialize, Serialize};

use crate::mv_mz_asset_xor::{MvMzAssetKey, encrypt_rpgmaker_asset};
use crate::{
    CodecTransform, KaifuuResult, KeyValidationProof, OperationStatus, PartialDiagnosticSeverity,
    ProofHash, SecretRef, redact_for_log_or_report, stable_json,
};

use super::{MvMzEncryptedImagePath, MvMzImageSurface, PNG_SIGNATURE, SYNTHETIC_PNG};

// The XOR primitive, key type, decrypt, and re-encrypt all live in the single
// canonical `crate::mv_mz_asset_xor` module (imported above); this path never
// re-implements them. `ImageAssetKey` is the historical local name for the
// shared key type.

pub(super) type ImageAssetKey = MvMzAssetKey;

/// True iff `bytes` begins with the PNG 8-byte signature — the wrong-key
/// discriminator for a decrypted RPG Maker image.
pub(super) fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= PNG_SIGNATURE.len() && &bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE
}

/// Build a clearly-synthetic RPGMV-header encrypted image from [`SYNTHETIC_PNG`]
/// masked with the given key. Public helper so callers can exercise the native
/// decrypt path on synthetic bytes without any retail asset.
pub fn encrypt_synthetic_image(key_bytes: &[u8]) -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_PNG, &MvMzAssetKey::from_bytes(key_bytes))
}

/// The synthetic scenario a fixture entry materialises in-process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzEncryptedImageScenario {
    /// Encrypted with the correct key; the correct key is offered — round-trips.
    Valid,
    /// Encrypted with the correct key; a wrong key is offered — decrypt yields
    /// non-PNG bytes.
    WrongKey,
    /// Encrypted asset present, but no key is resolvable for the requirement.
    MissingKey,
    /// The entry declares a non-image (audio) surface codec — outside this path.
    UnsupportedSurface,
    /// Asset bytes lack the RPGMV header magic (not a valid encrypted image).
    UnsupportedVariant,
}

impl MvMzEncryptedImageScenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::WrongKey => "wrong_key",
            Self::MissingKey => "missing_key",
            Self::UnsupportedSurface => "unsupported_surface",
            Self::UnsupportedVariant => "unsupported_variant",
        }
    }
}

/// The mechanical outcome of processing one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzEncryptedImageOutcome {
    /// Decrypted to a valid PNG and re-encrypted byte-correctly.
    RoundTripped,
    /// Candidate key did not decrypt to a valid PNG; no re-encryption.
    WrongKey,
    /// No key was resolvable; no decryption attempted.
    MissingKey,
    /// Surface codec is not image; outside this path.
    UnsupportedSurface,
    /// Asset bytes are not a well-formed RPGMV-header image.
    UnsupportedVariant,
}

impl MvMzEncryptedImageOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RoundTripped => "round_tripped",
            Self::WrongKey => "wrong_key",
            Self::MissingKey => "missing_key",
            Self::UnsupportedSurface => "unsupported_surface",
            Self::UnsupportedVariant => "unsupported_variant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzEncryptedImageFixture {
    pub schema_version: String,
    pub path_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<MvMzEncryptedImageFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzEncryptedImageFixtureEntry {
    pub entry_id: String,
    pub requirement_id: String,
    /// Structured secret-ref for the asset key. Never raw key material.
    pub secret_ref: SecretRef,
    /// The named image surface this entry targets (surface provenance).
    pub surface: MvMzImageSurface,
    /// The declared surface codec. The path accepts `png_image` only; an audio
    /// or JSON codec is an `unsupported_surface`.
    pub surface_codec: CodecTransform,
    pub scenario: MvMzEncryptedImageScenario,
    pub expected: MvMzEncryptedImageOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub path: MvMzEncryptedImagePath,
    pub status: OperationStatus,
    pub entries: Vec<MvMzEncryptedImageEntryReport>,
}

impl MvMzEncryptedImageReport {
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzEncryptedImageEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            path_id: redact_for_log_or_report(&self.path_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            path: self.path.clone(),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(MvMzEncryptedImageEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub path_id: String,
    pub surface_id: String,
    pub scenario: MvMzEncryptedImageScenario,
    pub outcome: MvMzEncryptedImageOutcome,
    /// `true` only when the asset decrypted to a valid PNG AND re-encrypted
    /// byte-correctly.
    pub round_tripped: bool,
    /// The round-trip proof, present **only** when `round_tripped`. `None` means
    /// no re-encrypted patch artifact was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<MvMzImageRoundTripProof>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<MvMzEncryptedImageFinding>,
}

impl MvMzEncryptedImageEntryReport {
    /// The byte-correct round-trip proof an adapter may consume **iff** the
    /// entry passed and round-tripped. Anything else returns `None`, so a
    /// caller physically cannot consume a patch artifact for a failed entry.
    pub fn consumable_proof(&self) -> Option<&MvMzImageRoundTripProof> {
        if self.round_tripped && self.status == OperationStatus::Passed {
            self.proof.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            path_id: redact_for_log_or_report(&self.path_id),
            surface_id: redact_for_log_or_report(&self.surface_id),
            scenario: self.scenario,
            outcome: self.outcome,
            round_tripped: self.round_tripped,
            proof: self
                .proof
                .as_ref()
                .map(MvMzImageRoundTripProof::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(MvMzEncryptedImageFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The byte-correct round-trip proof. Carries hashes / counts / a secret-ref
/// only — never the key bytes, never the decrypted image bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzImageRoundTripProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub surface_id: String,
    /// sha256 of the original encrypted asset bytes.
    pub encrypted_source_hash: ProofHash,
    /// sha256 of the decrypted plaintext PNG bytes.
    pub decrypted_plaintext_hash: ProofHash,
    /// sha256 of the re-encrypted asset bytes.
    pub reencrypted_hash: ProofHash,
    /// `true` iff `reencrypted_hash == encrypted_source_hash` (byte-correct).
    pub byte_correct_round_trip: bool,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    /// Proof method + hash. `proof_hash` is the byte-correct re-encrypted hash.
    pub validation: KeyValidationProof,
    pub redaction_status: crate::HelperRedactionStatus,
}

impl MvMzImageRoundTripProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            surface_id: redact_for_log_or_report(&self.surface_id),
            encrypted_source_hash: self.encrypted_source_hash.clone(),
            decrypted_plaintext_hash: self.decrypted_plaintext_hash.clone(),
            reencrypted_hash: self.reencrypted_hash.clone(),
            byte_correct_round_trip: self.byte_correct_round_trip,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl MvMzEncryptedImageFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
        }
    }
}
