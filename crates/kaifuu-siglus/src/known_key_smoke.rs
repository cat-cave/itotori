//! Siglus **known-key** Scene/Gameexe extract-patch-verify smoke.
//! This module lands a **narrow, honestly-scoped** known-key Siglus smoke: for
//! a single declared [`SiglusKnownKeyProfile`] it extracts profiled `Scene` /
//! `Gameexe` text + metadata, applies a trivial translated patch, and verifies
//! the round-trip — WITHOUT claiming broad Siglus compatibility. The full
//! `Scene.pck` / `Gameexe.dat` stack ([`crate::archive`], [`crate::decrypt`],
//! [`crate::decompress`], [`crate::gameexe`], [`crate::patchback`]) stays a
//! typed skeleton stub; this module does not alias around it or fake success on
//! its behalf.
//! # What "narrow known-key profile" means (the honesty line)
//! - The profile declares its crypto as a **constant key XOR** cycled over the
//!   text payloads — the same profiled transform 's static-key
//!   fixture uses ([`kaifuu_core::build_siglus_static_key_stub`]). It is NOT the
//!   real Siglus constant-256-byte-XOR-table + per-game second-layer strip
//!   (that lands in `siglus-04`/`siglus-06` against real bytes). The profile
//!   says so out loud.
//! - The profile declares its compression as
//!   [`SiglusKnownKeyCompression::Uncompressed`]. A payload flagged
//!   [`SiglusKnownKeyCompression::Lzss`] (or any other out-of-profile case) is
//!   returned as a typed [`KnownKeySmokeError::OutOfProfileCompression`]
//!   `not_implemented` — never a silent pass, and never an over-claim of
//!   proprietary-LZSS support.
//! - Raw key material lives ONLY inside the module-private, zeroize-on-drop,
//!   `Debug`-redacting [`KnownKeyMaterial`] holder. It is never serialized,
//!   logged, written to disk, or returned across the module boundary. The
//!   report carries a structured **secret-ref + one-way sha256 commitments +
//!   counts** only.
//! - No retail bytes: the committed fixture materialises a clearly-fake
//!   synthetic `Scene`/`Gameexe` container in-process from in-module constants.
//!   The optional local-file container source reads scoped private bytes
//!   in-process (never shelled out to) but still surfaces only refs + hashes.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, redact_for_log_or_report,
    secret_holder::{SecretRefSecretResolver, ZeroizingSecretBytes},
    sha256_hash_bytes, stable_json,
};

/// Schema version of the known-key smoke fixture + report.
pub const KNOWN_KEY_SMOKE_SCHEMA_VERSION: &str = "0.1.0";

/// The canonical narrow-profile capability id.
pub const KNOWN_KEY_SMOKE_CAPABILITY_ID: &str = "kaifuu-siglus-knownkey-smoke";

/// The support boundary surfaced in every known-key smoke report. Deliberately
/// blunt about the narrow scope so nothing downstream can read this as broad
/// Siglus coverage.
pub const KNOWN_KEY_SMOKE_SUPPORT_BOUNDARY: &str = "Kaifuu Siglus known-key smoke is a NARROW, profiled Scene/Gameexe extract-patch-verify demonstration for a single declared known-key profile: constant-key-XOR text payloads, UTF-16LE, uncompressed-within-profile only. It is NOT broad Siglus Scene.pck/Gameexe.dat support: the real constant-256-XOR-table + per-game second-layer strip and proprietary-LZSS codec remain skeleton stubs (siglus-04/siglus-06). Out-of-profile compression or magic is a typed not_implemented, never a silent pass. Raw key material is never logged, serialized, or written to disk; the report carries secret-refs + one-way proof hashes + counts only.";

// A narrow, self-describing container. The structural header is plaintext (the
// analogue of a readable Siglus SceneList); only the text payloads are
// key-XOR-masked, so the profile can walk the directory before decrypting text.
// Scene: <14B magic><u8 compression><u32 sceneId><u32 unitCount>
// unitCount * { <u32 unitIndex><u32 textByteLen><XOR(utf16le text)> }
// Gameexe: <14B magic><u8 compression><u32 entryCount>
// entryCount * { <u32 keyLen><XOR(utf16le key)>
// <u32 valLen><XOR(utf16le value)> }

const SCENE_SMOKE_MAGIC: &[u8; 14] = b"KSIG-SCN-SMOKE";
const GAMEEXE_SMOKE_MAGIC: &[u8; 14] = b"KSIG-GXE-SMOKE";

/// The synthetic, clearly-fake known key the fixture masks its text with. This
/// is fixture material, never a retail key; it is the only place raw key bytes
/// exist, and they never leave [`KnownKeyMaterial`].
const SYNTHETIC_KNOWN_KEY: &[u8; 16] = b"KSIG-SMOKE-KEY01";
const SYNTHETIC_KNOWN_KEY_SECRET_REF: &str = "local-secret:siglus-known-key-smoke-fixture";

/// On-wire compression flag byte for the uncompressed-within-profile case.
const COMPRESSION_UNCOMPRESSED: u8 = 0;
/// On-wire compression flag byte for the out-of-profile proprietary-LZSS case.
const COMPRESSION_LZSS: u8 = 1;

/// Synthetic scene id the fixture stub emits.
const FIXTURE_SCENE_ID: u32 = 1;

/// Clearly-synthetic source dialogue units (obviously fixture text, authored
/// here — not extracted from any game).
const FIXTURE_SCENE_UNITS: &[&str] = &[
    "[synthetic-siglus-dialogue-unit-0]",
    "[synthetic-siglus-dialogue-unit-1]",
    "[synthetic-siglus-choice-label-2]",
];

/// Clearly-synthetic `Gameexe.dat` key/value lines (structural config keys +
/// obviously-fixture values).
const FIXTURE_GAMEEXE_ENTRIES: &[(&str, &str)] = &[
    ("#NAMAE.000", "[synthetic-speaker-0]"),
    ("#NAMAE.001", "[synthetic-speaker-1]"),
    ("#WINDOW.000.NAME", "[synthetic-window-0]"),
];

/// Text encoding declared by a known-key profile. Siglus text is UTF-16LE; the
/// profile makes it explicit (no silent default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum SiglusKnownKeyEncoding {
    /// UTF-16LE (the only in-profile encoding).
    Utf16Le,
}

/// Compression declared by (or observed in) a known-key profile payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum SiglusKnownKeyCompression {
    /// Uncompressed-within-profile — the only case this narrow smoke handles.
    Uncompressed,
    /// Proprietary Siglus LZSS — explicitly **out of profile** here. The real
    /// codec is the `siglus-06` skeleton; the smoke returns a typed
    /// `not_implemented` for it rather than over-claiming support.
    Lzss,
}

