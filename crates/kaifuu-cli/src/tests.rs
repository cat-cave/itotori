use super::*;

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

/// Fixture generator (run manually) — regenerates the committed
/// `apps/itotori/test/fixtures/whole-seen-bridge.json` from the SAME
/// `--whole-seen` command path the CLI exposes, so the TS whole-game driver
/// test can feed the ACTUAL bridge output (not a hand-built bridge) into the
/// driver and prove end-to-end consumability. The matching structure fixture
/// (`whole-seen-structure.json`) is regenerated on the UTSUSHI side (kaifuu
/// no longer produces structure), by the `utsushi-cli` structure fixture
/// generator. Regenerate with:
/// `cargo test -p kaifuu-cli --bin kaifuu-cli \
/// regenerate_whole_seen_ts_driver_fixture -- --ignored`
#[test]
#[ignore = "fixture generator; run manually to regenerate the TS driver bridge fixture"]
fn regenerate_whole_seen_ts_driver_fixture() {
    let root = temp_dir("whole-seen-ts-fixture");
    let game_root = root.join("game");
    let data_root = game_root.join("REALLIVEDATA");
    fs::create_dir_all(&data_root).unwrap();
    let seen_bytes = build_synthetic_seen_txt_two_scenes();
    fs::write(data_root.join("Seen.txt"), &seen_bytes).unwrap();
    fs::write(data_root.join("Gameexe.ini"), b"#SEEN_START=1\n").unwrap();

    // Emit into the crate-relative committed fixtures dir.
    let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("apps/itotori/test/fixtures");
    let bridge_path = fixtures_dir.join("whole-seen-bridge.json");

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
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .unwrap();

    // Sanity: the emitted bridge is schema-valid + carries scene route keys.
    let bridge: serde_json::Value = read_json(&bridge_path).unwrap();
    kaifuu_core::BridgeBundleV02::validate_json(&bridge).unwrap();
    let _ = fs::remove_dir_all(root);
}

/// Probe helper (run manually) — materialize the synthetic 2-scene
/// Seen.txt + Gameexe.ini to a STABLE scratch path so the utsushi-side
/// `structure` command / fixture generator can run over the SAME archive
/// the kaifuu bridge fixture is built from. Not part of any gate.
#[test]
#[ignore = "probe helper; materializes the synthetic archive to /tmp for manual utsushi runs"]
fn materialize_synthetic_two_scene_archive_to_scratch() {
    let dir = PathBuf::from("/tmp/itotori-synth-archive/REALLIVEDATA");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("Seen.txt"), build_synthetic_seen_txt_two_scenes()).unwrap();
    fs::write(dir.join("Gameexe.ini"), b"#SEEN_START=1\n").unwrap();
}

#[test]
fn helper_run_fixture_stub_writes_helper_result() {
    let root = temp_dir("helper-run-fixture-stub");
    let output = root.join("helper-result.json");

    run_with_args(vec![
        "helper".to_string(),
        "run".to_string(),
        "--profile".to_string(),
        "fixture".to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["schemaVersion"], "0.1.0");
    assert_eq!(report["diagnostic"]["code"], "success");
    assert_eq!(report["redaction"]["status"], "redacted");
    assert!(report.get("stdout").is_none());
    assert!(report.get("stderr").is_none());
    assert!(validate_helper_result_value(&report).failures.is_empty());
}

#[test]
fn compat_evidence_fixture_writes_integrated_report() {
    // The `--fixture` mode integrates the committed synthetic sources into
    // one suite-readable report, listing all three sources per claimed
    // support, and writes the REDACTED artifact.
    let root = temp_dir("compat-evidence-fixture");
    let output = root.join("compat-evidence.json");

    run_with_args(vec![
        "compat-evidence".to_string(),
        "--fixture".to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["schemaVersion"], "0.1.0");
    assert_eq!(report["status"], "passed");
    assert_eq!(report["bundleSelfSufficient"], true);
    let supports = report["supports"].as_array().expect("supports array");
    assert_eq!(supports.len(), 2);
    // Each claimed support lists every acceptance field from all three
    // sources.
    for support in supports {
        for field in [
            "engineFamily",
            "engineVariant",
            "container",
            "crypto",
            "codec",
            "surface",
            "patchBackMode",
            "profileOrFixtureId",
            "secretRequirementIds",
            "diagnostics",
            "reproBundleIndex",
            "latestRegression",
        ] {
            assert!(
                support.get(field).is_some(),
                "claimed support must list {field}: {support}"
            );
        }
        // index + verdict are wired.
        assert!(support["reproBundleIndex"]["fixtureId"].is_string());
        assert_eq!(support["latestRegression"]["status"], "passed");
    }
    // Redaction-clean: ref-only, no raw material.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(serialized.contains("sha256:"));
    assert!(!serialized.contains("BEGIN"));
    assert!(!serialized.contains("/home/"));
}

#[test]
fn asset_ocr_public_fixture_matches_committed_golden() {
    // the public fixture command emits schema-valid text regions
    // with provenance + stable content hashes; the output is byte-pinned to a
    // committed golden. Set KAIFUU_026_REGEN=1 to rewrite the golden.
    let root = temp_dir("asset-ocr-public-fixture");
    let output = root.join("title-card.text-regions.json");
    let asset = public_fixture_path("fixtures/public/ocr-ui/title-card.png");
    let golden = public_fixture_path("fixtures/public/ocr-ui/title-card.text-regions.golden.json");

    run_with_args(vec![
        "asset-ocr".to_string(),
        asset.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let produced = fs::read_to_string(&output).unwrap();
    if std::env::var_os("KAIFUU_026_REGEN").is_some() {
        fs::write(&golden, &produced).unwrap();
    }
    let committed = fs::read_to_string(&golden).unwrap();
    assert_eq!(
        produced, committed,
        "asset-ocr output drifted from the committed golden; regen with KAIFUU_026_REGEN=1"
    );

    let report: serde_json::Value = serde_json::from_str(&produced).unwrap();
    assert_eq!(report["sourceNodeId"], "KAIFUU-026");
    // Three confident regions recover exact text; two uncertain regions are
    // findings (NOT asserted as recovered text).
    let regions = report["textRegions"].as_array().unwrap();
    assert_eq!(regions.len(), 5);
    let recovered: Vec<&str> = regions
        .iter()
        .filter_map(|region| region["recognition"]["recoveredText"].as_str())
        .collect();
    assert_eq!(recovered, ["NEW", "GAME", "LOAD"]);
    let findings = report["findings"].as_array().unwrap();
    assert_eq!(findings.len(), 2);
    // The uncertain "LOAD" read is a candidate on a finding, never truth.
    let uncertain = findings
        .iter()
        .find(|finding| finding["code"] == "uncertain_text_region")
        .unwrap();
    assert_eq!(uncertain["source"]["candidateText"], "LOAD");
    assert!(uncertain["source"]["provenance"].is_object());
    // Provenance + content hashes present.
    assert!(
        report["asset"]["contentHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    for region in regions {
        assert!(
            region["contentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert!(
            region["provenance"]["assetContentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
    }
    // No local path leakage.
    assert!(!produced.contains("/home/"));
    assert!(!produced.contains("/scratch/"));
}

#[test]
fn reallive_patch_read_write_and_source_mutation_diagnostics_redact_private_paths() {
    let source_seen = PathBuf::from("/home/dev/private-game/REALLIVEDATA/Seen.txt");
    let target_seen = PathBuf::from("/home/dev/private-target/REALLIVEDATA/Seen.txt");
    let read_error = reallive_patch_read_source_error(
        &source_seen,
        &io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
    );
    let write_error = reallive_patch_write_target_error(
        &target_seen,
        &io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
    );
    let source_mutated_error =
        reallive_patch_source_mutated_error(&source_seen, "before-hash", "after-hash");

    for rendered in [read_error, write_error, source_mutated_error] {
        assert!(
            rendered.contains("[REDACTED:kaifuu.secret_redacted]"),
            "diagnostic should carry a redaction token: {rendered}"
        );
        assert!(
            !rendered.contains("/home/dev/private"),
            "diagnostic leaked a private root: {rendered}"
        );
        assert!(
            rendered.contains("Seen.txt"),
            "diagnostic should preserve the public Seen.txt context: {rendered}"
        );
    }
}

#[test]
fn helper_run_rejects_arbitrary_command_flags() {
    let root = temp_dir("helper-run-command-rejected");
    let output = root.join("helper-result.json");

    let result = run_with_args(vec![
        "helper".to_string(),
        "run".to_string(),
        "--profile".to_string(),
        "fixture".to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--command".to_string(),
        "sh -c helper".to_string(),
    ]);

    let err = result.expect_err("arbitrary command flag must be rejected");
    assert!(err.to_string().contains("rejects arbitrary execution"));
    assert!(!output.exists());
}

#[test]
fn helper_run_local_mode_is_unsupported_and_never_launches_a_process() {
    // Regression guard for the deleted external helper-process launch path.
    // `helper run` is in-process fixture/stub only; requesting any non-stub
    // execution mode must fail with a structured error and never spawn.
    let root = temp_dir("helper-run-local-removed");
    let output = root.join("helper-result.json");

    let result = run_with_args(vec![
        "helper".to_string(),
        "run".to_string(),
        "--mode".to_string(),
        "local".to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--helper-binary".to_string(),
        "/bin/true".to_string(),
    ]);

    let err = result.expect_err("local helper-process launch must be unsupported");
    assert!(
        err.to_string()
            .contains("external helper-process launch is not supported"),
        "unexpected error: {err}"
    );
    assert!(!output.exists());
}

#[test]
fn key_helper_run_process_subcommand_is_removed() {
    // Regression guard: the `kaifuu key-helper run-process` external-spawn
    // subcommand has been deleted. Invoking it must fall through to usage,
    // proving no compiled path reaches an external process launch.
    let root = temp_dir("key-helper-run-process-removed");
    let output = root.join("report.json");

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "run-process".to_string(),
        "--helper-binary".to_string(),
        "/bin/true".to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    let err = result.expect_err("run-process subcommand must be removed");
    assert!(
        err.to_string()
            .contains("usage: kaifuu key-helper validate"),
        "unexpected error: {err}"
    );
    assert!(!output.exists());
}

fn temp_game(root: &Path) -> PathBuf {
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 6,
          "end": 14
        }
      ]
    }
  ]
}
"#,
    )
    .unwrap();
    game_dir
}

fn public_fixture_dir() -> PathBuf {
    test_manifest_dir().join("../../fixtures/hello-game")
}

fn native_source_patch_export() -> serde_json::Value {
    let fixture_dir = public_fixture_dir();
    let native_source_hashes: serde_json::Value =
        read_json(&fixture_dir.join("expected/native-source-hashes-v0.2.json")).unwrap();
    let hashes: BTreeMap<_, _> = native_source_hashes["sourceHashes"]
        .as_array()
        .expect("native source hash fixture sourceHashes")
        .iter()
        .map(|entry| {
            (
                entry["sourceUnitKey"]
                    .as_str()
                    .expect("native source hash fixture sourceUnitKey"),
                entry["sourceHash"]
                    .as_str()
                    .expect("native source hash fixture sourceHash"),
            )
        })
        .collect();
    let mut patch_export: serde_json::Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    for entry in patch_export["entries"]
        .as_array_mut()
        .expect("public patch entries")
    {
        let source_unit_key = entry["sourceUnitKey"]
            .as_str()
            .expect("public patch sourceUnitKey");
        entry["sourceHash"] = serde_json::Value::String(
            hashes
                .get(source_unit_key)
                .expect("native source hash for each patch entry")
                .to_string(),
        );
    }
    patch_export
}

fn native_source_hash_mismatch_patch_export() -> serde_json::Value {
    let fixture_dir = public_fixture_dir();
    let mismatch: serde_json::Value =
        read_json(&fixture_dir.join("expected/native-source-hash-mismatch-v0.2.json")).unwrap();
    let source_unit_key = mismatch["sourceUnitKey"]
        .as_str()
        .expect("native source hash mismatch sourceUnitKey");
    let mut patch_export = native_source_patch_export();
    let entry = patch_export["entries"]
        .as_array_mut()
        .expect("public patch entries")
        .iter_mut()
        .find(|entry| entry["sourceUnitKey"].as_str() == Some(source_unit_key))
        .expect("mismatched source unit in public patch");
    entry["sourceHash"] = mismatch["sourceHash"].clone();
    patch_export
}

fn public_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir().join("../..").join(relative_path)
}

fn core_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir()
        .join("../kaifuu-core")
        .join(relative_path)
}

fn write_fixture_file(root: &Path, relative_path: &str, bytes: &[u8]) {
    let path = root.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

#[derive(Clone, Copy)]
struct Xp3TestEntry<'a> {
    path: &'a str,
    payload: &'a [u8],
    compressed: bool,
    adler32: u32,
}

fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    bytes.extend_from_slice(&0_u64.to_le_bytes());

    let mut segment_offsets = Vec::new();
    for entry in entries {
        segment_offsets.push(bytes.len() as u64);
        bytes.extend_from_slice(entry.payload);
    }

    let index_offset = bytes.len() as u64;
    let mut index = Vec::new();
    for (entry, offset) in entries.iter().zip(segment_offsets) {
        let mut file = Vec::new();
        let path_units = entry.path.encode_utf16().collect::<Vec<_>>();
        let mut info = Vec::new();
        info.extend_from_slice(&0_u32.to_le_bytes());
        info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        info.extend_from_slice(&(path_units.len() as u16).to_le_bytes());
        for unit in path_units {
            info.extend_from_slice(&unit.to_le_bytes());
        }
        append_xp3_chunk(&mut file, b"info", &info);

        let mut segment = Vec::new();
        segment.extend_from_slice(&(u32::from(entry.compressed)).to_le_bytes());
        segment.extend_from_slice(&offset.to_le_bytes());
        segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        append_xp3_chunk(&mut file, b"segm", &segment);
        append_xp3_chunk(&mut file, b"adlr", &entry.adler32.to_le_bytes());
        append_xp3_chunk(&mut index, b"File", &file);
    }

    bytes.push(0);
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index);
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());
    bytes
}

fn append_xp3_chunk(output: &mut Vec<u8>, name: &[u8; 4], content: &[u8]) {
    output.extend_from_slice(name);
    output.extend_from_slice(&(content.len() as u64).to_le_bytes());
    output.extend_from_slice(content);
}

fn run_cli(args: &[&str]) {
    run_with_args(args.iter().map(std::string::ToString::to_string).collect()).unwrap();
}

fn run_cli_with_registry(args: &[&str], registry: &AdapterRegistry) {
    run_cli_with_registry_result(args, registry).unwrap();
}

fn run_cli_with_registry_result(
    args: &[&str],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_args_and_registry(
        args.iter().map(std::string::ToString::to_string).collect(),
        registry,
    )
}

#[test]
fn helper_result_validate_command_accepts_public_fixture() {
    let root = temp_dir("helper-result-valid");
    let output = root.join("helper-result-report.json");
    let fixture = public_fixture_path("fixtures/public/kaifuu-helper-results/success.json");

    run_cli(&[
        "helper-result",
        "validate",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["fixtureId"], "kaifuu-helper-success");
    assert_eq!(report["failures"].as_array().unwrap().len(), 0);
}

#[test]
fn helper_dry_run_names_five_fields_without_launching_and_matches_fixture() {
    // Public CI: no Wine/Proton, no private assets. The dry-run must resolve
    // the intended command from the synthetic request alone.
    let root = temp_dir("helper-dry-run-wine");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-wine-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    // (1) helper-binary-id, (2) platform-adapter, (3) intended-command,
    // (4) profile-id, (5) redaction-policy.
    assert_eq!(
        resolution["helperBinaryId"],
        "kaifuu.fixture.wine-local-windows"
    );
    assert_eq!(resolution["platformAdapter"], "wine-local");
    assert_eq!(resolution["intendedCommand"]["programRef"], "wine");
    assert_eq!(
        resolution["profileId"],
        "019ed000-0000-7000-8000-profile00090"
    );
    assert_eq!(
        resolution["redactionPolicy"],
        "redact-raw-logs-and-secret-refs"
    );
    // No launch.
    assert_eq!(resolution["launched"], false);
    assert_eq!(
        resolution["intendedCommand"]["launchesUntrustedCode"],
        false
    );
    // execution object carries no launch command; no raw secret.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("\"command\""));
    assert!(!serialized.contains("\"argv\""));
    assert!(!serialized.contains("\"env\""));

    // The committed resolution fixture must stay semantically identical to
    // the CLI output (formatting is owned by the repo formatter).
    let committed: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-wine-resolution.json",
    ))
    .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn helper_dry_run_unavailable_platform_emits_typed_diagnostic() {
    let root = temp_dir("helper-dry-run-unavailable");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-proton-unavailable-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(resolution["platformAdapter"], "proton-local");
    assert_eq!(
        resolution["helperResult"]["diagnostic"]["code"],
        "helper_unavailable"
    );
    assert!(
        resolution["helperResult"]["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("kaifuu.helper_unavailable")
    );
    assert_eq!(resolution["launched"], false);

    let committed: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-proton-unavailable-resolution.json",
        ))
        .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn helper_dry_run_rejects_raw_secret_material() {
    let root = temp_dir("helper-dry-run-raw-secret");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/invalid/dry-run-raw-secret-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let message = result.unwrap_err().to_string();
    assert!(message.contains("kaifuu.wine_proton.dry_run.secret_leak"));
    // The failing resolution must not be persisted at all.
    assert!(!output.exists());
}

#[test]
fn helper_dry_run_rejects_execution_config_flags() {
    let root = temp_dir("helper-dry-run-exec-flag");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/wine-proton/dry-run-wine-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--command".to_string(),
        "wine game.exe".to_string(),
    ]);

    assert!(result.is_err());
}

#[test]
fn native_windows_dry_run_records_six_fields_without_launching_and_matches_fixture() {
    // Public CI: non-Windows runner, no private assets. The dry-run must
    // resolve the intended command from the synthetic request alone.
    let root = temp_dir("helper-dry-run-native-windows");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--platform",
        "native-windows",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    // (1) platform-adapter, (2) helper-binary-id, (3) command-argv + quoted
    // command line, (4) working-directory-policy, (5) profile-id,
    // (6) redaction-policy.
    assert_eq!(resolution["platformAdapterId"], "native-windows");
    assert_eq!(resolution["platformAdapter"], "native-windows-local");
    assert_eq!(
        resolution["helperBinaryId"],
        "kaifuu.fixture.native-windows-local"
    );
    assert_eq!(
        resolution["intendedCommand"]["programRef"],
        "native-windows-helper"
    );
    assert!(
        resolution["intendedCommand"]["argumentTemplate"]
            .as_array()
            .unwrap()
            .iter()
            .any(|token| token == "--dry-run")
    );
    assert_eq!(
        resolution["intendedCommand"]["quotingRules"],
        "CommandLineToArgvW"
    );
    assert!(
        resolution["intendedCommand"]["commandLine"]
            .as_str()
            .unwrap()
            .starts_with("native-windows-helper --platform native-windows-local")
    );
    assert_eq!(
        resolution["intendedCommand"]["workingDirectoryPolicy"],
        "sandboxed-read-only-game-copy"
    );
    assert_eq!(
        resolution["profileId"],
        "019ed000-0000-7000-8000-profile00129"
    );
    assert_eq!(
        resolution["redactionPolicy"],
        "redact-raw-logs-and-secret-refs"
    );
    // No launch.
    assert_eq!(resolution["launched"], false);
    assert_eq!(
        resolution["intendedCommand"]["launchesUntrustedCode"],
        false
    );
    // The execution object carries no launch command; the quoted
    // descriptor lives under `commandLine`, not `command`/`argv`/`env`.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("\"command\""));
    assert!(!serialized.contains("\"argv\""));
    assert!(!serialized.contains("\"env\""));

    // The committed resolution fixture must stay semantically identical to
    // the CLI output.
    let committed: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-resolution.json",
        ))
        .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn native_windows_dry_run_unavailable_platform_emits_typed_diagnostic() {
    // Non-Windows public CI: availability is a synthetic request field, so
    // "unavailable" yields a typed helper_unavailable diagnostic, not a
    // platform-absence failure.
    let root = temp_dir("helper-dry-run-native-windows-unavailable");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-unavailable-request.json",
    );

    run_cli(&[
        "helper",
        "dry-run",
        "--platform",
        "native-windows",
        "--input",
        request.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);

    let resolution: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(resolution["platformAdapterId"], "native-windows");
    assert_eq!(
        resolution["helperResult"]["diagnostic"]["code"],
        "helper_unavailable"
    );
    assert!(
        resolution["helperResult"]["diagnostic"]["message"]
            .as_str()
            .unwrap()
            .contains("kaifuu.helper_unavailable")
    );
    assert_eq!(resolution["launched"], false);

    let committed: serde_json::Value = read_json(&public_fixture_path(
            "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-unavailable-resolution.json",
        ))
        .unwrap();
    assert_eq!(resolution, committed);
}

#[test]
fn native_windows_dry_run_rejects_raw_secret_material() {
    let root = temp_dir("helper-dry-run-native-windows-raw-secret");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/invalid/dry-run-native-windows-raw-secret-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--platform".to_string(),
        "native-windows".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let message = result.unwrap_err().to_string();
    assert!(message.contains("kaifuu.native_windows.dry_run.secret_leak"));
    // The failing resolution must not be persisted at all.
    assert!(!output.exists());
}

#[test]
fn native_windows_dry_run_rejects_execution_config_flags() {
    let root = temp_dir("helper-dry-run-native-windows-exec-flag");
    let output = root.join("resolution.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/dry-run-native-windows-request.json",
    );

    let result = run_with_args(vec![
        "helper".to_string(),
        "dry-run".to_string(),
        "--platform".to_string(),
        "native-windows".to_string(),
        "--input".to_string(),
        request.to_str().unwrap().to_string(),
        "--out".to_string(),
        output.to_str().unwrap().to_string(),
        "--argv".to_string(),
        "game.exe".to_string(),
    ]);

    assert!(result.is_err());
}

