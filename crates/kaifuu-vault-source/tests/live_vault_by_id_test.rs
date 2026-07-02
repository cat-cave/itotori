//! Live by-id resolution proof against the real read-only `/archive/vault`.
//!
//! `#[ignore]`d by default; run explicitly with the live vault:
//!
//! ```text
//! ITOTORI_VAULT_ROOT=/archive/vault \
//!   cargo test -p kaifuu-vault-source \
//!   --test live_vault_by_id_test -- --ignored --nocapture
//! ```
//!
//! Resolves Oshioki Sweetie HD and Kanon BY-ID, materialises their RealLive
//! trees into a throwaway scratch dir, and asserts the extracted `Seen.txt`
//! per-file sha256 (NEVER the archive/repack sha). Strictly read-only: a
//! scratch override keeps every write outside the vault.

use std::path::{Path, PathBuf};

use kaifuu_reallive::{
    RealLiveOpcode, SceneHeader, decompress_avg32, parse_archive, parse_real_bytecode,
};
use kaifuu_vault_source::{
    ClaimQuery, LocalCorpusSource, MaterializeOptions, RunOutcome, ScratchConfig, VaultConfig,
    VaultSource,
};
use sha2::{Digest, Sha256};

const SWEETIE_CANONICAL_ID: &str =
    "oshioki-sweetie-koi-suru-onee-san-wa-urahara-desu.vj013077.v1-0.ja";
const SWEETIE_SEEN_SHA256: &str =
    "903f538b821a9b1e6cb3d399582915c0bcf73b0a058ecc907caf6017a4fa209f";
const KANON_CANONICAL_ID: &str = "kanon.v33";

fn require_live_vault() -> Option<PathBuf> {
    let root = std::env::var("ITOTORI_VAULT_ROOT").ok()?;
    if root != "/archive/vault" {
        return None;
    }
    Some(PathBuf::from(root))
}

/// A throwaway scratch root that lives OUTSIDE the vault (large extractions:
/// prefer a real disk, not tmpfs). Each call returns a DISTINCT directory:
/// tests in this binary run in parallel (cargo default), and every test
/// `rm -rf`s its own scratch dir on the way out. A `run-{pid}`-only path is
/// shared across tests in the same process, so one test's cleanup would
/// clobber another's in-flight extraction (observed as a spurious
/// "incomplete extraction"). The per-call atomic counter guarantees each
/// test owns a disjoint dir and only removes its own.
fn scratch_base() -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let base = std::env::var("ITOTORI_SCRATCH_ROOT").map_or_else(
        |_| PathBuf::from("/scratch/itotori-vault-by-id-test"),
        PathBuf::from,
    );
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let unique = base.join(format!("run-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&unique).expect("create scratch base");
    unique
}

fn find_named(root: &Path, target_lower: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(target_lower))
            {
                return Some(p);
            }
        }
    }
    None
}

