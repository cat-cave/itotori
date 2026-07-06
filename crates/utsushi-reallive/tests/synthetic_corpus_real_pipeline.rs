//! `synthetic-fixture-author-feature-complete-archives` (P2) — RealLive.
//!
//! Authors MINIMAL, feature-complete SYNTHETIC RealLive archives that
//! instantiate every component of the RealLive engine family in the coverage
//! manifest (`fixtures/synthetic/coverage-manifest.v0.json`) EXACTLY ONCE,
//! and drives them through the REAL decode / framing / cipher / patchback
//! pipeline — the same pipeline the ~30-minute real-bytes lanes use — proving
//! they decode/replay/patch CLEAN just like the real archives, orders of
//! magnitude faster (seconds, tiny archives) and with NO copyrighted bytes.
//!
//! # Not a "scene-1 mirage"
//!
//! The archives are DERIVED FROM the real byte-format understanding, not
//! hand-guessed: every scene is assembled with the SAME encoders the real
//! pipeline uses —
//!
//! - the real AVG32 re-compressor ([`kaifuu_reallive::compress_avg32_literal`]),
//! - the documented `0x1d0`-byte [`kaifuu_reallive::SceneHeader`] framing and
//!   the 10,000-slot `Seen.txt` envelope ([`kaifuu_reallive::parse_archive`]),
//! - the real `xor_2` second-level segment transform (recovered + decrypted by
//!   [`kaifuu_reallive::recover_and_decrypt_archive`]),
//! - the real `module_sel` select-block framing + the NextString-safe choice
//!   encoder ([`kaifuu_reallive::encode_choice_option_next_string_safe`]),
//! - the real bundle-driven patchback
//!   ([`kaifuu_reallive::apply_translated_bundle`]),
//!
//! — and each one is then CONFIRMED to decode back through the REAL decoders
//! ([`kaifuu_reallive::parse_real_bytecode`] and utsushi's independent
//! [`utsushi_reallive::decode_bytecode_stream`]) to exactly the components it
//! was built to exercise (round-trip: re-emit == input, zero-unknown).
//!
//! All dialogue / choice / text is SYNTHETIC English authored here.

use std::collections::BTreeSet;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, CommandArg, Expr, PatchbackOpts, RealLiveOpcode, SceneHeader, TranslatedBundleV02,
    TranslationScope, Xor2DecScene, apply_translated_bundle, compiler_version_uses_xor2,
    decode_dialogue_textout, encode_choice_option_next_string_safe, framing_manifest,
    gameexe::parse_gameexe_inventory, parse_archive, parse_expression, parse_real_bytecode,
    parse_real_bytecode_spans, parse_scene_into_ast, produce_bundle, recover_and_decrypt_archive,
    reemit_scene,
};
use serde_json::Value;
use utsushi_reallive::{
    G00_TYPE_PALETTED_LZSS, G00Type, decode_bytecode_stream, decode_g00, decompress_all_scenes,
};

#[path = "support/g00_synthetic.rs"]
mod g00_synthetic;

// ---------------------------------------------------------------------------
// Manifest access.
// ---------------------------------------------------------------------------

fn manifest_value() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/synthetic/coverage-manifest.v0.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read coverage manifest {}: {err}", path.display()));
    serde_json::from_slice(&bytes).expect("coverage manifest is valid JSON")
}

fn reallive_group<'a>(manifest: &'a Value, group: &str) -> &'a Value {
    &manifest["engineFamilies"]["reallive"]["componentGroups"][group]
}

/// The 289 `(module_id, opcode)` tuples the manifest enumerates for RealLive.
fn manifest_tuples(manifest: &Value) -> Vec<(u8, u16)> {
    reallive_group(manifest, "opcode_tuple")["components"]
        .as_array()
        .expect("opcode_tuple components array")
        .iter()
        .map(|c| {
            (
                c["moduleId"].as_u64().expect("moduleId") as u8,
                c["opcode"].as_u64().expect("opcode") as u16,
            )
        })
        .collect()
}

