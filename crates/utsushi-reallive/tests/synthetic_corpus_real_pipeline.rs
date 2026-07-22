//! `synthetic-fixture-author-feature-complete-archives` (P2) — RealLive.
//!
//! Authors MINIMAL, feature-complete SYNTHETIC RealLive archives that
//! instantiate every component of the RealLive engine family in the coverage
//! manifest (`fixtures/synthetic/coverage-manifest.v0.json`) EXACTLY ONCE
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
//! - the real AVG32 re-compressor ([`kaifuu_reallive::compress_avg32_literal`])
//! - the documented `0x1d0`-byte [`kaifuu_reallive::SceneHeader`] framing and
//!   the 10,000-slot `Seen.txt` envelope ([`kaifuu_reallive::parse_archive`])
//! - the real `xor_2` second-level segment transform (recovered + decrypted by
//!   [`kaifuu_reallive::recover_and_decrypt_archive`])
//! - the real `module_sel` select-block framing + the NextString-safe choice
//!   encoder ([`kaifuu_reallive::encode_choice_option_next_string_safe`])
//! - the real bundle-driven patchback
//!   ([`kaifuu_reallive::apply_translated_bundle`])
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

#[path = "synthetic_corpus_real_pipeline/corpus.rs"]
mod corpus;
#[path = "synthetic_corpus_real_pipeline/patchback.rs"]
mod patchback;

use corpus::*;

// Tests.

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
    patchback::round_trip_choice_and_length_changing();
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

/// Every `g00_type` in the manifest is instantiated: the RAW_BGR (type 0)
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
    // The paletted decode actually ran: the first pixel is palette entry 0
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
