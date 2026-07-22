use super::*;

impl MediaDecryptState {
    /// True iff the plaintext is available (a correct decrypt).
    #[must_use]
    pub fn is_decrypted(&self) -> bool {
        matches!(
            self,
            Self::Decrypted {
                media_signature_ok: true,
                ..
            }
        )
    }

    fn tag(&self) -> &'static str {
        match self {
            Self::Decrypted { .. } => "decrypted",
            Self::EncryptedKeyAbsent => "encrypted_key_absent",
            Self::KeyMaterialInvalid { .. } => "key_material_invalid",
            Self::WrongKey => "wrong_key",
            Self::MalformedAsset { .. } => "malformed_asset",
        }
    }
}

impl MediaAssetSurface {
    fn redacted_for_report(&self) -> Self {
        let mut clone = self.clone();
        clone.relative_path = redact_for_log_or_report(&self.relative_path);
        clone.decision.relative_path = redact_for_log_or_report(&self.decision.relative_path);
        clone.decision.reason = redact_for_log_or_report(&self.decision.reason);
        clone
    }
}

fn sanitize_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    // Keep the last two segments (subtree hint) but strip any absolute prefix.
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return "asset.bin".to_string();
    }
    segments.join("/")
}

/// Build the media-surface representation for one encrypted asset.
/// Detects the encrypted suffix (typed [`MediaSurfaceError::UnsupportedSuffix`]
/// for an off-profile suffix), classifies the localization role from
/// `profile`, and decrypts with `key_source` WHEN a key is available — a
/// key-absent asset is represented as [`MediaDecryptState::EncryptedKeyAbsent`]
/// (no crash). Returns the surface + the Itotori decision handoff.
pub fn build_media_surface(
    profile: &MediaSurfaceProfile,
    relative_path: &str,
    encrypted_asset: &[u8],
    key_source: &MvMzKeySource,
) -> Result<MediaAssetSurface, MediaSurfaceError> {
    let sanitized = sanitize_relative_path(relative_path);
    let file_name = Path::new(&sanitized)
        .file_name()
        .and_then(|c| c.to_str())
        .unwrap_or(&sanitized);
    let suffix = EncryptedAssetSuffix::parse(file_name).map_err(map_suffix_error)?;
    let capability = suffix.capability();
    let role = profile.classify(&sanitized);
    let encrypted_sha256 = sha256_hash_bytes(encrypted_asset);

    let decrypt_state = decrypt_state_for(encrypted_asset, key_source, capability);
    let plaintext_available = decrypt_state.is_decrypted();

    let patch_back_mode = if !role.is_localization_surface() {
        PatchBackMode::ByteIdenticalPassthrough
    } else if plaintext_available {
        PatchBackMode::ReEncryptSameKey
    } else {
        PatchBackMode::HeldPendingKey
    };

    let reason = format!(
        "role={} capability={} surface={} decrypt={} patch_back={}",
        role.as_str(),
        capability.as_str(),
        role.is_localization_surface(),
        decrypt_state.tag(),
        patch_back_mode.as_str()
    );

    let decision = MediaAssetDecision {
        relative_path: sanitized.clone(),
        role,
        capability,
        is_candidate_surface: role.is_localization_surface(),
        plaintext_available,
        patch_back_mode,
        reason,
    };

    Ok(MediaAssetSurface {
        relative_path: sanitized,
        suffix,
        capability,
        role,
        is_localization_surface: role.is_localization_surface(),
        encrypted_sha256,
        decrypt_state,
        decision,
    })
}

