//! FIX-4 multi-game-validation real-bytes harness.
//! Project law (`docs/dev/orchestration-operating-model.md`,
//! multi-game-validation): RealLive engine-family behaviour must validate
//! against **>= 2 real RealLive games**. On main only Oshioki Sweetie HD was
//! staged; FIX-4 sources a second genuine RealLive title (Kanon, a 1.2.6.8
//! fan-patched / rlBabel tree) and exposes it to this harness via
//! [`real_corpus::REAL_GAME_ROOT_2_ENV`] (`ITOTORI_REAL_GAME_ROOT_2`).
//! # What this test proves (and what it deliberately does NOT)
//! This is the availability + multi-game + **full-archive 100%-decompile**
//! gate. It asserts:
//! - each staged corpus resolves, is a real RealLive SEEN archive with >= 1
//!   populated scene;
//! - when two corpora are staged their SEEN archives have **distinct
//!   sha256** (audit-focus: "2nd corpus actually Sweetie HD again" — caught
//!   here);
//! - the merged decompiler **runs** over every scene of every corpus without
//!   panicking and recognises non-trivial real structure;
//! - BOTH complete real archives — Kanon (`10002`, no `xor_2`) and Sweetie
//!   HD (`110002`, second-level `xor_2` decrypted in-process) — decode with
//!   ZERO unknown commands, ZERO malformed expressions, and ZERO parse
//!   failures across every populated scene (the alpha 100% bar).
//!   It then prints a sanitized per-corpus decompiler-coverage report (clean /
//!   parse-failed / unknown-command scene counts, opcode histogram, and the
//!   unrecognised `(module_type, module_id, opcode)` signatures with
//!   frequencies). **No raw copyrighted bytes or text are emitted — counts,
//!   offsets, opcode signatures and sha256 only.**
//! # Honest 100%-decompilation status (the FIX-4 finding)
//! Per the 100%-decompilation law, the bar is ZERO unknown opcodes / ZERO
//! parse failures on real bytes. This harness records the measured coverage
//! and does **not** relax any floor. The decompiler layers are now separable
//! and a FULL real archive is proven 100% decompiled:
//! - **Expression grammar (`reallive-expr-eval-bank-refs`) — DONE.** The
//!   ExpressionPiece evaluator implements the full RealLive reference grammar.
//! - **Semantic command cataloguing (`reallive-semantic-command-cataloguing`)
//!   — DONE.** Every in-space `(module_type, module_id, opcode)` maps to a
//!   SEMANTICALLY-TYPED operation family (keyed on `module_id`), not a generic
//!   `Command{module,id,opcode,args}` blob: `is_recognized` is true ONLY for
//!   a named family. Both archives are asserted at the SEMANTIC-zero bar —
//!   ZERO generic `Command`, ZERO `Unknown`, ZERO malformed expressions, ZERO
//!   parse failures across every populated scene. Supersedes the prior
//!   `reallive-command-module-catalogue`, which counted the generic blob as
//!   recognised (framing, not semantics).
//! - **Sweetie HD second-level XOR — DONE
//!   (`reallive-xor2-sukara-decryptor`).** corpus-1 (Sweetie HD, compiler
//!   `110002`) carries a second-level per-game `xor_2` over a bounded
//!   `[256, 513)` segment of every scene's decompressed bytecode (rlvm's
//!   `XorKey { xor_offset = 256, xor_length = 257 }` shape; clean-room from
//!   `compression.cc`). Forensic signature: byte-equality autocorrelation
//!   spikes at lag 16 / lag 32 against a ≈0.4 % baseline — a 16-byte-period
//!   XOR over structured plaintext. Sukara's key is absent from rlvm's
//!   published table AND is not stored anywhere in the shipped game (a full
//!   static scan of `RealLive.exe` + all 2,843 game files finds it under no
//!   rotation): the retail interpreter derives it at run time. It is
//!   therefore recovered here by in-process static analysis of the game's
//!   own encrypted corpus (cross-scene known-plaintext over the `0x00`-modal
//!   segment) and validated before consumption — see
//!   [`kaifuu_reallive::xor2`]. With the segment decrypted, the SAME command
//!   catalogue that decodes Kanon decodes all 198 Sweetie scenes 100% clean
//!   (was 45/198 clean, 121 parse failures). corpus-1 is now asserted at the
//!   SAME hard zero bar as corpus-2.
//!   This test's contract is corpus availability + harness execution + the
//!   full command-catalogue + expression-grammar + second-level-`xor_2` zero
//!   bar on BOTH complete real archives.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;

