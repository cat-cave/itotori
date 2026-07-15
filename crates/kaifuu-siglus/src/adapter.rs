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
//! codec (those remain the `siglus-06` skeleton). Out-of-profile compression /
//! magic is a typed capability error, never a silent pass. No real retail Siglus
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

/// The spec-DAG node this adapter is authored for.
pub const ADAPTER_SOURCE_NODE_ID: &str = "KAIFUU-022";

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

// Pure Scene operations

/// Extract a profiled `Scene` container with the consumed resolved key.
pub fn extract_scene(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<SiglusSceneExtraction, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    extract_scene_with(&profile, container, key.material())
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))
}

/// Identity round-trip for a `Scene`: re-emit the unedited container and prove
/// it is byte-identical to the input.
pub fn roundtrip_identity_scene(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<IdentityRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    let layout = read_scene_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let reemitted = reemit_scene_records(&layout);
    identity_result(container, &reemitted)
}

/// Apply translated edits to a `Scene` and prove the round-trip: every edited
/// unit decodes to the new text, and every out-of-scope record survives
/// byte-identical. An in-profile failure is [`AdapterError::VerifyFailed`].
pub fn apply_scene_translation(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
    edits: &[SiglusTranslatedEdit],
) -> Result<TranslatedRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    if edits.is_empty() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip requires at least one edit".to_string(),
        });
    }
    let profile = variant.internal_profile(key);
    let material = key.material();

    // Original byte-exact record layout (still-encrypted).
    let original = read_scene_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;

    // Apply every edit, evolving the container.
    let mut current = container.to_vec();
    let mut edited_indices: BTreeSet<u32> = BTreeSet::new();
    let mut in_scope_changes = Vec::with_capacity(edits.len());
    for edit in edits {
        let target_index = parse_source_unit_index(&edit.target_key)
            .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        edited_indices.insert(target_index);
        current = patch_scene_unit_with(
            &profile,
            &current,
            &edit.target_key,
            &edit.translated_text,
            material,
        )
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        in_scope_changes.push(InScopeChange {
            target_key: edit.target_key.clone(),
            changed: false, // filled after verification below
            translated_text_hash: hash_text(&edit.translated_text)?,
        });
    }

    // Verify in-scope: re-extract and confirm each edited unit decodes to the
    // requested translation and differs from the original.
    let original_text = extract_scene_with(&profile, container, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let patched_text = extract_scene_with(&profile, &current, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    for (edit, change) in edits.iter().zip(in_scope_changes.iter_mut()) {
        let target_index = parse_source_unit_index(&edit.target_key)
            .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        let before = original_text
            .units
            .iter()
            .find(|unit| unit.unit_index == target_index);
        let after = patched_text
            .units
            .iter()
            .find(|unit| unit.unit_index == target_index);
        change.changed = matches!((before, after), (Some(before), Some(after))
            if after.text == edit.translated_text && before.text != edit.translated_text);
        if !change.changed {
            return Err(AdapterError::VerifyFailed {
                detail: format!("edit {} did not apply in scope", edit.target_key),
            });
        }
    }

    // Verify out-of-scope byte-identity at record granularity.
    let patched_layout = read_scene_record_layout(&profile, &current)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let out_of_scope_byte_identical =
        out_of_scope_scene_preserved(&original, &patched_layout, &edited_indices)?;
    let out_of_scope_record_count = original
        .records
        .iter()
        .filter(|(index, _)| !edited_indices.contains(index))
        .count() as u64;

    Ok(TranslatedRoundTrip {
        patched_hash: hash_bytes(&current)?,
        patched_bytes: current,
        in_scope_changes,
        out_of_scope_byte_identical,
        out_of_scope_record_count,
    })
}

/// Prove every out-of-scope `Scene` record is byte-identical and only edited
/// records changed. A structural drift (reorder / count / header change) is an
/// in-profile bug → [`AdapterError::VerifyFailed`].
fn out_of_scope_scene_preserved(
    original: &crate::known_key_smoke::SceneRecordLayout,
    patched: &crate::known_key_smoke::SceneRecordLayout,
    edited_indices: &BTreeSet<u32>,
) -> Result<bool, AdapterError> {
    if original.scene_id != patched.scene_id || original.compression != patched.compression {
        return Err(AdapterError::VerifyFailed {
            detail: "scene header changed across patch".to_string(),
        });
    }
    if original.records.len() != patched.records.len() {
        return Err(AdapterError::VerifyFailed {
            detail: "scene record count changed across patch".to_string(),
        });
    }
    for ((original_index, original_bytes), (patched_index, patched_bytes)) in
        original.records.iter().zip(patched.records.iter())
    {
        if original_index != patched_index {
            return Err(AdapterError::VerifyFailed {
                detail: "scene records reordered across patch".to_string(),
            });
        }
        let edited = edited_indices.contains(original_index);
        if edited {
            if original_bytes == patched_bytes {
                return Err(AdapterError::VerifyFailed {
                    detail: format!("edited unit {original_index} did not change bytes"),
                });
            }
        } else if original_bytes != patched_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

// Pure Gameexe operations

/// Extract a profiled `Gameexe` container with the consumed resolved key.
pub fn extract_gameexe(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<SiglusGameexeExtraction, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    extract_gameexe_with(&profile, container, key.material())
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))
}

/// Identity round-trip for a `Gameexe` container (byte-identical re-emit).
pub fn roundtrip_identity_gameexe(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<IdentityRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    let layout = read_gameexe_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let reemitted = reemit_gameexe_records(&layout);
    identity_result(container, &reemitted)
}

/// Apply translated edits to a `Gameexe` container and prove the round-trip:
/// each edited value decodes to the new text and every other entry survives
/// byte-identical.
pub fn apply_gameexe_translation(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
    edits: &[SiglusTranslatedEdit],
) -> Result<TranslatedRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    if edits.is_empty() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip requires at least one edit".to_string(),
        });
    }
    let profile = variant.internal_profile(key);
    let material = key.material();

    let original = read_gameexe_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;

    let mut current = container.to_vec();
    let mut edited_keys: BTreeSet<String> = BTreeSet::new();
    let mut in_scope_changes = Vec::with_capacity(edits.len());
    for edit in edits {
        edited_keys.insert(edit.target_key.clone());
        current = patch_gameexe_value_with(
            &profile,
            &current,
            &edit.target_key,
            &edit.translated_text,
            material,
        )
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        in_scope_changes.push(InScopeChange {
            target_key: edit.target_key.clone(),
            changed: false,
            translated_text_hash: hash_text(&edit.translated_text)?,
        });
    }

    // In-scope verify.
    let original_text = extract_gameexe_with(&profile, container, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let patched_text = extract_gameexe_with(&profile, &current, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    for (edit, change) in edits.iter().zip(in_scope_changes.iter_mut()) {
        let before = original_text
            .entries
            .iter()
            .find(|entry| entry.key == edit.target_key);
        let after = patched_text
            .entries
            .iter()
            .find(|entry| entry.key == edit.target_key);
        change.changed = matches!((before, after), (Some(before), Some(after))
            if after.value == edit.translated_text && before.value != edit.translated_text);
        if !change.changed {
            return Err(AdapterError::VerifyFailed {
                detail: format!("gameexe edit {} did not apply in scope", edit.target_key),
            });
        }
    }

    // Out-of-scope byte-identity: match entries by decoded key.
    let patched_layout = read_gameexe_record_layout(&profile, &current)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    if original.records.len() != patched_layout.records.len() {
        return Err(AdapterError::VerifyFailed {
            detail: "gameexe entry count changed across patch".to_string(),
        });
    }
    let mut out_of_scope_byte_identical = true;
    let mut out_of_scope_record_count = 0u64;
    for ((original_key_bytes, original_value_bytes), (patched_key_bytes, patched_value_bytes)) in
        original.records.iter().zip(patched_layout.records.iter())
    {
        if original_key_bytes != patched_key_bytes {
            return Err(AdapterError::VerifyFailed {
                detail: "gameexe entry key bytes changed across patch".to_string(),
            });
        }
        let decoded_key = original_text
            .entries
            .iter()
            .find(|entry| material.xor_cycle(original_key_bytes) == utf16le_encode(&entry.key))
            .map(|entry| entry.key.clone());
        let edited = decoded_key
            .as_deref()
            .is_some_and(|key| edited_keys.contains(key));
        if edited {
            if original_value_bytes == patched_value_bytes {
                return Err(AdapterError::VerifyFailed {
                    detail: "edited gameexe value did not change bytes".to_string(),
                });
            }
        } else {
            out_of_scope_record_count += 1;
            if original_value_bytes != patched_value_bytes {
                out_of_scope_byte_identical = false;
            }
        }
    }

    Ok(TranslatedRoundTrip {
        patched_hash: hash_bytes(&current)?,
        patched_bytes: current,
        in_scope_changes,
        out_of_scope_byte_identical,
        out_of_scope_record_count,
    })
}

// Reject-on-secret deep scan

/// A reject-on-secret finding (field/where only — never the leaked value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretLeakFinding {
    /// Where the leak was found (`output-bytes` / `report:<path>`).
    pub location: String,
    /// The class of leak (`raw-key` / `decrypted-text`).
    pub kind: String,
}

