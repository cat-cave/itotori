//! Sample-frame emitter for the P0 render fix
//! (`utsushi-render-frame-is-visually-broken-not-proof`). Renders a real
//! Sweetie HD background through the fixed pipeline and writes the two
//! frames the orchestrator VISUALLY verifies:
//!
//!   * `fix-01-private-full.png` — full-fidelity PRIVATE frame: the real
//!     decoded g00 mansion background + the translated English dialogue
//!     rendered LEGIBLY in a VN dialogue box with the bundled DejaVu Sans
//!     font.
//!   * `fix-02-public-redacted.png` — the PUBLIC proof frame: the g00
//!     redacted proof-preservingly (a copyright-safe edge-outline — the
//!     scene's structure/layout stays visible, its pixels do not) with the
//!     SAME English dialogue legible on top.
//!
//! Both go to the gitignored `.private-render/diag/` (never committed).
//! The English dialogue here is supplied directly (a STAGED translation of
//! the opening line) so the frame shows what a patched game renders — the
//! live engine path (`engine_port::render_frame`) feeds the engine-decoded
//! dialogue instead; see the report's note on the patched-Seen.txt gap.
//!
//! Run:
//!   cargo run -p utsushi-reallive --example render_diag -- <g00_dir> <bg_stem> [out_dir]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    Framebuffer, GraphicsObject, GraphicsObjectStack, GraphicsPlane, GraphicsScale,
    MessageWindowConfig, RedactionPolicy, RenderPass, TextLayer, WipeColour, decode_g00,
    encode_png_rgba_deterministic,
};

#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}
impl OnDiskG00Package {
    fn host_path(&self, id: &AssetId) -> PathBuf {
        let logical = id.path();
        let stem = logical.strip_prefix("g00/").unwrap_or(logical);
        self.g00_dir.join(stem)
    }
}
impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "diag-on-disk-g00"
    }
    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_string()),
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
        Ok(self.host_path(id).exists())
    }
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let meta = std::fs::metadata(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let bytes = std::fs::read(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }
    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

const W: u32 = 1280;
const H: u32 = 720;

fn write_png(path: &Path, fb: &Framebuffer) {
    let bytes = encode_png_rgba_deterministic(fb);
    assert_eq!(
        &bytes[..8],
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    );
    std::fs::write(path, &bytes).unwrap();
    println!(
        "wrote {} ({} bytes, {}x{})",
        path.display(),
        bytes.len(),
        fb.width(),
        fb.height()
    );
}

/// Scale (thousandths) that makes the source fill the `W x H` frame
/// (cover). Uses the larger axis ratio so the frame has no letterbox.
fn cover_scale(src_w: u32, src_h: u32) -> i32 {
    let sx = (W as u64 * 1000) / src_w.max(1) as u64;
    let sy = (H as u64 * 1000) / src_h.max(1) as u64;
    sx.max(sy) as i32
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let g00_dir = PathBuf::from(&args[1]);
    let bg_stem = args[2].clone();
    let out_dir = args
        .get(3)
        .map_or_else(|| PathBuf::from(".private-render/diag"), PathBuf::from);
    std::fs::create_dir_all(&out_dir).unwrap();

    // Decode the real g00 up front to size the cover scale.
    let raw = std::fs::read(g00_dir.join(format!("{bg_stem}.g00"))).unwrap();
    let (img, warns) = decode_g00(&raw).expect("real g00 decodes");
    println!(
        "DECODE OK: {bg_stem}.g00 type={:?} {}x{} warnings={}",
        img.g00_type,
        img.width,
        img.height,
        warns.len()
    );
    let scale = cover_scale(img.width, img.height);

    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package { g00_dir });
    let pass = RenderPass::with_dimensions(W, H)
        .unwrap()
        .with_assets(Arc::clone(&assets));

    // The composited scene: a dark wipe under the real g00 background
    // scaled to cover the frame.
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x08, 0x08, 0x0C)),
        )
        .unwrap();
    let mut bg = GraphicsObject::image(bg_stem.clone());
    bg.scale = GraphicsScale {
        x_thousandths: scale,
        y_thousandths: scale,
    };
    stack.set(GraphicsPlane::Background, 1, bg).unwrap();

    // STAGED English translation of the opening line (see module note)
    // laid out as ONE message in the default message-window box (no
    // Gameexe here — this is the g00 + redaction diag, not the
    // config-driven message-window diag; see the `msgwin_diag` example).
    let dialogue = TextLayer::message_window(
        "\"...You're early today. Did something happen at work?\"",
        None,
        &MessageWindowConfig::default(),
        (W, H),
        (W, H),
    );

    // --- fix-01: full-fidelity PRIVATE frame (real art + English text).
    let (mut full_fb, report) = pass.rasterise_reporting(&stack, RedactionPolicy::Full);
    let painted_full = full_fb.draw_text(&dialogue);
    println!(
        "fix-01 full: dialogue painted {painted_full} px, skipped_objects={:?}",
        report.skipped_objects
    );
    assert!(painted_full > 0, "dialogue must paint legible pixels");
    write_png(&out_dir.join("fix-01-private-full.png"), &full_fb);

    // --- fix-02: PUBLIC proof frame (edge-outline redaction + English).
    let mut redacted_fb = pass.rasterise_with_policy(&stack, RedactionPolicy::Redact);
    // A small header label so the redaction reads unambiguously.
    let mut label = TextLayer::localized(vec![
        "BACKGROUND REDACTED - copyright-safe edge-outline (structure only)".to_string(),
    ]);
    label.origin_x = W / 24;
    label.origin_y = H / 24;
    label.scale = 24;
    label.colour = WipeColour {
        red: 0xCF,
        green: 0xD6,
        blue: 0xE6,
        alpha: 0xFF,
    };
    redacted_fb.draw_text(&label);
    let painted_pub = redacted_fb.draw_text(&dialogue);
    assert!(painted_pub > 0, "public dialogue must paint legible pixels");
    write_png(&out_dir.join("fix-02-public-redacted.png"), &redacted_fb);

    println!("done: wrote fix-01/fix-02 to {}", out_dir.display());
}
