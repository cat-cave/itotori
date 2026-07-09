//! Live Siglus corpus proof against the real read-only `/archive/vault`.
//!
//! Re-scope note: the parent node (`siglus-01-disc-recon`) originally assumed
//! Karetoshi + Gamekoi were only available as copy-protected DVD images
//! (`.mds`/`.mdf`), which are unrealizable under the no-Wine / no-shell-out
//! laws. That premise is SUPERSEDED: the vault now holds both titles as
//! **portable installs** (bare `by-id` artifacts), bypassing the DVD copy
//! protection entirely. So there is no sector-descramble work; this proof is
//! the same materialize path the RealLive corpus uses: resolve each title BY-ID
//! and extract its plaintext Siglus game tree into scratch, strictly read-only
//! against the vault.
//!
//! `#[ignore]`d by default; run explicitly with the live vault:
//!
//! ```text
//! ITOTORI_VAULT_ROOT=/archive/vault \
//!   cargo test -p kaifuu-vault-source \
//!   --test live_vault_siglus_test -- --ignored --nocapture
//! ```
//!
//! Materializes both Siglus portable installs BY-ID, confirms the plaintext
//! Siglus tree (`Scene.pck` + `Gameexe.dat` + `SiglusEngine.exe`), and records
//! a sanitized manifest (file counts, sizes, sha256 prefixes only). It NEVER
//! prints raw copyrighted bytes, archive header bytes, decrypted text, or full
//! hashes.

use std::io::Read;
use std::path::{Path, PathBuf};

