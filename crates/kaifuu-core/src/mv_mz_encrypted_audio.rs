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

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::mv_mz_asset_xor::{
    MvMzAssetKey, RPGMAKER_ASSET_XOR_PREFIX_LEN, decrypt_rpgmaker_asset, encrypt_rpgmaker_asset,
};
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, KeyMaterialKind,
    KeyValidationMethod, KeyValidationProof, OperationStatus, PartialDiagnosticSeverity,
    PatchBackTransform, ProofHash, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, SecretRef, SurfaceTransform,
    redact_for_log_or_report, sha256_hash_bytes, stable_json,
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

const FINDING_WRONG_KEY: &str = "rpgmaker.encrypted_audio.wrong_key";
const FINDING_MISSING_KEY: &str = "rpgmaker.encrypted_audio.missing_key";
const FINDING_UNSUPPORTED_SURFACE: &str = "rpgmaker.encrypted_audio.unsupported_surface";
const FINDING_UNSUPPORTED_VARIANT: &str = "rpgmaker.encrypted_audio.unsupported_variant";
const FINDING_OUTCOME_MISMATCH: &str = "rpgmaker.encrypted_audio.outcome_mismatch";
const FINDING_INTERNAL: &str = "rpgmaker.encrypted_audio.internal";

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
const SYNTHETIC_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A synthetic key that differs from the correct one within the first 4 bytes,
/// so a wrong-key decrypt corrupts the OGG capture pattern and is detected.
const SYNTHETIC_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

mod path_contract;

pub use path_contract::{
    MvMzAudioSurface, MvMzAudioSurfaceDeclaration, MvMzEncryptedAudioDiagnosticDeclaration,
    MvMzEncryptedAudioPath, MvMzEncryptedAudioPathViolation, RpgMakerAudioCryptoProfile,
};

// The XOR primitive, key type, decrypt, and re-encrypt all live in the single
// canonical `crate::mv_mz_asset_xor` module (imported above); this path never
// re-implements them. `AudioAssetKey` is the historical local name for the
// shared key type.

type AudioAssetKey = MvMzAssetKey;

/// True iff `bytes` begins with the OGG `OggS` capture pattern — the wrong-key
/// discriminator for a decrypted RPG Maker audio asset.
fn is_ogg(bytes: &[u8]) -> bool {
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
    /// The spec-DAG node id this fixture is authored for (e.g. ``).
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

/// The synthetic byte inputs the stub materialises for an entry.
struct ResolvedEntryInputs {
    /// The encrypted asset bytes (always present — even failing scenarios have
    /// asset bytes; only the key / surface routing differs).
    encrypted: Vec<u8>,
    /// The candidate decrypt key, or `None` for the missing-key scenario.
    key: Option<AudioAssetKey>,
}

fn resolve_entry_inputs(scenario: MvMzEncryptedAudioScenario) -> ResolvedEntryInputs {
    match scenario {
        MvMzEncryptedAudioScenario::Valid | MvMzEncryptedAudioScenario::UnsupportedSurface => {
            ResolvedEntryInputs {
                encrypted: encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT),
                key: Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT)),
            }
        }
        MvMzEncryptedAudioScenario::WrongKey => ResolvedEntryInputs {
            encrypted: encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT),
            key: Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG)),
        },
        MvMzEncryptedAudioScenario::MissingKey => ResolvedEntryInputs {
            encrypted: encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT),
            key: None,
        },
        MvMzEncryptedAudioScenario::UnsupportedVariant => ResolvedEntryInputs {
            // Plaintext OGG with NO RPGMV header — not a valid encrypted asset.
            encrypted: SYNTHETIC_OGG.to_vec(),
            key: Some(MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT)),
        },
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MvMzEncryptedAudioRequest<'a> {
    pub fixture: &'a MvMzEncryptedAudioFixture,
    /// The manifest file name (no directory), recorded in each entry's
    /// `validationCommand` without leaking a local path.
    pub fixture_file_name: &'a str,
}

