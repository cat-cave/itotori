/// Resolve this crate's manifest directory for locating tracked test
/// fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked into the binary at COMPILE time, so
/// a test binary reused from a different (since-removed) worktree points
/// fixture reads at a dead path and fails with an opaque
/// `Os { code: 2, NotFound }`. `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// test binary's RUNTIME environment to the LIVE crate directory of the
/// current invocation; prefer that, falling back to the compile-time
/// constant only when run outside cargo. Lookup only — never writes, so
/// tracked fixtures stay strictly read-only.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

/// ALPHA-006a — the alpha extract entrypoint sources Oshioki Sweetie HD
/// BY-ID through the read-only vault adapter and yields a `Seen.txt` whose
/// per-file sha256 equals the known direct-path bytes. Env-gated + ignored;
/// run against the real vault with:
/// ```text
/// ITOTORI_VAULT_ROOT=/archive/vault \
/// cargo test -p kaifuu-cli vault_sourced_extract -- --ignored --nocapture
#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn vault_sourced_extract_resolves_sweetie_hd_by_id_to_known_seen_bytes() {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    const SWEETIE_CANONICAL_ID: &str =
        "oshioki-sweetie-koi-suru-onee-san-wa-urahara-desu.vj013077.v1-0.ja";
    const SWEETIE_SEEN_SHA256: &str =
        "903f538b821a9b1e6cb3d399582915c0bcf73b0a058ecc907caf6017a4fa209f";

    // Real-bytes coverage is STRICT (see the real_corpus support helper):
    // this ignored proof runs only in the periodic ground-truth oracle,
    // where the live vault is staged. An absent vault is an unconditional
    // hard failure — there is NO opt-out.
    assert_eq!(
        std::env::var("ITOTORI_VAULT_ROOT").ok().as_deref(),
        Some("/archive/vault"),
        "real-bytes coverage is STRICT: set ITOTORI_VAULT_ROOT=/archive/vault to run this \
             vault-sourced proof (it runs in the periodic ground-truth oracle where the vault \
             is staged)"
    );

    let tree_root = resolve_reallive_game_root_via_vault(SWEETIE_CANONICAL_ID)
        .expect("by-id vault sourcing must resolve Sweetie HD");
    let seen_path = resolve_reallive_seen_path(&tree_root)
        .expect("REALLIVEDATA/Seen.txt under the vault-sourced tree");
    let bytes = std::fs::read(&seen_path).expect("read vault-sourced Seen.txt");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha = hasher.finalize().iter().fold(String::new(), |mut acc, b| {
        let _ = write!(acc, "{b:02x}");
        acc
    });
    eprintln!("[alpha-006a] vault-sourced Sweetie HD Seen.txt sha256 = {sha}");
    assert_eq!(
        sha, SWEETIE_SEEN_SHA256,
        "vault by-id sourced Seen.txt must equal the known direct-path bytes"
    );
}

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterCapabilityMatrix, AdapterFailure,
    AdapterWarning, ArchiveDetectionSignal, ArchiveDetectionStatus, AssetInventoryAsset,
    AssetInventoryAssetKind, AssetInventoryAssetRef, AssetInventoryPatchMode,
    AssetInventorySurface, AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind,
    AssetList, AssetListRequest, AssetProfile, BridgeBundle, BridgeUnit, Capability,
    CapabilityLevelStatus, CapabilityReport, CapabilityStatus, CodecTransform, ContainerTransform,
    CryptoTransform, DetectRequest, DetectionEvidence, DetectionReportStatus, DetectionResult,
    EngineProfile, EvidenceStatus, ExtractionResult, GoldenAssertionStatus, GoldenRoundTripReport,
    HelperCapability, LayeredAccessCapabilityContract, LayeredAccessPreflightReport,
    LayeredAccessPreflightRequirement, LayeredAccessProfile, LayeredAccessStage, OperationStatus,
    PatchExportEntry, PatchRef, PatchResult, ProfileRequirement, ProtectedSpanMapping,
    REDACTED_DETECTION_GAME_DIR, RequirementCategory, RequirementStatus, SemanticErrorCode,
    TextSurface, VerificationResult, XP3_PLAIN_MAGIC, content_hash, deterministic_id, read_json,
    sha256_hash_bytes,
};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::reallive_commands::{
    UnknownOpcodeGate, evaluate_unknown_opcode_gate, read_gameexe_inventory_bytes,
    reallive_patch_read_source_error, reallive_patch_source_mutated_error,
    reallive_patch_write_target_error, resolve_reallive_game_root_via_vault,
    resolve_reallive_seen_path,
};

