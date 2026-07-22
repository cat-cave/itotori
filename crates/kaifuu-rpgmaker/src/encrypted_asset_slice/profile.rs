use super::*;

/// The media capability an encrypted asset carries. RPG Maker's encrypted
/// suffixes collapse to exactly two decrypt/verify capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaCapability {
    Image,
    Audio,
}

impl MediaCapability {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }

    /// True iff `bytes` begins with this capability's plaintext media signature.
    /// Image is validated by the PNG signature; audio by the Ogg `OggS` capture
    /// pattern (the synthetic audio media this slice round-trips). NOTE: `.m4a_`
    /// assets are real M4A (`ftyp`), which the synthetic fixtures do not model;
    /// the suffix still routes to [`Self::Audio`], and a real M4A signature check
    /// would be added when M4A fixtures land.
    /// `pub(crate)` so the media-surface layer reuses this single
    /// signature oracle (never re-implements it).
    pub(crate) fn signature_matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Image => {
                bytes.len() >= PNG_SIGNATURE.len() && &bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE
            }
            Self::Audio => {
                bytes.len() >= OGG_SIGNATURE.len() && &bytes[..OGG_SIGNATURE.len()] == OGG_SIGNATURE
            }
        }
    }
}

impl fmt::Display for MediaCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The RPG Maker MV/MZ encrypted-asset suffixes this slice profiles. Each maps to
/// exactly one [`MediaCapability`]; a suffix outside this set is an
/// [`MvMzSliceError::UnsupportedSuffix`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedAssetSuffix {
    /// MV image (`*.rpgmvp`).
    Rpgmvp,
    /// MZ image (`*.png_`).
    PngUnderscore,
    /// MV Ogg audio (`*.rpgmvo`).
    Rpgmvo,
    /// MZ Ogg audio (`*.ogg_`).
    OggUnderscore,
    /// MV M4A audio (`*.rpgmvm`).
    Rpgmvm,
    /// MZ M4A audio (`*.m4a_`).
    M4aUnderscore,
}

impl EncryptedAssetSuffix {
    /// All profiled suffixes in canonical order.
    #[must_use]
    pub fn all() -> [Self; 6] {
        [
            Self::Rpgmvp,
            Self::PngUnderscore,
            Self::Rpgmvo,
            Self::OggUnderscore,
            Self::Rpgmvm,
            Self::M4aUnderscore,
        ]
    }

    /// The lowercase suffix token (no leading dot).
    #[must_use]
    pub fn token(self) -> &'static str {
        match self {
            Self::Rpgmvp => "rpgmvp",
            Self::PngUnderscore => "png_",
            Self::Rpgmvo => "rpgmvo",
            Self::OggUnderscore => "ogg_",
            Self::Rpgmvm => "rpgmvm",
            Self::M4aUnderscore => "m4a_",
        }
    }

    /// The media capability this suffix carries.
    #[must_use]
    pub fn capability(self) -> MediaCapability {
        match self {
            Self::Rpgmvp | Self::PngUnderscore => MediaCapability::Image,
            Self::Rpgmvo | Self::OggUnderscore | Self::Rpgmvm | Self::M4aUnderscore => {
                MediaCapability::Audio
            }
        }
    }

    /// Parse the encrypted suffix from a file name. The suffix is the substring
    /// after the final `.`; matching is case-insensitive. An off-profile suffix
    /// (or a name with no suffix) is a typed [`MvMzSliceError::UnsupportedSuffix`].
    pub fn parse(file_name: &str) -> Result<Self, MvMzSliceError> {
        let raw = file_name.rsplit_once('.').map(|(_, suffix)| suffix);
        let lowered = raw.map(str::to_ascii_lowercase);
        let matched = lowered.as_deref().and_then(|token| {
            Self::all()
                .into_iter()
                .find(|suffix| suffix.token() == token)
        });
        matched.ok_or_else(|| MvMzSliceError::UnsupportedSuffix {
            suffix: raw.unwrap_or("<none>").to_string(),
        })
    }
}

