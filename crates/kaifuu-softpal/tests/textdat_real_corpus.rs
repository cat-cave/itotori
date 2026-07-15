//! Real-bytes validation of the Softpal `TEXT.DAT` codec against two owned
//! titles, extracting the inner `TEXT.DAT` via the crate's own PAC reader.
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. **No raw copyrighted bytes live in this file** — only record
//! counts, byte offsets, SJIS-valid-byte ratios, and SHA-256 hashes, which the
//! codec must reproduce.
//! Mirrors `pac_real_corpus.rs`: gated on `ITOTORI_SOFTPAL_RESEARCH_ROOT` (the
//! standalone Softpal research tree), NOT `ITOTORI_REAL_GAME_ROOT` /
//! `ITOTORI_VAULT_ROOT`, and deliberately not named `*_real_bytes.rs`.
//! Coverage across the two titles:
//! - **v21465** — `TEXT.DAT` byte 0 is `'$'` (**encrypted**): decrypt raises the
//!   SJIS-valid-byte ratio (~0.76 → ~0.91); re-encrypt round-trips byte-identical.
//! - **v60663** — `TEXT.DAT` byte 0 is `'_'` (**plaintext**): decrypt is a no-op;
//!   `decrypt(encrypt(plaintext))` still round-trips byte-identical.
//! - Both: header count == the number of records the pool actually yields, and
//!   each record's absolute byte offset is recovered.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{
    EncFlag, PacArchive, TextDat, TextDatHeader, decrypt, encrypt, parse_records,
};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

/// One game's `TEXT.DAT` expectations.
struct GameExpectation {
    subdir: &'static str,
    /// `PAC ` entry count, used to pick the right `data.pac`.
    pac_count: usize,
    /// Expected `TEXT.DAT` header flag.
    flag: EncFlag,
    /// Expected header record count (`u32` @ 0x0C) == records recovered.
    record_count: u32,
    /// SHA-256 of the raw (as-extracted) `TEXT.DAT`, oracle-verified.
    raw_sha256_hex: &'static str,
}

