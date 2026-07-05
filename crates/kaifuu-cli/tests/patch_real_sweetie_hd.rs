//! KAIFUU-211 — CLI integration test for
//! `kaifuu-cli patch --engine reallive --source <readonly> --target <writable> --bundle <translated.json>`.
//!
//! Env-gated on `ITOTORI_REAL_GAME_ROOT`. Runs the kaifuu-cli
//! binary against the real Sweetie HD extracted root, asserts:
//!
//! - The command exits 0.
//! - The output `<target>/REALLIVEDATA/Seen.txt` exists, is non-empty,
//!   and starts with the canonical 10,000-slot directory shape (10,000
//!   × 8-byte slot table).
//! - The source root's `Seen.txt` is sha256-unchanged after the run.
//! - The patched archive re-parses with the source's scene count.
//! - **Byte-fidelity (ALPHA-006c), DIALOGUE-ONLY scope:** this test
//!   exercises a single VALID user translation config — `scope =
//!   dialogue-only`. It translates ONLY the `dialogue` Textout units and
//!   leaves every non-dialogue unit (RealLive `choice_label` / select
//!   options) UNtranslated. The byte-fidelity contract is config-driven:
//!   everything INSIDE the chosen scope changes (dialogue Textout bodies →
//!   SJIS sentinel) and everything OUTSIDE it stays byte-identical to the
//!   source — the Choice/select command (its `NextString` tokens intact),
//!   binary data tables, and every opcode/header byte. The patched scene
//!   re-decompiles with ZERO new unknown opcodes (no relaxed floor).
//!   Translating choices is the separate
//!   `config-driven-translation-scope-and-choice-translation` node — NOT
//!   this one.
//!
//! The bootstrap extract targets dialogue scene **2011** (the scene the
//! `kaifuu-reallive` `bridge_real_bytes` test uses). Scene 1 is binary-only
//! — the bridge returns no_text_units for it after the dialogue-surface
//! filter — so a dialogue scene is required to exercise real
//! translatable-text extraction plus byte-correct patchback.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use kaifuu_reallive::{
    RealLiveOpcode, RealLiveSceneIndex, SceneEntry, SceneHeader, Xor2DecScene,
    compiler_version_uses_xor2, decode_dialogue_textout, decompress_avg32,
    encode_choice_option_next_string_safe, encode_shift_jis_slot, parse_real_bytecode,
    recover_archive_cipher,
};

/// The dialogue scene the bootstrap extract targets (scene 1 is
/// binary-only). This is the only scene the synthesized bundle translates,
/// so it is the only scene whose blob bytes are expected to change.
const DIALOGUE_SCENE_ID: u16 = 2011;

/// English sentinel spliced into every translated Textout body. It opens
/// with the full-width `「` (Shift-JIS `0x81 0x75`) so the patched bytes
/// still parse as a Textout opcode (the parser recognises a run by the
/// Shift-JIS lead-byte switch), guaranteeing the patched scene
/// re-decompiles with zero unknown opcodes. The remaining ASCII bytes
/// carry no structural opener, so the whole sentinel stays one Textout
/// run.
const EN_SENTINEL: &str = "「[EN] hello from kaifuu CLI patch」";

/// A NextString-hostile en-US choice translation: it opens with `[` (0x5B),
/// the byte that terminates an unquoted RealLive NextString token, and
/// carries `.`/`!`/`(`/`)` — none of which are unquoted string-token bytes.
/// A naive raw splice would truncate the option and corrupt the `module_sel`
/// select command. Under `dialogue-only` scope it must be ignored entirely;
/// under `dialogue+choices` it must be re-emitted NextString-safe.
const HOSTILE_CHOICE: &str = "[EN] Pick me! (really)";