/// Deep-scan an about-to-be-written output container + its redacted report for
/// secret-shaped material: the raw key bytes, or any decrypted plaintext, must
/// NOT appear in either artifact. Returns findings (locations/kinds only). A
/// non-empty result means the write must be refused.
/// The plaintext probes are the in-memory decoded texts (original + translated);
/// they are NEVER persisted — only used here to prove they did not leak into the
/// output bytes (which hold only XOR-masked text) or the report (which holds only
/// hashes).
pub fn scan_for_secret_leak(
    key: &ResolvedSiglusKey,
    output_bytes: &[u8],
    report_json: &str,
    plaintext_probes: &[String],
) -> Vec<SecretLeakFinding> {
    let mut findings = Vec::new();

    // (1) Raw key must not appear in the output bytes.
    if key.material().appears_in(output_bytes) {
        findings.push(SecretLeakFinding {
            location: "output-bytes".to_string(),
            kind: "raw-key".to_string(),
        });
    }
    // (2) Raw key must not appear in the report bytes.
    if key.material().appears_in(report_json.as_bytes()) {
        findings.push(SecretLeakFinding {
            location: "report".to_string(),
            kind: "raw-key".to_string(),
        });
    }
    // (3) Decrypted plaintext must not appear (UTF-8 or UTF-16LE) in the output.
    for probe in plaintext_probes {
        if probe.is_empty() {
            continue;
        }
        let utf8 = probe.as_bytes();
        let utf16 = utf16le_encode(probe);
        if contains_window(output_bytes, utf8) || contains_window(output_bytes, &utf16) {
            findings.push(SecretLeakFinding {
                location: "output-bytes".to_string(),
                kind: "decrypted-text".to_string(),
            });
        }
        // The report is redacted and text-free; a raw probe string appearing in
        // it would be a redaction regression.
        if report_json.contains(probe.as_str()) {
            findings.push(SecretLeakFinding {
                location: "report".to_string(),
                kind: "decrypted-text".to_string(),
            });
        }
    }
    findings
}

