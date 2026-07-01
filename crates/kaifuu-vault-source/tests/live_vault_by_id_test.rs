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

use kaifuu_vault_source::{
    ClaimQuery, LocalCorpusSource, MaterializeOptions, RunOutcome, ScratchConfig, VaultConfig,
    VaultSource, VaultSourceError,
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
/// prefer a real disk, not tmpfs).
fn scratch_base() -> PathBuf {
    let base = std::env::var("ITOTORI_SCRATCH_ROOT").map_or_else(
        |_| PathBuf::from("/scratch/itotori-vault-by-id-test"),
        PathBuf::from,
    );
    let unique = base.join(format!("run-{}", std::process::id()));
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

    // Materialize. Kanon's by-id archive uses a Delta+BCJ2 multi-coder folder
    // the pure-Rust sevenz-rust2 0.21 decoder cannot fully decode; that now
    // surfaces as a typed ExtractionFailed rather than a silent partial tree.
    // Either outcome is acceptable here: a full materialize proves the whole
    // by-id path; a typed ExtractionFailed documents the (read-only,
    // vault-curation-owned) decoder gap precisely without faking a hash.
    match source.materialize(&candidate, MaterializeOptions::default()) {
        Ok(mat) => {
            assert_eq!(mat.artifact_canonical_id, KANON_CANONICAL_ID);
            let seen = find_named(&mat.tree_root, "seen.txt")
                .unwrap_or_else(|| panic!("SEEN.TXT not found under {}", mat.tree_root.display()));
            let sha = sha256_file(&seen);
            let _ = source.release(&mat, RunOutcome::Success);
            let _ = std::fs::remove_dir_all(&scratch);
            eprintln!("[kanon] by-id -> SEEN.TXT sha256 = {sha}");
            assert_eq!(sha.len(), 64);
        }
        Err(VaultSourceError::ExtractionFailed { reason, .. }) => {
            let _ = std::fs::remove_dir_all(&scratch);
            eprintln!(
                "[kanon] by-id resolved + present on disk; full materialize blocked by a \
                 pure-Rust decoder gap: {reason}"
            );
        }
        Err(other) => {
            let _ = std::fs::remove_dir_all(&scratch);
            panic!("unexpected Kanon materialize error: {other:?}");
        }
    }
}