/// Resolve this crate's manifest directory (runtime `CARGO_MANIFEST_DIR`).
///
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would resolve to a dead
/// path. `cargo test` sets `CARGO_MANIFEST_DIR` in the RUNTIME environment to
/// the LIVE crate directory; prefer that, falling back to the compile-time
/// constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn kaifuu_cli_binary() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    if path.exists() {
        return path;
    }
    path = test_manifest_dir()
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("target/debug/kaifuu-cli"))
        .expect("workspace root");
    path
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn cli_patch_engine_reallive_writes_patched_seen_txt_under_writable_target() {
    let Some(source_root) = real_corpus::game_root() else {
        eprintln!("{}", real_corpus::skip_message("CLI patch real-bytes test"));
        return;
    };
    let source_seen_path = real_corpus::seen_txt_path().expect("resolved root has Seen.txt");
    let source_seen_bytes = fs::read(&source_seen_path).expect("read source Seen.txt");
    let source_seen_hash_before = sha256_hex(&source_seen_bytes);

    let tmp = tempfile::tempdir().expect("tmp dir");
    let target_root = tmp.path().join("target-patched");
    let bundle_out = tmp.path().join("bridge-bundle-translated.json");

    // Step 1: extract the source-side bundle via the existing extract
    // CLI to bootstrap a real bundle. Target dialogue scene 2011 (scene 1
    // is binary-only and surfaces no translatable units).
    let extract_status = Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--scene")
        .arg("2011")
        .arg("--bundle-output")
        .arg(tmp.path().join("scene-2011-source.json"))
        .arg("--game-root")
        .arg(&source_root)
        .arg("--game-id")
        .arg("sweetie-hd")
        .arg("--game-version")
        .arg("1.0.0")
        .arg("--source-profile-id")
        .arg("kaifuu-reallive-sweetie-hd")
        .arg("--source-locale")
        .arg("ja-JP")
        .output()
        .expect("kaifuu-cli extract must run");
    assert!(
        extract_status.status.success(),
        "extract failed: {}",
        String::from_utf8_lossy(&extract_status.stderr)
    );

    // Synthesise a translated bundle under the CONFIG-DRIVEN dialogue-only
    // scope. Every unit — dialogue AND choice — is KEPT in the bundle and
    // carries a `target`; the choice options are given a deliberately
    // NextString-HOSTILE `[`-bearing target. Under `--scope dialogue-only`
    // the patchback must IGNORE those choice targets and carry the whole
    // Choice/select command byte-identical: the SCOPE CONFIG, not bundle
    // omission, enforces the boundary. (Translating choices is exercised by
    // the separate `dialogue+choices` run below.)
    let source_bundle_bytes =
        fs::read(tmp.path().join("scene-2011-source.json")).expect("read source bundle");
    let mut bundle_value: serde_json::Value =
        serde_json::from_slice(&source_bundle_bytes).expect("source bundle JSON parses");
    let mut dialogue_units_translated = 0usize;
    let mut non_dialogue_units_carried = 0usize;
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            if unit["surfaceKind"].as_str() == Some("dialogue") {
                unit["target"] = serde_json::json!({"locale": "en-US", "text": EN_SENTINEL});
                dialogue_units_translated += 1;
            } else {
                // Out-of-scope under dialogue-only: a corrupting `[`-target
                // the config must refuse to apply.
                unit["target"] = serde_json::json!({"locale": "en-US", "text": HOSTILE_CHOICE});
                non_dialogue_units_carried += 1;
            }
        }
    }
    assert!(
        dialogue_units_translated > 0,
        "scene {DIALOGUE_SCENE_ID} must surface at least one dialogue unit to translate"
    );
    assert!(
        non_dialogue_units_carried > 0,
        "scene {DIALOGUE_SCENE_ID} must surface at least one NON-dialogue (choice_label) unit \
         that the dialogue-only scope leaves byte-identical — proving the scope boundary is real, \
         not vacuous"
    );
    fs::write(
        &bundle_out,
        serde_json::to_vec_pretty(&bundle_value).expect("serialize translated bundle"),
    )
    .expect("write translated bundle");

    // Step 2: run the patch command with the dialogue-only scope config.
    let patch_output = Command::new(kaifuu_cli_binary())
        .arg("patch")
        .arg("--engine")
        .arg("reallive")
        .arg("--source")
        .arg(&source_root)
        .arg("--target")
        .arg(&target_root)
        .arg("--bundle")
        .arg(&bundle_out)
        .arg("--scope")
        .arg("dialogue-only")
        .output()
        .expect("kaifuu-cli patch must run");
    assert!(
        patch_output.status.success(),
        "patch exited non-zero: status={:?}\nstdout={}\nstderr={}",
        patch_output.status,
        String::from_utf8_lossy(&patch_output.stdout),
        String::from_utf8_lossy(&patch_output.stderr)
    );

    // ---- Acceptance: target Seen.txt exists and is non-empty. ----
    let target_seen_path = target_root.join("REALLIVEDATA").join("Seen.txt");
    let target_seen_bytes = fs::read(&target_seen_path).expect("read target Seen.txt");
    assert!(
        !target_seen_bytes.is_empty(),
        "patched Seen.txt must be non-empty"
    );
    assert!(
        (target_seen_bytes.len() as u64) >= 80_000,
        "patched Seen.txt must carry the 80,000-byte 10,000-slot directory; got {}",
        target_seen_bytes.len()
    );

    // ---- Acceptance: re-parse with the same scene count. ----
    let source_index = kaifuu_reallive::parse_archive(&source_seen_bytes).expect("source parses");
    let target_index = kaifuu_reallive::parse_archive(&target_seen_bytes).expect("target parses");
    assert_eq!(
        target_index.entries.len(),
        source_index.entries.len(),
        "patched archive must preserve the source's populated-slot count"
    );

    // ---- ALPHA-006c byte-fidelity: per-scene byte-identity. ----
    // Every scene EXCEPT the translated dialogue scene must round-trip
    // byte-identical (content compared per scene id — the directory
    // offsets shift because the translated scene changed size, but every
    // unmodified scene's bytes are carried verbatim by the bundle-driven
    // re-packer).
    let mut untranslated_checked = 0usize;
    for src_entry in &source_index.entries {
        let scene_id = src_entry.scene_id;
        if scene_id == DIALOGUE_SCENE_ID {
            continue;
        }
        let tgt_entry = target_index
            .entries
            .iter()
            .find(|entry| entry.scene_id == scene_id)
            .unwrap_or_else(|| panic!("scene {scene_id} missing from patched archive"));
        let src_blob = scene_blob_bytes(&source_seen_bytes, src_entry);
        let tgt_blob = scene_blob_bytes(&target_seen_bytes, tgt_entry);
        assert_eq!(
            src_blob,
            tgt_blob,
            "non-translated scene {scene_id} blob must be byte-identical after patch \
             (src_len={}, tgt_len={})",
            src_blob.len(),
            tgt_blob.len()
        );
        untranslated_checked += 1;
    }
    assert!(
        untranslated_checked > 0,
        "expected at least one untranslated scene to verify byte-identity against"
    );

    // ---- ALPHA-006c byte-fidelity: translated scene, headers intact. ----
    // Decompress the source and patched bytecode for the translated scene
    // and compare element-by-element: every NON-translatable element
    // (Meta, Command headers, expressions, Choice, binary catch-all
    // Textout runs) must be byte-identical; ONLY translatable Textout
    // bodies may change, and they must carry the SJIS-encoded sentinel.
    // Recover the per-game xor_2 cipher ONCE from the pristine source archive
    // (every source scene decodes clean, so the key validates) and reuse it to
    // decrypt BOTH the source and the patched target scene. The key is
    // per-game and identical for both; re-recovering it independently from the
    // patched archive is fragile because the strict "every scene decodes clean"
    // validation bar is a property of the corpus, not the key.
    let src_index = kaifuu_reallive::parse_archive(&source_seen_bytes).expect("source parses");
    let xor2_cipher = recover_archive_xor2_cipher(&source_seen_bytes, &src_index)
        .expect("pristine Sweetie HD source must yield a validated xor_2 cipher");
    let src_decompressed =
        decompress_scene(&source_seen_bytes, DIALOGUE_SCENE_ID, Some(&xor2_cipher));
    let tgt_decompressed =
        decompress_scene(&target_seen_bytes, DIALOGUE_SCENE_ID, Some(&xor2_cipher));
    let src_ops =
        parse_real_bytecode(&src_decompressed).expect("source scene bytecode must decode");
    let tgt_ops =
        parse_real_bytecode(&tgt_decompressed).expect("patched scene bytecode must decode");
    assert_eq!(
        src_ops.len(),
        tgt_ops.len(),
        "patch must preserve the translated scene's element count \
         (opcode/header structure intact): src={}, tgt={}",
        src_ops.len(),
        tgt_ops.len()
    );
    let sentinel_sjis = encode_shift_jis_slot(EN_SENTINEL).expect("sentinel encodes as Shift-JIS");
    let mut translated_bodies = 0usize;
    let mut binary_runs = 0usize;
    let mut choices_identical = 0usize;
    for (i, (src_op, tgt_op)) in src_ops.iter().zip(tgt_ops.iter()).enumerate() {
        match (src_op, tgt_op) {
            // OUT-OF-SCOPE: the Choice/select command. Dialogue-only scope
            // must never touch it — every byte (including the option
            // `NextString` tokens) survives verbatim.
            (RealLiveOpcode::Choice { .. }, RealLiveOpcode::Choice { .. }) => {
                assert_eq!(
                    src_op, tgt_op,
                    "out-of-scope Choice/select command element #{i} must be byte-identical after \
                     a dialogue-only patch (its NextString tokens must not be corrupted)"
                );
                choices_identical += 1;
            }
            (
                RealLiveOpcode::Textout {
                    raw_bytes: src_raw, ..
                },
                RealLiveOpcode::Textout {
                    raw_bytes: tgt_raw, ..
                },
            ) => {
                if decode_dialogue_textout(src_raw).is_some() {
                    assert_eq!(
                        tgt_raw.as_slice(),
                        sentinel_sjis.as_slice(),
                        "translated Textout element #{i} must carry only the SJIS sentinel body"
                    );
                    assert_ne!(
                        src_raw, tgt_raw,
                        "translated Textout element #{i} body must actually change"
                    );
                    translated_bodies += 1;
                } else {
                    assert_eq!(
                        src_raw, tgt_raw,
                        "binary (non-translatable) Textout run #{i} must survive byte-identical \
                         — patch must never overwrite an embedded data table"
                    );
                    binary_runs += 1;
                }
            }
            _ => assert_eq!(
                src_op, tgt_op,
                "non-Textout opcode/header element #{i} must be byte-identical after patch \
                 (only translatable text bodies may change)"
            ),
        }
    }
    assert!(
        translated_bodies > 0,
        "scene {DIALOGUE_SCENE_ID} must have at least one translated Textout body"
    );
    assert!(
        choices_identical > 0,
        "scene {DIALOGUE_SCENE_ID} must contain at least one Choice/select command left \
         byte-identical by the dialogue-only scope — proving an out-of-scope command survives \
         patchback untouched"
    );

    // ---- ALPHA-006c byte-fidelity: ZERO NEW unknown opcodes. ----
    // The patch must not introduce a single new unknown span: the patched
    // scene's unknown-opcode count must equal the source's. (Whole-scene
    // 100%-decompile of scene 2011 — driving the source count itself to
    // zero — is the separate decompiler-coverage node's job; this node
    // proves the *patchback* corrupts nothing. The element-wise check
    // above already proves every non-Textout element — including every
    // Unknown span — is byte-identical pre/post patch; this is the
    // explicit count guard the spec calls for.)
    let source_unknown = src_ops.iter().filter(|op| !op.is_recognized()).count();
    let patched_unknown = tgt_ops.iter().filter(|op| !op.is_recognized()).count();
    assert_eq!(
        patched_unknown,
        source_unknown,
        "patch must introduce zero NEW unknown opcodes in scene {DIALOGUE_SCENE_ID}: \
         source had {source_unknown}, patched has {patched_unknown} (of {} elements)",
        tgt_ops.len()
    );
    eprintln!(
        "ALPHA-006c dialogue-only byte-fidelity: untranslated_scenes_identical={untranslated_checked}, \
         scene {DIALOGUE_SCENE_ID} dialogue_units_translated={dialogue_units_translated}, \
         non_dialogue_units_carried={non_dialogue_units_carried}, translated_bodies={translated_bodies}, \
         choices_identical={choices_identical}, binary_runs_identical={binary_runs}, elements={}, \
         unknown source={source_unknown} patched={patched_unknown} (zero new)",
        tgt_ops.len()
    );

    // ---- CONFIG-DRIVEN SCOPE: dialogue+choices run. ----
    // Re-patch the SAME source into a second target, this time translating
    // the choice options too under `--scope dialogue+choices`. The choice
    // options must round-trip NextString-safe: the patched select command
    // re-decompiles cleanly and each option carries its translated bytes
    // (including the hostile `[`) without corrupting the `NextString` token.
    let target_root_dc = tmp.path().join("target-patched-dialogue-choices");
    let bundle_out_dc = tmp.path().join("bridge-bundle-dialogue-choices.json");
    let tricky = ["[EN] Yes, today! (maybe)", "[EN] No - not really... [skip]"];
    {
        let mut value: serde_json::Value =
            serde_json::from_slice(&source_bundle_bytes).expect("source bundle JSON parses");
        let mut choice_idx = 0usize;
        {
            let units = value["units"].as_array_mut().expect("units array");
            for unit in units.iter_mut() {
                if unit["surfaceKind"].as_str() == Some("choice_label") {
                    let text = tricky[choice_idx.min(tricky.len() - 1)];
                    choice_idx += 1;
                    unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
                } else {
                    unit["target"] = serde_json::json!({"locale": "en-US", "text": EN_SENTINEL});
                }
            }
        }
        assert!(
            choice_idx > 0,
            "scene {DIALOGUE_SCENE_ID} must surface a choice_label to translate under \
             dialogue+choices"
        );
        fs::write(
            &bundle_out_dc,
            serde_json::to_vec_pretty(&value).expect("serialize dc bundle"),
        )
        .expect("write dc bundle");
    }
    let patch_dc = Command::new(kaifuu_cli_binary())
        .arg("patch")
        .arg("--engine")
        .arg("reallive")
        .arg("--source")
        .arg(&source_root)
        .arg("--target")
        .arg(&target_root_dc)
        .arg("--bundle")
        .arg(&bundle_out_dc)
        .arg("--scope")
        .arg("dialogue+choices")
        .output()
        .expect("kaifuu-cli patch (dialogue+choices) must run");
    assert!(
        patch_dc.status.success(),
        "dialogue+choices patch exited non-zero: stdout={}\nstderr={}",
        String::from_utf8_lossy(&patch_dc.stdout),
        String::from_utf8_lossy(&patch_dc.stderr)
    );
    let dc_seen_bytes =
        fs::read(target_root_dc.join("REALLIVEDATA").join("Seen.txt")).expect("read dc Seen.txt");
    let dc_index = kaifuu_reallive::parse_archive(&dc_seen_bytes).expect("dc target parses");
    let dc_cipher = recover_archive_xor2_cipher(&source_seen_bytes, &src_index)
        .expect("source must yield xor_2 cipher for dc verify");
    let dc_decompressed = decompress_scene(&dc_seen_bytes, DIALOGUE_SCENE_ID, Some(&dc_cipher));
    let _ = &dc_index;
    let dc_ops = parse_real_bytecode(&dc_decompressed)
        .expect("dialogue+choices patched scene must re-decompile cleanly (select framing intact)");
    let dc_choices = dc_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .expect("dialogue+choices patched scene must still carry the module_sel Choice");
    assert_eq!(
        dc_choices.len(),
        2,
        "both choice options must survive the NextString-safe splice"
    );
    for (i, expected_text) in tricky.iter().enumerate() {
        let expected_bytes =
            encode_choice_option_next_string_safe(expected_text).expect("tricky encodes");
        assert_eq!(
            dc_choices[i].bytes, expected_bytes,
            "dialogue+choices option {i} must be the NextString-safe encoding of the translation"
        );
        assert!(
            decode_dialogue_textout(&dc_choices[i].bytes).is_some(),
            "dialogue+choices option {i} must decode cleanly"
        );
        assert!(
            dc_choices[i].bytes.contains(&b'['),
            "dialogue+choices option {i} must carry the literal `[` byte (not truncated)"
        );
    }
    eprintln!(
        "config-driven scope: dialogue+choices CLI run round-tripped scene {DIALOGUE_SCENE_ID} \
         choice NextString-safe ({} options)",
        dc_choices.len()
    );

    // ---- Acceptance: source sha256-unchanged. ----
    let source_seen_hash_after = sha256_hex(&fs::read(&source_seen_path).expect("re-read source"));
    assert_eq!(
        source_seen_hash_after, source_seen_hash_before,
        "source Seen.txt must be sha256-unchanged after the patch step \
         (before={source_seen_hash_before}, after={source_seen_hash_after})"
    );
}

