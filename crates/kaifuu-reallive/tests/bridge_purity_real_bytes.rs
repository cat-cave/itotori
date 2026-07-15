//! Real-bytes BridgeBundle **purity** gate (`reallive-bridge-no-binary-
//! textout-as-dialogue`).
//! The decompiler types every command tuple to a semantic `RealLiveOpcode`
//! family, and the bridge now derives translatability from that TYPED
//! operation: only a `Textout` run that decodes as readable Shift-JIS
//! dialogue (`decode_dialogue_textout` — valid decode AND no control bytes)
//! or a `Choice` option becomes a translatable unit. The old valid-decode
//! gate let a low-byte binary block that decodes cleanly into C0 control
//! characters masquerade as dialogue, and a kidoku-table marker could land on
//! such a bogus unit.
//! This test produces the v0.2 BridgeBundle for **every populated scene of
//! BOTH staged corpora** (Sweetie HD and Kanon; Sweetie HD is first decrypted
//! by the in-process second-level `xor_2` decryptor, exactly as the
//! multi-game decompiler harness does) and asserts a single hard invariant on
//! every emitted unit's `sourceText`:
//! - it carries **no control bytes** (`char::is_control`) and **no `U+FFFD`
//!   replacement character** — i.e. it is real text, never a binary /
//!   control-char run; and
//! - after removing any `reallive.kidoku` control-marker span it is still
//!   non-empty — i.e. no unit's `sourceText` is merely a kidoku-table marker.
//!   Per the data rule, the test asserts only on byte-category invariants and
//!   reports counts / categories — never decoded dialogue strings.
//!   Env-gated like the rest of the real-bytes suite and STRICT: needs
//!   `ITOTORI_REAL_GAME_ROOT` (Sweetie HD) and `ITOTORI_REAL_GAME_ROOT_2`
//!   (Kanon). Without them an absent corpus is an unconditional HARD FAILURE
//!   (no opt-out). These `#[ignore]`-d suites run only in the periodic
//!   ground-truth oracle (`just real-bytes-oracle`), where corpora are staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::Path;

use kaifuu_reallive::{
    BridgeOpts, BridgeProduceError, RealLiveOpcode, SceneHeader, Xor2DecScene,
    decode_dialogue_textout, decompress_avg32, gameexe::parse_gameexe_inventory, parse_archive,
    parse_real_bytecode, produce_bundle, recover_and_decrypt_archive,
};

use real_corpus::RealCorpus;

/// Per-scene metadata carried alongside the decrypted bytecode so a bundle
/// can be produced after the archive-wide `xor_2` recovery step.
struct SceneMeta {
    scene_id: u16,
    scene_blob: Vec<u8>,
    kidoku_count: u32,
}

/// Sanitized purity outcome for one corpus. Counts / categories only.
struct PurityReport {
    label: &'static str,
    populated_scenes: usize,
    scenes_with_units: usize,
    total_units: usize,
    /// Units whose `sourceText` carries a control byte / `U+FFFD` / is merely
    /// a kidoku marker. The gate's bar is ZERO.
    non_dialogue_units: usize,
    /// Textout runs that the OLD valid-decode-only gate would have surfaced
    /// (zero decode errors) but the NEW gate drops because they carry control
    /// bytes — the mojibake units this node removes.
    mojibake_runs_dropped: usize,
    /// Total Textout runs the NEW gate surfaces as dialogue (no false
    /// negatives: real dialogue retained).
    dialogue_runs_surfaced: usize,
}

/// `true` if `s` contains a control character or a replacement character —
/// the byte-category invariant that defines a non-dialogue / binary run.
fn has_non_text_bytes(s: &str) -> bool {
    s.chars().any(|c| c.is_control() || c == '\u{FFFD}')
}

