//! RPG Maker MV/MZ encrypted-AUDIO decrypt + re-encrypt path.
//! This is the **encrypted-media** path for RPG Maker MV/MZ named audio
//! surfaces. It mirrors the just-merged encrypted-image path
//! ([`crate::mv_mz_encrypted_image`]) leg-for-leg for the audio codec, and is
//! mechanically separate from three neighbouring nodes:
//! - ([`crate::mv_mz_encrypted_image`]) owns the encrypted **image**
//!   surfaces. THIS node never touches an image surface; an image-codec entry is
//!   rejected as an `unsupported_surface` before any byte is decrypted.
//! - ([`crate::mv_mz_readiness`]) is JSON-text inventory only and
//!   hard-pins encrypted media `extractable = false` / `patchable = false`.
//!   THIS node never touches a JSON-text surface and never widens that node's
//!   claims.
//! - ([`crate::encrypted_media_proof`]) is a research-only
//!   *readiness* proof that NEVER decrypts. THIS node is the distinct path
//!   that genuinely decrypts AND re-encrypts an audio asset, with a
//!   byte-correct round-trip proof.
//! # The scheme (native Rust, NO shell-out)
//! RPG Maker MV/MZ encrypted audio is the **same** `RPGMV`-header scheme as the
//! images: a 16-byte [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] signature is
//! prepended to the asset, and the first 16 bytes of the original OGG are
//! XOR-masked with a 16-byte key derived from `System.json`'s `encryptionKey`.
//! Decryption strips the header and XORs the first 16 body bytes back;
//! re-encryption prepends the header and XORs the first 16 plaintext bytes. XOR
//! is involutive, so a correct key yields a **byte-correct** round-trip
//! (`re_encrypt(decrypt(enc)) == enc`). MV ships `.rpgmvo`; MZ ships `.ogg_` —
//! both route through this path. The implementation is in-process Rust: no
//! `Command::new`, no helper process, no network.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live **only** inside the module-private [`AudioAssetKey`]
//!   (redacting `Debug`, zeroizing `Drop`). They are never serialized, logged,
//!   or returned across the module boundary. Reports carry structured
//!   **secret-refs + proof hashes / counts** only.
//! - A re-encrypted patch artifact is produced **only** after a candidate key
//!   decrypts the asset to a valid OGG. Wrong-key, missing-key,
//!   unsupported-surface (image / JSON), and unsupported-variant
//!   (malformed-header) entries fail **before** any re-encryption — every one
//!   is a structured [`MvMzEncryptedAudioFinding`], never a silent skip or a
//!   panic.
//! - Image and JSON surfaces are explicitly out of scope: an entry whose
//!   `surface_codec` is not [`CodecTransform::OggAudio`] is rejected with a
//!   structured `unsupported_surface` finding before any byte is decrypted.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module: a tiny synthetic OGG-ish page
//! ([`SYNTHETIC_OGG`]) and a clearly-fake 16-byte key. No retail audio bytes and
//! no real keys are ever vendored; the report carries only hashes / counts /
//! secret-refs.

use serde::{Deserialize, Serialize};

use super::{MvMzAudioSurface, MvMzEncryptedAudioPath};
use crate::mv_mz_asset_xor::{MvMzAssetKey, RPGMAKER_ASSET_XOR_PREFIX_LEN, encrypt_rpgmaker_asset};
use crate::{
    CodecTransform, KaifuuResult, KeyValidationProof, OperationStatus, PartialDiagnosticSeverity,
    ProofHash, SecretRef, redact_for_log_or_report, stable_json,
};

/// The canonical RPGMV-header variant error. Re-exported under the historical
/// audio-path name; the single implementation lives in [`crate::mv_mz_asset_xor`].
pub use crate::mv_mz_asset_xor::MvMzAssetVariantError as MvMzAudioVariantError;

pub const MV_MZ_ENCRYPTED_AUDIO_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical `engine_family` wire value for this path. MUST match 's
/// [`crate::MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY`] so the two media paths stay
/// consistent (the repo-wide canonical MV/MZ token).
pub const MV_MZ_ENCRYPTED_AUDIO_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
/// Canonical `variant` wire value (MV and MZ share the asset-XOR scheme).
pub const MV_MZ_ENCRYPTED_AUDIO_VARIANT: &str = "mv_or_mz";
/// Stable id of this path / its public fixture.
pub const MV_MZ_ENCRYPTED_AUDIO_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-encrypted-audio";
/// Stable crypto-profile id for the MV/MZ asset-XOR scheme. Audio and image
/// share the identical scheme, so they share the profile id.
pub const MV_MZ_ENCRYPTED_AUDIO_CRYPTO_PROFILE_ID: &str = "rpgmaker/mv_mz/asset_xor_v1";
/// The single secret requirement: the `System.json` asset key (the same key
/// requirement as the image path — one project key masks both media kinds).
pub const MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID: &str = "rpgmaker-mv-mz-asset-key";