use kaifuu_reallive::{
    RealLiveOpcode, RealLiveParseError, SceneHeader, Xor2DecScene, Xor2Report, decompress_avg32,
    parse_archive, parse_real_bytecode, recover_and_decrypt_archive,
};

use real_corpus::RealCorpus;

/// Sanitized per-corpus decompiler coverage. Counts/offsets/signatures only.
struct CoverageReport {
    label: &'static str,
    seen_sha256: String,
    populated_scenes: usize,
    clean_scenes: usize,
    scenes_with_unknown: usize,
    parse_failures: usize,
    /// Sanitized outcome of the second-level `xor_2` decryptor: counts /
    /// offsets / one-way key sha256 only (never the key or decrypted bytes).
    xor2: Xor2Report,
    /// Of `parse_failures`, the count whose first decode error is a
    /// `MalformedExpression` — i.e. the ExpressionPiece evaluator was handed
    /// a byte that is not a valid expression token. This is the metric the
    /// `reallive-expr-eval-bank-refs` node drives to zero: a complete
    /// expression-reference grammar produces none of these.
    malformed_expression_scenes: usize,
    total_opcodes: usize,
    /// Count of opcodes that fail `is_recognized` — i.e. the union of the
    /// un-catalogued generic `Command` blob and the `module_type > 2`
    /// `Unknown` desync tripwire. The semantic-zero bar is `0`.
    total_unknown: usize,
    /// Of `total_unknown`, the count that are the un-catalogued generic
    /// `Command` (an in-space tuple whose module/opcode pair is not
    /// catalogued). This is the metric the semantic catalogue drives to zero:
    /// every real command must map to a named operation family, never a blob.
    total_generic_command: usize,
    /// Of `total_unknown`, the count that are the `module_type > 2` `Unknown`
    /// desync tripwire.
    total_unknown_desync: usize,
    histogram: BTreeMap<&'static str, usize>,
    /// `(module_type, module_id, opcode)` signatures of every NOT-recognised
    /// command (generic `Command` and `Unknown` alike) with frequencies, so a
    /// regression names the exact un-catalogued tuples.
    unrecognised_signatures: BTreeMap<(u8, u8, u16), usize>,
    /// Per-scene decode verdict keyed by the 10,000-slot directory scene id.
    /// `true` iff the scene reached the decoder AND decoded with zero
    /// un-recognised opcodes (its full byte stream tiled into typed elements).
    /// A scene that never reaches the decoder (envelope / header / decompress /
    /// parse failure) is absent from the map. The
    /// `every_menu_boot_system_scene_decodes_to_zero_unknown` pin keys on this
    /// so a regression that DROPS or mis-decodes a specific hard scene (the
    /// New-Game routine 9996, boot 8507, a title / menu / config / system
    /// scene) turns the gate red by NAME, not just by an aggregate count — the
    /// "true 100% coverage, no skipped hard scenes" directive.
    per_scene_clean: BTreeMap<u16, bool>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    // Minimal dependency-free SHA-256 so the harness can prove the two
    // corpora are distinct games without pulling a hashing crate into the
    // test target.
    sha256::digest_hex(bytes)
}

