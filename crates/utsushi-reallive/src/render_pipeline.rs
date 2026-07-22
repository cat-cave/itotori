//! Headless render pipeline, localized text
//! layer, deterministic PNG encoder, and substrate frame-artifact
//! emission.
//!
//! Owns the per-frame [`Framebuffer`], the [`RenderPass`] that walks the
//! [`crate::GraphicsObjectStack`] and rasterises it, the localized
//! [`TextLayer`] painter, the deterministic-PNG encoder, and the
//! emission path that writes the encoded PNG to a managed
//! [`RuntimeArtifactRoot`] and announces it through the substrate
//! [`utsushi_core::substrate::FrameArtifactSink`] at
//! [`EvidenceTier::E2`].
//!
//! # Real g00 compositing + emit-boundary redaction
//!
//! The render pass composites REAL decoded g00 art. When a
//! [`GraphicsObjectKind::Image`] object is painted the pass resolves
//! `g00/<asset_key>.g00` through its bound
//! [`utsushi_core::substrate::AssetPackage`], decodes the bytes with
//! [`crate::decode_g00`], and blits the decoded bitmap into the
//! framebuffer subject to the object's recorded scale, colour tone, and
//! alpha (see [`RenderPass::paint_object`]). [`GraphicsObjectKind::Wipe`]
//! fills and the localized [`TextLayer`] are composited on top.
//!
//! Copyright redaction is a POLICY applied at the artifact-emit
//! boundary, NOT hard-enforced in the render path. [`RedactionPolicy`]
//! selects whether a rendered frame carries the real decoded art
//! ([`RedactionPolicy::Full`]) or a copyright-safe EDGE-OUTLINE of every
//! image object's rect ([`RedactionPolicy::Redact`], the default). The
//! edge-outline (see [`redact_edge_map`]) is a PROOF-PRESERVING
//! redaction: the scene's structure/layout stays visible for proof value
//! while the art's colour, tone, and texture are discarded and no
//! verbatim decoded run is republished — a marked improvement over a
//! solid fill, which showed nothing. [`RenderPass::emit_scene_screenshots`]
//! writes the full-fidelity buffer to a PRIVATE, uncommitted path
//! (hashable, never committed) and announces the public
//! (policy-selected) buffer through the substrate frame sink — so a
//! committed/CI proof publishes no copyrighted art while a
//! locally-authorized run can toggle redaction off.
//!
//! # Substrate frame-artifact emission (E2)
//!
//! [`RenderPass::emit_localized_screenshot`] writes the deterministic
//! PNG bytes to the caller's [`RuntimeArtifactRoot`] under a managed
//! `artifacts/utsushi/runtime/<run_id>/screenshots/<artifact_id>.png`
//! URI, then announces an [`utsushi_core::substrate::FrameArtifact`] at
//! `EvidenceTier::E2` through the supplied
//! [`utsushi_core::substrate::FrameArtifactSink`]. The sink enforces the
//! E2 per-payload floor, the artifact-kind allow-list (`screenshot`)
//! and the managed-URI shape; a frame that fails any of these is
//! rejected rather than silently dropped.
//!
//! # Deterministic PNG encoder
//!
//! Audit-focus pin: "Non-deterministic PNG output (timestamp
//! metadata)". The encoder writes exactly the `IHDR`, `IDAT`, `IEND`
//! chunks in a fixed order:
//!
//! 1. **`IHDR`** — width, height, bit depth `8`, colour type `6`
//!    (RGBA), no filter / interlace.
//! 2. **`IDAT`** — zlib stream wrapped around an **uncompressed
//!    deflate stored block** (BTYPE=00). Stored blocks have a fixed
//!    `(LEN, NLEN)` header and emit the pixel bytes verbatim, so the
//!    only variability surface that exists in dynamic-Huffman deflate
//!    is eliminated. zlib's `adler32` and the PNG `crc32` are both
//!    pure functions of the bytes, so the encoder is byte-identical
//!    across runs and threads.
//! 3. **`IEND`** — fixed zero-length terminator.
//!
//! No `tIME`, `tEXt`, `iTXt`, or `pHYs` chunks are written, so there is
//! no timestamp surface to leak between runs. The `artifact_id` is a
//! SHA-256 of the PNG bytes (sourced through the workspace `sha2`
//! crate), so identical frame state produces an identical artifact id.

use std::path::Path;
use std::sync::Arc;

use crate::g00::decode_g00;
use crate::gameexe::MessageWindowConfig;
use crate::graphics_objects::{
    GraphicsLayer, GraphicsObject, GraphicsObjectKind, GraphicsObjectStack, GraphicsPlane,
    WipeColour,
};
use crate::syscall::ScreenSize;
use utsushi_core::substrate::{
    AssetPackage, EvidenceTier, FrameArtifact, FrameArtifactSink, ObservationArtifactRef, SinkError,
};
use utsushi_core::{RuntimeArtifactKind, RuntimeArtifactRoot, runtime_artifact_uri};

