//! bounded MV/MZ encrypted-asset decrypt → replace → patch →
//! verify **slice** over SYNTHETIC encrypted image/audio fixtures.
//! Where the kaifuu-core paths prove each leg in isolation
//! ([`kaifuu_core::mv_mz_encrypted_image`] decrypt/re-encrypt,
//! [`kaifuu_core::mv_mz_encrypted_audio`] decrypt/re-encrypt,
//! [`kaifuu_core::mv_mz_encrypted_asset_replacement`] replace+verify), THIS node
//! stitches them into one bounded, end-to-end slice and adds the two surfaces
//! those paths do not carry:
//! 1. **Encrypted-suffix routing.** RPG Maker ships encrypted assets under
//!    engine-specific suffixes — image MV `.rpgmvp` / MZ `.png_`, audio MV
//!    `.rpgmvo` (Ogg) / MZ `.ogg_`, audio MV `.rpgmvm` / MZ `.m4a_` (M4A). This
//!    slice parses the suffix to a [`MediaCapability`]; an off-profile suffix is
//!    a TYPED [`MvMzSliceError::UnsupportedSuffix`], never a silent skip.
//! 2. **Key source.** The 16-byte asset key is derived either from a
//!    `System.json`-style `encryptionKey` (a 32-hex string) or **image-derived**:
//!    recovered by XOR-ing the encrypted image's first 16 body bytes against the
//!    known PNG plaintext prefix — no `System.json` needed. A missing key is
//!    [`MvMzSliceError::NoKey`]; an undecodable `encryptionKey` is
//!    [`MvMzSliceError::BadKeyMaterial`]; a decodable-but-wrong key that fails to
//!    recover the declared media signature is [`MvMzSliceError::WrongKey`].
//! 3. **Audio/image capability diff.** A replacement whose media kind does not
//!    match the asset suffix's capability (e.g. an image blob patched over an
//!    `.ogg_` audio asset), or an image-derived key source pointed at an audio
//!    asset, is a TYPED [`MvMzSliceError::CapabilityDiff`].
//! # The crypto (shared core, native Rust, NO shell-out)
//! The XOR primitive, key type, decrypt, and re-encrypt are the single canonical
//! [`kaifuu_core::mv_mz_asset_xor`] implementation; this slice never
//! re-implements them. A 16-byte
//! [`kaifuu_core::RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] is prepended and the first
//! 16 media bytes are XOR-masked with the key. XOR is involutive, so a correct
//! key round-trips byte-for-byte.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live only inside [`kaifuu_core::MvMzAssetKey`] (redacting
//!   `Debug`, zeroizing `Drop`). Reports carry secret-refs + sha256 commitments /
//!   hashes / counts only — never the key, never the media bytes.
//! - A consumable verify proof is published ONLY after the key resolves, the
//!   decrypt recovers the declared media signature, and every hash check passes.
//!   No-key, bad-key, wrong-key, unsupported-suffix, capability-diff, and
//!   non-media-replacement entries fail BEFORE a consumable proof — each is a
//!   TYPED [`MvMzSliceError`] surfaced as a structured diagnostic, never a panic
//!   or silent pass.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module from the public synthetic PNG/OGG media of
//! the kaifuu-core paths plus a clearly-fake 16-byte test key. No retail media
//! and no real keys are ever vendored; reports carry only hashes / counts /
//! secret-refs.

use std::fmt;
use std::path::Path;

use kaifuu_core::mv_mz_encrypted_audio::OGG_SIGNATURE;
use kaifuu_core::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};
use kaifuu_core::{
    HelperRedactionStatus, KeyValidationMethod, KeyValidationProof, MvMzAssetKey, OperationStatus,
    ProofHash, RPGMAKER_ASSET_XOR_PREFIX_LEN, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, SecretRef,
    decrypt_rpgmaker_asset, encrypt_rpgmaker_asset, redact_for_log_or_report, sha256_hash_bytes,
    stable_json,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MV_MZ_SLICE_SCHEMA_VERSION: &str = "0.1.0";
pub const MV_MZ_SLICE_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
pub const MV_MZ_SLICE_VARIANT: &str = "mv_or_mz";
pub const MV_MZ_SLICE_CRYPTO_PROFILE_ID: &str = "rpgmaker/mv_mz/asset_xor_v1";
pub const MV_MZ_SLICE_REQUIREMENT_ID: &str = "rpgmaker-mv-mz-asset-key";
pub const MV_MZ_SLICE_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-encrypted-asset-slice";

pub const MV_MZ_SLICE_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-asset slice (KAIFUU-068) is in-process Rust over the shared RPGMV-header XOR-with-System.json-key scheme (image MV .rpgmvp / MZ .png_, audio MV .rpgmvo|.rpgmvm / MZ .ogg_|.m4a_); it never shells out. It parses the encrypted suffix to an image/audio capability, resolves the 16-byte key from a System.json encryptionKey or image-derived metadata, decrypts to the declared media, and either proves a byte-correct identity round-trip or applies + verifies a trivial replacement patch (decrypt(patched)==replacement, header exact, differs-from-original). A consumable verify proof is published only after the key resolves and every hash check passes; no-key, bad-key, wrong-key, unsupported-suffix, capability-diff, and non-media-replacement entries are rejected with typed diagnostics before any consumable proof. Raw key bytes are never logged, serialized, or returned — reports carry secret-refs + sha256 commitments only.";

#[path = "encrypted_asset_slice/profile.rs"]
mod profile;

use profile::proof_hash;
pub use profile::{
    EncryptedAssetSuffix, MediaCapability, MvMzKeySource, MvMzKeySourceKind, MvMzSliceError,
    MvMzSliceInternalError, MvMzSliceOp, MvMzSliceOutcome, SliceReplacement,
};
#[cfg(test)]
use profile::{decode_encryption_key_hex, recover_image_derived_key};

/// A structured diagnostic for a typed slice error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceDiagnostic {
    pub code: String,
    pub semantic_code: String,
    pub message: String,
}

