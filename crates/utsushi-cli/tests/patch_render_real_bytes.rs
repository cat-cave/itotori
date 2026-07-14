//! Kaifuu-utsushi-patch-to-render-path — real-bytes end-to-end acceptance for
//! the composed patch / replay / render paths.
//!
//! Proves the whole patch→render chain on REAL Sweetie HD bytes through the
//! single shipped, config-parameterized command (no hard-coded game path or
//! scene — every game input is a CLI flag):
//!
//!   1. Build a translated v0.2 BridgeBundle (the "translated script") from a
//!      real dialogue scene via the kaifuu producer, with a distinctive en-US
//!      target on every translatable unit. Write it to a scratch JSON file.
//!   2. Drive the actual `utsushi-cli patch-render` binary with a config that
//!      points at the real Seen.txt / Gameexe.ini / game dir and scratch
//!      output paths. The command internally (a) patches the translated script
//!      via Kaifuu → a patched Seen.txt, then (b) drives Utsushi
//!      render-validate over the patched bytes → a REDACTED localized-scene
//!      PNG + a JSON evidence report.
//!   3. Assert the end-to-end product: a patched Seen.txt distinct from the
//!      source; a redacted public PNG on disk (real g00 pixels not published);
//!      a private full-fidelity PNG in the gitignored private tree; and a
//!      redaction-clean JSON evidence report whose render half proves the
//!      TRANSLATED text landed in the rendered message (`containsExpected`)
//!      at E2, with redaction ON — and which leaks NO absolute path and NO raw
//!      translated text (committable artifact).
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE (no
//! opt-out; runs only in the periodic ground-truth oracle
//! `just real-bytes-oracle`, where corpora are staged). Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie-hd> cargo test -p utsushi-cli
//! --test patch_render_real_bytes -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::Path;
use std::process::Command;

use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, SceneHeader, TranslatedBundleV02, TranslationScope, Xor2DecScene,
    apply_translated_bundle, compiler_version_uses_xor2, decompress_avg32,
    gameexe::parse_gameexe_inventory, parse_archive, produce_bundle, recover_archive_cipher,
};

const SWEETIE_HD_GAME_ID: &str = "sweetie-hd";
const SWEETIE_HD_SOURCE_PROFILE_ID: &str = "kaifuu-reallive-sweetie-hd";

/// A known dialogue-bearing Sweetie HD scene that decodes 100% clean AND
/// renders through the RealLive message-window pipeline with its own observed
/// g00 graphics stack (so the composed command needs no `--bg-asset`
/// fallback). Config-supplied to the command as `--scene`; NOT hard-coded in
/// shipped src (this is a test fixture).
const DIALOGUE_SCENE_ID: u16 = 1017;

/// The distinctive en-US "translation" the composed command must patch in and
/// then render. Wrapped in full-width SJIS brackets (`「`/`」`) so the patched
/// bytes still parse as a Textout run; the ASCII core avoids every byte the
/// textout partitioner treats as a structural lead (no digits, no
/// `! # $, @`) so the whole phrase surfaces as ONE observed message. Real
/// game text never aliases this exact phrase.
const EN_TRANSLATION: &str = "「[EN] composed patch-render localized line for utsushi cli」";

/// The substring the render step selects + asserts on (the ASCII core).
const EXPECT_CONTAINS: &str = "composed patch-render localized line";

fn bridge_opts(scene_kidoku_count: u32) -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count,
    }
}

/// `(scene_blob, decrypted_plaintext_bytecode, header)` for `scene_id`.
fn scene_bytes(seen_bytes: &[u8], scene_id: u16) -> (Vec<u8>, Vec<u8>, SceneHeader) {
    let index = parse_archive(seen_bytes).expect("envelope parses");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} must exist"));
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = seen_bytes[blob_start..blob_end].to_vec();
    let header = SceneHeader::parse(&scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let mut decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");
    if compiler_version_uses_xor2(header.compiler_version) {
        recover_archive_xor2_cipher(seen_bytes)
            .expect("Sweetie HD archive must yield a validated xor_2 cipher")
            .apply_segment(&mut decompressed);
    }
    (scene_blob, decompressed, header)
}