fn decompile_corpus(corpus: &RealCorpus) -> CoverageReport {
    let bytes = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|err| panic!("read {}: {err}", corpus.seen_txt.display()));
    let index = parse_archive(&bytes).unwrap_or_else(|diag| {
        panic!(
            "{} SEEN archive must parse as a RealLive 10,000-slot envelope; got {diag:?}",
            corpus.label
        )
    });

    let populated_scenes = index.entries.len();
    let mut report = CoverageReport {
        label: corpus.label,
        seen_sha256: sha256_hex(&bytes),
        populated_scenes,
        clean_scenes: 0,
        scenes_with_unknown: 0,
        parse_failures: 0,
        xor2: Xor2Report {
            segment_offset: 0,
            segment_length: 0,
            key_len: 0,
            scenes_total: 0,
            scenes_eligible: 0,
            baseline_clean: 0,
            after_clean: 0,
            scenes_decrypted: 0,
            validated: false,
            key_sha256: None,
            finding: None,
        },
        malformed_expression_scenes: 0,
        total_opcodes: 0,
        total_unknown: 0,
        total_generic_command: 0,
        total_unknown_desync: 0,
        histogram: BTreeMap::new(),
        unrecognised_signatures: BTreeMap::new(),
        per_scene_clean: BTreeMap::new(),
    };

    // Any failure before the decompressed bytecode exists is a hard parse
    // failure (it can never reach the decoder). The scene id is carried
    // alongside every decompressed scene so the per-scene decode verdict
    // (Stage 3) can be keyed by id for the hard-scene pin — a scene that fails
    // before the decoder is simply absent from `per_scene_clean` (which the
    // pin treats as a HARD miss, catching a silently-dropped menu/boot scene).
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(populated_scenes);
    let mut scene_ids: Vec<u16> = Vec::with_capacity(populated_scenes);
    for entry in &index.entries {
        let off = entry.byte_offset as usize;
        let end = off + entry.byte_len as usize;
        if end > bytes.len() {
            report.parse_failures += 1;
            continue;
        }
        let blob = &bytes[off..end];
        let Ok(header) = SceneHeader::parse(blob) else {
            report.parse_failures += 1;
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            report.parse_failures += 1;
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            report.parse_failures += 1;
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: decompressed,
        });
        scene_ids.push(entry.scene_id);
    }

    // in-process from the corpus, validate-before-consume). Scenes whose
    // compiler_version does not set use_xor_2 (Kanon's 10002) are untouched.
    report.xor2 = recover_and_decrypt_archive(&mut scenes);

    for (scene, scene_id) in scenes.iter().zip(scene_ids.iter()) {
        let opcodes = match parse_real_bytecode(&scene.bytecode) {
            Ok(opcodes) => opcodes,
            Err(err) => {
                report.parse_failures += 1;
                report.per_scene_clean.insert(*scene_id, false);
                if matches!(err, RealLiveParseError::MalformedExpression { .. }) {
                    report.malformed_expression_scenes += 1;
                }
                continue;
            }
        };

        let total = opcodes.len();
        let unknown = opcodes.iter().filter(|op| !op.is_recognized()).count();
        report.total_opcodes += total;
        report.total_unknown += unknown;
        report.per_scene_clean.insert(*scene_id, unknown == 0);
        if unknown == 0 {
            report.clean_scenes += 1;
        } else {
            report.scenes_with_unknown += 1;
        }
        for op in &opcodes {
            *report.histogram.entry(op.label()).or_insert(0) += 1;
            // The `(module_type, module_id, opcode)` tuple of every
            // NOT-recognised opcode comes from the SAME shared
            // `unrecognized_signature` primitive the `kaifuu extract`
            // decode-honesty gate reports, so the harness and the CLI name
            // identical tuples. The generic/desync split is retained for the
            // two catalogue metrics.
            if let Some(signature) = op.unrecognized_signature() {
                *report.unrecognised_signatures.entry(signature).or_insert(0) += 1;
                match op {
                    // Un-catalogued generic blob: an in-space tuple no semantic
                    // family covers. Its presence is the semantic-cataloguing
                    // regression the gate forbids.
                    RealLiveOpcode::Command { .. } => report.total_generic_command += 1,
                    // `module_type > 2` desync tripwire (raw header preserved).
                    RealLiveOpcode::Unknown { .. } => report.total_unknown_desync += 1,
                    _ => {}
                }
            }
        }
    }

    report
}

