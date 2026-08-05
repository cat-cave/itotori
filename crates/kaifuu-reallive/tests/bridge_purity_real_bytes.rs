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
//!   `private inventory row` (Sweetie HD) and `private inventory row`
//!   (Kanon). Without them an absent corpus is an unconditional HARD FAILURE
//!   (no opt-out). These feature-gated suites run only in the periodic
//!   ground-truth oracle (`just test real-bytes-oracle`), where corpora are staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use kaifuu_reallive::{
    BridgeOpts, BridgeProduceError, RealLiveOpcode, SceneHeader, Xor2DecScene,
    decode_dialogue_textout, decompress_avg32, gameexe::parse_gameexe_inventory, parse_archive,
    parse_real_bytecode, parse_scene_override_file_name, produce_bundle,
    recover_and_decrypt_archive,
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
    /// Exact `22 22` Textout bodies. These are syntax-only quote pairs, so
    /// their rendered body is empty rather than mojibake.
    empty_quoted_bodies_dropped: usize,
    /// One raw-byte sample from the exact empty-body population. Kept as bytes
    /// in the report so a diagnostic cannot mistake syntax for decoded text.
    empty_quoted_body_sample: Option<[u8; 2]>,
    /// Non-empty raw runs that decode cleanly as Shift-JIS but do not pass the
    /// visible-dialogue predicate. This is intentionally distinct from an
    /// empty quoted body and from an undecodable binary run.
    clean_decode_non_dialogue_runs_dropped: usize,
    /// Archive-only count of exact empty quoted bodies. Comparing it with the
    /// effective count makes standalone-scene replacement visible in the
    /// report instead of silently mixing two byte sets.
    archive_empty_quoted_bodies: usize,
    scene_overrides: usize,
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

/// Read format-defined standalone scene replacements next to the archive.
/// The bridge must inspect these effective scene bytes, not the archive's
/// replaced slot, because the runtime does the same.
fn scene_overrides(seen_txt: &Path) -> BTreeMap<u16, Vec<u8>> {
    let Some(data_dir) = seen_txt.parent() else {
        return BTreeMap::new();
    };
    fs::read_dir(data_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let scene_id = parse_scene_override_file_name(path.file_name()?.to_str()?)?;
            Some((scene_id, fs::read(path).ok()?))
        })
        .collect()
}

fn count_empty_quoted_bodies(scenes: &[Xor2DecScene]) -> usize {
    scenes
        .iter()
        .filter_map(|scene| parse_real_bytecode(&scene.bytecode).ok())
        .flatten()
        .filter(|opcode| {
            matches!(
                opcode,
                RealLiveOpcode::Textout { raw_bytes, .. } if raw_bytes == b"\"\""
            )
        })
        .count()
}

