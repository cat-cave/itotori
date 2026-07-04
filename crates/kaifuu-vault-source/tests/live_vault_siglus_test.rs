//! Live Siglus corpus proof against the real read-only `/archive/vault`.
//!
//! Re-scope note: the parent node (`siglus-01-disc-recon`) originally assumed
//! Karetoshi + Gamekoi were only available as copy-protected DVD images
//! (`.mds`/`.mdf`), which are unrealizable under the no-Wine / no-shell-out
//! laws. That premise is SUPERSEDED: the vault now holds both titles as
//! **portable installs** (bare `by-id` artifacts), bypassing the DVD copy
//! protection entirely. So there is no sector-descramble work — this proof is
//! the same mundane materialize the RealLive corpus already does: resolve each
//! title BY-ID and extract its plaintext Siglus game tree into throwaway
//! scratch, strictly read-only against the vault.
//!
//! `#[ignore]`d by default; run explicitly with the live vault:
//!
//! ```text
//! ITOTORI_VAULT_ROOT=/archive/vault \
//!   cargo test -p kaifuu-vault-source \
//!   --test live_vault_siglus_test -- --ignored --nocapture
//! ```
//!
//! Materialises both Siglus portable installs BY-ID, confirms the plaintext
//! Siglus tree (`Scene.pck` + `Gameexe.dat` + `SiglusEngine.exe`), reports file
//! counts + structural signatures, and runs the Siglus detector profile.
//! NEVER prints raw copyrighted bytes: file names, counts, sizes, and the
//! fixed-header structural signature only.

use std::path::{Path, PathBuf};

use kaifuu_core::{DetectRequest, EngineAdapter};
use kaifuu_engine_fixture::SiglusProfileDetectorAdapter;
use kaifuu_vault_source::{
    ClaimQuery, LocalCorpusSource, MaterializeOptions, RunOutcome, ScratchConfig, VaultConfig,
    VaultSource,
};
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