use kaifuu_core::{DetectRequest, EngineAdapter};
use kaifuu_engine_fixture::SiglusProfileDetectorAdapter;
use kaifuu_vault_source::{
    ClaimQuery, LocalCorpusSource, MaterializeOptions, RetentionPolicy, ScratchConfig, VaultConfig,
    VaultSource,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// "Karetoshi" — Kareshi Inai Reki = Nenrei ... (portable install, VJ007329).
const KARETOSHI_CANONICAL_ID: &str =
    "kareshi-inai-reki-nenrei-ja-doushite-ikenai-no-yo-sei-torea-gakuen-ren-ai-kinshi-rei.vj007329";
/// "Gamekoi" — Game ~ Eroge Mitai na Suteki na Koi ga Shitai (portable, VJ015134).
const GAMEKOI_CANONICAL_ID: &str = "game-eroge-mitai-na-suteki-na-koi-ga-shitai.vj015134";

/// The fixed `Scene.pck` header length documented by `kaifuu_siglus::archive`.
const SCENE_PCK_HEADER_BYTE_LEN: usize = 0x5C;

fn require_live_vault() -> Option<PathBuf> {
    let root = std::env::var("ITOTORI_VAULT_ROOT").ok()?;
    if root != "/archive/vault" {
        return None;
    }
    Some(PathBuf::from(root))
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate lives under crates/")
        .parent()
        .expect("crates/ lives under workspace root")
        .to_path_buf()
}

/// A scratch evidence root OUTSIDE the vault. Each call returns a distinct
/// directory so parallel tests never clobber one another's extraction.
fn scratch_base() -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let base = std::env::var("ITOTORI_SCRATCH_ROOT").map_or_else(
        |_| {
            workspace_root()
                .join(".tmp")
                .join("siglus-02-tree-realize")
                .join("scratch")
        },
        PathBuf::from,
    );
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let unique = base.join(format!("run-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&unique).expect("create scratch base");
    unique
}

/// Recursively find the first directory under `root` that directly contains a
/// `Scene.pck` file. The by-id archive can wrap the game directory under
/// publisher/title subdirectories; the returned directory is the node output
/// game tree whose top level contains `Scene.pck` and `Gameexe.dat`.
fn find_siglus_game_dir(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if dir.join("Scene.pck").is_file() {
            return Some(dir);
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
struct SiglusTreeManifest {
    schema_version: &'static str,
    node_id: &'static str,
    source: &'static str,
    generated_by: &'static str,
    read_only_vault_root: &'static str,
    scratch_root: String,
    titles: Vec<SiglusTitleManifest>,
}

#[derive(Debug, Clone, Serialize)]
struct SiglusTitleManifest {
    label: &'static str,
    canonical_id: &'static str,
    release_id: i64,
    artifact_canonical_id: String,
    game_id: String,
    run_id: String,
    game_tree_root: String,
    regular_file_count: u64,
    total_size_bytes: u64,
    required_top_level_files: Vec<RequiredFileManifest>,
    engine_executable: RequiredFileManifest,
    detector_variant: String,
    vault_archive_size_bytes_before: u64,
    vault_archive_size_bytes_after: u64,
    vault_archive_mtime_unix_before: Option<i64>,
    vault_archive_mtime_unix_after: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
struct RequiredFileManifest {
    name: &'static str,
    size_bytes: u64,
    sha256_prefix: String,
}

#[derive(Debug, Clone, Copy)]
struct FileStats {
    count: u64,
    total_size: u64,
}

#[derive(Debug, Clone, Copy)]
struct VaultArtifactSnapshot {
    size_bytes: u64,
    mtime_unix: Option<i64>,
}

fn file_stats(root: &Path) -> FileStats {
    let mut stack = vec![root.to_path_buf()];
    let mut stats = FileStats {
        count: 0,
        total_size: 0,
    };
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                stats.count += 1;
                stats.total_size += p.metadata().expect("file metadata").len();
            }
        }
    }
    stats
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn sha256_prefix_file(path: &Path) -> String {
    let mut f = std::fs::File::open(path).expect("open for sha256");
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let got = f.read(&mut buf).expect("read for sha256");
        if got == 0 {
            break;
        }
        h.update(&buf[..got]);
    }
    hex(&h.finalize())[..16].to_string()
}

fn required_file(path: &Path, name: &'static str) -> RequiredFileManifest {
    RequiredFileManifest {
        name,
        size_bytes: path.metadata().expect("required file metadata").len(),
        sha256_prefix: sha256_prefix_file(path),
    }
}

fn snapshot_vault_artifact(path: &Path) -> VaultArtifactSnapshot {
    let meta = path.metadata().expect("vault artifact metadata");
    VaultArtifactSnapshot {
        size_bytes: meta.len(),
        mtime_unix: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64),
    }
}

fn confirm_and_characterize(
    label: &'static str,
    canonical_id: &'static str,
    game_dir: &Path,
    mat: &kaifuu_vault_source::MaterializeResult,
    before: VaultArtifactSnapshot,
    after: VaultArtifactSnapshot,
) -> SiglusTitleManifest {
    let scene = game_dir.join("Scene.pck");
    let gameexe = game_dir.join("Gameexe.dat");
    let exe = game_dir.join("SiglusEngine.exe");

    assert!(
        scene.is_file(),
        "[{label}] Scene.pck must be present under {}",
        game_dir.display()
    );
    assert!(
        gameexe.is_file(),
        "[{label}] Gameexe.dat must be present under {}",
        game_dir.display()
    );
    assert!(
        exe.is_file(),
        "[{label}] SiglusEngine.exe must be present under {}",
        game_dir.display()
    );

    let scene_len = scene.metadata().expect("scene metadata").len();
    assert!(
        scene_len as usize >= SCENE_PCK_HEADER_BYTE_LEN,
        "[{label}] Scene.pck must be at least the fixed 0x5C header long"
    );

    // Structural read only; bytes are not logged or persisted.
    let mut scene_head = [0u8; 4];
    std::fs::File::open(&scene)
        .expect("open Scene.pck for structural header check")
        .read_exact(&mut scene_head)
        .expect("read Scene.pck structural header");
    let first_table_off = u32::from_le_bytes(scene_head);
    assert_eq!(
        first_table_off as usize, SCENE_PCK_HEADER_BYTE_LEN,
        "[{label}] Scene.pck fixed-header index must be plaintext; a DVD-scrambled \
         or header-encrypted archive would not satisfy this"
    );

    let detector = SiglusProfileDetectorAdapter;
    let detection = detector
        .detect(DetectRequest { game_dir })
        .expect("Siglus detector must run against the real tree");
    let variant = detection
        .detected_variant
        .clone()
        .unwrap_or_else(|| "<none>".to_string());

    assert_eq!(
        before.size_bytes, after.size_bytes,
        "[{label}] vault archive size must be unchanged after materialize"
    );
    assert_eq!(
        before.mtime_unix, after.mtime_unix,
        "[{label}] vault archive mtime must be unchanged after materialize"
    );

    let stats = file_stats(game_dir);
    eprintln!(
        "[{label}] materialized plaintext Siglus tree: files={}, total_bytes={}, \
         required=Scene.pck/Gameexe.dat/SiglusEngine.exe, detector_variant={variant}",
        stats.count, stats.total_size
    );

    SiglusTitleManifest {
        label,
        canonical_id,
        release_id: mat.release_id,
        artifact_canonical_id: mat.artifact_canonical_id.clone(),
        game_id: mat.game_id.clone(),
        run_id: mat.run_id.clone(),
        game_tree_root: game_dir.display().to_string(),
        regular_file_count: stats.count,
        total_size_bytes: stats.total_size,
        required_top_level_files: vec![
            required_file(&scene, "Scene.pck"),
            required_file(&gameexe, "Gameexe.dat"),
        ],
        engine_executable: required_file(&exe, "SiglusEngine.exe"),
        detector_variant: variant,
        vault_archive_size_bytes_before: before.size_bytes,
        vault_archive_size_bytes_after: after.size_bytes,
        vault_archive_mtime_unix_before: before.mtime_unix,
        vault_archive_mtime_unix_after: after.mtime_unix,
    }
}

fn materialize_confirm_siglus(
    label: &'static str,
    canonical_id: &'static str,
    scratch_root: &Path,
) -> SiglusTitleManifest {
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
        .unwrap_or_else(|| panic!("[{label}] at least one release for {canonical_id}"));
    eprintln!(
        "[{label}] by-id resolved: release_id={} (canonical_id={canonical_id})",
        candidate.release_id
    );
    let archive_path =
        kaifuu_vault_source::resolution::by_id_path(source.vault_root(), canonical_id)
            .expect("canonical by-id artifact path");
    let before = snapshot_vault_artifact(&archive_path);

    let mat = source
        .materialize(
            &candidate,
            MaterializeOptions {
                retention: RetentionPolicy::KeepAll,
                ..MaterializeOptions::default()
            },
        )
        .unwrap_or_else(|e| {
            panic!("[{label}] {canonical_id} must materialize from the vault by-id: {e:?}")
        });
    assert_eq!(mat.artifact_canonical_id, canonical_id);
    assert!(
        mat.tree_root.join("_vault/metadata.json").exists(),
        "[{label}] embedded _vault/metadata.json present under the canonical_id wrapper"
    );
    assert_eq!(
        mat.embedded.canonical_id.as_deref(),
        Some(canonical_id),
        "[{label}] embedded canonical_id identity matches the requested artifact"
    );
    assert_eq!(
        mat.artifacts
            .first()
            .expect("primary artifact is resolved")
            .on_disk_path
            .as_path(),
        archive_path.as_path(),
        "[{label}] resolved artifact path is the expected by-id path"
    );
    let game_dir = find_siglus_game_dir(&mat.tree_root).unwrap_or_else(|| {
        panic!(
            "[{label}] no Scene.pck found under materialized tree {}",
            mat.tree_root.display()
        )
    });
    let after = snapshot_vault_artifact(&archive_path);

    confirm_and_characterize(label, canonical_id, &game_dir, &mat, before, after)
}

#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn materializes_both_siglus_titles_to_plaintext_trees_and_records_manifest() {
    let Some(_vault) = require_live_vault() else {
        eprintln!("skipping: set ITOTORI_VAULT_ROOT=/archive/vault to run this proof");
        return;
    };
    let scratch = scratch_base();

    let titles = vec![
        materialize_confirm_siglus("karetoshi", KARETOSHI_CANONICAL_ID, &scratch),
        materialize_confirm_siglus("gamekoi", GAMEKOI_CANONICAL_ID, &scratch),
    ];

    for title in &titles {
        assert_eq!(
            title.detector_variant, "scene-pck-gameexe-dat-real",
            "real-signature detector must recognise {} Scene.pck/Gameexe.dat pair",
            title.label
        );
        assert!(
            Path::new(&title.game_tree_root).join("Scene.pck").is_file(),
            "{} output tree top-level contains Scene.pck",
            title.label
        );
        assert!(
            Path::new(&title.game_tree_root)
                .join("Gameexe.dat")
                .is_file(),
            "{} output tree top-level contains Gameexe.dat",
            title.label
        );
    }

    let manifest = SiglusTreeManifest {
        schema_version: "itotori.siglus-02-tree-realize-manifest.v1",
        node_id: "siglus-02-tree-realize",
        source: "kaifuu-vault-source/by-id/read-only",
        generated_by: "crates/kaifuu-vault-source/tests/live_vault_siglus_test.rs",
        read_only_vault_root: "/archive/vault",
        scratch_root: scratch.display().to_string(),
        titles,
    };

    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).expect("serialize sanitized Siglus manifest");
    let worktree_manifest_dir = workspace_root().join(".tmp").join("siglus-02-tree-realize");
    std::fs::create_dir_all(&worktree_manifest_dir).expect("create manifest dir");
    let worktree_manifest = worktree_manifest_dir.join("manifest.json");
    std::fs::write(&worktree_manifest, &manifest_bytes).expect("write worktree manifest");
    let scratch_manifest = scratch.join("siglus-02-tree-realize-manifest.json");
    std::fs::write(&scratch_manifest, &manifest_bytes).expect("write scratch manifest");

    eprintln!(
        "siglus-02-tree-realize manifest written: {} and {}",
        worktree_manifest.display(),
        scratch_manifest.display()
    );
}