impl SiglusKnownKeyCompression {
    /// Stable lowercase label for reports / diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uncompressed => "uncompressed",
            Self::Lzss => "lzss",
        }
    }

    fn from_wire(flag: u8) -> Option<Self> {
        match flag {
            COMPRESSION_UNCOMPRESSED => Some(Self::Uncompressed),
            COMPRESSION_LZSS => Some(Self::Lzss),
            _ => None,
        }
    }
}

/// Where a profile's container bytes come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum SiglusKnownKeyContainerSource {
    /// Materialise the synthetic profiled container in-process (public CI).
    SyntheticStub,
    /// Read a scoped local container file in-process (never shelled out to).
    /// Path is relative to the fixture directory.
    LocalFile {
        /// Relative path to the scoped local container.
        path: String,
    },
}

/// The narrow known-key profile a smoke runs against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusKnownKeyProfile {
    /// Stable per-profile id (redacted in the report).
    pub profile_id: String,
    /// Structured secret-ref the known key is published under. NEVER raw key
    /// material — the raw bytes are resolved in-process and held only inside
    /// [`KnownKeyMaterial`].
    pub secret_ref: SecretRef,
    /// Declared text encoding.
    pub encoding: SiglusKnownKeyEncoding,
    /// Declared in-profile compression. Anything else is out of profile.
    pub compression: SiglusKnownKeyCompression,
    /// Where the `Scene` container bytes come from.
    pub scene_source: SiglusKnownKeyContainerSource,
    /// Where the `Gameexe` container bytes come from.
    pub gameexe_source: SiglusKnownKeyContainerSource,
}

/// The resolved known-key bytes. Raw material is crate-private, never
/// serialized, redacted in `Debug`, and zeroized on drop. Nothing public
/// returns or logs these bytes.
/// The pure adapter ([`crate::adapter`]) reuses this holder as the
/// single place raw key bytes ever live: it constructs one via
/// a shared [`ZeroizingSecretBytes`] holder from an *already-resolved* secret
/// ref (the adapter never does key discovery) and passes it to the key-injected
/// `*_with` primitives below.
pub(crate) struct KnownKeyMaterial {
    holder: ZeroizingSecretBytes,
}

impl KnownKeyMaterial {
    pub(crate) fn from_holder(holder: ZeroizingSecretBytes) -> Self {
        Self { holder }
    }

    pub(crate) fn byte_len(&self) -> usize {
        self.holder.byte_len()
    }

    /// One-way sha256 commitment to the key bytes (never the bytes themselves).
    pub(crate) fn material_hash(&self) -> KaifuuResult<ProofHash> {
        Ok(ProofHash::new(self.holder.sha256_material_hash())?)
    }

    pub(crate) fn xor_cycle(&self, data: &[u8]) -> Vec<u8> {
        self.holder.apply_xor_filter(data, None, false, 0)
    }

    /// Reject-on-secret probe: does the raw key material appear as a contiguous
    /// byte window inside `haystack`? Used to refuse writing any artifact that
    /// would leak the key. Returns only a boolean — never the bytes.
    pub(crate) fn appears_in(&self, haystack: &[u8]) -> bool {
        self.holder.appears_in(haystack)
    }
}

impl std::fmt::Debug for KnownKeyMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KnownKeyMaterial")
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .field("byte_len", &self.holder.byte_len())
            .finish()
    }
}

fn known_key_material_from_resolved_secret(
    secret_ref: &SecretRef,
    raw_material: Vec<u8>,
) -> KnownKeyMaterial {
    let holder = SecretRefSecretResolver::from_entries(vec![(
        secret_ref.as_str().to_string(),
        raw_material,
    )])
    .into_resolved(secret_ref)
    .expect("newly inserted Siglus key must resolve by its SecretRef");
    KnownKeyMaterial::from_holder(holder)
}

/// Resolve the profile's known key to in-process material.
/// For the narrow smoke this is the synthetic fixture key (never persisted). In
/// a real scoped run this seam is where the validated key-ref would
/// be consumed; either way the raw bytes never cross this boundary except
/// inside [`KnownKeyMaterial`].
fn resolve_known_key(profile: &SiglusKnownKeyProfile) -> KnownKeyMaterial {
    known_key_material_from_resolved_secret(&profile.secret_ref, SYNTHETIC_KNOWN_KEY.to_vec())
}

/// A single extracted scene text unit. `text` is decoded UTF-8 held in memory
/// for the caller/patcher; it is NEVER placed in the serialized report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusSceneUnit {
    /// Unit index within the scene.
    pub unit_index: u32,
    /// Canonical source-unit key (`siglus:scene-NNNN#OOOO`).
    pub source_unit_key: String,
    /// Decoded unit text (in-memory only).
    pub text: String,
}

/// Extracted profiled `Scene` container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusSceneExtraction {
    /// `SceneList` scene id.
    pub scene_id: u32,
    /// Extracted text units in on-disk order.
    pub units: Vec<SiglusSceneUnit>,
}

/// A single extracted `Gameexe` key/value pair (text held in memory only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusGameexeEntry {
    /// Configuration key (structural).
    pub key: String,
    /// Value text (in-memory only).
    pub value: String,
}

/// Extracted profiled `Gameexe` container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusGameexeExtraction {
    /// Extracted entries in on-disk order.
    pub entries: Vec<SiglusGameexeEntry>,
}