/// Stable diagnostic code emitted by [`RenderPass::new`] when the
/// caller supplies a [`ScreenSize`] with `width == 0` or `height == 0`.
pub const RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE: &str =
    "utsushi.reallive.render_pipeline.zero_screen_size";

/// Stable diagnostic code emitted by
/// [`RenderPass::emit_localized_screenshot`] when a non-empty localized
/// [`TextLayer`] paints ZERO framebuffer pixels — the load-bearing guard
/// that keeps a localized-screenshot proof from being vacuous.
pub const RENDER_PIPELINE_BLANK_LOCALIZED_TEXT_CODE: &str =
    "utsushi.reallive.render_pipeline.blank_localized_text";

/// Stable diagnostic code emitted by [`RenderPass::paint_image`] when an
/// image object contributes NO pixels (missing asset package, resolve
/// open / decode failure, or a zero-extent sprite). The compositor is
/// fail-soft — it keeps rendering the rest of the stack — but the skip is
/// NEVER silent: it is logged under this code AND recorded on the
/// [`RenderReport`] so a consumer can tell an incomplete frame (one that
/// dropped an object, e.g. the un-decodable `BACK.g00` background) from a
/// complete render. See [`SkipReason`] / [`SkippedObject`].
pub const RENDER_PIPELINE_OBJECT_SKIPPED_CODE: &str =
    "utsushi.reallive.render_pipeline.object_skipped";

#[cfg(test)]
pub(crate) use crate::render_png::wrap_as_zlib_stored;
/// PNG file-magic / colour-type / bit-depth / encoder + checksum surface.
/// Bodies live in [`crate::render_png`]; re-exported here so the crate
/// public API path (`render_pipeline::*` / crate-root `pub use`) is unchanged.
pub use crate::render_png::{
    PNG_BIT_DEPTH, PNG_COLOUR_TYPE_RGBA, PNG_FILE_MAGIC, adler32, crc32_ieee,
    encode_png_rgba_deterministic, sha256_hex,
};

/// Bytes per pixel (`RGBA = 4`).
pub const RGBA_BYTES_PER_PIXEL: usize = 4;

/// Stable `artifact_kind` the substrate frame sink announces for a
/// rasterized screenshot. Member of the sink's allow-list.
pub const SCREENSHOT_ARTIFACT_KIND: &str = "screenshot";

/// Copyright-redaction policy applied at the artifact-emit boundary.
///
/// This is NOT hard-enforced inside the compositing loop: the render
/// path can always produce the full-fidelity buffer. The policy only
/// selects what an *emitted* frame carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactionPolicy {
    /// Composite the real decoded g00 art. Used for the PRIVATE
    /// uncommitted full-fidelity artifact and for locally-authorized
    /// (redaction-off) public frames.
    Full,
    /// Replace every image object's rect with a copyright-safe
    /// EDGE-OUTLINE of the decoded g00 (see [`redact_edge_map`]): the
    /// scene's structure/layout survives for proof value while colour
    /// tone, and texture are discarded and no verbatim art is republished.
    /// The default for committed / CI proof.
    Redact,
}

impl RedactionPolicy {
    /// Map a public-redaction toggle to a policy. `redact == true`
    /// (the safe default) yields [`RedactionPolicy::Redact`].
    pub fn public_toggle(redact: bool) -> Self {
        if redact { Self::Redact } else { Self::Full }
    }
}

mod framebuffer;
pub use framebuffer::Framebuffer;

mod text_layer;
pub use text_layer::{TextBackdrop, TextLayer};

/// Box text-area height (virtual px) for a bottom-anchored window when no
/// waku frame graphic is available: the RealLive
/// `y_chars * (font + y_spacing + ruby)` formula plus the vertical
/// padding, falling back to a quarter-screen band when `MOJI_CNT` is
/// absent.
fn box_text_height_virtual(config: &MessageWindowConfig, virtual_height: i32) -> i32 {
    let (pad_upper, pad_lower, _, _) = config.moji_pad;
    let vertical_pad = pad_upper.max(0) + pad_lower.max(0);
    let line_stride = config.moji_size as i32 + config.moji_rep.1 + config.ruby_size.max(0);
    let y_chars = config.moji_cnt.map(|(_, y)| y).filter(|y| *y > 0);
    let base = match y_chars {
        Some(rows) => rows * line_stride,
        None => virtual_height / 4,
    };
    (base + vertical_pad).clamp(1, virtual_height)
}

