#[test]
fn xp3_inventory_cli_reports_public_plain_profile_entries() {
    let root = temp_dir("public-xp3-inventory-cli");
    let fixture_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix");
    let game_dir = fixture_root.join("xp3-profiles/plain");
    let inventory_path = root.join("inventory.json");

    run_cli(&[
        "asset-inventory",
        game_dir.to_str().unwrap(),
        "--output",
        inventory_path.to_str().unwrap(),
    ]);

    let inventory: AssetInventoryManifest = read_json(&inventory_path).unwrap();
    assert_eq!(
        inventory.adapter_id,
        kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
    );
    assert_eq!(inventory.validate().status, OperationStatus::Passed);

    let archive = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "data.xp3")
        .unwrap();
    assert_eq!(
        archive.metadata.get("profileId").map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );
    assert_eq!(
        archive.metadata.get("entryCount").map(String::as_str),
        Some("3")
    );

    let intro = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "scenario/intro.ks")
        .unwrap();
    assert_eq!(intro.asset_kind, AssetInventoryAssetKind::Script);
    assert_eq!(
        intro.source_hash.as_deref(),
        Some(sha256_hash_bytes(b"hello public xp3\n").as_str())
    );
    assert_eq!(
        intro.metadata.get("originalSize").map(String::as_str),
        Some("17")
    );
    assert_eq!(
        intro.metadata.get("archiveSize").map(String::as_str),
        Some("17")
    );
    assert_eq!(
        intro.metadata.get("compressed").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        intro.metadata.get("profileId").map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );

    let compressed = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "scenario/compressed.ks")
        .unwrap();
    assert_eq!(
        compressed.source_hash.as_deref(),
        Some(sha256_hash_bytes(b"compressed public payload\n").as_str())
    );
    assert_eq!(
        compressed.metadata.get("originalSize").map(String::as_str),
        Some("26")
    );
    assert_eq!(
        compressed.metadata.get("archiveSize").map(String::as_str),
        Some("26")
    );
    assert_eq!(
        compressed.metadata.get("compressed").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        compressed.metadata.get("storedAdler32").map(String::as_str),
        Some("adler32:33334444")
    );
    assert_eq!(
        compressed.metadata.get("profileId").map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );

    let image = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "image/title.png")
        .unwrap();
    assert_eq!(image.asset_kind, AssetInventoryAssetKind::Image);
    assert_eq!(
        image.source_hash.as_deref(),
        Some(sha256_hash_bytes(b"png fixture bytes\n").as_str())
    );
    assert_eq!(
        image.metadata.get("originalSize").map(String::as_str),
        Some("18")
    );
    assert_eq!(
        image.metadata.get("archiveSize").map(String::as_str),
        Some("18")
    );
    assert_eq!(
        image.metadata.get("compressed").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        image.metadata.get("profileId").map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_inventory_cli_rejects_encrypted_and_helper_required_profiles() {
    let root = temp_dir("xp3-inventory-cli-diagnostics");
    let encrypted_dir = root.join("encrypted");
    fs::create_dir_all(&encrypted_dir).unwrap();
    fs::write(
        encrypted_dir.join("data.xp3"),
        b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
    )
    .unwrap();
    let encrypted_output = root.join("encrypted.json");
    let encrypted_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            encrypted_dir.to_str().unwrap(),
            "--output",
            encrypted_output.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(encrypted_error.contains("kaifuu.missing_capability.crypto"));

    let helper_dir = root.join("helper");
    fs::create_dir_all(&helper_dir).unwrap();
    fs::write(
        helper_dir.join("data.xp3"),
        b"XP3\r\nXP3-HELPER-REQUIRED\nfixture-only helper-required archive",
    )
    .unwrap();
    let helper_output = root.join("helper.json");
    let helper_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            helper_dir.to_str().unwrap(),
            "--output",
            helper_output.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(helper_error.contains("kaifuu.helper_required"));

    let _ = fs::remove_dir_all(root);
}