/// Fatal errors raised by the known-key smoke. Every variant's `Display` begins
/// with the [`crate::SIGLUS_UNIMPLEMENTED_MARKER`] namespace so an audit can pin
/// the honest-scope contract.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum KnownKeySmokeError {
    /// The payload's compression is outside the declared narrow profile. This
    /// is the honest not-implemented boundary — the smoke refuses to fake
    /// proprietary-LZSS support (that codec is the `siglus-06` skeleton).
    #[error(
        "kaifuu.siglus.known_key_smoke.out_of_profile_compression_not_implemented: profile \
         {profile_id} declares in-profile compression {declared}, but the container is flagged \
         {observed}; the narrow known-key smoke does not implement it (real proprietary-LZSS is \
         the siglus-06 skeleton)"
    )]
    OutOfProfileCompression {
        /// Profile id whose scope was exceeded.
        profile_id: String,
        /// Declared in-profile compression.
        declared: &'static str,
        /// Observed out-of-profile compression.
        observed: &'static str,
    },
    /// The container magic did not match the profiled format.
    #[error(
        "kaifuu.siglus.known_key_smoke.bad_magic: container does not carry the expected profiled \
         {expected} magic"
    )]
    BadMagic {
        /// Human label of the expected container kind.
        expected: &'static str,
    },
    /// The container was truncated before a declared field.
    #[error(
        "kaifuu.siglus.known_key_smoke.truncated: profiled container truncated at byte \
         {byte_offset} (needed {needed} more bytes)"
    )]
    Truncated {
        /// Byte offset where decode ran out of input.
        byte_offset: usize,
        /// Bytes that were still required.
        needed: usize,
    },
    /// A text payload was not valid UTF-16LE.
    #[error(
        "kaifuu.siglus.known_key_smoke.invalid_utf16le: text payload is not valid UTF-16LE at \
         byte {byte_offset}"
    )]
    InvalidUtf16Le {
        /// Byte offset of the invalid unit within the container.
        byte_offset: usize,
    },
    /// A source-unit key did not parse as `siglus:scene-NNNN#OOOO`.
    #[error(
        "kaifuu.siglus.known_key_smoke.bad_unit_key: source-unit key {source_unit_key} is malformed"
    )]
    BadUnitKey {
        /// The malformed key.
        source_unit_key: String,
    },
    /// The patch target unit was not present in the scene.
    #[error(
        "kaifuu.siglus.known_key_smoke.unit_not_found: patch target {source_unit_key} does not \
         match any scene unit"
    )]
    UnitNotFound {
        /// The unresolved target key.
        source_unit_key: String,
    },
    /// The patch round-trip failed verification.
    #[error("kaifuu.siglus.known_key_smoke.verify_mismatch: {detail}")]
    VerifyMismatch {
        /// What did not match.
        detail: String,
    },
    /// An internal proof/serialization failure (redacted).
    #[error("kaifuu.siglus.known_key_smoke.internal: {message}")]
    Internal {
        /// Redacted internal detail.
        message: String,
    },
}

/// Extract the profiled `Scene` container's text units + metadata using the
/// profile's known key.
/// Returns [`KnownKeySmokeError::OutOfProfileCompression`] (typed
/// not-implemented) if the container is flagged with an out-of-profile
/// compression — the smoke does not fabricate a decompressor.
pub fn extract_scene(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
) -> Result<SiglusSceneExtraction, KnownKeySmokeError> {
    extract_scene_with(profile, container, &resolve_known_key(profile))
}

/// Key-injected [`extract_scene`]: identical parse, but the caller supplies the
/// already-resolved key material instead of the module resolving it. This is the
/// seam the pure adapter consumes — it separates parsing from key
/// discovery (the adapter never discovers keys; it is handed a resolved one).
pub(crate) fn extract_scene_with(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    key: &KnownKeyMaterial,
) -> Result<SiglusSceneExtraction, KnownKeySmokeError> {
    let mut reader = Reader::new(container);
    reader.expect_magic(SCENE_SMOKE_MAGIC, "Scene")?;
    check_in_profile(profile, &mut reader)?;

    let scene_id = reader.u32()?;
    let unit_count = reader.u32()?;

    let mut units = Vec::with_capacity(unit_count as usize);
    for _ in 0..unit_count {
        let unit_index = reader.u32()?;
        let text = reader.encrypted_utf16le(key)?;
        units.push(SiglusSceneUnit {
            source_unit_key: source_unit_key(scene_id, unit_index),
            unit_index,
            text,
        });
    }
    Ok(SiglusSceneExtraction { scene_id, units })
}

/// The byte-exact record layout of a profiled `Scene` container: the header
/// scalars plus each unit's *still-encrypted* payload slice, in on-disk order.
/// The adapter uses this to prove identity round-trips (re-emit == input,
/// byte-identical) and out-of-scope byte-identity (every non-edited unit's
/// encrypted bytes survive unchanged) WITHOUT ever decrypting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SceneRecordLayout {
    pub(crate) scene_id: u32,
    pub(crate) compression: SiglusKnownKeyCompression,
    /// `(unit_index, still-encrypted payload bytes)` in on-disk order.
    pub(crate) records: Vec<(u32, Vec<u8>)>,
}