fn manifest_string_list(manifest: &Value, group: &str) -> Vec<String> {
    reallive_group(manifest, group)["components"]
        .as_array()
        .expect("components array")
        .iter()
        .map(|c| c.as_str().expect("string component").to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Synthetic RealLive archive builder — built FROM the real encoders.
// ---------------------------------------------------------------------------

/// A planted 16-byte `xor_2` key used to STAGE the encrypted-at-rest xor2
/// corpus. Recovery is done by the REAL cross-scene known-plaintext recovery
/// ([`recover_and_decrypt_archive`]); this only encrypts the fixture so the
/// real recovery has something to recover. Non-copyrighted, arbitrary bytes.
const PLANTED_XOR2_KEY: [u8; 16] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01,
];

const XOR2_SEGMENT_OFFSET: usize = 0x100; // 256
const XOR2_SEGMENT_LENGTH: usize = 0x101; // 257

/// The documented `xor_2` segment transform (`data[256 + i] ^= key[i % 16]`).
/// Self-inverse; used ONLY to stage the encrypted fixture. The real decryptor
/// is [`recover_and_decrypt_archive`].
fn stage_encrypt_xor2_segment(data: &mut [u8], key: &[u8; 16]) {
    for i in 0..XOR2_SEGMENT_LENGTH {
        let pos = XOR2_SEGMENT_OFFSET + i;
        if pos >= data.len() {
            break;
        }
        data[pos] ^= key[i % 16];
    }
}

fn push_cmd(out: &mut Vec<u8>, module_type: u8, module_id: u8, opcode: u16) {
    out.push(0x23); // COMMAND opener
    out.push(module_type);
    out.push(module_id);
    out.extend_from_slice(&opcode.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // argc = 0
    out.push(0); // overload
}

fn push_meta_line(out: &mut Vec<u8>, line: u16) {
    out.push(0x0a);
    out.extend_from_slice(&line.to_le_bytes());
}

/// The synthetic English dialogue line (ASCII => a valid Shift-JIS Textout run
/// carrying no structural opener bytes and no control bytes, so the bridge
/// surfaces it as a translatable `dialogue` unit).
const SYNTH_DIALOGUE: &[u8] = b"[EN] Hello traveler this is a synthetic line";

/// The two synthetic English source choice options (plain NextString tokens —
/// letters + spaces only, so they decode cleanly through the real select
/// framing).
const SYNTH_CHOICE_0: &[u8] = b"Left path onward";
const SYNTH_CHOICE_1: &[u8] = b"Right path homeward";

/// Build the decompressed scene bytecode that instantiates every RealLive
/// element form + every manifest `(module_id, opcode)` tuple exactly once.
///
/// Layout: `pad` MetaLine(0) triples (so the `xor_2` segment `[256, 513)` is
/// uniform across scenes and the real known-plaintext key recovery is exact),
/// then the feature-complete body.
fn build_content_bytecode(tuples: &[(u8, u16)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();

    // 0x00 dominant padding so the xor_2 [256,513) segment is a uniform
    // MetaLine(0) run in every eligible scene (exact key recovery).
    for _ in 0..200 {
        push_meta_line(&mut out, 0); // 0a 00 00
    }

    // ---- element forms: Meta / Comma / Textout / Expression ----
    push_meta_line(&mut out, 1); // MetaLine
    out.extend_from_slice(&[0x21, 0x00, 0x00]); // MetaEntrypoint
    out.extend_from_slice(&[0x40, 0x00, 0x00]); // MetaKidoku
    out.push(0x00); // Comma (0x00 form)
    out.push(0x2c); // Comma (0x2C form)
    out.extend_from_slice(SYNTH_DIALOGUE); // Textout (dialogue run)
    // NB: the standalone `0x24` Expression element form is a kaifuu decoder
    // taxonomy element whose utsushi counterpart is an ASSIGNMENT-shaped
    // element; it is covered (and 0x24-opener coverage with it) via the
    // kaifuu-decoded corpus snippets in `decoder_snippets`, kept OUT of the
    // archived scene so utsushi's independent decoder reaches clean parity.

    // ---- element forms only reachable via specific commands ----
    push_cmd(&mut out, 1, 3, 3); //  CharacterTextDisplay (msg opcode 3)
    push_cmd(&mut out, 1, 4, 17); // End (sys opcode 17)
    push_cmd(&mut out, 1, 11, 0); // SetVariable (mem)
    push_cmd(&mut out, 1, 1, 0); //  Goto (jmp 0/1)
    push_cmd(&mut out, 1, 1, 2); //  Branch (jmp 2/3)
    push_cmd(&mut out, 1, 1, 4); //  If (jmp 4/5)
    push_cmd(&mut out, 1, 1, 10); // Call (jmp 10..=13)
    push_cmd(&mut out, 1, 1, 20); // Return (jmp 20..=22)
    push_cmd(&mut out, 1, 1, 30); // Jump (jmp default)

    // ---- Choice: a real module_sel select-block ({ ... }) ----
    push_select_block(&mut out, &[SYNTH_CHOICE_0, SYNTH_CHOICE_1]);

    // ---- every manifest (module_id, opcode) tuple, module_type = 1 ----
    // module_type 1 keeps every tuple on the ordinary function-call framing
    // (no select/goto special-casing), so each is exactly an 8-byte header the
    // classifier maps to a recognised semantic family.
    for &(module_id, opcode) in tuples {
        push_cmd(&mut out, 1, module_id, opcode);
    }

    push_meta_line(&mut out, 0); // final MetaLine terminator
    out
}

/// Append a `module_sel` select block (`0x23` header, `{`, options, `}`) using
/// the real select-block framing.
fn push_select_block(out: &mut Vec<u8>, options: &[&[u8]]) {
    push_cmd(out, 0, 2, 0); // module_type 0, module 2, opcode 0 => select
    out.push(b'{');
    for (i, opt) in options.iter().enumerate() {
        out.extend_from_slice(opt);
        // trailing `\n` + i16 line marker for this option
        push_meta_line(out, (i + 1) as u16);
    }
    out.push(b'}');
}

/// The `0x1d0`-byte scene header with the documented field offsets. Built by
/// hand exactly as the real encoder lays it out; both the kaifuu and utsushi
/// header decoders parse it.
fn build_scene_header(compiler_version: u32, uncompressed: u32, compressed: u32) -> Vec<u8> {
    let mut h = vec![0u8; kaifuu_reallive::SCENE_HEADER_BYTE_LEN];
    let put = |h: &mut [u8], off: usize, v: u32| h[off..off + 4].copy_from_slice(&v.to_le_bytes());
    put(&mut h, 0x00, kaifuu_reallive::SCENE_HEADER_BYTE_LEN as u32); // header_size
    put(&mut h, 0x04, compiler_version);
    put(&mut h, 0x08, kaifuu_reallive::SCENE_HEADER_BYTE_LEN as u32); // kidoku_offset
    put(&mut h, 0x0c, 0); // kidoku_count
    put(&mut h, 0x20, kaifuu_reallive::SCENE_HEADER_BYTE_LEN as u32); // bytecode_offset
    put(&mut h, 0x24, uncompressed);
    put(&mut h, 0x28, compressed);
    h
}

/// Assemble one scene payload (`header || avg32-compressed bytecode`) from a
/// plaintext (or already-`xor_2`-encrypted) decompressed bytecode.
fn build_scene_payload(compiler_version: u32, decompressed: &[u8]) -> Vec<u8> {
    let compressed =
        kaifuu_reallive::compress_avg32_literal(decompressed).expect("AVG32 re-compress");
    let header = build_scene_header(
        compiler_version,
        decompressed.len() as u32,
        compressed.len() as u32,
    );
    let mut payload = header;
    payload.extend_from_slice(&compressed);
    payload
}

/// Pack a set of `(slot_id, payload)` scenes into a real 10,000-slot `Seen.txt`
/// envelope.
fn pack_seen_txt(scenes: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let directory_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut directory = vec![0u8; directory_len];
    let mut body: Vec<u8> = Vec::new();
    for (slot_id, payload) in scenes {
        let offset = directory_len + body.len();
        let slot = (*slot_id as usize) * 8;
        directory[slot..slot + 4].copy_from_slice(&(offset as u32).to_le_bytes());
        directory[slot + 4..slot + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        body.extend_from_slice(payload);
    }
    let mut seen = directory;
    seen.extend_from_slice(&body);
    seen
}

struct SyntheticCorpus {
    label: &'static str,
    seen_bytes: Vec<u8>,
    /// Slot id of the feature-complete content scene.
    content_scene_id: u16,
    /// The plaintext content bytecode (post-`xor_2`-decrypt), for direct
    /// assertions.
    content_bytecode: Vec<u8>,
}

/// Build one synthetic RealLive corpus. `xor2` selects the encrypted-at-rest
/// (compiler 110002) variant; otherwise the plaintext (compiler 10002) variant.
fn build_corpus(label: &'static str, tuples: &[(u8, u16)], xor2: bool) -> SyntheticCorpus {
    let compiler_version = if xor2 { 110002 } else { 10002 };
    let content = build_content_bytecode(tuples);

    // The stored (decompressed-layer) bytecode: for xor2 scenes it is the
    // plaintext with the [256,513) segment encrypted by the planted key.
    let stored_content = if xor2 {
        let mut c = content.clone();
        stage_encrypt_xor2_segment(&mut c, &PLANTED_XOR2_KEY);
        c
    } else {
        content.clone()
    };

    let content_scene_id: u16 = 1000;
    let mut scenes: Vec<(u16, Vec<u8>)> = vec![(
        content_scene_id,
        build_scene_payload(compiler_version, &stored_content),
    )];

    // For the xor2 corpus, add a couple of pure-padding eligible filler scenes
    // so the cross-scene known-plaintext key recovery is over-determined.
    if xor2 {
        let mut pad = Vec::new();
        for _ in 0..220 {
            push_meta_line(&mut pad, 0);
        }
        for (n, slot) in [1001u16, 1002u16].into_iter().enumerate() {
            let mut stored = pad.clone();
            for _ in 0..(n * 4) {
                push_meta_line(&mut stored, 0);
            }
            stage_encrypt_xor2_segment(&mut stored, &PLANTED_XOR2_KEY);
            scenes.push((slot, build_scene_payload(compiler_version, &stored)));
        }
    }

    SyntheticCorpus {
        label,
        seen_bytes: pack_seen_txt(&scenes),
        content_scene_id,
        content_bytecode: content,
    }
}

/// Decompress + (for xor2) recover-and-decrypt every scene of a corpus,
/// returning `(scene_id, plaintext_bytecode)` pairs — exactly the staging the
/// real decoder-parity harness performs.
fn staged_scenes(corpus: &SyntheticCorpus) -> Vec<(u16, Vec<u8>)> {
    let mut decompressed =
        decompress_all_scenes(&corpus.seen_bytes).expect("decompress synthetic archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);
    if xor2
        .iter()
        .any(|s| compiler_version_uses_xor2(s.compiler_version))
    {
        assert!(
            report.validated,
            "[{}] xor_2 key recovery must validate on the synthetic encrypted corpus: {report:?}",
            corpus.label
        );
    }
    for (scene, decrypted) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = decrypted.bytecode;
    }
    decompressed
        .into_iter()
        .map(|s| (s.scene_id, s.bytecode))
        .collect()
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

/// The synthetic archives decode CLEAN (zero-unknown) through BOTH the kaifuu
/// decompiler and utsushi's independent decoder, and their framing round-trips
/// (`reemit == input`) — exactly as the real archives do — for both the
/// plaintext and the `xor_2`-encrypted corpus.
#[test]
fn synthetic_archives_decode_clean_and_frame_round_trip_through_real_pipeline() {
    let start = std::time::Instant::now();
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);

    for xor2 in [false, true] {
        let label = if xor2 {
            "corpus-xor2-110002"
        } else {
            "corpus-plaintext-10002"
        };
        let corpus = build_corpus(label, &tuples, xor2);
        let scenes = staged_scenes(&corpus);
        assert!(!scenes.is_empty(), "[{label}] archive must yield scenes");

        for (scene_id, bytecode) in &scenes {
            // kaifuu: decode with zero Unknown / zero un-catalogued Command.
            let opcodes = parse_real_bytecode(bytecode)
                .unwrap_or_else(|e| panic!("[{label}] scene {scene_id} kaifuu decode: {e}"));
            for op in &opcodes {
                assert!(
                    op.is_recognized(),
                    "[{label}] scene {scene_id} produced a non-recognised element {op:?} \
                     (zero-unknown bar)"
                );
            }
            // framing round-trip: re-emit == input, spans partition exactly.
            let _manifest_spans = framing_manifest(bytecode)
                .unwrap_or_else(|e| panic!("[{label}] scene {scene_id} framing manifest: {e}"));
            let reemitted = reemit_scene(bytecode)
                .unwrap_or_else(|e| panic!("[{label}] scene {scene_id} reemit: {e}"));
            assert_eq!(
                &reemitted, bytecode,
                "[{label}] scene {scene_id} re-emit must equal input byte-for-byte"
            );
            // utsushi: independent decoder reaches the same clean decode.
            decode_bytecode_stream(bytecode).unwrap_or_else(|e| {
                panic!("[{label}] scene {scene_id} utsushi decode parity failed: {e}")
            });
        }
    }

    // Multi-game validation: two distinct RealLive sub-corpora (the manifest's
    // decoder_parity_corpus group), one per cipher variant.
    let parity = reallive_group(&manifest, "decoder_parity_corpus")["components"]
        .as_array()
        .expect("decoder_parity_corpus components");
    assert_eq!(
        parity.len(),
        2,
        "manifest pins 2 RealLive parity corpora; the synthetic corpus mirrors both cipher variants"
    );

    eprintln!(
        "synthetic RealLive decode/frame round-trip (2 corpora) in {:?}",
        start.elapsed()
    );
}

/// The synthetic content scene instantiates 100% of the manifest's RealLive
/// `(module_id, opcode)` tuples, and every one decodes to a recognised family.
#[test]
fn synthetic_scene_instantiates_every_opcode_tuple() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let manifest_set: BTreeSet<(u8, u16)> = tuples.iter().copied().collect();
    assert_eq!(
        manifest_set.len(),
        289,
        "manifest enumerates 289 unique tuples"
    );

    let corpus = build_corpus("coverage", &tuples, false);
    let bytecode = &corpus.content_bytecode;

    // Extract the (module_id, opcode) of every command header in the scene by
    // walking the authoritative span decode (never a hand-maintained table).
    let spans = parse_real_bytecode_spans(bytecode).expect("content scene spans decode");
    let mut cursor = 0usize;
    let mut emitted: BTreeSet<(u8, u16)> = BTreeSet::new();
    for (_op, width) in &spans {
        if bytecode[cursor] == 0x23 {
            let module_id = bytecode[cursor + 2];
            let opcode = u16::from_le_bytes([bytecode[cursor + 3], bytecode[cursor + 4]]);
            emitted.insert((module_id, opcode));
        }
        cursor += width;
    }

    let missing: Vec<(u8, u16)> = manifest_set.difference(&emitted).copied().collect();
    assert!(
        missing.is_empty(),
        "synthetic scene is missing {} manifest tuples: {:?}",
        missing.len(),
        &missing[..missing.len().min(12)]
    );

    // And every command in the scene decodes to a recognised semantic family.
    let opcodes = parse_real_bytecode(bytecode).expect("decode");
    assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
}

/// Every RealLive `element_form` in the manifest appears in the synthetic
/// corpus — the 27 recognised forms in the clean content scene, plus the two
/// non-recognised tripwire forms (`Command`, `Unknown`) instantiated as
/// documented desync snippets (kept OUT of the clean scene so the zero-unknown
/// bar holds).
#[test]
fn synthetic_corpus_instantiates_every_element_form() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let corpus = build_corpus("elements", &tuples, false);

    let mut labels: BTreeSet<String> = BTreeSet::new();
    for op in parse_real_bytecode(&corpus.content_bytecode).expect("decode") {
        labels.insert(op.label().to_string());
    }

    // Documented corpus snippets add Expression + the two non-recognised
    // forms (generic `Command`, `Unknown` desync tripwire) through the same
    // real decoder, without perturbing the clean scene's zero-unknown bar.
    for snippet in decoder_snippets() {
        let (op, _) = kaifuu_decode_one(&snippet).expect("snippet decodes");
        labels.insert(op.label().to_string());
    }
    // The two tripwire forms are genuinely non-recognised (they must FAIL the
    // semantic-zero gate), proving the decoder still flags them.
    let (command_op, _) =
        kaifuu_decode_one(&[0x23, 1, 99, 0, 0, 0, 0, 0]).expect("generic command");
    assert!(matches!(command_op, RealLiveOpcode::Command { .. }));
    let (unknown_op, _) = kaifuu_decode_one(&[0x23, 14, 0, 0, 0, 0, 0, 0]).expect("desync marker");
    assert!(matches!(unknown_op, RealLiveOpcode::Unknown { .. }));

    // Manifest element forms are PascalCase; the decoder labels are snake_case.
    for form in manifest_string_list(&manifest, "element_form") {
        let snake = pascal_to_snake(&form);
        assert!(
            labels.contains(&snake),
            "element form {form} ({snake}) not instantiated; have {labels:?}"
        );
    }
}

/// Decode exactly one element via the real kaifuu decoder (thin wrapper so the
/// tripwire snippets go through the SAME decode path as the archives).
fn kaifuu_decode_one(bytes: &[u8]) -> Result<(RealLiveOpcode, usize), String> {
    let spans = parse_real_bytecode_spans(bytes).map_err(|e| e.to_string())?;
    let (op, width) = spans.into_iter().next().ok_or("no element")?;
    Ok((op, width))
}

/// Documented single-element corpus snippets that complete the element-form
/// and opener-marker coverage but are kept out of the archived clean scene:
/// the `0x24` Expression element (kaifuu taxonomy; utsushi's variant is
/// assignment-shaped), the generic un-catalogued `Command` (in-space module
/// no family covers), and the `Unknown` desync tripwire (`module_type > 2`).
/// Each decodes through the SAME real kaifuu decoder the archives use.
fn decoder_snippets() -> Vec<Vec<u8>> {
    vec![
        vec![0x24, 0xFF, 0x00, 0x00, 0x00, 0x00], // Expression ($ int-literal)
        vec![0x23, 1, 99, 0, 0, 0, 0, 0],         // generic Command (module 99)
        vec![0x23, 14, 0, 0, 0, 0, 0, 0],         // Unknown (module_type 14)
    ]
}

/// Every RealLive `expression_form` (ExpressionPiece node) is produced by the
/// REAL expression evaluator ([`parse_expression`] / the data-item grammar) on
/// synthetic operand bytes.
#[test]
fn synthetic_expressions_instantiate_every_expression_form() {
    let manifest = manifest_value();
    let mut forms: BTreeSet<String> = BTreeSet::new();

    // Crafted operand buffers exercising every node form through the REAL
    // evaluator. SpecialParam / bare-StrLiteral only occur as complex-parameter
    // ITEMS (rlvm `GetData`), so they are wrapped in a `( … )` group the
    // top-level `parse_expression` recurses into.
    let cases: &[&[u8]] = &[
        &[0xFF, 0x01, 0x00, 0x00, 0x00],                         // IntLiteral
        &[0xC8],                                                 // StoreRegister
        &[0x24, 0x62, 0x5B, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x5D], // $ bank [ lit ] => MemoryRef
        &[
            0xFF, 0x01, 0x00, 0x00, 0x00, 0x5C, 0x00, 0xFF, 0x02, 0x00, 0x00, 0x00,
        ], // Binary
        &[0x5C, 0x00, 0xFF, 0x01, 0x00, 0x00, 0x00],             // \op lit => Unary
        &[0x28, 0xFF, 0x01, 0x00, 0x00, 0x00, 0x29],             // ( lit ) => Complex
        &[
            0x28, 0x61, 0x05, 0x28, 0xFF, 0x01, 0x00, 0x00, 0x00, 0x29, 0x29,
        ], // ( 0x61 tag (…) ) => SpecialParam
        &[0x28, 0x41, 0x42, 0x29],                               // ( AB ) => StrLiteral item
    ];
    for case in cases {
        let (expr, _len) = parse_expression(case, 0).expect("expression parses");
        collect_expr_forms(&expr, &mut forms);
    }

    for form in manifest_string_list(&manifest, "expression_form") {
        let snake = pascal_to_snake(&form);
        assert!(
            forms.contains(&snake),
            "expression form {form} ({snake}) not instantiated; have {forms:?}"
        );
    }
}

fn collect_expr_forms(expr: &Expr, out: &mut BTreeSet<String>) {
    match expr {
        Expr::IntLiteral { .. } => {
            out.insert("int_literal".into());
        }
        Expr::StoreRegister => {
            out.insert("store_register".into());
        }
        Expr::MemoryRef { index, .. } => {
            out.insert("memory_ref".into());
            collect_expr_forms(index, out);
        }
        Expr::Binary { lhs, rhs, .. } => {
            out.insert("binary".into());
            collect_expr_forms(lhs, out);
            collect_expr_forms(rhs, out);
        }
        Expr::Unary { operand, .. } => {
            out.insert("unary".into());
            collect_expr_forms(operand, out);
        }
        Expr::Complex { items } => {
            out.insert("complex".into());
            for item in items {
                collect_expr_forms(item, out);
            }
        }
        Expr::SpecialParam { content, .. } => {
            out.insert("special_param".into());
            collect_expr_forms(content, out);
        }
        Expr::StrLiteral { .. } => {
            out.insert("str_literal".into());
        }
    }
}

/// Every `opener_marker` byte appears in the synthetic scene bytes.
#[test]
fn synthetic_scene_contains_every_opener_marker() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let corpus = build_corpus("openers", &tuples, false);
    let mut present: BTreeSet<u8> = corpus.content_bytecode.iter().copied().collect();
    // The 0x24 EXPRESSION opener is carried by the corpus Expression snippet.
    for snippet in decoder_snippets() {
        present.extend(snippet.iter().copied());
    }

    for marker in reallive_group(&manifest, "opener_marker")["components"]
        .as_array()
        .expect("opener_marker components")
    {
        let byte = marker["byte"].as_u64().expect("byte") as u8;
        let name = marker["name"].as_str().unwrap_or("");
        assert!(
            present.contains(&byte),
            "opener marker {name} ({byte:#04x}) not present in the synthetic scene"
        );
    }
}

/// Every `named_opcode` (the bridge/AST summary catalogue) is produced by the
/// REAL AST projection ([`parse_scene_into_ast`]) over the synthetic scene.
#[test]
fn synthetic_scene_instantiates_every_named_opcode() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let corpus = build_corpus("named", &tuples, false);

    let outcome = parse_scene_into_ast(&corpus.content_bytecode, corpus.content_scene_id, 0);
    let scene = outcome.scene.expect("AST scene present");
    let mut named: BTreeSet<String> = BTreeSet::new();
    for ins in &scene.instructions {
        if let kaifuu_reallive::InstructionKind::Named { opcode } = &ins.kind {
            named.insert(opcode.as_label().to_string());
        }
    }

    for form in manifest_string_list(&manifest, "named_opcode") {
        let snake = pascal_to_snake(&form);
        assert!(
            named.contains(&snake),
            "named opcode {form} ({snake}) not produced by the AST; have {named:?}"
        );
    }
}

