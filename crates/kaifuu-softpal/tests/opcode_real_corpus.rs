//! Real-bytes validation of the Softpal `SCRIPT.SRC` **full opcode catalog**
//! against two owned titles, extracting `SCRIPT.SRC` from each `data.pac` via
//! the crate's own PAC reader.
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. **No raw copyrighted text/bytes live in this file** — only
//! opcode/command counts, histograms, and the 0-unknown accounting, which the
//! catalog must reproduce.
//! PROOF BAR: the arity-driven walk is **exhaustive** — it types every command
//! with **0 unknown** operator tokens, **0** truncated final command, and **0**
//! trailing bytes (every byte of the token stream accounted for), on both
//! titles. It must also reproduce the disassembler's TEXT-SHOW / SELECT counts
//! exactly (consistency across the two SCRIPT.SRC surfaces).

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{OpcodeScan, PacArchive, ScriptScan};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

/// One game's opcode-catalog expectations. Counts are the measured ground truth.
struct GameExpectation {
    subdir: &'static str,
    /// `PAC ` entry count, used to select the right `data.pac`.
    pac_count: usize,
    /// TEXT-SHOW (dialogue) command count — must match [`ScriptScan`].
    text_show_count: usize,
    /// SELECT (choice) command count — must match [`ScriptScan`].
    select_count: usize,
    /// Total `Call` (opcode 0x17) instruction count.
    call_count: usize,
    /// Distinct `Call` `(category, function)` dispatch targets.
    call_target_count: usize,
    /// Distinct opcode ids observed (of the 33-entry 0x01..=0x21 table).
    distinct_opcodes: usize,
    /// Total typed instruction count.
    instruction_count: usize,
}