/// Run the decrypt + re-encrypt path for every entry. Each entry resolves its
/// synthetic inputs in-process; a re-encrypted patch artifact (round-trip
/// proof) is published **only** after the candidate key decrypts the asset to a
/// valid OGG and the re-encryption reproduces the source bytes. Returns `Err`
/// only on an internal failure; evidence problems are per-entry findings.
pub fn run_mv_mz_encrypted_audio(
    request: MvMzEncryptedAudioRequest<'_>,
) -> KaifuuResult<MvMzEncryptedAudioReport> {
    let fixture = request.fixture;
    let validation_command = format!(
        "kaifuu rpgmaker encrypted-audio --fixture {}",
        sanitize_file_name(request.fixture_file_name)
    );
    let path = MvMzEncryptedAudioPath::canonical()?;

    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(process_entry(
            entry,
            &fixture.source_node_id,
            &fixture.path_id,
            &validation_command,
        )?);
    }

    let status = if entries
        .iter()
        .all(|entry| entry.status == OperationStatus::Passed)
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(MvMzEncryptedAudioReport {
        schema_version: MV_MZ_ENCRYPTED_AUDIO_SCHEMA_VERSION.to_string(),
        path_id: fixture.path_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: MV_MZ_ENCRYPTED_AUDIO_SUPPORT_BOUNDARY.to_string(),
        path,
        status,
        entries,
    })
}

fn process_entry(
    entry: &MvMzEncryptedAudioFixtureEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
) -> KaifuuResult<MvMzEncryptedAudioEntryReport> {
    let mut findings = Vec::new();

    // (0) Unsupported surface short-circuits BEFORE any byte is touched: image
    // and JSON surfaces are outside this audio-only path.
    if entry.surface_codec != CodecTransform::OggAudio {
        findings.push(finding(
            FINDING_UNSUPPORTED_SURFACE,
            "surfaceCodec",
            format!(
                "surface codec {:?} is not an OGG audio surface; image and JSON surfaces are outside this path",
                entry.surface_codec
            ),
            SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_SURFACE,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::UnsupportedSurface,
            None,
            findings,
        ));
    }

    let ResolvedEntryInputs { encrypted, key } = resolve_entry_inputs(entry.scenario);

    // (1) Missing key: no decryption attempted, no patch write.
    let Some(key) = key else {
        findings.push(finding(
            FINDING_MISSING_KEY,
            "secretRef",
            "no asset key was resolvable for the secret requirement; no decryption attempted"
                .to_string(),
            SEMANTIC_MV_MZ_AUDIO_MISSING_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::MissingKey,
            None,
            findings,
        ));
    };

    // (2) Decrypt — a non-RPGMV-header asset is an unsupported variant.
    let plaintext = match decrypt_rpgmaker_asset(&encrypted, &key) {
        Ok(plaintext) => plaintext,
        Err(error) => {
            findings.push(finding(
                FINDING_UNSUPPORTED_VARIANT,
                "asset",
                format!("asset is not a well-formed RPGMV-header encrypted audio asset: {error:?}"),
                SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
            ));
            return Ok(finalize_entry(
                entry,
                source_node_id,
                path_id,
                validation_command,
                MvMzEncryptedAudioOutcome::UnsupportedVariant,
                None,
                findings,
            ));
        }
    };

    // (3) Wrong-key gate: a correctly-decrypted RPG Maker audio asset is an OGG.
    // A decrypt that does not yield the OGG capture pattern is a wrong key —
    // fail BEFORE re-encrypting (no patch write).
    if !is_ogg(&plaintext) {
        findings.push(finding(
            FINDING_WRONG_KEY,
            "secretRef",
            "candidate key did not decrypt the asset to a valid OGG; no re-encryption performed"
                .to_string(),
            SEMANTIC_MV_MZ_AUDIO_WRONG_KEY,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::WrongKey,
            None,
            findings,
        ));
    }

    // (4) Re-encrypt (the patch write) and prove byte-correctness.
    let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
    let encrypted_source_hash = ProofHash::new(sha256_hash_bytes(&encrypted))?;
    let reencrypted_hash = ProofHash::new(sha256_hash_bytes(&reencrypted))?;
    let byte_correct = reencrypted == encrypted;
    let proof = MvMzAudioRoundTripProof {
        requirement_id: entry.requirement_id.clone(),
        secret_ref: entry.secret_ref.clone(),
        surface_id: entry.surface.surface_id(),
        encrypted_source_hash,
        decrypted_plaintext_hash: ProofHash::new(sha256_hash_bytes(&plaintext))?,
        reencrypted_hash: reencrypted_hash.clone(),
        byte_correct_round_trip: byte_correct,
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        validation: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: reencrypted_hash,
        },
        redaction_status: crate::HelperRedactionStatus::Redacted,
    };

    // A round trip that is not byte-correct is an internal failure (the XOR
    // scheme must be involutive); never publish a non-byte-correct proof.
    if !byte_correct {
        findings.push(finding(
            FINDING_INTERNAL,
            "reencrypted",
            "re-encryption did not reproduce the source bytes (round-trip not byte-correct)"
                .to_string(),
            SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
        ));
        return Ok(finalize_entry(
            entry,
            source_node_id,
            path_id,
            validation_command,
            MvMzEncryptedAudioOutcome::UnsupportedVariant,
            None,
            findings,
        ));
    }

    Ok(finalize_entry(
        entry,
        source_node_id,
        path_id,
        validation_command,
        MvMzEncryptedAudioOutcome::RoundTripped,
        Some(proof),
        findings,
    ))
}

