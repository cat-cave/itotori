//! Two-corpus validation of RealLive protected-span extraction.
//! The bridge protected-span scanner (`bridge.rs::collect_units` + the RLDEV
//! control-byte catalogue in `protected_spans.rs`) feeds the pilot's
//! deterministic strip/re-inject (patchback-safety): every span it emits is a
//! `preserveMode=exact` region the translate+patchback pass must NOT rewrite.
//! # Rule provenance
//! RealLive engine surfaces:
//! - `reallive.kidoku` — read-tracking markers. Sourced from the `MetaKidoku`
//!   (`0x40`) opcode AND synthesised from the scene header's `kidoku_count`.
//! - NAMAE speaker resolution via the `Gameexe.ini` `#NAMAE` table — an
//!   engine-wide Gameexe family.
//! - Inline `【話者】` names and the `#FACE`/`#GANBMP`/font-tone tag vocabulary.
//!   RLDEV's `lib/textout.kh`, cited by rlvm's
//!   `src/doc/notes/NamesAndIndentation.txt`, defines lenticular-name textout
//!   markup; a corpus may simply not author an optional grammar construct.
//! - The RLDEV control-byte catalogue (`detect_protected_spans`): colour
//!   (`0x1f`), ruby (`0x0d/0x0a/0x09`), choice token (`0x02`), text size
//!   (`0x1e`), wait (`0x10`), clear (`0x0c`), line break (`0x0a`), the
//!   `\{<digits>\}` name placeholder and the `\\<ident>` variable
//!   placeholder — all derived from Haeleth's public RLDEV documentation.
//!   Structurally engine-general; over READABLE dialogue runs it emits no
//!   control-byte spans (the dialogue gate excludes `< 0x20` bytes) and, on
//!   both corpora, ZERO unknown-control warnings and ZERO decode errors.
//! - `reallive.choice_marker` — the `0x30..0x33` ASCII-digit heuristic. Not an
//!   RLDEV-documented marker; emits ZERO spans on BOTH real corpora.
//!   Data rule: span TYPE counts / categories only — never decoded copyrighted
//!   dialogue text.
//!   Env-gated + STRICT like the rest of the real-bytes suite. Runs only in the
//!   periodic ground-truth oracle (`just real-bytes-oracle`) where both corpora
//!   are staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use kaifuu_reallive::{
    BridgeOpts, BridgeProduceError, ProtectedSpanKind, RealLiveOpcode, SceneHeader, Xor2DecScene,
    decode_dialogue_textout, decompress_avg32, detect_protected_spans,
    gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode, produce_bundle,
    recover_and_decrypt_archive,
};

use real_corpus::RealCorpus;

/// The engine-wide read-tracking span must fire on every populated corpus.
const GENERAL_BRIDGE_SPAN_KINDS: &[&str] = &["reallive.kidoku"];

/// Optional grammar and heuristic spans are reported, not required per corpus.
const OPTIONAL_BRIDGE_SPAN_KINDS: &[&str] = &[
    "reallive.name_token",
    "reallive.asset_ref",
    "reallive.font_tone",
    "reallive.choice_marker",
];

/// Per-scene metadata carried alongside the decrypted bytecode so a bundle can
/// be produced after the archive-wide `xor_2` recovery step.
struct SceneMeta {
    scene_id: u16,
    scene_blob: Vec<u8>,
    kidoku_count: u32,
}

/// Sanitized protected-span coverage for one corpus. Counts / categories only.
struct SpanReport {
    label: &'static str,
    populated_scenes: usize,
    scenes_with_units: usize,
    total_units: usize,
    /// Bridge-emitted span `parsedName` -> occurrence count across the whole
    /// archive (`reallive.kidoku`, `reallive.name_token`, `reallive.asset_ref`,
    /// `reallive.font_tone`, `reallive.choice_marker`).
    bridge_span_kinds: BTreeMap<String, usize>,
    /// RLDEV control-byte catalogue (`detect_protected_spans`) kind -> count,
    /// tallied over every readable dialogue Textout run. On real dialogue this
    /// surfaces the ASCII placeholder rules (`name_placeholder`,
    /// `variable_placeholder`); control-byte kinds only appear on runs that
    /// carry `< 0x20` bytes, which the dialogue gate excludes.
    catalogue_kinds: BTreeMap<String, usize>,
    /// `unknown_control` warnings from the catalogue over readable runs. The
    /// dialogue gate forbids control bytes, so this MUST stay 0 (a non-zero
    /// value would mean the gate leaked a control-byte run into dialogue).
    catalogue_unknown_warnings: usize,
    /// Detection errors (`DecodedRangeNotCharBoundary`) over readable runs.
    /// MUST stay 0 on real dialogue.
    catalogue_errors: usize,
    /// Speaker `knowledgeState` -> count across every produced unit. Used to
    /// prove NO fabricated speaker on a corpus that does not inline-bracket
    /// speaker names (Kanon): `known` + `reader_unknown` must be ZERO there.
    speaker_states: BTreeMap<String, usize>,
}