const GAMES: [GameExpectation; 2] = [
    // v21465 — Kizuna kirameku koi iroha.
    GameExpectation {
        subdir: "v21465",
        pac_count: 417,
        text_show_count: 30165,
        select_count: 11,
        call_count: 72245,
        call_target_count: 420,
        distinct_opcodes: 33,
        instruction_count: 561463,
    },
    // v60663 — Dimension totsu lovers.
    GameExpectation {
        subdir: "v60663",
        pac_count: 160,
        text_show_count: 39832,
        select_count: 21,
        call_count: 79378,
        call_target_count: 498,
        distinct_opcodes: 33,
        instruction_count: 734961,
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

/// Extract one named entry from the game's `data.pac` (selected by entry count).
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
fn opcode_catalog_on_two_softpal_titles() {
    let Some(root) = env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        panic!("set {RESEARCH_ROOT_ENV} to the read-only Softpal research tree");
    };

    for game in &GAMES {
        let script_bytes = extract_entry(game, &root, "SCRIPT.SRC");

        let scan = OpcodeScan::parse(&script_bytes)
            .unwrap_or_else(|e| panic!("{} opcode catalog: {e}", game.subdir));
        assert_eq!(
            &scan.header.version[..2],
            b"20",
            "{} Sv version",
            game.subdir
        );

        let opcode_hist = scan.opcode_histogram();
        let tag_hist = scan.operand_tag_histogram();
        let cat_hist = scan.call_category_histogram();
        let semantic_names = scan
            .instructions
            .iter()
            .filter_map(kaifuu_softpal::Instruction::call_target)
            .filter_map(|target| target.semantic_name())
            .collect::<BTreeSet<_>>();

        eprintln!(
            "[{}] instructions={} tokens={} unknown={} truncated_final={} trailing_bytes={} \
             text_show={} select={} call={} call_targets={} distinct_opcodes={}",
            game.subdir,
            scan.instructions.len(),
            scan.token_count(),
            scan.unknown_count(),
            scan.truncated_final,
            scan.trailing_bytes,
            scan.text_show_count(),
            scan.select_count(),
            scan.call_count(),
            scan.call_target_count(),
            opcode_hist.len(),
        );
        eprintln!("[{}] opcode histogram: {opcode_hist:?}", game.subdir);
        eprintln!("[{}] operand-tag histogram: {tag_hist:?}", game.subdir);
        eprintln!("[{}] call-category histogram: {cat_hist:?}", game.subdir);
        eprintln!(
            "[{}] evidenced call semantics: {semantic_names:?}",
            game.subdir
        );

        // PROOF BAR: exhaustive, 0-unknown walk — every command typed, every byte
        // of the token stream accounted for.
        assert_eq!(
            scan.unknown_count(),
            0,
            "{} zero unknown opcodes",
            game.subdir
        );
        assert!(
            !scan.truncated_final,
            "{} no truncated final command",
            game.subdir
        );
        assert_eq!(scan.trailing_bytes, 0, "{} no trailing bytes", game.subdir);
        assert!(scan.is_exhaustive(), "{} exhaustive catalog", game.subdir);

        // Every instruction consumed lies within the header..EOF window, in
        // strictly ascending play order; operand fields are byte-locatable.
        let mut prev: Option<usize> = None;
        for ins in &scan.instructions {
            if let Some(p) = prev {
                assert!(ins.offset > p, "{} instructions in play order", game.subdir);
            }
            prev = Some(ins.offset);
            for o in ins.operands() {
                assert!(
                    o.field_offset + 4 <= script_bytes.len(),
                    "{} operand field in bounds",
                    game.subdir
                );
            }
        }

        // Every observed opcode id is in the known 0x01..=0x21 table.
        for id in opcode_hist.keys() {
            assert!(
                (0x01..=0x0021).contains(id),
                "{} opcode {id:#x} in table",
                game.subdir
            );
        }

        // Recorded ground-truth counts.
        assert_eq!(
            scan.instructions.len(),
            game.instruction_count,
            "{} instruction count",
            game.subdir
        );
        assert_eq!(
            scan.text_show_count(),
            game.text_show_count,
            "{} text-show count",
            game.subdir
        );
        assert_eq!(
            scan.select_count(),
            game.select_count,
            "{} select count",
            game.subdir
        );
        assert_eq!(
            scan.call_count(),
            game.call_count,
            "{} call count",
            game.subdir
        );
        assert_eq!(
            scan.call_target_count(),
            game.call_target_count,
            "{} call-target count",
            game.subdir
        );

        // These names come from the game executable's `(category, function)`
        // registration table and the selected handler's named Pal.dll import.
        // Every one is exercised by both real titles; this guards the actual
        // decoder catalog, not a synthetic CallTarget fixture.
        for name in [
            "message.show",
            "choice.select",
            "sprite.set_option",
            "sound.set_volume",
            "button.create",
            "video.play",
            "fx.set",
            "random.next",
            "effect.execute",
            "input.get_key_ex",
        ] {
            assert!(
                semantic_names.contains(name),
                "{} must exercise evidenced semantic {name}",
                game.subdir
            );
        }
        assert_eq!(
            opcode_hist.len(),
            game.distinct_opcodes,
            "{} distinct opcodes",
            game.subdir
        );

        // CONSISTENCY with the existing disassembler: the opcode catalog's
        // TEXT-SHOW / SELECT counts equal the marker-scan disassembler's.
        let dis_scan = ScriptScan::parse(&script_bytes)
            .unwrap_or_else(|e| panic!("{} disassembler scan: {e}", game.subdir));
        assert_eq!(
            scan.text_show_count(),
            dis_scan.text_show_count(),
            "{} TEXT-SHOW matches disassembler",
            game.subdir
        );
        assert_eq!(
            scan.select_count(),
            dis_scan.select_count(),
            "{} SELECT matches disassembler",
            game.subdir
        );

        // Token accounting is exact: header + every token = input length.
        assert_eq!(
            kaifuu_softpal::SV_PROGRAM_HEADER_BYTE_LEN
                + scan.token_count() * kaifuu_softpal::SV_TOKEN_BYTE_LEN,
            script_bytes.len(),
            "{} exact byte coverage",
            game.subdir
        );
    }
}
