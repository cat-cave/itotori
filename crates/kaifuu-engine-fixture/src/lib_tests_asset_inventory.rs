use super::*;

#[test]
fn fixture_asset_inventory_reports_non_text_surfaces_without_patching_support() {
    let game_dir = hello_fixture_dir();
    let manifest = FixtureAdapter
        .asset_inventory(AssetInventoryRequest {
            game_dir: &game_dir,
        })
        .unwrap();

    assert_eq!(manifest.validate().status, OperationStatus::Passed);
    assert_eq!(manifest.assets.len(), 11);
    assert_eq!(manifest.surfaces.len(), 6);
    let surface_kinds = manifest
        .surfaces
        .iter()
        .map(|surface| serde_json::to_string(&surface.asset_surface_kind).unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        surface_kinds,
        [
            "\"credits\"",
            "\"font\"",
            "\"image_text\"",
            "\"song_title\"",
            "\"ui_art\"",
            "\"video\"",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
    );
    assert!(manifest.surfaces.iter().all(|surface| {
        surface.patching.capability == Capability::AssetTextPatching
            && surface.patching.status == kaifuu_core::CapabilityStatus::Unsupported
    }));
    assert!(
        manifest
            .surfaces
            .iter()
            .all(|surface| { surface.text_source_kind != AssetInventoryTextSourceKind::OcrHint })
    );
    assert!(manifest.surfaces.iter().any(|surface| {
        surface.asset_surface_kind == AssetInventorySurfaceKind::Font
            && surface.source_text.is_none()
            && surface.text_source_kind == AssetInventoryTextSourceKind::NotApplicable
    }));
}

#[test]
fn fixture_asset_inventory_metadata_round_trips_stably() {
    let game_dir = hello_fixture_dir();
    let manifest = FixtureAdapter
        .asset_inventory(AssetInventoryRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    // `AssetInventoryManifest::stable_json` is report-safe: it routes
    // through the centralized redaction policy, so the public serialization
    // is a fixed point (re-serializing the round-tripped manifest is
    // stable) rather than a lossless round-trip of the raw struct. Non
    // sensitive asset metadata still survives redaction.
    let serialized = manifest.stable_json().unwrap();
    let round_tripped: AssetInventoryManifest = serde_json::from_str(&serialized).unwrap();

    assert_eq!(round_tripped.stable_json().unwrap(), serialized);
    assert_eq!(round_tripped.validate().status, OperationStatus::Passed);
    let audio_asset = round_tripped
        .assets
        .iter()
        .find(|asset| asset.asset_id == "asset-audio-moonlit-path")
        .unwrap();
    assert_eq!(
        audio_asset.metadata.get("titleField").map(String::as_str),
        Some("vorbisComment.TITLE")
    );
}

#[test]
fn fixture_asset_inventory_matches_reviewed_fixture_manifest() {
    let game_dir = hello_fixture_dir();
    let mut manifest = FixtureAdapter
        .asset_inventory(AssetInventoryRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    let mut expected: AssetInventoryManifest =
        serde_json::from_str(&fs::read_to_string(expected_asset_inventory_path()).unwrap())
            .unwrap();

    manifest.normalize();
    expected.normalize();
    assert_eq!(manifest.validate().status, OperationStatus::Passed);
    assert_eq!(expected.validate().status, OperationStatus::Passed);
    assert_eq!(manifest, expected);
}

#[test]
fn fixture_profile_json_is_stable() {
    let game_dir = temp_game("profile");
    let first = FixtureAdapter
        .profile(ProfileRequest {
            game_dir: &game_dir,
        })
        .unwrap()
        .stable_json()
        .unwrap();
    let second = FixtureAdapter
        .profile(ProfileRequest {
            game_dir: &game_dir,
        })
        .unwrap()
        .stable_json()
        .unwrap();
    assert_eq!(first, second);
    assert!(first.contains("\"capability\": \"line_parity_patching\""));
    assert!(first.contains("\"container\": \"identity\""));
    assert!(first.contains("\"crypto\": \"null_key\""));
    assert!(first.contains("\"codec\": \"identity\""));
    let _ = fs::remove_dir_all(game_dir);
}