/// Every `cipher_case` in the manifest is instantiated: the two archive cipher
/// variants (110002 xor2 + 10002 plaintext) exercise the pipeline, and the
/// second-level xor2/plaintext gate ([`compiler_version_uses_xor2`]) matches
/// the manifest for all four compiler-version cases.
#[test]
fn synthetic_corpus_instantiates_every_cipher_case() {
    let manifest = manifest_value();
    for case in reallive_group(&manifest, "cipher_case")["components"]
        .as_array()
        .expect("cipher_case components")
    {
        let version = case["compilerVersion"].as_u64().expect("compilerVersion") as u32;
        let expected = case["usesXor2"].as_bool().expect("usesXor2");
        assert_eq!(
            compiler_version_uses_xor2(version),
            expected,
            "cipher case for compiler_version {version} must match the manifest"
        );
    }
}

/// Choice + length-changing (and length-preserving) patchback round-trip
/// through the REAL bundle-driven patchback, on the synthetic plaintext
/// archive — decode/replay/patch CLEAN, exactly as the real archives.
#[test]
fn synthetic_archive_patchback_round_trips_choice_and_length_changing() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let corpus = build_corpus("patchback", &tuples, false);

    let scene_id = corpus.content_scene_id;
    let index = parse_archive(&corpus.seen_bytes).expect("synthetic archive parses");
    let entry = index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .expect("content scene present");
    let blob = corpus.seen_bytes
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize]
        .to_vec();

    let gameexe_inventory = parse_gameexe_inventory(&[]);
    let opts = BridgeOpts {
        game_id: "synthetic-reallive",
        game_version: "0.0.0",
        source_profile_id: "synthetic-reallive",
        source_locale: "en-US",
        extractor_name: "synthetic-corpus-author",
        extractor_version: "0.1.0",
        scene_kidoku_count: 0,
    };
    let produced = produce_bundle(
        scene_id,
        &blob,
        &corpus.content_bytecode,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle builds from the synthetic scene");

    let choice_keys: Vec<String> = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "choice_label")
        .map(|u| u.source_unit_key.clone())
        .collect();
    assert_eq!(
        choice_keys.len(),
        2,
        "synthetic scene must surface exactly two choice_label options"
    );
    let dialogue_keys: Vec<String> = produced
        .bundle
        .units
        .iter()
        .filter(|u| u.surface_kind == "dialogue")
        .map(|u| u.source_unit_key.clone())
        .collect();
    assert!(
        !dialogue_keys.is_empty(),
        "synthetic scene must surface dialogue"
    );

    // Length-CHANGING dialogue + NextString-hostile choices (contain `[`, `(`,
    // `)`, `!`, `,`, `-`, `.` — all outside the unquoted NextString set, so a
    // naive splice would corrupt the select block; the real encoder quotes it).
    let long_dialogue =
        "[EN] A deliberately much longer localized dialogue line (grows the scene!)";
    let tricky_choice_0 = "[EN] Go left, into the (bright) hall!";
    let tricky_choice_1 = "[EN] Wait - not yet, hold on...";
    let choice_targets = [tricky_choice_0, tricky_choice_1];

    let mut bundle_value = produced.json.clone();
    {
        let units = bundle_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let key = unit["sourceUnitKey"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let text = if let Some(idx) = choice_keys.iter().position(|k| *k == key) {
                choice_targets[idx].to_string()
            } else {
                long_dialogue.to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&bundle_value).expect("translated bundle parses");

    let patched = apply_translated_bundle(
        &corpus.seen_bytes,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
    )
    .expect("dialogue+choices patch must succeed on the synthetic archive");

    // The patched archive re-parses and the patched scene re-decodes CLEAN.
    let reindex = parse_archive(&patched).expect("patched archive re-parses");
    assert_eq!(reindex.entries.len(), index.entries.len());
    let new_entry = reindex
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .expect("patched content scene present");
    let new_blob = &patched[new_entry.byte_offset as usize
        ..(new_entry.byte_offset + u64::from(new_entry.byte_len)) as usize];
    let new_header = SceneHeader::parse(new_blob).expect("patched header parses");
    let new_compressed = &new_blob[new_header.bytecode_offset as usize
        ..(new_header.bytecode_offset + new_header.bytecode_compressed_size) as usize];
    let new_bytecode = kaifuu_reallive::decompress_avg32(
        new_compressed,
        new_header.bytecode_uncompressed_size as usize,
    )
    .expect("patched scene decompresses");
    let patched_ops = parse_real_bytecode(&new_bytecode)
        .expect("patched scene re-decodes CLEAN (framing intact)");
    assert!(
        patched_ops.iter().all(RealLiveOpcode::is_recognized),
        "patched scene must have zero unknown / generic opcodes"
    );

    // The `{ … }` select block survives with both options re-inserted as the
    // NextString-safe encodings of the tricky translations.
    let patched_choices: &Vec<CommandArg> = patched_ops
        .iter()
        .find_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices),
            _ => None,
        })
        .expect("patched scene still carries the select block");
    assert_eq!(patched_choices.len(), 2, "both choice options survive");
    for (i, target) in choice_targets.iter().enumerate() {
        let expected =
            encode_choice_option_next_string_safe(target).expect("choice encodes NextString-safe");
        assert_eq!(
            patched_choices[i].bytes, expected,
            "option {i} must be the NextString-safe quoted encoding of the translation"
        );
        assert!(
            decode_dialogue_textout(&patched_choices[i].bytes).is_some(),
            "option {i} decodes cleanly as a translatable run"
        );
    }

    // Length-CHANGING: the patched bytecode grew (longer dialogue + choices).
    assert!(
        new_bytecode.len() > corpus.content_bytecode.len(),
        "length-changing patch must grow the scene ({} -> {})",
        corpus.content_bytecode.len(),
        new_bytecode.len()
    );

    // Length-PRESERVING: an identity re-translation of the dialogue (under
    // dialogue-only scope, so the choices are carried byte-identical rather
    // than re-quoted) reproduces the source bytecode byte-for-byte (no drift).
    let mut identity_value = produced.json.clone();
    {
        let units = identity_value["units"].as_array_mut().expect("units array");
        for unit in units.iter_mut() {
            let src = unit["sourceText"].as_str().unwrap_or_default().to_string();
            unit["target"] = serde_json::json!({"locale": "en-US", "text": src});
        }
    }
    let identity = TranslatedBundleV02::from_json(&identity_value).expect("identity bundle parses");
    let identity_patched = apply_translated_bundle(
        &corpus.seen_bytes,
        &identity,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .expect("identity patch must succeed");
    let id_index = parse_archive(&identity_patched).expect("identity archive parses");
    let id_entry = id_index
        .entries
        .iter()
        .find(|e| e.scene_id == scene_id)
        .unwrap();
    let id_blob = &identity_patched[id_entry.byte_offset as usize
        ..(id_entry.byte_offset + u64::from(id_entry.byte_len)) as usize];
    let id_header = SceneHeader::parse(id_blob).unwrap();
    let id_compressed = &id_blob[id_header.bytecode_offset as usize
        ..(id_header.bytecode_offset + id_header.bytecode_compressed_size) as usize];
    let id_bytecode = kaifuu_reallive::decompress_avg32(
        id_compressed,
        id_header.bytecode_uncompressed_size as usize,
    )
    .unwrap();
    assert_eq!(
        id_bytecode, corpus.content_bytecode,
        "length-preserving identity patch must reproduce the source bytecode byte-for-byte"
    );
}