/// The known 16-byte PNG plaintext prefix an image-derived key recovery XORs
/// against the encrypted image's first 16 body bytes. It is exactly the leading
/// 16 bytes of the public synthetic PNG media (a fixed PNG signature + IHDR
/// framing that every RPG Maker PNG shares in its first bytes).
fn known_png_prefix() -> [u8; RPGMAKER_ASSET_XOR_PREFIX_LEN] {
    let mut prefix = [0u8; RPGMAKER_ASSET_XOR_PREFIX_LEN];
    prefix.copy_from_slice(&SYNTHETIC_PNG[..RPGMAKER_ASSET_XOR_PREFIX_LEN]);
    prefix
}

/// How the 16-byte asset key is sourced for an entry. Raw key material never
/// reaches the report — only the [`MvMzKeySourceKind`] tag plus a one-way
/// commitment do.
#[derive(Debug, Clone)]
pub enum MvMzKeySource {
    /// A `System.json`-style `encryptionKey` hex string (32 lowercase hex chars →
    /// 16 bytes). Undecodable / wrong-length input is a typed
    /// [`MvMzSliceError::BadKeyMaterial`].
    SystemJsonEncryptionKey(String),
    /// Recover the key from the encrypted image itself: XOR the first 16 body
    /// bytes against the known PNG plaintext prefix. Image-only — pointing it at
    /// an audio asset is a [`MvMzSliceError::CapabilityDiff`].
    ImageDerived,
    /// No key is resolvable — a typed [`MvMzSliceError::NoKey`].
    None,
}

/// The report-safe tag for a key source (never carries the key bytes/hex).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzKeySourceKind {
    SystemJsonEncryptionKey,
    ImageDerived,
    None,
}

impl MvMzKeySource {
    pub(super) fn kind(&self) -> MvMzKeySourceKind {
        match self {
            Self::SystemJsonEncryptionKey(_) => MvMzKeySourceKind::SystemJsonEncryptionKey,
            Self::ImageDerived => MvMzKeySourceKind::ImageDerived,
            Self::None => MvMzKeySourceKind::None,
        }
    }

    /// Resolve the 16-byte asset key. `encrypted` is the encrypted asset bytes
    /// (needed for image-derived recovery); `capability` is the asset suffix's
    /// capability (image-derived is image-only). Every failure is typed.
    /// `pub(crate)` so the media-surface layer reuses this single key
    /// resolution path (System.json hex / image-derived / none).
    pub(crate) fn resolve(
        &self,
        encrypted: &[u8],
        capability: MediaCapability,
    ) -> Result<MvMzAssetKey, MvMzSliceError> {
        match self {
            Self::None => Err(MvMzSliceError::NoKey),
            Self::SystemJsonEncryptionKey(hex) => {
                let bytes = decode_encryption_key_hex(hex)?;
                Ok(MvMzAssetKey::from_bytes(&bytes))
            }
            Self::ImageDerived => {
                if capability != MediaCapability::Image {
                    return Err(MvMzSliceError::CapabilityDiff {
                        asset_capability: capability,
                        requested_capability: MediaCapability::Image,
                    });
                }
                let bytes = recover_image_derived_key(encrypted)?;
                Ok(MvMzAssetKey::from_bytes(&bytes))
            }
        }
    }
}

/// Decode a `System.json` `encryptionKey`: exactly 32 lowercase/uppercase hex
/// characters → 16 bytes. Anything else is a typed [`MvMzSliceError::BadKeyMaterial`].
pub(super) fn decode_encryption_key_hex(hex: &str) -> Result<Vec<u8>, MvMzSliceError> {
    let expected_chars = RPGMAKER_ASSET_XOR_PREFIX_LEN * 2;
    if hex.len() != expected_chars {
        return Err(MvMzSliceError::BadKeyMaterial {
            reason: format!(
                "encryptionKey must be {expected_chars} hex chars, got {}",
                hex.len()
            ),
        });
    }
    let mut bytes = Vec::with_capacity(RPGMAKER_ASSET_XOR_PREFIX_LEN);
    let raw = hex.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        let hi = hex_nibble(raw[index])?;
        let lo = hex_nibble(raw[index + 1])?;
        bytes.push((hi << 4) | lo);
        index += 2;
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Result<u8, MvMzSliceError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        other => Err(MvMzSliceError::BadKeyMaterial {
            reason: format!("non-hex byte 0x{other:02x} in encryptionKey"),
        }),
    }
}