fn print_report(report: &CoverageReport) {
    eprintln!(
        "[{}] seen_sha256={} populated_scenes={} clean(0-unknown)={} \
         scenes_with_unknown={} parse_failures={} malformed_expression_scenes={} \
         total_opcodes={} total_unknown={}",
        report.label,
        report.seen_sha256,
        report.populated_scenes,
        report.clean_scenes,
        report.scenes_with_unknown,
        report.parse_failures,
        report.malformed_expression_scenes,
        report.total_opcodes,
        report.total_unknown,
    );
    let xor2 = &report.xor2;
    eprintln!(
        "[{}] XOR2: eligible={} validated={} decrypted={} baseline_clean={} after_clean={} \
         segment=[{}..{}) key_len={} key_sha256={} finding={}",
        report.label,
        xor2.scenes_eligible,
        xor2.validated,
        xor2.scenes_decrypted,
        xor2.baseline_clean,
        xor2.after_clean,
        xor2.segment_offset,
        xor2.segment_offset + xor2.segment_length,
        xor2.key_len,
        xor2.key_sha256.as_deref().unwrap_or("none"),
        xor2.finding.as_deref().unwrap_or("none"),
    );
    eprintln!("[{}] opcode histogram (label -> count):", report.label);
    for (label, count) in &report.histogram {
        eprintln!("    {label}: {count}");
    }
    if !report.unrecognised_signatures.is_empty() {
        eprintln!(
            "[{}] UNRECOGNISED command (un-catalogued generic Command / desync Unknown) \
             (module_type, module_id, opcode) -> count:",
            report.label
        );
        for ((mt, mid, oc), count) in &report.unrecognised_signatures {
            eprintln!("    ({mt:>3}, {mid:>3}, {oc:>5}): {count}");
        }
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2 for multi-game)"]
fn multi_game_validation_runs_against_two_distinct_reallive_corpora() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "multi_game_validation_runs_against_two_distinct_reallive_corpora \
             (set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    }

    let reports: Vec<CoverageReport> = corpora.iter().map(decompile_corpus).collect();
    for report in &reports {
        print_report(report);

        // Each staged corpus must be a real RealLive SEEN archive with real
        // populated scenes (no silent zero-state).
        assert!(
            report.populated_scenes > 0,
            "[{}] SEEN archive parsed but has zero populated scenes",
            report.label
        );
        // The merged decompiler must actually engage the real bytes: at
        // least one scene must decode into recognised structure. (This is
        // an availability/execution check, NOT a 100%-recognition floor.)
        assert!(
            report.total_opcodes > 0,
            "[{}] decompiler ran but produced no opcodes for any scene",
            report.label
        );
        assert!(
            report.clean_scenes + report.scenes_with_unknown > 0,
            "[{}] no scene decoded at all (every scene hit a hard parse failure)",
            report.label
        );
    }

    // The command catalogue (`opcode.rs`) maps every enumerated real
    // `(module_type, module_id, opcode)` to a **semantically-typed operation
    // family** keyed on its `module_id` (the engine's real semantic key —
    // `module_type` is a compiler-version artifact): control-flow, selection,
    // message-window, system, variable/flag, audio, voice,
    // graphics-background, display-object, screen-control and memory. An
    // uncatalogued opcode in a known module becomes generic `Command` and
    // fails this gate, so there is NO `Command{module,id,opcode,args}` blob on
    // the real bytes:
    // `is_recognized` is true ONLY for a semantically-typed variant, so the
    // SEMANTIC bar is "zero generic `Command` AND zero `Unknown`". This
    // supersedes the prior `reallive-command-module-catalogue`, which funnelled
    // the long tail into the generic `Command` blob and (wrongly) counted it as
    // recognised — framing, not semantics: Utsushi cannot render a command it
    // cannot semantically identify.
    // BOTH complete archives are asserted at this hard SEMANTIC-zero bar.
    // corpus-2 (Kanon, 10002) carries no second-level XOR and is decoded by
    // the catalogue alone; corpus-1 (Sweetie HD, 110002) is first decrypted by
    // the second-level `xor_2` decryptor (per-game key recovered in-process,
    // validated before consumption) and then decoded by the SAME catalogue.
    // No floor is relaxed and no scene is skipped: every populated scene of
    // both archives decodes with zero generic `Command`, zero `Unknown`, zero
    // malformed expressions and zero parse failures.
    for report in &reports {
        eprintln!(
            "[{}] CATALOGUE: not_recognised={} (generic_command={} unknown_desync={}) \
             malformed_expression_scenes={} parse_failures={}",
            report.label,
            report.total_unknown,
            report.total_generic_command,
            report.total_unknown_desync,
            report.malformed_expression_scenes,
            report.parse_failures,
        );

        // SEMANTIC zero, split out explicitly so a regression names which
        // failure mode it is. (1) Zero un-catalogued generic `Command`: every
        // real command maps to a named operation family.
        assert_eq!(
            report.total_generic_command, 0,
            "[{}] {} command(s) decode to the generic `Command` blob on the full archive \
             — every real tuple must map to a SEMANTIC family (see signatures above)",
            report.label, report.total_generic_command
        );
        // (2) Zero `module_type > 2` desync `Unknown`.
        assert_eq!(
            report.total_unknown_desync, 0,
            "[{}] {} `Unknown` desync tripwire(s) on the full archive",
            report.label, report.total_unknown_desync
        );
        // The histogram must carry no `"command"` bucket at all.
        assert_eq!(
            report.histogram.get("command").copied().unwrap_or(0),
            0,
            "[{}] opcode histogram still has a `command` bucket — un-catalogued tuples remain",
            report.label
        );
        // (1)+(2) combined: nothing fails `is_recognized`.
        assert_eq!(
            report.total_unknown, 0,
            "[{}] {} command(s) fail recognition on the full archive \
             (the bar is zero; no floor may be relaxed)",
            report.label, report.total_unknown
        );
        assert_eq!(
            report.scenes_with_unknown, 0,
            "[{}] {} scene(s) still carry an Unknown command on the full archive",
            report.label, report.scenes_with_unknown
        );
        assert_eq!(
            report.malformed_expression_scenes, 0,
            "[{}] {} scene(s) still fail with MalformedExpression on the full archive",
            report.label, report.malformed_expression_scenes
        );
        assert_eq!(
            report.parse_failures, 0,
            "[{}] {} scene(s) still hit a parse failure on the full archive \
             (zero unknown + zero parse-failure is the gate's bar)",
            report.label, report.parse_failures
        );
        assert_eq!(
            report.clean_scenes, report.populated_scenes,
            "[{}] only {}/{} scenes decode 100% clean (every populated scene must)",
            report.label, report.clean_scenes, report.populated_scenes
        );

        // The xor_2 decryptor must have ACTUALLY engaged on the eligible
        // corpus (Sweetie HD): a corpus with use_xor_2 scenes must have a
        // validated, consumed per-game key, and the decryption must have
        // strictly recovered scenes that were unreadable before
        // (after_clean > baseline_clean). A corpus with no eligible scenes
        // (Kanon) must have left every scene untouched.
        if report.xor2.scenes_eligible > 0 {
            assert!(
                report.xor2.validated,
                "[{}] {} scene(s) set use_xor_2 but no per-game key validated: {:?}",
                report.label, report.xor2.scenes_eligible, report.xor2.finding
            );
            assert_eq!(
                report.xor2.scenes_decrypted, report.xor2.scenes_eligible,
                "[{}] xor_2 key validated but not applied to every eligible scene",
                report.label
            );
            assert!(
                report.xor2.after_clean > report.xor2.baseline_clean,
                "[{}] xor_2 decryption did not recover any previously-unreadable scene \
                 (after_clean={} baseline_clean={})",
                report.label,
                report.xor2.after_clean,
                report.xor2.baseline_clean
            );
            assert!(
                report.xor2.key_sha256.is_some(),
                "[{}] validated xor_2 key must surface a one-way sha256 commitment",
                report.label
            );
        } else {
            assert!(
                !report.xor2.validated && report.xor2.scenes_decrypted == 0,
                "[{}] corpus has no use_xor_2 scenes yet the decryptor reported activity",
                report.label
            );
        }
    }

    // Multi-game-validation core assertion. Real-bytes coverage is
    // unconditionally required, so both corpora must resolve AND be DIFFERENT
    // games. A single resolved corpus is a hard failure; two identical corpora
    // (same SEEN sha256) defeat the FIX-4 audit-focus "2nd corpus actually
    // Sweetie HD again".
    assert!(
        reports.len() >= 2,
        "multi-game validation requires >= 2 RealLive corpora, but only {} \
         resolved; set {} to a second, distinct RealLive title",
        reports.len(),
        real_corpus::REAL_GAME_ROOT_2_ENV,
    );
    assert_ne!(
        reports[0].seen_sha256, reports[1].seen_sha256,
        "multi-game validation requires two DISTINCT RealLive titles; both \
         corpus roots resolved to the same SEEN archive (sha256 match)"
    );

    // Honest 100%-decompilation status line (NOT an assertion — the floor is
    // never relaxed, and completeness is owned by a follow-up extension node).
    for report in &reports {
        let pct_clean = if report.populated_scenes > 0 {
            (report.clean_scenes as f64) / (report.populated_scenes as f64) * 100.0
        } else {
            0.0
        };
        eprintln!(
            "[{}] 100%-DECOMPILE STATUS: {}/{} scenes fully recognised ({pct_clean:.1}%); \
             {} parse failures, {} scenes with unknown commands -> {}",
            report.label,
            report.clean_scenes,
            report.populated_scenes,
            report.parse_failures,
            report.scenes_with_unknown,
            if report.parse_failures == 0 && report.total_unknown == 0 {
                "PROVEN (zero unknowns, zero parse failures)"
            } else {
                "NEEDS DECOMPILER EXTENSION (see signatures above)"
            },
        );
    }
}

