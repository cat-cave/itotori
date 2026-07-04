//! Real-bytes validation of the Softpal `SCRIPT.SRC` dialogue disassembler
//! against two owned titles, extracting both `SCRIPT.SRC` and `TEXT.DAT` from
//! the same `data.pac` via the crate's own PAC reader.
//!
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. **No raw copyrighted text lives in this file** — only command
//! counts, the 100 %-pointer-resolution result, and byte offsets, which the
//! disassembler must reproduce.
//!
//! PROOF BAR: every extracted dialogue/choice **text** pointer and every present
//! **speaker name** pointer must resolve to an *exact* `TEXT.DAT` record
//! boundary (0 dangling) — full pointer resolution, both titles.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{PacArchive, ScriptScan, TextDat};

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
}

const GAMES: [GameExpectation; 2] = [
    // v21465 — SELECT immediates are text pointers (all 11 choices resolve).
    GameExpectation {
        subdir: "v21465",
        pac_count: 417,
        text_show_count: 30165,
        with_speaker_count: 19990,
        select_count: 11,
        text_bearing_choice_count: 11,
        nontext_select_count: 0,
    },
    // v60663 — SELECTs are system/branch ops (immediate 0x40000000, no inline
    // text); the choice labels are decoupled from the opcode in this variant.
    GameExpectation {
        subdir: "v60663",
        pac_count: 160,
        text_show_count: 39832,
        with_speaker_count: 28665,
        select_count: 21,
        text_bearing_choice_count: 0,
        nontext_select_count: 21,
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
        // for patch-back); dialogue text + speakers all resolve to records.
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
