//! Real-bytes validation of the Softpal `SCRIPT.SRC` dialogue disassembler
//! against three owned titles, extracting both `SCRIPT.SRC` and `TEXT.DAT` from
//! the same `data.pac` via the crate's own PAC reader. It also surveys the SELECT
//! choice-label encoding across the corpus (direct immediate vs typed-flow
//! indirect label) — see the `GAMES` note for the four-title finding.
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. **No raw copyrighted text lives in this file** — only command
//! counts, the 100 %-pointer-resolution result, and byte offsets, which the
//! disassembler must reproduce.
//! PROOF BAR: every extracted dialogue/choice **text** pointer and every present
//! **speaker name** pointer must resolve to an *exact* `TEXT.DAT` record
//! boundary (0 dangling) — full pointer resolution, all titles.
//! Wired into the PERIODIC `ci-real-bytes` lane; see `pac_real_corpus.rs` for
//! the env-gate / skip-when-absent contract.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{PacArchive, RawCommand, ScriptScan, TextDat};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

/// One game's `SCRIPT.SRC` disassembly expectations. Counts are the measured
/// ground truth (verified against the SoftPal-Tool oracle scan logic).
struct GameExpectation {
    subdir: &'static str,
    /// `PAC ` entry count, used to select the right `data.pac`.
    pac_count: usize,
    /// Expected TEXT-SHOW (dialogue) command count.
    text_show_count: usize,
    /// Expected count of TEXT-SHOW commands carrying a speaker name pointer.
    with_speaker_count: usize,
    /// Expected total SELECT command count (text-bearing + system/branch).
    select_count: usize,
    /// Expected text-bearing choices (SELECT immediate resolves to a record).
    text_bearing_choice_count: usize,
    /// Expected non-text system/branch selects (out-of-pool immediate).
    nontext_select_count: usize,
    /// Expected number of SELECTs whose typed value-flow reaches a plain label
    /// source in the current menu block.
    indirect_candidate_count: usize,
    /// Expected number of indirect-label candidates that actually land on a
    /// `TEXT.DAT` record boundary — i.e. are **real, translatable choice labels**.
    /// This is the load-bearing discriminator for the indirect mechanism: it is
    /// non-zero for **exactly one** title (v60663). See the module note below.
    indirect_resolved_count: usize,
}

// SELECT-ENCODING SURVEY across four CRYSTALiA/Softpal titles — measured on real
// bytes. The indirect typed-value mechanism resolves real labels on exactly one
// title (v60663, 16). Every other title carries its choice labels directly on the
// SELECT immediate (the "direct" encoding):
//   * v21465 (2024) — 11 choices, all direct; zero indirect candidates.
//   * v60663 (2026) — INDIRECT encoding: 16 candidates, all resolve to real labels.
//   * v57740 CRACK≡TRICK! (2025-10, nearest sibling of v60663) — 5 story choices,
//     all direct; its 5-select system cluster at script start has typed values
//     that do not flow to a plain label source (indirect_resolved_count == 0).
//   * v55293 Suzaku Shijuusou (2025-05) — trial script with ZERO SELECTs; it
//     cannot exercise the mechanism and is therefore not enrolled below.
// A typed operand alone is not evidence of an indirect label: it must trace to a
// plain source and resolve to a record boundary. The resolver handles both
// encodings and keeps every title's choices translatable.
const GAMES: [GameExpectation; 3] = [
    // v21465 — direct encoding: all 11 SELECT immediates are text pointers.
    GameExpectation {
        subdir: "v21465",
        pac_count: 417,
        text_show_count: 30165,
        with_speaker_count: 19990,
        select_count: 11,
        text_bearing_choice_count: 11,
        nontext_select_count: 0,
        indirect_candidate_count: 0,
        indirect_resolved_count: 0,
    },
    // v60663 — indirect encoding: the typed SELECT value flows through moves to
    // a plain source earlier in the menu block. Sixteen of 21 SELECTs reach real
    // label records; the remaining five are genuine system/menu selects and stay
    // out-of-pool (nontext_select_count == 5).
    GameExpectation {
        subdir: "v60663",
        pac_count: 160,
        text_show_count: 39832,
        with_speaker_count: 28665,
        select_count: 21,
        text_bearing_choice_count: 16,
        nontext_select_count: 5,
        indirect_candidate_count: 16,
        indirect_resolved_count: 16,
    },
    // v57740 CRACK≡TRICK! — the five story choices resolve directly. Its typed
    // system-select cluster has no plain label source, proving that the indirect
    // encoding is selected by bytecode shape rather than generation or identity.
    GameExpectation {
        subdir: "v57740",
        pac_count: 142,
        text_show_count: 10098,
        with_speaker_count: 6471,
        select_count: 10,
        text_bearing_choice_count: 5,
        nontext_select_count: 5,
        indirect_candidate_count: 0,
        indirect_resolved_count: 0,
    },
];

