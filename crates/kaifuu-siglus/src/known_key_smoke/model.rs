use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    KaifuuResult, ProofHash, SecretRef,
    secret_holder::{SecretRefSecretResolver, ZeroizingSecretBytes},
};

use super::{COMPRESSION_LZSS, COMPRESSION_UNCOMPRESSED, SYNTHETIC_KNOWN_KEY, codec::Reader};

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
    /// Proprietary Siglus LZSS — explicitly **out of profile** here. The
    /// real codec is the proprietary-LZSS skeleton; the smoke returns a
    /// typed `not_implemented` for it rather than over-claiming support.
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

pub(super) fn known_key_material_from_resolved_secret(
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
pub(crate) fn resolve_known_key(profile: &SiglusKnownKeyProfile) -> KnownKeyMaterial {
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
    /// proprietary-LZSS support (that codec is the proprietary-LZSS skeleton).
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

/// Enforce the declared in-profile compression: an out-of-profile flag is a
/// typed not-implemented, never a silent pass.
pub(super) fn check_in_profile(
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
