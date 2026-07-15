use kaifuu_core::{ProofHash, SecretRef, sha256_hash_bytes};

use super::{
    COMPRESSION_LZSS, FIXTURE_SCENE_ID, FIXTURE_SCENE_UNITS, SCENE_SMOKE_MAGIC,
    SYNTHETIC_KNOWN_KEY, SYNTHETIC_KNOWN_KEY_SECRET_REF,
    codec::{
        Reader, build_scene_container, parse_source_unit_key, source_unit_key, utf16le_encode,
    },
    model::{
        KnownKeyMaterial, KnownKeySmokeError, SiglusKnownKeyCompression, SiglusKnownKeyProfile,
        SiglusSceneExtraction, SiglusSceneUnit, check_in_profile,
        known_key_material_from_resolved_secret, resolve_known_key,
    },
};

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