/// Read a profiled `Scene` container into its byte-exact [`SceneRecordLayout`]
/// without decrypting any text. Out-of-profile compression is the usual typed
/// not-implemented.
pub(crate) fn read_scene_record_layout(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
) -> Result<SceneRecordLayout, KnownKeySmokeError> {
    let mut reader = Reader::new(container);
    reader.expect_magic(SCENE_SMOKE_MAGIC, "Scene")?;
    check_in_profile(profile, &mut reader)?;
    let scene_id = reader.u32()?;
    let unit_count = reader.u32()?;
    let mut records = Vec::with_capacity(unit_count as usize);
    for _ in 0..unit_count {
        let unit_index = reader.u32()?;
        let encrypted = reader.encrypted_slice()?.to_vec();
        records.push((unit_index, encrypted));
    }
    Ok(SceneRecordLayout {
        scene_id,
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

/// Re-emit a profiled `Scene` container from a byte-exact record layout. Feeding
/// back an untouched [`read_scene_record_layout`] result reproduces the input
/// byte-for-byte (the identity round-trip the adapter proves).
pub(crate) fn reemit_scene_records(layout: &SceneRecordLayout) -> Vec<u8> {
    build_scene_container(layout.scene_id, layout.compression, &layout.records)
}

/// Extract the profiled `Gameexe` container's key/value inventory using the
/// profile's known key. Out-of-profile compression is a typed not-implemented.
pub fn extract_gameexe(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
) -> Result<SiglusGameexeExtraction, KnownKeySmokeError> {
    extract_gameexe_with(profile, container, &resolve_known_key(profile))
}

/// Key-injected [`extract_gameexe`] (see [`extract_scene_with`]).
pub(crate) fn extract_gameexe_with(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    key: &KnownKeyMaterial,
) -> Result<SiglusGameexeExtraction, KnownKeySmokeError> {
    let mut reader = Reader::new(container);
    reader.expect_magic(GAMEEXE_SMOKE_MAGIC, "Gameexe")?;
    check_in_profile(profile, &mut reader)?;

    let entry_count = reader.u32()?;

    let mut entries = Vec::with_capacity(entry_count as usize);
    for _ in 0..entry_count {
        let key_text = reader.encrypted_utf16le(key)?;
        let value_text = reader.encrypted_utf16le(key)?;
        entries.push(SiglusGameexeEntry {
            key: key_text,
            value: value_text,
        });
    }
    Ok(SiglusGameexeExtraction { entries })
}

/// Enforce the declared in-profile compression: an out-of-profile flag is a
/// typed not-implemented, never a silent pass.
fn check_in_profile(
    profile: &SiglusKnownKeyProfile,
    reader: &mut Reader<'_>,
) -> Result<(), KnownKeySmokeError> {
    let flag = reader.u8()?;
    let observed = SiglusKnownKeyCompression::from_wire(flag).ok_or_else(|| {
        KnownKeySmokeError::OutOfProfileCompression {
            profile_id: profile.profile_id.clone(),
            declared: profile.compression.as_str(),
            observed: "unknown",
        }
    })?;
    if observed != profile.compression || observed != SiglusKnownKeyCompression::Uncompressed {
        return Err(KnownKeySmokeError::OutOfProfileCompression {
            profile_id: profile.profile_id.clone(),
            declared: profile.compression.as_str(),
            observed: observed.as_str(),
        });
    }
    Ok(())
}

/// Apply a trivial translated change to a single scene unit and return the
/// re-emitted profiled `Scene` container.
/// Only the target unit's encrypted text payload + its length are rewritten;
/// every other unit's directory record and encrypted bytes are preserved
/// byte-identical. The result is self-checked by re-extraction inside
/// [`verify_scene_patch`]; callers should route through
/// [`patch_and_verify_scene`].
pub fn patch_scene_unit(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    target_source_unit_key: &str,
    translated_text: &str,
) -> Result<Vec<u8>, KnownKeySmokeError> {
    patch_scene_unit_with(
        profile,
        container,
        target_source_unit_key,
        translated_text,
        &resolve_known_key(profile),
    )
}

/// Key-injected [`patch_scene_unit`] (see [`extract_scene_with`]).
pub(crate) fn patch_scene_unit_with(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    target_source_unit_key: &str,
    translated_text: &str,
    key: &KnownKeyMaterial,
) -> Result<Vec<u8>, KnownKeySmokeError> {
    let (_, target_index) = parse_source_unit_key(target_source_unit_key)?;

    // Parse the existing container into (unit_index, original encrypted text
    // bytes) so non-target units survive byte-identical.
    let mut reader = Reader::new(container);
    reader.expect_magic(SCENE_SMOKE_MAGIC, "Scene")?;
    check_in_profile(profile, &mut reader)?;
    let scene_id = reader.u32()?;
    let unit_count = reader.u32()?;

    let mut records: Vec<(u32, Vec<u8>)> = Vec::with_capacity(unit_count as usize);
    let mut matched = false;
    for _ in 0..unit_count {
        let unit_index = reader.u32()?;
        let original_encrypted = reader.encrypted_slice()?.to_vec();
        if unit_index == target_index {
            let encrypted = key.xor_cycle(&utf16le_encode(translated_text));
            records.push((unit_index, encrypted));
            matched = true;
        } else {
            records.push((unit_index, original_encrypted));
        }
    }
    if !matched {
        return Err(KnownKeySmokeError::UnitNotFound {
            source_unit_key: target_source_unit_key.to_string(),
        });
    }

    Ok(build_scene_container(
        scene_id,
        SiglusKnownKeyCompression::Uncompressed,
        &records,
    ))
}

/// The verified result of a trivial patch round-trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenePatchVerification {
    /// The patched target unit key.
    pub target_source_unit_key: String,
    /// `true` iff the target unit now decodes to the translated text.
    pub target_changed: bool,
    /// `true` iff every non-target unit decodes byte-identical to the original.
    pub other_units_preserved: bool,
    /// sha256 over the re-emitted container bytes (round-trip proof).
    pub patched_container_hash: ProofHash,
}

impl ScenePatchVerification {
    /// Whether the patch fully verified.
    pub fn verified(&self) -> bool {
        self.target_changed && self.other_units_preserved
    }
}

/// Patch a trivial translated change AND verify it round-trips: the target unit
/// changed to the translated text, and every other unit is preserved. Returns
/// the patched container bytes alongside the verification.
pub fn patch_and_verify_scene(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    target_source_unit_key: &str,
    translated_text: &str,
) -> Result<(Vec<u8>, ScenePatchVerification), KnownKeySmokeError> {
    patch_and_verify_scene_with(
        profile,
        container,
        target_source_unit_key,
        translated_text,
        &resolve_known_key(profile),
    )
}

/// Key-injected [`patch_and_verify_scene`] (see [`extract_scene_with`]). The
/// adapter routes translated round-trips through this so the resolved
/// key is threaded end-to-end (patch, re-extract, verify) with no hidden
/// re-resolution.
pub(crate) fn patch_and_verify_scene_with(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    target_source_unit_key: &str,
    translated_text: &str,
    key: &KnownKeyMaterial,
) -> Result<(Vec<u8>, ScenePatchVerification), KnownKeySmokeError> {
    let original = extract_scene_with(profile, container, key)?;
    let patched_bytes = patch_scene_unit_with(
        profile,
        container,
        target_source_unit_key,
        translated_text,
        key,
    )?;
    let verification = verify_scene_patch(
        profile,
        &original,
        &patched_bytes,
        target_source_unit_key,
        translated_text,
        key,
    )?;
    if !verification.verified() {
        return Err(KnownKeySmokeError::VerifyMismatch {
            detail: format!(
                "patch round-trip did not verify: target_changed={}, other_units_preserved={}",
                verification.target_changed, verification.other_units_preserved
            ),
        });
    }
    Ok((patched_bytes, verification))
}

fn verify_scene_patch(
    profile: &SiglusKnownKeyProfile,
    original: &SiglusSceneExtraction,
    patched_bytes: &[u8],
    target_source_unit_key: &str,
    translated_text: &str,
    key: &KnownKeyMaterial,
) -> Result<ScenePatchVerification, KnownKeySmokeError> {
    let (_, target_index) = parse_source_unit_key(target_source_unit_key)?;
    let patched = extract_scene_with(profile, patched_bytes, key)?;

    if patched.units.len() != original.units.len() {
        return Err(KnownKeySmokeError::VerifyMismatch {
            detail: "unit count changed across patch".to_string(),
        });
    }

    let mut target_changed = false;
    let mut other_units_preserved = true;
    for (before, after) in original.units.iter().zip(patched.units.iter()) {
        if before.unit_index != after.unit_index {
            other_units_preserved = false;
            continue;
        }
        if after.unit_index == target_index {
            // The target must now carry the translation AND actually differ
            // from the source (a no-op "change" would be a fake pass).
            target_changed = after.text == translated_text && before.text != translated_text;
        } else if before.text != after.text {
            other_units_preserved = false;
        }
    }

    Ok(ScenePatchVerification {
        target_source_unit_key: target_source_unit_key.to_string(),
        target_changed,
        other_units_preserved,
        patched_container_hash: ProofHash::new(sha256_hash_bytes(patched_bytes))
            .map_err(|error| KnownKeySmokeError::Internal { message: error })?,
    })
}

/// Build the synthetic profiled `Scene` container (uncompressed-within-profile).
pub fn build_synthetic_scene_fixture() -> Vec<u8> {
    let key = known_key_material_from_resolved_secret(
        &SecretRef::new(SYNTHETIC_KNOWN_KEY_SECRET_REF)
            .expect("static synthetic secret ref is valid"),
        SYNTHETIC_KNOWN_KEY.to_vec(),
    );
    let records: Vec<(u32, Vec<u8>)> = FIXTURE_SCENE_UNITS
        .iter()
        .enumerate()
        .map(|(index, text)| {
            (
                u32::try_from(index).expect("fixture unit count fits in u32"),
                key.xor_cycle(&utf16le_encode(text)),
            )
        })
        .collect();
    build_scene_container(
        FIXTURE_SCENE_ID,
        SiglusKnownKeyCompression::Uncompressed,
        &records,
    )
}

/// Build a synthetic `Scene` container flagged with the **out-of-profile**
/// proprietary-LZSS compression, used to exercise the typed not-implemented
/// boundary. Its body is deliberately opaque: the profile refuses it before any
/// decode, so there is no fabricated LZSS stream here.
pub fn build_synthetic_out_of_profile_scene_fixture() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(SCENE_SMOKE_MAGIC);
    bytes.push(COMPRESSION_LZSS);
    bytes.extend_from_slice(b"...out-of-profile-lzss-body-not-decoded...");
    bytes
}

/// Build the synthetic profiled `Gameexe` container.
pub fn build_synthetic_gameexe_fixture() -> Vec<u8> {
    let key = known_key_material_from_resolved_secret(
        &SecretRef::new(SYNTHETIC_KNOWN_KEY_SECRET_REF)
            .expect("static synthetic secret ref is valid"),
        SYNTHETIC_KNOWN_KEY.to_vec(),
    );
    let records: Vec<(Vec<u8>, Vec<u8>)> = FIXTURE_GAMEEXE_ENTRIES
        .iter()
        .map(|(config_key, value)| {
            (
                key.xor_cycle(&utf16le_encode(config_key)),
                key.xor_cycle(&utf16le_encode(value)),
            )
        })
        .collect();
    build_gameexe_container(SiglusKnownKeyCompression::Uncompressed, &records)
}

/// The byte-exact record layout of a profiled `Gameexe` container: each
/// entry's *still-encrypted* key + value slices in on-disk order. Feeding an
/// untouched layout back through [`reemit_gameexe_records`] reproduces the input
/// byte-for-byte (the Gameexe identity round-trip).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GameexeRecordLayout {
    pub(crate) compression: SiglusKnownKeyCompression,
    /// `(still-encrypted key bytes, still-encrypted value bytes)` per entry.
    pub(crate) records: Vec<(Vec<u8>, Vec<u8>)>,
}