/// Historical snapshot: the Sweetie HD menu / boot / system scenes that the
/// earlier `work-scope` carve trace
/// (`apps/itotori/src/agents/work-scope/carve.ts`, 2026-07-04)
/// recorded as UNDECODABLE before the ExpressionPiece grammar
/// (`reallive-expr-eval-bank-refs`), the semantic command catalogue
/// (`reallive-semantic-command-cataloguing`) and the second-level `xor_2`
/// decryptor (`reallive-xor2-sukara-decryptor`) landed:
/// - **9996** — the New-Game routine (`farcall` (0,1,18) target from the title
///   menu's `goto_case($store)`). The historical carve trace recorded it FAILING with
///   `MalformedExpression @~offset 271`; the completed expression grammar now
///   decodes it to zero unknowns.
/// - **8507** — a boot / system scene in the `8500..=8516` block.
/// - **2 / 3 / 10** — the first-screen title menu (`select_objbtn` game-select),
///   the config / gallery scene, and the extra sub-menu the title dispatch
///   `jump`/`farcall`s into.
/// - **8500 / 8600 / 9999** — further boot / system / menu scenes.
///   These are the exact "menu/boot/system scenes not strictly needed for
///   dialogue" the true-100%-coverage directive names: they must NOT be dropped
///   from the archive index AND must each decode to zero unknown opcodes. The
///   aggregate `clean_scenes == populated_scenes` gate above already forbids ANY
///   unclean scene, but this pin makes a regression that DROPS or mis-decodes one
///   of these specific hard scenes fail by NAME (rather than being masked by the
///   aggregate count) — closing the "skip the hard scenes" hole strictly.
const SWEETIE_HD_HARD_MENU_BOOT_SYSTEM_SCENES: &[u16] = &[2, 3, 10, 8500, 8507, 8600, 9996, 9999];