/// Config-driven window-box geometry shared by the message window
/// ([`TextLayer::message_window`]) and the choice / selection window
/// ([`ChoiceWindow::from_config`]).
///
/// Every field is derived from a `#WINDOW.NNN` [`MessageWindowConfig`]
/// scaled from the game's virtual screen space to the actual framebuffer —
/// the backdrop rectangle (POS-anchored, ATTR-coloured), the text origin
/// (MOJI_POS insets), the glyph size (MOJI_SIZE), the inner text width, and
/// the engine's fixed row stride (MOJI_SIZE + MOJI_REP.y + LUBY_SIZE).
/// Nothing here is hardcoded: a game with a different `Gameexe.ini` yields a
/// different box, and the SAME box math frames a message and a choice list.
#[derive(Debug, Clone, Copy)]
struct WindowBoxGeometry {
    backdrop: TextBackdrop,
    origin_x: u32,
    origin_y: u32,
    scale: u32,
    text_area_width: u32,
    line_height: u32,
}

/// Compute the [`WindowBoxGeometry`] for `config` scaled from `screen_size`
/// (the game's virtual space) to `frame_size` (the framebuffer). This is the
/// exact box placement [`TextLayer::message_window`] used inline before the
/// choice window shared it; behaviour is unchanged.
fn window_box_geometry(
    config: &MessageWindowConfig,
    screen_size: (u32, u32),
    frame_size: (u32, u32),
) -> WindowBoxGeometry {
    let (vw, vh) = (screen_size.0.max(1) as i32, screen_size.1.max(1) as i32);
    let scale_x = frame_size.0 as f32 / vw as f32;
    let scale_y = frame_size.1 as f32 / vh as f32;
    let to_x = |v: i32| (v as f32 * scale_x).round().max(0.0) as u32;
    let to_y = |v: i32| (v as f32 * scale_y).round().max(0.0) as u32;

    let inset = config.pos_x.max(0);
    let box_left = inset;
    let box_right = (vw - inset).max(box_left + 1);
    let (box_top, box_bottom) = match config.origin {
        0 | 1 => (config.pos_y.max(0), (vh - inset).max(config.pos_y + 1)),
        _ => {
            let bottom = (vh - config.pos_y.max(0)).clamp(1, vh);
            let height = box_text_height_virtual(config, vh);
            ((bottom - height).max(0), bottom)
        }
    };

    let bx = to_x(box_left);
    let by = to_y(box_top);
    let bw = to_x(box_right).saturating_sub(bx).max(1);
    let bh = to_y(box_bottom).saturating_sub(by).max(1);
    let (r, g, b, alpha) = config.attr_rgba;
    let backdrop = TextBackdrop {
        x: bx,
        y: by,
        width: bw,
        height: bh,
        colour: WipeColour {
            red: r,
            green: g,
            blue: b,
            alpha,
        },
    };

    let (pad_upper, _pad_lower, pad_left, pad_right) = config.moji_pad;
    let origin_x = bx.saturating_add(to_x(pad_left.max(0)));
    let origin_y = by.saturating_add(to_y(pad_upper.max(0)));
    let scale = ((config.moji_size as f32) * scale_y).round().max(10.0) as u32;

    let text_area_width = bw
        .saturating_sub(to_x(pad_left.max(0)))
        .saturating_sub(to_x(pad_right.max(0)))
        .max(1);

    let line_stride =
        (config.moji_size as i32 + config.moji_rep.1 + config.ruby_size.max(0)).max(1);
    let line_height = to_y(line_stride).max(1);

    WindowBoxGeometry {
        backdrop,
        origin_x,
        origin_y,
        scale,
        text_area_width,
        line_height,
    }
}

mod choice_window;
pub use choice_window::{
    ChoiceWindow, ObjectButtonChoiceOption, ObjectButtonChoiceWindow,
    ObjectButtonChoiceWindowBuildError,
};

/// Real TrueType glyph rasteriser for the localized text layer.
///
/// Renders LEGIBLE mixed-case English dialogue with the bundled DejaVu
/// Sans font (`assets/DejaVuSans.ttf`, compiled in with `include_bytes!`
/// — no runtime font lookup, no network). Glyphs are laid out with real
/// horizontal advances + kerning and anti-aliased coverage, so lowercase
/// is genuine lowercase (not folded to uppercase) and text reads at a
/// readable size. A code point the font has no glyph for (every CJK
/// Shift-JIS source character) falls back to the font's `.notdef` box, so
/// a localized English layer is still provably distinct — at the pixel
/// level — from the untranslated Japanese source.
mod font;

/// Typed errors surfaced by [`RenderPass::new`] when the caller-supplied
/// [`ScreenSize`] is unusable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RenderPassBuildError {
    /// Width or height is zero. The render pass refuses to silently
    /// emit a zero-pixel PNG.
    #[error(
        "render pass requires non-zero screen dimensions, got width={width} height={height} ({code})"
    )]
    ZeroScreenSize {
        code: String,
        width: u32,
        height: u32,
    },
}