/// Read a profiled `Gameexe` container into its byte-exact layout without
/// decrypting. Out-of-profile compression is the usual typed not-implemented.
pub(crate) fn read_gameexe_record_layout(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
) -> Result<GameexeRecordLayout, KnownKeySmokeError> {
    let mut reader = Reader::new(container);
    reader.expect_magic(GAMEEXE_SMOKE_MAGIC, "Gameexe")?;
    check_in_profile(profile, &mut reader)?;
    let entry_count = reader.u32()?;
    let mut records = Vec::with_capacity(entry_count as usize);
    for _ in 0..entry_count {
        let key_bytes = reader.encrypted_slice()?.to_vec();
        let value_bytes = reader.encrypted_slice()?.to_vec();
        records.push((key_bytes, value_bytes));
    }
    Ok(GameexeRecordLayout {
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

/// Re-emit a profiled `Gameexe` container from a byte-exact record layout.
pub(crate) fn reemit_gameexe_records(layout: &GameexeRecordLayout) -> Vec<u8> {
    build_gameexe_container(layout.compression, &layout.records)
}

/// Patch a single `Gameexe` value (config key matched by decoded text), keeping
/// every other entry's encrypted key + value byte-identical. The caller supplies
/// the already-resolved key.
pub(crate) fn patch_gameexe_value_with(
    profile: &SiglusKnownKeyProfile,
    container: &[u8],
    target_config_key: &str,
    translated_value: &str,
    key: &KnownKeyMaterial,
) -> Result<Vec<u8>, KnownKeySmokeError> {
    let layout = read_gameexe_record_layout(profile, container)?;
    let mut records = Vec::with_capacity(layout.records.len());
    let mut matched = false;
    for (enc_key, enc_val) in layout.records {
        let decoded_key = utf16le_decode(&key.xor_cycle(&enc_key), 0)?;
        if decoded_key == target_config_key {
            let new_val = key.xor_cycle(&utf16le_encode(translated_value));
            records.push((enc_key, new_val));
            matched = true;
        } else {
            records.push((enc_key, enc_val));
        }
    }
    if !matched {
        return Err(KnownKeySmokeError::UnitNotFound {
            source_unit_key: format!("gameexe:{target_config_key}"),
        });
    }
    Ok(build_gameexe_container(
        SiglusKnownKeyCompression::Uncompressed,
        &records,
    ))
}

fn build_gameexe_container(
    compression: SiglusKnownKeyCompression,
    records: &[(Vec<u8>, Vec<u8>)],
) -> Vec<u8> {
    let flag = match compression {
        SiglusKnownKeyCompression::Uncompressed => COMPRESSION_UNCOMPRESSED,
        SiglusKnownKeyCompression::Lzss => COMPRESSION_LZSS,
    };
    let mut bytes = Vec::new();
    bytes.extend_from_slice(GAMEEXE_SMOKE_MAGIC);
    bytes.push(flag);
    bytes.extend_from_slice(
        &u32::try_from(records.len())
            .expect("gameexe entry count fits in u32")
            .to_le_bytes(),
    );
    for (enc_key, enc_val) in records {
        push_encrypted_slice(&mut bytes, enc_key);
        push_encrypted_slice(&mut bytes, enc_val);
    }
    bytes
}

fn push_encrypted_slice(bytes: &mut Vec<u8>, encrypted: &[u8]) {
    bytes.extend_from_slice(
        &u32::try_from(encrypted.len())
            .expect("encrypted slice length fits in u32")
            .to_le_bytes(),
    );
    bytes.extend_from_slice(encrypted);
}

fn build_scene_container(
    scene_id: u32,
    compression: SiglusKnownKeyCompression,
    records: &[(u32, Vec<u8>)],
) -> Vec<u8> {
    let flag = match compression {
        SiglusKnownKeyCompression::Uncompressed => COMPRESSION_UNCOMPRESSED,
        SiglusKnownKeyCompression::Lzss => COMPRESSION_LZSS,
    };
    let mut bytes = Vec::new();
    bytes.extend_from_slice(SCENE_SMOKE_MAGIC);
    bytes.push(flag);
    bytes.extend_from_slice(&scene_id.to_le_bytes());
    bytes.extend_from_slice(
        &u32::try_from(records.len())
            .expect("scene unit count fits in u32")
            .to_le_bytes(),
    );
    for (unit_index, encrypted) in records {
        bytes.extend_from_slice(&unit_index.to_le_bytes());
        bytes.extend_from_slice(
            &u32::try_from(encrypted.len())
                .expect("encrypted unit length fits in u32")
                .to_le_bytes(),
        );
        bytes.extend_from_slice(encrypted);
    }
    bytes
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], KnownKeySmokeError> {
        let end = self
            .position
            .checked_add(count)
            .ok_or(KnownKeySmokeError::Truncated {
                byte_offset: self.position,
                needed: count,
            })?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or(KnownKeySmokeError::Truncated {
                byte_offset: self.position,
                needed: end.saturating_sub(self.bytes.len()),
            })?;
        self.position = end;
        Ok(slice)
    }

    fn expect_magic(
        &mut self,
        magic: &[u8; 14],
        expected: &'static str,
    ) -> Result<(), KnownKeySmokeError> {
        let observed = self.take(magic.len())?;
        if observed == magic {
            Ok(())
        } else {
            Err(KnownKeySmokeError::BadMagic { expected })
        }
    }

    fn u8(&mut self) -> Result<u8, KnownKeySmokeError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, KnownKeySmokeError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// A length-prefixed still-encrypted text slice (borrowed).
    fn encrypted_slice(&mut self) -> Result<&'a [u8], KnownKeySmokeError> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    /// A length-prefixed encrypted UTF-16LE text unit, decrypted + decoded.
    fn encrypted_utf16le(&mut self, key: &KnownKeyMaterial) -> Result<String, KnownKeySmokeError> {
        let offset = self.position;
        let encrypted = self.encrypted_slice()?;
        let plaintext = key.xor_cycle(encrypted);
        utf16le_decode(&plaintext, offset)
    }
}

pub(crate) fn utf16le_encode(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn utf16le_decode(bytes: &[u8], byte_offset: usize) -> Result<String, KnownKeySmokeError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(KnownKeySmokeError::InvalidUtf16Le { byte_offset });
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).map_err(|_| KnownKeySmokeError::InvalidUtf16Le { byte_offset })
}

fn source_unit_key(scene_id: u32, unit_index: u32) -> String {
    format!("siglus:scene-{scene_id:04}#{unit_index:04}")
}

/// Parse just the unit index out of a canonical `siglus:scene-NNNN#OOOO` key.
/// Used by the adapter to identify edited units.
pub(crate) fn parse_source_unit_index(key: &str) -> Result<u32, KnownKeySmokeError> {
    parse_source_unit_key(key).map(|(_, unit_index)| unit_index)
}

fn parse_source_unit_key(key: &str) -> Result<(u32, u32), KnownKeySmokeError> {
    let malformed = || KnownKeySmokeError::BadUnitKey {
        source_unit_key: key.to_string(),
    };
    let rest = key.strip_prefix("siglus:scene-").ok_or_else(malformed)?;
    let (scene, unit) = rest.split_once('#').ok_or_else(malformed)?;
    let scene_id = scene.parse::<u32>().map_err(|_| malformed())?;
    let unit_index = unit.parse::<u32>().map_err(|_| malformed())?;
    Ok((scene_id, unit_index))
}

/// The narrow known-key smoke capability descriptor. Records the mechanical
/// facts: in-process, no shell-out, redacted, and — crucially —
/// `broad_siglus_support = false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusKnownKeyCapability {
    /// Capability id.
    pub capability_id: String,
    /// Engine family (`siglus`).
    pub engine_family: String,
    /// Always `false`: this crate never shells out.
    pub shells_out: bool,
    /// Always `false`: honest scope — this is a narrow known-key smoke, NOT
    /// broad Siglus Scene.pck/Gameexe.dat coverage.
    pub broad_siglus_support: bool,
    /// The in-profile encoding.
    pub encoding: SiglusKnownKeyEncoding,
    /// The in-profile compression.
    pub in_profile_compression: SiglusKnownKeyCompression,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// The blunt support boundary.
    pub support_boundary: String,
}

