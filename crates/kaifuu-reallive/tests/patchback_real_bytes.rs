//! real-bytes integration test for the bundle-driven
//! patchback driver (`apply_translated_bundle`).
//! Loads a Sweetie HD **dialogue scene** from `ITOTORI_REAL_GAME_ROOT`,
//! runs `kaifuu_reallive::produce_bundle` to get the canonical
//! source-side bundle, **synthesises** a translated bundle by replacing
//! every (dialogue) unit's `target.text` with a known en-US sentinel
//! string, applies the patchback, re-parses the patched `Seen.txt`, and
//! asserts the acceptance criteria PLUS the binary-vs-dialogue
//! surface-selection guarantee:
//! - The directory still has 198 entries.
//! - The patched scene's bytecode decompresses cleanly.
//! - The Textout opcodes now contain the en-US sentinel bytes (not the
//!   original ja-JP body).
//! - **Every binary (non-translatable) Textout run in the scene survives
//!   patchback byte-identical** — a translate+patchback run never
//!   overwrites the embedded data tables.
//! - The file size is within +/- 50% of the original.
//! - The original source byte slice is unchanged (returned `Vec<u8>`
//!   is a fresh allocation).
//!   Env-gated and STRICT: without `ITOTORI_REAL_GAME_ROOT` an absent corpus is
//!   an unconditional HARD FAILURE (no opt-out). This `#[ignore]`-d suite runs
//!   only in the periodic ground-truth oracle (`just real-bytes-oracle`), where
//!   the corpus is staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_core::RedactedContentSummary;
use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode, SceneHeader,
    TranslatedBundleV02, TranslationScope, Xor2Cipher, Xor2DecScene, apply_translated_bundle,
    collect_goto_pointer_sites, compiler_version_uses_xor2, decode_dialogue_textout,
    decompress_avg32, encode_choice_option_next_string_safe, gameexe::parse_gameexe_inventory,
    parse_archive, parse_real_bytecode, parse_real_bytecode_spans, produce_bundle,
    recover_archive_cipher,
};

const SWEETIE_HD_GAME_ID: &str = "sweetie-hd";
const SWEETIE_HD_SOURCE_PROFILE_ID: &str = "kaifuu-reallive-sweetie-hd";
/// A known dialogue-bearing scene in Sweetie HD's `Seen.txt` that decodes
/// 100% clean. Scene 1 is an all-binary boundary scene and carries no
/// translatable units (see `bridge_real_bytes`), so the patchback
/// round-trip is exercised against a real dialogue scene instead.
/// (Scene 2011, previously used here, contains a second-level-XOR'd
/// `module_sel` block — a `compiler_version=110002` `xor_2` segment owned
/// by the decompressor — and can no longer be decoded
/// end-to-end, so it is not a valid clean round-trip fixture.)
const DIALOGUE_SCENE_ID: u16 = 1017;

/// English-language sentinel used by the round-trip assertion.
/// Prefixed with one full-width SJIS punctuation character (`「`,
/// 0x81 0x75) so the patched bytes still parse as a Textout opcode (the
/// parser recognises a run by the SJIS lead-byte switch
/// `0x81..=0x9F | 0xE0..=0xFC`).
const EN_SENTINEL: &str = "「[EN] hello world from roundtrip1」";

/// SJIS lead-byte for the leading `「` character.
const EN_SENTINEL_SJIS_PREFIX: &[u8] = &[0x81, 0x75];

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}

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

/// `(scene_blob, decompressed_bytecode, header)` for a scene id.
/// The bytecode is returned as the real PLAINTEXT the interpreter executes:
/// after AVG32 decompression, Sweetie HD's second-level `xor_2` segment
/// (`compiler_version=110002`) over `[256, 513)` is decrypted with the
/// per-game key recovered cross-scene from the whole archive. Comparing at
/// the plaintext layer is the only correct fidelity check for an
/// encrypted-at-rest game: the patchback re-encrypts edited scenes, so a raw
/// (still-ciphertext) comparison would see the position-fixed xor_2 window
/// shift whenever a length-changing splice moved content under it.
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
/// of the archive (the cross-scene known-plaintext key recovery). `None` when
/// the archive carries no `use_xor_2` scenes or no key validates.
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

#[path = "patchback_real_bytes/dialogue.rs"]
mod dialogue;

#[path = "patchback_real_bytes/choices.rs"]
mod choices;

#[path = "patchback_real_bytes/select.rs"]
mod select;

