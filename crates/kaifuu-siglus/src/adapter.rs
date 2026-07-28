//! pure Siglus extraction + patching adapter for profiled
//! `Scene.pck` / `Gameexe.dat` variants.
//! This module is the **pure adapter** layer: it EXTRACTS and PATCHES profiled
//! Siglus containers and it OWNS the filesystem write for patch-back, but it
//! does **not** discover keys. The distinction from the known-key
//! smoke ([`crate::known_key_smoke`]) is the seam:
//! - the smoke resolves its own (synthetic) key internally — a self-contained
//!   demonstration;
//! - the adapter is *handed* an already-resolved [`ResolvedSiglusKey`]: a
//!   structured secret-ref + a [`KeyValidationProof`] + the raw material the
//!   key-discovery layer (static-key / secret store) produced. The
//!   adapter **re-validates the proof against the material before consuming it**
//!   (validate-before-consume) and never persists, logs, or serializes the raw
//!   bytes.
//! # What this adapter proves (all on profiled fixtures)
//! - **Extract** profiled `Scene` / `Gameexe` text + metadata with a resolved key.
//! - **Identity round-trip** — re-emit an unedited container **byte-identical**
//!   to the input.
//! - **Translated round-trip** — apply translated edits so the in-scope units
//!   decode to the new text AND every out-of-scope byte survives identical.
//! - **Patch + verify** to disk: atomic write, and — crucially —
//!   **reject-before-write**. Every failure class (unsupported/protected variant,
//!   key-proof mismatch, in-profile verify failure, or a reject-on-secret
//!   finding) returns `Err` with **no output file written**.
//! - **Reject-on-secret** — before any write the output bytes + the redacted
//!   report are deep-scanned; a raw key or decrypted-text leak fails loud.
//! # Honest scope / real-bytes gap
//! Like the smoke, the profiled format here is the narrow constant-key-XOR,
//! UTF-16LE, uncompressed-within-profile container — NOT the real
//! constant-256-XOR-table + per-game second-layer strip and proprietary-LZSS
//! codec (those remain the proprietary-LZSS skeleton). Out-of-profile
//! compression / magic is a typed capability error, never a silent pass. No real retail Siglus
//! `Scene.pck` / `Gameexe.dat` bytes are available in the vault/scratch as of
//! this node, so validation is on profiled synthetic fixtures; the real-bytes
//! gap is documented in `docs/kaifuu-siglus-pure-adapter-capability.md`.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, atomic_write_bytes, atomic_write_text,
    redact_for_log_or_report, secret_holder::SecretRefSecretResolver, sha256_hash_bytes,
    stable_json,
};

use crate::known_key_smoke::{
    GameexeEntryDigest, GameexeExtractionReport, GameexeRecordLayout, KnownKeyMaterial,
    KnownKeySmokeError, SceneExtractionReport, SceneRecordLayout, SceneUnitDigest,
    SiglusGameexeExtraction, SiglusKnownKeyCompression, SiglusKnownKeyContainerSource,
    SiglusKnownKeyEncoding, SiglusKnownKeyProfile, SiglusSceneExtraction, extract_gameexe_with,
    extract_scene_with, parse_source_unit_index, patch_gameexe_value_with, patch_scene_unit_with,
    read_gameexe_record_layout, read_scene_record_layout, reemit_gameexe_records,
    reemit_scene_records, utf16le_encode,
};

/// Schema version of the adapter patch report.
pub const ADAPTER_SCHEMA_VERSION: &str = "0.1.0";

/// The adapter capability id.
pub const ADAPTER_CAPABILITY_ID: &str = "kaifuu-siglus-pure-adapter";

/// Provenance node id stamped into adapter reports.
pub const ADAPTER_SOURCE_NODE_ID: &str = "synthetic-fixture";

/// The blunt support boundary surfaced in every adapter report.
pub const ADAPTER_SUPPORT_BOUNDARY: &str = "Kaifuu Siglus pure adapter EXTRACTS and PATCHES profiled Scene.pck/Gameexe.dat variants (constant-key-XOR, UTF-16LE, uncompressed-within-profile) using an ALREADY-RESOLVED key it re-validates before consuming — it performs NO key discovery. It proves extract, identity byte-identical round-trip, translated round-trip (in-scope correct + out-of-scope byte-identical), and reject-before-write patch+verify with a reject-on-secret deep scan. It is NOT broad commercial Siglus support: the real constant-256-XOR-table + per-game second-layer strip and proprietary-LZSS codec remain skeleton stubs (siglus-04/siglus-06); out-of-profile compression/magic is a typed capability error. Raw key material and decrypted text are never persisted; the report carries secret-refs + one-way proof hashes + counts only.";

// Resolved key (consumed, never discovered)

