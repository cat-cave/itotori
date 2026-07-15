//! Real-bytes validation of the Softpal **patch-back** against two owned titles,
//! extracting `SCRIPT.SRC` + `TEXT.DAT` from the same `data.pac` via the crate's
//! own PAC reader.
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. **No raw copyrighted text lives in this file** — only counts,
//! offsets, SHA-256 digests, and short ASCII/kana strings *we* inject.
//! PROOF BAR (both titles):
//! 1. IDENTITY round-trip — patch-back with an EMPTY translation map rebuilds a
//!    `TEXT.DAT` + `SCRIPT.SRC` that are BYTE-IDENTICAL (SHA-256) to the
//!    originals (lossless rebuild + repoint + re-encrypt).
//! 2. REAL translation — replace a handful of in-scope dialogue records with
//!    known strings, then RE-DECODE the patched pair: the translated strings
//!    appear at those units, 100 % pointer resolution is preserved (0 dangling,
//!    fully resolved), and out-of-scope units are unchanged.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{
    EncFlag, PacArchive, ScriptScan, TextDat, TextDatHeader, TranslationMap, patchback,
};
use sha2::{Digest, Sha256};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

struct Game {
    subdir: &'static str,
    pac_count: usize,
    /// Expected `TEXT.DAT` encryption flag ($ encrypted vs _ plaintext).
    flag: EncFlag,
    /// Expected TEXT-SHOW (dialogue) command count (from the disassembler node).
    text_show_count: usize,
}

