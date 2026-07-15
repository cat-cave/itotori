use kaifuu_core::SecretRef;

use super::{
    FIXTURE_GAMEEXE_ENTRIES, GAMEEXE_SMOKE_MAGIC, SYNTHETIC_KNOWN_KEY,
    SYNTHETIC_KNOWN_KEY_SECRET_REF,
    codec::{Reader, build_gameexe_container, utf16le_decode, utf16le_encode},
    model::{
        KnownKeyMaterial, KnownKeySmokeError, SiglusGameexeEntry, SiglusGameexeExtraction,
        SiglusKnownKeyCompression, SiglusKnownKeyProfile, check_in_profile,
        known_key_material_from_resolved_secret, resolve_known_key,
    },
};

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