/// A resolved Siglus secondary key the adapter CONSUMES. Carries the structured
/// secret-ref + the validation proof the key-discovery layer published, plus the
/// raw material held only inside the crate-private zeroizing [`KnownKeyMaterial`]
/// holder. Nothing here serializes, logs, or returns the raw bytes.
/// Construct via [`ResolvedSiglusKey::consume`], which re-validates the proof
/// against the material (validate-before-consume) and rejects a mismatch.
pub struct ResolvedSiglusKey {
    secret_ref: SecretRef,
    validation: KeyValidationProof,
    material_kind: KeyMaterialKind,
    material: KnownKeyMaterial,
}

impl std::fmt::Debug for ResolvedSiglusKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedSiglusKey")
            .field("secret_ref", &self.secret_ref)
            .field("validation", &self.validation)
            .field("material_kind", &self.material_kind)
            .field("material", &"[REDACTED:kaifuu.secret_redacted]")
            .finish()
    }
}

impl ResolvedSiglusKey {
    /// Consume an already-resolved key: a structured secret-ref, the validation
    /// proof the discovery layer published, and the raw material bytes.
    /// Validate-before-consume: the adapter recomputes a one-way commitment over
    /// the material and requires it to equal the supplied proof
    /// ([`KeyValidationMethod::KnownPlaintextProof`], a commitment to the key
    /// bytes). A method the adapter cannot re-check, or a hash that does not
    /// match, is [`AdapterError::KeyProofMethodUnsupported`] /
    /// [`AdapterError::KeyProofMismatch`] — the key is refused and no operation
    /// proceeds.
    pub fn consume(
        secret_ref: SecretRef,
        validation: KeyValidationProof,
        material_kind: KeyMaterialKind,
        raw_material: Vec<u8>,
    ) -> Result<Self, AdapterError> {
        if raw_material.is_empty() {
            return Err(AdapterError::KeyProofMismatch {
                detail: "resolved key material is empty".to_string(),
            });
        }
        if validation.method != KeyValidationMethod::KnownPlaintextProof {
            return Err(AdapterError::KeyProofMethodUnsupported {
                method: format!("{:?}", validation.method),
            });
        }
        let holder = SecretRefSecretResolver::from_entries(vec![(
            secret_ref.as_str().to_string(),
            raw_material,
        )])
        .into_resolved(&secret_ref)
        .expect("newly inserted Siglus key must resolve by its SecretRef");
        let material = KnownKeyMaterial::from_holder(holder);
        let recomputed = material
            .material_hash()
            .map_err(|error| AdapterError::Internal {
                message: format!("key commitment: {error}"),
            })?;
        if recomputed.as_str() != validation.proof_hash.as_str() {
            return Err(AdapterError::KeyProofMismatch {
                detail: "recomputed key commitment does not match the supplied validation proof"
                    .to_string(),
            });
        }
        Ok(Self {
            secret_ref,
            validation,
            material_kind,
            material,
        })
    }

    /// The structured secret-ref the key is published under.
    pub fn secret_ref(&self) -> &SecretRef {
        &self.secret_ref
    }

    /// The validation proof the adapter re-checked before consuming.
    pub fn validation(&self) -> &KeyValidationProof {
        &self.validation
    }

    /// One-way sha256 commitment to the key bytes (never the bytes).
    pub fn material_hash(&self) -> KaifuuResult<ProofHash> {
        self.material.material_hash()
    }

    /// Raw key byte length (disclosed; the bytes are not).
    pub fn key_byte_len(&self) -> usize {
        self.material.byte_len()
    }

    fn material(&self) -> &KnownKeyMaterial {
        &self.material
    }
}

// Supported variant (capability gate)

/// A declared, supported profiled Siglus variant. The adapter's capability gate
/// refuses anything outside this envelope BEFORE any read/patch/write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusSupportedVariant {
    /// Stable per-variant id (a profiled game/format label).
    pub variant_id: String,
    /// The in-profile text encoding.
    pub encoding: SiglusKnownKeyEncoding,
    /// The in-profile compression.
    pub compression: SiglusKnownKeyCompression,
}

impl SiglusSupportedVariant {
    /// The single supported profile envelope: UTF-16LE, uncompressed-within-profile.
    pub fn profiled(variant_id: impl Into<String>) -> Self {
        Self {
            variant_id: variant_id.into(),
            encoding: SiglusKnownKeyEncoding::Utf16Le,
            compression: SiglusKnownKeyCompression::Uncompressed,
        }
    }