fn contains_window(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// Report

/// The adapter capability descriptor: the mechanical facts, including
/// `does_key_discovery = false` and `broad_siglus_support = false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusAdapterCapability {
    pub capability_id: String,
    pub engine_family: String,
    /// Always `false`: never shells out.
    pub shells_out: bool,
    /// Always `false`: the adapter consumes a resolved key, never discovers one.
    pub does_key_discovery: bool,
    /// Always `true`: consumes a re-validated resolved key.
    pub consumes_resolved_key: bool,
    /// Always `false`: honest scope — narrow profiled support, not broad Siglus.
    pub broad_siglus_support: bool,
    pub encoding: SiglusKnownKeyEncoding,
    pub compression: SiglusKnownKeyCompression,
    pub redaction_status: HelperRedactionStatus,
    pub support_boundary: String,
}

impl SiglusAdapterCapability {
    fn for_variant(variant: &SiglusSupportedVariant) -> Self {
        Self {
            capability_id: ADAPTER_CAPABILITY_ID.to_string(),
            engine_family: "siglus".to_string(),
            shells_out: false,
            does_key_discovery: false,
            consumes_resolved_key: true,
            broad_siglus_support: false,
            encoding: variant.encoding,
            compression: variant.compression,
            redaction_status: HelperRedactionStatus::Redacted,
            support_boundary: ADAPTER_SUPPORT_BOUNDARY.to_string(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            capability_id: redact_for_log_or_report(&self.capability_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            shells_out: self.shells_out,
            does_key_discovery: self.does_key_discovery,
            consumes_resolved_key: self.consumes_resolved_key,
            broad_siglus_support: self.broad_siglus_support,
            encoding: self.encoding,
            compression: self.compression,
            redaction_status: self.redaction_status,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
        }
    }
}

/// The translated round-trip section of the report (counts + hashes, no text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedRoundTripReport {
    pub in_scope_changes: Vec<InScopeChange>,
    pub out_of_scope_byte_identical: bool,
    pub out_of_scope_record_count: u64,
    pub patched_container_hash: ProofHash,
    pub verified: bool,
}

/// The reject-on-secret section of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectOnSecretReport {
    /// Always `true`: the output + report were deep-scanned before write.
    pub deep_scan_performed: bool,
    /// Number of secret-leak findings (a persisted artifact always carries `0`;
    /// any finding refuses the write before anything is persisted).
    pub finding_count: u64,
    /// The number of plaintext probes checked against the output.
    pub plaintext_probes_checked: u64,
}

