

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    G00Image, G00Type, GraphicsAlpha, GraphicsColourTone, GraphicsObject, GraphicsObjectStack,
    GraphicsPlane, GraphicsScale, PNG_FILE_MAGIC, RecordingFrameArtifactSink, RedactionPolicy,
    RenderPass, SceneEmit, SkipReason, TextLayer, WipeColour, decode_g00, sha256_hex,
};

/// Minimal [`AssetPackage`] that resolves `g00/<NAME>.g00` against a
/// real on-disk g00 directory (no whole-tree indexing). Case-sensitive:
/// the caller supplies the on-disk stem verbatim.
#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "render-g00-on-disk"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "render-g00-on-disk".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("render-g00-on-disk".to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.g00_dir.join(strip_g00_prefix(id.path())).exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let meta = fs::metadata(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let bytes = fs::read(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

fn strip_g00_prefix(logical: &str) -> &str {
    logical.strip_prefix("g00/").unwrap_or(logical)
}

/// Scan `g00_dir` for the first type-0 (`RawBgr`) g00 file whose bytes
/// decode cleanly into a canvas with genuine pixel variance (so the
/// downstream "not all fill" / "differs" invariants are non-vacuous).
/// Returns `(on-disk stem without extension, decoded image)`.
fn pick_varied_type0_g00(g00_dir: &Path) -> Option<(String, G00Image)> {
    let mut entries: Vec<PathBuf> = fs::read_dir(g00_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("g00"))
        })
        .collect();
    entries.sort();

    for path in entries.iter().take(400) {
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if bytes.first().copied() != Some(0) {
            continue; // fast-path: only probe type-0 lead bytes.
        }
        let Ok((image, _warnings)) = decode_g00(&bytes) else {
            continue;
        };
        if image.g00_type != G00Type::RawBgr || image.width == 0 || image.height == 0 {
            continue;
        }
        if !has_pixel_variance(&image.pixels_rgba) {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str())?.to_string();
        return Some((stem, image));
    }
    None
}

/// A deliberately-malformed, SYNTHETIC type-0 g00 byte buffer that
/// [`decode_g00`] hard-rejects with
/// [`G00DecodeError::MalformedCompressedSize`]. It carries a plausible
/// header — a valid type-0 lead byte and non-zero `width`/`height` — but
/// its LZSS section declares a `compressed_size` of `0`, which is below
/// the mandatory 8-byte section preamble the field is defined to include
/// so the decoder rejects it as internally inconsistent (rather than
/// clamping to an empty payload and surfacing only a downstream warning).
///
/// No real art is embedded: every byte is authored here. This lets the
/// skip-surface proof exercise the `DecodeFailed` fail-soft path
/// deterministically, decoupled from whether any real corpus g00 happens
/// to be broken.
fn malformed_type0_g00() -> Vec<u8> {
    // 5-byte preamble: type byte 0 (RawBgr) + width=4, height=4 (u16 LE).
    let mut bytes = vec![0u8, 4, 0, 4, 0];
    // LZSS section header: compressed_size (u32 LE) = 0 (< 8, the mandatory
    // preamble length) → MalformedCompressedSize. uncompressed_size = 64
    // (4*4*4) so ONLY the compressed_size field is the offending value.
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&64u32.to_le_bytes());
    // A few trailing bytes so the buffer plausibly carries a payload region.
    bytes.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);
    bytes
}

/// Write `bytes` to `<temp>/g00/<stem>.g00` under a unique managed temp
/// directory and return the g00 directory an [`OnDiskG00Package`] resolves
/// against. Used to inject a synthetic malformed g00 into the render seam.
fn temp_g00_dir_with(stem: &str, bytes: &[u8]) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-render-g00-synthetic-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create synthetic g00 dir");
    fs::write(dir.join(format!("{stem}.g00")), bytes).expect("write malformed synthetic g00");
    dir
}

/// True if the RGBA buffer is not a single uniform colour (some pixel
/// differs from the first).
fn has_pixel_variance(pixels: &[u8]) -> bool {
    if pixels.len() < 8 {
        return false;
    }
    let head = &pixels[..4];
    pixels.chunks_exact(4).any(|px| px != head)
}

/// Private (uncommitted, gitignored) render root under the workspace's
/// `/.private-render/` directory — which lives under `/scratch`.
fn private_render_dir(tag: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root two levels above crate manifest");
    workspace_root
        .join(".private-render")
        .join(format!("{tag}-{}-{nonce}", std::process::id()))
}

fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-render-g00-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    let root = RuntimeArtifactRoot::new(&dir);
    root.prepare().expect("prepare managed artifact root");
    root
}

/// Bounds a source dimension so the scaled sprite fits inside `budget`
/// framebuffer pixels; returns a scale in thousandths (`<= 1000`).
fn fit_scale(src_w: u32, src_h: u32, budget_w: u32, budget_h: u32) -> i32 {
    let sx = (budget_w as u64 * 1000) / src_w.max(1) as u64;
    let sy = (budget_h as u64 * 1000) / src_h.max(1) as u64;
    sx.min(sy).clamp(1, 1000) as i32
}