impl MvMzSliceDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            semantic_code: redact_for_log_or_report(&self.semantic_code),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The identity-round-trip leg of a verify proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRoundTripProof {
    /// sha256 of `re_encrypt(decrypt(enc))`.
    pub reencrypted_hash: ProofHash,
    /// `true` iff `reencrypted_hash == encrypted_source_hash` (byte-correct).
    pub byte_correct_round_trip: bool,
}

/// The replacement-patch leg of a verify proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicePatchProof {
    /// sha256 of the intended replacement plaintext.
    pub replacement_plaintext_hash: ProofHash,
    /// sha256 of the produced patched encrypted asset.
    pub patched_encrypted_hash: ProofHash,
    /// sha256 of `decrypt(patched)`.
    pub decrypted_patched_hash: ProofHash,
    /// `true` iff `decrypt(patched) == replacement`.
    pub decrypt_matches_replacement: bool,
    /// `true` iff the patched asset differs from the original encrypted asset.
    pub differs_from_original: bool,
}

/// The hash-based verify proof. Carries hashes / counts / a secret-ref +
/// commitment only — never the key bytes, never the media bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceVerifyProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub asset_capability: MediaCapability,
    pub key_source_kind: MvMzKeySourceKind,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    /// sha256 of the original encrypted asset bytes.
    pub encrypted_source_hash: ProofHash,
    /// sha256 of `decrypt(enc)`.
    pub decrypted_plaintext_hash: ProofHash,
    /// sha256 of the declared known plaintext.
    pub known_plaintext_hash: ProofHash,
    /// `true` iff `decrypt(enc)` equals the declared known plaintext.
    pub decrypt_matches_known: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round_trip: Option<SliceRoundTripProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<SlicePatchProof>,
    pub validation: KeyValidationProof,
    pub redaction_status: HelperRedactionStatus,
}

impl MvMzSliceVerifyProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            asset_capability: self.asset_capability,
            key_source_kind: self.key_source_kind,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            encrypted_source_hash: self.encrypted_source_hash.clone(),
            decrypted_plaintext_hash: self.decrypted_plaintext_hash.clone(),
            known_plaintext_hash: self.known_plaintext_hash.clone(),
            decrypt_matches_known: self.decrypt_matches_known,
            round_trip: self.round_trip.clone(),
            patch: self.patch.clone(),
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

/// One slice entry report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub asset_file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<EncryptedAssetSuffix>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_capability: Option<MediaCapability>,
    pub outcome: MvMzSliceOutcome,
    /// `true` only when a consumable verify proof was published.
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<MvMzSliceVerifyProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MvMzSliceDiagnostic>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
}

impl MvMzSliceEntryReport {
    /// The verify proof a caller may consume **iff** the entry passed and
    /// verified. Anything else returns `None`.
    #[must_use]
    pub fn consumable_proof(&self) -> Option<&MvMzSliceVerifyProof> {
        if self.verified && self.status == OperationStatus::Passed {
            self.verify.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            asset_file_name: redact_for_log_or_report(&self.asset_file_name),
            suffix: self.suffix,
            asset_capability: self.asset_capability,
            outcome: self.outcome,
            verified: self.verified,
            verify: self
                .verify
                .as_ref()
                .map(MvMzSliceVerifyProof::redacted_for_report),
            error: self
                .error
                .as_ref()
                .map(MvMzSliceDiagnostic::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
        }
    }
}

/// The full slice report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceReport {
    pub schema_version: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub variant: String,
    pub crypto_profile_id: String,
    pub fixture_id: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<MvMzSliceEntryReport>,
}