/// Recover the 16-byte key from an encrypted image by XOR-ing its first 16 body
/// bytes (after the RPGMV header) against the known PNG plaintext prefix.
pub(super) fn recover_image_derived_key(
    encrypted: &[u8],
) -> Result<[u8; RPGMAKER_ASSET_XOR_PREFIX_LEN], MvMzSliceError> {
    let header_len = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len();
    let need = header_len + RPGMAKER_ASSET_XOR_PREFIX_LEN;
    if encrypted.len() < need {
        return Err(MvMzSliceError::MalformedAsset {
            reason: format!("encrypted image is {} bytes, need {need}", encrypted.len()),
        });
    }
    if &encrypted[..header_len] != RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER {
        return Err(MvMzSliceError::MalformedAsset {
            reason: "encrypted image lacks the RPGMV header magic".to_string(),
        });
    }
    let known = known_png_prefix();
    let mut key = [0u8; RPGMAKER_ASSET_XOR_PREFIX_LEN];
    for (index, slot) in key.iter_mut().enumerate() {
        *slot = encrypted[header_len + index] ^ known[index];
    }
    Ok(key)
}

/// The typed failure vocabulary of the slice. Every input problem is one of
/// these — never a panic, never a silent pass.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MvMzSliceError {
    #[error("kaifuu.rpgmaker.k068.no_key: no asset key was resolvable for the secret requirement")]
    NoKey,
    #[error("kaifuu.rpgmaker.k068.bad_key_material: {reason}")]
    BadKeyMaterial { reason: String },
    #[error(
        "kaifuu.rpgmaker.k068.wrong_key: decrypt did not recover the declared {capability} media signature"
    )]
    WrongKey { capability: MediaCapability },
    #[error("kaifuu.rpgmaker.k068.unsupported_suffix: {suffix} is not a profiled encrypted suffix")]
    UnsupportedSuffix { suffix: String },
    #[error(
        "kaifuu.rpgmaker.k068.capability_diff: asset is {asset_capability} but the operation is {requested_capability}"
    )]
    CapabilityDiff {
        asset_capability: MediaCapability,
        requested_capability: MediaCapability,
    },
    #[error(
        "kaifuu.rpgmaker.k068.replacement_not_media: replacement does not carry the {capability} media signature"
    )]
    ReplacementNotMedia { capability: MediaCapability },
    #[error("kaifuu.rpgmaker.k068.malformed_asset: {reason}")]
    MalformedAsset { reason: String },
}