/// alpha true-100%-coverage: every Sweetie HD menu / boot / system scene the
/// earlier carve trace flagged as undecodable now decodes to ZERO unknown
/// opcodes on real bytes — proven by NAME, not just in the aggregate.
/// The `reallive-boot-menu-system-scene-decode-gap` directive is "true 100%
/// coverage even for scenes not strictly needed for dialogue" — decode the
/// menu/boot/system scenes (New-Game 9996, boot 8507, title/menu 2/3/10, …),
/// no skipped scenes. This test resolves the real Sweetie HD corpus, runs the
/// full envelope -> header -> AVG32 -> xor_2 -> decode chain, and asserts each
/// named hard scene both (a) reached the decoder (is present in
/// `per_scene_clean` — a silently-dropped scene is absent and fails HERE) and
/// (b) decoded to zero unknown opcodes. No raw copyrighted bytes/text — scene
/// ids and the clean/unclean verdict only.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn every_menu_boot_system_scene_decodes_to_zero_unknown() {
    let Some(corpus) = real_corpus::corpus_1() else {
        real_corpus::require_real_bytes(
            "every_menu_boot_system_scene_decodes_to_zero_unknown \
             (set ITOTORI_REAL_GAME_ROOT to Sweetie HD)",
        );
        return;
    };

    let report = decompile_corpus(&corpus);
    print_report(&report);

    // The corpus must actually be Sweetie HD (the title carrying these
    // menu/boot/system scene ids). A second-level xor_2 corpus with these
    // exact ids IS Sweetie HD; guard against an accidentally-repointed root.
    assert!(
        report.xor2.scenes_eligible > 0,
        "[{}] expected Sweetie HD (xor_2 title) for the menu/boot/system pin; \
         got a non-xor2 corpus",
        report.label
    );

    let mut missing: Vec<u16> = Vec::new();
    let mut unclean: Vec<u16> = Vec::new();
    for &scene_id in SWEETIE_HD_HARD_MENU_BOOT_SYSTEM_SCENES {
        match report.per_scene_clean.get(&scene_id) {
            None => missing.push(scene_id),
            Some(true) => {}
            Some(false) => unclean.push(scene_id),
        }
    }

    eprintln!(
        "[{}] MENU/BOOT/SYSTEM hard-scene pin: checked {:?} -> missing(dropped/pre-decode-fail)={:?} \
         unclean(unknown-opcode)={:?}",
        report.label, SWEETIE_HD_HARD_MENU_BOOT_SYSTEM_SCENES, missing, unclean
    );

    // (a) None of the named hard scenes may be DROPPED before the decoder
    // (silently omitted from the index, or lost to an envelope/header/
    // decompress/parse failure). "Skip the hard scenes" is forbidden.
    assert!(
        missing.is_empty(),
        "[{}] menu/boot/system scene(s) {:?} never reached the decoder \
         (dropped from the index or failed before decode) — the true-100% \
         directive forbids skipping the hard scenes",
        report.label,
        missing
    );
    // (b) Each named hard scene must decode to ZERO unknown opcodes.
    assert!(
        unclean.is_empty(),
        "[{}] menu/boot/system scene(s) {:?} decoded with un-recognised opcodes \
         (the New-Game routine 9996 / boot 8507 / title menu 2,3,10 / system \
         scenes must each decode to zero unknowns)",
        report.label,
        unclean
    );

    eprintln!(
        "[{}] MENU/BOOT/SYSTEM PROVEN: all {} named hard scenes (incl. New-Game 9996, \
         boot 8507, title menu 2/3/10) decode to zero unknown opcodes on real bytes.",
        report.label,
        SWEETIE_HD_HARD_MENU_BOOT_SYSTEM_SCENES.len(),
    );
}