/// Resolve the key and decrypt, mapping every outcome to a [`MediaDecryptState`]
/// (key-absent and bad material are STATES, not hard errors — the asset is
/// still represented).
fn decrypt_state_for(
    encrypted: &[u8],
    key_source: &MvMzKeySource,
    capability: MediaCapability,
) -> MediaDecryptState {
    let key = match key_source.resolve(encrypted, capability) {
        Ok(key) => key,
        Err(err) => return key_resolution_state(&err),
    };
    match decrypt_rpgmaker_asset(encrypted, &key) {
        Ok(plaintext) => {
            let media_signature_ok = capability.signature_matches(&plaintext);
            if media_signature_ok {
                MediaDecryptState::Decrypted {
                    plaintext_sha256: sha256_hash_bytes(&plaintext),
                    plaintext_len: plaintext.len(),
                    media_signature_ok,
                }
            } else {
                MediaDecryptState::WrongKey
            }
        }
        Err(err) => MediaDecryptState::MalformedAsset {
            reason: format!("{err:?}"),
        },
    }
}

/// Map a key-resolution error to a media-surface decrypt state.
fn key_resolution_state(err: &crate::encrypted_asset_slice::MvMzSliceError) -> MediaDecryptState {
    use crate::encrypted_asset_slice::MvMzSliceError;
    match err {
        MvMzSliceError::NoKey => MediaDecryptState::EncryptedKeyAbsent,
        MvMzSliceError::BadKeyMaterial { reason } => MediaDecryptState::KeyMaterialInvalid {
            reason: reason.clone(),
        },
        other => MediaDecryptState::MalformedAsset {
            reason: other.to_string(),
        },
    }
}

fn map_suffix_error(err: crate::encrypted_asset_slice::MvMzSliceError) -> MediaSurfaceError {
    use crate::encrypted_asset_slice::MvMzSliceError;
    match err {
        MvMzSliceError::UnsupportedSuffix { suffix } => {
            MediaSurfaceError::UnsupportedSuffix { suffix }
        }
        other => MediaSurfaceError::MalformedAsset {
            reason: other.to_string(),
        },
    }
}

/// Plan a replacement (patch-back) for a profiled text-bearing surface.
/// Policy ([`PatchBackMode::ReEncryptSameKey`]): re-encrypt `replacement` with
/// the SAME key and re-wrap the RPGMV header. Allowed **only** when the asset's
/// role is a localization surface, the key is available, the replacement's
/// capability matches the asset, and the replacement carries the matching media
/// signature — every other case is a typed [`MediaSurfaceError`]. The proof
/// confirms `decrypt(patched) == replacement` and records whether the change
/// was byte-identical (unchanged) or a real diff.
pub fn plan_replacement(
    surface: &MediaAssetSurface,
    key_source: &MvMzKeySource,
    original_encrypted: &[u8],
    replacement_plaintext: &[u8],
) -> Result<ReplacementPlan, MediaSurfaceError> {
    // (1) Inventory-only assets are never patched.
    if !surface.role.is_localization_surface() {
        return Err(MediaSurfaceError::NotALocalizationSurface { role: surface.role });
    }
    // (2) The key must be available (the plaintext must be producible).
    let key = key_source
        .resolve(original_encrypted, surface.capability)
        .map_err(|err| match key_resolution_state(&err) {
            MediaDecryptState::EncryptedKeyAbsent
            | MediaDecryptState::KeyMaterialInvalid { .. } => MediaSurfaceError::KeyAbsent,
            _ => MediaSurfaceError::MalformedAsset {
                reason: err.to_string(),
            },
        })?;

    // (3) Verify the ORIGINAL decrypts to the declared capability (a wrong key
    // is a declared-profile regression, surfaced typed).
    let original_plaintext = decrypt_rpgmaker_asset(original_encrypted, &key).map_err(|err| {
        MediaSurfaceError::MalformedAsset {
            reason: format!("{err:?}"),
        }
    })?;
    if !surface.capability.signature_matches(&original_plaintext) {
        return Err(MediaSurfaceError::WrongKey {
            capability: surface.capability,
        });
    }

    // (4) The replacement must be media of the asset's capability.
    if !surface.capability.signature_matches(replacement_plaintext) {
        return Err(MediaSurfaceError::ReplacementNotMedia {
            capability: surface.capability,
        });
    }

    // (5) Re-encrypt the replacement with the SAME key + re-wrap the header.
    let patched = encrypt_rpgmaker_asset(replacement_plaintext, &key);
    let decrypted_patched = decrypt_rpgmaker_asset(&patched, &key).map_err(|err| {
        MediaSurfaceError::MalformedAsset {
            reason: format!("patched asset no longer decrypts: {err:?}"),
        }
    })?;
    let decrypt_matches_replacement = decrypted_patched == replacement_plaintext;
    let differs_from_original = patched != original_encrypted;

    // (6) Byte-preservation: re-encrypting the ORIGINAL plaintext reproduces the
    // original asset exactly (the unchanged-asset guarantee).
    let identity_reencrypt = encrypt_rpgmaker_asset(&original_plaintext, &key);
    let identity_byte_preserving = identity_reencrypt == original_encrypted;

    let proof = ReplacementProof {
        mode: PatchBackMode::ReEncryptSameKey,
        role: surface.role,
        capability: surface.capability,
        original_encrypted_sha256: sha256_hash_bytes(original_encrypted),
        replacement_plaintext_sha256: sha256_hash_bytes(replacement_plaintext),
        patched_encrypted_sha256: sha256_hash_bytes(&patched),
        decrypted_patched_sha256: sha256_hash_bytes(&decrypted_patched),
        decrypt_matches_replacement,
        differs_from_original,
        identity_byte_preserving,
    };

    // A produced-but-unverified patch is an internal fault surfaced as malformed
    // (never a silent bad patch).
    if !(decrypt_matches_replacement && identity_byte_preserving) {
        return Err(MediaSurfaceError::MalformedAsset {
            reason: format!(
                "patch verify failed: decrypt_matches_replacement={decrypt_matches_replacement} identity_byte_preserving={identity_byte_preserving}"
            ),
        });
    }

    Ok(ReplacementPlan {
        patched_asset: patched,
        proof,
    })
}