/// A throwaway scratch root OUTSIDE the vault. Each call returns a distinct
/// directory so parallel tests never clobber one another's extraction.
fn scratch_base() -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let base = std::env::var("ITOTORI_SCRATCH_ROOT").map_or_else(
        |_| PathBuf::from("/scratch/itotori-vault-siglus-test"),
        PathBuf::from,
    );
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let unique = base.join(format!("run-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&unique).expect("create scratch base");
    unique
}

/// Recursively find the first directory under `root` that directly contains a
/// `Scene.pck` file (the Siglus game directory sits at a `<studio>/<title>/`
/// subpath inside the by-id wrapper).
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

/// Count regular files under `root`, recursively.
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

/// Read the first `n` bytes of a file (for structural-signature reporting).
fn head_bytes(path: &Path, n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).expect("open for header");
    let mut buf = vec![0u8; n];
    let got = f.read(&mut buf).expect("read header");
    buf.truncate(got);
    buf
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn sha256_file(path: &Path) -> String {
    let bytes = std::fs::read(path).expect("read for sha256");
    let mut h = Sha256::new();
    h.update(&bytes);
    hex(&h.finalize())
}

/// Characterise a Siglus game directory: confirm the three engine signatures,
/// count files, and report structural signatures. Runs the Siglus detector and
/// returns its `detected_variant`. Reports facts only — never raw content.
fn confirm_and_characterize(label: &str, game_dir: &Path) -> String {
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

    let file_count = count_regular_files(game_dir);
    let scene_len = scene.metadata().expect("scene metadata").len();
    let gameexe_len = gameexe.metadata().expect("gameexe metadata").len();
    let exe_len = exe.metadata().expect("exe metadata").len();

    assert!(
        scene_len as usize >= SCENE_PCK_HEADER_BYTE_LEN,
        "[{label}] Scene.pck must be at least the fixed 0x5C header long"
    );

    let scene_head = head_bytes(&scene, SCENE_PCK_HEADER_BYTE_LEN);
    let gameexe_head = head_bytes(&gameexe, 16);

    // Structural read of the Scene.pck fixed header: Siglus stores the
    // SceneList/HeaderPair table offsets/lengths as little-endian u32s in the
    // first 0x5C bytes. The first u32 echoes the 0x5C header length (the first
    // table begins immediately after the header). A plaintext (non
    // header-encrypted) archive shows sane, ascending table offsets here; a
    // fully-encrypted header shows high-entropy garbage. Factual format fields,
    // not content. The header index being plaintext means only the per-scene
    // payloads carry the constant-256-XOR (+ optional per-game second-layer
    // key); the archive directory itself is readable.
    let first_table_off =
        u32::from_le_bytes([scene_head[0], scene_head[1], scene_head[2], scene_head[3]]);
    let header_plaintext = first_table_off as usize == SCENE_PCK_HEADER_BYTE_LEN;
    // Trailing 8 bytes of the fixed header: a build/format constant that is
    // stable across scene tables (compare across the two titles for build
    // divergence).
    let header_tail = &scene_head[SCENE_PCK_HEADER_BYTE_LEN - 8..];
    let exe_sha = sha256_file(&exe);

    // Plaintext Gameexe.dat is UTF-16LE (BOM 0xFF 0xFE, or ASCII-key low bytes
    // with 0x00 high bytes). Encrypted Gameexe.dat is high-entropy.
    let utf16le_bom = gameexe_head.starts_with(&[0xFF, 0xFE]);
    let looks_utf16le = utf16le_bom
        || (gameexe_head.len() >= 4
            && gameexe_head[0].is_ascii_graphic()
            && gameexe_head[1] == 0x00
            && gameexe_head[2].is_ascii_graphic()
            && gameexe_head[3] == 0x00);

    assert!(
        header_plaintext,
        "[{label}] Scene.pck fixed-header index must be plaintext (first table offset == 0x5C); \
         a DVD-scrambled or header-encrypted archive would not satisfy this"
    );

    let detector = SiglusProfileDetectorAdapter;
    let detection = detector
        .detect(DetectRequest { game_dir })
        .expect("Siglus detector must run against the real tree");
    let variant = detection
        .detected_variant
        .clone()
        .unwrap_or_else(|| "<none>".to_string());

    eprintln!("[{label}] siglus game dir = {}", game_dir.display());
    eprintln!(
        "[{label}] engine signatures present: Scene.pck={scene_len} bytes, \
         Gameexe.dat={gameexe_len} bytes, SiglusEngine.exe={exe_len} bytes"
    );
    eprintln!("[{label}] regular file count under game dir = {file_count}");
    eprintln!(
        "[{label}] Scene.pck fixed-header[0..0x5C] = {}",
        hex(&scene_head)
    );
    eprintln!(
        "[{label}] Scene.pck header plaintext = {header_plaintext} (first table offset LE u32 \
         @0x00 = {first_table_off}, expect 0x5C={SCENE_PCK_HEADER_BYTE_LEN}); \
         header-tail[0x54..0x5C] = {}",
        hex(header_tail)
    );
    eprintln!("[{label}] SiglusEngine.exe sha256 = {exe_sha}");
    eprintln!(
        "[{label}] Gameexe.dat head16 = {}  (utf16le_bom={utf16le_bom}, looks_utf16le={looks_utf16le})",
        hex(&gameexe_head)
    );
    eprintln!(
        "[{label}] Siglus detector: adapter_id={}, detected={}, engine_family={:?}, variant={variant}",
        detection.adapter_id, detection.detected, detection.engine_family
    );

    variant
}

/// Materialise one Siglus title by canonical id, confirm + characterise its
/// tree, then release the scratch. Returns the detector's `detected_variant`.
fn materialize_confirm_siglus(label: &str, canonical_id: &str, scratch_root: &Path) -> String {
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

    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_or_else(|e| {
            panic!("[{label}] {canonical_id} must materialize from the vault by-id: {e:?}")
        });
    assert_eq!(mat.artifact_canonical_id, canonical_id);
    assert!(
        mat.tree_root.join("_vault/metadata.json").exists(),
        "[{label}] embedded _vault/metadata.json present under the canonical_id wrapper"
    );

    let game_dir = find_siglus_game_dir(&mat.tree_root).unwrap_or_else(|| {
        panic!(
            "[{label}] no Scene.pck found under materialised tree {}",
            mat.tree_root.display()
        )
    });

    let variant = confirm_and_characterize(label, &game_dir);

    source
        .release(&mat, RunOutcome::Success)
        .expect("release scratch");
    variant
}

#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn karetoshi_materializes_to_plaintext_siglus_tree() {
    let Some(_vault) = require_live_vault() else {
        eprintln!("skipping: set ITOTORI_VAULT_ROOT=/archive/vault to run this proof");
        return;
    };
    let scratch = scratch_base();
    let variant = materialize_confirm_siglus("karetoshi", KARETOSHI_CANONICAL_ID, &scratch);
    let _ = std::fs::remove_dir_all(&scratch);
    // The detector now recognises the REAL Siglus archive-header signatures
    // (Scene.pck `0x5C` header + ascending index-section offsets; Gameexe.dat
    // zero/`1` prefix + encrypted high-entropy body), so the real pair
    // classifies as `scene-pck-gameexe-dat-real` at identify level (extraction
    // /decryption remain unclaimed). Recording the exact variant keeps the
    // detect-vs-extract boundary honest.
    eprintln!("[karetoshi] detector variant = {variant}");
    assert_eq!(
        variant, "scene-pck-gameexe-dat-real",
        "real-signature detector must recognise the real Karetoshi Scene.pck/Gameexe.dat pair"
    );
}

#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn gamekoi_materializes_to_plaintext_siglus_tree() {
    let Some(_vault) = require_live_vault() else {
        eprintln!("skipping: set ITOTORI_VAULT_ROOT=/archive/vault to run this proof");
        return;
    };
    let scratch = scratch_base();
    let variant = materialize_confirm_siglus("gamekoi", GAMEKOI_CANONICAL_ID, &scratch);
    let _ = std::fs::remove_dir_all(&scratch);
    eprintln!("[gamekoi] detector variant = {variant}");
    assert_eq!(
        variant, "scene-pck-gameexe-dat-real",
        "real-signature detector must recognise the real Gamekoi Scene.pck/Gameexe.dat pair"
    );
}