/// Decompress + `xor_2`-decrypt scene `scene_id` out of `seen_bytes` to the
/// plaintext bytecode layer, using an already-recovered per-game cipher.
fn decrypt_scene(seen_bytes: &[u8], scene_id: u16, cipher: &Xor2Cipher) -> Vec<u8> {
    let index = parse_archive(seen_bytes).expect("archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} present"));
    let blob = &seen_bytes
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
    let header = SceneHeader::parse(blob).expect("header");
    let bo = header.bytecode_offset as usize;
    let bc = header.bytecode_compressed_size as usize;
    let mut d = decompress_avg32(
        &blob[bo..bo + bc],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("decompress");
    if compiler_version_uses_xor2(header.compiler_version) {
        cipher.apply_segment(&mut d);
    }
    d
}
/// A goto-rich Sweetie HD dialogue scene used by the length-changing
/// jump-recalculation test. Scene 8509 decodes 100% clean (0 unknown, 0
/// generic Command), surfaces 72 translatable dialogue units, and carries
/// **91 goto-family jump-target pointers**, every one of whose destination
/// sits AFTER the first dialogue body — so a length-changing edit to the
/// dialogue shifts all 91 targets and forces the recalculation path.
const GOTO_SCENE_ID: u16 = 8509;

/// A LONGER en-US replacement body. Deliberately long enough that even
/// replacing a multi-byte Shift-JIS source line (2 bytes/char) grows the
/// total scene bytecode — a genuine length-INCREASING edit. Carries NO
/// structural-opener byte (`0x00 0x0A 0x21 0x23 0x24 0x2C 0x40`, i.e. no
/// `,` `!` `#` `$` `@`) so it re-decodes as exactly ONE Textout element and
/// the scene's element count is preserved (the same-logical-element jump
/// assertion below keys on that 1:1 element correspondence).
const LONG_SENTINEL: &str = "「[EN] This is a deliberately long English localization line \
    padded well beyond the original Japanese so that even after the two-byte-per-character \
    Shift-JIS source is removed the patched scene bytecode is strictly larger exercising the \
    forward jump-target recalculation path across every downstream goto pointer in the scene」";
/// A SHORTER en-US replacement body (shrinks the multi-byte JA dialogue).
/// Leading/trailing full-width brackets keep it a valid Shift-JIS Textout run.
const SHORT_SENTINEL: &str = "「A」";

/// Map each element-boundary byte offset in `bytecode` to its element
/// ordinal (index into the decoded element stream), plus a synthetic
/// end-of-stream ordinal for fall-through targets. Every well-formed goto
/// target lands on one of these boundaries.
fn boundary_ordinals(bytecode: &[u8]) -> std::collections::BTreeMap<usize, (usize, &'static str)> {
    let spans = parse_real_bytecode_spans(bytecode).expect("bytecode spans decode");
    let mut map = std::collections::BTreeMap::new();
    let mut cursor = 0usize;
    for (ordinal, (op, width)) in spans.iter().enumerate() {
        map.insert(cursor, (ordinal, op.label()));
        cursor += width;
    }
    // End-of-stream boundary: a jump-to-end / fall-through target.
    map.insert(cursor, (spans.len(), "<end-of-stream>"));
    map
}

