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

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, sha256_hash_bytes,
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

mod codec;
mod gameexe;
mod model;
mod report;
mod scene;

pub use gameexe::{build_synthetic_gameexe_fixture, extract_gameexe};
pub use model::{
    KnownKeySmokeError, SiglusGameexeEntry, SiglusGameexeExtraction, SiglusKnownKeyCompression,
    SiglusKnownKeyContainerSource, SiglusKnownKeyEncoding, SiglusKnownKeyProfile,
    SiglusSceneExtraction, SiglusSceneUnit,
};
pub use report::{
    GameexeEntryDigest, GameexeExtractionReport, OutOfProfileReport, PatchRoundTripReport,
    SceneExtractionReport, SceneUnitDigest, SiglusKnownKeyCapability, SiglusKnownKeyPatchSpec,
    SiglusKnownKeySmokeFixture, SiglusKnownKeySmokeReport,
};
pub use scene::{
    ScenePatchVerification, build_synthetic_out_of_profile_scene_fixture,
    build_synthetic_scene_fixture, extract_scene, patch_and_verify_scene, patch_scene_unit,
};

pub(crate) use codec::{parse_source_unit_index, utf16le_encode};
pub(crate) use gameexe::{
    GameexeRecordLayout, extract_gameexe_with, patch_gameexe_value_with,
    read_gameexe_record_layout, reemit_gameexe_records,
};
pub(crate) use model::{KnownKeyMaterial, resolve_known_key};
pub(crate) use scene::{
    SceneRecordLayout, extract_scene_with, patch_scene_unit_with, read_scene_record_layout,
    reemit_scene_records,
};

#[cfg(test)]
use kaifuu_core::SecretRef;
#[cfg(test)]
use model::known_key_material_from_resolved_secret;
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
