use super::*;

pub(super) fn multi_game_validation_runs_against_two_distinct_reallive_corpora() {
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

pub(super) fn every_menu_boot_system_scene_decodes_to_zero_unknown() {
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

pub(super) fn kanon_second_corpus_decompiles_zero_unknown() {
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
