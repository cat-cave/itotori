//! utsushi-cli-single-scene-xor2-staging — real-bytes acceptance for the
//! single-scene `replay-validate` path on a `use_xor_2` title (Sweetie HD,
//! compiler `110002`).
//!
//! The bug this pins: the single-scene CLI replay path
//! (`replay-validate` → `utsushi_reallive::replay_scene`) drives the
//! pure-`utsushi-reallive` decode path, which owns the first-level AVG32
//! inflate but NOT the second-level `use_xor_2` segment cipher over
//! `[256, 513)`. On Sweetie HD it therefore replayed the still-ciphered
//! segment as MOJIBAKE, and the observed-translated-text assertion
//! (`assertReplayObservedTranslatedText`) correctly FAILED.
//!
//! The fix stages the dev-only `kaifuu-reallive` `recover_and_decrypt_archive`
//! recovery in the CLI orchestration layer (the same seam the
//! `full_module_replay_real_bytes` test uses), so the emitted `ReplayLog`
//! carries REAL decoded text.
//!
//! This test proves the wiring end-to-end:
//!   1. Patch a REAL Sweetie HD dialogue scene with a known en-US string via
//!      the kaifuu patchback (which re-encrypts the xor2 segment, exactly as
//!      the shipped pipeline does).
//!   2. Drive the actual `utsushi-cli replay-validate` binary against the
//!      patched Seen.txt and read the emitted replay-log.json.
//!   3. POSITIVE: assert the engine's OBSERVED `text_line` bodies contain the
//!      real translated text (not mojibake) — the exact assertion
//!      `assertReplayObservedTranslatedText` performs.
//!   4. NEGATIVE control: the pure `utsushi_reallive::replay_scene` path
//!      (no staging) does NOT observe the translated text on the SAME patched
//!      bytes — proving the xor2 staging is load-bearing.
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE
//! (no opt-out; runs only in the periodic ground-truth oracle,
//! `just real-bytes-oracle`, where corpora are staged). Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie-hd> cargo test -p utsushi-cli
//! --test single_scene_xor2_replay_real_bytes -- --ignored`.

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

/// A known dialogue-bearing scene in Sweetie HD's `Seen.txt` for which the
/// `use_xor_2` staging is LOAD-BEARING: the ciphered `[256, 513)` segment
/// derails the pure (non-staged) bytecode parse so the dialogue never
/// decodes to the patched text (0 observed matches), whereas the staged
/// (decrypted) path decodes every one of the scene's translatable units.
/// (Scene 1 is the all-binary bootstrap scene and carries no translatable
/// units; a handful of scenes such as 1017 happen to re-synchronise past the
/// segment and so are NOT load-bearing — 1007 is.)
const DIALOGUE_SCENE_ID: u16 = 1007;

/// Known en-US "translation" written into the scene. Prefixed/suffixed with
/// full-width SJIS brackets (`「`/`」`) so the patched bytes still parse as a
/// Textout opcode (the parser recognises a run by the SJIS lead-byte switch).
///
/// The ASCII core is deliberately distinctive AND free of any byte the
/// RealLive textout partitioner treats as a structural lead — no digits
/// (`0x30..=0x34` are selection-option markers), no `!` `#` `$` `,` `@`
/// (0x21/0x23/0x24/0x2C/0x40) — so the whole translation surfaces as ONE
/// observed textout run rather than being split mid-string. Real game text
/// never aliases this exact phrase.
const EN_TRANSLATION: &str = "「[EN] observed staging text for utsushi cli single scene」";

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
/// The bytecode is returned as the real PLAINTEXT the interpreter executes:
/// after AVG32 decompression, Sweetie HD's `use_xor_2` segment over
/// `[256, 513)` is decrypted with the per-game key recovered cross-scene from
/// the whole archive.
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

/// Recover the validated per-game `xor_2` cipher by decompressing every scene
/// of the archive (the cross-scene known-plaintext key recovery).
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