/// Best-effort locate a `Gameexe.ini` for NAMAE resolution next to the SEEN
/// archive (case-insensitive). NAMAE resolution is not required for the
/// purity invariant, so an absent file yields an empty inventory.
fn read_gameexe(seen_txt: &Path) -> Vec<u8> {
    let Some(dir) = seen_txt.parent() else {
        return Vec::new();
    };
    let found = fs::read_dir(dir).ok().and_then(|entries| {
        entries.flatten().find_map(|entry| {
            let path = entry.path();
            let is_gameexe = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("Gameexe.ini"));
            (is_gameexe && path.is_file()).then_some(path)
        })
    });
    found
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default()
}

fn purity_for_corpus(corpus: &RealCorpus) -> PurityReport {
    let bytes = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|err| panic!("read {}: {err}", corpus.seen_txt.display()));
    let index = parse_archive(&bytes)
        .unwrap_or_else(|diag| panic!("[{}] SEEN archive must parse: {diag:?}", corpus.label));
    let gameexe_bytes = read_gameexe(&corpus.seen_txt);
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);

    // Stage 1: envelope -> header -> AVG32 decompress, keeping per-scene
    // metadata in lockstep so a bundle can be produced post-xor_2.
    let mut scenes: Vec<Xor2DecScene> = Vec::new();
    let mut metas: Vec<SceneMeta> = Vec::new();
    for entry in &index.entries {
        let off = entry.byte_offset as usize;
        let end = off + entry.byte_len as usize;
        if end > bytes.len() {
            continue;
        }
        let blob = &bytes[off..end];
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
        metas.push(SceneMeta {
            scene_id: entry.scene_id,
            scene_blob: blob.to_vec(),
            kidoku_count: header.kidoku_count,
        });
    }

    // Stage 2: archive-wide second-level xor_2 recovery (Sweetie HD only;
    // Kanon's compiler version leaves every scene untouched).
    let _ = recover_and_decrypt_archive(&mut scenes);

    let mut report = PurityReport {
        label: corpus.label,
        populated_scenes: index.entries.len(),
        scenes_with_units: 0,
        total_units: 0,
        non_dialogue_units: 0,
        mojibake_runs_dropped: 0,
        dialogue_runs_surfaced: 0,
    };

    // Stage 3: produce a bundle per scene and scan every emitted unit.
    let opts_for = |kidoku_count: u32| BridgeOpts {
        game_id: "purity-corpus",
        game_version: "real",
        source_profile_id: "kaifuu-reallive-purity",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: kidoku_count,
    };

    for (scene, meta) in scenes.iter().zip(metas.iter()) {
        // Before/after accounting: classify each Textout run by the OLD gate
        // (valid Shift-JIS decode, zero replacement errors) vs the NEW gate
        // (also no control bytes). A run the old gate accepted but the new
        // one drops is a mojibake unit this node removes.
        if let Ok(opcodes) = parse_real_bytecode(&scene.bytecode) {
            for op in &opcodes {
                if let RealLiveOpcode::Textout { raw_bytes, .. } = op {
                    if raw_bytes.is_empty() {
                        continue;
                    }
                    let (_d, _e, had_errors) = encoding_rs::SHIFT_JIS.decode(raw_bytes);
                    let old_gate = !had_errors;
                    let new_gate = decode_dialogue_textout(raw_bytes).is_some();
                    if new_gate {
                        report.dialogue_runs_surfaced += 1;
                    } else if old_gate {
                        report.mojibake_runs_dropped += 1;
                    }
                }
            }
        }

        let produced = match produce_bundle(
            meta.scene_id,
            &meta.scene_blob,
            &scene.bytecode,
            &gameexe_inventory,
            &opts_for(meta.kidoku_count),
        ) {
            Ok(produced) => produced,
            // A scene with no dialogue/choice surface legitimately produces
            // no bundle — that is not impurity.
            Err(BridgeProduceError::NoTextUnits { .. } | BridgeProduceError::EmptyScene { .. }) => {
                continue;
            }
            Err(other) => panic!(
                "[{}] scene {} produced an unexpected bundle error: {other:?}",
                corpus.label, meta.scene_id
            ),
        };

        report.scenes_with_units += 1;
        let units = produced.json["units"]
            .as_array()
            .expect("bundle units must be an array");
        for unit in units {
            report.total_units += 1;
            let source_text = unit["sourceText"]
                .as_str()
                .expect("every unit must carry a string sourceText");

            // Invariant 1: no control / replacement bytes anywhere in the
            // surfaced text.
            let mut impure = has_non_text_bytes(source_text);

            // Invariant 2: stripping any reallive.kidoku marker span must
            // leave real text behind — no unit may be merely a kidoku-table
            // marker.
            let mut kept = source_text.as_bytes().to_vec();
            if let Some(spans) = unit["spans"].as_array() {
                for span in spans {
                    if span["parsedName"].as_str() == Some("reallive.kidoku") {
                        let start = span["startByte"].as_u64().unwrap_or(0) as usize;
                        let end = span["endByte"].as_u64().unwrap_or(0) as usize;
                        for b in kept.iter_mut().take(end.min(source_text.len())).skip(start) {
                            *b = b' ';
                        }
                    }
                }
            }
            let remainder = String::from_utf8_lossy(&kept);
            if remainder.trim().is_empty() {
                impure = true;
            }

            if impure {
                report.non_dialogue_units += 1;
                // Byte-category diagnostics only (no decoded dialogue): how
                // many control / replacement code points the offending unit
                // carries and whether it collapses to a bare kidoku marker.
                let fffd = source_text.chars().filter(|&c| c == '\u{FFFD}').count();
                let ctrl = source_text.chars().filter(|c| c.is_control()).count();
                eprintln!(
                    "[{}] IMPURE unit scene {}: kind={:?} chars={} fffd={} ctrl={} kidoku_empty={}",
                    corpus.label,
                    meta.scene_id,
                    unit["surfaceKind"].as_str().unwrap_or("?"),
                    source_text.chars().count(),
                    fffd,
                    ctrl,
                    remainder.trim().is_empty(),
                );
            }
        }
    }

    report
}