impl SiglusKnownKeyCapability {
    fn narrow(profile: &SiglusKnownKeyProfile) -> Self {
        Self {
            capability_id: KNOWN_KEY_SMOKE_CAPABILITY_ID.to_string(),
            engine_family: "siglus".to_string(),
            shells_out: false,
            broad_siglus_support: false,
            encoding: profile.encoding,
            in_profile_compression: profile.compression,
            redaction_status: HelperRedactionStatus::Redacted,
            support_boundary: KNOWN_KEY_SMOKE_SUPPORT_BOUNDARY.to_string(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            capability_id: redact_for_log_or_report(&self.capability_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            shells_out: self.shells_out,
            broad_siglus_support: self.broad_siglus_support,
            encoding: self.encoding,
            in_profile_compression: self.in_profile_compression,
            redaction_status: self.redaction_status,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
        }
    }
}

/// Per-scene-unit metadata carried in the report: structural key + byte length +
/// a one-way sha256 commitment to the text — NEVER the text itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneUnitDigest {
    /// Canonical source-unit key.
    pub source_unit_key: String,
    /// UTF-16LE byte length of the decoded text.
    pub text_byte_len: u32,
    /// sha256 commitment to the decoded text (never the text).
    pub text_hash: ProofHash,
}

/// The scene extraction section of the report (counts + digests, no text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneExtractionReport {
    /// `SceneList` scene id.
    pub scene_id: u32,
    /// Number of extracted units.
    pub unit_count: u32,
    /// Per-unit digests.
    pub units: Vec<SceneUnitDigest>,
}

/// A `Gameexe` entry digest: structural key + value byte length + value hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeEntryDigest {
    /// Configuration key (structural).
    pub key: String,
    /// UTF-16LE byte length of the value.
    pub value_byte_len: u32,
    /// sha256 commitment to the value (never the value text).
    pub value_hash: ProofHash,
}

/// The gameexe extraction section of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameexeExtractionReport {
    /// Number of extracted entries.
    pub entry_count: u32,
    /// Per-entry digests.
    pub entries: Vec<GameexeEntryDigest>,
}

/// The trivial-patch round-trip section of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRoundTripReport {
    /// The patched target unit key.
    pub target_source_unit_key: String,
    /// sha256 commitment to the translated text (never the text).
    pub translated_text_hash: ProofHash,
    /// Whether the round-trip fully verified.
    pub verified: bool,
    /// Whether every non-target unit was preserved.
    pub other_units_preserved: bool,
    /// The round-trip proof (method + hash over the re-emitted container).
    pub proof: KeyValidationProof,
}