/// Exercise the length-changing patchback's jump-target recalculation on a
/// real, goto-rich Sweetie HD scene, for BOTH a longer and a shorter
/// translated body. Proves:
/// - the archive re-parses with the same 198-scene count and a correctly
///   rewritten scene offset table;
/// - the patched scene re-decompiles with ZERO new unknown / generic
///   opcodes and ZERO malformed framing (`parse_real_bytecode_spans` Ok);
/// - EVERY one of the 91 goto pointers was recalculated to a NEW byte
///   offset that still lands on an element boundary AND still targets the
///   SAME logical element (same ordinal + same opcode label) it pointed to
///   in the source — i.e. a jump that pointed to opcode X still points to
///   opcode X at its new offset, never into the middle of a command.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn length_changing_patch_recalculates_goto_targets_on_real_scene() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "length_changing_patch_recalculates_goto_targets_on_real_scene",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let cipher = recover_archive_xor2_cipher(&seen_bytes)
        .expect("Sweetie HD must yield a validated xor_2 cipher");

    let source_seen_len = seen_bytes.len();

    let source_bytecode = decrypt_scene(&seen_bytes, GOTO_SCENE_ID, &cipher);
    let source_boundaries = boundary_ordinals(&source_bytecode);
    let source_sites =
        collect_goto_pointer_sites(&source_bytecode).expect("source scene goto pointers collect");
    assert!(
        source_sites.len() >= 50,
        "test scene must be goto-rich; got {} sites",
        source_sites.len()
    );
    // Every source target lands on a boundary and targets a known element.
    let source_target_ordinals: Vec<(usize, &'static str)> = source_sites
        .iter()
        .map(|site| {
            assert!(site.target >= 0, "source goto target must be non-negative");
            *source_boundaries
                .get(&(site.target as usize))
                .unwrap_or_else(|| {
                    panic!(
                        "source goto target {:#x} does not land on an element boundary",
                        site.target
                    )
                })
        })
        .collect();

    // The source bundle (producer), reused for both directions.
    let (scene_blob, decompressed, header) = scene_bytes(&seen_bytes, GOTO_SCENE_ID);
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        GOTO_SCENE_ID,
        &scene_blob,
        &decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle builds from the goto-rich scene");
    let dialogue_units = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "dialogue")
        .count();
    assert!(dialogue_units > 0, "scene must carry dialogue units");

    for (label, sentinel, expect_longer) in [
        ("LONGER", LONG_SENTINEL, true),
        ("SHORTER", SHORT_SENTINEL, false),
    ] {
        // Translate every dialogue unit to the sentinel of this direction.
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"]
                .as_array_mut()
                .expect("units array");
            for unit in units.iter_mut() {
                unit["target"] = serde_json::json!({"locale": "en-US", "text": sentinel});
            }
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");

        let patched = apply_translated_bundle(
            &seen_bytes,
            &translated,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .unwrap_or_else(|err| panic!("{label}: length-changing patch must succeed: {err}"));

        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(
            reparsed.entries.len(),
            198,
            "{label}: patched archive must keep the 198-scene directory"
        );

        let patched_bytecode = decrypt_scene(&patched, GOTO_SCENE_ID, &cipher);
        let patched_ops = parse_real_bytecode(&patched_bytecode)
            .unwrap_or_else(|err| panic!("{label}: patched scene must re-decompile: {err}"));
        let unknown = patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Unknown { .. }))
            .count();
        let generic = patched_ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Command { .. }))
            .count();
        assert_eq!(unknown, 0, "{label}: zero unknown opcodes required");
        assert_eq!(
            generic, 0,
            "{label}: zero generic (un-catalogued) commands required"
        );
        // Framing must still partition exactly (no MalformedExpression / drift).
        parse_real_bytecode_spans(&patched_bytecode)
            .unwrap_or_else(|err| panic!("{label}: patched framing must partition: {err}"));

        if expect_longer {
            assert!(
                patched_bytecode.len() > source_bytecode.len(),
                "{label}: patched bytecode ({}) must be longer than source ({})",
                patched_bytecode.len(),
                source_bytecode.len()
            );
        } else {
            assert!(
                patched_bytecode.len() < source_bytecode.len(),
                "{label}: patched bytecode ({}) must be shorter than source ({})",
                patched_bytecode.len(),
                source_bytecode.len()
            );
        }

        // boundary, targets the SAME logical element. ----
        let patched_boundaries = boundary_ordinals(&patched_bytecode);
        let patched_sites = collect_goto_pointer_sites(&patched_bytecode)
            .expect("patched scene goto pointers collect");
        assert_eq!(
            patched_sites.len(),
            source_sites.len(),
            "{label}: goto pointer count must be preserved"
        );

        let mut changed_targets = 0usize;
        for (i, (src, pat)) in source_sites.iter().zip(patched_sites.iter()).enumerate() {
            assert!(
                pat.target >= 0,
                "{label}: patched goto target #{i} must be non-negative"
            );
            let (pat_ord, pat_label) = *patched_boundaries
                .get(&(pat.target as usize))
                .unwrap_or_else(|| {
                    panic!(
                        "{label}: patched goto target #{i} = {:#x} does NOT land on an element \
                         boundary (would jump into the middle of a command)",
                        pat.target
                    )
                });
            let (src_ord, src_label) = source_target_ordinals[i];
            assert_eq!(
                (pat_ord, pat_label),
                (src_ord, src_label),
                "{label}: goto #{i} must still target the same logical element \
                 (source ordinal {src_ord}/{src_label}); got {pat_ord}/{pat_label}"
            );
            if pat.target != src.target {
                changed_targets += 1;
            }
        }
        // A length change that shifts content under the jumps MUST move at
        // least some targets (proving recalculation ran, not a silent no-op).
        assert!(
            changed_targets > 0,
            "{label}: expected at least one goto target to be re-based by the length delta"
        );

        eprintln!(
            "scene {GOTO_SCENE_ID} {label}: seen {source_seen_len}->{} bytes, scene bytecode \
             {}->{} bytes, {} goto pointers all land on element boundaries & target the same \
             elements ({changed_targets} re-based)",
            patched.len(),
            source_bytecode.len(),
            patched_bytecode.len(),
            patched_sites.len(),
        );
    }
}

/// Cheap byte-checksum used by the test for "byte slice unchanged"
/// invariants. Not a cryptographic hash; FNV-1a suffices for detecting
/// any in-place mutation.
fn simple_hash(bytes: &[u8]) -> u64 {
    let mut acc: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        acc ^= u64::from(*byte);
        acc = acc.wrapping_mul(0x100000001b3);
    }
    acc
}