const TEST_ADAPTER_ID: &str = "kaifuu.test.registry";

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("kaifuu-cli-{name}-{}-{nonce}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn without_bgi_detection(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(detections) = value
        .get_mut("detections")
        .and_then(serde_json::Value::as_array_mut)
    {
        detections.retain(|detection| {
            detection
                .get("adapterId")
                .and_then(serde_json::Value::as_str)
                != Some(kaifuu_engine_fixture::BGI_BYTECODE_ADAPTER_ID)
        });
    }
    value
}

fn assert_bgi_detection_absent_or_undetected(report: &DetectionReport) {
    if let Some(detection) = report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::BGI_BYTECODE_ADAPTER_ID)
    {
        assert!(
            !detection.detected,
            "BGI adapter row is allowed here only as an undetected registry row"
        );
    }
}

fn build_synthetic_seen_txt_two_scenes() -> Vec<u8> {
    let one_scene = crate::binary_patch_smoke::build_synthetic_seen_txt();
    let index = kaifuu_reallive::parse_archive(&one_scene).unwrap();
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .unwrap();
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let blob = &one_scene[blob_start..blob_end];
    let directory_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut out = vec![0u8; directory_len + (blob.len() * 2)];
    let scene1_offset = directory_len as u32;
    let scene2_offset = (directory_len + blob.len()) as u32;
    out[8..12].copy_from_slice(&scene1_offset.to_le_bytes());
    out[12..16].copy_from_slice(&(blob.len() as u32).to_le_bytes());
    out[16..20].copy_from_slice(&scene2_offset.to_le_bytes());
    out[20..24].copy_from_slice(&(blob.len() as u32).to_le_bytes());
    out[directory_len..directory_len + blob.len()].copy_from_slice(blob);
    out[directory_len + blob.len()..].copy_from_slice(blob);
    out
}