/// Confirm the synthetic archives carry NO copyrighted bytes: every scene body
/// is either ASCII synthetic English or documented structural framing.
#[test]
fn synthetic_archives_carry_no_copyrighted_bytes() {
    let manifest = manifest_value();
    let tuples = manifest_tuples(&manifest);
    let corpus = build_corpus("no-copyright", &tuples, false);
    // The only text runs are the authored ASCII lines.
    let opcodes = parse_real_bytecode(&corpus.content_bytecode).expect("decode");
    for op in &opcodes {
        if let RealLiveOpcode::Textout { raw_bytes, .. } = op {
            assert!(
                raw_bytes.iter().all(u8::is_ascii),
                "every synthetic Textout run must be ASCII synthetic English"
            );
        }
    }
}

/// Every `g00_type` in the manifest is instantiated: the RAW_BGR (type 0),
/// PALETTED_LZSS (type 1) and REGIONED_LZSS (type 2) synthetic images all
/// decode through the REAL `decode_g00` to exactly their declared type. The
/// type-1 paletted-LZSS fixture was added by
/// `synthetic-fixture-differential-validation` to close a real-only decode gap
/// the mutation harness surfaced (a paletted-decode mutation previously escaped
/// the synthetic suite because no synthetic paletted fixture existed).
#[test]
fn synthetic_g00_images_instantiate_every_g00_type() {
    let manifest = manifest_value();

    // Type 0, type 1 and type 2 all decode through the REAL decoder to their
    // declared type — no constant-identity fallback.
    let (t0, _) = decode_g00(&g00_synthetic::synthetic_type0_g00())
        .expect("synthetic type-0 G00 decodes through decode_g00");
    assert_eq!(t0.g00_type, G00Type::RawBgr);
    let (t1, _) = decode_g00(&g00_synthetic::synthetic_type1_g00())
        .expect("synthetic type-1 (paletted LZSS) G00 decodes through decode_g00");
    assert_eq!(t1.g00_type, G00Type::PalettedLzss);
    // The paletted decode actually ran: the first pixel is palette entry 0,
    // whose on-disk BGRA (0x11,0x22,0x33,0xff) reorders to RGBA
    // (0x33,0x22,0x11,0xff). A skipped B/R reorder or a broken paletted decode
    // changes these bytes, so a mutation there is now caught.
    assert!(
        t1.pixels_rgba.len() >= 4,
        "type-1 fixture must decode at least one pixel"
    );
    assert_eq!(
        &t1.pixels_rgba[0..4],
        &[0x33, 0x22, 0x11, 0xff],
        "type-1 first pixel must be palette entry 0 reordered BGRA->RGBA"
    );
    let (t2, _) = decode_g00(&g00_synthetic::synthetic_type2_g00())
        .expect("synthetic type-2 G00 decodes through decode_g00");
    assert_eq!(t2.g00_type, G00Type::RegionedLzss);

    let mut covered_type_bytes: BTreeSet<u8> = BTreeSet::new();
    covered_type_bytes.insert(t0.g00_type.lead_byte());
    covered_type_bytes.insert(t1.g00_type.lead_byte());
    covered_type_bytes.insert(t2.g00_type.lead_byte());
    // Redundant source-of-truth constant identity for type 1 (now also
    // exercised by the real decode above).
    covered_type_bytes.insert(G00_TYPE_PALETTED_LZSS);

    for component in reallive_group(&manifest, "g00_type")["components"]
        .as_array()
        .expect("g00_type components")
    {
        let type_byte = component["typeByte"].as_u64().expect("typeByte") as u8;
        let name = component["name"].as_str().unwrap_or("");
        assert!(
            covered_type_bytes.contains(&type_byte),
            "g00 type {name} (typeByte {type_byte}) not instantiated"
        );
    }
}

/// Convert a manifest PascalCase form name to the decoder's snake_case label.
fn pascal_to_snake(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}