const GAMES: [GameExpectation; 2] = [
    GameExpectation {
        subdir: "v21465",
        pac_count: 417,
        flag: EncFlag::Encrypted,
        record_count: 51260,
        raw_sha256_hex: "03048a9e89d88768010515ec0316384f3e5eead7ecd355fe3f9e6f0c41423405",
    },
    GameExpectation {
        subdir: "v60663",
        pac_count: 160,
        flag: EncFlag::Plaintext,
        record_count: 70112,
        raw_sha256_hex: "237cd11590f06ffc9f84a114a4c7a450b1fb91d4d07f7051141e7b049f4b9e41",
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

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Fraction of body bytes that are SJIS/cp932-plausible: printable ASCII (plus
/// tab/CR/LF), half-width kana (0xA1..=0xDF), or a valid double-byte lead+trail
/// pair. Rises sharply when an encrypted pool is correctly decrypted.
fn sjis_valid_ratio(b: &[u8]) -> f64 {
    let mut ok = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        let single = matches!(c, 0x09 | 0x0A | 0x0D | 0x20..=0x7E) || (0xA1..=0xDF).contains(&c);
        if single {
            ok += 1;
            i += 1;
        } else if ((0x81..=0x9F).contains(&c) || (0xE0..=0xFC).contains(&c)) && i + 1 < b.len() {
            let t = b[i + 1];
            if (0x40..=0x7E).contains(&t) || (0x80..=0xFC).contains(&t) {
                ok += 2;
                i += 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    if b.is_empty() {
        return 0.0;
    }
    ok as f64 / b.len() as f64
}

/// Extract the `TEXT.DAT` bytes from the game's `data.pac` (selected by entry
/// count), via the crate's PAC reader.
fn extract_textdat(game: &GameExpectation, root: &Path) -> Vec<u8> {
    let game_dir = root.join(game.subdir);
    let mut pacs = Vec::new();
    find_data_pacs(&game_dir, &mut pacs);
    assert!(
        !pacs.is_empty(),
        "no data.pac found under {}",
        game_dir.display()
    );
    for pac_path in &pacs {
        let bytes = fs::read(pac_path).expect("read data.pac");
        let Ok(arc) = PacArchive::parse(&bytes) else {
            continue;
        };
        if arc.len() != game.pac_count {
            continue;
        }
        let entry = arc
            .find("TEXT.DAT")
            .expect("TEXT.DAT must be present in the index");
        return arc
            .extract(&bytes, entry)
            .expect("extract TEXT.DAT")
            .to_vec();
    }
    panic!(
        "no data.pac under {} parsed to {} entries",
        game_dir.display(),
        game.pac_count
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal research tree)"]
fn textdat_codec_on_two_softpal_titles() {
    let Some(root) = env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        panic!("set {RESEARCH_ROOT_ENV} to the read-only Softpal research tree");
    };

    for game in &GAMES {
        let raw = extract_textdat(game, &root);
        assert_eq!(
            sha256_hex(&raw),
            game.raw_sha256_hex,
            "{} raw TEXT.DAT must byte-match the PAC/oracle extraction",
            game.subdir
        );

        let header = TextDatHeader::parse(&raw).expect("parse header");
        assert_eq!(header.flag, game.flag, "{} enc flag", game.subdir);
        assert_eq!(
            header.record_count, game.record_count,
            "{} header record count",
            game.subdir
        );

        let plain = decrypt(&raw).expect("decrypt");
        assert_eq!(
            plain[0],
            EncFlag::Plaintext.as_byte(),
            "{} decrypt yields a plaintext header",
            game.subdir
        );

        let enc_ratio = sjis_valid_ratio(&raw[16..]);
        let dec_ratio = sjis_valid_ratio(&plain[16..]);
        match game.flag {
            EncFlag::Encrypted => {
                // Decryption sharply raises the SJIS-valid-byte ratio.
                assert!(
                    enc_ratio < 0.80,
                    "{} encrypted ratio {enc_ratio:.4} should be low",
                    game.subdir
                );
                assert!(
                    dec_ratio > 0.90,
                    "{} decrypted ratio {dec_ratio:.4} should be high",
                    game.subdir
                );
                assert!(
                    dec_ratio - enc_ratio > 0.10,
                    "{} decrypt must raise the ratio (enc {enc_ratio:.4} -> dec {dec_ratio:.4})",
                    game.subdir
                );
                // decrypt actually changed the pool.
                assert_ne!(&plain[16..], &raw[16..], "{} pool changed", game.subdir);
            }
            EncFlag::Plaintext => {
                // Plaintext: decrypt is a no-op and the pool is already clean.
                assert_eq!(&plain[16..], &raw[16..], "{} pool unchanged", game.subdir);
                assert!(
                    dec_ratio > 0.80,
                    "{} plaintext ratio {dec_ratio:.4} should already be high",
                    game.subdir
                );
            }
        }

        match game.flag {
            EncFlag::Encrypted => {
                // encrypt(decrypt(raw)) reproduces the original encrypted bytes.
                let re = encrypt(&plain).expect("re-encrypt");
                assert_eq!(
                    re, raw,
                    "{} encrypt(decrypt(x)) must be byte-identical",
                    game.subdir
                );
            }
            EncFlag::Plaintext => {
                // decrypt(encrypt(plaintext)) reproduces the original plaintext.
                let enc = encrypt(&raw).expect("encrypt");
                assert_eq!(
                    enc[0],
                    EncFlag::Encrypted.as_byte(),
                    "{} enc flag",
                    game.subdir
                );
                assert_ne!(
                    &enc[16..],
                    &raw[16..],
                    "{} encrypt changed pool",
                    game.subdir
                );
                let back = decrypt(&enc).expect("decrypt back");
                assert_eq!(
                    back, raw,
                    "{} decrypt(encrypt(x)) must be byte-identical",
                    game.subdir
                );
            }
        }

        let records = parse_records(&plain).expect("parse records");
        assert_eq!(
            records.len() as u32,
            header.record_count,
            "{} recovered record count == header count",
            game.subdir
        );

        // First record starts immediately after the 16-byte header, and every
        // record's offset is strictly increasing and in bounds.
        assert_eq!(records[0].offset, 16, "{} record 0 offset", game.subdir);
        let mut prev = None;
        for (i, r) in records.iter().enumerate() {
            assert_eq!(
                r.text_offset,
                r.offset + 4,
                "{} record {i} text_offset",
                game.subdir
            );
            assert!(
                r.text_offset <= plain.len(),
                "{} record {i} in bounds",
                game.subdir
            );
            if let Some(p) = prev {
                assert!(
                    r.offset > p,
                    "{} record {i} offset strictly increasing",
                    game.subdir
                );
            }
            prev = Some(r.offset);
        }

        // The all-in-one entry point agrees with the piecewise calls.
        let td = TextDat::parse(&raw).expect("TextDat::parse");
        assert_eq!(td.header, header, "{} TextDat header", game.subdir);
        assert_eq!(
            td.records.len(),
            records.len(),
            "{} TextDat record count",
            game.subdir
        );
    }
}