/// Typed errors surfaced by [`RenderPass::emit_localized_screenshot`].
#[derive(Debug, thiserror::Error)]
pub enum RenderEmitError {
    /// Writing the PNG bytes to the managed [`RuntimeArtifactRoot`]
    /// failed (URI shape, symlink rejection, IO).
    #[error("render artifact write failed: {0}")]
    ArtifactWrite(String),
    /// The substrate frame sink rejected the announcement (evidence
    /// floor, artifact-kind allow-list, or capability).
    #[error("substrate frame sink rejected emission: {0}")]
    Sink(#[from] SinkError),
    /// Building the managed runtime-artifact URI failed.
    #[error("runtime artifact uri build failed: {0}")]
    UriBuild(String),
    /// Writing the PRIVATE full-fidelity PNG to its uncommitted
    /// on-disk path failed (directory creation or file write).
    #[error("private full-fidelity artifact write failed: {0}")]
    PrivateArtifactWrite(String),
    /// A non-empty localized [`TextLayer`] painted ZERO framebuffer
    /// pixels (off-screen origin, all-whitespace, or a glyph-less
    /// layer), so the emitted PNG would carry no localized text and the
    /// E2 screenshot would be a vacuous localization/redaction proof.
    /// The emit path refuses to announce it rather than discard the
    /// painted-pixel count [`Framebuffer::draw_text`] returns.
    #[error(
        "non-empty localized text layer painted zero pixels \
         ({char_count} chars across {line_count} lines); refusing to emit a \
         vacuous localized screenshot ({code})"
    )]
    BlankLocalizedText {
        code: String,
        char_count: usize,
        line_count: usize,
    },
}

/// Emit-boundary inputs for [`RenderPass::emit_scene_screenshots`]: the
/// managed public artifact root + run id + substrate sink, the private
/// full-fidelity output directory, and the public-frame redaction toggle.
pub struct SceneEmit<'a> {
    /// Managed runtime-artifact root the PUBLIC PNG is written under.
    pub root: &'a RuntimeArtifactRoot,
    /// Run-id segment for the managed public artifact URI.
    pub run_id: &'a str,
    /// Substrate frame sink the public frame is announced through (E2).
    pub sink: &'a dyn FrameArtifactSink,
    /// Directory the PRIVATE full-fidelity PNG is written to (uncommitted).
    pub private_dir: &'a Path,
    /// Public-frame redaction toggle. `true` (default) redacts image
    /// rects; `false` publishes the full-fidelity buffer.
    pub public_redact: bool,
}

impl std::fmt::Debug for SceneEmit<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SceneEmit")
            .field("run_id", &self.run_id)
            .field("private_dir", &self.private_dir)
            .field("public_redact", &self.public_redact)
            .finish_non_exhaustive()
    }
}

/// Compositing skip-reason / skipped-object / decode-warning records,
/// the structural [`RenderReport`], and the emit-result
/// [`SceneScreenshots`]. Bodies live in the [`render_report`] child
/// module; re-exported here so the crate public API path is unchanged.
mod render_report;
pub use render_report::{ObjectWarning, RenderReport, SceneScreenshots, SkipReason, SkippedObject};

/// The headless render pipeline. Owns a per-pass `frame_index`
/// counter, the framebuffer dimensions, and the optional
/// [`AssetPackage`] the image-object compositor resolves g00 assets
/// through. The encoded PNG bytes are persisted on disk through the
/// caller's [`RuntimeArtifactRoot`]; the pass itself retains no bytes.
pub struct RenderPass {
    width: u32,
    height: u32,
    frame_index: u64,
    /// Asset package the image-object compositor resolves
    /// `g00/<asset_key>.g00` through. `None` means no loader is bound, so
    /// image objects contribute no pixels (there is nothing to
    /// dereference).
    assets: Option<Arc<dyn AssetPackage>>,
}

impl std::fmt::Debug for RenderPass {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RenderPass")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("frame_index", &self.frame_index)
            .field("has_assets", &self.assets.is_some())
            .finish()
    }
}

#[path = "render_pipeline/render_pass.rs"]
mod render_pass;

/// Copyright-safe g00 edge-map redaction, nearest-neighbour scale, and
/// signed-thousandths colour-tone helpers. Bodies live in the
/// [`compositing`] child module.
mod compositing;
use compositing::{apply_tone, apply_tone_rgba, redact_edge_map, scale_dimension};

/// A concrete [`FrameArtifactSink`] validates every announced [`FrameArtifact`].
/// Its body lives in the [`sink`] child module; re-exported here unchanged.
mod sink;
pub use sink::RecordingFrameArtifactSink;

#[cfg(test)]
mod tests;