/// The redacted adapter patch report (committed as proof). Never carries raw key
/// material or decrypted text — only secret-refs, one-way hashes, and counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterPatchReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub variant_id: String,
    /// The container kind that was patched (`scene` / `gameexe`).
    pub container_kind: String,
    pub secret_ref: SecretRef,
    /// The consumed validation proof (re-checked before use).
    pub key_validation: KeyValidationProof,
    /// One-way commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    pub key_material_kind: KeyMaterialKind,
    pub redaction_status: HelperRedactionStatus,
    pub capability: SiglusAdapterCapability,
    pub identity: IdentityRoundTrip,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_extraction: Option<SceneExtractionReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gameexe_extraction: Option<GameexeExtractionReport>,
    pub translation: TranslatedRoundTripReport,
    pub reject_on_secret: RejectOnSecretReport,
    pub status: OperationStatus,
}

impl AdapterPatchReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            variant_id: redact_for_log_or_report(&self.variant_id),
            container_kind: self.container_kind.clone(),
            secret_ref: self.secret_ref.clone(),
            key_validation: self.key_validation.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            capability: self.capability.redacted_for_report(),
            identity: self.identity.clone(),
            scene_extraction: self.scene_extraction.clone(),
            gameexe_extraction: self.gameexe_extraction.clone(),
            translation: self.translation.clone(),
            reject_on_secret: self.reject_on_secret.clone(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no text).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// FS-owning patch-back driver (reject-before-write)

/// Which profiled container a patch targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusContainerKind {
    Scene,
    Gameexe,
}

impl SiglusContainerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Gameexe => "gameexe",
        }
    }
}