impl SpanReport {
    fn bridge_count(&self, kind: &str) -> usize {
        self.bridge_span_kinds.get(kind).copied().unwrap_or(0)
    }

    fn speaker_count(&self, state: &str) -> usize {
        self.speaker_states.get(state).copied().unwrap_or(0)
    }
}

/// Best-effort locate a `Gameexe.ini` next to the SEEN archive (NAMAE table).
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

fn span_report_for_corpus(corpus: &RealCorpus) -> SpanReport {
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

    let mut report = SpanReport {
        label: corpus.label,
        populated_scenes: index.entries.len(),
        scenes_with_units: 0,
        total_units: 0,
        bridge_span_kinds: BTreeMap::new(),
        catalogue_kinds: BTreeMap::new(),
        catalogue_unknown_warnings: 0,
        catalogue_errors: 0,
        speaker_states: BTreeMap::new(),
    };

    let opts_for = |kidoku_count: u32| BridgeOpts {
        game_id: "protected-span-corpus",
        game_version: "real",
        source_profile_id: "kaifuu-reallive-protected-span",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: kidoku_count,
    };

    for (scene, meta) in scenes.iter().zip(metas.iter()) {
        // RLDEV control-byte catalogue over every READABLE dialogue Textout
        // run (the runs the bridge surfaces as translatable). This exercises
        // `detect_protected_spans` on the 2nd corpus and surfaces its ASCII
        // placeholder rules; a control-byte kind or an unknown warning here
        // would mean the dialogue gate leaked a binary run.
        if let Ok(opcodes) = parse_real_bytecode(&scene.bytecode) {
            for op in &opcodes {
                if let RealLiveOpcode::Textout { raw_bytes, .. } = op {
                    let Some(decoded) = decode_dialogue_textout(raw_bytes) else {
                        continue;
                    };
                    match detect_protected_spans(raw_bytes, &decoded) {
                        Ok(cat) => {
                            for span in &cat.spans {
                                let label = protected_kind_label(&span.kind);
                                *report.catalogue_kinds.entry(label.to_string()).or_insert(0) += 1;
                            }
                            report.catalogue_unknown_warnings += cat.warnings.len();
                        }
                        Err(_) => report.catalogue_errors += 1,
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
            if let Some(state) = unit["speaker"]["knowledgeState"].as_str() {
                *report.speaker_states.entry(state.to_string()).or_insert(0) += 1;
            }
            if let Some(spans) = unit["spans"].as_array() {
                for span in spans {
                    if let Some(name) = span["parsedName"].as_str() {
                        *report
                            .bridge_span_kinds
                            .entry(name.to_string())
                            .or_insert(0) += 1;
                    }
                }
            }
        }
    }

    report
}

/// Stable label for a catalogue [`ProtectedSpanKind`]; the enum's own
/// `label` is `pub`, but re-deriving here keeps the test decoupled from any
/// future label rename and reads as documentation of the catalogue surface.
fn protected_kind_label(kind: &ProtectedSpanKind) -> &'static str {
    match kind {
        ProtectedSpanKind::ColorCode { .. } => "color_code",
        ProtectedSpanKind::Ruby { .. } => "ruby",
        ProtectedSpanKind::NamePlaceholder { .. } => "name_placeholder",
        ProtectedSpanKind::ChoiceToken { .. } => "choice_token",
        ProtectedSpanKind::TextSizeDirective { .. } => "text_size_directive",
        ProtectedSpanKind::WaitDirective { .. } => "wait_directive",
        ProtectedSpanKind::ClearTextBox => "clear_text_box",
        ProtectedSpanKind::LineBreak => "line_break",
        ProtectedSpanKind::VariablePlaceholder { .. } => "variable_placeholder",
        ProtectedSpanKind::UnknownControl { .. } => "unknown_control",
    }
}

fn print_report(report: &SpanReport) {
    eprintln!(
        "[{}] PROTECTED-SPANS: populated_scenes={} scenes_with_units={} total_units={}",
        report.label, report.populated_scenes, report.scenes_with_units, report.total_units,
    );
    eprintln!("[{}] bridge span parsedName -> count:", report.label);
    for (kind, count) in &report.bridge_span_kinds {
        let provenance = if GENERAL_BRIDGE_SPAN_KINDS.contains(&kind.as_str()) {
            "GENERAL"
        } else if OPTIONAL_BRIDGE_SPAN_KINDS.contains(&kind.as_str()) {
            "OPTIONAL"
        } else {
            "other"
        };
        eprintln!("    {kind}: {count} [{provenance}]");
    }
    eprintln!(
        "[{}] RLDEV catalogue over readable runs: kinds={:?} unknown_warnings={} errors={}",
        report.label,
        report.catalogue_kinds,
        report.catalogue_unknown_warnings,
        report.catalogue_errors,
    );
    eprintln!(
        "[{}] speaker knowledgeState -> count: {:?}",
        report.label, report.speaker_states,
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2 for multi-game)"]
fn protected_span_extraction_generalizes_to_second_corpus_real_bytes() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "protected_span_extraction_generalizes_to_second_corpus_real_bytes \
             (set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    }

    let reports: Vec<SpanReport> = corpora.iter().map(span_report_for_corpus).collect();
    for report in &reports {
        print_report(report);

        // Each corpus must be a real, populated archive the producer engaged.
        assert!(
            report.populated_scenes > 0,
            "[{}] SEEN archive parsed but has zero populated scenes",
            report.label
        );
        assert!(
            report.total_units > 0,
            "[{}] no translatable unit produced across the whole archive",
            report.label
        );

        // The dialogue gate forbids `< 0x20` control bytes, so the RLDEV
        // catalogue over the surfaced runs must never surface an unknown
        // control warning or a decode-range error. (This is the 0-unknown /
        // sane-span invariant for the catalogue on BOTH corpora.)
        assert_eq!(
            report.catalogue_unknown_warnings, 0,
            "[{}] {} unknown-control warning(s) over readable dialogue runs — the dialogue \
             gate leaked a control-byte run",
            report.label, report.catalogue_unknown_warnings
        );
        assert_eq!(
            report.catalogue_errors, 0,
            "[{}] {} protected-span decode-range error(s) over readable dialogue runs",
            report.label, report.catalogue_errors
        );

        // RealLive-GENERAL rules must actually fire on every corpus: the
        // read-tracking (`reallive.kidoku`) surface is engine-wide and present
        // on any populated archive.
        assert!(
            report.bridge_count("reallive.kidoku") > 0,
            "[{}] no reallive.kidoku span emitted anywhere — the engine-general read-tracking \
             surface must be exercised on every RealLive corpus",
            report.label
        );
    }

    // Multi-game validation: >= 2 distinct RealLive titles.
    assert!(
        reports.len() >= 2,
        "protected-span multi-game validation requires >= 2 distinct RealLive corpora, but \
         only {} resolved; set {}",
        reports.len(),
        real_corpus::REAL_GAME_ROOT_2_ENV,
    );

    let first = reports
        .iter()
        .find(|r| r.label == "corpus-1")
        .expect("corpus-1 must be staged");
    let second = reports
        .iter()
        .find(|r| r.label == "corpus-2")
        .expect("corpus-2 must be staged for the generalization witness");
    eprintln!(
        "[corpus-1] kidoku={} name_token={} choice_marker={} asset_ref={} font_tone={}",
        first.bridge_count("reallive.kidoku"),
        first.bridge_count("reallive.name_token"),
        first.bridge_count("reallive.choice_marker"),
        first.bridge_count("reallive.asset_ref"),
        first.bridge_count("reallive.font_tone"),
    );
    eprintln!(
        "[corpus-2] kidoku={} name_token={} choice_marker={} asset_ref={} font_tone={}",
        second.bridge_count("reallive.kidoku"),
        second.bridge_count("reallive.name_token"),
        second.bridge_count("reallive.choice_marker"),
        second.bridge_count("reallive.asset_ref"),
        second.bridge_count("reallive.font_tone"),
    );

    // The engine-wide read-tracking surface fires on the second corpus.
    assert!(
        second.bridge_count("reallive.kidoku") > 0,
        "[corpus-2] must exercise the engine-general reallive.kidoku surface"
    );

    // ZERO FABRICATED SPEAKERS: corpus-2 authors no inline `【】` token, so
    // there is NO authoritative
    // display-key evidence anywhere in the archive — the producer must
    // therefore resolve ZERO `known` and ZERO `reader_unknown` speakers. A
    // non-zero here is a fabricated identity (a substring / carried-forward
    // attribution the hardening removed). The bounded first-line fallback may
    // still mark a `parser_unknown` guess — that is not a fabricated identity.
    assert_eq!(
        second.bridge_count("reallive.name_token"),
        0,
        "[corpus-2] must author no inline 【】 tokens (no-fabrication precondition)"
    );
    assert_eq!(
        second.speaker_count("known"),
        0,
        "[corpus-2] has no inline display-key evidence — ZERO `known` speakers may be \
         fabricated; got {}",
        second.speaker_count("known"),
    );
    assert_eq!(
        second.speaker_count("reader_unknown"),
        0,
        "[corpus-2] has no inline display-key evidence — ZERO `reader_unknown` speakers may \
         be fabricated; got {}",
        second.speaker_count("reader_unknown"),
    );

    // The first corpus witnesses the engine grammar. Its absence in the second
    // corpus is valid optional-markup behavior, not a different game profile.
    assert!(
        first.bridge_count("reallive.name_token") > 0,
        "[corpus-1] must exercise the documented reallive.name_token grammar"
    );
}