const GAMES: [Game; 2] = [
    Game {
        subdir: "v21465",
        pac_count: 417,
        flag: EncFlag::Encrypted,
        text_show_count: 30165,
    },
    Game {
        subdir: "v60663",
        pac_count: 160,
        flag: EncFlag::Plaintext,
        text_show_count: 39832,
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

fn extract_entry(game: &Game, root: &Path, name: &str) -> Vec<u8> {
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

fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal research tree)"]
fn patchback_on_two_softpal_titles() {
    let Some(root) = env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        panic!("set {RESEARCH_ROOT_ENV} to the read-only Softpal research tree");
    };

    for game in &GAMES {
        let textdat_bytes = extract_entry(game, &root, "TEXT.DAT");
        let script_bytes = extract_entry(game, &root, "SCRIPT.SRC");

        // Sanity: the original decodes fully (matches the disassembler node).
        let orig_flag = TextDatHeader::parse(&textdat_bytes).unwrap().flag;
        assert_eq!(orig_flag, game.flag, "{} TEXT.DAT flag", game.subdir);
        let orig_td = TextDat::parse(&textdat_bytes).unwrap();
        let orig_scan = ScriptScan::parse(&script_bytes).unwrap();
        let orig_dis = orig_scan.resolve(&orig_td);
        assert!(
            orig_dis.is_fully_resolved(),
            "{} original fully resolves",
            game.subdir
        );
        assert_eq!(
            orig_dis.dialogue.len(),
            game.text_show_count,
            "{} dialogue count",
            game.subdir
        );

        let td_sha = sha256(&textdat_bytes);
        let sc_sha = sha256(&script_bytes);
        let identity = patchback(&textdat_bytes, &script_bytes, &TranslationMap::new()).unwrap();
        assert_eq!(identity.flag, game.flag);
        assert_eq!(identity.translated_record_count, 0);
        assert_eq!(
            sha256(&identity.textdat),
            td_sha,
            "{} identity TEXT.DAT byte-identical",
            game.subdir
        );
        assert_eq!(
            sha256(&identity.script),
            sc_sha,
            "{} identity SCRIPT.SRC byte-identical",
            game.subdir
        );
        assert_eq!(
            identity.textdat, textdat_bytes,
            "{} TEXT.DAT bytes equal",
            game.subdir
        );
        assert_eq!(
            identity.script, script_bytes,
            "{} SCRIPT.SRC bytes equal",
            game.subdir
        );
        eprintln!(
            "[{}] IDENTITY ok: flag={:?} records={} repointed_fields={} textdat_sha={} script_sha={}",
            game.subdir,
            game.flag,
            identity.offset_map.len(),
            identity.repointed_field_count,
            &td_sha[..16],
            &sc_sha[..16],
        );

        // Pick the first few DISTINCT dialogue text records; translate each to a
        // known ASCII marker string. Record their pointers + the untranslated
        // neighbours we will assert stay unchanged.
        let mut chosen: Vec<u32> = Vec::new();
        for d in &orig_dis.dialogue {
            let p = d.text.pointer;
            if !chosen.contains(&p) {
                chosen.push(p);
            }
            if chosen.len() == 5 {
                break;
            }
        }
        assert_eq!(chosen.len(), 5, "{} five distinct records", game.subdir);

        let mut translations = TranslationMap::new();
        let expected: Vec<(u32, String)> = chosen
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                // Deliberately LONGER than typical so downstream offsets shift and
                // repointing is exercised on real bytes.
                let s = format!("ITOTORI_PATCH_UNIT_{i}_translated_and_padded_out");
                translations.insert(p, s.clone());
                (p, s)
            })
            .collect();

        let patched = patchback(&textdat_bytes, &script_bytes, &translations).unwrap();
        assert_eq!(patched.translated_record_count, 5, "{}", game.subdir);
        // The pool changed; the script changed (downstream pointers moved).
        assert_ne!(sha256(&patched.textdat), td_sha, "{}", game.subdir);
        assert_ne!(sha256(&patched.script), sc_sha, "{}", game.subdir);
        // Re-encryption preserved the flag.
        assert_eq!(
            TextDatHeader::parse(&patched.textdat).unwrap().flag,
            game.flag,
            "{} patched flag",
            game.subdir
        );

        // RE-DECODE the patched pair and prove integrity + content.
        let new_td = TextDat::parse(&patched.textdat).unwrap();
        let new_scan = ScriptScan::parse(&patched.script).unwrap();
        let new_dis = new_scan.resolve(&new_td);

        // 100 % pointer resolution preserved.
        assert_eq!(
            new_dis.dangling_pointer_count(),
            0,
            "{} zero dangling post-patch",
            game.subdir
        );
        assert!(
            new_dis.is_fully_resolved(),
            "{} fully resolved post-patch",
            game.subdir
        );
        // Same number of dialogue/choice units (structure unchanged).
        assert_eq!(
            new_dis.dialogue.len(),
            orig_dis.dialogue.len(),
            "{}",
            game.subdir
        );
        assert_eq!(
            new_dis.choices.len(),
            orig_dis.choices.len(),
            "{}",
            game.subdir
        );
        assert_eq!(
            new_td.header.record_count, orig_td.header.record_count,
            "{}",
            game.subdir
        );

        // The translated strings appear at exactly the chosen records.
        let want: std::collections::HashMap<u32, &str> =
            expected.iter().map(|(p, s)| (*p, s.as_str())).collect();
        let mut hit = 0usize;
        for (old, new) in orig_dis.dialogue.iter().zip(new_dis.dialogue.iter()) {
            let op = old.text.pointer;
            if let Some(exp) = want.get(&op) {
                assert_eq!(
                    new.text.resolved_text(),
                    Some(*exp),
                    "{} translated unit content",
                    game.subdir
                );
                hit += 1;
            } else {
                // Out-of-scope dialogue: text unchanged (may be repointed, same string).
                assert_eq!(
                    new.text.resolved_text(),
                    old.text.resolved_text(),
                    "{} out-of-scope dialogue unchanged",
                    game.subdir
                );
            }
            // Speakers were never in scope: unchanged content on both sides.
            assert_eq!(
                new.speaker.as_ref().and_then(|s| s.resolved_text()),
                old.speaker.as_ref().and_then(|s| s.resolved_text()),
                "{} speaker unchanged",
                game.subdir
            );
        }
        assert_eq!(hit, 5, "{} all five translations landed", game.subdir);

        // Choices unchanged (not in scope for this translation).
        for (old, new) in orig_dis.choices.iter().zip(new_dis.choices.iter()) {
            assert_eq!(
                new.text.resolved_text(),
                old.text.resolved_text(),
                "{} choice unchanged",
                game.subdir
            );
        }

        eprintln!(
            "[{}] REAL-TRANSLATION ok: translated=5 repointed_fields={} \
             dialogue={} choices={} dangling=0 fully_resolved=true",
            game.subdir,
            patched.repointed_field_count,
            new_dis.dialogue.len(),
            new_dis.choices.len(),
        );
    }
}