/// Filesystem-owning patch-back: read the profiled container at `input_path`,
/// apply the translated edits, VERIFY the round-trip, deep-scan for secret
/// leaks, and only then atomically write the patched container to `output_path`
/// (and the redacted report to `report_path`, if given).
/// Reject-before-write ordering (nothing is written until all pass):
/// 1. capability gate (unsupported variant → `Err`, no write),
/// 2. read input,
/// 3. identity round-trip + translated round-trip + verify (in-profile failure →
///    `Err`, no write),
/// 4. reject-on-secret deep scan (leak → `Err`, no write),
/// 5. atomic write of output + report.
pub fn patch_container_file(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    kind: SiglusContainerKind,
    input_path: &Path,
    output_path: &Path,
    report_path: Option<&Path>,
    edits: &[SiglusTranslatedEdit],
) -> Result<AdapterPatchReport, AdapterError> {
    // (1) Capability gate BEFORE touching the filesystem.
    variant.ensure_supported()?;

    // (2) Read input.
    let container = std::fs::read(input_path).map_err(|error| AdapterError::Io {
        detail: format!("reading input container: {error}"),
    })?;

    // (3) Identity + translated round-trips + verify (in-memory).
    let (identity, translation, scene_report, gameexe_report, plaintext_probes) = match kind {
        SiglusContainerKind::Scene => {
            let identity = roundtrip_identity_scene(variant, key, &container)?;
            let extraction = extract_scene(variant, key, &container)?;
            let translation = apply_scene_translation(variant, key, &container, edits)?;
            let probes = scene_plaintext_probes(&extraction, edits);
            let report = scene_extraction_report(&extraction)?;
            (identity, translation, Some(report), None, probes)
        }
        SiglusContainerKind::Gameexe => {
            let identity = roundtrip_identity_gameexe(variant, key, &container)?;
            let extraction = extract_gameexe(variant, key, &container)?;
            let translation = apply_gameexe_translation(variant, key, &container, edits)?;
            let probes = gameexe_plaintext_probes(&extraction, edits);
            let report = gameexe_extraction_report(&extraction)?;
            (identity, translation, None, Some(report), probes)
        }
    };

    if !identity.byte_identical {
        return Err(AdapterError::VerifyFailed {
            detail: "identity round-trip was not byte-identical".to_string(),
        });
    }
    if !translation.verified() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip did not verify (in-scope change or out-of-scope preservation failed)"
                .to_string(),
        });
    }

    // Build the redacted report body.
    let mut report = AdapterPatchReport {
        schema_version: ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: ADAPTER_SOURCE_NODE_ID.to_string(),
        engine_family: "siglus".to_string(),
        support_boundary: ADAPTER_SUPPORT_BOUNDARY.to_string(),
        variant_id: variant.variant_id.clone(),
        container_kind: kind.as_str().to_string(),
        secret_ref: key.secret_ref().clone(),
        key_validation: key.validation().clone(),
        key_material_hash: key
            .material_hash()
            .map_err(|error| AdapterError::Internal {
                message: format!("key commitment: {error}"),
            })?,
        key_bytes: u32::try_from(key.key_byte_len()).unwrap_or(u32::MAX),
        key_material_kind: key.material_kind,
        redaction_status: HelperRedactionStatus::Redacted,
        capability: SiglusAdapterCapability::for_variant(variant),
        identity,
        scene_extraction: scene_report,
        gameexe_extraction: gameexe_report,
        translation: TranslatedRoundTripReport {
            in_scope_changes: translation.in_scope_changes.clone(),
            out_of_scope_byte_identical: translation.out_of_scope_byte_identical,
            out_of_scope_record_count: translation.out_of_scope_record_count,
            patched_container_hash: translation.patched_hash.clone(),
            verified: translation.verified(),
        },
        reject_on_secret: RejectOnSecretReport {
            deep_scan_performed: true,
            finding_count: 0,
            plaintext_probes_checked: plaintext_probes.len() as u64,
        },
        status: OperationStatus::Passed,
    };

    // (4) Reject-on-secret deep scan of the ABOUT-TO-BE-WRITTEN artifacts.
    let report_json = report
        .stable_json()
        .map_err(|error| AdapterError::Internal {
            message: format!("report serialization: {error}"),
        })?;
    let findings = scan_for_secret_leak(
        key,
        &translation.patched_bytes,
        &report_json,
        &plaintext_probes,
    );
    if !findings.is_empty() {
        return Err(AdapterError::SecretLeak {
            finding_count: findings.len() as u64,
            first_finding: format!("{}:{}", findings[0].location, findings[0].kind),
        });
    }

    // (5) Atomic writes — output first, then the redacted report.
    atomic_write_bytes(output_path, &translation.patched_bytes).map_err(|error| {
        AdapterError::Io {
            detail: format!("writing patched output: {error}"),
        }
    })?;
    if let Some(report_path) = report_path {
        // Re-serialize post-scan (identical content) and write.
        atomic_write_text(report_path, &report_json).map_err(|error| AdapterError::Io {
            detail: format!("writing report: {error}"),
        })?;
    }

    report.reject_on_secret.finding_count = 0;
    Ok(report)
}

// Profiled fixture builders (encode with a resolved key — no retail bytes)

/// Build a profiled `Scene` container by masking each unit's UTF-16LE text with
/// the resolved key. Fixture support: the bytes it produces round-trip through
/// the adapter's own reader (proving the codec is symmetric); no retail bytes.
pub fn build_profiled_scene_container(
    key: &ResolvedSiglusKey,
    scene_id: u32,
    units: &[(u32, &str)],
) -> Vec<u8> {
    let records = units
        .iter()
        .map(|(unit_index, text)| (*unit_index, key.material().xor_cycle(&utf16le_encode(text))))
        .collect();
    reemit_scene_records(&SceneRecordLayout {
        scene_id,
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

/// Build a profiled `Gameexe` container by masking each key/value with the
/// resolved key.
pub fn build_profiled_gameexe_container(
    key: &ResolvedSiglusKey,
    entries: &[(&str, &str)],
) -> Vec<u8> {
    let records = entries
        .iter()
        .map(|(config_key, value)| {
            (
                key.material().xor_cycle(&utf16le_encode(config_key)),
                key.material().xor_cycle(&utf16le_encode(value)),
            )
        })
        .collect();
    reemit_gameexe_records(&GameexeRecordLayout {
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

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
