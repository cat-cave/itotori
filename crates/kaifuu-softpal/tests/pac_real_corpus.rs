//! Real-bytes validation of the Softpal PAC reader against two owned titles.
//! `#[ignore]`d and env-gated: set `ITOTORI_SOFTPAL_RESEARCH_ROOT` to the
//! READ-ONLY research tree (e.g. `/scratch/softpal-research`) and run with
//! `--ignored`. No raw copyrighted bytes live in this file — only entry
//! counts, offsets, sizes, and SHA-256 hashes, which the reader must
//! reproduce. The extracted `SCRIPT.SRC` / `TEXT.DAT` hashes were verified
//! byte-for-byte against the GARbro / SoftPal-Tool `pac_unpack.py` oracle.
//! Deliberately NOT named `*_real_bytes.rs` and NOT gated on
//! `ITOTORI_REAL_GAME_ROOT` / `ITOTORI_VAULT_ROOT`: this crate's corpus is the
//! standalone Softpal research tree, not the RealLive/vault periodic-oracle
//! lane. Wiring Softpal into the periodic oracle is a separate follow-up.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{PacArchive, PacEntry};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

/// One inner-file expectation: name, on-disk size, absolute offset, and the
/// SHA-256 of the extracted payload (oracle-verified).
struct FileExpectation {
    name: &'static str,
    size: u32,
    offset: u32,
    sha256_hex: &'static str,
}

/// One game's `data.pac` expectations.
struct GameExpectation {
    /// Subdirectory of the research root to search under.
    subdir: &'static str,
    /// `PAC ` file count (`u32` @ 0x08).
    count: usize,
    /// Entry-0 name / size / absolute offset (also equals the index end).
    entry0: (&'static str, u32, u32),
    /// The two script/text inner files this node cares about.
    files: [FileExpectation; 2],
}

const GAMES: [GameExpectation; 2] = [
    GameExpectation {
        subdir: "v21465",
        count: 417,
        entry0: ("ANI_ANGEL_STAND.ANI", 47, 18732),
        files: [
            FileExpectation {
                name: "SCRIPT.SRC",
                size: 5_273_068,
                offset: 666_306,
                sha256_hex: "3aa40d6cdc6df0d6874e47b5692ada24fc85c00694e609e519f68065ee68cbca",
            },
            FileExpectation {
                name: "TEXT.DAT",
                size: 2_014_562,
                offset: 5_939_759,
                sha256_hex: "03048a9e89d88768010515ec0316384f3e5eead7ecd355fe3f9e6f0c41423405",
            },
        ],
    },
    GameExpectation {
        subdir: "v60663",
        count: 160,
        entry0: ("ANI_ANGEL_STAND.ANI", 47, 8452),
        files: [
            FileExpectation {
                name: "SCRIPT.SRC",
                size: 6_954_384,
                offset: 1_000_148,
                sha256_hex: "280ffddc9ed13de380ea94832b621a5e17e0ff2381b329a8f5a2db8364c0095a",
            },
            FileExpectation {
                name: "TEXT.DAT",
                size: 2_148_954,
                offset: 7_954_532,
                sha256_hex: "237cd11590f06ffc9f84a114a4c7a450b1fb91d4d07f7051141e7b049f4b9e41",
            },
        ],
    },
];

/// Recursively collect every path named `data.pac` under `dir`.
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

/// Minimal SHA-256 (test-local; the reader itself takes no hash dependency).
fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn assert_inner_file(arc: &PacArchive, pac_bytes: &[u8], exp: &FileExpectation) {
    let entry: &PacEntry = arc
        .find(exp.name)
        .unwrap_or_else(|| panic!("{} must be present in the index", exp.name));
    assert_eq!(entry.size, exp.size, "{} size", exp.name);
    assert_eq!(entry.offset, exp.offset, "{} offset", exp.name);

    let payload = arc
        .extract(pac_bytes, entry)
        .unwrap_or_else(|e| panic!("extract {} failed: {e}", exp.name));
    assert_eq!(
        payload.len(),
        exp.size as usize,
        "{} extracted len",
        exp.name
    );
    assert_eq!(
        sha256_hex(payload),
        exp.sha256_hex,
        "{} extracted bytes must byte-match the GARbro oracle (sha256)",
        exp.name
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal research tree)"]
fn enumerates_and_extracts_two_softpal_titles() {
    let Some(root) = env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        panic!("set {RESEARCH_ROOT_ENV} to the read-only Softpal research tree");
    };

    for game in &GAMES {
        let game_dir = root.join(game.subdir);
        let mut pacs = Vec::new();
        find_data_pacs(&game_dir, &mut pacs);
        assert!(
            !pacs.is_empty(),
            "no data.pac found under {}",
            game_dir.display()
        );

        // Select the data.pac whose parsed count matches this game (the v21465
        // tree also contains csv.pac / system.pac siblings, but only one
        // data.pac with the expected 417-entry index).
        let mut matched: Option<(PathBuf, PacArchive, Vec<u8>)> = None;
        for pac_path in &pacs {
            let bytes = fs::read(pac_path).expect("read data.pac");
            let Ok(arc) = PacArchive::parse(&bytes) else {
                continue;
            };
            if arc.len() == game.count {
                matched = Some((pac_path.clone(), arc, bytes));
                break;
            }
        }
        let (pac_path, arc, bytes) = matched.unwrap_or_else(|| {
            panic!(
                "no data.pac under {} parsed to {} entries",
                game_dir.display(),
                game.count
            )
        });

        // Count.
        assert_eq!(
            arc.len(),
            game.count,
            "{} entry count ({})",
            game.subdir,
            pac_path.display()
        );

        // Entry-0 (its offset also equals the index end — cross-checked by the
        // reader itself).
        let (e0_name, e0_size, e0_off) = game.entry0;
        let first = &arc.entries()[0];
        assert_eq!(first.name, e0_name, "{} entry-0 name", game.subdir);
        assert_eq!(first.size, e0_size, "{} entry-0 size", game.subdir);
        assert_eq!(first.offset, e0_off, "{} entry-0 offset", game.subdir);

        // SCRIPT.SRC + TEXT.DAT present, sane, and byte-identical to the oracle.
        for exp in &game.files {
            assert_inner_file(&arc, &bytes, exp);
        }

        // Every entry's payload lies within the archive (reader invariant, but
        // assert it holds over the whole real index too).
        for entry in arc.entries() {
            let end = entry.offset as usize + entry.size as usize;
            assert!(
                end <= bytes.len(),
                "{} entry {:?} runs past EOF",
                game.subdir,
                entry.name
            );
        }
    }
}
