use super::*;

#[derive(Debug, Clone, Copy)]
pub struct EncryptedMediaProofRequest<'a> {
    pub fixture: &'a EncryptedMediaProofFixture,
    /// Directory the fixture file lives in. The `game_dir` declared in
    /// the fixture is resolved relative to this directory.
    pub fixture_dir: &'a Path,
}

/// Per-suffix profile for readiness routing. This is a
/// research-only table — every encrypted-suffix entry carries
/// `patch_capability_level = Unsupported` and `decryptability = OutOfScope`
/// until a key profile resolves it upward to `KeyProfileSatisfied`.
pub(crate) struct EncryptedMediaSuffixProfile {
    pub(crate) suffix: &'static str,
    pub(crate) kind: Option<EncryptedMediaAssetKind>,
    pub(crate) encrypted: bool,
    /// Suffix is in the recognised RPG Maker family but has no profiled
    /// crypto / codec mapping (e.g. `.webp_`).
    pub(crate) unknown_in_family: bool,
}

pub(crate) const ENCRYPTED_MEDIA_SUFFIX_PROFILES: &[EncryptedMediaSuffixProfile] = &[
    // MV-era encrypted suffixes.
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvp",
        kind: Some(EncryptedMediaAssetKind::Image),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvm",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvo",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvu",
        kind: Some(EncryptedMediaAssetKind::Video),
        encrypted: true,
        unknown_in_family: false,
    },
    // MZ-era encrypted suffixes.
    EncryptedMediaSuffixProfile {
        suffix: "png_",
        kind: Some(EncryptedMediaAssetKind::Image),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "m4a_",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "ogg_",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    // Plaintext (unencrypted) media — present as evidence only.
    EncryptedMediaSuffixProfile {
        suffix: "png",
        kind: Some(EncryptedMediaAssetKind::Image),
        encrypted: false,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "m4a",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: false,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "ogg",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: false,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "webm",
        kind: Some(EncryptedMediaAssetKind::Video),
        encrypted: false,
        unknown_in_family: false,
    },
    // Recognised but unmapped suffixes (route to unknown_suffix).
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvu",
        kind: None,
        encrypted: true,
        unknown_in_family: true,
    },
    EncryptedMediaSuffixProfile {
        suffix: "webp_",
        kind: None,
        encrypted: true,
        unknown_in_family: true,
    },
];

pub(crate) fn encrypted_media_suffix_profile(
    suffix: &str,
) -> Option<&'static EncryptedMediaSuffixProfile> {
    let lower = suffix.to_ascii_lowercase();
    ENCRYPTED_MEDIA_SUFFIX_PROFILES
        .iter()
        .find(|profile| profile.suffix == lower)
}