// reason: single cohesive entry-finalize over distinct MV/MZ header fields; a params struct would only relocate the arity.
#[allow(clippy::too_many_arguments)]
fn finalize_entry(
    entry: &MvMzEncryptedAudioFixtureEntry,
    source_node_id: &str,
    path_id: &str,
    validation_command: &str,
    outcome: MvMzEncryptedAudioOutcome,
    proof: Option<MvMzAudioRoundTripProof>,
    mut findings: Vec<MvMzEncryptedAudioFinding>,
) -> MvMzEncryptedAudioEntryReport {
    // Validator: the evidence-derived outcome must match the declared
    // expectation. A correctly-diagnosed failure (wrong-key, missing-key,
    // unsupported surface / variant) is a structured finding but a PASSING
    // conformance entry — the path behaved correctly. Only an outcome mismatch
    // or an internal finding flips the entry red.
    let outcome_matches = entry.expected == outcome;
    if !outcome_matches {
        findings.push(finding(
            FINDING_OUTCOME_MISMATCH,
            "expected",
            format!(
                "entry declared outcome {} but evidence derived {}",
                entry.expected.as_str(),
                outcome.as_str()
            ),
            SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
        ));
    }

    let round_tripped = outcome == MvMzEncryptedAudioOutcome::RoundTripped;
    // Belt-and-braces: a proof may exist ONLY for a round-tripped outcome.
    let proof = if round_tripped { proof } else { None };

    let status = if outcome_matches && !findings.iter().any(|finding| forces_failure(&finding.code))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    MvMzEncryptedAudioEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        path_id: path_id.to_string(),
        surface_id: entry.surface.surface_id(),
        scenario: entry.scenario,
        outcome,
        round_tripped: round_tripped && proof.is_some(),
        proof,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

/// Internal findings that flip an entry red regardless of the declared
/// expectation. Diagnosis-class findings (the expected semantic outcomes) are
/// excluded — a correctly-diagnosed wrong key is a passing conformance entry.
fn forces_failure(code: &str) -> bool {
    matches!(code, FINDING_OUTCOME_MISMATCH | FINDING_INTERNAL)
}

fn finding(
    code: &str,
    field: &str,
    message: String,
    semantic_code: &str,
) -> MvMzEncryptedAudioFinding {
    MvMzEncryptedAudioFinding {
        code: code.to_string(),
        severity: PartialDiagnosticSeverity::P0,
        field: field.to_string(),
        message,
        semantic_code: Some(semantic_code.to_string()),
    }
}

/// Keep only the file-name component of a declared manifest name so the recorded
/// validation command can never echo a local directory path.
fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(|| "encrypted-audio.json".to_string(), ToString::to_string)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::read_json;

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/rpgmaker")
    }

    fn load_fixture() -> MvMzEncryptedAudioFixture {
        read_json(&manifest_dir().join("encrypted-audio.json"))
            .expect("encrypted-audio manifest must parse")
    }

    fn run(fixture: &MvMzEncryptedAudioFixture) -> MvMzEncryptedAudioReport {
        run_mv_mz_encrypted_audio(MvMzEncryptedAudioRequest {
            fixture,
            fixture_file_name: "encrypted-audio.json",
        })
        .expect("run must not error internally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut MvMzEncryptedAudioFixture,
        entry_id: &str,
    ) -> &'a mut MvMzEncryptedAudioFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &MvMzEncryptedAudioReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn canonical_path_declares_and_validates_every_leg() {
        let path = MvMzEncryptedAudioPath::canonical().unwrap();
        assert_eq!(path.engine_family, "rpg_maker_mv_mz");
        assert_eq!(path.variant, "mv_or_mz");
        assert_eq!(path.container, ContainerTransform::ProjectAsset);
        assert_eq!(path.codec, CodecTransform::OggAudio);
        assert_eq!(
            path.crypto_profile.crypto,
            CryptoTransform::RpgMakerAssetXor
        );
        assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
        assert_eq!(
            path.secret_requirement_ids,
            vec![MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID.to_string()]
        );
        assert_eq!(path.audio_surfaces.len(), 4);
        assert!(!path.diagnostics.is_empty());
        assert_eq!(path.fixture_id, MV_MZ_ENCRYPTED_AUDIO_FIXTURE_ID);
        path.validate().expect("canonical path is consistent");
    }

    #[test]
    fn engine_family_token_matches_image_path() {
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_ENGINE_FAMILY,
            crate::MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY,
            "audio and image paths must share the engine_family token"
        );
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_VARIANT,
            crate::MV_MZ_ENCRYPTED_IMAGE_VARIANT
        );
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_CRYPTO_PROFILE_ID,
            crate::MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID
        );
        assert_eq!(
            MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID,
            crate::MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID
        );
    }

    #[test]
    fn validate_rejects_non_audio_codec_and_wrong_legs() {
        let mut path = MvMzEncryptedAudioPath::canonical().unwrap();
        path.codec = CodecTransform::PngImage;
        path.patch_back = PatchBackTransform::RewriteJson;
        path.audio_surfaces[0].codec = CodecTransform::PngImage;
        let violations = path.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzEncryptedAudioPathViolation::WrongCodec { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedAudioPathViolation::PatchBackNotReplaceAsset { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedAudioPathViolation::AudioSurfaceClaimsNonAudioCodec { .. }
        )));
    }

    #[test]
    fn decrypt_re_encrypt_is_byte_correct_round_trip() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let encrypted = encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT);
        // The encrypted asset carries the RPGMV header magic.
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        );
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &key).expect("decrypts");
        assert_eq!(plaintext, SYNTHETIC_OGG, "decrypt recovers the OGG exactly");
        assert!(is_ogg(&plaintext));
        let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
        assert_eq!(
            reencrypted, encrypted,
            "re-encrypt reproduces the source bytes (byte-correct)"
        );
        assert_eq!(
            sha256_hash_bytes(&reencrypted),
            sha256_hash_bytes(&encrypted)
        );
    }

    #[test]
    fn wrong_key_decrypt_does_not_yield_an_ogg() {
        let encrypted = encrypt_synthetic_audio(SYNTHETIC_KEY_CORRECT);
        let wrong = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG);
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &wrong).expect("strips header");
        assert!(!is_ogg(&plaintext), "wrong key must not recover the OGG");
    }

    #[test]
    fn malformed_header_is_a_variant_error() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        assert_eq!(
            decrypt_rpgmaker_asset(SYNTHETIC_OGG, &key).err(),
            Some(MvMzAudioVariantError::MissingHeaderMagic)
        );
        assert_eq!(
            decrypt_rpgmaker_asset(b"RPGMV", &key).err(),
            Some(MvMzAudioVariantError::TooShort)
        );
    }

    #[test]
    fn fixture_matrix_passes_and_records_path() {
        let report = run(&load_fixture());
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert_eq!(report.source_node_id, "KAIFUU-116");
        report.path.validate().expect("path is consistent");
        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert_eq!(entry.source_node_id, "KAIFUU-116");
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu rpgmaker encrypted-audio --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn valid_entry_round_trips_with_matching_hashes() {
        let report = run(&load_fixture());
        let entry = report.entry("audio-valid-bgm").unwrap();
        assert_eq!(entry.outcome, MvMzEncryptedAudioOutcome::RoundTripped);
        assert!(entry.round_tripped);
        let proof = entry
            .consumable_proof()
            .expect("round-tripped is consumable");
        assert!(proof.byte_correct_round_trip);
        // Byte-correct: the re-encrypted hash equals the encrypted source hash.
        assert_eq!(
            proof.reencrypted_hash.as_str(),
            proof.encrypted_source_hash.as_str()
        );
        // The decrypted plaintext is exactly the synthetic OGG.
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_OGG)
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::FixtureRoundTripProof
        );
        assert_eq!(proof.key_bytes, RPGMAKER_AUDIO_XOR_PREFIX_LEN as u32);
    }

    #[test]
    fn failing_entries_publish_no_patch_artifact() {
        let report = run(&load_fixture());
        for (entry_id, outcome, code) in [
            (
                "audio-wrong-key",
                MvMzEncryptedAudioOutcome::WrongKey,
                FINDING_WRONG_KEY,
            ),
            (
                "audio-missing-key",
                MvMzEncryptedAudioOutcome::MissingKey,
                FINDING_MISSING_KEY,
            ),
            (
                "audio-unsupported-surface-image",
                MvMzEncryptedAudioOutcome::UnsupportedSurface,
                FINDING_UNSUPPORTED_SURFACE,
            ),
            (
                "audio-unsupported-variant",
                MvMzEncryptedAudioOutcome::UnsupportedVariant,
                FINDING_UNSUPPORTED_VARIANT,
            ),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, outcome, "{entry_id}");
            assert!(!entry.round_tripped, "{entry_id} must not round-trip");
            assert!(entry.proof.is_none(), "{entry_id} must publish no proof");
            assert!(
                entry.consumable_proof().is_none(),
                "{entry_id} must not be consumable"
            );
            assert!(has_finding(&report, entry_id, code), "{entry_id} finding");
            // The structured finding carries a semantic code.
            let finding = report
                .entry(entry_id)
                .unwrap()
                .findings
                .iter()
                .find(|finding| finding.code == code)
                .unwrap();
            assert!(finding.semantic_code.is_some(), "{entry_id} semantic code");
        }
    }

    #[test]
    fn validator_fails_on_outcome_mismatch() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "audio-wrong-key").expected =
            MvMzEncryptedAudioOutcome::RoundTripped;
        let report = run(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "audio-wrong-key",
            FINDING_OUTCOME_MISMATCH
        ));
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        use std::fmt::Write as _;
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        let key_text = String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT);
        assert!(!json.contains(key_text.as_ref()), "raw key leaked");
        let key_hex: String = SYNTHETIC_KEY_CORRECT
            .iter()
            .fold(String::new(), |mut acc, byte| {
                let _ = write!(acc, "{byte:02x}");
                acc
            });
        assert!(!json.contains(&key_hex), "raw key hex leaked");

        // The proof carries a one-way commitment + count, not the key.
        let proof = report
            .entry("audio-valid-bgm")
            .unwrap()
            .proof
            .as_ref()
            .unwrap();
        assert_eq!(proof.key_bytes as usize, SYNTHETIC_KEY_CORRECT.len());
        assert_eq!(
            proof.key_material_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_KEY_CORRECT)
        );
    }

    #[test]
    fn key_debug_is_redacted_and_zeroized() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT).into_owned()));
    }

    #[test]
    fn report_round_trips_through_stable_json() {
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzEncryptedAudioReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }
}