impl MvMzSliceReport {
    #[must_use]
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzSliceEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    #[must_use]
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            variant: redact_for_log_or_report(&self.variant),
            crypto_profile_id: redact_for_log_or_report(&self.crypto_profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(MvMzSliceEntryReport::redacted_for_report)
                .collect(),
        }
    }

    /// Stable, redacted JSON (secret-refs + hashes only, trailing newline).
    pub fn stable_json(&self) -> Result<String, MvMzSliceInternalError> {
        stable_json(&self.redacted_for_report())
            .map_err(|err| MvMzSliceInternalError::new(err.to_string()))
    }
}

fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(|| "asset.bin".to_string(), ToString::to_string)
}

/// The pure decrypt→(replace)→patch→verify transform for one op. Returns the
/// verify proof + outcome on success, or a typed [`MvMzSliceError`]. Never
/// panics; input problems are all typed errors.
fn slice_verify(op: &MvMzSliceOp) -> Result<(MvMzSliceVerifyProof, MvMzSliceOutcome), SliceStep> {
    // (0) Route the encrypted suffix to a capability.
    let suffix = EncryptedAssetSuffix::parse(&op.asset_file_name).map_err(SliceStep::Typed)?;
    let capability = suffix.capability();

    // (1) Capability diff: a replacement whose kind mismatches the asset.
    if let Some(replacement) = &op.replacement
        && replacement.capability != capability
    {
        return Err(SliceStep::Typed(MvMzSliceError::CapabilityDiff {
            asset_capability: capability,
            requested_capability: replacement.capability,
        }));
    }

    // (2) Resolve the key (typed no-key / bad-key / capability-diff).
    let key = op
        .key_source
        .resolve(&op.encrypted_asset, capability)
        .map_err(SliceStep::Typed)?;

    // (3) Decrypt (typed malformed-asset).
    let plaintext = decrypt_rpgmaker_asset(&op.encrypted_asset, &key).map_err(|err| {
        SliceStep::Typed(MvMzSliceError::MalformedAsset {
            reason: format!("{err:?}"),
        })
    })?;

    // (4) Wrong-key gate: a correct decrypt recovers the declared media signature.
    if !capability.signature_matches(&plaintext) {
        return Err(SliceStep::Typed(MvMzSliceError::WrongKey { capability }));
    }

    // (5) Hash-based decrypt-verify against the declared known plaintext.
    let encrypted_source_hash = proof_hash(&op.encrypted_asset).map_err(SliceStep::Internal)?;
    let decrypted_plaintext_hash = proof_hash(&plaintext).map_err(SliceStep::Internal)?;
    let known_plaintext_hash = proof_hash(&op.known_plaintext).map_err(SliceStep::Internal)?;
    let decrypt_matches_known = plaintext == op.known_plaintext;
    let key_material_hash = key
        .material_hash()
        .map_err(|err| SliceStep::Internal(MvMzSliceInternalError::new(err.to_string())))?;
    let key_bytes = u32::try_from(key.byte_len()).unwrap_or(u32::MAX);

    let mut proof = MvMzSliceVerifyProof {
        requirement_id: MV_MZ_SLICE_REQUIREMENT_ID.to_string(),
        secret_ref: op.secret_ref.clone(),
        asset_capability: capability,
        key_source_kind: op.key_source.kind(),
        key_material_hash,
        key_bytes,
        encrypted_source_hash: encrypted_source_hash.clone(),
        decrypted_plaintext_hash,
        known_plaintext_hash,
        decrypt_matches_known,
        round_trip: None,
        patch: None,
        validation: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: encrypted_source_hash.clone(),
        },
        redaction_status: HelperRedactionStatus::Redacted,
    };

    // (6a) Replacement patch path.
    if let Some(replacement) = &op.replacement {
        if !capability.signature_matches(&replacement.plaintext) {
            return Err(SliceStep::Typed(MvMzSliceError::ReplacementNotMedia {
                capability,
            }));
        }
        let patched = encrypt_rpgmaker_asset(&replacement.plaintext, &key);
        let decrypted_patched = decrypt_rpgmaker_asset(&patched, &key).map_err(|err| {
            SliceStep::Typed(MvMzSliceError::MalformedAsset {
                reason: format!("patched asset no longer decrypts: {err:?}"),
            })
        })?;
        let decrypt_matches_replacement = decrypted_patched == replacement.plaintext;
        let differs_from_original = patched != op.encrypted_asset;
        let decrypted_patched_hash = proof_hash(&decrypted_patched).map_err(SliceStep::Internal)?;
        proof.patch = Some(SlicePatchProof {
            replacement_plaintext_hash: proof_hash(&replacement.plaintext)
                .map_err(SliceStep::Internal)?,
            patched_encrypted_hash: proof_hash(&patched).map_err(SliceStep::Internal)?,
            decrypted_patched_hash: decrypted_patched_hash.clone(),
            decrypt_matches_replacement,
            differs_from_original,
        });
        proof.validation = KeyValidationProof {
            method: KeyValidationMethod::KnownPlaintextProof,
            proof_hash: decrypted_patched_hash,
        };
        // A produced-but-unverified patch is an internal fault, never published.
        if !(decrypt_matches_replacement && differs_from_original) {
            return Err(SliceStep::Internal(MvMzSliceInternalError::new(format!(
                "patch verify failed: decrypt_matches_replacement={decrypt_matches_replacement} differs_from_original={differs_from_original}"
            ))));
        }
        return Ok((proof, MvMzSliceOutcome::Replaced));
    }

    // (6b) Identity round-trip path.
    let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
    let byte_correct_round_trip = reencrypted == op.encrypted_asset;
    proof.round_trip = Some(SliceRoundTripProof {
        reencrypted_hash: proof_hash(&reencrypted).map_err(SliceStep::Internal)?,
        byte_correct_round_trip,
    });
    if !byte_correct_round_trip {
        return Err(SliceStep::Internal(MvMzSliceInternalError::new(
            "identity round-trip not byte-correct".to_string(),
        )));
    }
    Ok((proof, MvMzSliceOutcome::DecryptedRoundTripped))
}