/// Slice a scene's raw blob bytes out of a Seen.txt archive for a given
/// directory entry.
fn scene_blob_bytes(seen_bytes: &[u8], entry: &SceneEntry) -> Vec<u8> {
    let start = entry.byte_offset as usize;
    let end = start + entry.byte_len as usize;
    seen_bytes[start..end].to_vec()
}

/// Resolve a scene by id from a Seen.txt archive and return its
/// AVG32-decompressed, `xor_2`-DECRYPTED bytecode (the plaintext layer the
/// opcode parser consumes).
///
/// Sweetie HD (compiler_version 110002) is encrypted-at-rest: both the source
/// archive and the patchback output carry the second-level `xor_2` cipher over
/// `[256, 513)` of every `use_xor_2` scene. This helper mirrors the read
/// pipeline — decompress, then decrypt with the per-game key recovered
/// cross-scene from the whole archive — so the byte-fidelity comparison runs on
/// the real plaintext bytecode of both the source and the patched target.
fn decompress_scene(
    seen_bytes: &[u8],
    scene_id: u16,
    xor2_cipher: Option<&kaifuu_reallive::Xor2Cipher>,
) -> Vec<u8> {
    let index: RealLiveSceneIndex =
        kaifuu_reallive::parse_archive(seen_bytes).expect("Seen.txt envelope must parse");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} must exist in the archive"));
    let blob = scene_blob_bytes(seen_bytes, entry);
    let header = SceneHeader::parse(&blob).expect("scene header must parse");
    let bytecode_start = header.bytecode_offset as usize;
    let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
    let mut decompressed = decompress_avg32(
        &blob[bytecode_start..bytecode_end],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("scene bytecode must decompress");

    if compiler_version_uses_xor2(header.compiler_version) {
        xor2_cipher
            .expect("a use_xor_2 scene requires a recovered xor_2 cipher to decrypt")
            .apply_segment(&mut decompressed);
    }
    decompressed
}

/// Recover the validated per-game `xor_2` cipher by decompressing every scene
/// of the archive (the cross-scene known-plaintext key recovery). Returns
/// `None` when the archive carries no `use_xor_2` scenes or no key validates.
fn recover_archive_xor2_cipher(
    seen_bytes: &[u8],
    index: &RealLiveSceneIndex,
) -> Result<kaifuu_reallive::Xor2Cipher, kaifuu_reallive::Xor2Report> {
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let blob = scene_blob_bytes(seen_bytes, entry);
        let Ok(header) = SceneHeader::parse(&blob) else {
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
    recover_archive_cipher(&scenes)
}