/// Known Sweetie HD (`ITOTORI_REAL_GAME_ROOT`, corpus-1) SEEN sha256, recorded
/// from this harness's own `[corpus-1] seen_sha256=...` line. The Kanon-only
/// generalization test below asserts corpus-2's SEEN archive does NOT match it,
/// so `ITOTORI_REAL_GAME_ROOT_2` accidentally re-pointed at Sweetie HD is caught
/// even when corpus-1 is not staged in the same run. (One-way digest of an
/// already-committed corpus fingerprint — no raw bytes.)
const SWEETIE_HD_SEEN_SHA256: &str =
    "903f538b821a9b1e6cb3d399582915c0bcf73b0a058ecc907caf6017a4fa209f";

/// alpha-006e-multigame-validation: the 2nd-title 100%-decompilation law.
/// Distinct from
/// [`multi_game_validation_runs_against_two_distinct_reallive_corpora`] (which
/// needs BOTH corpora staged), this test gates on `ITOTORI_REAL_GAME_ROOT_2`
/// (Kanon) ALONE and proves the Sweetie-HD opcode coverage GENERALIZES to a
/// second, independently-authored RealLive title: the SAME command catalogue
/// and expression grammar decode the whole Kanon archive at the hard SEMANTIC
/// zero bar (zero generic `Command`, zero `Unknown`, zero malformed
/// expressions, zero parse failures) across every populated scene.
/// Kanon is a 1.2.6.8 (`10002`) title that carries NO second-level `xor_2`, so
/// it is decoded by the catalogue alone with no game-specific decrypt path —
/// which is precisely why it is the generalization witness: nothing
/// Sweetie-HD-specific is in the loop, and no game-specific special-casing or
/// generic-`Command` escape may mask an unknown (the `is_recognized` bar is
/// `false` for the generic blob, so a masked tuple would fail this test, not
/// pass it). No raw copyrighted bytes/text are emitted — counts, opcode
/// signatures and sha256 only.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT_2 (2nd RealLive title, e.g. Kanon)"]
fn kanon_second_corpus_decompiles_zero_unknown() {
    let Some(corpus) = real_corpus::corpus_2() else {
        real_corpus::require_real_bytes(
            "kanon_second_corpus_decompiles_zero_unknown \
             (set ITOTORI_REAL_GAME_ROOT_2 to a 2nd RealLive title, e.g. Kanon)",
        );
        return;
    };

    let report = decompile_corpus(&corpus);
    print_report(&report);

    // (0) The 2nd corpus is a genuinely DIFFERENT title from Sweetie HD — not
    // corpus-1 re-pointed. Structural: Kanon (10002) carries NO second-level
    // xor_2, whereas Sweetie HD (110002) is xor_2-encrypted; AND the SEEN
    // sha256 must not equal Sweetie HD's. This catches "2nd corpus actually
    // Sweetie HD again" even with corpus-1 unstaged.
    assert_ne!(
        report.seen_sha256, SWEETIE_HD_SEEN_SHA256,
        "ITOTORI_REAL_GAME_ROOT_2 resolved to the Sweetie HD SEEN archive; \
         multi-game validation needs a DISTINCT 2nd RealLive title"
    );
    assert_eq!(
        report.xor2.scenes_eligible, 0,
        "[{}] 2nd corpus reports second-level xor_2 scenes — expected a plain \
         (non-xor2) RealLive title distinct from Sweetie HD",
        report.label
    );

    // (1) The 2nd corpus is a real, populated RealLive archive the merged
    // decompiler actually engaged (at least one real scene decoded).
    assert!(
        report.populated_scenes > 0,
        "[{}] 2nd corpus SEEN archive has zero populated scenes",
        report.label
    );
    assert!(
        report.total_opcodes > 0,
        "[{}] decompiler ran but produced no opcodes for the 2nd corpus",
        report.label
    );
    assert!(
        report.clean_scenes > 0,
        "[{}] no scene of the 2nd corpus decoded 0-unknown \
         (the law requires >= 1 real scene at recognition_rate 100%)",
        report.label
    );

    // (2) The hard SEMANTIC zero bar on the FULL 2nd archive (same
    // `is_recognized` bar as Sweetie HD). Split by failure mode so a
    // regression names exactly which generalization gap opened.
    assert_eq!(
        report.total_generic_command, 0,
        "[{}] {} command(s) decode to the generic `Command` blob on Kanon \
         — a generalization gap: every real tuple must map to a SEMANTIC \
         family (catalogue it in opcode.rs; do NOT relax the bar). Signatures \
         printed above.",
        report.label, report.total_generic_command
    );
    assert_eq!(
        report.total_unknown_desync, 0,
        "[{}] {} `Unknown` desync tripwire(s) on Kanon",
        report.label, report.total_unknown_desync
    );
    assert_eq!(
        report.histogram.get("command").copied().unwrap_or(0),
        0,
        "[{}] opcode histogram still has a `command` bucket — un-catalogued \
         tuples remain on the 2nd corpus",
        report.label
    );
    assert_eq!(
        report.total_unknown, 0,
        "[{}] {} command(s) fail recognition on the full Kanon archive \
         (the bar is zero unknown; no floor may be relaxed)",
        report.label, report.total_unknown
    );
    assert_eq!(
        report.scenes_with_unknown, 0,
        "[{}] {} Kanon scene(s) still carry an Unknown command",
        report.label, report.scenes_with_unknown
    );
    assert_eq!(
        report.malformed_expression_scenes, 0,
        "[{}] {} Kanon scene(s) still fail with MalformedExpression",
        report.label, report.malformed_expression_scenes
    );
    assert_eq!(
        report.parse_failures, 0,
        "[{}] {} Kanon scene(s) still hit a parse failure \
         (zero unknown + zero parse-failure is the bar)",
        report.label, report.parse_failures
    );
    assert_eq!(
        report.clean_scenes, report.populated_scenes,
        "[{}] only {}/{} Kanon scenes decode 100% clean (every populated scene must)",
        report.label, report.clean_scenes, report.populated_scenes
    );

    eprintln!(
        "[{}] GENERALIZATION PROVEN: Sweetie-HD opcode coverage decodes a 2nd \
         RealLive title (Kanon) — {}/{} scenes, {} opcodes, 0 unknown, 0 parse \
         failures, no game-specific special-casing.",
        report.label, report.clean_scenes, report.populated_scenes, report.total_opcodes,
    );
}