/// The support boundary surfaced in every report.
pub const MV_MZ_ENCRYPTED_AUDIO_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-audio decrypt + re-encrypt is in-process Rust (the standard RPGMV-header XOR-with-System.json-key scheme, the same scheme as the image path); it never shells out. A re-encrypted patch artifact is produced only after a candidate key decrypts the asset to a valid OGG and a byte-correct round-trip is proven; wrong-key, missing-key, unsupported-surface (image/JSON), and unsupported-variant (malformed header) entries fail before any re-encryption. Raw key bytes are never logged, serialized, or returned — reports carry secret-refs + proof hashes only. Image and JSON surfaces are out of scope for this path.";

/// The OGG 4-byte capture-pattern signature (`OggS`). Used as the wrong-key
/// discriminator: a correctly decrypted RPG Maker audio asset begins with it.
pub const OGG_SIGNATURE: &[u8; 4] = b"OggS";

/// The number of leading bytes the RPGMV scheme XOR-masks (the key length).
/// Aliases the shared [`RPGMAKER_ASSET_XOR_PREFIX_LEN`].
pub const RPGMAKER_AUDIO_XOR_PREFIX_LEN: usize = RPGMAKER_ASSET_XOR_PREFIX_LEN;

pub const SEMANTIC_MV_MZ_AUDIO_WRONG_KEY: &str = "kaifuu.rpgmaker.encrypted_audio.wrong_key";
pub const SEMANTIC_MV_MZ_AUDIO_MISSING_KEY: &str = "kaifuu.rpgmaker.encrypted_audio.missing_key";
pub const SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_SURFACE: &str =
    "kaifuu.rpgmaker.encrypted_audio.unsupported_surface";
pub const SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT: &str =
    "kaifuu.rpgmaker.encrypted_audio.unsupported_variant";

pub(super) const FINDING_WRONG_KEY: &str = "rpgmaker.encrypted_audio.wrong_key";
pub(super) const FINDING_MISSING_KEY: &str = "rpgmaker.encrypted_audio.missing_key";
pub(super) const FINDING_UNSUPPORTED_SURFACE: &str = "rpgmaker.encrypted_audio.unsupported_surface";
pub(super) const FINDING_UNSUPPORTED_VARIANT: &str = "rpgmaker.encrypted_audio.unsupported_variant";
pub(super) const FINDING_OUTCOME_MISMATCH: &str = "rpgmaker.encrypted_audio.outcome_mismatch";
pub(super) const FINDING_INTERNAL: &str = "rpgmaker.encrypted_audio.internal";

/// A tiny, synthetic OGG-ish page (44 bytes). Public + synthetic — it is the
/// plaintext every fixture entry round-trips. It begins with the real `OggS`
/// capture pattern (so the wrong-key discriminator is exercised) followed by a
/// minimal, clearly-fake page header + payload; it is NOT a playable stream and
/// carries no retail audio.
pub const SYNTHETIC_OGG: &[u8] = &[
    // "OggS" capture pattern + stream structure version 0 + header type 0x02.
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, //
    // granule position (8 bytes).
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, //
    // bitstream serial number (4 bytes, synthetic).
    0x49, 0x54, 0x4f, 0x54, //
    // page sequence number (4 bytes).
    0x00, 0x00, 0x00, 0x00, //
    // CRC checksum (4 bytes, synthetic — not recomputed).
    0xde, 0xad, 0xbe, 0xef, //
    // page segments (1) + segment table [0x10 = 16].
    0x01, 0x10, //
    // 16-byte synthetic payload.
    0x69, 0x74, 0x6f, 0x74, 0x6f, 0x72, 0x69, 0x2d, 0x6f, 0x67, 0x67, 0x2d, 0x66, 0x69, 0x78, 0x21,
];

/// The synthetic "correct" 16-byte asset key. Clearly fake fixture material.
pub(super) const SYNTHETIC_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A synthetic key that differs from the correct one within the first 4 bytes,
/// so a wrong-key decrypt corrupts the OGG capture pattern and is detected.
pub(super) const SYNTHETIC_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

// The XOR primitive, key type, decrypt, and re-encrypt all live in the single
// canonical `crate::mv_mz_asset_xor` module (imported above); this path never
// re-implements them. `AudioAssetKey` is the historical local name for the
// shared key type.