impl MvMzSliceError {
    /// The stable machine code (the `error` message prefix, without the message).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoKey => "kaifuu.rpgmaker.k068.no_key",
            Self::BadKeyMaterial { .. } => "kaifuu.rpgmaker.k068.bad_key_material",
            Self::WrongKey { .. } => "kaifuu.rpgmaker.k068.wrong_key",
            Self::UnsupportedSuffix { .. } => "kaifuu.rpgmaker.k068.unsupported_suffix",
            Self::CapabilityDiff { .. } => "kaifuu.rpgmaker.k068.capability_diff",
            Self::ReplacementNotMedia { .. } => "kaifuu.rpgmaker.k068.replacement_not_media",
            Self::MalformedAsset { .. } => "kaifuu.rpgmaker.k068.malformed_asset",
        }
    }

    /// The semantic code (engine-family-namespaced), for cross-report joins.
    #[must_use]
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::NoKey => "kaifuu.rpgmaker.encrypted_asset_slice.no_key",
            Self::BadKeyMaterial { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.bad_key_material",
            Self::WrongKey { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.wrong_key",
            Self::UnsupportedSuffix { .. } => {
                "kaifuu.rpgmaker.encrypted_asset_slice.unsupported_suffix"
            }
            Self::CapabilityDiff { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.capability_diff",
            Self::ReplacementNotMedia { .. } => {
                "kaifuu.rpgmaker.encrypted_asset_slice.replacement_not_media"
            }
            Self::MalformedAsset { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.malformed_asset",
        }
    }

    /// The slice outcome this error maps to.
    pub(super) fn outcome(&self) -> MvMzSliceOutcome {
        match self {
            Self::NoKey => MvMzSliceOutcome::NoKey,
            Self::BadKeyMaterial { .. } => MvMzSliceOutcome::BadKeyMaterial,
            Self::WrongKey { .. } => MvMzSliceOutcome::WrongKey,
            Self::UnsupportedSuffix { .. } => MvMzSliceOutcome::UnsupportedSuffix,
            Self::CapabilityDiff { .. } => MvMzSliceOutcome::CapabilityDiff,
            Self::ReplacementNotMedia { .. } => MvMzSliceOutcome::ReplacementNotMedia,
            Self::MalformedAsset { .. } => MvMzSliceOutcome::MalformedAsset,
        }
    }

    pub(super) fn diagnostic(&self) -> MvMzSliceDiagnostic {
        MvMzSliceDiagnostic {
            code: self.code().to_string(),
            semantic_code: self.semantic_code().to_string(),
            message: self.to_string(),
        }
    }
}

/// An internal failure building a proof hash. This is a programmer-error class
/// (the sha256 hashing invariants always hold for real bytes) surfaced instead
/// of a panic.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("kaifuu.rpgmaker.k068.internal: {0}")]
pub struct MvMzSliceInternalError(String);

impl MvMzSliceInternalError {
    pub(super) fn new(message: String) -> Self {
        Self(message)
    }
}

pub(super) fn proof_hash(bytes: &[u8]) -> Result<ProofHash, MvMzSliceInternalError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(MvMzSliceInternalError)
}

/// The mechanical outcome of one slice op.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzSliceOutcome {
    /// Decrypted to the declared media AND re-encrypted byte-correctly (identity).
    DecryptedRoundTripped,
    /// A trivial replacement was patched in AND every verify check passed.
    Replaced,
    NoKey,
    BadKeyMaterial,
    WrongKey,
    UnsupportedSuffix,
    CapabilityDiff,
    ReplacementNotMedia,
    MalformedAsset,
}

impl MvMzSliceOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DecryptedRoundTripped => "decrypted_round_tripped",
            Self::Replaced => "replaced",
            Self::NoKey => "no_key",
            Self::BadKeyMaterial => "bad_key_material",
            Self::WrongKey => "wrong_key",
            Self::UnsupportedSuffix => "unsupported_suffix",
            Self::CapabilityDiff => "capability_diff",
            Self::ReplacementNotMedia => "replacement_not_media",
            Self::MalformedAsset => "malformed_asset",
        }
    }
}

/// A trivial replacement to patch in place of the decrypted asset.
#[derive(Debug, Clone)]
pub struct SliceReplacement {
    /// The media kind of the replacement plaintext. A mismatch with the asset
    /// suffix capability is a [`MvMzSliceError::CapabilityDiff`].
    pub capability: MediaCapability,
    /// The replacement plaintext bytes (must carry the capability's media signature).
    pub plaintext: Vec<u8>,
}

/// One slice op: an encrypted asset, a key source, and either an identity
/// round-trip (no replacement) or a trivial replacement patch.
#[derive(Debug, Clone)]
pub struct MvMzSliceOp {
    pub entry_id: String,
    /// The asset file name (its suffix routes the capability). Recorded sanitized.
    pub asset_file_name: String,
    pub secret_ref: SecretRef,
    pub key_source: MvMzKeySource,
    /// The encrypted asset bytes (synthetic).
    pub encrypted_asset: Vec<u8>,
    /// The known plaintext the asset must decrypt to (the decrypt-verify anchor).
    pub known_plaintext: Vec<u8>,
    /// `Some` for a replacement patch op; `None` for an identity round-trip.
    pub replacement: Option<SliceReplacement>,
    pub expected: MvMzSliceOutcome,
}