/// Synthesise a patched Seen.txt: every translatable unit of
/// `DIALOGUE_SCENE_ID` gets `EN_TRANSLATION` as its en-US target, and the
/// patchback re-encrypts the edited scene's xor2 segment (dialogue-only
/// scope). Returns the patched envelope bytes.
fn build_patched_seen(seen_bytes: &[u8], gameexe_bytes: &[u8]) -> Vec<u8> {
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
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");

    apply_translated_bundle(
        seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("apply_translated_bundle must succeed on the dialogue scene")
}

/// Count the `text_line` events in a replay-log JSON whose observed body
/// contains `needle` (mirrors `assertReplayObservedTranslatedText`: it
/// checks `bodyUtf8`, then re-decodes `bodyShiftJisHex` as a byte-stable
/// fallback).
fn observed_matches(replay_log: &serde_json::Value, needle: &str) -> (usize, usize) {
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
    let mut i = 0;
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
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD, xor_2 / 110002)"]
fn single_scene_replay_validate_decodes_real_text_on_xor2_title() {
    let Some(seen_path) = real_corpus::seen_txt_path() else {
        real_corpus::require_real_bytes(
            "single_scene_replay_validate_decodes_real_text_on_xor2_title",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    let gameexe_path = real_corpus::gameexe_ini_path().expect("Gameexe.ini path");
    let g00_dir = real_corpus::reallivedata_subdir("g00").expect("g00 directory path");

    // Confirm the corpus is genuinely a `use_xor_2` title (else this test
    // would be vacuous).
    let index = parse_archive(&seen_bytes).expect("real Seen.txt envelope must parse");
    let first_header = {
        let entry = &index.entries[0];
        let blob = &seen_bytes
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
        SceneHeader::parse(blob).expect("scene header parses")
    };
    assert!(
        compiler_version_uses_xor2(first_header.compiler_version),
        "corpus must be a use_xor_2 title (compiler 110002/1110002); got compiler {}",
        first_header.compiler_version
    );

    let gameexe_bytes = fs::read(&gameexe_path).expect("read Gameexe.ini");

    // 1. Patch a real dialogue scene with the known en-US translation. The
    //    patchback re-encrypts the edited scene's xor2 segment.
    let patched = build_patched_seen(&seen_bytes, &gameexe_bytes);

    let work_dir = std::env::temp_dir().join(format!(
        "utsushi-cli-xor2-replay-{}-{}",
        std::process::id(),
        DIALOGUE_SCENE_ID
    ));
    fs::create_dir_all(&work_dir).expect("create work dir");
    let patched_seen = work_dir.join("Seen.txt");
    fs::write(&patched_seen, &patched).expect("write patched Seen.txt");
    let replay_log_path = work_dir.join("replay-log.json");

    // 2. Drive the actual `replay-validate` binary (the CLI single-scene
    //    path that stages xor2 recovery) against the patched envelope.
    let output = Command::new(cli_bin())
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("replay-validate stdout:\n{stdout}");
    if !output.status.success() {
        panic!(
            "replay-validate failed (status {:?}):\n{stderr}",
            output.status.code()
        );
    }

    // 3. POSITIVE: the engine's OBSERVED text_line bodies decode the real
    //    translated text (not mojibake) — the exact
    //    assertReplayObservedTranslatedText intersection check.
    let staged_log: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&replay_log_path).expect("read replay-log.json"))
            .expect("replay-log.json parses");
    let (staged_textlines, staged_matches) = observed_matches(&staged_log, EN_TRANSLATION);
    eprintln!(
        "STAGED (replay-validate): text_lines={staged_textlines} matching_observed={staged_matches}"
    );
    assert!(
        staged_matches > 0,
        "replay-validate must stage xor2 recovery so the engine OBSERVES the real translated \
         text; got {staged_matches}/{staged_textlines} matching text_line(s). The patched xor2 \
         segment did not round-trip through the VM's decode (mojibake)."
    );

    // 4. NEGATIVE control: the pure `utsushi_reallive::replay_scene` path
    //    (no xor2 staging) does NOT observe the translated text on the SAME
    //    patched bytes — proving the staging is load-bearing, not vacuous.
    let pure_matches =
        pure_replay_observed_matches(&patched_seen, DIALOGUE_SCENE_ID, EN_TRANSLATION);
    eprintln!("PURE (no staging): observed_translated_text={pure_matches}");
    assert_eq!(
        pure_matches, 0,
        "the pure (non-staged) decode path must NOT observe the translated text on the ciphered \
         xor2 segment (it should be mojibake); observing it here would mean the xor2 staging is \
         not load-bearing and this test is vacuous"
    );

    let _ = fs::remove_dir_all(&work_dir);
}

// Count observed `text_line` matches from the PURE (non-staged)
// `utsushi_reallive::replay_scene` path. A decode failure (the ciphered
// segment derails the bytecode parse) surfaces as `Err`, which is itself
// zero observed matches.
fn pure_replay_observed_matches(seen_path: &Path, scene_id: u16, needle: &str) -> usize {
    let opts = utsushi_reallive::ReplayOpts::default();
    match utsushi_reallive::replay_scene(seen_path, scene_id, &opts) {
        Ok(log) => {
            let value = log
                .to_deterministic_json()
                .ok()
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .unwrap_or(serde_json::Value::Null);
            observed_matches(&value, needle).1
        }
        Err(err) => {
            eprintln!("pure replay_scene returned typed error (mojibake/undecodable): {err}");
            0
        }
    }
}
