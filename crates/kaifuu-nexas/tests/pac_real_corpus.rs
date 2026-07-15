//! Real-bytes validation of the NeXAS PAC reader against Majikoi (*Maji de
//! Watashi ni Koi Shinasai!*), a byte-verified NeXAS title.
//! `#[ignore]`d and env-gated: set `ITOTORI_NEXAS_RESEARCH_ROOT` to a READ-ONLY
//! directory holding the extracted `Config.pac` and `Script.pac` (e.g.
//! `/scratch/nexas-majikoi`) and run with `--ignored`. No raw copyrighted bytes
//! live in this file — only entry counts, offsets, sizes, and SHA-256 hashes,
//! which the reader must reproduce.
//! ```text
//! ITOTORI_NEXAS_RESEARCH_ROOT=/scratch/nexas-majikoi \
//! cargo test -p kaifuu-nexas --test pac_real_corpus -- --ignored --nocapture
//! # Oracle
//! The format is a clean-room port of GARbro's `ArcFormats/Nexas/ArcPAC.cs`.
//! Every Majikoi archive is `pack_type=3` (zlib-Deflate) with the tail Huffman
//! index. Two independent in-band oracles corroborate the extraction on the real
//! bytes: (1) GARbro's own tail-index sanity bound accepts the recovered index,
//! and (2) every entry's zlib stream carries an Adler-32 checksum of the
//! *original* bytes, which this reader's inflater verifies, and every entry
//! decompresses to exactly the index-declared unpacked size. The
//! per-archive concatenated-payload SHA-256 below pins the exact bytes.

use std::path::PathBuf;

use kaifuu_nexas::{Compression, IndexLayout, PacArchive};
use sha2::{Digest, Sha256};

const RESEARCH_ROOT_ENV: &str = "ITOTORI_NEXAS_RESEARCH_ROOT";

struct ArchiveExpectation {
    file: &'static str,
    count: usize,
    entry0_name: &'static str,
    entry0_offset: u32,
    entry0_size: u32,
    entry0_unpacked: u32,
    /// SHA-256 over the concatenation of every extracted (decompressed) payload,
    /// in index order.
    concat_sha256_hex: &'static str,
    total_unpacked: u64,
}

const ARCHIVES: [ArchiveExpectation; 2] = [
    ArchiveExpectation {
        file: "Config.pac",
        count: 19,
        entry0_name: "configstring.dat",
        entry0_offset: 12,
        entry0_size: 104,
        entry0_unpacked: 236,
        concat_sha256_hex: "24d016ef809079e8fd7c37be64676aefd909cdb830b99640b8574f082440f235",
        total_unpacked: 1_590_614,
    },
    ArchiveExpectation {
        file: "Script.pac",
        count: 27,
        entry0_name: "replayseen.bin",
        entry0_offset: 12,
        entry0_size: 280_554,
        entry0_unpacked: 1_508_059,
        concat_sha256_hex: "c20cb464f3fb9e1d40c377ae888439a6bb22270f370aadb1cf1ea383daacf6b5",
        total_unpacked: 32_374_214,
    },
];

fn require_corpus_root() -> Option<PathBuf> {
    let root = std::env::var(RESEARCH_ROOT_ENV).ok()?;
    let path = PathBuf::from(root);
    path.is_dir().then_some(path)
}

#[test]
#[ignore = "requires ITOTORI_NEXAS_RESEARCH_ROOT with extracted Majikoi PACs"]
fn extracts_majikoi_pacs_byte_exact() {
    let Some(root) = require_corpus_root() else {
        eprintln!("{RESEARCH_ROOT_ENV} not set / not a dir; skipping real-bytes NeXAS validation");
        return;
    };

    for expected in &ARCHIVES {
        let path = root.join(expected.file);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let arc = PacArchive::parse(&bytes).expect("real NeXAS PAC must parse");

        assert_eq!(arc.len(), expected.count, "{} entry count", expected.file);
        assert_eq!(
            arc.pack_type(),
            Compression::Deflate,
            "{} pack_type",
            expected.file
        );
        assert_eq!(
            arc.index_layout(),
            IndexLayout::TailHuffman,
            "{} index layout",
            expected.file
        );

        let e0 = &arc.entries()[0];
        assert_eq!(
            e0.name, expected.entry0_name,
            "{} entry0 name",
            expected.file
        );
        assert_eq!(e0.offset, expected.entry0_offset);
        assert_eq!(e0.size, expected.entry0_size);
        assert_eq!(e0.unpacked_size, expected.entry0_unpacked);

        let mut concat = Sha256::new();
        let mut total = 0u64;
        for entry in arc.entries() {
            let payload = arc
                .extract(&bytes, entry)
                .unwrap_or_else(|e| panic!("extract {} from {}: {e}", entry.name, expected.file));
            // The reader already enforces `payload.len == unpacked_size` and
            // verifies each zlib Adler-32; re-assert the size for clarity.
            assert_eq!(
                payload.len() as u32,
                entry.unpacked_size,
                "{}/{} decompressed size",
                expected.file,
                entry.name
            );
            total += payload.len() as u64;
            concat.update(&payload);
        }
        assert_eq!(
            total, expected.total_unpacked,
            "{} total unpacked",
            expected.file
        );
        let digest = format!("{:x}", concat.finalize());
        assert_eq!(
            digest, expected.concat_sha256_hex,
            "{} concatenated-payload SHA-256",
            expected.file
        );
        eprintln!(
            "{}: {} entries, {} bytes decompressed, concat-sha256 {} OK",
            expected.file, expected.count, total, digest
        );
    }
}