impl MediaSurfaceManifest {
    /// Build a manifest from classified surfaces.
    #[must_use]
    pub fn new(profile: &MediaSurfaceProfile, surfaces: Vec<MediaAssetSurface>) -> Self {
        let localization_surface_count = surfaces
            .iter()
            .filter(|s| s.is_localization_surface)
            .count();
        let inventory_only_count = surfaces.len() - localization_surface_count;
        Self {
            schema_version: MEDIA_SURFACE_SCHEMA_VERSION.to_string(),
            source_node_id: MEDIA_SURFACE_SOURCE_NODE_ID.to_string(),
            engine_family: MEDIA_SURFACE_ENGINE_FAMILY.to_string(),
            profile_id: profile.profile_id.clone(),
            support_boundary: MEDIA_SURFACE_SUPPORT_BOUNDARY.to_string(),
            surfaces,
            localization_surface_count,
            inventory_only_count,
        }
    }

    /// The Itotori decision handoffs for every asset (kaifuu classifies;
    /// Itotori decides).
    #[must_use]
    pub fn decisions(&self) -> Vec<MediaAssetDecision> {
        self.surfaces.iter().map(|s| s.decision.clone()).collect()
    }

    fn redacted_for_report(&self) -> Self {
        let mut clone = self.clone();
        clone.surfaces = self
            .surfaces
            .iter()
            .map(MediaAssetSurface::redacted_for_report)
            .collect();
        clone
    }

    /// Deterministic stable JSON. Carries roles / hashes / counts / structural
    /// paths only — never media bytes, never the key. Any secret-looking value
    /// is redacted as defense-in-depth.
    pub fn stable_json(&self) -> Result<String, MediaManifestError> {
        stable_json(&self.redacted_for_report()).map_err(|err| MediaManifestError(err.to_string()))
    }
}

/// A `ProofHash` helper kept for parity with the slice (validates a
/// sha256 commitment before it is published).
#[must_use]
pub fn commitment(bytes: &[u8]) -> Option<ProofHash> {
    ProofHash::new(sha256_hash_bytes(bytes)).ok()
}