/// Dependency-free SHA-256 for corpus distinctness checks.
mod sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    pub fn digest_hex(data: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];
        let mut msg = data.to_vec();
        let bit_len = (data.len() as u64) * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());

        for chunk in msg.chunks_exact(64) {
            let mut w = [0u32; 64];
            for (i, word) in w.iter_mut().enumerate().take(16) {
                let j = i * 4;
                *word = u32::from_be_bytes([chunk[j], chunk[j + 1], chunk[j + 2], chunk[j + 3]]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }
            let mut v = h;
            for i in 0..64 {
                let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
                let ch = (v[4] & v[5]) ^ ((!v[4]) & v[6]);
                let t1 = v[7]
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
                let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
                let t2 = s0.wrapping_add(maj);
                v[7] = v[6];
                v[6] = v[5];
                v[5] = v[4];
                v[4] = v[3].wrapping_add(t1);
                v[3] = v[2];
                v[2] = v[1];
                v[1] = v[0];
                v[0] = t1.wrapping_add(t2);
            }
            for (hi, vi) in h.iter_mut().zip(v.iter()) {
                *hi = hi.wrapping_add(*vi);
            }
        }

        let mut out = String::with_capacity(64);
        for word in h {
            let _ = write!(out, "{word:08x}");
        }
        out
    }

    #[test]
    fn sha256_known_vector() {
        // FIPS-180 "abc" test vector.
        assert_eq!(
            digest_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            digest_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
