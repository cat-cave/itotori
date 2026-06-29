//! ALPHA-006b — real-bytes integration test for the `render-validate`
//! screenshot surface.
//!
//! Env-gated on `ITOTORI_REAL_GAME_ROOT`. Synthesises a localized
//! (English) patched Sweetie HD `Seen.txt` by replacing scene 1's
//! Textout bodies with an en-US sentinel via the kaifuu patchback, then
//! drives the built `utsushi-cli render-validate` binary against it and
//! asserts:
//!
//! - a real, hashable PNG is written to disk under the artifact root,
//! - it is announced through the substrate frame sink at `E2` as a
//!   `screenshot`,
//! - the rendered (localized) text layer carries the English sentinel,
//! - the PNG bytes hash to the announced `artifact_id`, and
//! - rendering the ORIGINAL (Japanese) scene 1 yields a *different*
//!   screenshot and a *different* rendered-text hash — proving the
//!   screenshot reflects the localized layer, not the source.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, SceneHeader, TranslatedBundleV02, apply_translated_bundle,
    decompress_avg32, gameexe::parse_gameexe_inventory, parse_archive, produce_bundle,
};
use serde_json::Value;

/// en-US sentinel. The leading `「` (SJIS) is required so the KAIFUU
/// parser recognises the run as a Textout opcode; the ASCII interior is
/// what the render-validate text layer renders and the test asserts on.
const EN_US_SENTINEL: &str = "「STELLA-ALPHA-EN-US-SENTINEL」";
const EN_US_SENTINEL_SUBSTR: &str = "STELLA-ALPHA-EN-US-SENTINEL";

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_utsushi-cli"))
}

/// Build a patched `Seen.txt` whose scene 1 carries the en-US sentinel
/// in every Textout body. Mirrors the UTSUSHI-227 real-bytes helper.
fn patch_with_sentinel(seen_bytes: &[u8]) -> Vec<u8> {
    let index = parse_archive(seen_bytes).expect("real Seen.txt envelope must parse");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1 must exist in the directory");
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];

    let header = SceneHeader::parse(scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");

    let gameexe_bytes = real_corpus::gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);

    let opts = BridgeOpts {
        game_id: "reallive",
        game_version: "1.0.0",
        source_profile_id: "kaifuu-reallive-real-bytes",
        source_locale: "ja-JP",
        scene_blob_file_offset: entry.byte_offset,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: header.kidoku_count,
    };
    let produced = produce_bundle(1, scene_blob, &decompressed, &gameexe_inventory, &opts)
        .expect("v0.2 bundle must build from real Sweetie HD scene 1");

    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units must be a JSON array");
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_US_SENTINEL,
            });
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");
    apply_translated_bundle(seen_bytes, &translated, &PatchbackOpts::shift_jis())
        .expect("apply_translated_bundle must succeed on Sweetie HD scene 1")
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn render_validate_screenshot() {
    let Some(seen_path) = real_corpus::seen_txt_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT unset; skipping ALPHA-006b render-validate screenshot \
             real-bytes test (no silent pass: re-run with \
             ITOTORI_REAL_GAME_ROOT=/path/to/reallive-game-root)"
        );
        return;
    };

    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    let tmp_dir =
        std::env::temp_dir().join(format!("utsushi-cli-alpha-006b-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("mkdir tmp");

    // Localized (English) patched Seen.txt.
    let patched_path = tmp_dir.join("Seen.txt");
    fs::write(&patched_path, patch_with_sentinel(&seen_bytes)).expect("write patched Seen.txt");

    // artifacts/scratch lives under the tmp root.
    let artifact_root = tmp_dir.join("artifacts").join("scratch");
    let report_path = tmp_dir.join("render-report.json");

    // ---- Drive render-validate against the localized copy. ----
    let output = Command::new(binary())
        .args([
            "render-validate",
            "--engine",
            "reallive",
            "--seen",
            &patched_path.display().to_string(),
            "--scene",
            "1",
            "--artifact-root",
            &artifact_root.display().to_string(),
            "--run-id",
            "alpha-006b",
            "--expect-text-contains",
            EN_US_SENTINEL_SUBSTR,
            "--output",
            &report_path.display().to_string(),
        ])
        .output()
        .expect("spawn render-validate");
    assert!(
        output.status.success(),
        "render-validate must succeed on the localized scene 1; stderr=\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value =
        serde_json::from_str(&fs::read_to_string(&report_path).expect("read report")).unwrap();
    eprintln!(
        "[ALPHA-006b] localized render: evidenceTier={} artifactKind={} containsExpected={} \
         renderedLineCount={} textlineCount={}",
        report["evidenceTier"],
        report["artifactKind"],
        report["containsExpected"],
        report["renderedLineCount"],
        report["textlineCount"],
    );

    // ---- E2 frame-sink emission proof. ----
    assert_eq!(report["evidenceTier"], "E2", "must emit at E2 or higher");
    assert_eq!(report["artifactKind"], "screenshot");
    assert_eq!(
        report["framesAnnounced"], 1,
        "one frame announced via the substrate sink"
    );
    assert_eq!(report["width"], 1280);
    assert_eq!(report["height"], 720);

    // ---- Localized-English text proof. ----
    assert_eq!(
        report["containsExpected"], true,
        "the rendered localized text layer must contain the en-US sentinel"
    );

    // ---- Real, hashable PNG on disk. ----
    let artifact_id = report["artifactId"]
        .as_str()
        .expect("artifactId")
        .to_string();
    let artifact_path = PathBuf::from(report["artifactPath"].as_str().expect("artifactPath"));
    assert!(
        artifact_path.starts_with(&artifact_root),
        "screenshot must be written under the artifact root"
    );
    let png = fs::read(&artifact_path).expect("png on disk");
    assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert_eq!(
        utsushi_reallive::sha256_hex(&png),
        artifact_id,
        "PNG bytes must hash to the announced artifact_id"
    );

    // ---- Negative control: original (Japanese) scene 1 renders a
    //      DIFFERENT screenshot and a DIFFERENT rendered-text hash. ----
    let original_report_path = tmp_dir.join("render-report-original.json");
    let original_root = tmp_dir.join("artifacts").join("scratch-original");
    let original_output = Command::new(binary())
        .args([
            "render-validate",
            "--engine",
            "reallive",
            "--seen",
            &seen_path.display().to_string(),
            "--scene",
            "1",
            "--artifact-root",
            &original_root.display().to_string(),
            "--run-id",
            "alpha-006b-original",
            "--output",
            &original_report_path.display().to_string(),
        ])
        .output()
        .expect("spawn render-validate (original)");
    assert!(
        original_output.status.success(),
        "render-validate must succeed on the original scene 1; stderr=\n{}",
        String::from_utf8_lossy(&original_output.stderr)
    );
    let original_report: Value =
        serde_json::from_str(&fs::read_to_string(&original_report_path).expect("read report"))
            .unwrap();

    assert_ne!(
        original_report["artifactId"], report["artifactId"],
        "the Japanese-source screenshot must differ from the localized screenshot"
    );
    assert_ne!(
        original_report["renderedTextSha256"], report["renderedTextSha256"],
        "the localized rendered text must differ from the source rendered text"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}