#[test]
fn native_windows_quoting_fixture_matches_committed_and_round_trips() {
    let root = temp_dir("helper-quoting-fixture");
    let output = root.join("quoting-fixture.json");

    run_cli(&[
        "helper",
        "quoting-fixture",
        "--out",
        output.to_str().unwrap(),
    ]);

    let fixture: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(fixture["quotingRules"], "CommandLineToArgvW");
    assert_eq!(fixture["launchesUntrustedCode"], false);

    // Cross-check a couple of adversarial cases against the CommandLineToArgvW
    // rules (space, embedded quote, backslash-before-quote).
    let cases = fixture["cases"].as_array().unwrap();
    let quoted_for = |raw: &str| -> String {
        cases
            .iter()
            .find(|case| case["raw"] == raw)
            .and_then(|case| case["quoted"].as_str())
            .unwrap()
            .to_string()
    };
    assert_eq!(quoted_for("arg with spaces"), "\"arg with spaces\"");
    assert_eq!(
        quoted_for("bs before quote\\\""),
        "\"bs before quote\\\\\\\"\""
    );

    let committed: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/native-windows/quoting-fixture.json",
    ))
    .unwrap();
    assert_eq!(fixture, committed);
}

#[test]
fn key_helper_validate_command_writes_normalized_helper_result_contract() {
    let root = temp_dir("key-helper-valid");
    let output = root.join("normalized-helper-result.json");
    let fixture =
        public_fixture_path("fixtures/public/kaifuu-helper-results/key-helper/manual-entry.json");

    run_cli(&[
        "key-helper",
        "validate",
        "--fixture",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["fixtureId"], "kaifuu-key-helper-manual-entry");
    assert_eq!(result["helper"]["helperKind"], "manualKeyEntry");
    assert_eq!(result["capabilityLevel"], "manualEntry");
    assert_eq!(result["execution"]["mode"], "notExecuted");
    assert_eq!(result["execution"]["bounded"], true);
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("rawKey"));
    assert!(!serialized.contains("keyMaterial"));
    assert!(!serialized.contains("command"));
}

#[test]
fn key_helper_validate_command_rejects_arbitrary_command_metadata() {
    let root = temp_dir("key-helper-invalid");
    let output = root.join("key-helper-report.json");
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/invalid/execution-command-field.json",
    );

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "validate".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["field"] == "execution.command"
                && failure["code"] == "forbidden_helper_execution_field")
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("fixture-helper --dump"));
}

#[test]
fn key_helper_validate_command_rejects_top_level_command_metadata() {
    let root = temp_dir("key-helper-top-level-command-invalid");
    let fixture = root.join("top-level-command.json");
    let output = root.join("key-helper-report.json");
    let mut value: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/key-helper/static-parser.json",
    ))
    .unwrap();
    value.as_object_mut().unwrap().insert(
        "command".to_string(),
        serde_json::json!("fixture-helper --dump-private-state"),
    );
    write_json(&fixture, &value).unwrap();

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "validate".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["field"] == "command"
                && failure["code"] == "forbidden_helper_metadata_field")
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("dump-private-state"));
}

#[test]
fn key_helper_validate_command_rejects_static_parser_remote_overclaim() {
    let root = temp_dir("key-helper-static-remote-overclaim-invalid");
    let fixture = root.join("static-remote-overclaim.json");
    let output = root.join("key-helper-report.json");
    let mut value: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/key-helper/static-parser.json",
    ))
    .unwrap();
    value["capabilityLevel"] = serde_json::json!("remoteWindows");
    value["execution"]["mode"] = serde_json::json!("remoteHelper");
    write_json(&fixture, &value).unwrap();

    let result = run_with_args(vec![
        "key-helper".to_string(),
        "validate".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| failure["field"] == "helper"
                && failure["code"] == "invalid_helper_semantics")
    );
}

#[test]
fn helper_registry_validate_command_accepts_public_fixture() {
    let root = temp_dir("helper-registry-valid");
    let output = root.join("helper-registry-report.json");
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-registry/valid-helper.json",
    );

    run_cli(&[
        "helper-registry",
        "validate",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(report["diagnostics"].as_array().unwrap().len(), 0);
}

#[test]
fn helper_registry_validate_command_rejects_invalid_fixtures() {
    let cases = [
        (
            "missing-capability",
            kaifuu_core::SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
        ),
        (
            "bad-schema-id",
            kaifuu_core::SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
        ),
        (
            "unsupported-redaction-class",
            kaifuu_core::SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS,
        ),
    ];

    for (fixture_name, expected_code) in cases {
        let root = temp_dir(&format!("helper-registry-invalid-{fixture_name}"));
        let output = root.join("helper-registry-report.json");
        let fixture = public_fixture_path(&format!(
            "fixtures/public/kaifuu-helper-results/helper-registry/{fixture_name}.json",
        ));

        let result = run_with_args(vec![
            "helper-registry".to_string(),
            "validate".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err());
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == expected_code)
        );
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_command_uses_registry_boundary() {
    let root = temp_dir("helper-registry-invoke");
    let output = root.join("helper-result.json");

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["fixtureId"], "kaifuu-helper-registry-stub");
    assert_eq!(
        result["helper"]["helperId"],
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
    );
    assert_eq!(result["diagnostic"]["code"], "success");
}

#[test]
fn helper_registry_invoke_fixture_stub_accepts_siglus_key_validation_request() {
    let root = temp_dir("helper-registry-invoke-siglus-request");
    let output = root.join("helper-result.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    );

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        request.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    let expected: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/siglus-secondary-key-helper-boundary-success.json",
    ))
    .unwrap();
    assert_eq!(result, expected);
    assert_eq!(
        result["helper"]["helperId"],
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
    );
    assert_eq!(result["diagnostic"]["code"], "success");
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_reports_siglus_rejected_helper_with_registered_override() {
    let root = temp_dir("helper-registry-invoke-siglus-rejected-helper");
    let output = root.join("helper-result.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-helper-rejection.json",
    );

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        request.to_str().unwrap(),
        "--helper-id",
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID,
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        result["diagnostic"]["message"],
        kaifuu_core::SEMANTIC_HELPER_REQUEST_WRONG_HELPER
    );
    assert_eq!(
        result["helper"]["helperId"],
        kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
    );
    assert_eq!(
        kaifuu_core::validate_helper_result_value(&result).status,
        kaifuu_core::OperationStatus::Passed
    );

    // Parity with the core boundary suite: the structured rejection
    // diagnostic must stay public-safe even though the request fixture
    // names a helper id the registry does not recognize.
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_fails_closed_for_unregistered_request_helper() {
    let root = temp_dir("helper-registry-invoke-unregistered-helper");
    let output = root.join("helper-result.json");
    let request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-helper-rejection.json",
    );

    let error = run_with_args(vec![
        "helper-registry".to_string(),
        "invoke-fixture-stub".to_string(),
        "--input".to_string(),
        request.display().to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ])
    .unwrap_err();

    assert!(
        error
            .to_string()
            .contains(kaifuu_core::SEMANTIC_HELPER_UNAVAILABLE)
    );
    assert!(!output.exists());
}

#[test]
fn helper_registry_invoke_fixture_stub_rejects_siglus_request_missing_redaction_expectation() {
    let root = temp_dir("helper-registry-invoke-siglus-request-missing-redaction");
    let input = root.join("helper-request.json");
    let output = root.join("helper-result.json");
    let mut request: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    ))
    .unwrap();
    request
        .as_object_mut()
        .unwrap()
        .remove("expectedRedactedLogHash");
    fs::write(&input, serde_json::to_string_pretty(&request).unwrap()).unwrap();

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        input.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        result["diagnostic"]["message"],
        kaifuu_core::SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
    );
    assert_eq!(result["redaction"]["status"], "failed");
    assert_eq!(result["secretRefs"], serde_json::json!([]));
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_registry_invoke_fixture_stub_rejects_siglus_key_refs_without_redaction_expectation() {
    let root = temp_dir("helper-registry-invoke-siglus-request-no-required-redaction");
    let input = root.join("helper-request.json");
    let output = root.join("helper-result.json");
    let mut request: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    ))
    .unwrap();
    let request_object = request.as_object_mut().unwrap();
    request_object.remove("expectedRedactedLogHash");
    request_object.remove("requiredKeyRefs");
    fs::write(&input, serde_json::to_string_pretty(&request).unwrap()).unwrap();

    run_cli(&[
        "helper-registry",
        "invoke-fixture-stub",
        "--input",
        input.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let result: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(result["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        result["diagnostic"]["message"],
        kaifuu_core::SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
    );
    assert_eq!(result["redaction"]["status"], "failed");
    assert_eq!(result["secretRefs"], serde_json::json!([]));
    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn key_import_command_writes_local_secret_and_hash_only_report() {
    let root = temp_dir("key-import-command");
    let secret_store = root.join("secrets.local");
    let output = root.join("key-import-report.json");

    run_cli(&[
        "key",
        "import",
        "--secret-store",
        secret_store.to_str().unwrap(),
        "--secret-ref",
        "local-secret:fixture/siglus/manual-secondary-key",
        "--purpose",
        "siglus-secondary-key",
        "--engine-profile-id",
        "019ed000-0000-7000-8000-profile00087",
        "--source-hash",
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "--key-hex",
        "000102030405060708090a0b0c0d0e0f",
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(
        report["secretRef"],
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    assert_eq!(report["keyPurpose"], "siglus-secondary-key");
    assert_eq!(
        report["engineProfileId"],
        "019ed000-0000-7000-8000-profile00087"
    );
    assert_eq!(report["redactionStatus"], "redacted");
    assert_eq!(report["materialBytes"], 16);
    assert!(
        report["materialHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        fs::read(secret_store.join("fixture/siglus/manual-secondary-key")).unwrap(),
        (0_u8..16).collect::<Vec<_>>()
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("000102030405060708090a0b0c0d0e0f"));
    assert!(!serialized.contains("rawKey"));
    assert!(!serialized.contains("keyMaterial"));
}

#[test]
fn key_import_usage_steers_away_from_command_line_hex_key() {
    // the key-import usage text must not advertise `--key-hex`
    // as the primary manual-entry path (a hex key on the command line leaks
    // into shell history + the process list). It must recommend the
    // shell-history-safe `--key-file` path, warn about the hex hazard, and
    // retain the hash-only report explanation.
    let err = run_with_args(vec!["key".to_string(), "not-a-subcommand".to_string()])
        .expect_err("unknown key subcommand must surface the usage text");
    let usage = err.to_string();

    // `--key-file` is the advertised/primary path and appears before the
    // discouraged `--key-hex` option.
    let key_file_at = usage
        .find("--key-file")
        .expect("usage must mention --key-file");
    let key_hex_at = usage
        .find("--key-hex")
        .expect("usage must still document --key-hex");
    assert!(
        key_file_at < key_hex_at,
        "--key-file must be advertised before --key-hex; usage: {usage}"
    );

    // The required-argument slot advertises --key-file, not a
    // `(--key-hex|...)` primary choice.
    assert!(
        usage.contains("--engine-profile-id <id> --key-file <path>"),
        "usage must advertise --key-file as the primary key input; usage: {usage}"
    );
    assert!(
        !usage.contains("(--key-hex <hex>|--key-file <path>)"),
        "usage must not advertise --key-hex as a primary manual-entry path; usage: {usage}"
    );

    // The safe method is recommended and the shell-history hazard is called
    // out.
    assert!(
        usage.contains("recommended"),
        "usage must recommend the shell-history-safe path; usage: {usage}"
    );
    assert!(
        usage.contains("shell history"),
        "usage must warn about shell-history exposure; usage: {usage}"
    );
    assert!(
        usage.contains("process list"),
        "usage must warn about process-list exposure; usage: {usage}"
    );
    assert!(
        usage.contains("DISCOURAGED"),
        "usage must mark --key-hex as discouraged; usage: {usage}"
    );

    // The hash-only report explanation is retained.
    assert!(
        usage.contains("sha256 hash"),
        "usage must retain the hash-only report explanation; usage: {usage}"
    );

    // The missing-material error also steers toward the safe path.
    let empty: Vec<String> = Vec::new();
    let material_err = import_key_material_from_args(&empty)
        .expect_err("missing key material must error with guidance");
    let material_msg = material_err.to_string();
    let file_at = material_msg
        .find("--key-file")
        .expect("error must mention --key-file");
    let hex_at = material_msg
        .find("--key-hex")
        .expect("error must mention --key-hex");
    assert!(
        file_at < hex_at,
        "missing-material error must lead with --key-file: {material_msg}"
    );
}

#[test]
fn helper_registry_check_binary_reports_allowlist_diagnostics() {
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-registry/valid-helper.json",
    );
    let allowed_binary = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-binaries/kaifuu-fixture-helper",
    );
    let root = temp_dir("helper-registry-check-binary-allowed");
    let output = root.join("helper-binary-report.json");

    run_cli(&[
        "helper-registry",
        "check-binary",
        fixture.to_str().unwrap(),
        "--helper-binary",
        allowed_binary.to_str().unwrap(),
        "--allowlist-entry-id",
        kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID,
        "--platform",
        "fixture-any",
        "--helper-version",
        "0.1.0",
        "--capability",
        "fixture_invocation",
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(
        report["allowlistEntryId"],
        kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
    );
    assert_eq!(
        report["observedHash"],
        "sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c"
    );

    let mismatch_binary = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-binaries/kaifuu-fixture-helper-mismatch",
    );
    let cases = [
        (
            "missing",
            fixture.clone(),
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-binaries/missing-helper",
            ),
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY,
        ),
        (
            "mismatched",
            fixture.clone(),
            mismatch_binary,
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH,
        ),
        (
            "wrong-platform",
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-wrong-platform.json",
            ),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM,
        ),
        (
            "stale-version",
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-stale-version.json",
            ),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            "fixture_invocation",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
        ),
        (
            "undeclared-capability",
            public_fixture_path(
                "fixtures/public/kaifuu-helper-results/helper-registry/allowlist-missing-declared-capability.json",
            ),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            "key_discovery",
            kaifuu_core::SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
        ),
    ];

    for (
        name,
        registry_fixture,
        helper_binary,
        platform,
        helper_version,
        capability,
        expected_code,
    ) in cases
    {
        let root = temp_dir(&format!("helper-registry-check-binary-{name}"));
        let output = root.join("helper-binary-report.json");
        let result = run_with_args(vec![
            "helper-registry".to_string(),
            "check-binary".to_string(),
            registry_fixture.to_str().unwrap().to_string(),
            "--helper-binary".to_string(),
            helper_binary.to_str().unwrap().to_string(),
            "--allowlist-entry-id".to_string(),
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
            "--platform".to_string(),
            platform.to_string(),
            "--helper-version".to_string(),
            helper_version.to_string(),
            "--capability".to_string(),
            capability.to_string(),
            "--output".to_string(),
            output.to_str().unwrap().to_string(),
        ]);

        assert!(result.is_err(), "{name} unexpectedly passed");
        let report: serde_json::Value = read_json(&output).unwrap();
        assert_eq!(report["status"], "failed");
        assert_eq!(report["helperId"], kaifuu_core::FIXTURE_HELPER_REGISTRY_ID);
        assert_eq!(
            report["allowlistEntryId"],
            kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
        );
        assert_eq!(report["platform"], platform);
        if name == "mismatched" {
            let observed_hash = report["observedHash"]
                .as_str()
                .expect("mismatched helper should report top-level observedHash");
            assert!(
                observed_hash.starts_with("sha256:")
                    && observed_hash.len() == 71
                    && observed_hash["sha256:".len()..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit()
                            && !character.is_ascii_uppercase()),
                "{name}: observedHash is not canonical: {report:#?}"
            );
            assert!(
                report["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| {
                        diagnostic["code"] == expected_code
                            && diagnostic["observedHash"].as_str() == Some(observed_hash)
                    }),
                "{name}: diagnostic did not preserve observedHash: {report:#?}"
            );
        }
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| {
                    diagnostic["code"] == expected_code
                        && diagnostic["helperId"] == kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
                        && diagnostic["allowlistEntryId"]
                            == kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
                        && diagnostic["platform"] == platform
                        && diagnostic["remediationCode"]
                            .as_str()
                            .is_some_and(|code| !code.is_empty())
                }),
            "{name}: {report:#?}"
        );
    }
}

#[test]
fn helper_result_validate_command_rejects_raw_secret_ref_path_component() {
    let root = temp_dir("helper-result-invalid-path-component");
    let output = root.join("helper-result-report.json");
    let fixture = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/invalid/raw-base64url-path-component-secret-ref.json",
    );

    let result = run_with_args(vec![
        "helper-result".to_string(),
        "validate".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(
        report["fixtureId"],
        "kaifuu-helper-invalid-encoded-path-component-ref"
    );
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["fixtureId"] == "kaifuu-helper-invalid-encoded-path-component-ref"
                    && failure["field"] == "secretRefs.0.secretRef"
            })
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
}

#[test]
fn helper_result_validate_command_reports_redacted_field_and_fixture_id() {
    let root = temp_dir("helper-result-invalid");
    let helper_result_path = root.join("helper-result.json");
    let output = root.join("helper-result-report.json");
    fs::write(
        &helper_result_path,
        r#"{
  "schemaVersion": "0.1.0",
  "fixtureId": "kaifuu-helper-invalid-redaction",
  "helperResultId": "helper-result-invalid-redaction",
  "profileId": "019ed000-0000-7000-8000-profile00085",
  "helper": {
    "helperId": "kaifuu.fixture.static-parser",
    "helperVersion": "0.1.0",
    "helperKind": "staticParser"
  },
  "diagnostic": {
    "code": "success",
    "message": "helper output referenced path=/home/dev/private/key.bin"
  },
  "redaction": {
    "status": "redacted",
    "redactedLogHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "secretRefs": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:fixture/siglus/secondary-key",
      "materialKind": "fixedBytes",
      "bytes": 16
    }
  ],
  "proofHashes": []
}
"#,
    )
    .unwrap();

    let result = run_with_args(vec![
        "helper-result".to_string(),
        "validate".to_string(),
        helper_result_path.to_str().unwrap().to_string(),
        "--output".to_string(),
        output.to_str().unwrap().to_string(),
    ]);

    assert!(result.is_err());
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["fixtureId"], "kaifuu-helper-invalid-redaction");
    assert!(
        report["failures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|failure| {
                failure["fixtureId"] == "kaifuu-helper-invalid-redaction"
                    && failure["field"] == "diagnostic.message"
            })
    );
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/dev"));
    assert!(!serialized.contains("key.bin"));
}