/// The out-of-profile section: proves out-of-scope cases are typed
/// not-implemented, not silent passes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutOfProfileReport {
    /// The out-of-profile compression that was attempted.
    pub attempted_compression: String,
    /// Always `true`: the attempt was refused with a typed error.
    pub typed_not_implemented: bool,
    /// The stable diagnostic code the refusal carried.
    pub diagnostic_code: String,
}

/// The full known-key smoke report. Redact before serialization via
/// [`SiglusKnownKeySmokeReport::stable_json`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusKnownKeySmokeReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id this smoke is authored for.
    pub source_node_id: String,
    /// Engine family.
    pub engine_family: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// The declared profile id.
    pub profile_id: String,
    /// The structured secret-ref the known key is published under.
    pub secret_ref: SecretRef,
    /// One-way sha256 commitment to the known-key bytes (never the key).
    pub key_material_hash: ProofHash,
    /// Known-key byte length.
    pub key_bytes: u32,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// The narrow capability descriptor.
    pub capability: SiglusKnownKeyCapability,
    /// Scene extraction section.
    pub scene: SceneExtractionReport,
    /// Gameexe extraction section.
    pub gameexe: GameexeExtractionReport,
    /// Trivial patch round-trip section.
    pub patch: PatchRoundTripReport,
    /// Out-of-profile handling section.
    pub out_of_profile: OutOfProfileReport,
    /// Overall status.
    pub status: OperationStatus,
}

impl SiglusKnownKeySmokeReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            profile_id: redact_for_log_or_report(&self.profile_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            capability: self.capability.redacted_for_report(),
            scene: self.scene.clone(),
            gameexe: self.gameexe.clone(),
            patch: self.patch.clone(),
            out_of_profile: self.out_of_profile.clone(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no text).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// The known-key smoke fixture manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusKnownKeySmokeFixture {
    /// Schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id (e.g. ``).
    pub source_node_id: String,
    /// Engine family.
    pub engine_family: String,
    /// The narrow known-key profile.
    pub profile: SiglusKnownKeyProfile,
    /// The trivial translated patch to apply + verify.
    pub patch: SiglusKnownKeyPatchSpec,
}

/// The trivial translated change a smoke applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusKnownKeyPatchSpec {
    /// The target unit key (`siglus:scene-NNNN#OOOO`).
    pub target_source_unit_key: String,
    /// The replacement (translated) text.
    pub translated_text: String,
}

/// Resolve a container source to bytes, in-process.
fn resolve_container(
    source: &SiglusKnownKeyContainerSource,
    fixture_dir: &Path,
    synthetic: impl FnOnce() -> Vec<u8>,
) -> KaifuuResult<Vec<u8>> {
    match source {
        SiglusKnownKeyContainerSource::SyntheticStub => Ok(synthetic()),
        SiglusKnownKeyContainerSource::LocalFile { path } => {
            Ok(std::fs::read(fixture_dir.join(path))?)
        }
    }
}

/// Run the full known-key smoke from a fixture manifest: extract Scene +
/// Gameexe, apply + verify the trivial patch, and prove the out-of-profile case
/// is a typed not-implemented. Returns a redactable report.
pub fn run_known_key_smoke_from_fixture(
    fixture: &SiglusKnownKeySmokeFixture,
    fixture_dir: &Path,
) -> KaifuuResult<SiglusKnownKeySmokeReport> {
    let profile = &fixture.profile;

    let scene_bytes = resolve_container(
        &profile.scene_source,
        fixture_dir,
        build_synthetic_scene_fixture,
    )?;
    let gameexe_bytes = resolve_container(
        &profile.gameexe_source,
        fixture_dir,
        build_synthetic_gameexe_fixture,
    )?;

    // (1) Extraction smoke.
    let scene = extract_scene(profile, &scene_bytes)?;
    let gameexe = extract_gameexe(profile, &gameexe_bytes)?;

    // (2) Trivial patch + verify smoke.
    let (_, verification) = patch_and_verify_scene(
        profile,
        &scene_bytes,
        &fixture.patch.target_source_unit_key,
        &fixture.patch.translated_text,
    )?;

    // (3) Out-of-profile case must be a typed not-implemented, not a silent
    // pass. Feed a proprietary-LZSS-flagged container and require refusal.
    let out_of_profile = probe_out_of_profile(profile)?;

    // (4) Assemble the report (counts + one-way commitments only).
    let key = resolve_known_key(profile);
    let report = SiglusKnownKeySmokeReport {
        schema_version: KNOWN_KEY_SMOKE_SCHEMA_VERSION.to_string(),
        capability_id: fixture.capability_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: KNOWN_KEY_SMOKE_SUPPORT_BOUNDARY.to_string(),
        profile_id: profile.profile_id.clone(),
        secret_ref: profile.secret_ref.clone(),
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        capability: SiglusKnownKeyCapability::narrow(profile),
        scene: scene_report(&scene)?,
        gameexe: gameexe_report(&gameexe)?,
        patch: patch_report(&fixture.patch, &verification)?,
        out_of_profile,
        status: OperationStatus::Passed,
    };
    Ok(report)
}

/// Confirm an out-of-profile (proprietary-LZSS) container is refused with the
/// typed not-implemented error — the honest-scope proof.
fn probe_out_of_profile(profile: &SiglusKnownKeyProfile) -> KaifuuResult<OutOfProfileReport> {
    let out_of_profile_bytes = build_synthetic_out_of_profile_scene_fixture();
    match extract_scene(profile, &out_of_profile_bytes) {
        Err(KnownKeySmokeError::OutOfProfileCompression { observed, .. }) => {
            Ok(OutOfProfileReport {
                attempted_compression: observed.to_string(),
                typed_not_implemented: true,
                diagnostic_code:
                    "kaifuu.siglus.known_key_smoke.out_of_profile_compression_not_implemented"
                        .to_string(),
            })
        }
        Err(other) => {
            Err(format!("out-of-profile container produced the wrong error: {other}").into())
        }
        Ok(_) => Err("out-of-profile container was silently accepted"
            .to_string()
            .into()),
    }
}

fn scene_report(scene: &SiglusSceneExtraction) -> KaifuuResult<SceneExtractionReport> {
    let mut units = Vec::with_capacity(scene.units.len());
    for unit in &scene.units {
        let text_bytes = utf16le_encode(&unit.text);
        units.push(SceneUnitDigest {
            source_unit_key: unit.source_unit_key.clone(),
            text_byte_len: u32::try_from(text_bytes.len()).unwrap_or(u32::MAX),
            text_hash: ProofHash::new(sha256_hash_bytes(&text_bytes))?,
        });
    }
    Ok(SceneExtractionReport {
        scene_id: scene.scene_id,
        unit_count: u32::try_from(scene.units.len()).unwrap_or(u32::MAX),
        units,
    })
}