/// Recover the validated per-game `xor_2` cipher (cross-scene key recovery).
fn recover_archive_xor2_cipher(seen_bytes: &[u8]) -> Option<kaifuu_reallive::Xor2Cipher> {
    let index = parse_archive(seen_bytes).expect("envelope parses");
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let blob_start = entry.byte_offset as usize;
        let blob_end = blob_start + entry.byte_len as usize;
        if blob_end > seen_bytes.len() {
            continue;
        }
        let blob = &seen_bytes[blob_start..blob_end];
        let Ok(header) = SceneHeader::parse(blob) else {
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: decompressed,
        });
    }
    recover_archive_cipher(&scenes).ok()
}

/// Build the TRANSLATED v0.2 bundle JSON (the "translated script"): every
/// translatable unit of `DIALOGUE_SCENE_ID` gets `EN_TRANSLATION` as its
/// en-US `target.text`. Returns the serialized JSON string ready to write to
/// a file the composed command consumes via `--translated-bundle`.
fn build_translated_bundle_json(seen_bytes: &[u8], gameexe_bytes: &[u8]) -> String {
    let (scene_blob, decompressed, header) = scene_bytes(seen_bytes, DIALOGUE_SCENE_ID);
    let gameexe_inventory = parse_gameexe_inventory(gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from the dialogue scene");

    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units must be a JSON array");
        assert!(
            !units.is_empty(),
            "dialogue scene {DIALOGUE_SCENE_ID} must surface at least one translatable unit"
        );
        for unit in units.iter_mut() {
            unit["target"] = serde_json::json!({
                "locale": "en-US",
                "text": EN_TRANSLATION,
            });
        }
    }
    serde_json::to_string_pretty(&translated_value).expect("serialize translated bundle")
}

fn build_patched_seen_from_bundle_json(seen_bytes: &[u8], bundle_json: &str) -> Vec<u8> {
    let translated_value: serde_json::Value =
        serde_json::from_str(bundle_json).expect("translated bundle JSON parses");
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle schema");
    apply_translated_bundle(
        seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("apply_translated_bundle must patch the dialogue scene")
}

/// Count observed replay `text_line` bodies containing `needle`, checking both
/// the UTF-8 convenience body and the byte-stable Shift-JIS hex fallback.
fn observed_replay_matches(replay_log: &serde_json::Value, needle: &str) -> (usize, usize) {
    let events = replay_log["events"].as_array().cloned().unwrap_or_default();
    let mut text_lines = 0usize;
    let mut matching = 0usize;
    for event in &events {
        if event["kind"].as_str() != Some("text_line") {
            continue;
        }
        text_lines += 1;
        let body_utf8 = event["bodyUtf8"].as_str().unwrap_or_default();
        let mut observed = body_utf8.contains(needle);
        if !observed && let Some(hex) = event["bodyShiftJisHex"].as_str() {
            let bytes = decode_hex(hex);
            let (decoded, _, _) = encoding_rs::SHIFT_JIS.decode(&bytes);
            observed = decoded.contains(needle);
        }
        if observed {
            matching += 1;
        }
    }
    (text_lines, matching)
}

fn decode_hex(hex: &str) -> Vec<u8> {
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16).unwrap_or(0);
        let lo = (bytes[i + 1] as char).to_digit(16).unwrap_or(0);
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    out
}