fn print_report(report: &PurityReport) {
    eprintln!(
        "[{}] PURITY: populated_scenes={} scenes_with_units={} total_units={} \
         non_dialogue_units={} | dialogue_runs_surfaced={} mojibake_runs_dropped={} \
         (before={} after={})",
        report.label,
        report.populated_scenes,
        report.scenes_with_units,
        report.total_units,
        report.non_dialogue_units,
        report.dialogue_runs_surfaced,
        report.mojibake_runs_dropped,
        report.dialogue_runs_surfaced + report.mojibake_runs_dropped,
        report.dialogue_runs_surfaced,
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2 for multi-game)"]
fn bridge_bundles_carry_zero_non_dialogue_units_on_both_corpora_real_bytes() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "bridge_bundles_carry_zero_non_dialogue_units_on_both_corpora_real_bytes \
             (set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    }

    let reports: Vec<PurityReport> = corpora.iter().map(purity_for_corpus).collect();
    for report in &reports {
        print_report(report);

        assert!(
            report.populated_scenes > 0,
            "[{}] SEEN archive parsed but has zero populated scenes",
            report.label
        );
        // The producer must actually engage real dialogue on each corpus —
        // otherwise a zero-unit run could vacuously pass the purity gate.
        assert!(
            report.total_units > 0,
            "[{}] no translatable unit was produced across the whole archive",
            report.label
        );
        // THE GATE: not one emitted unit may be a binary / control-char run
        // or a bare kidoku-table marker.
        assert_eq!(
            report.non_dialogue_units, 0,
            "[{}] {} emitted unit(s) carry non-dialogue bytes (control / U+FFFD / kidoku-only); \
             the bar is ZERO",
            report.label, report.non_dialogue_units
        );
    }

    // Multi-game-validation: the purity gate must hold on >= 2 distinct
    // RealLive titles. Real-bytes coverage is unconditionally required, so a
    // single resolved corpus is always a hard failure.
    assert!(
        reports.len() >= 2,
        "multi-game validation requires >= 2 distinct RealLive corpora, but only \
         {} resolved; stage the second corpus or set {}",
        reports.len(),
        real_corpus::REAL_GAME_ROOT_2_ENV,
    );
}