pub(super) type AudioAssetKey = MvMzAssetKey;

/// True iff `bytes` begins with the OGG `OggS` capture pattern — the wrong-key
/// discriminator for a decrypted RPG Maker audio asset.
pub(super) fn is_ogg(bytes: &[u8]) -> bool {
    bytes.len() >= OGG_SIGNATURE.len() && &bytes[..OGG_SIGNATURE.len()] == OGG_SIGNATURE
}

/// Build a clearly-synthetic RPGMV-header encrypted audio asset from
/// [`SYNTHETIC_OGG`] masked with the given key. Public helper so callers can
/// exercise the native decrypt path on synthetic bytes without any retail asset.
pub fn encrypt_synthetic_audio(key_bytes: &[u8]) -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_OGG, &MvMzAssetKey::from_bytes(key_bytes))
}

/// The synthetic scenario a fixture entry materialises in-process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzEncryptedAudioScenario {
    /// Encrypted with the correct key; the correct key is offered — round-trips.
    Valid,
    /// Encrypted with the correct key; a wrong key is offered — decrypt yields
    /// non-OGG bytes.
    WrongKey,
    /// Encrypted asset present, but no key is resolvable for the requirement.
    MissingKey,
    /// The entry declares a non-audio (image) surface codec — outside this path.
    UnsupportedSurface,
    /// Asset bytes lack the RPGMV header magic (not a valid encrypted asset).
    UnsupportedVariant,
}

impl MvMzEncryptedAudioScenario {
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
pub enum MvMzEncryptedAudioOutcome {
    /// Decrypted to a valid OGG and re-encrypted byte-correctly.
    RoundTripped,
    /// Candidate key did not decrypt to a valid OGG; no re-encryption.
    WrongKey,
    /// No key was resolvable; no decryption attempted.
    MissingKey,
    /// Surface codec is not OGG audio; outside this path.
    UnsupportedSurface,
    /// Asset bytes are not a well-formed RPGMV-header audio asset.
    UnsupportedVariant,
}

impl MvMzEncryptedAudioOutcome {
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
pub struct MvMzEncryptedAudioFixture {
    pub schema_version: String,
    pub path_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<MvMzEncryptedAudioFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzEncryptedAudioFixtureEntry {
    pub entry_id: String,
    pub requirement_id: String,
    /// Structured secret-ref for the asset key. Never raw key material.
    pub secret_ref: SecretRef,
    /// The named audio surface this entry targets (surface provenance).
    pub surface: MvMzAudioSurface,
    /// The declared surface codec. The path accepts `ogg_audio` only; an image
    /// or JSON codec is an `unsupported_surface`.
    pub surface_codec: CodecTransform,
    pub scenario: MvMzEncryptedAudioScenario,
    pub expected: MvMzEncryptedAudioOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedAudioReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub path: MvMzEncryptedAudioPath,
    pub status: OperationStatus,
    pub entries: Vec<MvMzEncryptedAudioEntryReport>,
}

impl MvMzEncryptedAudioReport {
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzEncryptedAudioEntryReport> {
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
                .map(MvMzEncryptedAudioEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedAudioEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub path_id: String,
    pub surface_id: String,
    pub scenario: MvMzEncryptedAudioScenario,
    pub outcome: MvMzEncryptedAudioOutcome,
    /// `true` only when the asset decrypted to a valid OGG AND re-encrypted
    /// byte-correctly.
    pub round_tripped: bool,
    /// The round-trip proof, present **only** when `round_tripped`. `None` means
    /// no re-encrypted patch artifact was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<MvMzAudioRoundTripProof>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<MvMzEncryptedAudioFinding>,
}

impl MvMzEncryptedAudioEntryReport {
    /// The byte-correct round-trip proof an adapter may consume **iff** the
    /// entry passed and round-tripped. Anything else returns `None`, so a
    /// caller physically cannot consume a patch artifact for a failed entry.
    pub fn consumable_proof(&self) -> Option<&MvMzAudioRoundTripProof> {
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
                .map(MvMzAudioRoundTripProof::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(MvMzEncryptedAudioFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The byte-correct round-trip proof. Carries hashes / counts / a secret-ref
/// only — never the key bytes, never the decrypted audio bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAudioRoundTripProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub surface_id: String,
    /// sha256 of the original encrypted asset bytes.
    pub encrypted_source_hash: ProofHash,
    /// sha256 of the decrypted plaintext OGG bytes.
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

impl MvMzAudioRoundTripProof {
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
pub struct MvMzEncryptedAudioFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl MvMzEncryptedAudioFinding {
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