fn find_data_pacs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_data_pacs(&path, out);
        } else if path.file_name().is_some_and(|n| n == "data.pac") {
            out.push(path);
        }
    }
}

/// Extract one named entry from the game's `data.pac` (selected by entry count),
/// via the crate's PAC reader.
fn extract_entry(game: &GameExpectation, root: &Path, name: &str) -> Vec<u8> {
    let game_dir = root.join(game.subdir);
    let mut pacs = Vec::new();
    find_data_pacs(&game_dir, &mut pacs);
    assert!(!pacs.is_empty(), "no data.pac under {}", game_dir.display());
    for pac_path in &pacs {
        let bytes = fs::read(pac_path).expect("read data.pac");
        let Ok(arc) = PacArchive::parse(&bytes) else {
            continue;
        };
        if arc.len() != game.pac_count {
            continue;
        }
        let entry = arc
            .find(name)
            .unwrap_or_else(|| panic!("{name} must be present in {}", pac_path.display()));
        return arc.extract(&bytes, entry).expect("extract entry").to_vec();
    }
    panic!(
        "no data.pac under {} parsed to {} entries",
        game_dir.display(),
        game.pac_count
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal research tree)"]
fn script_disassembler_on_two_softpal_titles() {
    let Some(root) = env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        panic!("set {RESEARCH_ROOT_ENV} to the read-only Softpal research tree");
    };

    for game in &GAMES {
        let script_bytes = extract_entry(game, &root, "SCRIPT.SRC");
        let textdat_bytes = extract_entry(game, &root, "TEXT.DAT");

        // SCRIPT.SRC is plaintext `Sv..`; scan the two text-bearing shapes.
        let scan = ScriptScan::parse(&script_bytes)
            .unwrap_or_else(|e| panic!("{} SCRIPT.SRC scan: {e}", game.subdir));
        assert_eq!(
            &scan.header.version[..2],
            b"20",
            "{} Sv version",
            game.subdir
        );

        let ts = scan.text_show_count();
        let sp = scan.text_show_with_speaker_count();
        let se = scan.select_count();
        // How many SELECTs carry an indirect typed-flow label candidate.
        let indirect_candidates = scan
            .commands
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    RawCommand::Select {
                        decoupled_label: Some(_),
                        ..
                    }
                )
            })
            .count();

        // The stream is in play order: command offsets strictly increasing.
        let mut prev: Option<usize> = None;
        for c in &scan.commands {
            let off = c.command_offset();
            if let Some(p) = prev {
                assert!(off > p, "{} commands in play order", game.subdir);
            }
            prev = Some(off);
        }

        // Resolve every pointer against the decoded TEXT.DAT pool.
        let textdat = TextDat::parse(&textdat_bytes)
            .unwrap_or_else(|e| panic!("{} TEXT.DAT parse: {e}", game.subdir));
        let dis = scan.resolve(&textdat);

        // How many indirect candidates land on a TEXT.DAT record boundary — i.e.
        // real choice labels. Computed from the walk-recovered candidates.
        let record_offsets: std::collections::HashSet<u32> = textdat
            .records
            .iter()
            .filter_map(|r| u32::try_from(r.offset).ok())
            .collect();
        let indirect_resolved = scan
            .commands
            .iter()
            .filter_map(|c| match c {
                RawCommand::Select {
                    decoupled_label: Some(dl),
                    ..
                } => Some(dl.pointer),
                _ => None,
            })
            .filter(|p| record_offsets.contains(p))
            .count();

        let dangling = dis.dangling_pointer_count();
        let ud = dis.unresolved_dialogue_text_count();
        let us = dis.unresolved_speaker_count();
        let tbc = dis.text_bearing_choice_count();
        let nts = dis.nontext_select_count();

        eprintln!(
            "[{}] text_show={ts} with_speaker={sp} select={se} \
             dialogue_units={} choice_units={} dangling={dangling} \
             unresolved_dialogue={ud} unresolved_speaker={us} \
             text_bearing_choices={tbc} nontext_selects={nts}",
            game.subdir,
            dis.dialogue.len(),
            dis.choices.len(),
        );

        // Units mirror the scanned commands.
        assert_eq!(
            dis.dialogue.len(),
            ts,
            "{} dialogue unit count",
            game.subdir
        );
        assert_eq!(dis.choices.len(), se, "{} choice unit count", game.subdir);

        // Measured command counts match the recorded ground truth.
        assert_eq!(ts, game.text_show_count, "{} text-show count", game.subdir);
        assert_eq!(sp, game.with_speaker_count, "{} with-speaker", game.subdir);
        assert_eq!(se, game.select_count, "{} select count", game.subdir);
        // Encoding discriminators (see GAMES note). The mechanism-confirming
        // metric is the resolved count: real, translatable indirect labels.
        assert_eq!(
            indirect_candidates, game.indirect_candidate_count,
            "{} indirect-label candidate count",
            game.subdir
        );
        assert_eq!(
            indirect_resolved, game.indirect_resolved_count,
            "{} resolved indirect-label count",
            game.subdir
        );
        assert_eq!(
            tbc, game.text_bearing_choice_count,
            "{} text choices",
            game.subdir
        );
        assert_eq!(
            nts, game.nontext_select_count,
            "{} system selects",
            game.subdir
        );
        // Every select is accounted for as text-bearing or system (no dangling).
        assert_eq!(tbc + nts, se, "{} selects classified", game.subdir);

        // PROOF BAR: 100 % pointer resolution — ZERO dangling anywhere, and every
        // dialogue text + present speaker name pointer lands on an exact record
        // boundary. Out-of-pool system-select immediates are disclosed above.
        assert_eq!(dangling, 0, "{} zero dangling pointers", game.subdir);
        assert_eq!(ud, 0, "{} all dialogue text resolves", game.subdir);
        assert_eq!(us, 0, "{} all speaker pointers resolve", game.subdir);
        assert!(dis.is_fully_resolved(), "{} fully resolved", game.subdir);

        // Every unit's pointer field offset lies within SCRIPT.SRC (byte-locatable
        for d in &dis.dialogue {
            assert!(
                d.text.field_offset + 4 <= script_bytes.len(),
                "{} text ptr field in bounds",
                game.subdir
            );
            assert!(
                d.text.is_resolved(),
                "{} dialogue text resolved",
                game.subdir
            );
            if let Some(s) = &d.speaker {
                assert!(
                    s.field_offset + 4 <= script_bytes.len(),
                    "{} name ptr field in bounds",
                    game.subdir
                );
                assert!(s.is_resolved(), "{} speaker resolved", game.subdir);
            }
        }
        // Text-bearing choices resolve; system selects are out-of-pool.
        for c in &dis.choices {
            assert!(
                c.text.field_offset + 4 <= script_bytes.len(),
                "{} choice ptr field in bounds",
                game.subdir
            );
            assert!(
                c.text.is_resolved() || c.text.is_out_of_pool(),
                "{} choice is text-bearing or system (never dangling)",
                game.subdir
            );
        }
    }
}