fn cli_bin() -> &'static str {
    env!("CARGO_BIN_EXE_utsushi-cli")
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn patch_replay_then_render_single_real_scene_renders_patched_dialogue() {
    let Some(seen_path) = real_corpus::seen_txt_path() else {
        real_corpus::require_real_bytes(
            "patch_replay_then_render_single_real_scene_renders_patched_dialogue",
        );
        return;
    };
    let gameexe_path = real_corpus::gameexe_ini_path().expect("Gameexe.ini path");
    let game_dir = seen_path
        .parent()
        .expect("Seen.txt has a parent directory")
        .to_path_buf();
    let g00_dir = real_corpus::reallivedata_subdir("g00").expect("g00 directory path");

    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    let gameexe_bytes = fs::read(&gameexe_path).expect("read Gameexe.ini");

    // 1. Patch a real scene via the same translated-bundle + patchback seam
    //    used by the shipped localization pipeline.
    let bundle_json = build_translated_bundle_json(&seen_bytes, &gameexe_bytes);
    let patched_bytes = build_patched_seen_from_bundle_json(&seen_bytes, &bundle_json);
    assert_ne!(
        patched_bytes, seen_bytes,
        "patched Seen.txt must differ from the source before replay/render validation"
    );

    let work_dir = std::env::temp_dir().join(format!(
        "utsushi-cli-patch-replay-render-{}-{}",
        std::process::id(),
        DIALOGUE_SCENE_ID
    ));
    let _ = fs::remove_dir_all(&work_dir);
    fs::create_dir_all(&work_dir).expect("create work dir");
    let patched_seen = work_dir.join("patched").join("Seen.txt");
    fs::create_dir_all(patched_seen.parent().expect("patched Seen parent"))
        .expect("create patched dir");
    fs::write(&patched_seen, &patched_bytes).expect("write patched Seen.txt");

    // 2. Replay the exact patched bytes through the real replay-validate
    //    binary and assert the VM observes the translated dialogue.
    let replay_log_path = work_dir.join("replay-log.json");
    let replay_output = Command::new(cli_bin())
        .args([
            "replay-validate",
            "--engine",
            "reallive",
            "--seen",
            &patched_seen.display().to_string(),
            "--scene",
            &DIALOGUE_SCENE_ID.to_string(),
            "--gameexe",
            &gameexe_path.display().to_string(),
            "--g00-dir",
            &g00_dir.display().to_string(),
            "--print-replay-log",
            &replay_log_path.display().to_string(),
            "--print-textlines",
        ])
        .output()
        .expect("spawn utsushi-cli replay-validate");
    let replay_stdout = String::from_utf8_lossy(&replay_output.stdout);
    let replay_stderr = String::from_utf8_lossy(&replay_output.stderr);
    eprintln!("replay-validate stdout:\n{replay_stdout}");
    if !replay_output.status.success() {
        panic!(
            "replay-validate failed (status {:?}):\n{replay_stderr}",
            replay_output.status.code()
        );
    }
    assert!(
        replay_stdout.contains("utsushi.reallive.replay_observed_textlines_emitted"),
        "replay-validate must report observed textline evidence; got:\n{replay_stdout}"
    );
    let replay_log: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&replay_log_path).expect("read replay-log.json"))
            .expect("replay-log.json parses");
    let (replay_textlines, replay_matches) = observed_replay_matches(&replay_log, EXPECT_CONTAINS);
    assert!(
        replay_matches > 0,
        "replay-validate must observe the patched translated text before render; got \
         {replay_matches}/{replay_textlines} matching text_line(s)"
    );

    // 3. Render those same patched bytes and assert the localized text layer
    //    contains the patched dialogue, with public-frame redaction on.
    let artifact_root = work_dir.join("artifacts");
    let private_root = work_dir.join("private-render");
    let render_evidence_path = work_dir.join("render-evidence.json");
    let render_output = Command::new(cli_bin())
        .args([
            "render-validate",
            "--engine",
            "reallive",
            "--seen",
            &patched_seen.display().to_string(),
            "--scene",
            &DIALOGUE_SCENE_ID.to_string(),
            "--gameexe",
            &gameexe_path.display().to_string(),
            "--game-dir",
            &game_dir.display().to_string(),
            "--artifact-root",
            &artifact_root.display().to_string(),
            "--private-artifact-root",
            &private_root.display().to_string(),
            "--source-seen",
            &seen_path.display().to_string(),
            "--redaction",
            "on",
            "--expect-text-contains",
            EXPECT_CONTAINS,
            "--run-id",
            "patch-replay-render-real-bytes",
            "--output",
            &render_evidence_path.display().to_string(),
        ])
        .output()
        .expect("spawn utsushi-cli render-validate");
    let render_stdout = String::from_utf8_lossy(&render_output.stdout);
    let render_stderr = String::from_utf8_lossy(&render_output.stderr);
    eprintln!("render-validate stdout:\n{render_stdout}");
    if !render_output.status.success() {
        panic!(
            "render-validate failed (status {:?}):\n{render_stderr}",
            render_output.status.code()
        );
    }
    assert!(
        render_stdout.contains("utsushi.reallive.render_validate_screenshot_ok"),
        "render-validate must emit screenshot evidence; got:\n{render_stdout}"
    );

    let render_evidence: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&render_evidence_path).expect("read render-evidence.json"),
    )
    .expect("render-evidence.json parses");
    assert_eq!(render_evidence["engine"], "reallive");
    assert_eq!(render_evidence["sceneId"], DIALOGUE_SCENE_ID);
    assert_eq!(render_evidence["evidenceTier"], "E2");
    assert_eq!(render_evidence["redaction"], "on");
    assert_eq!(
        render_evidence["containsExpected"], true,
        "rendered frame text layer must contain the patched translated line"
    );
    assert_eq!(render_evidence["renderedLineCount"], 1);
    assert!(
        render_evidence["renderedTextSha256"]
            .as_str()
            .is_some_and(|sha| sha.len() == 64),
        "render evidence must commit to the rendered text layer"
    );
    assert!(
        !find_pngs(&artifact_root).is_empty(),
        "render-validate must emit a redacted public PNG under {}",
        artifact_root.display()
    );
    assert!(
        !find_pngs(&private_root).is_empty(),
        "render-validate must emit a private full-fidelity PNG under {}",
        private_root.display()
    );

    eprintln!(
        "patch->replay->render OK: scene {DIALOGUE_SCENE_ID} replay_matches={replay_matches}/\
         {replay_textlines} redaction={} contains_expected={}",
        render_evidence["redaction"], render_evidence["containsExpected"],
    );

    let _ = fs::remove_dir_all(&work_dir);
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn patch_render_composes_patchback_and_render_on_real_bytes() {
    let Some(seen_path) = real_corpus::seen_txt_path() else {
        real_corpus::require_real_bytes("patch_render_composes_patchback_and_render_on_real_bytes");
        return;
    };
    let gameexe_path = real_corpus::gameexe_ini_path().expect("Gameexe.ini path");
    // The g00 asset directory lives under REALLIVEDATA next to Seen.txt; the
    // command discovers `g00/` under `--game-dir` on its own.
    let game_dir = seen_path
        .parent()
        .expect("Seen.txt has a parent directory")
        .to_path_buf();

    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    let gameexe_bytes = fs::read(&gameexe_path).expect("read Gameexe.ini");

    // 1. Build the translated script (v0.2 bundle) and write it to scratch.
    let bundle_json = build_translated_bundle_json(&seen_bytes, &gameexe_bytes);

    let work_dir = std::env::temp_dir().join(format!(
        "utsushi-cli-patch-render-{}-{}",
        std::process::id(),
        DIALOGUE_SCENE_ID
    ));
    let _ = fs::remove_dir_all(&work_dir);
    fs::create_dir_all(&work_dir).expect("create work dir");
    let bundle_path = work_dir.join("translated-bundle.json");
    fs::write(&bundle_path, &bundle_json).expect("write translated bundle");

    // Output paths — ALL under the (uncommitted) work dir: the patched
    // Seen.txt (game-derived bytes), the public + private PNG artifact roots
    // and the JSON evidence report.
    let patched_seen = work_dir.join("patched").join("Seen.txt");
    let artifact_root = work_dir.join("artifacts");
    let private_root = work_dir.join("private-render");
    let evidence_path = work_dir.join("evidence.json");

    // 2. Drive the actual composed `patch-render` binary. Config-parameterized:
    //    engine + real data-root paths + scene + scope + redaction, no
    //    hard-coded game path anywhere in the shipped command.
    let output = Command::new(cli_bin())
        .args([
            "patch-render",
            "--engine",
            "reallive",
            "--seen",
            &seen_path.display().to_string(),
            "--translated-bundle",
            &bundle_path.display().to_string(),
            "--scene",
            &DIALOGUE_SCENE_ID.to_string(),
            "--gameexe",
            &gameexe_path.display().to_string(),
            "--game-dir",
            &game_dir.display().to_string(),
            "--patched-seen-output",
            &patched_seen.display().to_string(),
            "--artifact-root",
            &artifact_root.display().to_string(),
            "--private-artifact-root",
            &private_root.display().to_string(),
            "--scope",
            "dialogue",
            "--redaction",
            "on",
            "--expect-text-contains",
            EXPECT_CONTAINS,
            "--run-id",
            "patch-render-real-bytes",
            "--output",
            &evidence_path.display().to_string(),
        ])
        .output()
        .expect("spawn utsushi-cli patch-render");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("patch-render stdout:\n{stdout}");
    if !output.status.success() {
        panic!(
            "patch-render failed (status {:?}):\n{stderr}",
            output.status.code()
        );
    }
    assert!(
        stdout.contains("utsushi.reallive.patch_render_ok"),
        "composed command must print the patch_render_ok diagnostic; got:\n{stdout}"
    );

    // 3a. The PATCHED Seen.txt exists and differs from the source (the
    //     translation was really spliced in).
    let patched_bytes = fs::read(&patched_seen).expect("patched Seen.txt written");
    assert!(
        !patched_bytes.is_empty(),
        "patched Seen.txt must carry the archive bytes"
    );
    assert_ne!(
        patched_bytes, seen_bytes,
        "patched Seen.txt must differ from the source (the translation must be spliced in)"
    );
    // The patched archive must still re-parse with the same scene shape.
    let reparsed = parse_archive(&patched_bytes).expect("patched Seen.txt re-parses");
    assert_eq!(
        reparsed.entries.len(),
        parse_archive(&seen_bytes).unwrap().entries.len(),
        "patched archive must preserve the source scene-directory shape"
    );

    // 3b. The REDACTED public PNG exists on disk (a real localized frame), and
    //     the private full-fidelity PNG exists in the gitignored private tree.
    let public_pngs = find_pngs(&artifact_root);
    assert!(
        !public_pngs.is_empty(),
        "the composed command must emit a redacted public PNG under {}",
        artifact_root.display()
    );
    let private_pngs = find_pngs(&private_root);
    assert!(
        !private_pngs.is_empty(),
        "the composed command must emit a private full-fidelity PNG under {}",
        private_root.display()
    );

    // 3c. The JSON evidence report: patch half + render half, redaction-clean.
    let evidence: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&evidence_path).expect("read evidence.json"))
            .expect("evidence.json parses");
    let evidence_raw = fs::read_to_string(&evidence_path).expect("read evidence.json text");

    assert_eq!(evidence["command"], "patch-render");
    assert_eq!(evidence["engine"], "reallive");
    assert_eq!(evidence["sceneId"], DIALOGUE_SCENE_ID);
    assert_eq!(evidence["scope"], "dialogue");

    // Patch half: source vs patched hashes differ; a non-zero unit count.
    let patch = &evidence["patch"];
    let source_sha = patch["sourceSeenSha256"]
        .as_str()
        .expect("sourceSeenSha256");
    let patched_sha = patch["patchedSeenSha256"]
        .as_str()
        .expect("patchedSeenSha256");
    assert_ne!(
        source_sha, patched_sha,
        "patch evidence must record distinct source/patched Seen.txt hashes"
    );
    assert!(
        patch["translatedUnitCount"].as_u64().unwrap_or(0) > 0,
        "patch evidence must record a non-zero translated unit count"
    );

    // Render half: E2, redaction on, the rendered message carries the
    // TRANSLATED text (containsExpected == true), through the real pipeline.
    let render = &evidence["render"];
    assert_eq!(render["evidenceTier"], "E2");
    assert_eq!(render["redaction"], "on");
    assert_eq!(
        render["containsExpected"], true,
        "the rendered message must carry the translated text the config asked for"
    );
    assert_eq!(render["renderedLineCount"], 1);
    assert!(
        render["textlineCount"].as_u64().unwrap_or(0) > 0,
        "render evidence must record the observed play-order message count"
    );
    assert!(
        render["artifactId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "render evidence must carry the frame artifact id"
    );

    // Redaction-clean: the committable JSON leaks NO absolute filesystem path
    // and NO raw translated text — only ids / sha256 / counts.
    assert!(
        !evidence_raw.contains(&work_dir.display().to_string()),
        "evidence JSON must not leak the operator's work-dir path"
    );
    assert!(
        !evidence_raw.contains(EXPECT_CONTAINS),
        "evidence JSON must not embed the raw translated text (redaction-clean)"
    );

    eprintln!(
        "patch-render OK: scene {DIALOGUE_SCENE_ID} source_seen={} patched_seen={} bytes, \
         translated_units={}, public_pngs={}, private_pngs={}, render_tier={}, contains_expected={}",
        seen_bytes.len(),
        patched_bytes.len(),
        patch["translatedUnitCount"],
        public_pngs.len(),
        private_pngs.len(),
        render["evidenceTier"],
        render["containsExpected"],
    );

    // Frames stay uncommitted: clean up the scratch work dir.
    let _ = fs::remove_dir_all(&work_dir);
}

/// Collect every `*.png` under `dir` (recursive, bounded depth) — used to
/// assert the public + private frames were emitted without hard-coding the
/// content-addressed file names.
fn find_pngs(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut frontier = vec![(dir.to_path_buf(), 0usize)];
    while let Some((current, depth)) = frontier.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 6 {
                    frontier.push((path, depth + 1));
                }
            } else if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
            {
                out.push(path);
            }
        }
    }
    out
}