fn gameexe_report(gameexe: &SiglusGameexeExtraction) -> KaifuuResult<GameexeExtractionReport> {
    let mut entries = Vec::with_capacity(gameexe.entries.len());
    for entry in &gameexe.entries {
        let value_bytes = utf16le_encode(&entry.value);
        entries.push(GameexeEntryDigest {
            key: entry.key.clone(),
            value_byte_len: u32::try_from(value_bytes.len()).unwrap_or(u32::MAX),
            value_hash: ProofHash::new(sha256_hash_bytes(&value_bytes))?,
        });
    }
    Ok(GameexeExtractionReport {
        entry_count: u32::try_from(gameexe.entries.len()).unwrap_or(u32::MAX),
        entries,
    })
}

fn patch_report(
    patch: &SiglusKnownKeyPatchSpec,
    verification: &ScenePatchVerification,
) -> KaifuuResult<PatchRoundTripReport> {
    Ok(PatchRoundTripReport {
        target_source_unit_key: patch.target_source_unit_key.clone(),
        translated_text_hash: ProofHash::new(sha256_hash_bytes(&utf16le_encode(
            &patch.translated_text,
        )))?,
        verified: verification.verified(),
        other_units_preserved: verification.other_units_preserved,
        proof: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: verification.patched_container_hash.clone(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_profile() -> SiglusKnownKeyProfile {
        SiglusKnownKeyProfile {
            profile_id: "siglus-knownkey-smoke-fixture".to_string(),
            secret_ref: SecretRef::new("local-secret:siglus-secondary-key").unwrap(),
            encoding: SiglusKnownKeyEncoding::Utf16Le,
            compression: SiglusKnownKeyCompression::Uncompressed,
            scene_source: SiglusKnownKeyContainerSource::SyntheticStub,
            gameexe_source: SiglusKnownKeyContainerSource::SyntheticStub,
        }
    }

    #[test]
    fn known_key_extracts_profiled_scene_and_gameexe() {
        let profile = synthetic_profile();
        let scene = extract_scene(&profile, &build_synthetic_scene_fixture()).unwrap();
        assert_eq!(scene.scene_id, FIXTURE_SCENE_ID);
        assert_eq!(scene.units.len(), FIXTURE_SCENE_UNITS.len());
        assert_eq!(scene.units[0].source_unit_key, "siglus:scene-0001#0000");
        assert_eq!(scene.units[0].text, FIXTURE_SCENE_UNITS[0]);

        let gameexe = extract_gameexe(&profile, &build_synthetic_gameexe_fixture()).unwrap();
        assert_eq!(gameexe.entries.len(), FIXTURE_GAMEEXE_ENTRIES.len());
        assert_eq!(gameexe.entries[0].key, FIXTURE_GAMEEXE_ENTRIES[0].0);
        assert_eq!(gameexe.entries[0].value, FIXTURE_GAMEEXE_ENTRIES[0].1);
    }

    #[test]
    fn trivial_patch_round_trips_and_preserves_other_units() {
        let profile = synthetic_profile();
        let container = build_synthetic_scene_fixture();
        let translated = "[synthetic-translation-EN-0]";
        let (patched, verification) =
            patch_and_verify_scene(&profile, &container, "siglus:scene-0001#0000", translated)
                .unwrap();
        assert!(verification.verified());
        assert!(verification.target_changed);
        assert!(verification.other_units_preserved);

        // Re-extract confirms exactly the target changed.
        let after = extract_scene(&profile, &patched).unwrap();
        assert_eq!(after.units[0].text, translated);
        assert_eq!(after.units[1].text, FIXTURE_SCENE_UNITS[1]);
        assert_eq!(after.units[2].text, FIXTURE_SCENE_UNITS[2]);
    }

    #[test]
    fn out_of_profile_compression_is_typed_not_implemented() {
        let profile = synthetic_profile();
        let bytes = build_synthetic_out_of_profile_scene_fixture();
        let err = extract_scene(&profile, &bytes).expect_err("lzss is out of profile");
        assert!(matches!(
            err,
            KnownKeySmokeError::OutOfProfileCompression { .. }
        ));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
        assert!(err.to_string().contains("not_implemented"));
    }

    #[test]
    fn missing_patch_target_is_typed_not_faked() {
        let profile = synthetic_profile();
        let container = build_synthetic_scene_fixture();
        let err = patch_scene_unit(&profile, &container, "siglus:scene-0001#0099", "x")
            .expect_err("missing target must not be faked");
        assert!(matches!(err, KnownKeySmokeError::UnitNotFound { .. }));
    }

    #[test]
    fn key_material_is_redacted_and_zeroized_in_debug() {
        let key = known_key_material_from_resolved_secret(
            &SecretRef::new(SYNTHETIC_KNOWN_KEY_SECRET_REF)
                .expect("static synthetic secret ref is valid"),
            SYNTHETIC_KNOWN_KEY.to_vec(),
        );
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_KNOWN_KEY).into_owned()));
    }

    #[test]
    fn report_carries_no_raw_key_and_no_extracted_text() {
        let profile = synthetic_profile();
        let fixture = SiglusKnownKeySmokeFixture {
            schema_version: KNOWN_KEY_SMOKE_SCHEMA_VERSION.to_string(),
            capability_id: KNOWN_KEY_SMOKE_CAPABILITY_ID.to_string(),
            source_node_id: "KAIFUU-070".to_string(),
            engine_family: "siglus".to_string(),
            profile,
            patch: SiglusKnownKeyPatchSpec {
                target_source_unit_key: "siglus:scene-0001#0000".to_string(),
                translated_text: "[synthetic-translation-EN-0]".to_string(),
            },
        };
        let report =
            run_known_key_smoke_from_fixture(&fixture, Path::new(".")).expect("smoke runs");
        assert_eq!(report.status, OperationStatus::Passed);
        assert!(!report.capability.broad_siglus_support);
        assert!(report.patch.verified);
        assert!(report.out_of_profile.typed_not_implemented);

        let json = report.stable_json().expect("stable json");
        // The raw key never appears (bytes or utf-8).
        assert!(!json.contains(&String::from_utf8_lossy(SYNTHETIC_KNOWN_KEY).into_owned()));
        // Extracted/translated text never appears — only its hash.
        assert!(!json.contains(FIXTURE_SCENE_UNITS[1]));
        assert!(!json.contains("[synthetic-translation-EN-0]"));
        // The key length is disclosed, the bytes are not.
        assert_eq!(report.key_bytes as usize, SYNTHETIC_KNOWN_KEY.len());
        assert_eq!(
            report.key_material_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_KNOWN_KEY)
        );
    }
}