#[test]
fn offset_map_validate_command_accepts_valid_fixture() {
    let root = temp_dir("offset-map-valid");
    let output = root.join("offset-map-report.json");
    let fixture = core_fixture_path("fixtures/offset-map/shift-jis.json");

    run_cli(&[
        "offset-map",
        "validate",
        fixture.to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["diagnostics"].as_array().unwrap().len(), 0);
}

#[test]
fn offset_map_validate_command_writes_semantic_diagnostics() {
    let root = temp_dir("offset-map-invalid");
    let input = root.join("invalid-offset-map.json");
    let output = root.join("offset-map-report.json");
    fs::write(
        &input,
        r#"{
  "sourceFileId": "script.ks",
  "encoding": "utf_8",
  "sourceLength": 6,
  "decodedTextLength": 6,
  "patchedLength": 6,
  "segments": [
    {
      "sourceBytes": { "start": 0, "end": 4 },
      "decodedText": { "start": 0, "end": 4 },
      "patchedBytes": { "start": 0, "end": 4 }
    },
    {
      "sourceBytes": { "start": 3, "end": 8 },
      "decodedText": { "start": 4, "end": 6 },
      "patchedBytes": { "start": 4, "end": 6 }
    }
  ]
}
"#,
    )
    .unwrap();

    let error = run_cli_with_registry_result(
        &[
            "offset-map",
            "validate",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .expect_err("invalid offset map should fail");
    let error = error.to_string();
    assert!(
        error.contains("kaifuu.missing_source_revision_id"),
        "{error}"
    );
    assert!(error.contains("kaifuu.overlapping_spans"), "{error}");
    assert!(
        error.contains("kaifuu.out_of_range_source_range"),
        "{error}"
    );

    let report: serde_json::Value = read_json(&output).unwrap();
    let codes = report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| diagnostic["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(codes.contains(&"kaifuu.missing_source_revision_id"));
    assert!(codes.contains(&"kaifuu.overlapping_spans"));
    assert!(codes.contains(&"kaifuu.out_of_range_source_range"));
}

#[test]
fn offset_map_validate_command_rejects_detached_decoded_source_axes() {
    let root = temp_dir("offset-map-detached");
    let input = root.join("detached-offset-map.json");
    let output = root.join("offset-map-report.json");
    fs::write(
        &input,
        r#"{
  "sourceFileId": "script.ks",
  "sourceRevisionId": "rev-detached-001",
  "encoding": "utf_8",
  "sourceLength": 4,
  "decodedTextLength": 4,
  "patchedLength": 4,
  "segments": [
    {
      "sourceBytes": { "start": 0, "end": 0 },
      "decodedText": { "start": 0, "end": 4 },
      "patchedBytes": { "start": 0, "end": 4 }
    }
  ]
}
"#,
    )
    .unwrap();

    let error = run_cli_with_registry_result(
        &[
            "offset-map",
            "validate",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .expect_err("detached offset map should fail");
    let error = error.to_string();
    assert!(error.contains("kaifuu.detached_offset_segment"), "{error}");

    let report: serde_json::Value = read_json(&output).unwrap();
    let codes = report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| diagnostic["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(codes.contains(&"kaifuu.detached_offset_segment"));
}

fn write_apply_delta(root: &Path) -> (PathBuf, PathBuf) {
    let game_dir = temp_game(root);
    let patched_dir = root.join("patched");
    fs::create_dir_all(&patched_dir).unwrap();
    write_fixture_file(
        &patched_dir,
        "source.json",
        br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
    );

    let delta_path = root.join("hello.kaifuu");
    run_cli(&[
        "diff",
        game_dir.to_str().unwrap(),
        patched_dir.to_str().unwrap(),
        "--output",
        delta_path.to_str().unwrap(),
    ]);
    (game_dir, delta_path)
}

fn test_capabilities() -> AdapterCapabilities {
    AdapterCapabilities::new(
        TEST_ADAPTER_ID,
        vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
            CapabilityReport::supported(Capability::AssetListing),
            CapabilityReport::supported(Capability::AssetInventory),
            CapabilityReport::supported(Capability::NonTextSurfaceExtraction),
            CapabilityReport::supported(Capability::ProfileGeneration),
        ],
        // full-rung matrix mirrors the per-Capability
        // reports above; declared explicitly so the registry gate
        // sees a Supported claim at every rung.
        AdapterCapabilityMatrix::up_to(
            TEST_ADAPTER_ID,
            kaifuu_core::CapabilityLevel::Patch,
            "test capabilities cover every rung",
        ),
    )
}

struct RecordingAdapter {
    calls: Rc<RefCell<Vec<&'static str>>>,
}

impl RecordingAdapter {
    fn record(&self, call: &'static str) {
        self.calls.borrow_mut().push(call);
    }

    fn profile_result(&self) -> GameProfile {
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 98),
            game_id: "registry-dispatch-game".to_string(),
            title: "Registry Dispatch Game".to_string(),
            source_locale: "en-US".to_string(),
            engine: EngineProfile {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                engine_family: "registry-test".to_string(),
                engine_version: Some("9.9.9".to_string()),
                detected_variant: "injected-adapter".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 98),
                path: "registry.txt".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some("registry-source-hash".to_string()),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            layered_access: None,
            capabilities: test_capabilities().reports,
            requirements: vec![],
            metadata: std::collections::BTreeMap::new(),
        };
        profile.normalize();
        profile
    }
}

impl EngineAdapter for RecordingAdapter {
    fn id(&self) -> &'static str {
        TEST_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu registry dispatch test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        self.record("capabilities");
        test_capabilities()
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        self.record("detect");
        Ok(DetectionResult {
            adapter_id: TEST_ADAPTER_ID.to_string(),
            detected: true,
            engine_family: Some("registry-test".to_string()),
            engine_version: Some("9.9.9".to_string()),
            detected_variant: Some("injected-adapter".to_string()),
            evidence: vec![DetectionEvidence {
                path: request.game_dir.display().to_string(),
                kind: "injected_registry".to_string(),
                status: EvidenceStatus::Matched,
                detail: "custom registry adapter was called".to_string(),
            }],
            requirements: vec![ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "test_key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "test adapter does not need secrets".to_string(),
                placeholder: None,
                secret: true,
            }],
            capabilities: test_capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.record("profile");
        Ok(self.profile_result())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        self.record("list_assets");
        Ok(AssetList {
            adapter_id: TEST_ADAPTER_ID.to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.record("asset_inventory");
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "registry test asset inventory".to_string(),
        );
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("asset-inventory", 98),
            adapter_id: TEST_ADAPTER_ID.to_string(),
            source_locale: "en-US".to_string(),
            assets: vec![AssetInventoryAsset {
                asset_id: "registry-image".to_string(),
                asset_key: "image/registry".to_string(),
                asset_kind: AssetInventoryAssetKind::Image,
                path: Some("registry/image.png".to_string()),
                source_hash: Some(content_hash("registry-image")),
                metadata: BTreeMap::new(),
            }],
            surfaces: vec![AssetInventorySurface {
                surface_id: "registry-image-text".to_string(),
                asset_surface_kind: AssetInventorySurfaceKind::ImageText,
                source_asset_ref: AssetInventoryAssetRef {
                    asset_id: "registry-image".to_string(),
                    asset_key: Some("image/registry".to_string()),
                },
                source_location: None,
                source_text: Some("Registry".to_string()),
                source_hash: Some(content_hash("Registry")),
                text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
                patch_mode: AssetInventoryPatchMode::Unsupported,
                patching: CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "registry test adapter does not patch image assets",
                ),
                patch_payload: None,
                metadata_hash: None,
                notes: vec![],
            }],
            capabilities: test_capabilities().reports,
            warnings: vec![],
            metadata,
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        self.record("extract");
        Ok(ExtractionResult {
            adapter_id: TEST_ADAPTER_ID.to_string(),
            profile: self.profile_result(),
            bridge: BridgeBundle {
                schema_version: "0.1.0".to_string(),
                bridge_id: deterministic_id("bridge", 98),
                source_bundle_hash: "registry-bundle-hash".to_string(),
                source_locale: "en-US".to_string(),
                extractor_name: "registry-test-extractor".to_string(),
                extractor_version: "9.9.9".to_string(),
                units: vec![BridgeUnit {
                    bridge_unit_id: deterministic_id("bridge-unit", 98),
                    source_unit_key: "registry.unit.001".to_string(),
                    occurrence_id: "registry-occurrence-001".to_string(),
                    source_hash: "registry-source-hash".to_string(),
                    source_locale: "en-US".to_string(),
                    source_text: "Registry source".to_string(),
                    speaker: "Registry".to_string(),
                    text_surface: "dialogue".to_string(),
                    protected_spans: vec![],
                    patch_ref: PatchRef {
                        asset_id: "registry.txt".to_string(),
                        write_mode: "replace".to_string(),
                        source_unit_key: "registry.unit.001".to_string(),
                    },
                }],
            },
            warnings: Vec::<AdapterWarning>::new(),
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        self.record("patch");
        fs::create_dir_all(request.output_dir)?;
        fs::write(
            request.output_dir.join("registry-adapter-called.txt"),
            "patch\n",
        )?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 98),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: "registry-patch-output".to_string(),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        self.record("verify");
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("verify", 98),
            status: OperationStatus::Passed,
            output_hash: "registry-verify-output".to_string(),
            failures: vec![],
        })
    }
}

fn recording_registry(calls: Rc<RefCell<Vec<&'static str>>>) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(RecordingAdapter { calls });
    registry
}

struct PreflightBlockingAdapter;

impl EngineAdapter for PreflightBlockingAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.preflight"
    }

    fn name(&self) -> &'static str {
        "Kaifuu preflight failure test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Patching),
                CapabilityReport::requires_user_input(
                    Capability::ContainerAccess,
                    "synthetic preflight requires container support",
                ),
                CapabilityReport::requires_user_input(
                    Capability::CryptoAccess,
                    "synthetic preflight requires crypto support",
                ),
            ],
            // identify-only matrix — this synthetic
            // preflight fixture stops at Identify, so the registry
            // gate must never bubble it up to Inventory/Extract/Patch.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "preflight failure test adapter is identify-only; container/crypto required-user-input gates inventory/extract/patch",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("preflight-test".to_string()),
            engine_version: None,
            detected_variant: Some("layered-access-test".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the preflight test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the preflight test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the preflight test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the preflight test".into())
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let raw_key = "00112233445566778899aabbccddeeff";
        let preflight = LayeredAccessPreflightReport::from_requirements(
            self.id(),
            "preflight-test",
            "layered-access-test",
            vec![
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Container,
                    "private-route-name/ending.ks",
                    "container helper unavailable for /home/dev/Private Route Spoiler Game/data.xp3",
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Crypto,
                    "Scene.pck",
                    format!("helper dump included unresolved raw key {raw_key}"),
                ),
            ],
        );
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 77),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: content_hash("preflight failed without output"),
            failures: preflight.failures,
        })
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch must not run after a blocking preflight failure".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the preflight test".into())
    }
}

fn preflight_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(PreflightBlockingAdapter);
    registry
}

struct ContractStatusPreflightAdapter;

impl EngineAdapter for ContractStatusPreflightAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.contract-status-preflight"
    }

    fn name(&self) -> &'static str {
        "Kaifuu contract status preflight test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let mut access_contract = LayeredAccessCapabilityContract::plaintext_identity();
        access_contract.patch.status = CapabilityStatus::RequiresUserInput;
        access_contract.patch.support_boundary =
            Some("patch access requires local helper confirmation before writing".to_string());
        AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                    CapabilityReport::supported(Capability::ContainerAccess),
                    CapabilityReport::supported(Capability::CryptoAccess),
                    CapabilityReport::supported(Capability::CodecAccess),
                    CapabilityReport::supported(Capability::PatchBack),
                ],
                // identify-only matrix — Patching reports as
                // Supported but the access-contract `RequiresUserInput`
                // status keeps the registry gate strict.
                AdapterCapabilityMatrix::identify_only(
                    self.id(),
                    "contract-status preflight test adapter is identify-only; patch contract requires user input before any write",
                ),
            )
            .with_access_contract(access_contract)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("contract-status-preflight-test".to_string()),
            engine_version: None,
            detected_variant: Some("requires-user-input".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the contract status preflight test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the contract status preflight test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the contract status preflight test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the contract status preflight test".into())
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
            "source-json",
            "source.json",
            &[TextSurface::Dialogue],
            "$.lines[*]",
        );
        let preflight = LayeredAccessPreflightReport::from_access_profile(
            self.id(),
            "contract-status-preflight-test",
            "requires-user-input",
            &self.capabilities(),
            &access_profile,
        );
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 82),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: preflight.status,
            output_hash: content_hash("contract status preflight without output"),
            failures: preflight.failures,
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        fs::create_dir_all(request.output_dir)?;
        fs::write(
            request
                .output_dir
                .join("contract-status-preflight-bypassed.txt"),
            "patch should not have run\n",
        )?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 83),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("contract status preflight bypassed"),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the contract status preflight test".into())
    }
}

fn contract_status_preflight_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(ContractStatusPreflightAdapter);
    registry
}

struct MaliciousPreflightBlockingPatchAdapter {
    failure: AdapterFailure,
}

impl MaliciousPreflightBlockingPatchAdapter {
    fn new(failure: AdapterFailure) -> Self {
        Self { failure }
    }
}

impl EngineAdapter for MaliciousPreflightBlockingPatchAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.malicious-preflight"
    }

    fn name(&self) -> &'static str {
        "Kaifuu malicious preflight failure test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Patching),
            ],
            // identify-only matrix — the malicious-preflight
            // fixture intentionally has no real inventory/extract/patch
            // path despite a Patching capability report.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "malicious-preflight test adapter is identify-only at the registry gate",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("malicious-preflight-test".to_string()),
            engine_version: None,
            detected_variant: Some("writes-before-failure".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the malicious preflight test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the malicious preflight test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the malicious preflight test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the malicious preflight test".into())
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        fs::create_dir_all(request.output_dir)?;
        fs::write(
            request.output_dir.join("must-not-escape.txt"),
            "leaked output\n",
        )?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 78),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: content_hash("malicious preflight output"),
            failures: vec![self.failure.clone()],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the malicious preflight test".into())
    }
}

fn malicious_registry(failure: AdapterFailure) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(MaliciousPreflightBlockingPatchAdapter::new(failure));
    registry
}

enum PatchFilesystemFailureMode {
    AdapterErrAfterWrite,
    ReportWriteCollision,
    SuccessfulWrite,
}

struct PatchFilesystemFailureAdapter {
    mode: PatchFilesystemFailureMode,
}

impl PatchFilesystemFailureAdapter {
    fn new(mode: PatchFilesystemFailureMode) -> Self {
        Self { mode }
    }
}

impl EngineAdapter for PatchFilesystemFailureAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.patch-filesystem-failure"
    }

    fn name(&self) -> &'static str {
        "Kaifuu patch filesystem failure test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Patching),
            ],
            // identify-only matrix — this test adapter
            // simulates filesystem failure during patch and never
            // promotes itself in the registry-side gate.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "patch filesystem-failure test adapter is identify-only at the registry gate",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("patch-filesystem-failure-test".to_string()),
            engine_version: None,
            detected_variant: Some("cleanup".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the patch filesystem failure test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the patch filesystem failure test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the patch filesystem failure test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the patch filesystem failure test".into())
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        fs::write(
            request.output_dir.join("adapter-output.txt"),
            "staged output\n",
        )?;
        match self.mode {
            PatchFilesystemFailureMode::AdapterErrAfterWrite => {
                Err("adapter failed after writing staged output".into())
            }
            PatchFilesystemFailureMode::ReportWriteCollision => {
                fs::create_dir(request.output_dir.join("patch-result.json"))?;
                Ok(self.patch_result(request.patch_export))
            }
            PatchFilesystemFailureMode::SuccessfulWrite => {
                Ok(self.patch_result(request.patch_export))
            }
        }
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the patch filesystem failure test".into())
    }
}

impl PatchFilesystemFailureAdapter {
    fn patch_result(&self, patch_export: &PatchExport) -> PatchResult {
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 79),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patch filesystem failure output"),
            failures: vec![],
        }
    }
}

fn patch_filesystem_failure_registry(mode: PatchFilesystemFailureMode) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(PatchFilesystemFailureAdapter::new(mode));
    registry
}

fn empty_patch_export(root: &Path, seed: usize) -> PathBuf {
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", seed),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    patch_export_path
}

fn assert_no_patch_staging_entries(root: &Path, output_name: &str) {
    let leaked_entries = fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(output_name) && name.contains("kaifuu-staging"))
        .collect::<Vec<_>>();
    assert_eq!(leaked_entries, Vec::<String>::new());
}

struct SensitiveReportAdapter;

impl EngineAdapter for SensitiveReportAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.sensitive-report"
    }

    fn name(&self) -> &'static str {
        "Kaifuu sensitive report test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "path=~/games/private/key.bin",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "requires file=%USERPROFILE%\\Games\\SecretRoute\\patcher.exe",
                ),
            ],
            // this fixture has no Detection report so even
            // Identify is Unsupported at the registry gate; the fully
            // unsupported matrix exercises the redaction pipeline only.
            AdapterCapabilityMatrix::new(
                self.id(),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no Detection capability report",
                ),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no AssetListing capability report",
                ),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no Extraction capability report",
                ),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no Patching capability report",
                ),
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("sensitive-report-test".to_string()),
            engine_version: None,
            detected_variant: Some("private-route".to_string()),
            evidence: vec![],
            requirements: vec![
                ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "route-key".to_string(),
                    status: RequirementStatus::Missing,
                    description: "read key from $HOME/games/private/key.bin".to_string(),
                    placeholder: Some(
                        "file=%USERPROFILE%\\Games\\SecretRoute\\key.bin".to_string(),
                    ),
                    secret: true,
                },
                ProfileRequirement {
                    category: RequirementCategory::File,
                    key: "script".to_string(),
                    status: RequirementStatus::Unsupported,
                    description: "story-ish filename private-route-ending.ks must stay local"
                        .to_string(),
                    placeholder: None,
                    secret: false,
                },
            ],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "diagnostic".to_string(),
            "source=$HOME/games/private/key.bin".to_string(),
        );
        Ok(GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: deterministic_id("profile", 1301),
                game_id: "sensitive-report-game".to_string(),
                title: "Sensitive Report Game".to_string(),
                source_locale: "ja-JP".to_string(),
                engine: EngineProfile {
                    adapter_id: self.id().to_string(),
                    engine_family: "sensitive-report-test".to_string(),
                    engine_version: None,
                    detected_variant: "private-route".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 1301),
                    path: "~/games/private/source.ks".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some(content_hash("sensitive profile asset")),
                    patching: CapabilityReport::limited(
                        Capability::Patching,
                        "helper input lives at %USERPROFILE%\\Games\\SecretRoute\\key.bin",
                    ),
                }],
                layered_access: None,
                capabilities: self.capabilities().reports,
                requirements: vec![ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "route-key".to_string(),
                    status: RequirementStatus::Missing,
                    description:
                        "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff"
                            .to_string(),
                    placeholder: Some("file=C:\\Games\\SecretRoute\\key.bin".to_string()),
                    secret: true,
                }],
                metadata,
            })
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the sensitive report test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the sensitive report test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the sensitive report test".into())
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch is not used by the sensitive report test".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the sensitive report test".into())
    }
}

fn sensitive_report_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(SensitiveReportAdapter);
    registry
}

struct InvalidProfileAdapter;

impl EngineAdapter for InvalidProfileAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.invalid-profile"
    }

    fn name(&self) -> &'static str {
        "Kaifuu invalid profile test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::Patching),
            ],
            // identify-only matrix — exercises the
            // missing-profile-id path; the registry gate must stay
            // strict despite the per-Capability reports.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "invalid-profile fixture is identify-only at the registry gate",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("invalid-profile-test".to_string()),
            engine_version: None,
            detected_variant: Some("missing-profile-id".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: String::new(),
            game_id: "invalid-profile-game".to_string(),
            title: "Invalid Profile Game".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: self.id().to_string(),
                engine_family: "invalid-profile-test".to_string(),
                engine_version: None,
                detected_variant: "missing-profile-id".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 1401),
                path: "source.ks".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("invalid profile source")),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            layered_access: None,
            capabilities: self.capabilities().reports,
            requirements: vec![],
            metadata: BTreeMap::new(),
        })
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the invalid profile test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the invalid profile test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the invalid profile test".into())
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch is not used by the invalid profile test".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the invalid profile test".into())
    }
}

fn invalid_profile_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(InvalidProfileAdapter);
    registry
}

fn assert_no_sensitive_profile_material(surface: &str) {
    for forbidden in [
        "~/games",
        "$HOME/games",
        "%USERPROFILE%",
        "/home/dev/game",
        "C:\\Games",
        "private/key.bin",
        "helper dump",
        "decrypted text",
        "00112233445566778899aabbccddeeff",
        "private-route-ending.ks",
        "SecretRoute",
    ] {
        assert!(
            !surface.contains(forbidden),
            "profile write surface leaked {forbidden}: {surface}"
        );
    }
}

fn assert_calls(calls: &Rc<RefCell<Vec<&'static str>>>, expected: &[&'static str]) {
    assert_eq!(calls.borrow().as_slice(), expected);
    calls.borrow_mut().clear();
}