    /// Capability gate: reject an out-of-profile encoding/compression as a typed
    /// capability error (never a silent pass).
    pub fn ensure_supported(&self) -> Result<(), AdapterError> {
        if self.encoding != SiglusKnownKeyEncoding::Utf16Le {
            return Err(AdapterError::UnsupportedVariant {
                variant_id: self.variant_id.clone(),
                detail: "only UTF-16LE text is in profile".to_string(),
            });
        }
        if self.compression != SiglusKnownKeyCompression::Uncompressed {
            return Err(AdapterError::UnsupportedVariant {
                variant_id: self.variant_id.clone(),
                detail: format!(
                    "compression {} is out of profile (proprietary-LZSS is the siglus-06 skeleton)",
                    self.compression.as_str()
                ),
            });
        }
        Ok(())
    }

    /// Build the internal known-key profile the pure primitives consume, keyed by
    /// the resolved secret-ref (the adapter never re-declares its own key).
    fn internal_profile(&self, key: &ResolvedSiglusKey) -> SiglusKnownKeyProfile {
        SiglusKnownKeyProfile {
            profile_id: self.variant_id.clone(),
            secret_ref: key.secret_ref.clone(),
            encoding: self.encoding,
            compression: self.compression,
            // The pure `*_with` primitives never read these source fields (the
            // adapter is handed bytes directly), but the type requires them.
            scene_source: SiglusKnownKeyContainerSource::SyntheticStub,
            gameexe_source: SiglusKnownKeyContainerSource::SyntheticStub,
        }
    }
}

// Errors

/// Fatal errors raised by the pure adapter. Every failure is a typed error that
/// occurs BEFORE any output is written. A failure *inside* the declared profile
/// (e.g. an in-profile verify mismatch) is a bug/compat-regression, surfaced as
/// [`AdapterError::VerifyFailed`] — never a silent partial write.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AdapterError {
    /// The variant is outside the declared support profile (capability error).
    #[error(
        "kaifuu.siglus.adapter.unsupported_variant: variant {variant_id} is not supported: {detail}"
    )]
    UnsupportedVariant { variant_id: String, detail: String },
    /// The supplied key validation proof uses a method the adapter cannot
    /// re-check (it only consumes a re-validatable material commitment).
    #[error(
        "kaifuu.siglus.adapter.key_proof_method_unsupported: validation method {method} cannot be \
         re-checked against the material; the adapter consumes a known-plaintext key commitment"
    )]
    KeyProofMethodUnsupported { method: String },
    /// The recomputed key commitment did not match the supplied validation proof
    /// (validate-before-consume failed) — the key is refused before any use.
    #[error("kaifuu.siglus.adapter.key_proof_mismatch: {detail}")]
    KeyProofMismatch { detail: String },
    /// The container could not be parsed within the declared profile.
    #[error("kaifuu.siglus.adapter.parse_failed: {detail}")]
    ParseFailed { detail: String },
    /// A patch/verify inside the declared profile failed. This is a BUG /
    /// compat-regression, not a feature request.
    #[error("kaifuu.siglus.adapter.verify_failed: {detail}")]
    VerifyFailed { detail: String },
    /// A reject-on-secret deep scan found raw key or decrypted text in an
    /// artifact that was about to be written — the write is refused.
    #[error(
        "kaifuu.siglus.adapter.secret_leak: refusing to write an artifact carrying secret-shaped \
         material ({finding_count} finding(s); first: {first_finding})"
    )]
    SecretLeak {
        finding_count: u64,
        first_finding: String,
    },
    /// A filesystem error while reading input or writing output.
    #[error("kaifuu.siglus.adapter.io: {detail}")]
    Io { detail: String },
    /// An internal proof/serialization failure (redacted).
    #[error("kaifuu.siglus.adapter.internal: {message}")]
    Internal { message: String },
}

impl AdapterError {
    fn from_scene(profile_id: &str, error: KnownKeySmokeError) -> Self {
        match error {
            KnownKeySmokeError::OutOfProfileCompression { observed, .. } => {
                AdapterError::UnsupportedVariant {
                    variant_id: profile_id.to_string(),
                    detail: format!("out-of-profile compression {observed}"),
                }
            }
            KnownKeySmokeError::VerifyMismatch { detail } => AdapterError::VerifyFailed { detail },
            KnownKeySmokeError::UnitNotFound { source_unit_key } => AdapterError::VerifyFailed {
                detail: format!("patch target {source_unit_key} not found"),
            },
            other => AdapterError::ParseFailed {
                detail: other.to_string(),
            },
        }
    }
}

// A translated edit

/// A single translated edit: the target unit/config key + the replacement text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusTranslatedEdit {
    /// For a `Scene`: canonical `siglus:scene-NNNN#OOOO` unit key.
    /// For a `Gameexe`: the structural config key (e.g. `#NAMAE.000`).
    pub target_key: String,
    /// The replacement (translated) text.
    pub translated_text: String,
}

// Identity + translated round-trip results (in-memory)