fn sha256_file(path: &Path) -> String {
    use std::fmt::Write as _;
    let bytes = std::fs::read(path).expect("read seen file");
    let mut h = Sha256::new();
    h.update(&bytes);
    let d = h.finalize();
    let mut s = String::with_capacity(64);
    for b in &d {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Materialise a title by its canonical id, find its `Seen.txt`/`SEEN.TXT`,
/// and return its sha256. Cleans up scratch on the way out.
fn materialize_and_hash_seen(canonical_id: &str, scratch_root: &Path) -> String {
    let source = VaultSource::open(
        &VaultConfig::default(),
        &ScratchConfig {
            scratch_root_override: Some(scratch_root.to_path_buf()),
        },
    )
    .expect("open live vault");

    let candidate = source
        .discover(&ClaimQuery::ByCanonicalId {
            canonical_id: canonical_id.to_string(),
        })
        .expect("discover by canonical_id")
        .into_iter()
        .next()
        .expect("at least one release for canonical_id");

    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .expect("materialize by-id");

    assert_eq!(
        mat.artifact_canonical_id, canonical_id,
        "resolved canonical_id must match the requested by-id key"
    );
    assert!(
        mat.tree_root.join("_vault/metadata.json").exists(),
        "embedded _vault/metadata.json present under the canonical_id wrapper"
    );
    assert_eq!(
        mat.embedded.canonical_id.as_deref(),
        Some(canonical_id),
        "embedded canonical_id identity matches"
    );

    let seen = find_named(&mat.tree_root, "seen.txt")
        .unwrap_or_else(|| panic!("Seen.txt not found under {}", mat.tree_root.display()));
    let sha = sha256_file(&seen);

    source
        .release(&mat, RunOutcome::Success)
        .expect("release scratch");
    sha
}

#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn resolves_sweetie_hd_by_id_and_seen_txt_matches_known_bytes() {
    let Some(_vault) = require_live_vault() else {
        eprintln!("skipping: set ITOTORI_VAULT_ROOT=/archive/vault to run this proof");
        return;
    };
    let scratch = scratch_base();
    let sha = materialize_and_hash_seen(SWEETIE_CANONICAL_ID, &scratch);
    let _ = std::fs::remove_dir_all(&scratch);
    eprintln!("[sweetie] by-id -> Seen.txt sha256 = {sha}");
    assert_eq!(
        sha, SWEETIE_SEEN_SHA256,
        "Sweetie HD by-id Seen.txt sha256 must equal the known direct-path bytes"
    );
}

#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn resolves_kanon_by_id_and_materializes_reallive_tree() {
    let Some(_vault) = require_live_vault() else {
        eprintln!("skipping: set ITOTORI_VAULT_ROOT=/archive/vault to run this proof");
        return;
    };
    let scratch = scratch_base();

    let source = VaultSource::open(
        &VaultConfig::default(),
        &ScratchConfig {
            scratch_root_override: Some(scratch.clone()),
        },
    )
    .expect("open live vault");

    // By-id discovery + resolution MUST succeed for Kanon.
    let candidate = source
        .discover(&ClaimQuery::ByCanonicalId {
            canonical_id: KANON_CANONICAL_ID.to_string(),
        })
        .expect("discover Kanon by canonical_id")
        .into_iter()
        .next()
        .expect("at least one release for kanon.v33");
    eprintln!(
        "[kanon] by-id resolved: release_id={} (canonical_id={KANON_CANONICAL_ID})",
        candidate.release_id
    );

    // Materialize. Kanon's by-id archive layers a Delta filter on top of a
    // BCJ2 coder (`Method = Delta BCJ2`). sevenz-rust2 <= 0.21.1 could not
    // decode that multi-coder folder and the decode loop returned `Ok(())`
    // having silently skipped its entries; the `verify_complete_extraction`
    // guard then turned that partial tree into a typed `ExtractionFailed`.
    // sevenz-rust2 0.21.2 (upstream PR #117) decodes Delta+BCJ2 folders, so a
    // complete materialize is now REQUIRED — a full `Ok(mat)` here *is* the
    // proof that `verify_complete_extraction` passed (every archive-declared
    // file entry landed on disk; missing == 0). The guard is kept as
    // defence-in-depth against any future silent-skip regression.
    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .expect(
            "Kanon (Delta+BCJ2) must materialize COMPLETELY from the vault by-id with \
             sevenz-rust2 0.21.2 (PR #117); a partial tree would surface as ExtractionFailed \
             via verify_complete_extraction",
        );
    assert_eq!(mat.artifact_canonical_id, KANON_CANONICAL_ID);

    let extracted_files = count_regular_files(&mat.tree_root);
    let seen = find_named(&mat.tree_root, "seen.txt")
        .unwrap_or_else(|| panic!("SEEN.TXT not found under {}", mat.tree_root.display()));
    let sha = sha256_file(&seen);
    assert_eq!(sha.len(), 64);
    eprintln!(
        "[kanon] by-id COMPLETE extraction (verify_complete_extraction PASS): \
         extracted_regular_files={extracted_files}, SEEN.TXT sha256={sha}"
    );

    // Byte-usable proof: the RealLive decompiler parses a real scene straight
    // from the VAULT-materialised Seen.txt (NOT the /scratch pre-extraction
    // workaround the Delta+BCJ2 bug previously forced Kanon onto).
    let seen_bytes = std::fs::read(&seen).expect("read vault-materialised SEEN.TXT");
    let (populated_scenes, first_opcodes, first_unknown) = decode_first_scene(&seen_bytes);
    eprintln!(
        "[kanon] vault-sourced decode: populated_scenes={populated_scenes}, \
         first_scene_opcodes={first_opcodes}, first_scene_unrecognised={first_unknown}"
    );
    assert!(
        populated_scenes > 0,
        "vault-materialised Kanon Seen.txt must parse into >= 1 populated scene"
    );
    assert!(
        first_opcodes > 0,
        "the RealLive decompiler must decode >= 1 opcode from the vault-sourced first scene"
    );

    let _ = source.release(&mat, RunOutcome::Success);
    let _ = std::fs::remove_dir_all(&scratch);
}

/// Count regular files (not directories) under `root`, recursively. Used only
/// to report the size of a COMPLETE extraction — the completeness invariant
/// itself is enforced by `verify_complete_extraction` inside `materialize`.
fn count_regular_files(root: &Path) -> u64 {
    let mut stack = vec![root.to_path_buf()];
    let mut n = 0u64;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                n += 1;
            }
        }
    }
    n
}

/// Decode the first populated scene of a RealLive `Seen.txt` envelope, reusing
/// the shared decompiler pipeline (envelope -> scene header -> AVG32 decompress
/// -> bytecode dispatch). Returns `(populated_scene_count, first_scene_opcodes,
/// first_scene_unrecognised)`. Kanon's compiler version does not use the
/// second-level `xor_2`, so no key recovery is needed for a single scene.
fn decode_first_scene(seen_bytes: &[u8]) -> (usize, usize, usize) {
    let index = parse_archive(seen_bytes).expect("vault-sourced Seen.txt must parse as envelope");
    let Some(entry) = index.entries.first() else {
        return (0, 0, 0);
    };
    let off = entry.byte_offset as usize;
    let end = off + entry.byte_len as usize;
    assert!(
        end <= seen_bytes.len(),
        "scene payload runs past end of file"
    );
    let blob = &seen_bytes[off..end];
    let header = SceneHeader::parse(blob).expect("first scene header must parse");
    let bo = header.bytecode_offset as usize;
    let bc = header.bytecode_compressed_size as usize;
    let bu = header.bytecode_uncompressed_size as usize;
    assert!(bo + bc <= blob.len(), "compressed bytecode runs past scene");
    let decompressed = decompress_avg32(&blob[bo..bo + bc], bu).expect("AVG32 decompress");
    let opcodes = parse_real_bytecode(&decompressed).expect("first scene bytecode must decode");
    let unknown = opcodes
        .iter()
        .filter(|op: &&RealLiveOpcode| !op.is_recognized())
        .count();
    (index.entries.len(), opcodes.len(), unknown)
}