#[test]
fn engine_commands_use_supplied_registry() {
    let root = temp_dir("injected-registry-dispatch");
    let game_dir = root.join("non-fixture-game");
    fs::create_dir_all(&game_dir).unwrap();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let registry = recording_registry(Rc::clone(&calls));

    let capabilities_path = root.join("capabilities.json");
    run_cli_with_registry(
        &[
            "capabilities",
            "--output",
            capabilities_path.to_str().unwrap(),
        ],
        &registry,
    );
    let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
    assert_eq!(capabilities, vec![test_capabilities()]);
    assert_calls(&calls, &["capabilities"]);

    let detect_path = root.join("detect.json");
    run_cli_with_registry(
        &[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ],
        &registry,
    );
    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Matched);
    assert_eq!(detection_report.detections.len(), 1);
    let detection = &detection_report.detections[0];
    assert_eq!(detection.adapter_id, TEST_ADAPTER_ID);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("injected-adapter")
    );
    assert_eq!(detection.evidence[0].status, EvidenceStatus::Matched);
    let serialized_detection: serde_json::Value = read_json(&detect_path).unwrap();
    let detection_json = &serialized_detection["detections"][0];
    assert_eq!(detection_json["engineFamily"], "registry-test");
    assert_eq!(detection_json["engineVersion"], "9.9.9");
    assert_eq!(detection_json["detectedVariant"], "injected-adapter");
    let serialized_detection_text = fs::read_to_string(&detect_path).unwrap();
    assert!(!serialized_detection_text.contains(&game_dir.display().to_string()));
    assert_calls(&calls, &["detect"]);

    let profile_path = root.join("profile.json");
    run_cli_with_registry(
        &[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ],
        &registry,
    );
    let profile: GameProfile = read_json(&profile_path).unwrap();
    assert_eq!(profile.engine.adapter_id, TEST_ADAPTER_ID);
    assert_eq!(profile.game_id, "registry-dispatch-game");
    assert_calls(&calls, &["detect", "profile"]);

    let asset_inventory_path = root.join("asset-inventory.json");
    run_cli_with_registry(
        &[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            asset_inventory_path.to_str().unwrap(),
        ],
        &registry,
    );
    let asset_inventory: AssetInventoryManifest = read_json(&asset_inventory_path).unwrap();
    assert_eq!(asset_inventory.adapter_id, TEST_ADAPTER_ID);
    assert_eq!(asset_inventory.surfaces.len(), 1);
    assert_eq!(
        asset_inventory.surfaces[0].patching.status,
        CapabilityStatus::Unsupported
    );
    assert_calls(&calls, &["detect", "asset_inventory"]);

    let validation_path = root.join("profile-validation.json");
    run_cli_with_registry(
        &[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ],
        &registry,
    );
    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Passed);
    assert_calls(&calls, &[]);

    let bridge_path = root.join("bridge.json");
    run_cli_with_registry(
        &[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ],
        &registry,
    );
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    assert_eq!(bridge.extractor_name, "registry-test-extractor");
    assert_eq!(bridge.units[0].source_unit_key, "registry.unit.001");
    assert_calls(&calls, &["detect", "extract"]);

    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 98),
        source_locale: "en-US".to_string(),
        target_locale: "fr-FR".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let patched_dir = root.join("patched");
    run_cli_with_registry(
        &[
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ],
        &registry,
    );
    let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
    assert_eq!(patch_result.output_hash, "registry-patch-output");
    assert!(patched_dir.join("registry-adapter-called.txt").exists());
    assert_calls(&calls, &["detect", "patch"]);

    let verify_path = root.join("verify.json");
    run_cli_with_registry(
        &[
            "verify",
            game_dir.to_str().unwrap(),
            "--output",
            verify_path.to_str().unwrap(),
        ],
        &registry,
    );
    let verify: VerificationResult = read_json(&verify_path).unwrap();
    assert_eq!(verify.output_hash, "registry-verify-output");
    assert_calls(&calls, &["detect", "verify"]);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detection_and_capabilities_reports_redact_sensitive_free_text() {
    let root = temp_dir("sensitive-report-redaction");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let registry = sensitive_report_registry();

    let capabilities_path = root.join("capabilities.json");
    run_cli_with_registry(
        &[
            "capabilities",
            "--output",
            capabilities_path.to_str().unwrap(),
        ],
        &registry,
    );
    let capabilities_serialized = fs::read_to_string(&capabilities_path).unwrap();
    assert!(capabilities_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    for forbidden in ["~/games", "%USERPROFILE%", "private/key.bin", "SecretRoute"] {
        assert!(
            !capabilities_serialized.contains(forbidden),
            "capabilities leaked {forbidden}"
        );
    }

    let detect_path = root.join("detect.json");
    run_cli_with_registry(
        &[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ],
        &registry,
    );
    let detection_serialized = fs::read_to_string(&detect_path).unwrap();
    assert!(detection_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    for forbidden in [
        "$HOME/games",
        "%USERPROFILE%",
        "private/key.bin",
        "SecretRoute",
    ] {
        assert!(
            !detection_serialized.contains(forbidden),
            "detection leaked {forbidden}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_write_gate_rejects_unredacted_adapter_payloads_on_init_and_legacy_paths() {
    let root = temp_dir("sensitive-profile-write-gate");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let registry = sensitive_report_registry();

    for legacy in [false, true] {
        let label = if legacy { "legacy" } else { "init" };
        let output = root.join(format!("profile-{label}.json"));
        let args = if legacy {
            vec![
                "profile",
                game_dir.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ]
        } else {
            vec![
                "profile",
                "init",
                game_dir.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ]
        };
        let error = run_cli_with_registry_result(&args, &registry)
            .expect_err("sensitive profile payload should be rejected")
            .to_string();

        assert!(
            error.contains("generated profile failed validation"),
            "{label} path returned unexpected error: {error}"
        );
        assert!(
            error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
            "{label} path did not report the redaction boundary: {error}"
        );
        assert!(
            !output.exists(),
            "{label} path persisted an invalid profile to {}",
            output.display()
        );
        assert_no_sensitive_profile_material(&error);
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_write_gate_redacts_raw_key_material_before_persisting_valid_profile() {
    let root = temp_dir("profile-write-gate-redacted-persist");
    let output = root.join("profile.json");
    let profile = GameProfile {
        schema_version: "0.1.0".to_string(),
        profile_id: deterministic_id("profile", 1402),
        game_id: "valid-redaction-profile-game".to_string(),
        title: "Valid Profile 00112233445566778899aabbccddeeff".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: "kaifuu.test.redacted-persist".to_string(),
            engine_family: "redacted-persist-test".to_string(),
            engine_version: None,
            detected_variant: "valid-title-redaction".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![AssetProfile {
            asset_id: deterministic_id("asset", 1402),
            path: "source.ks".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces: vec![TextSurface::Dialogue],
            source_hash: Some(content_hash("redacted persist source")),
            patching: CapabilityReport::supported(Capability::Patching),
        }],
        layered_access: None,
        capabilities: vec![
            CapabilityReport::supported(Capability::ProfileGeneration),
            CapabilityReport::supported(Capability::Patching),
        ],
        requirements: vec![],
        metadata: BTreeMap::new(),
    };

    assert_eq!(profile.validate().status, OperationStatus::Passed);
    write_validated_stable_profile(&output, &profile).unwrap();

    let serialized = fs::read_to_string(&output).unwrap();
    assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    assert_no_sensitive_profile_material(&serialized);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_profile_command_rejects_structurally_invalid_profiles_before_write() {
    let root = temp_dir("legacy-profile-invalid-write-gate");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let output = root.join("profile.json");
    let registry = invalid_profile_registry();

    let error = run_cli_with_registry_result(
        &[
            "profile",
            game_dir.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &registry,
    )
    .expect_err("legacy profile command should reject invalid generated profiles")
    .to_string();

    assert!(error.contains("generated profile failed validation"));
    assert!(error.contains("missing_required_field"));
    assert!(!output.exists());
    assert_no_sensitive_profile_material(&error);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn fixture_commands_dispatch_through_registered_adapter() {
    let root = temp_dir("fixture-dispatch");
    let game_dir = temp_game(&root);

    let capabilities_path = root.join("capabilities.json");
    run_cli(&[
        "capabilities",
        "--output",
        capabilities_path.to_str().unwrap(),
    ]);
    let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
    assert_eq!(capabilities.len(), 7);
    let fixture_capabilities = capabilities
        .iter()
        .find(|capabilities| capabilities.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert_eq!(
        fixture_capabilities.adapter_id,
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
    );
    assert!(fixture_capabilities.reports.iter().any(|report| {
        report.capability == Capability::LineParityPatching
            && report.status == CapabilityStatus::Limited
    }));
    assert!(fixture_capabilities.access_contract.is_some());
    assert!(
        fixture_capabilities
            .helper_requirements
            .iter()
            .any(|requirement| {
                requirement.helper_registry_id == kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
                    && requirement.allowlist_ref_id == kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
                    && requirement
                        .capabilities
                        .contains(&HelperCapability::FixtureInvocation)
            })
    );
    assert!(capabilities.iter().any(|capabilities| {
        capabilities.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
            && capabilities.reports.iter().any(|report| {
                report.capability == Capability::Detection
                    && report.status == CapabilityStatus::Supported
            })
    }));

    let detect_path = root.join("detect.json");
    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Matched);
    let detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert!(detection.detected);
    assert_eq!(
        detection.adapter_id,
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
    );
    assert!(detection.evidence.iter().any(|evidence| {
        evidence.path == "source.json" && evidence.status == EvidenceStatus::Matched
    }));

    let profile_path = root.join("profile.json");
    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        profile_path.to_str().unwrap(),
    ]);
    let profile: GameProfile = read_json(&profile_path).unwrap();
    assert_eq!(
        profile.engine.adapter_id,
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
    );
    let layered_access = profile.layered_access.as_ref().unwrap();
    assert!(layered_access.surfaces.iter().any(|surface| {
        surface.container == kaifuu_core::ContainerTransform::Identity
            && surface.crypto == kaifuu_core::CryptoTransform::NullKey
            && surface.codec == kaifuu_core::CodecTransform::Identity
    }));
    assert!(profile.requirements.iter().any(|requirement| {
        requirement.category == RequirementCategory::SecretKey
            && requirement.status == RequirementStatus::NotRequired
            && requirement.secret
            && requirement.placeholder.is_none()
    }));

    let validation_path = root.join("profile-validation.json");
    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);
    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Passed);

    let bridge_path = root.join("bridge.json");
    run_cli(&[
        "extract",
        game_dir.to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    assert_eq!(bridge.units.len(), 1);

    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 1),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: bridge.units[0].source_unit_key.clone(),
            source_hash: bridge.units[0].source_hash.clone(),
            target_text: "Hello, {player}.".to_string(),
            protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 7, 15)],
        }],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();

    let patched_dir = root.join("patched");
    run_cli(&[
        "patch",
        game_dir.to_str().unwrap(),
        "--patch",
        patch_export_path.to_str().unwrap(),
        "--output",
        patched_dir.to_str().unwrap(),
    ]);
    let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
    assert_eq!(patch_result.status, OperationStatus::Passed);
    assert!(
        fs::read_to_string(patched_dir.join("source.json"))
            .unwrap()
            .contains("Hello, {player}.")
    );

    let verify_path = root.join("verify.json");
    run_cli(&[
        "verify",
        patched_dir.to_str().unwrap(),
        "--output",
        verify_path.to_str().unwrap(),
    ]);
    let verify: VerificationResult = read_json(&verify_path).unwrap();
    assert_eq!(verify.status, OperationStatus::Passed);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn diff_apply_commands_round_trip_v02_delta_package() {
    let root = temp_dir("diff-apply-v02");
    let game_dir = temp_game(&root);
    write_fixture_file(&game_dir, "readme.txt", b"same\n");

    let patched_dir = root.join("patched");
    fs::create_dir_all(&patched_dir).unwrap();
    write_fixture_file(
        &patched_dir,
        "source.json",
        br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
    );
    write_fixture_file(&patched_dir, "readme.txt", b"same\n");
    write_fixture_file(&patched_dir, "extra.txt", b"new\n");

    let delta_path = root.join("hello.kaifuu");
    run_cli(&[
        "diff",
        game_dir.to_str().unwrap(),
        patched_dir.to_str().unwrap(),
        "--output",
        delta_path.to_str().unwrap(),
    ]);
    let delta: serde_json::Value = read_json(&delta_path).unwrap();
    // bumped the kaifuu-delta-package schema from 0.2.0 to
    // 0.3.0 to add the required `sourceProvenance` envelope. The
    // round-trip diff/apply still works when no --source-extract is
    // passed; the resulting `sourceProvenance.partial` is false.
    assert_eq!(delta["schemaVersion"], "0.3.0");
    assert_eq!(delta["sourceProvenance"]["partial"], false);
    let changed_paths = delta["changedEntries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(changed_paths, vec!["extra.txt", "source.json"]);

    let output_dir = root.join("applied");
    run_cli(&[
        "apply",
        game_dir.to_str().unwrap(),
        "--patch",
        delta_path.to_str().unwrap(),
        "--output",
        output_dir.to_str().unwrap(),
    ]);

    let report_path = root.join("applied.kaifuu/patch-result.json");
    let apply_result: serde_json::Value = read_json(&report_path).unwrap();
    assert_eq!(apply_result["status"], "passed");
    assert_eq!(apply_result["changedFileCount"], 2);
    assert!(!output_dir.join("patch-result.json").exists());
    assert!(
        fs::read_to_string(output_dir.join("source.json"))
            .unwrap()
            .contains("Hello, {player}.")
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("readme.txt")).unwrap(),
        "same\n"
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("extra.txt")).unwrap(),
        "new\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_command_preserves_target_patch_result_and_writes_report_outside_output() {
    let root = temp_dir("apply-target-report-collision");
    let game_dir = temp_game(&root);

    let patched_dir = root.join("patched");
    fs::create_dir_all(&patched_dir).unwrap();
    write_fixture_file(
        &patched_dir,
        "source.json",
        br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
    );
    write_fixture_file(&patched_dir, "patch-result.json", b"real game file\n");

    let delta_path = root.join("hello.kaifuu");
    run_cli(&[
        "diff",
        game_dir.to_str().unwrap(),
        patched_dir.to_str().unwrap(),
        "--output",
        delta_path.to_str().unwrap(),
    ]);
    let delta: serde_json::Value = read_json(&delta_path).unwrap();
    assert!(
        delta["target"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["path"] == "patch-result.json")
    );

    let output_dir = root.join("applied");
    run_cli(&[
        "apply",
        game_dir.to_str().unwrap(),
        "--patch",
        delta_path.to_str().unwrap(),
        "--output",
        output_dir.to_str().unwrap(),
    ]);

    assert_eq!(
        fs::read(output_dir.join("patch-result.json")).unwrap(),
        b"real game file\n"
    );
    let report: serde_json::Value =
        read_json(&root.join("applied.kaifuu/patch-result.json")).unwrap();
    assert_eq!(report["status"], "passed");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_command_rejects_report_output_inside_patched_output() {
    let root = temp_dir("apply-report-output-guard");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            output_dir.join("patch-result.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside patched output directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn apply_command_rejects_report_output_inside_source() {
    let root = temp_dir("apply-report-source-guard");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            game_dir.join("report.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_default_report_sidecar_symlink_to_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-default-sidecar-symlink");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");
    unix_fs::symlink(&output_dir, root.join("applied.kaifuu")).unwrap();

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output path must not contain symlinks"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_report_output_symlink_to_source() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-output-symlink-source");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");
    let report_link = root.join("report-link");
    unix_fs::symlink(&game_dir, &report_link).unwrap();

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            report_link.join("report.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_report_output_symlink_to_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-output-symlink-output");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let output_dir = root.join("applied");
    let report_link = root.join("output-report-link");
    unix_fs::symlink(&output_dir, &report_link).unwrap();

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            report_link.join("patch-result.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output path must not contain symlinks"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_canonical_source_report_output_bypass() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-source-canonical");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let game_link = root.join("game-link");
    unix_fs::symlink(&game_dir, &game_link).unwrap();
    let output_dir = root.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_link.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            game_dir.join("report.json").to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn apply_command_rejects_canonical_output_report_output_bypass() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("apply-report-output-canonical");
    let (game_dir, delta_path) = write_apply_delta(&root);
    let real_parent = root.join("real-parent");
    fs::create_dir_all(&real_parent).unwrap();
    let linked_parent = root.join("linked-parent");
    unix_fs::symlink(&real_parent, &linked_parent).unwrap();
    let output_dir = linked_parent.join("applied");

    let result = run_with_args(
        [
            "apply",
            game_dir.to_str().unwrap(),
            "--patch",
            delta_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
            "--report-output",
            real_parent
                .join("applied")
                .join("patch-result.json")
                .to_str()
                .unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("apply report output must not be inside patched output directory"),
        "{error}"
    );
    assert!(!real_parent.join("applied").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_returns_error_when_adapter_reports_failed_patch_result() {
    let root = temp_dir("patch-failed-exit");
    let game_dir = temp_game(&root);
    let bridge_path = root.join("bridge.json");
    run_cli(&[
        "extract",
        game_dir.to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 1),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: bridge.units[0].source_unit_key.clone(),
            source_hash: bridge.units[0].source_hash.clone(),
            target_text: "Hello, {player}.".to_string(),
            protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 0, 8)],
        }],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let patched_dir = root.join("patched");

    let result = run_with_args(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch failed; see"));
    let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
    assert_eq!(patch_result.status, OperationStatus::Failed);
    assert!(!patched_dir.join("source.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_staging_when_adapter_errors_after_writing() {
    let root = temp_dir("patch-adapter-error-cleanup");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 79);
    let output_dir = root.join("patched-output");
    let registry =
        patch_filesystem_failure_registry(PatchFilesystemFailureMode::AdapterErrAfterWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("adapter failed after writing staged output"),
        "{error}"
    );
    assert!(!output_dir.exists());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_staging_when_promotion_fails_for_existing_output() {
    let root = temp_dir("patch-promotion-cleanup");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 80);
    let output_dir = root.join("patched-output");
    fs::create_dir_all(&output_dir).unwrap();
    fs::write(output_dir.join("existing.txt"), "existing output\n").unwrap();
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(output_dir.join("existing.txt")).unwrap(),
        "existing output\n"
    );
    assert!(!output_dir.join("adapter-output.txt").exists());
    assert!(!output_dir.join("patch-result.json").exists());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_output_symlink_before_staging_or_adapter_write() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-output-target-symlink");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 83);
    let output_dir = root.join("patched-output");
    let linked_target = root.join("linked-target");
    fs::create_dir(&linked_target).unwrap();
    unix_fs::symlink(&linked_target, &output_dir).unwrap();
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("patch output directory must not be a symlink"),
        "{error}"
    );
    assert!(fs::read_dir(&linked_target).unwrap().next().is_none());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_rejects_nested_output_before_staging_or_adapter_write() {
    let root = temp_dir("patch-output-nested-source");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 84);
    let output_dir = game_dir.join("patched-output");
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("patch output directory must not nest with source game directory"),
        "{error}"
    );
    assert!(!output_dir.exists());
    assert!(!game_dir.join("adapter-output.txt").exists());
    assert_no_patch_staging_entries(&game_dir, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_canonical_source_alias_and_nesting_before_output_mutation() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-output-canonical-source");
    let game_dir = root.join("game");
    let game_link = root.join("game-link");
    fs::create_dir_all(&game_dir).unwrap();
    unix_fs::symlink(&game_dir, &game_link).unwrap();
    let patch_export_path = empty_patch_export(&root, 85);
    let registry = patch_filesystem_failure_registry(PatchFilesystemFailureMode::SuccessfulWrite);

    let alias_result = run_with_args_and_registry(
        [
            "patch",
            game_link.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            game_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );
    let alias_error = alias_result.unwrap_err().to_string();
    assert!(
        alias_error.contains("patch output directory must not alias source game directory"),
        "{alias_error}"
    );

    let nested_output = game_dir.join("patched-output");
    let nested_result = run_with_args_and_registry(
        [
            "patch",
            game_link.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            nested_output.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );
    let nested_error = nested_result.unwrap_err().to_string();
    assert!(
        nested_error.contains("patch output directory must not nest with source game directory"),
        "{nested_error}"
    );

    assert!(!game_dir.join("adapter-output.txt").exists());
    assert!(!nested_output.exists());
    assert_no_patch_staging_entries(&root, "game");
    assert_no_patch_staging_entries(&game_dir, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_reallive_target_reallivedata_symlink_to_source_before_copy_or_write() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-reallive-target-data-symlink-source");
    let source_root = root.join("private-source-root");
    let source_data = source_root.join("REALLIVEDATA");
    let target_root = root.join("private-target-root");
    let target_data = target_root.join("REALLIVEDATA");
    let bundle_path = root.join("missing-translated-bundle.json");
    fs::create_dir_all(&source_data).unwrap();
    fs::create_dir_all(&target_root).unwrap();
    fs::write(
        source_data.join("Seen.txt"),
        b"synthetic source seen bytes\n",
    )
    .unwrap();
    unix_fs::symlink(&source_data, &target_data).unwrap();

    let result = run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--force",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.reallive.patchback_target_symlink"),
        "{error}"
    );
    assert!(
        error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
        "{error}"
    );
    for forbidden in [
        source_root.to_string_lossy(),
        source_data.to_string_lossy(),
        target_root.to_string_lossy(),
        target_data.to_string_lossy(),
    ] {
        assert!(
            !error.contains(forbidden.as_ref()),
            "diagnostic leaked private path {forbidden}: {error}"
        );
    }
    assert_eq!(
        fs::read(source_data.join("Seen.txt")).unwrap(),
        b"synthetic source seen bytes\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_command_rejects_reallive_nested_target_symlink_to_writable_dir_before_copy_or_write() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-reallive-target-data-symlink-writable");
    let source_root = root.join("private-source-root");
    let target_root = root.join("private-target-root");
    let linked_writable = root.join("private-linked-writable");
    let bundle_path = root.join("missing-translated-bundle.json");
    fs::create_dir_all(source_root.join("REALLIVEDATA")).unwrap();
    fs::create_dir_all(&target_root).unwrap();
    fs::create_dir_all(&linked_writable).unwrap();
    fs::write(
        source_root.join("REALLIVEDATA/Seen.txt"),
        b"synthetic source seen bytes\n",
    )
    .unwrap();
    unix_fs::symlink(&linked_writable, target_root.join("REALLIVEDATA")).unwrap();

    let result = run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--force",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    );

    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.reallive.patchback_target_symlink"),
        "{error}"
    );
    assert!(
        error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
        "{error}"
    );
    for forbidden in [
        source_root.to_string_lossy(),
        target_root.to_string_lossy(),
        linked_writable.to_string_lossy(),
    ] {
        assert!(
            !error.contains(forbidden.as_ref()),
            "diagnostic leaked private path {forbidden}: {error}"
        );
    }
    assert_eq!(
        fs::read(source_root.join("REALLIVEDATA/Seen.txt")).unwrap(),
        b"synthetic source seen bytes\n"
    );
    assert!(fs::read_dir(&linked_writable).unwrap().next().is_none());

    let _ = fs::remove_dir_all(root);
}

/// kaifuu-patch-touch-archive-not-copy-game-tree (pilot throughput):
/// the reallive patch flow must TOUCH ONLY the target archive — it must
/// NOT copy the multi-GB voice/image siblings of the game tree. This
/// test seeds a source tree with the real-shape `REALLIVEDATA/Seen.txt`
/// PLUS two large siblings (`voice/`, `image/`) standing in for the
/// ~5.7GB of assets a real title carries, runs the patch, and asserts:
/// - the ONLY file materialised under the target is
///   `REALLIVEDATA/Seen.txt` (no sibling was copied — the filesystem
///   footprint is exactly the target archive, so a per-scene patch is
///   target-sized, not full-tree-sized);
/// - the patched target archive is byte-for-byte the canonical
///   `apply_translated_bundle` output (declared text changes only — the
///   same byte-correct-patchback contract the round-trip tests assert);
/// - the source tree (Seen.txt AND both siblings) is untouched.
#[test]
fn patch_reallive_touches_only_target_archive_not_multi_gb_siblings() {
    use crate::binary_patch_smoke::{
        build_synthetic_seen_txt, build_synthetic_translated_bundle_json,
    };

    let root = temp_dir("patch-reallive-touch-archive-only");
    let source_root = root.join("source-game-tree");
    let source_data = source_root.join("REALLIVEDATA");
    fs::create_dir_all(&source_data).unwrap();

    let source_seen_bytes = build_synthetic_seen_txt();
    let source_seen_path = source_data.join("Seen.txt");
    fs::write(&source_seen_path, &source_seen_bytes).unwrap();
    let source_seen_hash_before = sha256_hash_bytes(&source_seen_bytes);

    // Large siblings standing in for the multi-GB voice/image trees a
    // real title ships. If the patch flow copied the whole tree these
    // would be duplicated under the target (~infeasible at scale). ~1MB
    // each keeps the test fast while remaining clearly "not the 3.7MB
    // archive".
    let big_sibling = vec![0xABu8; 1_048_576];
    let voice_dir = source_root.join("voice");
    let image_dir = source_root.join("image");
    fs::create_dir_all(&voice_dir).unwrap();
    fs::create_dir_all(&image_dir).unwrap();
    fs::write(voice_dir.join("z0001.ogg"), &big_sibling).unwrap();
    fs::write(image_dir.join("bg0001.g00"), &big_sibling).unwrap();

    // A valid translated bundle over the synthetic dialogue unit.
    let bundle_value = build_synthetic_translated_bundle_json("うえ", "reallive:scene-0001#0000");
    let bundle_path = root.join("translated-bundle.json");
    fs::write(
        &bundle_path,
        serde_json::to_vec_pretty(&bundle_value).unwrap(),
    )
    .unwrap();

    let target_root = root.join("target-patched");

    run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--scope",
            "dialogue-only",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .expect("patch must succeed");

    let target_seen_path = target_root.join("REALLIVEDATA").join("Seen.txt");
    assert!(
        target_seen_path.is_file(),
        "patched target Seen.txt must exist"
    );

    // Walk the whole target tree and collect every regular file. The
    // ONLY file must be REALLIVEDATA/Seen.txt — no voice/image sibling
    // was copied.
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![target_root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path);
            }
        }
    }
    assert_eq!(
        files,
        vec![target_seen_path.clone()],
        "the patch must touch ONLY the target archive; the multi-GB voice/image \
             siblings must NOT be copied into the target (found: {files:?})"
    );
    assert!(
        !target_root.with_extension("kaifuu").exists(),
        "without --delta-output, the compatible sparse-overlay command must not produce a default delta"
    );
    assert!(
        !target_root.join("voice").exists(),
        "voice sibling tree must not be copied to the target"
    );
    assert!(
        !target_root.join("image").exists(),
        "image sibling tree must not be copied to the target"
    );

    let target_seen_bytes = fs::read(&target_seen_path).unwrap();
    let translated =
        kaifuu_reallive::TranslatedBundleV02::from_json(&bundle_value).expect("bundle parses");
    let expected = kaifuu_reallive::apply_translated_bundle(
        &source_seen_bytes,
        &translated,
        &kaifuu_reallive::PatchbackOpts::shift_jis(kaifuu_reallive::TranslationScope::DialogueOnly),
    )
    .expect("canonical patchback succeeds");
    assert_eq!(
        target_seen_bytes, expected,
        "patched target archive must be byte-for-byte the canonical patchback output \
             (declared text changes only)"
    );
    // The patched archive still re-parses to the source's scene count.
    let src_index = kaifuu_reallive::parse_archive(&source_seen_bytes).unwrap();
    let tgt_index = kaifuu_reallive::parse_archive(&target_seen_bytes).unwrap();
    assert_eq!(tgt_index.entries.len(), src_index.entries.len());

    assert_eq!(
        sha256_hash_bytes(&fs::read(&source_seen_path).unwrap()),
        source_seen_hash_before,
        "source Seen.txt must be sha256-unchanged"
    );
    assert_eq!(
        fs::read(voice_dir.join("z0001.ogg")).unwrap(),
        big_sibling,
        "source voice sibling must be untouched"
    );
    assert_eq!(
        fs::read(image_dir.join("bg0001.g00")).unwrap(),
        big_sibling,
        "source image sibling must be untouched"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_reallive_delta_output_replaces_seen_and_inherits_source_siblings() {
    use crate::binary_patch_smoke::{
        build_synthetic_seen_txt, build_synthetic_translated_bundle_json,
    };

    let root = temp_dir("patch-reallive-delta-output");
    let source_root = root.join("source-game-tree");
    let source_data = source_root.join("REALLIVEDATA");
    fs::create_dir_all(&source_data).unwrap();
    let source_seen = build_synthetic_seen_txt();
    fs::write(source_data.join("Seen.txt"), &source_seen).unwrap();
    fs::write(source_root.join("voice.ogg"), b"source voice sibling").unwrap();
    fs::create_dir_all(source_root.join("config")).unwrap();
    fs::write(
        source_root.join("config/settings.bin"),
        b"source config sibling",
    )
    .unwrap();

    let bundle = build_synthetic_translated_bundle_json("うえ", "reallive:scene-0001#0000");
    let bundle_path = root.join("translated-bundle.json");
    fs::write(&bundle_path, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();
    let target_root = root.join("sparse-target");
    let delta_path = root.join("replacement.kaifuu");

    run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--scope",
            "dialogue-only",
            "--delta-output",
            delta_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .expect("patch and replacement delta must succeed");

    let target_seen_path = target_root.join("REALLIVEDATA/Seen.txt");
    let target_seen = fs::read(&target_seen_path).unwrap();
    assert_ne!(
        target_seen, source_seen,
        "patchback must replace Seen.txt bytes"
    );
    let source_index = kaifuu_reallive::parse_archive(&source_seen).unwrap();
    let target_index = kaifuu_reallive::parse_archive(&target_seen).unwrap();
    assert_eq!(target_index.entries.len(), source_index.entries.len());
    assert!(
        !target_root.join("voice.ogg").exists() && !target_root.join("config").exists(),
        "the direct target remains a sparse Seen-only overlay"
    );

    let delta: serde_json::Value = read_json(&delta_path).unwrap();
    let changed = delta["changedEntries"].as_array().unwrap();
    assert_eq!(changed.len(), 1, "delta must contain one replacement entry");
    assert_eq!(changed[0]["path"], "REALLIVEDATA/Seen.txt");
    assert_eq!(changed[0]["operation"], "replace");
    assert!(
        !changed.iter().any(|entry| entry["operation"] == "delete"),
        "replacement-only output must never delete source siblings"
    );

    let applied_root = root.join("applied-full-tree");
    apply_delta(&source_root, &delta_path, &applied_root).unwrap();
    assert_eq!(
        fs::read(applied_root.join("REALLIVEDATA/Seen.txt")).unwrap(),
        target_seen
    );
    assert_eq!(
        fs::read(applied_root.join("voice.ogg")).unwrap(),
        b"source voice sibling"
    );
    assert_eq!(
        fs::read(applied_root.join("config/settings.bin")).unwrap(),
        b"source config sibling"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_reallive_rejects_delta_output_inside_source_before_target_write() {
    use crate::binary_patch_smoke::{
        build_synthetic_seen_txt, build_synthetic_translated_bundle_json,
    };

    let root = temp_dir("patch-reallive-delta-inside-source");
    let source_root = root.join("source-game-tree");
    let source_data = source_root.join("REALLIVEDATA");
    fs::create_dir_all(&source_data).unwrap();
    let source_seen = build_synthetic_seen_txt();
    fs::write(source_data.join("Seen.txt"), &source_seen).unwrap();
    let bundle = build_synthetic_translated_bundle_json("うえ", "reallive:scene-0001#0000");
    let bundle_path = root.join("translated-bundle.json");
    fs::write(&bundle_path, serde_json::to_vec_pretty(&bundle).unwrap()).unwrap();
    let target_root = root.join("sparse-target");
    let invalid_delta = source_root.join("must-not-write.kaifuu");

    let error = run_patch_reallive_bundle(
        &[
            "patch",
            "--engine",
            "reallive",
            "--source",
            source_root.to_str().unwrap(),
            "--target",
            target_root.to_str().unwrap(),
            "--bundle",
            bundle_path.to_str().unwrap(),
            "--scope",
            "dialogue-only",
            "--delta-output",
            invalid_delta.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .unwrap_err()
    .to_string();

    assert!(
        error.contains("kaifuu.reallive.delta_output_inside_source"),
        "{error}"
    );
    assert_eq!(fs::read(source_data.join("Seen.txt")).unwrap(), source_seen);
    assert!(!invalid_delta.exists());
    assert!(
        !target_root.exists(),
        "rejected output must not create a target tree"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_promotion_rejects_empty_directory_created_after_staging() {
    let root = temp_dir("patch-promotion-empty-dir-race");
    let output_dir = root.join("patched-output");
    let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
    fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
    fs::create_dir(&output_dir).unwrap();

    let error = promote_patch_staging_dir(&staging_dir, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
        "staged output\n"
    );
    assert!(fs::read_dir(&output_dir).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_promotion_rejects_existing_file_without_touching_staging_or_output() {
    let root = temp_dir("patch-promotion-existing-file");
    let output_dir = root.join("patched-output");
    let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
    fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
    fs::write(&output_dir, "existing file\n").unwrap();

    let error = promote_patch_staging_dir(&staging_dir, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
        "staged output\n"
    );
    assert_eq!(fs::read_to_string(&output_dir).unwrap(), "existing file\n");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn patch_promotion_rejects_existing_symlink_like_output() {
    use std::os::unix::fs as unix_fs;

    let root = temp_dir("patch-promotion-existing-symlink");
    let output_dir = root.join("patched-output");
    let linked_target = root.join("linked-target");
    let staging_dir = allocate_patch_staging_dir(&output_dir).unwrap();
    fs::write(staging_dir.join("adapter-output.txt"), "staged output\n").unwrap();
    fs::create_dir(&linked_target).unwrap();
    unix_fs::symlink(&linked_target, &output_dir).unwrap();

    let error = promote_patch_staging_dir(&staging_dir, &output_dir)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("patch output directory already exists"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(staging_dir.join("adapter-output.txt")).unwrap(),
        "staged output\n"
    );
    assert!(
        fs::symlink_metadata(&output_dir)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_staging_when_report_write_fails() {
    let root = temp_dir("patch-report-write-cleanup");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export_path = empty_patch_export(&root, 81);
    let output_dir = root.join("patched-output");
    let registry =
        patch_filesystem_failure_registry(PatchFilesystemFailureMode::ReportWriteCollision);

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    assert!(result.is_err());
    assert!(!output_dir.exists());
    assert_no_patch_staging_entries(&root, "patched-output");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_preflight_failure_is_redacted_and_writes_no_output() {
    let root = temp_dir("patch-preflight-redaction");
    let game_dir = root.join("Private Route Spoiler Game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 77),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");
    let registry = preflight_registry();

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(
        error.contains(kaifuu_core::SEMANTIC_MISSING_CONTAINER_CAPABILITY),
        "{error}"
    );
    assert!(
        error.contains(kaifuu_core::SEMANTIC_MISSING_CRYPTO_CAPABILITY),
        "{error}"
    );
    assert!(!error.contains("00112233445566778899aabbccddeeff"));
    assert!(!error.contains("/home/dev"));
    assert!(!error.contains("Private Route Spoiler Game"));
    assert!(!error.contains("private-route-name"));
    assert!(!error.contains("helper dump"));
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_preflight_blocks_layered_contract_status_before_output_prepare() {
    let root = temp_dir("patch-preflight-contract-status");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 82),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");
    let registry = contract_status_preflight_registry();

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(
        error.contains(kaifuu_core::SEMANTIC_MISSING_PATCH_BACK_CAPABILITY),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_reports_encoded_string_slot_preflight_without_output_mutation() {
    let root = temp_dir("patch-encoded-string-slot-preflight");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "encoded-slot-fixture",
  "title": "Encoded Slot Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "slot.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "Hi",
      "encodedStringSlot": {
        "slotId": "slot.line.001",
        "encoding": "utf_8",
        "byteRange": { "start": 32, "end": 37 },
        "layout": { "kind": "null_terminated", "terminatorHex": "00" },
        "sourceBytesHex": "4869000000"
      }
    }
  ]
}
"#,
    )
    .unwrap();
    let bridge_path = root.join("bridge.json");
    run_cli(&[
        "extract",
        game_dir.to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 82),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: bridge.units[0].source_unit_key.clone(),
            source_hash: bridge.units[0].source_hash.clone(),
            target_text: "Overflow".to_string(),
            protected_span_mappings: vec![],
        }],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");

    let result = run_with_args(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(error.contains(kaifuu_core::STRING_SLOT_OVERFLOW), "{error}");
    assert!(error.contains("slot.line.001"), "{error}");
    assert!(error.contains("byte range 32..37"), "{error}");
    assert!(error.contains("shorten_translation"), "{error}");
    assert!(error.contains("encoded target plus terminator"), "{error}");
    assert!(!error.contains("Overflow"), "{error}");
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_malicious_adapter_output_on_late_preflight_failure() {
    let root = temp_dir("patch-preflight-malicious-output");
    let game_dir = root.join("malicious-game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 78),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");
    let registry = malicious_registry(AdapterFailure::missing_key_material(
        "kaifuu.test.malicious-preflight",
        "malicious-preflight-test",
        "writes-before-failure",
        "raw-key",
        "path=/home/dev/game helper dump contained 00112233445566778899aabbccddeeff",
    ));

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(error.contains(kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL));
    assert!(!error.contains("/home/dev"));
    assert!(!error.contains("helper dump"));
    assert!(!error.contains("00112233445566778899aabbccddeeff"));
    assert!(!output_dir.exists());
    let leaked_entries = fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("patched-output") && name.contains("kaifuu-staging"))
        .collect::<Vec<_>>();
    assert_eq!(leaked_entries, Vec::<String>::new());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_preflight_blocking_semantic_classes_write_no_output() {
    let cases = vec![
        AdapterFailure::missing_key_material(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "missing-key",
            "local-key",
            "missing local key material",
        ),
        AdapterFailure::helper_unavailable(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "helper-unavailable",
            "helper unavailable before patching",
        ),
        AdapterFailure::key_validation_failed(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "key-validation",
            "local-key",
            "key validation failed before patching",
        ),
        AdapterFailure::protected_executable_unsupported(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "protected-exe",
            "protected executable unsupported before patching",
        ),
        AdapterFailure::semantic(
            kaifuu_core::AdapterFailureSemanticParams::new(
                SemanticErrorCode::UnsupportedLayeredTransform,
                "kaifuu.test.malicious-preflight",
                "unsupported layered transform before patching",
            )
            .engine("semantic-test")
            .detected_variant("unsupported-layered-transform"),
        ),
        AdapterFailure::semantic(
            kaifuu_core::AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingCodecCapability,
                "kaifuu.test.malicious-preflight",
                "codec unavailable before patching",
            )
            .engine("semantic-test")
            .detected_variant("missing-codec")
            .required_capability(Capability::CodecAccess),
        ),
        AdapterFailure::semantic(
            kaifuu_core::AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingPatchBackCapability,
                "kaifuu.test.malicious-preflight",
                "patch-back unavailable before patching",
            )
            .engine("semantic-test")
            .detected_variant("missing-patch-back")
            .required_capability(Capability::PatchBack),
        ),
    ];

    for (index, failure) in cases.into_iter().enumerate() {
        let root = temp_dir(&format!("patch-preflight-semantic-{index}"));
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 790 + index),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let expected_code = failure.error_code.clone();
        let registry = malicious_registry(failure);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(error.contains(&expected_code), "{error}");
        assert!(!output_dir.exists(), "{expected_code} wrote output");
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn golden_command_runs_fixture_round_trip_and_public_translated_patch() {
    let root = temp_dir("golden-public-translated");
    let fixture_dir = public_fixture_dir();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");
    run_cli(&[
        "golden",
        fixture_dir.to_str().unwrap(),
        "--adapter",
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
        "--translated-patch",
        fixture_dir
            .join("expected/patch-export-v0.2.fr-FR.json")
            .to_str()
            .unwrap(),
        "--translated-source-bridge",
        fixture_dir
            .join("expected/bridge-v0.2.json")
            .to_str()
            .unwrap(),
        "--work-dir",
        work_dir.to_str().unwrap(),
        "--output",
        report_path.to_str().unwrap(),
    ]);

    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "byte_equivalence" && phase.status == GoldenAssertionStatus::Skipped
    }));
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "translated_target_equivalence"
            && phase.status == GoldenAssertionStatus::Passed
    }));
    assert!(
        fs::read_to_string(work_dir.join("translated-patch/source.json"))
            .unwrap()
            .contains("Bonjour, {player}.")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn golden_command_accepts_v02_translated_patch_with_native_source_hashes() {
    let root = temp_dir("golden-public-translated-no-source-bridge");
    let fixture_dir = public_fixture_dir();
    let patch_export = native_source_patch_export();
    let patch_path = root.join("native-source-patch-export.json");
    write_json(&patch_path, &patch_export).unwrap();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");

    run_cli(&[
        "golden",
        fixture_dir.to_str().unwrap(),
        "--adapter",
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
        "--translated-patch",
        patch_path.to_str().unwrap(),
        "--work-dir",
        work_dir.to_str().unwrap(),
        "--output",
        report_path.to_str().unwrap(),
    ]);

    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());
    assert!(report.phases.iter().any(|phase| {
        phase.phase == "translated_source_compatibility"
            && phase.status == GoldenAssertionStatus::Passed
            && phase.details.contains("native adapter extraction")
    }));
    assert!(work_dir.join("translated-patch/source.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn golden_command_rejects_native_v02_source_hash_mismatch_before_patch_write() {
    let root = temp_dir("golden-public-native-source-hash-mismatch");
    let fixture_dir = public_fixture_dir();
    let patch_export = native_source_hash_mismatch_patch_export();
    let patch_path = root.join("native-source-hash-mismatch-patch-export.json");
    write_json(&patch_path, &patch_export).unwrap();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");

    let result = run_with_args(
        [
            "golden",
            fixture_dir.to_str().unwrap(),
            "--adapter",
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
            "--translated-patch",
            patch_path.to_str().unwrap(),
            "--work-dir",
            work_dir.to_str().unwrap(),
            "--output",
            report_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    assert!(result.is_err());
    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    let failure = report
        .failures
        .iter()
        .find(|failure| failure.code == "translated_source_hash_mismatch")
        .expect("native source hash mismatch failure");
    assert_eq!(failure.phase, "translated_source_compatibility");
    assert_eq!(
        failure.asset_ref.as_deref(),
        Some("source.json#hello.scene.001.line.001")
    );
    assert!(failure.message.contains("native adapter extraction"));
    assert!(!report.phases.iter().any(|phase| {
        phase.phase == "translated_patch_conversion" || phase.phase == "translated_patch"
    }));
    assert!(!work_dir.join("translated-patch/source.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn golden_command_returns_error_and_report_for_translated_patch_failure() {
    let root = temp_dir("golden-public-translated-failure");
    let fixture_dir = public_fixture_dir();
    let mut patch_export: serde_json::Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    patch_export["entries"][0]["targetText"] = serde_json::json!("Bonjour.");
    let patch_path = root.join("bad-patch-export.json");
    write_json(&patch_path, &patch_export).unwrap();
    let report_path = root.join("golden-report.json");
    let work_dir = root.join("golden-work");

    let result = run_with_args(
        [
            "golden",
            fixture_dir.to_str().unwrap(),
            "--adapter",
            kaifuu_engine_fixture::FIXTURE_ADAPTER_ID,
            "--translated-patch",
            patch_path.to_str().unwrap(),
            "--translated-source-bridge",
            fixture_dir
                .join("expected/bridge-v0.2.json")
                .to_str()
                .unwrap(),
            "--work-dir",
            work_dir.to_str().unwrap(),
            "--output",
            report_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    assert!(result.is_err());
    let report: GoldenRoundTripReport = read_json(&report_path).unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "translated_source_compatibility"
            && failure.code == "translated_protected_span_mapping_mismatch"
            && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
            && failure
                .asset_ref
                .as_deref()
                .unwrap_or("")
                .contains("script/prologue#hello.scene.001.line.001")
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_unknown_directory_is_non_fatal_and_evidence_based() {
    let root = temp_dir("unknown-detect");
    let game_dir = root.join("unknown-game");
    fs::create_dir_all(&game_dir).unwrap();
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    assert_bgi_detection_absent_or_undetected(&detection_report);
    let softpal_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::SOFTPAL_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(!softpal_detection.detected);
    let fixture_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert!(!fixture_detection.detected);
    assert!(fixture_detection.evidence.iter().any(|evidence| {
        evidence.path == "source.json" && evidence.status == EvidenceStatus::Missing
    }));
    let xp3_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!xp3_detection.detected);
    assert!(xp3_detection.evidence.iter().any(|evidence| {
        evidence.path == "data.xp3" && evidence.status == EvidenceStatus::Missing
    }));
    let reallive_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(!reallive_detection.detected);
    assert!(
        detection_report
            .detections
            .iter()
            .all(|detection| !detection.detected)
    );
    assert!(detection_report.warnings[0].contains("no registered adapter"));

    let serialized = fs::read_to_string(&detect_path).unwrap();
    assert!(!serialized.contains("confidence"));
    let serialized_report: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    for detection_json in serialized_report["detections"].as_array().unwrap() {
        let detection_json = detection_json.as_object().unwrap();
        assert!(!detection_json.contains_key("engineFamily"));
        assert!(!detection_json.contains_key("engineVersion"));
        assert!(!detection_json.contains_key("detectedVariant"));
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_cli_writes_archive_detection_matrix_without_adapter_support_claim() {
    let root = temp_dir("archive-detect");
    let game_dir = root.join("Private Route Spoiler Game");
    fs::create_dir_all(&game_dir).unwrap();
    write_fixture_file(&game_dir, "game/scripts.rpa", b"RenPy archive synthetic");
    write_fixture_file(
        &game_dir,
        "www/data/System.json",
        br#"{
  "hasEncryptedImages": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
    );
    write_fixture_file(&game_dir, "img/pictures/private-title.rpgmvp", b"encrypted");
    write_fixture_file(&game_dir, "img/pictures/private-title.png_", b"encrypted");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.game_dir, REDACTED_DETECTION_GAME_DIR);
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    assert_eq!(
        detection_report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(!detection_report.detections[0].detected);
    assert!(
        detection_report
            .warnings
            .iter()
            .any(|warning| { warning.contains("no registered extraction adapter") })
    );

    let rpg_maker = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
        .unwrap();
    assert!(rpg_maker.detected);
    assert!(
        rpg_maker
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.rpgmvu|*.png_|*.m4a_|*.ogg_"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 2
    }));
    assert!(
        rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
    );
    assert!(rpg_maker.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));

    let serialized = fs::read_to_string(&detect_path).unwrap();
    assert!(serialized.contains("\"archiveDetection\""));
    assert!(!serialized.contains(&game_dir.display().to_string()));
    assert!(!serialized.contains("Private Route Spoiler Game"));
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("private-title"));
    assert!(!serialized.contains("confidence"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_cli_matches_public_rpg_maker_encrypted_suffix_fixture_report() {
    let root = temp_dir("public-rpg-maker-suffix-detect");
    let game_dir = public_fixture_path("fixtures/public/kaifuu-rpg-maker-encrypted-suffixes");
    let expected_path = game_dir.join("expected/detection-report-v0.1.json");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let actual: serde_json::Value = read_json(&detect_path).unwrap();
    let expected: serde_json::Value = read_json(&expected_path).unwrap();
    assert_eq!(without_bgi_detection(actual.clone()), expected);

    let detection_report: DetectionReport = serde_json::from_value(actual).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    assert_eq!(
        detection_report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(!detection_report.detections[0].detected);
    let rpg_maker = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
        .unwrap();
    assert!(rpg_maker.detected);
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.rpgmvu|*.png_|*.m4a_|*.ogg_"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 7
    }));
    assert!(
        rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
    );
    assert_eq!(rpg_maker.detected_variant, "mv_or_mz_with_unknown_suffix");
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-mv-image-rpgmvp"
            && surface.engine_family == "rpg_maker_mv_mz"
            && surface.variant == "mv_or_mz"
            && surface.container == ContainerTransform::ProjectAsset
            && surface.crypto == CryptoTransform::RpgMakerAssetXor
            && surface.codec == CodecTransform::PngImage
            && surface.surface == "image_asset"
            && surface.key_requirement_refs == vec!["rpg-maker-mv-mz-asset-key".to_string()]
    }));
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-plain-image-png"
            && surface.variant == "plain_asset"
            && surface.crypto == CryptoTransform::NullKey
            && surface.key_requirement_refs.is_empty()
            && surface.diagnostics.is_empty()
    }));
    let unknown_surfaces = rpg_maker
        .surfaces
        .iter()
        .filter(|surface| surface.variant == "unknown_suffix")
        .collect::<Vec<_>>();
    assert_eq!(unknown_surfaces.len(), 1);
    for surface in unknown_surfaces {
        assert_eq!(surface.crypto, CryptoTransform::Unknown);
        assert!(surface.key_requirement_refs.is_empty());
        assert!(
            surface.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            })
        );
        assert!(
            !surface
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
        );
    }

    let serialized = fs::read_to_string(&detect_path).unwrap();
    for forbidden in [
        "title.rpgmvp",
        "theme.rpgmvm",
        "cursor.rpgmvo",
        "title.rpgmvu",
        "title.webp_",
    ] {
        assert!(!serialized.contains(forbidden), "report leaked {forbidden}");
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_validate_fixture_key_command_writes_redacted_proof_report() {
    let root = temp_dir("rpg-maker-key-validation-cli");
    let secret_store = root.join("secret-store");
    write_fixture_file(
        &secret_store,
        "fixture/rpg-maker/asset-key",
        b"00112233445566778899aabbccddeeff",
    );
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    let image_asset = game_dir.join("img").join("pictures").join("title.rpgmvp");
    let output = root.join("rpg-maker-key-validation.json");

    run_cli(&[
        "rpg-maker",
        "validate-fixture-key",
        "--game-dir",
        game_dir.to_str().unwrap(),
        "--image-asset",
        image_asset.to_str().unwrap(),
        "--secret-store",
        secret_store.to_str().unwrap(),
        "--secret-ref",
        "local-secret:fixture/rpg-maker/asset-key",
        "--output",
        output.to_str().unwrap(),
        "--fixture-id",
        "kaifuu-rpg-maker-mv-mz-key-validation-success",
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["decryptOrPatchClaimed"], false);
    assert_eq!(
        report["records"][0]["requirementId"],
        "rpg-maker-mv-mz-asset-key"
    );
    assert_eq!(report["records"][0]["surface"], "image_asset");
    assert_eq!(report["records"][0]["codec"], "png_image");
    assert_eq!(report["records"][0]["diagnosticResult"], "success");
    assert!(
        report["records"][0]["proofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
        secret_store.to_str().unwrap(),
        image_asset.to_str().unwrap(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "CLI report leaked {forbidden}: {serialized}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_validate_fixture_key_command_fails_without_image_evidence() {
    let root = temp_dir("rpg-maker-key-validation-cli-missing-image");
    let secret_store = root.join("secret-store");
    write_fixture_file(
        &secret_store,
        "fixture/rpg-maker/asset-key",
        b"00112233445566778899aabbccddeeff",
    );
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    let missing_image_asset = game_dir.join("img").join("pictures").join("missing.rpgmvp");
    let output = root.join("rpg-maker-key-validation-missing-image.json");

    let result = run_with_args(
        [
            "rpg-maker",
            "validate-fixture-key",
            "--game-dir",
            game_dir.to_str().unwrap(),
            "--image-asset",
            missing_image_asset.to_str().unwrap(),
            "--secret-store",
            secret_store.to_str().unwrap(),
            "--secret-ref",
            "local-secret:fixture/rpg-maker/asset-key",
            "--output",
            output.to_str().unwrap(),
            "--fixture-id",
            "kaifuu-rpg-maker-missing-image-evidence",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.expect_err("missing image evidence must fail validation");
    let error = error.to_string();
    assert!(error.contains("MissingImageEvidence:imageAssetPath"));

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["records"][0]["surface"], "image_asset");
    assert_eq!(report["records"][0]["codec"], "png_image");
    assert_eq!(
        report["records"][0]["diagnosticResult"],
        "missing_image_evidence"
    );
    assert!(report["records"][0]["proofHash"].is_null());
    assert!(report["records"][0]["imageEvidenceHash"].is_null());
    assert!(
        report["records"][0]["systemJsonProofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(report["diagnostics"][0]["code"], "missing_image_evidence");
    assert_eq!(report["diagnostics"][0]["field"], "imageAssetPath");
    assert_eq!(
        report["diagnostics"][0]["message"],
        "encrypted image evidence is missing or unreadable"
    );

    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
        secret_store.to_str().unwrap(),
        missing_image_asset.to_str().unwrap(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "CLI report leaked {forbidden}: {serialized}"
        );
    }
    assert!(!serialized.contains("image evidence matched"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn siglus_detector_profile_fixture_reports_identify_inventory_only() {
    let root = temp_dir("public-siglus-detector");
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
    let expected_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/expected");

    let detect_path = root.join("siglus-detect.json");
    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    let actual_detection: serde_json::Value = read_json(&detect_path).unwrap();
    let detection_report: DetectionReport = serde_json::from_value(actual_detection).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Matched);
    assert_bgi_detection_absent_or_undetected(&detection_report);
    let siglus_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(siglus_detection.detected);
    assert_eq!(siglus_detection.engine_family.as_deref(), Some("siglus"));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::Detection
            && capability.status == CapabilityStatus::Supported
    }));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::AssetInventory
            && capability.status == CapabilityStatus::Supported
    }));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(siglus_detection.capabilities.iter().any(|capability| {
        capability.capability == Capability::RuntimeVm
            && capability.status == CapabilityStatus::Unsupported
    }));

    let profile_path = root.join("siglus-profile.json");
    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        profile_path.to_str().unwrap(),
    ]);
    let actual_profile: serde_json::Value = read_json(&profile_path).unwrap();
    let expected_profile: serde_json::Value =
        read_json(&expected_root.join("siglus-detector-profile-v0.1.json")).unwrap();
    assert_eq!(actual_profile, expected_profile);
    let profile: GameProfile = serde_json::from_value(actual_profile).unwrap();
    assert_eq!(profile.profile_id, "019ed000-0000-7000-8000-000000091001");
    assert_eq!(
        profile
            .metadata
            .get("profileDiagnostics.encryptedPayload")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        profile
            .metadata
            .get("profileDiagnostics.unsupportedParserBoundary")
            .map(String::as_str),
        Some("true")
    );
    assert!(profile.assets.iter().all(|asset| {
        asset
            .source_hash
            .as_deref()
            .unwrap_or("")
            .starts_with("sha256:")
    }));
    assert!(profile.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));

    let inventory_path = root.join("siglus-inventory.json");
    run_cli(&[
        "asset-inventory",
        game_dir.to_str().unwrap(),
        "--output",
        inventory_path.to_str().unwrap(),
    ]);
    let actual_inventory: serde_json::Value = read_json(&inventory_path).unwrap();
    let expected_inventory: serde_json::Value =
        read_json(&expected_root.join("siglus-asset-inventory-v0.1.json")).unwrap();
    assert_eq!(actual_inventory, expected_inventory);
    let inventory: AssetInventoryManifest = serde_json::from_value(actual_inventory).unwrap();
    assert_eq!(inventory.validate().status, OperationStatus::Passed);
    assert!(inventory.assets.iter().all(|asset| {
        asset
            .source_hash
            .as_deref()
            .unwrap_or("")
            .starts_with("sha256:")
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn siglus_parser_boundary_smoke_cli_writes_redacted_report_and_blocks_unsupported_opcode() {
    let root = temp_dir("siglus-parser-boundary-smoke");
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
    let key_request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    );

    let success_output = root.join("siglus-parser-boundary-success.json");
    run_cli(&[
        "siglus",
        "parser-boundary-smoke",
        "--scene",
        game_dir.join("Scene.pck").to_str().unwrap(),
        "--gameexe",
        game_dir.join("Gameexe.dat").to_str().unwrap(),
        "--key-request",
        key_request.to_str().unwrap(),
        "--output",
        success_output.to_str().unwrap(),
    ]);
    let success: serde_json::Value = read_json(&success_output).unwrap();
    let expected_success: serde_json::Value = read_json(&public_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json",
    ))
    .unwrap();
    assert_eq!(success, expected_success);
    assert_eq!(success["status"], "passed");
    assert_eq!(success["outcome"], "parser_boundary_success");
    assert_eq!(success["profileId"], "019ed000-0000-7000-8000-000000091001");
    assert_eq!(success["patchWriteAttempted"], false);
    assert_eq!(
        success["textSlots"][0]["textSlotId"],
        "siglus.synthetic.scene.text.001"
    );
    assert_eq!(
        success["textSlots"][0]["byteSpan"],
        serde_json::json!({"startByte": 17, "endByte": 52})
    );

    let unsupported_output = root.join("siglus-parser-boundary-unsupported.json");
    let result = run_with_args(vec![
        "siglus".to_string(),
        "parser-boundary-smoke".to_string(),
        "--scene".to_string(),
        game_dir.join("Scene.pck").to_str().unwrap().to_string(),
        "--gameexe".to_string(),
        game_dir.join("Gameexe.dat").to_str().unwrap().to_string(),
        "--key-request".to_string(),
        key_request.to_str().unwrap().to_string(),
        "--variant".to_string(),
        "unsupported-opcode".to_string(),
        "--output".to_string(),
        unsupported_output.to_str().unwrap().to_string(),
    ]);
    assert!(result.is_err());
    let unsupported: serde_json::Value = read_json(&unsupported_output).unwrap();
    assert_eq!(unsupported["status"], "failed");
    assert_eq!(unsupported["outcome"], "unsupported_opcode");
    assert_eq!(unsupported["patchWriteAttempted"], false);
    assert_eq!(
        unsupported["diagnostics"][0]["semanticCode"],
        kaifuu_core::SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE
    );
    assert_eq!(
        unsupported["diagnostics"][0]["unsupportedOpcode"],
        "SIGLUS_SYNTH_UNSUPPORTED_7f"
    );

    for output in [success_output, unsupported_output] {
        let serialized = fs::read_to_string(output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "fixture-only-siglus-secondary-key-v1",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    let _ = fs::remove_dir_all(root);
}

/// Build a synthetic profile-proof fixture into `dir`, wiring the
/// composed slices at absolute paths to the committed synthetic fixtures. The
/// optional `seed_key_profile_id` overrides `keyProfile.keyProfileId` so the
/// deep-scan reject tests can inject secret-shaped material; `capability_level`
/// overrides the honest default.
fn write_siglus_profile_proof_fixture(
    dir: &Path,
    seed_key_profile_id: Option<&str>,
    capability_level: &str,
) -> PathBuf {
    let raw = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus");
    let key_request = public_fixture_path(
        "fixtures/public/kaifuu-helper-results/helper-request/siglus-secondary-key-request.json",
    );
    let compat = public_fixture_path("fixtures/kaifuu/compat-profile/siglus.extract.tuple.json");
    let fixture = serde_json::json!({
        "schemaVersion": "0.1.0",
        "fixtureId": "kaifuu-siglus-synthetic-profile-proof",
        "profileId": "019ed000-0000-7000-8000-000000091001",
        "detectorGameDir": raw.to_str().unwrap(),
        "parser": {
            "parserProfileId": "019ed000-0000-7000-8000-000000091001",
            "scene": raw.join("Scene.pck").to_str().unwrap(),
            "gameexe": raw.join("Gameexe.dat").to_str().unwrap(),
            "keyRequest": key_request.to_str().unwrap(),
            "variant": "parser-boundary-success"
        },
        "keyProfile": {
            "keyProfileId": seed_key_profile_id.unwrap_or("siglus-secondary-key"),
            "secretRef": "local-secret:fixture/siglus/secondary-key-ref"
        },
        "compatTuple": compat.to_str().unwrap(),
        "capabilityLevel": capability_level
    });
    let path = dir.join("synthetic-profile.json");
    fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap()).unwrap();
    path
}

#[test]
fn siglus_profile_proof_composes_slices_into_honest_redacted_report() {
    let root = temp_dir("siglus-profile-proof-happy");
    let fixture = write_siglus_profile_proof_fixture(&root, None, "known-key-extract");
    let out = root.join("profile-proof.json");

    run_with_args(vec![
        "siglus".to_string(),
        "profile-proof".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--out".to_string(),
        out.to_str().unwrap().to_string(),
    ])
    .unwrap();

    let report: serde_json::Value = read_json(&out).unwrap();
    assert_eq!(report["status"], "passed");
    // (1) records detector evidence + key-profile-id + parser-profile-id +
    // capability-level + redaction-summary.
    assert_eq!(report["detector"]["detected"], true);
    assert_eq!(report["detector"]["engineFamily"], "siglus");
    assert!(
        report["detector"]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|evidence| evidence["status"] == "matched")
    );
    assert_eq!(report["keyProfile"]["keyProfileId"], "siglus-secondary-key");
    assert_eq!(report["keyProfile"]["extractCoreStatus"], "not_implemented");
    assert_eq!(
        report["parserProfile"]["parserProfileId"],
        "019ed000-0000-7000-8000-000000091001"
    );
    assert_eq!(
        report["parserProfile"]["outcome"],
        "parser_boundary_success"
    );
    assert_eq!(report["capabilityLevel"], "known-key-extract");
    assert_eq!(report["redactionSummary"]["deepScanPerformed"], true);
    assert_eq!(report["redactionSummary"]["secretLeakFindings"], 0);
    assert_eq!(report["redactionSummary"]["redactionBoundaryOk"], true);
    // Honest scope: never claims broad commercial Siglus support.
    assert_eq!(report["broadCommercialClaim"], false);
    assert_eq!(report["compat"]["honest"], true);
    assert_eq!(report["compat"]["patchBackMode"], "unsupported");

    // Deterministic: a second run over the same fixture is byte-identical.
    let out2 = root.join("profile-proof-2.json");
    run_with_args(vec![
        "siglus".to_string(),
        "profile-proof".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--out".to_string(),
        out2.to_str().unwrap().to_string(),
    ])
    .unwrap();
    assert_eq!(
        fs::read_to_string(&out).unwrap(),
        fs::read_to_string(&out2).unwrap()
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn siglus_profile_proof_rejects_seeded_secrets_before_write() {
    // A raw key, helper dump, private path, and decrypted private text seeded
    // into the input are each REJECTED from the persisted artifact: the
    // command fails loud and writes nothing.
    for seed in [
        "00112233445566778899aabbccddeeff00112233",
        "helper dump of the secondary key state",
        "/home/trevor/games/siglus/private/Scene.pck",
        "decrypted script: secret dialogue",
    ] {
        let root = temp_dir("siglus-profile-proof-seed");
        let fixture = write_siglus_profile_proof_fixture(&root, Some(seed), "known-key-extract");
        let out = root.join("profile-proof.json");

        let result = run_with_args(vec![
            "siglus".to_string(),
            "profile-proof".to_string(),
            "--fixture".to_string(),
            fixture.to_str().unwrap().to_string(),
            "--out".to_string(),
            out.to_str().unwrap().to_string(),
        ]);
        assert!(result.is_err(), "seed {seed:?} should be rejected");
        assert!(
            !out.exists(),
            "seed {seed:?} must persist no artifact before write"
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn siglus_profile_proof_rejects_capability_overclaim() {
    // Declaring known-key-patch-verify overclaims past the evidence ceiling
    // (the extract/patch core is NotImplemented): the proof fails.
    let root = temp_dir("siglus-profile-proof-overclaim");
    let fixture = write_siglus_profile_proof_fixture(&root, None, "known-key-patch-verify");
    let out = root.join("profile-proof.json");

    let result = run_with_args(vec![
        "siglus".to_string(),
        "profile-proof".to_string(),
        "--fixture".to_string(),
        fixture.to_str().unwrap().to_string(),
        "--out".to_string(),
        out.to_str().unwrap().to_string(),
    ]);
    assert!(result.is_err());
    // The Failed report IS written (no secret leak), recording the overclaim.
    let report: serde_json::Value = read_json(&out).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["semanticCode"]
                == kaifuu_core::SEMANTIC_SIGLUS_PROFILE_PROOF_CAPABILITY_OVERCLAIM)
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_detector_profile_fixture_reports_variant_profiles_and_unknown_diagnostics() {
    let root = temp_dir("public-xp3-detector");
    let fixture_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix");
    let expected_root = fixture_root.join("expected");

    for (variant, expected_name) in [
        ("plain", "xp3-plain-detector-profile-v0.1.json"),
        ("encrypted", "xp3-encrypted-detector-profile-v0.1.json"),
        ("compressed", "xp3-compressed-detector-profile-v0.1.json"),
    ] {
        let game_dir = fixture_root.join("xp3-profiles").join(variant);
        let profile_path = root.join(format!("xp3-{variant}-profile.json"));
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ]);
        let actual_profile: serde_json::Value = read_json(&profile_path).unwrap();
        let expected_profile: serde_json::Value =
            read_json(&expected_root.join(expected_name)).unwrap();
        assert_eq!(actual_profile, expected_profile);

        let profile: GameProfile = serde_json::from_value(actual_profile).unwrap();
        assert_eq!(
            profile.engine.adapter_id,
            kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
        );
        assert_eq!(profile.validate().status, OperationStatus::Passed);
        assert!(profile.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));
        if variant == "encrypted" {
            assert_eq!(profile.key_requirements.len(), 1);
            assert!(
                profile
                    .layered_access
                    .as_ref()
                    .unwrap()
                    .surfaces
                    .iter()
                    .any(|surface| surface.key_requirement_refs
                        == vec!["kirikiri-xp3-key-profile".to_string()])
            );
        }
        if variant == "compressed" {
            assert!(profile.archive_parameters.iter().any(|parameter| {
                parameter.kind == kaifuu_core::ArchiveParameterKind::Compression
                    && parameter.value == "compressed"
            }));
        }
    }

    let unknown_dir = fixture_root.join("xp3-profiles/unknown");
    let detect_path = root.join("xp3-unknown-detect.json");
    run_cli(&[
        "detect",
        unknown_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    let actual_detection: serde_json::Value = read_json(&detect_path).unwrap();
    let expected_detection: serde_json::Value =
        read_json(&expected_root.join("xp3-unknown-detection-report-v0.1.json")).unwrap();
    assert_eq!(
        without_bgi_detection(actual_detection.clone()),
        expected_detection
    );
    let detection_report: DetectionReport = serde_json::from_value(actual_detection).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    let xp3_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!xp3_detection.detected);
    assert_eq!(
        xp3_detection.detected_variant.as_deref(),
        Some("xp3-unknown-container")
    );
    let xp3_archive = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "kirikiri-xp3")
        .unwrap();
    assert!(
        xp3_archive
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SemanticErrorCode::UnknownEngineVariant)
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_cli_reports_reallive_adapter_on_synthetic_fixture() {
    let root = temp_dir("public-reallive-detect-positive");
    let game_dir =
        public_fixture_path("fixtures/public/reallive-detector/positive-synthetic-triple");
    let expected_path = game_dir.join("expected/detection-report.json");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let actual: serde_json::Value = read_json(&detect_path).unwrap();
    let expected: serde_json::Value = read_json(&expected_path).unwrap();
    assert_eq!(without_bgi_detection(actual.clone()), expected);

    let detection_report: DetectionReport = serde_json::from_value(actual).unwrap();
    let reallive_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(reallive_detection.detected);
    assert_eq!(
        reallive_detection.engine_family.as_deref(),
        Some("reallive")
    );
    assert_eq!(
        reallive_detection.detected_variant.as_deref(),
        Some("reallive-synthetic-triple")
    );
}

#[test]
fn detect_cli_emits_archive_detection_matrix_reallive_row_with_aggregate_evidence_only() {
    let root = temp_dir("public-reallive-detect-matrix-row");
    let game_dir =
        public_fixture_path("fixtures/public/reallive-detector/positive-synthetic-triple");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    let reallive_row = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .expect("RealLive matrix row missing");
    assert!(reallive_row.detected);
    assert_eq!(reallive_row.detected_variant, "reallive-seen-txt-archive");
    assert!(reallive_row.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(reallive_row.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));
}

#[test]
fn detect_cli_emits_ambiguous_engine_variant_diagnostic_when_reallive_and_siglus_markers_co_present()
 {
    let root = temp_dir("public-reallive-detect-ambiguous");
    let game_dir = public_fixture_path("fixtures/public/reallive-detector/negative-siglus-overlap");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    let reallive_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(!reallive_detection.detected);
    assert_eq!(
        reallive_detection.detected_variant.as_deref(),
        Some("ambiguous-reallive-siglus-overlap")
    );
    let reallive_row = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .expect("RealLive matrix row missing");
    assert!(
        reallive_row
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::AmbiguousEngineVariant })
    );
}

#[test]
fn capabilities_cli_lists_reallive_adapter_with_kaifuu_174_inventory_support_boundary() {
    let root = temp_dir("public-reallive-capabilities");
    let capabilities_path = root.join("capabilities.json");
    run_cli(&[
        "capabilities",
        "--output",
        capabilities_path.to_str().unwrap(),
    ]);
    let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
    let reallive_caps = capabilities
        .iter()
        .find(|caps| caps.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID)
        .expect("RealLive adapter missing from capabilities output");
    for required in [
        Capability::Detection,
        Capability::ProfileGeneration,
        Capability::AssetListing,
        Capability::AssetInventory,
        Capability::Extraction,
        Capability::ContainerAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        assert!(
            reallive_caps.reports.iter().any(|report| {
                report.capability == required && report.status == CapabilityStatus::Supported
            }),
            "RealLive adapter missing supported {required:?}"
        );
    }
    for unsupported in [Capability::RuntimeVm, Capability::EncryptedInput] {
        assert!(
            reallive_caps.reports.iter().any(|report| {
                report.capability == unsupported && report.status == CapabilityStatus::Unsupported
            }),
            "RealLive adapter missing unsupported {unsupported:?}"
        );
    }
    // Patching is Limited per (§3.3): length-changing Scene/SEEN
    // text-slot replacement, but limited to one scene-scoped bundle per
    // call and to the configured text scope (not image-overlaid.g00 text).
    assert!(
        reallive_caps.reports.iter().any(|report| {
            report.capability == Capability::Patching && report.status == CapabilityStatus::Limited
        }),
        "RealLive adapter must report Patching as Limited at KAIFUU-174 (length-changing single-scene text-slot replacement)"
    );
    // Field PR #2: typed level matrix must not under-detect real patch.
    assert!(
        reallive_caps.level_matrix.patch.is_partial(),
        "RealLive level matrix must expose partial Patch for length-changing single-scene patch-back"
    );
}

#[test]
fn xp3_inventory_cli_reports_plain_file_table_separately_from_extract_and_patch() {
    let root = temp_dir("xp3-inventory-cli");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("data.xp3"),
        plain_xp3_fixture(&[
            Xp3TestEntry {
                path: "scenario/intro.ks",
                payload: b"plain text payload",
                compressed: false,
                adler32: 0x0102_0304,
            },
            Xp3TestEntry {
                path: "image/title.png",
                payload: b"compressed-image-bytes",
                compressed: true,
                adler32: 0x0506_0708,
            },
        ]),
    )
    .unwrap();
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
    assert!(inventory.capabilities.iter().any(|capability| {
        capability.capability == Capability::AssetInventory
            && capability.status == CapabilityStatus::Supported
    }));
    assert!(inventory.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(inventory.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));

    let script = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "scenario/intro.ks")
        .unwrap();
    let script_hash = sha256_hash_bytes(b"plain text payload");
    assert_eq!(script.source_hash.as_deref(), Some(script_hash.as_str()));
    assert_eq!(
        script.metadata.get("profileId").map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );
    assert_eq!(
        script.metadata.get("compressed").map(String::as_str),
        Some("false")
    );

    let image = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "image/title.png")
        .unwrap();
    assert_eq!(image.asset_kind, AssetInventoryAssetKind::Image);
    assert_eq!(
        image.metadata.get("compressed").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        image.metadata.get("storedAdler32").map(String::as_str),
        Some("adler32:05060708")
    );

    let _ = fs::remove_dir_all(root);
}

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

#[test]
fn siglus_detector_reports_missing_pair_and_unknown_variant_diagnostics() {
    let root = temp_dir("siglus-detector-diagnostics");
    let source_fixture =
        public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Scene.pck");
    let missing_pair_dir = root.join("missing-pair");
    fs::create_dir_all(&missing_pair_dir).unwrap();
    fs::copy(&source_fixture, missing_pair_dir.join("Scene.pck")).unwrap();

    let missing_pair_detect = root.join("missing-pair-detect.json");
    run_cli(&[
        "detect",
        missing_pair_dir.to_str().unwrap(),
        "--output",
        missing_pair_detect.to_str().unwrap(),
    ]);
    let missing_report: DetectionReport = read_json(&missing_pair_detect).unwrap();
    let missing_siglus = missing_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!missing_siglus.detected);
    assert_eq!(
        missing_siglus.detected_variant.as_deref(),
        Some("scene-pck-missing-gameexe-dat")
    );
    assert!(missing_siglus.requirements.iter().any(|requirement| {
        requirement.key == "Gameexe.dat" && requirement.status == RequirementStatus::Missing
    }));

    let missing_profile = root.join("missing-pair-profile.json");
    let missing_profile_error = run_cli_with_registry_result(
        &[
            "profile",
            "init",
            missing_pair_dir.to_str().unwrap(),
            "--output",
            missing_profile.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(missing_profile_error.contains("kaifuu.missing_capability.container"));
    assert!(missing_profile_error.contains("scene-pck-missing-gameexe-dat"));
    assert!(!missing_profile.exists());

    let missing_inventory = root.join("missing-pair-inventory.json");
    let missing_inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            missing_pair_dir.to_str().unwrap(),
            "--output",
            missing_inventory.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(missing_inventory_error.contains("kaifuu.missing_capability.container"));
    assert!(missing_inventory_error.contains("scene-pck-missing-gameexe-dat"));
    assert!(!missing_inventory.exists());

    let unknown_dir = root.join("unknown-variant");
    fs::create_dir_all(&unknown_dir).unwrap();
    fs::write(
        unknown_dir.join("Scene.pck"),
        b"fixture-only unknown siglus-like scene",
    )
    .unwrap();
    fs::write(
        unknown_dir.join("Gameexe.dat"),
        b"fixture-only unknown siglus-like metadata",
    )
    .unwrap();
    let unknown_detect = root.join("unknown-detect.json");
    run_cli(&[
        "detect",
        unknown_dir.to_str().unwrap(),
        "--output",
        unknown_detect.to_str().unwrap(),
    ]);
    let report: DetectionReport = read_json(&unknown_detect).unwrap();
    let siglus = report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!siglus.detected);
    assert_eq!(
        siglus.detected_variant.as_deref(),
        Some("unknown-siglus-named-files")
    );
    assert!(siglus.requirements.iter().any(|requirement| {
        requirement.key == "siglus-synthetic-signature"
            && requirement.status == RequirementStatus::Unsupported
    }));

    let unknown_profile = root.join("unknown-variant-profile.json");
    let unknown_profile_error = run_cli_with_registry_result(
        &[
            "profile",
            "init",
            unknown_dir.to_str().unwrap(),
            "--output",
            unknown_profile.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(unknown_profile_error.contains("kaifuu.unknown_engine_variant"));
    assert!(unknown_profile_error.contains("unknown-siglus-named-files"));
    assert!(!unknown_profile.exists());

    let unknown_inventory = root.join("unknown-variant-inventory.json");
    let unknown_inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            unknown_dir.to_str().unwrap(),
            "--output",
            unknown_inventory.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(unknown_inventory_error.contains("kaifuu.unknown_engine_variant"));
    assert!(unknown_inventory_error.contains("unknown-siglus-named-files"));
    assert!(!unknown_inventory.exists());

    let generic_dir = root.join("unrecognized");
    fs::create_dir_all(&generic_dir).unwrap();
    let generic_profile = root.join("generic-profile.json");
    let generic_profile_error = run_cli_with_registry_result(
        &[
            "profile",
            "init",
            generic_dir.to_str().unwrap(),
            "--output",
            generic_profile.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(generic_profile_error.contains("no registered adapter detected"));

    let generic_inventory = root.join("generic-inventory.json");
    let generic_inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            generic_dir.to_str().unwrap(),
            "--output",
            generic_inventory.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(generic_inventory_error.contains("no registered adapter detected"));

    let _ = fs::remove_dir_all(root);
}

/// P1: variant string without adapter opt-in must stay on the
/// partial / no-adapter path; profile and inventory must never run.
#[test]
fn undetected_variant_without_diagnostic_opt_in_never_invokes_profile_or_inventory() {
    const ADAPTER_ID: &str = "kaifuu.test.variant-only-no-opt-in";

    struct VariantOnlyNoOptInAdapter {
        calls: Rc<RefCell<Vec<&'static str>>>,
    }

    impl VariantOnlyNoOptInAdapter {
        fn record(&self, call: &'static str) {
            self.calls.borrow_mut().push(call);
        }
    }

    impl EngineAdapter for VariantOnlyNoOptInAdapter {
        fn id(&self) -> &'static str {
            ADAPTER_ID
        }

        fn name(&self) -> &'static str {
            "Variant-only adapter without diagnostic opt-in"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                ADAPTER_ID,
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::ProfileGeneration),
                    CapabilityReport::supported(Capability::AssetInventory),
                ],
                AdapterCapabilityMatrix::identify_only(
                    ADAPTER_ID,
                    "test adapter is identify-only decoy",
                ),
            )
        }

        fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            self.record("detect");
            Ok(DetectionResult {
                adapter_id: ADAPTER_ID.to_string(),
                detected: false,
                engine_family: Some("decoy".to_string()),
                engine_version: None,
                detected_variant: Some("looks-like-mine".to_string()),
                evidence: vec![DetectionEvidence {
                    path: request.game_dir.display().to_string(),
                    kind: "variant_only_marker".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "undetected adapter with a descriptive variant".to_string(),
                }],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        // Default is_diagnostic_candidate → false.

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            self.record("profile");
            panic!("profile must not run without diagnostic opt-in");
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            self.record("list_assets");
            unreachable!("list_assets must not run")
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            self.record("asset_inventory");
            panic!("asset_inventory must not run without diagnostic opt-in");
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            self.record("extract");
            unreachable!("extract must not run")
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            self.record("patch");
            unreachable!("patch must not run")
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            self.record("verify");
            unreachable!("verify must not run")
        }
    }

    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut registry = AdapterRegistry::new();
    registry.register(VariantOnlyNoOptInAdapter {
        calls: Rc::clone(&calls),
    });

    let root = temp_dir("variant-only-no-opt-in");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();

    // Registry selection refuses the decoy.
    let detections = registry.detect_all(&game_dir).unwrap();
    assert!(
        registry
            .diagnostic_candidate_from_results(&detections)
            .is_none()
    );

    // Profile: matched evidence without opt-in takes the partial path —
    // never Diagnostic, never adapter.profile.
    let profile_out = root.join("profile.json");
    run_cli_with_registry(
        &[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_out.to_str().unwrap(),
        ],
        &registry,
    );
    let profile_report: serde_json::Value = read_json(&profile_out).unwrap();
    assert_eq!(
        profile_report["partial"].as_bool(),
        Some(true),
        "must stay on partial path, not diagnostic profile route: {profile_report}"
    );
    assert_eq!(
        profile_report["detected"].as_bool(),
        Some(false),
        "partial report must not claim full detection: {profile_report}"
    );
    assert_eq!(
        profile_report["command"].as_str(),
        Some("profile"),
        "partial envelope command must be profile: {profile_report}"
    );
    // Full GameProfile carries schemaVersion 0.1.0 + engine.adapterId;
    // partial reports never carry an engine block.
    assert!(
        profile_report.get("engine").is_none(),
        "must not emit a full profile for the decoy adapter: {profile_report}"
    );

    // Inventory: partial gate falls through to registered_adapter_for_game,
    // which requires detected=true → hard error; inventory must not run.
    let inventory_out = root.join("inventory.json");
    let inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            inventory_out.to_str().unwrap(),
        ],
        &registry,
    )
    .unwrap_err()
    .to_string();
    assert!(
        inventory_error.contains("no registered adapter detected"),
        "unexpected inventory error: {inventory_error}"
    );
    assert!(!inventory_out.exists());

    let recorded = calls.borrow().clone();
    assert!(
        recorded
            .iter()
            .all(|call| *call == "detect" || *call == "capabilities"),
        "profile/inventory must never be invoked; calls={recorded:?}"
    );
    assert!(
        !recorded
            .iter()
            .any(|call| *call == "profile" || *call == "asset_inventory"),
        "profile/inventory must never be invoked; calls={recorded:?}"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_source_without_units_has_no_engine_version() {
    let root = temp_dir("source-without-units-detect");
    let game_dir = root.join("unknown-fixture-like-game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "not-fixture-yet",
  "title": "Not Fixture Yet",
  "sourceLocale": "ja-JP"
}
"#,
    )
    .unwrap();
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    let detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert!(!detection.detected);
    assert_eq!(detection.engine_family, None);
    assert_eq!(detection.engine_version, None);
    assert_eq!(detection.detected_variant, None);
    assert!(detection.evidence.iter().any(|evidence| {
        evidence.path == "source.json"
            && evidence.status == EvidenceStatus::Missing
            && evidence.detail.contains("missing units")
    }));
    let serialized: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&detect_path).unwrap()).unwrap();
    let detection_json = serialized["detections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|detection| detection["adapterId"] == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap()
        .as_object()
        .unwrap();
    assert!(!detection_json.contains_key("engineFamily"));
    assert!(!detection_json.contains_key("engineVersion"));
    assert!(!detection_json.contains_key("detectedVariant"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_init_is_stable_across_repeated_cli_runs() {
    let root = temp_dir("profile-init-stability");
    let game_dir = temp_game(&root);
    let first_path = root.join("profile-first.json");
    let second_path = root.join("profile-second.json");

    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        first_path.to_str().unwrap(),
    ]);
    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        second_path.to_str().unwrap(),
    ]);

    assert_eq!(
        fs::read_to_string(&first_path).unwrap(),
        fs::read_to_string(&second_path).unwrap()
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_reports_missing_required_fields() {
    let root = temp_dir("profile-validation-failure");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
        &profile_path,
        r#"{
  "schemaVersion": "0.1.0",
  "profileId": "",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": ""
  },
  "assets": [],
  "capabilities": [],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive_key",
      "status": "missing",
      "description": "archive key must be provided out of band",
      "placeholder": "KAIFUU_ARCHIVE_KEY",
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
    )
    .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(validation.failures.iter().any(|failure| {
        failure.code == "missing_required_field" && failure.field == "profileId"
    }));
    assert!(validation.failures.iter().any(|failure| {
        failure.code == "missing_requirement" && failure.field == "requirements.archive_key"
    }));
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(serialized.contains("KAIFUU_ARCHIVE_KEY"));
    assert!(!serialized.contains("actual-secret"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_redacts_secret_bearing_key_profile_fields() {
    let root = temp_dir("profile-validation-redaction");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
        &profile_path,
        r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00014",
  "gameId": "siglus-owned-local",
  "title": "Siglus Owned Local",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.siglus",
    "engineFamily": "siglus",
    "engineVersion": null,
    "detectedVariant": "scene-pck-secondary-key"
  },
  "sourceFingerprint": {
    "gameRootHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "engineEvidence": ["Scene.pck", "Gameexe.dat"]
  },
  "keyRequirements": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:siglus/example/secondary-key",
      "kind": "fixedBytes",
      "bytes": 16,
      "rawKey": "00112233445566778899aabbccddeeff",
      "validation": {
        "method": "decryptHeaderProof",
        "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    }
  ],
  "archiveParameters": [
    {
      "parameterId": "scene-cipher-key",
      "name": "cipherKey",
      "kind": "cipherScheme",
      "value": "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b",
      "source": "manual"
    }
  ],
  "helperEvidence": {
    "helperKind": "staticParser",
    "toolVersion": "kaifuu-key-helper/0.1.0",
    "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "helperDump": "register dump with local key bytes"
  },
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0000014",
      "path": "Scene.pck",
      "assetKind": "archive",
      "textSurfaces": ["dialogue"],
      "sourceHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "patching": {
        "capability": "patching",
        "status": "limited",
        "limitation": "requires caller-provided resolved keys and archive parameters"
      }
    }
  ],
  "capabilities": [
    {
      "capability": "key_profile",
      "status": "supported",
      "limitation": null
    },
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires caller-provided resolved keys and archive parameters"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "siglus-secondary-key",
      "status": "satisfied",
      "description": "secondary key is referenced through local secret storage",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {
    "localPath": "/home/dev/private-game",
    "decryptedText": "private script line"
  }
}
"#,
    )
    .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "keyRequirements.0.rawKey",
        "archiveParameters.0.value",
        "helperEvidence.helperDump",
        "metadata.localPath",
        "metadata.decryptedText",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing secret redaction failure for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
    assert!(!serialized.contains("/home/dev/private-game"));
    assert!(!serialized.contains("private script line"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_redacts_requirement_free_text_fields() {
    let root = temp_dir("profile-validation-requirement-redaction");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00015",
  "gameId": "sensitive-requirements",
  "title": "Sensitive Requirements",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": "plain-json-source"
  },
  "assets": [],
  "capabilities": [
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires profile validation"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive-key",
      "status": "missing",
      "description": "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
      "placeholder": "file=C:\\Games\\SecretRoute\\key.bin",
      "secret": true
    },
    {
      "category": "file",
      "key": "story-script",
      "status": "unsupported",
      "description": "decrypted text from private-route-ending.ks must remain local",
      "placeholder": null,
      "secret": false
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "requirements.0.description",
        "requirements.0.placeholder",
        "requirements.1.description",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing requirement redaction failure for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    for forbidden in [
        "/home/dev/game",
        "C:\\Games",
        "helper dump",
        "decrypted text",
        "00112233445566778899aabbccddeeff",
        "private-route-ending.ks",
        "SecretRoute",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "validation leaked {forbidden}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_reports_malformed_profile_fields() {
    let root = temp_dir("profile-validation-malformed");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
        &profile_path,
        r#"{
  "schemaVersion": "9.9.9",
  "profileId": "bad profile id",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja_JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": "",
    "detectedVariant": "plain-json-source"
  },
  "assets": [
    {
      "assetId": "bad asset",
      "path": "../source.json",
      "assetKind": "scriptish",
      "textSurfaces": ["dialogue", "dialogue", "bad_surface"],
      "sourceHash": "",
      "patching": {
        "capability": "line_parity_patching",
        "status": "limited",
        "limitation": ""
      }
    }
  ],
  "capabilities": [
    {
      "capability": "detection",
      "status": "supported",
      "limitation": "unexpected"
    },
    {
      "capability": "detection",
      "status": "supported",
      "limitation": null
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive key",
      "status": "blocked",
      "description": "",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
    )
    .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    for expected_code in [
        "unsupported_schema_version",
        "invalid_locale",
        "invalid_engine_version",
        "invalid_asset_id",
        "invalid_asset_path",
        "invalid_enum_value",
        "duplicate_text_surface",
        "invalid_text_surface",
        "invalid_source_hash",
        "missing_capability_limitation",
        "unexpected_capability_limitation",
        "duplicate_capability",
        "invalid_requirement_key",
        "inconsistent_capability",
    ] {
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == expected_code),
            "missing validation failure code {expected_code}: {:#?}",
            validation.failures
        );
    }
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(!serialized.contains("confidence"));
    assert!(!serialized.contains("actual-secret"));

    let _ = fs::remove_dir_all(root);
}

// `kaifuu xp3 profile-proof` CLI tests

fn kirikiri_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
        .join(relative_path)
}

#[test]
fn xp3_profile_proof_command_plain_fixture_passes() {
    let root = temp_dir("xp3-profile-proof-plain");
    let output = root.join("plain-proof.json");
    run_cli(&[
        "xp3",
        "profile-proof",
        "--fixture",
        kirikiri_fixture_path("xp3-profile.json").to_str().unwrap(),
        "--output",
        output.to_str().unwrap(),
    ]);
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["classification"], "plain");
    assert_eq!(report["patchCapabilityLevel"], "patch_back");
    assert_eq!(report["helperRequirement"], "not_required");
    assert_eq!(report["patchWriteAttempted"], false);
    assert_eq!(report["archive"]["archiveId"], "kirikiri-xp3-archive");
    assert_eq!(
        report["fixtureId"],
        "kaifuu-kirikiri-xp3-plain-profile-proof"
    );
    assert_eq!(report["profileId"], "019ed000-0000-7000-8000-000000095001");
    assert_eq!(report["cryptProfile"]["status"], "not_required");
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/"));
    assert!(!serialized.contains("C:\\"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_plain_smoke_command_passes_and_writes_report() {
    // inventory + deterministic rebuild through the shared
    // reader/writer path; negatives fail before writes citing member ids.
    let root = temp_dir("xp3-plain-smoke");
    let output = root.join("plain-xp3-smoke.json");
    run_cli(&[
        "xp3",
        "plain-smoke",
        "--fixture",
        kirikiri_fixture_path("plain-xp3.json").to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ]);
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["archive"]["memberCount"], 3);
    assert_eq!(report["archive"]["compressedMemberCount"], 1);
    assert_eq!(report["rebuild"]["equivalence"], "byte_identical");
    assert_eq!(report["rebuild"]["byteIdentical"], true);
    assert_eq!(
        report["rebuild"]["outputHash"],
        report["rebuild"]["sourceHash"]
    );
    let negatives = report["negatives"].as_array().unwrap();
    assert_eq!(negatives.len(), 2);
    for negative in negatives {
        assert_eq!(negative["status"], "passed");
        assert_eq!(negative["failedBeforeWrite"], true);
    }
    let flagged = negatives
        .iter()
        .find(|negative| negative["failureKind"] == "unsupported_member_flags")
        .unwrap();
    assert_eq!(flagged["memberId"], "scenario/flagged.ks");
    // No local path leaks into the redacted report.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/"));
    assert!(!serialized.contains("/scratch/"));
    assert!(!serialized.contains(".xp3"));
    let _ = fs::remove_dir_all(root);
}

fn run_xp3_profile_proof_cli(
    fixture: &Path,
    output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_args(
        [
            "xp3",
            "profile-proof",
            "--fixture",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    )
}

#[test]
fn xp3_profile_proof_command_encrypted_fixture_routes_without_patch_claim() {
    // Acceptance criterion: "Unsupported cases fail before extract or
    // patch claims are made." The CLI exits non-zero on encrypted
    // routing and writes the redacted proof carrying the unsupported
    // capability level.
    let root = temp_dir("xp3-profile-proof-encrypted");
    let output = root.join("encrypted-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("xp3-encrypted-profile.json"),
        &output,
    );
    assert!(result.is_err(), "encrypted routing must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["classification"], "encrypted");
    assert_eq!(report["patchCapabilityLevel"], "unsupported");
    assert_eq!(report["patchWriteAttempted"], false);
    assert_eq!(report["cryptProfile"]["status"], "satisfied");
    let diagnostics = report["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.encrypted.unsupported")
    );
    assert!(
        report["semanticRemediation"]
            .as_str()
            .unwrap_or_default()
            .contains("encrypted")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_helper_required_fixture_routes_without_patch_claim() {
    let root = temp_dir("xp3-profile-proof-helper-required");
    let output = root.join("helper-required-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("xp3-helper-required-profile.json"),
        &output,
    );
    assert!(
        result.is_err(),
        "helper-required routing must exit non-zero"
    );
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["classification"], "helper_required");
    assert_eq!(report["patchCapabilityLevel"], "unsupported");
    assert_eq!(report["helperRequirement"], "required");
    let diagnostics = report["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.helper_required")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_protected_executable_fixture_routes_without_patch_claim() {
    let root = temp_dir("xp3-profile-proof-protected-executable");
    let output = root.join("protected-executable-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("xp3-protected-executable-profile.json"),
        &output,
    );
    assert!(
        result.is_err(),
        "protected-executable routing must exit non-zero"
    );
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["classification"], "unsupported_protected_executable");
    assert_eq!(report["patchCapabilityLevel"], "unsupported");
    let diagnostics = report["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.unsupported_protected_executable")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_missing_crypt_profile_fails_and_writes_report() {
    let root = temp_dir("xp3-profile-proof-missing-crypt-cli");
    let output = root.join("missing-crypt-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("negative/xp3-missing-crypt-profile.json"),
        &output,
    );
    assert!(result.is_err(), "missing-crypt-profile must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["cryptProfile"]["status"], "missing");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.crypt_profile.missing")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_unknown_encryption_plugin_fails_and_writes_report() {
    let root = temp_dir("xp3-profile-proof-unknown-plugin-cli");
    let output = root.join("unknown-plugin-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("negative/xp3-unknown-encryption-plugin.json"),
        &output,
    );
    assert!(result.is_err(), "unknown-plugin must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["cryptProfile"]["status"], "unknown_plugin");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.crypt_profile.unknown_plugin")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_profile_proof_command_leaked_archive_path_fails_and_redacts_path() {
    let root = temp_dir("xp3-profile-proof-leaked-path-cli");
    let output = root.join("leaked-path-proof.json");
    let result = run_xp3_profile_proof_cli(
        &kirikiri_fixture_path("negative/xp3-leaked-archive-path.json"),
        &output,
    );
    assert!(result.is_err(), "leaked archive path must exit non-zero");
    let serialized = fs::read_to_string(&output).unwrap();
    let report: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "xp3.archive_path.leaked")
    );
    // The literal leaked path must not survive into the report.
    assert!(
        !serialized.contains("/home/local-user/private/data.xp3"),
        "leaked path survived into report: {serialized}"
    );
    let _ = fs::remove_dir_all(root);
}

/// multi-game validation — exercise the proof against real
/// KiriKiri XP3 bytes when optional corpus roots are configured.
/// Following the "multi-game validation" memory rule and
/// the spec's `KiriKiri research-only anchor; no vendored decryption
/// code` load-bearing rule: this test reads, classifies, and emits
/// the redacted proof; it never decrypts, never extracts, and never
/// claims patch-back on archives whose index cannot be inventoried by
/// the plain reader.
/// The test no-ops when `ITOTORI_REAL_GAME_ROOT_KIRIKIRI_PLAIN`
/// and `ITOTORI_REAL_GAME_ROOT_KIRIKIRI_ENCRYPTED` are unset; public
/// CI is satisfied by the synthetic fixtures above.
#[test]
fn xp3_profile_proof_command_real_bytes_kirikiri_corpus_when_available() {
    // Two optional real KiriKiri game roots. Both wear the XP3 plain
    // magic, but the plain inventory reader only handles
    // flag=0 (plain index encoding) and rejects everything else as
    // UnsupportedEncrypted. In practice these games carry compressed
    // or encrypted directories, so the proof routes them to the
    // `Encrypted` taxonomy and refuses to claim patch_back. This is
    // the load-bearing protection: real KiriKiri bytes never silently
    // produce a patch_back capability claim.
    let real_cases: &[(&str, &str)] = &[
        (
            "ITOTORI_REAL_GAME_ROOT_KIRIKIRI_PLAIN",
            "kaifuu-real-kirikiri-plain-corpus",
        ),
        (
            "ITOTORI_REAL_GAME_ROOT_KIRIKIRI_ENCRYPTED",
            "kaifuu-real-kirikiri-encrypted-corpus",
        ),
    ];

    let mut exercised = 0u32;
    for (env_var, fixture_id) in real_cases {
        let Some(game_root) = std::env::var_os(env_var) else {
            continue;
        };
        let archive = PathBuf::from(game_root).join("data.xp3");
        assert!(
            archive.is_file(),
            "{env_var} must point to a KiriKiri game root containing data.xp3"
        );
        exercised += 1;

        let root = temp_dir(&format!("xp3-real-bytes-{fixture_id}"));
        // Materialize the fixture next to a symlink pointing at the
        // real archive — the proof's path validator rejects absolute
        // paths so we must hand it a relative archive reference.
        let archive_link = root.join("archive.xp3");
        std::os::unix::fs::symlink(&archive, &archive_link).unwrap();
        let fixture_path = root.join("fixture.json");
        let fixture_body = serde_json::json!({
            "schemaVersion": "0.1.0",
            "fixtureId": fixture_id,
            "profileId": "019ed000-0000-7000-8000-000000095001",
            "archive": {
                "archiveId": "kirikiri-xp3-archive",
                "path": "archive.xp3",
            },
            "expectedClassification": "plain",
            "patchCapabilityLevel": "patch_back",
        });
        fs::write(&fixture_path, fixture_body.to_string()).unwrap();

        let output = root.join("real-bytes-proof.json");
        // We accept Err from the CLI here — the proof exits non-zero
        // when the plain inventory cannot be read and the fixture
        // overclaimed patch_back. We assert from the report contents.
        let _ = run_xp3_profile_proof_cli(&fixture_path, &output);

        let report: serde_json::Value = read_json(&output).unwrap();
        // The proof must never claim patch-back on a real-bytes
        // archive whose index the reader cannot inventory.
        assert_ne!(
            report["patchCapabilityLevel"], "patch_back",
            "configured real-bytes archive must never claim patch_back"
        );
        // Patch-write attempted is always false — the proof never
        // writes patched bytes.
        assert_eq!(report["patchWriteAttempted"], false);
        // The archive hash is computed regardless of classification.
        let archive_hash = report["archive"]["archiveHash"].as_str().unwrap();
        assert!(archive_hash.starts_with("sha256:"));

        // The absolute path must not be echoed in the report.
        let serialized = fs::read_to_string(&output).unwrap();
        if let Some(archive_path) = archive.to_str() {
            assert!(
                !serialized.contains(archive_path),
                "configured real-bytes archive path leaked into report"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    // Public CI without the optional corpus is fine — the synthetic
    // tests cover correctness; this test only adds *additional* signal
    // when real bytes are available. Logging via println! makes the
    // exercised count visible in `cargo test -- --nocapture`.
    println!("KAIFUU-038 real-bytes corpus exercised {exercised} game(s)");
}

// Plain XP3 deterministic writer CLI tests

fn write_real_plain_xp3_fixture(dir: &Path) -> PathBuf {
    let source = kirikiri_fixture_path("plain.xp3");
    let staged = dir.join("plain.xp3");
    fs::copy(&source, &staged).unwrap();
    staged
}

#[test]
fn xp3_unpack_pack_round_trips_real_plain_fixture_byte_identical_via_cli() {
    // Acceptance criterion (writer): unpack -> pack reproduces the
    // source bytes for an unchanged plain fixture. Round-trips via
    // the `kaifuu xp3 unpack` and `kaifuu xp3 pack` subcommands so
    // the CLI surface is exercised end-to-end.
    let root = temp_dir("xp3-unpack-pack-real-cli");
    let staged = write_real_plain_xp3_fixture(&root);
    let unpack_dir = root.join("unpacked");
    let rebuilt = root.join("rebuilt.xp3");

    run_cli(&[
        "xp3",
        "unpack",
        "--archive",
        staged.to_str().unwrap(),
        "--output-dir",
        unpack_dir.to_str().unwrap(),
    ]);
    assert!(unpack_dir.join("manifest.json").exists());

    run_cli(&[
        "xp3",
        "pack",
        "--input-dir",
        unpack_dir.to_str().unwrap(),
        "--output",
        rebuilt.to_str().unwrap(),
    ]);
    let original = fs::read(&staged).unwrap();
    let rebuilt_bytes = fs::read(&rebuilt).unwrap();
    assert_eq!(
        rebuilt_bytes, original,
        "CLI unpack -> pack must round-trip byte-identical"
    );

    // The verify subcommand confirms the same property without us
    // having to re-read the bytes ourselves.
    run_cli(&[
        "xp3",
        "verify",
        "--source",
        staged.to_str().unwrap(),
        "--input-dir",
        unpack_dir.to_str().unwrap(),
    ]);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_replace_command_updates_table_and_round_trip_passes_through_inventory() {
    // Acceptance criterion: "Replacing an allowed plain fixture file
    // updates table metadata and verification output."
    let root = temp_dir("xp3-replace-cli");
    let staged = write_real_plain_xp3_fixture(&root);
    let unpack_dir = root.join("unpacked");
    let rebuilt = root.join("rebuilt.xp3");
    let new_payload_path = root.join("new-intro.bin");
    let new_payload = b"intro replaced by KAIFUU-098 writer CLI\n";
    fs::write(&new_payload_path, new_payload).unwrap();

    run_cli(&[
        "xp3",
        "unpack",
        "--archive",
        staged.to_str().unwrap(),
        "--output-dir",
        unpack_dir.to_str().unwrap(),
    ]);
    run_cli(&[
        "xp3",
        "replace",
        "--input-dir",
        unpack_dir.to_str().unwrap(),
        "--entry-path",
        "scenario/intro.ks",
        "--payload",
        new_payload_path.to_str().unwrap(),
    ]);
    run_cli(&[
        "xp3",
        "pack",
        "--input-dir",
        unpack_dir.to_str().unwrap(),
        "--output",
        rebuilt.to_str().unwrap(),
    ]);

    let inventory = kaifuu_core::read_plain_xp3_inventory(&fs::read(&rebuilt).unwrap()).unwrap();
    let intro = inventory
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(intro.archive_size, new_payload.len() as u64);
    assert_eq!(intro.original_size, new_payload.len() as u64);
    assert_eq!(
        intro.payload_hash.as_deref(),
        Some(sha256_hash_bytes(new_payload).as_str())
    );
    let expected_adler = kaifuu_core::compute_adler32(new_payload);
    assert_eq!(
        intro.stored_adler32.as_deref(),
        Some(format!("adler32:{expected_adler:08x}").as_str())
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_unpack_refuses_encrypted_fixture_with_semantic_diagnostic() {
    // Acceptance criterion: "Encrypted... profiles fail before
    // writes with semantic diagnostics."
    let root = temp_dir("xp3-unpack-encrypted-refusal");
    let encrypted = kirikiri_fixture_path("encrypted.xp3");
    let target = root.join("would-not-create");
    let result = run_with_args(
        [
            "xp3",
            "unpack",
            "--archive",
            encrypted.to_str().unwrap(),
            "--output-dir",
            target.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.unsupported_variant.encrypted"),
        "encrypted refusal must surface the semantic code: {error}"
    );
    assert!(
        !target.exists(),
        "encrypted unpack must not create the output directory"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_unpack_refuses_helper_required_fixture_with_semantic_diagnostic() {
    let root = temp_dir("xp3-unpack-helper-required-refusal");
    let helper_required = kirikiri_fixture_path("helper-required.xp3");
    let target = root.join("would-not-create");
    let result = run_with_args(
        [
            "xp3",
            "unpack",
            "--archive",
            helper_required.to_str().unwrap(),
            "--output-dir",
            target.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.helper_required"),
        "helper-required refusal must surface the semantic code: {error}"
    );
    assert!(!target.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_unpack_refuses_protected_executable_fixture_with_semantic_diagnostic() {
    let root = temp_dir("xp3-unpack-protected-executable-refusal");
    let protected = kirikiri_fixture_path("protected-executable.bin");
    let target = root.join("would-not-create");
    let result = run_with_args(
        [
            "xp3",
            "unpack",
            "--archive",
            protected.to_str().unwrap(),
            "--output-dir",
            target.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.protected_executable_unsupported"),
        "protected-executable refusal must surface the semantic code: {error}"
    );
    assert!(!target.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_replace_refuses_compressed_entry_with_semantic_diagnostic() {
    // Acceptance criterion: "Encrypted, compressed-unknown, or
    // helper-required profiles fail before writes with semantic
    // diagnostics." The CLI replace command refuses compressed
    // entries with the matching kaifuu.unsupported_variant.packed
    // semantic code.
    let root = temp_dir("xp3-replace-compressed-refusal");
    let staged = write_real_plain_xp3_fixture(&root);
    let unpack_dir = root.join("unpacked");
    let new_payload_path = root.join("would-require-recompression.bin");
    fs::write(&new_payload_path, b"replacement requires recompression").unwrap();

    run_cli(&[
        "xp3",
        "unpack",
        "--archive",
        staged.to_str().unwrap(),
        "--output-dir",
        unpack_dir.to_str().unwrap(),
    ]);
    let result = run_with_args(
        [
            "xp3",
            "replace",
            "--input-dir",
            unpack_dir.to_str().unwrap(),
            "--entry-path",
            "scenario/compressed.ks",
            "--payload",
            new_payload_path.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("kaifuu.unsupported_variant.packed"),
        "compressed-replacement refusal must surface the packed semantic code: {error}"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn xp3_writer_capability_command_emits_archive_rebuild_plain_tuple() {
    // Acceptance criterion: "Writer capability tuple records
    // patch_back_mode=archive_rebuild_plain". CLI exposes the tuple
    // so orchestrator code can pattern-match without statically
    // linking kaifuu-core.
    let root = temp_dir("xp3-writer-capability");
    let output = root.join("capability.json");
    run_cli(&[
        "xp3",
        "writer-capability",
        "--output",
        output.to_str().unwrap(),
    ]);
    let value: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(value["patchBackMode"], "archive_rebuild_plain");
    assert_eq!(value["variant"], "plain");
    assert_eq!(value["adapterId"], kaifuu_core::PLAIN_XP3_WRITER_ADAPTER_ID);
    let _ = fs::remove_dir_all(root);
}

fn rpgmaker_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/rpgmaker")
        .join(relative_path)
}

fn run_encrypted_media_proof_cli(
    fixture: &Path,
    output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_args(
        [
            "rpg-maker",
            "encrypted-media-proof",
            "--fixture",
            fixture.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    )
}

#[test]
fn encrypted_media_proof_command_happy_path_routes_without_overclaim() {
    let root = temp_dir("encrypted-media-happy");
    let output = root.join("encrypted-media-proof.json");
    run_encrypted_media_proof_cli(&rpgmaker_fixture_path("encrypted-media.json"), &output).unwrap();
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["readiness"], "ready");
    // Load-bearing: media-key detection never implies script
    // capability; decrypted bytes are never persisted; the
    // aggregate patch capability never claims patch_back or extract.
    assert_eq!(report["scriptCapabilityClaimed"], false);
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert_ne!(report["patchCapabilityLevel"], "patch_back");
    assert_ne!(report["patchCapabilityLevel"], "extract");
    // Per-asset distinct kinds.
    let assets = report["assets"].as_array().unwrap();
    let kinds: Vec<&str> = assets
        .iter()
        .map(|asset| asset["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"image"));
    assert!(kinds.contains(&"audio"));
    assert!(kinds.contains(&"video"));
    // Every encrypted asset claims `unsupported` patch capability.
    for asset in assets {
        if asset["classification"] == "encrypted" {
            assert_eq!(asset["patchCapabilityLevel"], "unsupported");
            assert_ne!(asset["patchCapabilityLevel"], "patch_back");
            assert_ne!(asset["patchCapabilityLevel"], "extract");
            assert_eq!(asset["decryptability"], "key_profile_satisfied");
        }
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_qd_contract_writes_stdout_without_output_flag() {
    run_with_args(
        [
            "rpgmaker",
            "encrypted-media-proof",
            "--fixture",
            rpgmaker_fixture_path("encrypted-media.json")
                .to_str()
                .unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    )
    .unwrap();
}

#[test]
fn encrypted_media_proof_command_missing_key_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-missing-key");
    let output = root.join("missing-key-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("encrypted-media-missing-key.json"),
        &output,
    );
    assert!(result.is_err(), "missing-key fixture must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["readiness"], "unsupported");
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"]
                == "rpgmaker.encrypted_media.system_json.key_missing")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_wrong_key_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-wrong-key");
    let output = root.join("wrong-key-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("encrypted-media-wrong-key.json"),
        &output,
    );
    assert!(result.is_err(), "wrong-key fixture must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["readiness"], "unsupported");
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"]
                == "rpgmaker.encrypted_media.system_json.key_mismatch"
                && diagnostic["semanticCode"] == "kaifuu.key_validation_failed")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_leaked_game_dir_rejected_before_any_decryption_claim() {
    let root = temp_dir("encrypted-media-leaked-game-dir");
    let output = root.join("leaked-game-dir-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("negative/encrypted-media-leaked-game-dir.json"),
        &output,
    );
    assert!(result.is_err(), "leaked game dir must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["readiness"], "unsupported");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "rpgmaker.encrypted_media.game_dir.leaked")
    );
    // The leaked absolute path must not survive into the report.
    let serialized = fs::read_to_string(&output).unwrap();
    assert!(!serialized.contains("/home/local-user"));
    assert!(!serialized.contains("C:\\"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_malformed_header_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-malformed-header");
    let output = root.join("malformed-header-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("negative/encrypted-media-malformed-header.json"),
        &output,
    );
    assert!(
        result.is_err(),
        "malformed-header fixture must exit non-zero"
    );
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "rpgmaker.encrypted_media.header.malformed")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn encrypted_media_proof_command_unknown_key_profile_routes_to_unsupported() {
    let root = temp_dir("encrypted-media-unknown-profile");
    let output = root.join("unknown-profile-report.json");
    let result = run_encrypted_media_proof_cli(
        &rpgmaker_fixture_path("negative/encrypted-media-unknown-key-profile.json"),
        &output,
    );
    assert!(result.is_err(), "unknown-key-profile must exit non-zero");
    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "rpgmaker.encrypted_media.key_profile.unknown")
    );
    let _ = fs::remove_dir_all(root);
}

/// multi-game validation — exercise the proof against
/// real RPG Maker MV/MZ media bytes when an optional corpus root is
/// configured. Following the "multi-game validation"
/// memory rule and the spec's research-only anchor (commercial
/// product; no vendored decryption code, no key extraction): the
/// test reads, classifies, and emits the redacted readiness report;
/// it never decrypts, never extracts, and never claims patch_back
/// or script capability on real bytes.
/// The test no-ops when `ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ`
/// is unset; the synthetic fixtures above are the load-bearing
/// correctness coverage.
#[test]
fn encrypted_media_proof_command_real_bytes_rpgmaker_corpus_when_available() {
    let Some(real_root) = std::env::var_os("ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ") else {
        println!("KAIFUU-039 ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ unset; skipping");
        return;
    };
    let real_root = PathBuf::from(real_root);
    if !real_root.is_dir() {
        eprintln!("SKIP: RPG Maker MV/MZ corpus is not staged");
        return;
    }
    let title_asset = real_root.join("img/sv_actors/Actor1_1.rpgmvp");
    let theme_asset = real_root.join("audio/bgm/Battle1.rpgmvo");
    let system_json = real_root.join("data/System.json");
    if !(title_asset.is_file() && theme_asset.is_file() && system_json.is_file()) {
        eprintln!("SKIP: RPG Maker MV/MZ corpus misses required media anchors");
        return;
    }

    let root = temp_dir("encrypted-media-real-bytes");
    // The proof's path validator rejects absolute paths so we
    // materialise a relative game tree by symlinking the real
    // sub-tree under our fixture-root.
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let symlink_targets = &[
        ("data", real_root.join("data")),
        ("img", real_root.join("img")),
        ("audio", real_root.join("audio")),
    ];
    for (name, target) in symlink_targets {
        std::os::unix::fs::symlink(target, game_dir.join(name)).unwrap();
    }

    let fixture_path = root.join("fixture.json");
    let fixture_body = serde_json::json!({
        "schemaVersion": "0.1.0",
        "fixtureId": "kaifuu-real-rpgmaker-mv-mz-corpus",
        "profileId": "019ed000-0000-7000-8000-000000039999",
        "gameDir": "game",
        "assets": [
            {
                "assetId": "real-image-mv",
                "path": "img/sv_actors/Actor1_1.rpgmvp",
                "expectedKind": "image",
                "expectedClassification": "encrypted"
            },
            {
                "assetId": "real-audio-mv",
                "path": "audio/bgm/Battle1.rpgmvo",
                "expectedKind": "audio",
                "expectedClassification": "encrypted"
            }
        ],
        "keyProfile": {
            "profileId": "rpg-maker-mv-mz-asset-key",
            "keyRefRequirement": {
                "requirementId": "rpg-maker-mv-mz-asset-key",
                "secretRef": "local-secret:fixture/rpgmaker/mv-mz-asset-key"
            }
        }
    });
    fs::write(&fixture_path, fixture_body.to_string()).unwrap();

    let output = root.join("real-bytes-proof.json");
    // We accept Err — the proof exits non-zero whenever any blocking
    // diagnostic fires. We assert from the report contents.
    let _ = run_encrypted_media_proof_cli(&fixture_path, &output);

    let report: serde_json::Value = read_json(&output).unwrap();

    // Load-bearing checks across real bytes:
    // - decryptedBytesPersisted is always false (no decryption).
    // - scriptCapabilityClaimed is always false (no script claim).
    // - patchCapabilityLevel never claims patch_back / extract.
    assert_eq!(report["decryptedBytesPersisted"], false);
    assert_eq!(report["scriptCapabilityClaimed"], false);
    assert_ne!(report["patchCapabilityLevel"], "patch_back");
    assert_ne!(report["patchCapabilityLevel"], "extract");

    // Every real-bytes encrypted asset must be classified as
    // `encrypted` and route to `unsupported` patch capability.
    let assets = report["assets"].as_array().unwrap();
    let encrypted_assets: Vec<_> = assets
        .iter()
        .filter(|asset| asset["classification"] == "encrypted")
        .collect();
    assert!(
        !encrypted_assets.is_empty(),
        "expected at least one encrypted real-bytes asset"
    );
    for asset in &encrypted_assets {
        assert_eq!(asset["patchCapabilityLevel"], "unsupported");
        assert_ne!(asset["patchCapabilityLevel"], "patch_back");
        assert_ne!(asset["patchCapabilityLevel"], "extract");
    }

    // Absolute real-bytes path must not leak into the report.
    let serialized = fs::read_to_string(&output).unwrap();
    if let Some(real_root_text) = real_root.to_str() {
        assert!(
            !serialized.contains(real_root_text),
            "configured real-bytes root leaked into report",
        );
    }

    // The encryption key from real-bytes System.json must not leak
    // into the report (we only emit the proof hash). Some real
    // corpora use permissive placeholder keys, but any
    // 32-hex token would be unsafe to surface.
    if let Ok(system_json_text) = fs::read_to_string(&system_json)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&system_json_text)
        && let Some(real_key) = value.get("encryptionKey").and_then(|v| v.as_str())
    {
        assert!(
            !serialized.contains(real_key),
            "raw real-bytes System.json key leaked into report",
        );
    }

    println!("KAIFUU-039 real-bytes corpus exercised configured RPG Maker MV/MZ root");
    let _ = fs::remove_dir_all(root);
}

/// KAIFUU bridge regression: a `Gameexe.ini` that exists but cannot be
/// read (e.g. `chmod 000`) must surface the structured
/// `kaifuu.reallive.gameexe_unreadable` diagnostic rather than silently
/// degrading to an empty inventory, and a genuinely-absent file must be
/// distinguished as `kaifuu.reallive.gameexe_absent`. Both replace the
/// pre-fix `unwrap_or_default` silent fallback that produced a
/// structurally-valid-but-wrong bundle.
#[cfg(unix)]
#[test]
fn gameexe_read_surfaces_structured_diagnostic_instead_of_silent_default() {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_dir("gameexe-read-diagnostic");
    let gameexe_path = root.join("Gameexe.ini");

    // Readable Gameexe.ini round-trips its bytes (no diagnostic).
    fs::write(&gameexe_path, b"#SCENE001 = synthetic\n").unwrap();
    let ok = read_gameexe_inventory_bytes(&gameexe_path).unwrap();
    assert_eq!(ok, b"#SCENE001 = synthetic\n");

    // Unreadable Gameexe.ini (permission-denied) is a real failure.
    let mut permissions = fs::metadata(&gameexe_path).unwrap().permissions();
    permissions.set_mode(0o000);
    fs::set_permissions(&gameexe_path, permissions).unwrap();
    let unreadable = read_gameexe_inventory_bytes(&gameexe_path).unwrap_err();
    let unreadable = unreadable.to_string();
    assert!(
        unreadable.contains("kaifuu.reallive.gameexe_unreadable"),
        "expected unreadable diagnostic, got: {unreadable}"
    );
    assert!(
        !unreadable.contains("kaifuu.reallive.gameexe_absent"),
        "unreadable must not be conflated with absent: {unreadable}"
    );
    // Restore permissions so the temp tree can be cleaned up.
    let mut permissions = fs::metadata(&gameexe_path).unwrap().permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(&gameexe_path, permissions).unwrap();

    // A genuinely-absent Gameexe.ini is distinguished from unreadable.
    let absent = read_gameexe_inventory_bytes(&root.join("missing-Gameexe.ini")).unwrap_err();
    let absent = absent.to_string();
    assert!(
        absent.contains("kaifuu.reallive.gameexe_absent"),
        "expected absent diagnostic, got: {absent}"
    );

    let _ = fs::remove_dir_all(root);
}