#[test]
fn whole_seen_extract_writes_one_multi_scene_bridge() {
    // `kaifuu extract --whole-seen` produces the BRIDGE (pure kaifuu decode)
    // — NOT the replay-derived narrative structure. Deriving the structure /
    // `sceneDispatchOrder` needs the Utsushi replay runtime and kaifuu must
    // never depend on utsushi (deps flow utsushi → kaifuu); the structure is
    // produced separately by `utsushi-cli structure` and fed to the driver as
    // its own input. So this test asserts ONLY the bridge + decompile report.
    let root = temp_dir("whole-seen-extract");
    let game_root = root.join("game");
    let data_root = game_root.join("REALLIVEDATA");
    fs::create_dir_all(&data_root).unwrap();
    let seen_bytes = build_synthetic_seen_txt_two_scenes();
    fs::write(data_root.join("Seen.txt"), &seen_bytes).unwrap();
    fs::write(data_root.join("Gameexe.ini"), b"#SEEN_START=1\n").unwrap();

    let bridge_path = root.join("whole-bridge.json");
    let report_path = root.join("whole-decompile-report.json");
    run_extract_reallive_bundle(
        &[
            "extract",
            "--engine",
            "reallive",
            "--game-root",
            game_root.to_str().unwrap(),
            "--game-id",
            "kaifuu-reallive-synthetic",
            "--game-version",
            "1.0.0",
            "--source-profile-id",
            "kaifuu-reallive-synthetic",
            "--source-locale",
            "ja-JP",
            "--whole-seen",
            "--bundle-output",
            bridge_path.to_str().unwrap(),
            "--decompile-report-output",
            report_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .unwrap();

    let bridge: serde_json::Value = read_json(&bridge_path).unwrap();
    let validated = kaifuu_core::BridgeBundleV02::validate_json(&bridge).unwrap();
    assert_eq!(validated.assets.len(), 2);
    assert!(
        validated
            .units
            .iter()
            .any(|unit| unit.source_unit_key.starts_with("reallive:scene-0001#"))
    );
    assert!(
        validated
            .units
            .iter()
            .any(|unit| unit.source_unit_key.starts_with("reallive:scene-0002#"))
    );
    assert_eq!(bridge["sourceBundleHash"], sha256_hash_bytes(&seen_bytes));

    // Every whole-SEEN bridge unit carries its numeric scene in
    // `context.route.sceneKey` (`scene-NNNN`) — the field the whole-game
    // localize driver's structure resolver parses. Assert both scenes'
    // units are keyed, so the bridge→driver handoff is real end-to-end
    // (the driver joins this route key to the utsushi-produced structure).
    let unit_scene_keys: BTreeSet<String> = bridge["units"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|unit| unit["context"]["route"]["sceneKey"].as_str())
        .map(str::to_string)
        .collect();
    assert!(
        unit_scene_keys.contains("scene-0001"),
        "expected a unit routed to scene-0001; got {unit_scene_keys:?}"
    );
    assert!(
        unit_scene_keys.contains("scene-0002"),
        "expected a unit routed to scene-0002; got {unit_scene_keys:?}"
    );

    let report: serde_json::Value = read_json(&report_path).unwrap();
    assert_eq!(report["scope"], "whole-seen");
    assert_eq!(report["sceneCount"], 2);
    assert_eq!(report["unknownOpcodes"], 0);
    // A fully-recognised SEEN carries an empty tuple list and passes the
    // decode-honesty gate cleanly (the command above returned Ok).
    assert_eq!(report["unknownOpcodeTuples"], serde_json::json!([]));

    let _ = fs::remove_dir_all(root);
}

/// Frame `bytecode` into a single-scene synthetic Seen.txt (real 10,000-slot
/// directory + 0x1d0 scene header + AVG32 literal compression), scene at
/// slot 1. Mirrors `binary_patch_smoke::build_synthetic_seen_txt` but takes
/// arbitrary decompressed bytecode so a scene can carry an UNCATALOGUED
/// command (the decode-honesty gate's failure input).
fn build_synthetic_seen_txt_with_bytecode(bytecode: &[u8]) -> Vec<u8> {
    let compressed =
        kaifuu_reallive::compress_avg32_literal(bytecode).expect("synthetic bytecode compresses");
    let header_len = kaifuu_reallive::SCENE_HEADER_BYTE_LEN;
    let mut header = vec![0u8; header_len];
    header[0..4].copy_from_slice(&(header_len as u32).to_le_bytes());
    // Non-`xor_2` compiler version (110001): a plaintext synthetic scene.
    header[4..8].copy_from_slice(&110_001u32.to_le_bytes());
    header[0x20..0x24].copy_from_slice(&(header_len as u32).to_le_bytes());
    header[0x24..0x28].copy_from_slice(&(bytecode.len() as u32).to_le_bytes());
    header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
    let mut blob = header;
    blob.extend_from_slice(&compressed);

    let directory_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut archive = vec![0u8; directory_len + blob.len()];
    let slot1 = 8usize;
    archive[slot1..slot1 + 4].copy_from_slice(&(directory_len as u32).to_le_bytes());
    archive[slot1 + 4..slot1 + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
    archive[directory_len..].copy_from_slice(&blob);
    archive
}

/// One synthetic scene whose bytecode carries an UNCATALOGUED in-space
/// command (`module_type 1, module_id 99, opcode 999`) — the generic
/// `Command` blob that fails `is_recognized` — alongside ordinary
/// recognised elements. This is the decode-honesty gate's failure fixture.
fn synthetic_seen_with_unknown_command() -> Vec<u8> {
    fn command_header(module_type: u8, module_id: u8, opcode: u16, argc: u8) -> [u8; 8] {
        let [lo, hi] = opcode.to_le_bytes();
        [0x23, module_type, module_id, lo, hi, argc, 0x00, 0x00]
    }
    let mut bytecode = Vec::new();
    bytecode.extend_from_slice(&[0x0A, 0x02, 0x00]); // MetaLine(2)
    bytecode.extend_from_slice(&[0x21, 0x00, 0x00]); // MetaEntrypoint(0)
    bytecode.extend_from_slice(&[0x40, 0x01, 0x00]); // MetaKidoku(1)
    bytecode.extend_from_slice(&command_header(1, 3, 3, 0)); // CharacterTextDisplay
    bytecode.extend_from_slice(&[0x82, 0xA0, 0x82, 0xA2]); // Textout "あい"
    bytecode.extend_from_slice(&command_header(1, 99, 999, 0)); // UNCATALOGUED command
    bytecode.extend_from_slice(&command_header(1, 4, 17, 0)); // End (module_sys op 17)
    build_synthetic_seen_txt_with_bytecode(&bytecode)
}

fn stage_synthetic_reallive_game(name: &str, seen_bytes: &[u8]) -> (PathBuf, PathBuf) {
    let root = temp_dir(name);
    let game_root = root.join("game");
    let data_root = game_root.join("REALLIVEDATA");
    fs::create_dir_all(&data_root).unwrap();
    fs::write(data_root.join("Seen.txt"), seen_bytes).unwrap();
    fs::write(data_root.join("Gameexe.ini"), b"#SEEN_START=1\n").unwrap();
    (root, game_root)
}

fn whole_seen_extract_args(
    game_root: &Path,
    bridge_path: &Path,
    report_path: &Path,
    extra: &[&str],
) -> Vec<String> {
    let mut args = vec![
        "extract",
        "--engine",
        "reallive",
        "--game-root",
        game_root.to_str().unwrap(),
        "--game-id",
        "kaifuu-reallive-synthetic",
        "--game-version",
        "1.0.0",
        "--source-profile-id",
        "kaifuu-reallive-synthetic",
        "--source-locale",
        "ja-JP",
        "--whole-seen",
        "--bundle-output",
        bridge_path.to_str().unwrap(),
        "--decompile-report-output",
        report_path.to_str().unwrap(),
    ];
    args.extend_from_slice(extra);
    args.iter().map(std::string::ToString::to_string).collect()
}

#[test]
fn whole_seen_extract_fails_loud_on_unknown_opcode_and_emits_tuple_list() {
    // A SEEN with an uncatalogued command must (a) surface the full
    // `(module_type, module_id, opcode)` tuple list in the report, and
    // (b) FAIL LOUD by default — non-zero exit (Err) with a clearly-flagged
    // INCOMPLETE DECODE message naming the tuple — never a silent green.
    let (root, game_root) =
        stage_synthetic_reallive_game("whole-seen-unknown", &synthetic_seen_with_unknown_command());
    let bridge_path = root.join("whole-bridge.json");
    let report_path = root.join("whole-decompile-report.json");

    let err = run_extract_reallive_bundle(&whole_seen_extract_args(
        &game_root,
        &bridge_path,
        &report_path,
        &[],
    ))
    .expect_err("nonzero unknown opcodes must fail loud by default");
    let message = err.to_string();
    assert!(
        message.contains("INCOMPLETE DECODE"),
        "fail message must be clearly flagged: {message}"
    );
    assert!(
        message.contains("99") && message.contains("999"),
        "fail message must name the uncatalogued tuple: {message}"
    );

    // The report artifact is still written so the failure is triageable,
    // and it carries the full tuple list, not just the aggregate count.
    let report: serde_json::Value = read_json(&report_path).unwrap();
    assert_eq!(report["unknownOpcodes"], 1);
    assert_eq!(
        report["unknownOpcodeTuples"],
        serde_json::json!([{ "moduleType": 1, "moduleId": 99, "opcode": 999, "count": 1 }])
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn whole_seen_extract_allow_unknown_downgrades_to_warning() {
    // The explicit opt-in flag downgrades the hard failure to a warning:
    // the command SUCCEEDS (Ok) but the report still carries the tuple
    // list so the incomplete decode is never hidden.
    let (root, game_root) = stage_synthetic_reallive_game(
        "whole-seen-unknown-allow",
        &synthetic_seen_with_unknown_command(),
    );
    let bridge_path = root.join("whole-bridge.json");
    let report_path = root.join("whole-decompile-report.json");

    run_extract_reallive_bundle(&whole_seen_extract_args(
        &game_root,
        &bridge_path,
        &report_path,
        &["--allow-unknown-opcodes"],
    ))
    .expect("--allow-unknown-opcodes downgrades the gate to a warning (Ok)");

    let report: serde_json::Value = read_json(&report_path).unwrap();
    assert_eq!(report["unknownOpcodes"], 1);
    assert_eq!(
        report["unknownOpcodeTuples"],
        serde_json::json!([{ "moduleType": 1, "moduleId": 99, "opcode": 999, "count": 1 }])
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn evaluate_unknown_opcode_gate_verdicts() {
    let mut signatures: BTreeMap<(u8, u8, u16), usize> = BTreeMap::new();
    signatures.insert((1, 99, 999), 2);

    // Zero unknown → clean regardless of the opt-in flag.
    assert!(matches!(
        evaluate_unknown_opcode_gate(0, &BTreeMap::new(), false),
        UnknownOpcodeGate::Clean
    ));
    // Nonzero unknown, default → fail with the tuple in the message.
    match evaluate_unknown_opcode_gate(2, &signatures, false) {
        UnknownOpcodeGate::Fail(message) => {
            assert!(message.contains("INCOMPLETE DECODE"));
            assert!(message.contains("999"));
        }
        other => panic!("expected Fail by default, got {other:?}"),
    }
    // Nonzero unknown, opt-in → warn (still surfaces the tuple).
    match evaluate_unknown_opcode_gate(2, &signatures, true) {
        UnknownOpcodeGate::Warn(message) => {
            assert!(message.contains("WARNING"));
            assert!(message.contains("999"));
        }
        other => panic!("expected Warn with opt-in, got {other:?}"),
    }
}