fn purity_for_corpus(corpus: &RealCorpus) -> PurityReport {
    let bytes = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|err| panic!("read {}: {err}", corpus.seen_txt.display()));
    let index = parse_archive(&bytes)
        .unwrap_or_else(|diag| panic!("[{}] SEEN archive must parse: {diag:?}", corpus.label));
    let gameexe_bytes = read_gameexe(&corpus.seen_txt);
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let overrides = scene_overrides(&corpus.seen_txt);

    // Stage 1: envelope -> header -> AVG32 decompress. Keep both the archive
    // slots and the runtime's effective replacement slots: the former explains
    // an archive/effective count delta, while only the latter reaches bridge
    // production.
    let mut archive_scenes: Vec<Xor2DecScene> = Vec::new();
    let mut scenes: Vec<Xor2DecScene> = Vec::new();
    let mut metas: Vec<SceneMeta> = Vec::new();
    for entry in &index.entries {
        let off = entry.byte_offset as usize;
        let end = off + entry.byte_len as usize;
        if end > bytes.len() {
            continue;
        }
        let archive_blob = &bytes[off..end];
        let blob = overrides
            .get(&entry.scene_id)
            .map_or(archive_blob, Vec::as_slice);
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
        let Ok(archive_header) = SceneHeader::parse(archive_blob) else {
            continue;
        };
        let archive_bo = archive_header.bytecode_offset as usize;
        let archive_bc = archive_header.bytecode_compressed_size as usize;
        let archive_bu = archive_header.bytecode_uncompressed_size as usize;
        if archive_bo + archive_bc > archive_blob.len() {
            continue;
        }
        let Ok(archive_decompressed) = decompress_avg32(
            &archive_blob[archive_bo..archive_bo + archive_bc],
            archive_bu,
        ) else {
            continue;
        };
        archive_scenes.push(Xor2DecScene {
            compiler_version: archive_header.compiler_version,
            bytecode: archive_decompressed,
        });
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

    // Stage 2: archive-wide second-level xor_2 recovery. Apply it to each
    // comparison set before counting, so both sides have the same decode stage.
    let _ = recover_and_decrypt_archive(&mut archive_scenes);
    let _ = recover_and_decrypt_archive(&mut scenes);

    let mut report = PurityReport {
        label: corpus.label,
        populated_scenes: index.entries.len(),
        scenes_with_units: 0,
        total_units: 0,
        non_dialogue_units: 0,
        empty_quoted_bodies_dropped: 0,
        empty_quoted_body_sample: None,
        clean_decode_non_dialogue_runs_dropped: 0,
        archive_empty_quoted_bodies: count_empty_quoted_bodies(&archive_scenes),
        scene_overrides: overrides.len(),
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
        // Classify dropped Textout runs by the visible-text reason. In
        // particular, `22 22` is quote syntax whose rendered body is empty;
        // it is not a decoded garbage string.
        if let Ok(opcodes) = parse_real_bytecode(&scene.bytecode) {
            for op in &opcodes {
                if let RealLiveOpcode::Textout { raw_bytes, .. } = op {
                    if raw_bytes.is_empty() {
                        continue;
                    }
                    if raw_bytes == b"\"\"" {
                        report.empty_quoted_bodies_dropped += 1;
                        report
                            .empty_quoted_body_sample
                            .get_or_insert([raw_bytes[0], raw_bytes[1]]);
                    } else if decode_dialogue_textout(raw_bytes).is_some() {
                        report.dialogue_runs_surfaced += 1;
                    } else {
                        let (_decoded, _encoding, had_errors) =
                            encoding_rs::SHIFT_JIS.decode(raw_bytes);
                        if !had_errors {
                            report.clean_decode_non_dialogue_runs_dropped += 1;
                        }
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
    let raw_sample = report.empty_quoted_body_sample.map_or_else(
        || "none".to_string(),
        |[first, second]| format!("{first:02x} {second:02x}"),
    );
    eprintln!(
        "[{}] PURITY: populated_scenes={} scenes_with_units={} total_units={} \
         non_dialogue_units={} | dialogue_runs_surfaced={} empty_quoted_bodies_dropped={} \
         clean_decode_non_dialogue_runs_dropped={} archive_empty_quoted_bodies={} \
         scene_overrides={} raw_empty_quote_sample=[{}]",
        report.label,
        report.populated_scenes,
        report.scenes_with_units,
        report.total_units,
        report.non_dialogue_units,
        report.dialogue_runs_surfaced,
        report.empty_quoted_bodies_dropped,
        report.clean_decode_non_dialogue_runs_dropped,
        report.archive_empty_quoted_bodies,
        report.scene_overrides,
        raw_sample,
    );
}

#[test]
fn bridge_bundles_carry_zero_non_dialogue_units_on_both_corpora_real_bytes() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "bridge_bundles_carry_zero_non_dialogue_units_on_both_corpora_real_bytes \
             (set reallive/1/encrypted and reallive/2/plain)",
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
        // A no-unit corpus is legitimate only with direct byte evidence that
        // its effective Textouts are empty quoted bodies. Conversely, when the
        // classifier finds dialogue, a zero-unit bridge is always a defect.
        if report.dialogue_runs_surfaced > 0 {
            assert!(
                report.total_units > 0,
                "[{}] classified {} dialogue Textout run(s) but produced no translatable units",
                report.label,
                report.dialogue_runs_surfaced,
            );
        } else if report.total_units == 0 {
            assert!(
                report.empty_quoted_bodies_dropped > 0,
                "[{}] produced no units and no dialogue, but has no exact empty-quoted Textout evidence",
                report.label
            );
            assert_eq!(
                report.empty_quoted_body_sample,
                Some([0x22, 0x22]),
                "[{}] empty-body accounting must retain the raw quote-pair bytes",
                report.label
            );
        }
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
        real_corpus::SECONDARY,
    );
}