/// A failed step: a typed input error (a valid diagnostic) or an internal fault.
enum SliceStep {
    Typed(MvMzSliceError),
    Internal(MvMzSliceInternalError),
}

/// Run one slice op → an entry report. The declared `expected` outcome is
/// validated against the evidence-derived one: a correctly-diagnosed failure
/// (no-key, bad-key, wrong-key, unsupported-suffix, capability-diff,
/// replacement-not-media) is a PASSING conformance entry; only an outcome
/// mismatch or an internal fault flips the entry red. Returns `Err` only on an
/// internal fault.
pub fn run_slice_op(
    op: &MvMzSliceOp,
    source_node_id: &str,
) -> Result<MvMzSliceEntryReport, MvMzSliceInternalError> {
    let validation_command = format!(
        "kaifuu rpgmaker encrypted-asset-slice --asset {}",
        sanitize_file_name(&op.asset_file_name)
    );
    // Suffix (best-effort) for provenance even on a failing entry.
    let suffix = EncryptedAssetSuffix::parse(&op.asset_file_name).ok();
    let asset_capability = suffix.map(EncryptedAssetSuffix::capability);

    let (outcome, verify, error) = match slice_verify(op) {
        Ok((proof, outcome)) => (outcome, Some(proof), None),
        Err(SliceStep::Typed(err)) => (err.outcome(), None, Some(err.diagnostic())),
        Err(SliceStep::Internal(err)) => return Err(err),
    };

    let outcome_matches = op.expected == outcome;
    let verified =
        outcome == MvMzSliceOutcome::DecryptedRoundTripped || outcome == MvMzSliceOutcome::Replaced;
    // Belt-and-braces: a proof exists ONLY for a verified outcome.
    let verify = if verified { verify } else { None };
    let status = if outcome_matches {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(MvMzSliceEntryReport {
        entry_id: op.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        asset_file_name: sanitize_file_name(&op.asset_file_name),
        suffix,
        asset_capability,
        outcome,
        verified: verified && verify.is_some(),
        verify,
        error,
        validation_command,
        redaction_status: "redacted".to_string(),
        status,
    })
}

/// Run the whole slice fixture → a report. Aggregates per-op entries; the report
/// is `Passed` iff every entry passed.
pub fn run_mv_mz_slice(
    ops: &[MvMzSliceOp],
    source_node_id: &str,
) -> Result<MvMzSliceReport, MvMzSliceInternalError> {
    let mut entries = Vec::with_capacity(ops.len());
    for op in ops {
        entries.push(run_slice_op(op, source_node_id)?);
    }
    let status = if entries
        .iter()
        .all(|entry| entry.status == OperationStatus::Passed)
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    Ok(MvMzSliceReport {
        schema_version: MV_MZ_SLICE_SCHEMA_VERSION.to_string(),
        source_node_id: source_node_id.to_string(),
        engine_family: MV_MZ_SLICE_ENGINE_FAMILY.to_string(),
        variant: MV_MZ_SLICE_VARIANT.to_string(),
        crypto_profile_id: MV_MZ_SLICE_CRYPTO_PROFILE_ID.to_string(),
        fixture_id: MV_MZ_SLICE_FIXTURE_ID.to_string(),
        support_boundary: MV_MZ_SLICE_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    })
}

mod fixture;

pub use fixture::{MV_MZ_SLICE_SOURCE_NODE_ID, canonical_slice_fixture};