/// Asset-relative-path validator. Mirrors the XP3 profile-proof
/// validator: rejects absolute / drive-letter / parent-traversal / home
/// prefixes so private paths cannot survive into the report.
pub(crate) fn validate_encrypted_media_fixture_path(path: &str) -> Result<&str, String> {
    if path.is_empty() {
        return Err("asset path must not be empty".to_string());
    }
    let trimmed = path.trim_start();
    if trimmed != path {
        return Err("asset path must not contain leading whitespace".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("asset path must be relative to the game directory".to_string());
    }
    if path.starts_with("~/") || path.starts_with("~\\") {
        return Err("asset path must not contain home prefixes".to_string());
    }
    if path.starts_with("$HOME")
        || path.starts_with("${HOME}")
        || path.starts_with("%USERPROFILE%")
        || path.starts_with("%HOME%")
        || path.starts_with("$USERPROFILE")
    {
        return Err("asset path must not contain environment-variable home prefixes".to_string());
    }
    for component in path.split(['/', '\\']) {
        if component == ".." {
            return Err("asset path must not contain parent traversal".to_string());
        }
    }
    if path.len() >= 2 {
        let mut chars = path.chars();
        let first = chars.next().unwrap_or(' ');
        let second = chars.next().unwrap_or(' ');
        if first.is_ascii_alphabetic() && second == ':' {
            return Err("asset path must not contain a drive letter".to_string());
        }
    }
    Ok(path)
}

/// `data/System.json` evidence parsed for readiness routing. Stored
/// alongside the proof hash so the key profile section can surface
/// `has_encrypted_images_flag` / `has_encrypted_audio_flag` without
/// re-reading the file.
pub(crate) struct EncryptedMediaSystemJson {
    pub(crate) proof_hash: Option<ProofHash>,
    pub(crate) has_encrypted_images: Option<bool>,
    pub(crate) has_encrypted_audio: Option<bool>,
    pub(crate) encryption_key_present: bool,
    pub(crate) encryption_key_well_formed: bool,
    pub(crate) encryption_key_hash: Option<ProofHash>,
}

pub(crate) fn read_encrypted_media_system_json(
    game_dir: &Path,
) -> Option<EncryptedMediaSystemJson> {
    let path = find_rpg_maker_system_json(game_dir)?;
    let bytes = fs::read(&path).ok()?;
    let proof_hash = ProofHash::new(sha256_hash_bytes(&bytes)).ok();
    let value = serde_json::from_slice::<Value>(&bytes).ok();
    let (
        has_encrypted_images,
        has_encrypted_audio,
        encryption_key_present,
        encryption_key_well_formed,
        encryption_key_hash,
    ) = match value {
        Some(value) => {
            let has_encrypted_images = value.get("hasEncryptedImages").and_then(Value::as_bool);
            let has_encrypted_audio = value.get("hasEncryptedAudio").and_then(Value::as_bool);
            let key = value
                .get("encryptionKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty());
            let well_formed = key.is_some_and(|key| {
                // MV/MZ asset XOR key is 16 bytes encoded as 32
                // lowercase hex chars.
                key.len() == 32
                    && key.chars().all(|c| {
                        c.is_ascii_hexdigit()
                            && (!c.is_ascii_alphabetic() || c.is_ascii_lowercase())
                    })
            });
            let key_hash = if well_formed {
                key.and_then(|key| ProofHash::new(sha256_hash_bytes(key.as_bytes())).ok())
            } else {
                None
            };
            (
                has_encrypted_images,
                has_encrypted_audio,
                key.is_some(),
                well_formed,
                key_hash,
            )
        }
        None => (None, None, false, false, None),
    };
    Some(EncryptedMediaSystemJson {
        proof_hash,
        has_encrypted_images,
        has_encrypted_audio,
        encryption_key_present,
        encryption_key_well_formed,
        encryption_key_hash,
    })
}

/// Hash 64 bytes of asset evidence (or all bytes if shorter). Mirrors
/// [`rpg_maker_mv_mz_image_evidence_hash`] — the proof never persists
/// full asset bytes, only a stable hash of the leading window for
/// downstream provenance review.
pub(crate) fn encrypted_media_asset_evidence_hash(bytes: &[u8]) -> ProofHash {
    ProofHash::new(sha256_hash_bytes(&bytes[..bytes.len().min(64)]))
        .expect("sha256 hash output is always shaped as a valid kaifuu ProofHash")
}

/// Classify a single asset by its on-disk bytes + declared suffix +
/// declared kind. Byte-level classification is the source of truth: a
/// fixture that *declares* `encrypted` but supplies plaintext-shaped
/// bytes is re-classified to `MalformedHeader`, never silently upgraded
/// to `Encrypted`.
pub(crate) fn classify_encrypted_media_asset(
    profile: Option<&EncryptedMediaSuffixProfile>,
    bytes: Option<&[u8]>,
) -> EncryptedMediaClassification {
    let Some(profile) = profile else {
        return EncryptedMediaClassification::UnknownSuffix;
    };
    if profile.unknown_in_family {
        return EncryptedMediaClassification::UnknownSuffix;
    }
    let Some(bytes) = bytes else {
        return EncryptedMediaClassification::MissingAsset;
    };
    if profile.encrypted {
        if bytes.len() < RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len() {
            return EncryptedMediaClassification::MalformedHeader;
        }
        if &bytes[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()] == RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        {
            EncryptedMediaClassification::Encrypted
        } else {
            EncryptedMediaClassification::MalformedHeader
        }
    } else {
        EncryptedMediaClassification::Plaintext
    }
}