/// The result of an identity round-trip: re-emit an unedited container and prove
/// it is byte-identical to the input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRoundTrip {
    /// `true` iff the re-emitted container equals the input byte-for-byte.
    pub byte_identical: bool,
    /// sha256 over the input container.
    pub input_hash: ProofHash,
    /// sha256 over the re-emitted container (equals `input_hash` when identical).
    pub reemitted_hash: ProofHash,
}

/// One in-scope unit change proven by a translated round-trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InScopeChange {
    /// The edited target key.
    pub target_key: String,
    /// `true` iff the unit now decodes to the requested translation AND differs
    /// from the original.
    pub changed: bool,
    /// sha256 commitment to the translated text (never the text).
    pub translated_text_hash: ProofHash,
}

/// The result of a translated round-trip over a `Scene` (patched bytes held in
/// memory; the FS driver writes them).
#[derive(Debug, Clone)]
pub struct TranslatedRoundTrip {
    /// The re-emitted container bytes.
    pub patched_bytes: Vec<u8>,
    /// Per-edit in-scope change proof.
    pub in_scope_changes: Vec<InScopeChange>,
    /// `true` iff every out-of-scope record is byte-identical to the original.
    pub out_of_scope_byte_identical: bool,
    /// Number of out-of-scope records that were preserved byte-identical.
    pub out_of_scope_record_count: u64,
    /// sha256 over the patched container.
    pub patched_hash: ProofHash,
}

impl TranslatedRoundTrip {
    /// Whether the round-trip fully verified: every edit changed in-scope and
    /// every out-of-scope byte survived.
    pub fn verified(&self) -> bool {
        self.out_of_scope_byte_identical
            && !self.in_scope_changes.is_empty()
            && self.in_scope_changes.iter().all(|change| change.changed)
    }
}

mod operations;
mod report_patch;
mod secret_scan;

pub use operations::*;
pub use report_patch::*;
pub use secret_scan::*;

// Helpers

fn identity_result(input: &[u8], reemitted: &[u8]) -> Result<IdentityRoundTrip, AdapterError> {
    Ok(IdentityRoundTrip {
        byte_identical: input == reemitted,
        input_hash: hash_bytes(input)?,
        reemitted_hash: hash_bytes(reemitted)?,
    })
}

fn hash_bytes(bytes: &[u8]) -> Result<ProofHash, AdapterError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(|message| AdapterError::Internal { message })
}

fn hash_text(text: &str) -> Result<ProofHash, AdapterError> {
    hash_bytes(&utf16le_encode(text))
}

fn scene_plaintext_probes(
    extraction: &SiglusSceneExtraction,
    edits: &[SiglusTranslatedEdit],
) -> Vec<String> {
    let mut probes: Vec<String> = extraction
        .units
        .iter()
        .map(|unit| unit.text.clone())
        .collect();
    probes.extend(edits.iter().map(|edit| edit.translated_text.clone()));
    probes
}

fn gameexe_plaintext_probes(
    extraction: &SiglusGameexeExtraction,
    edits: &[SiglusTranslatedEdit],
) -> Vec<String> {
    let mut probes: Vec<String> = extraction
        .entries
        .iter()
        .map(|entry| entry.value.clone())
        .collect();
    probes.extend(edits.iter().map(|edit| edit.translated_text.clone()));
    probes
}

fn scene_extraction_report(
    extraction: &SiglusSceneExtraction,
) -> Result<SceneExtractionReport, AdapterError> {
    let mut units = Vec::with_capacity(extraction.units.len());
    for unit in &extraction.units {
        let text_bytes = utf16le_encode(&unit.text);
        units.push(SceneUnitDigest {
            source_unit_key: unit.source_unit_key.clone(),
            text_byte_len: u32::try_from(text_bytes.len()).unwrap_or(u32::MAX),
            text_hash: hash_bytes(&text_bytes)?,
        });
    }
    Ok(SceneExtractionReport {
        scene_id: extraction.scene_id,
        unit_count: u32::try_from(extraction.units.len()).unwrap_or(u32::MAX),
        units,
    })
}

fn gameexe_extraction_report(
    extraction: &SiglusGameexeExtraction,
) -> Result<GameexeExtractionReport, AdapterError> {
    let mut entries = Vec::with_capacity(extraction.entries.len());
    for entry in &extraction.entries {
        let value_bytes = utf16le_encode(&entry.value);
        entries.push(GameexeEntryDigest {
            key: entry.key.clone(),
            value_byte_len: u32::try_from(value_bytes.len()).unwrap_or(u32::MAX),
            value_hash: hash_bytes(&value_bytes)?,
        });
    }
    Ok(GameexeExtractionReport {
        entry_count: u32::try_from(extraction.entries.len()).unwrap_or(u32::MAX),
        entries,
    })
}
