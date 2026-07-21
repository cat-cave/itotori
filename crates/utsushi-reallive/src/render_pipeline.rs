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

impl RenderPass {
    pub fn new(screen_size: ScreenSize) -> Result<Self, RenderPassBuildError> {
        Self::with_dimensions(screen_size.width, screen_size.height)
    }

    /// Construct a render pass with raw `(width, height)`. Used by
    /// tests that want to drive the encoder without a full Gameexe
    /// parse.
    pub fn with_dimensions(width: u32, height: u32) -> Result<Self, RenderPassBuildError> {
        if width == 0 || height == 0 {
            return Err(RenderPassBuildError::ZeroScreenSize {
                code: RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE.to_string(),
                width,
                height,
            });
        }
        Ok(Self {
            width,
            height,
            frame_index: 0,
            assets: None,
        })
    }

    /// Bind the [`AssetPackage`] the image-object compositor resolves
    /// `g00/<asset_key>.g00` assets through. Consumes and returns `self`
    /// so it chains off a constructor.
    pub fn with_assets(mut self, assets: Arc<dyn AssetPackage>) -> Self {
        self.assets = Some(assets);
        self
    }

    /// Whether an asset package is bound (image objects can be
    /// dereferenced).
    pub fn has_assets(&self) -> bool {
        self.assets.is_some()
    }

    /// Framebuffer pixel width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Framebuffer pixel height.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The next `frame_index` the render pass will emit.
    pub fn next_frame_index(&self) -> u64 {
        self.frame_index
    }

    /// Rasterise `stack` into a fresh framebuffer under the default
    /// [`RedactionPolicy::Redact`] policy (no text layer). Image objects
    /// are rendered as a copyright-safe edge-outline; use
    /// [`Self::rasterise_with_policy`] with [`RedactionPolicy::Full`] to
    /// composite the real decoded g00 art.
    pub fn rasterise(&self, stack: &GraphicsObjectStack) -> Framebuffer {
        self.rasterise_with_policy(stack, RedactionPolicy::Redact)
    }

    /// Rasterise `stack` into a fresh framebuffer under `policy` (no text
    /// layer). The render order is `(layer: DCs, bg objects, fg objects)`
    /// then within each layer `(layer_order ascending, slot ascending)`.
    pub fn rasterise_with_policy(
        &self,
        stack: &GraphicsObjectStack,
        policy: RedactionPolicy,
    ) -> Framebuffer {
        self.rasterise_reporting(stack, policy).0
    }

    pub fn rasterise_object_button_choice(
        &self,
        stack: &GraphicsObjectStack,
        choice: &ObjectButtonChoiceWindow,
        policy: RedactionPolicy,
    ) -> Framebuffer {
        let mut framebuffer = self.rasterise_with_policy(stack, policy);
        framebuffer.draw_object_button_choice_window(choice);
        framebuffer
    }

    /// Rasterise `stack` under `policy` exactly like
    /// [`Self::rasterise_with_policy`], but ALSO return a [`RenderReport`]
    /// recording every object the compositor could not fully render
    /// (skipped objects with reasons + non-fatal decode warnings). This
    /// is the honest fail-soft surface: the framebuffer still composites
    /// whatever it can, and the report tells the caller whether anything
    /// was dropped (an empty report ⇒ a complete render of the stack).
    pub fn rasterise_reporting(
        &self,
        stack: &GraphicsObjectStack,
        policy: RedactionPolicy,
    ) -> (Framebuffer, RenderReport) {
        let mut framebuffer = Framebuffer::new(self.width, self.height);
        let mut report = RenderReport::default();
        let mut entries: Vec<(GraphicsLayer, i32, usize, &GraphicsObject)> = stack
            .iter_allocated_layers()
            .map(|(layer, slot, object)| (layer, object.layer_order, slot, object))
            .collect();
        entries.sort_by_key(|(layer, z, slot, _)| (layer.paint_order(), *z, *slot));
        for (layer, _, slot, object) in entries {
            if !object.visible {
                continue;
            }
            self.paint_object(
                &mut framebuffer,
                object,
                layer.diagnostic_plane(),
                slot,
                policy,
                &mut report,
            );
        }
        (framebuffer, report)
    }

    /// Rasterise `stack`, then paint the localized `text` layer on top.
    /// This is the frame the screenshot emission encodes. Returns the
    /// framebuffer **and** the count of localized-text pixels
    /// [`Framebuffer::draw_text`] painted, so the emission path can prove
    /// the localized layer actually drew something rather than discarding
    /// the count (a blank layer is a vacuous-evidence regression the
    /// caller must reject).
    pub fn rasterise_with_text(
        &self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
    ) -> (Framebuffer, u64) {
        self.rasterise_with_text_policy(stack, text, RedactionPolicy::Redact)
    }

    /// Rasterise `stack` under `policy`, then paint the localized `text`
    /// layer on top. Returns the framebuffer and the localized-text pixel
    /// count.
    pub fn rasterise_with_text_policy(
        &self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        policy: RedactionPolicy,
    ) -> (Framebuffer, u64) {
        let mut framebuffer = self.rasterise_with_policy(stack, policy);
        let text_pixels = framebuffer.draw_text(text);
        (framebuffer, text_pixels)
    }

    /// Rasterise `stack` + the localized `text` layer under the default
    /// [`RedactionPolicy::Redact`] policy, encode the deterministic PNG
    /// persist it to `root` under a managed `screenshots/<artifact_id>.png`
    /// URI, and announce a [`FrameArtifact`] at [`EvidenceTier::E2`]
    /// through `sink`. This is the public, redacted single-frame emit: an
    /// image object contributes only a copyright-safe edge-outline (see
    /// [`redact_edge_map`]), so the emitted PNG publishes no source art.
    /// The full-fidelity path is [`Self::emit_scene_screenshots`].
    ///
    /// NON-VACUOUS LOCALIZATION PROOF: a non-empty `text` layer that
    /// paints ZERO framebuffer pixels (off-screen origin, all-whitespace
    /// or a glyph-less layer) is rejected with
    /// [`RenderEmitError::BlankLocalizedText`] **before** any PNG is
    /// written or any frame announced, so an E2 localized screenshot can
    /// never be emitted with zero localized-text pixels painted.
    pub fn emit_localized_screenshot(
        &mut self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        root: &RuntimeArtifactRoot,
        run_id: &str,
        sink: &dyn FrameArtifactSink,
    ) -> Result<FrameArtifact, RenderEmitError> {
        let (framebuffer, text_pixels) = self.rasterise_with_text(stack, text);
        Self::reject_blank_localized(text, text_pixels)?;
        self.announce_framebuffer(&framebuffer, root, run_id, sink)
    }

    /// Emit the full-fidelity PRIVATE screenshot AND the public
    /// (policy-selected) screenshot for `stack` + `text`.
    ///
    /// 1. The full-fidelity framebuffer (real decoded g00 composited
    ///    [`RedactionPolicy::Full`]) is encoded and written to
    ///    `private_dir/<sha256>.png` — an uncommitted, hashable file on
    ///    disk. Its pixels are byte-derived from the decoded g00.
    /// 2. The public framebuffer is rendered under
    ///    [`RedactionPolicy::public_toggle`]`(emit.public_redact)`: with
    ///    `public_redact == true` (the default) image rects carry only a
    ///    copyright-safe edge-outline (see [`redact_edge_map`]); with
    ///    `false` the public buffer equals the full-fidelity buffer. It is
    ///    announced through `emit.sink` at E2.
    ///
    /// Redaction is thus a policy at THIS emit boundary — the render path
    /// itself always produces the full-fidelity buffer.
    pub fn emit_scene_screenshots(
        &mut self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        emit: SceneEmit<'_>,
    ) -> Result<SceneScreenshots, RenderEmitError> {
        // Full-fidelity private buffer (always real g00 art). Collect the
        // render report so any DROPPED object (e.g. an un-decodable
        // BACK.g00 background) is surfaced on the result rather than
        // silently omitted from a frame that would otherwise look
        // complete.
        let (mut full_fb, report) = self.rasterise_reporting(stack, RedactionPolicy::Full);
        let full_text_pixels = full_fb.draw_text(text);
        Self::reject_blank_localized(text, full_text_pixels)?;

        let private_png = encode_png_rgba_deterministic(&full_fb);
        let private_sha = sha256_hex(&private_png);
        std::fs::create_dir_all(emit.private_dir).map_err(|error| {
            RenderEmitError::PrivateArtifactWrite(format!(
                "create private dir {}: {error}",
                emit.private_dir.display()
            ))
        })?;
        let private_png_path = emit.private_dir.join(format!("{private_sha}.png"));
        std::fs::write(&private_png_path, &private_png).map_err(|error| {
            RenderEmitError::PrivateArtifactWrite(format!(
                "write {}: {error}",
                private_png_path.display()
            ))
        })?;

        // Public buffer under the redaction toggle. When redaction is off
        // the public buffer IS the full-fidelity buffer.
        let policy = RedactionPolicy::public_toggle(emit.public_redact);
        let public_fb = match policy {
            RedactionPolicy::Full => full_fb,
            RedactionPolicy::Redact => {
                self.rasterise_with_text_policy(stack, text, RedactionPolicy::Redact)
                    .0
            }
        };
        let public = self.announce_framebuffer(&public_fb, emit.root, emit.run_id, emit.sink)?;

        Ok(SceneScreenshots {
            public,
            private_png_path,
            private_png_sha256: private_sha,
            redaction: policy,
            skipped_objects: report.skipped_objects,
            decode_warnings: report.warnings,
        })
    }

    /// Reject a non-empty localized text layer that painted zero pixels.
    fn reject_blank_localized(text: &TextLayer, text_pixels: u64) -> Result<(), RenderEmitError> {
        if text.char_count() > 0 && text_pixels == 0 {
            return Err(RenderEmitError::BlankLocalizedText {
                code: RENDER_PIPELINE_BLANK_LOCALIZED_TEXT_CODE.to_string(),
                char_count: text.char_count(),
                line_count: text.lines.len(),
            });
        }
        Ok(())
    }

    /// Encode `framebuffer`, persist it under a managed
    /// `screenshots/<artifact_id>.png` URI on `root`, and announce a
    /// [`FrameArtifact`] at [`EvidenceTier::E2`] through `sink`. Advances
    /// the per-pass frame index.
    fn announce_framebuffer(
        &mut self,
        framebuffer: &Framebuffer,
        root: &RuntimeArtifactRoot,
        run_id: &str,
        sink: &dyn FrameArtifactSink,
    ) -> Result<FrameArtifact, RenderEmitError> {
        let png_bytes = encode_png_rgba_deterministic(framebuffer);
        let artifact_id = sha256_hex(&png_bytes);

        root.prepare()
            .map_err(|error| RenderEmitError::ArtifactWrite(error.to_string()))?;
        let uri = runtime_artifact_uri(run_id, RuntimeArtifactKind::Screenshot, &artifact_id)
            .map_err(|error| RenderEmitError::UriBuild(error.to_string()))?;
        root.write_bytes(&uri, &png_bytes)
            .map_err(|error| RenderEmitError::ArtifactWrite(error.to_string()))?;

        let artifact = FrameArtifact {
            frame_id: artifact_id.clone(),
            evidence_tier: EvidenceTier::E2,
            artifact_ref: ObservationArtifactRef {
                artifact_id,
                artifact_kind: SCREENSHOT_ARTIFACT_KIND.to_string(),
                uri,
                media_type: Some("image/png".to_string()),
            },
            width: Some(self.width),
            height: Some(self.height),
            frame_index: self.frame_index,
            bridge_ref: None,
        };
        sink.emit_frame(artifact.clone())?;
        self.frame_index = self.frame_index.saturating_add(1);
        Ok(artifact)
    }

    fn paint_object(
        &self,
        framebuffer: &mut Framebuffer,
        object: &GraphicsObject,
        plane: GraphicsPlane,
        slot: usize,
        policy: RedactionPolicy,
        report: &mut RenderReport,
    ) {
        match &object.kind {
            GraphicsObjectKind::Wipe { colour } => {
                // A wipe is a full-screen clear. Its recorded colour tone
                // and object-level alpha are applied uniformly with every
                // other object: a neutral-tone opaque wipe fills verbatim.
                let toned = apply_tone(*colour, object.colour_tone);
                framebuffer.fill_blended(toned, object.alpha.0);
            }
            GraphicsObjectKind::Image { image_ref } => {
                self.paint_image(
                    framebuffer,
                    object,
                    &image_ref.asset_key,
                    plane,
                    slot,
                    policy,
                    report,
                );
            }
        }
    }

    /// Record (and log, under [`RENDER_PIPELINE_OBJECT_SKIPPED_CODE`]) a
    /// fail-soft skip: an image object that contributed no pixels. The
    /// compositor keeps going, but the skip is NEVER silent.
    fn record_skip(
        report: &mut RenderReport,
        asset_key: &str,
        plane: GraphicsPlane,
        slot: usize,
        reason: SkipReason,
    ) {
        // No `tracing`/`log` dependency in this crate; the established
        // diagnostic channel here (see `bytecode_element`) is stderr. The
        // stable code prefix makes the line audit-greppable.
        eprintln!(
            "{RENDER_PIPELINE_OBJECT_SKIPPED_CODE}: asset_key={asset_key} \
             plane={plane:?} slot={slot} reason={reason:?}"
        );
        report.skipped_objects.push(SkippedObject {
            asset_key: asset_key.to_string(),
            plane,
            slot,
            reason,
        });
    }

    /// Dereference an image object's `asset_key` through the bound asset
    /// package, decode the g00 bytes, and composite the decoded bitmap
    /// into `framebuffer` at the object's position, applying its scale
    /// (nearest-neighbour resample), colour tone, and alpha. Under
    /// [`RedactionPolicy::Redact`] the same destination rect carries a
    /// copyright-safe edge-outline of the decoded pixels (see
    /// [`redact_edge_map`]) instead of the art itself, so the emitted
    /// frame publishes the scene's layout without its pixels. If no asset
    /// package is
    /// bound, or resolution / decoding fails, the object contributes no
    /// pixels — a fail-soft gap, never a panic. Every such gap is RECORDED
    /// on `report` (and logged) via [`Self::record_skip`] so the dropped
    /// object surfaces on the render result instead of a frame silently
    /// looking complete when it is not.
    // reason: cohesive paint step over distinct blit/render inputs; a params struct would add indirection without clarity.
    #[allow(clippy::too_many_arguments)]
    fn paint_image(
        &self,
        framebuffer: &mut Framebuffer,
        object: &GraphicsObject,
        asset_key: &str,
        plane: GraphicsPlane,
        slot: usize,
        policy: RedactionPolicy,
        report: &mut RenderReport,
    ) {
        let Some(assets) = self.assets.as_ref() else {
            Self::record_skip(report, asset_key, plane, slot, SkipReason::NoAssetPackage);
            return;
        };
        let logical = format!("g00/{asset_key}.g00");
        let asset_id = match assets.resolve(&logical) {
            Ok(asset_id) => asset_id,
            Err(error) => {
                Self::record_skip(
                    report,
                    asset_key,
                    plane,
                    slot,
                    SkipReason::ResolveFailed {
                        logical,
                        error: error.to_string(),
                    },
                );
                return;
            }
        };
        let bytes = match assets.open(&asset_id) {
            Ok(bytes) => bytes,
            Err(error) => {
                Self::record_skip(
                    report,
                    asset_key,
                    plane,
                    slot,
                    SkipReason::OpenFailed {
                        logical,
                        error: error.to_string(),
                    },
                );
                return;
            }
        };
        // LIVE decode of the real g00 bytes into an RGBA canvas. The
        // decoder's non-fatal warnings (short-payload zero-extension) are
        // surfaced on the report; a hard decode error records a
        // DecodeFailed skip (the fail-soft continues rendering the rest of
        // the stack) rather than silently dropping the object.
        let (image, warnings) = match decode_g00(bytes.as_slice()) {
            Ok(decoded) => decoded,
            Err(error) => {
                Self::record_skip(
                    report,
                    asset_key,
                    plane,
                    slot,
                    SkipReason::DecodeFailed {
                        error: error.to_string(),
                    },
                );
                return;
            }
        };
        for warning in warnings {
            report.warnings.push(ObjectWarning {
                asset_key: asset_key.to_string(),
                warning,
            });
        }
        let src_w = image.width;
        let src_h = image.height;
        if src_w == 0 || src_h == 0 {
            Self::record_skip(
                report,
                asset_key,
                plane,
                slot,
                SkipReason::ZeroDims {
                    src_w,
                    src_h,
                    dst_w: 0,
                    dst_h: 0,
                },
            );
            return;
        }
        let dst_w = scale_dimension(src_w, object.scale.x_thousandths);
        let dst_h = scale_dimension(src_h, object.scale.y_thousandths);
        if dst_w == 0 || dst_h == 0 {
            Self::record_skip(
                report,
                asset_key,
                plane,
                slot,
                SkipReason::ZeroDims {
                    src_w,
                    src_h,
                    dst_w,
                    dst_h,
                },
            );
            return;
        }
        // Select the source-space RGBA buffer the blit samples from.
        //
        // - `Full` composites the REAL decoded g00 (with the object's
        //   colour tone) — the private, full-fidelity buffer.
        // - `Redact` composites a copyright-safe EDGE-OUTLINE of the g00
        //   ([`redact_edge_map`]): the scene's structure/layout survives
        //   for proof value while colour, tone, and texture are discarded
        //   and no verbatim decoded run is republished. This REPLACES the
        //   old solid-marker fill, which painted over the whole frame and
        //   showed nothing.
        let redacted = match policy {
            RedactionPolicy::Full => None,
            RedactionPolicy::Redact => Some(redact_edge_map(&image.pixels_rgba, src_w, src_h)),
        };
        let source_pixels: &[u8] = match &redacted {
            Some(edges) => edges,
            None => &image.pixels_rgba,
        };
        let src_stride = (src_w as usize) * RGBA_BYTES_PER_PIXEL;
        for dy in 0..dst_h {
            // `object.position` comes from VM state and can be arbitrary;
            // saturating_add keeps a corrupt/out-of-range position from
            // overflowing i32 — a saturated coordinate falls outside the
            // framebuffer and is skipped by the bounds check below.
            let py = object.position.y.saturating_add(dy as i32);
            if py < 0 || py >= framebuffer.height as i32 {
                continue;
            }
            // Nearest-neighbour source row.
            let sy = ((dy as u64 * src_h as u64) / dst_h as u64) as u32;
            for dx in 0..dst_w {
                let px = object.position.x.saturating_add(dx as i32);
                if px < 0 || px >= framebuffer.width as i32 {
                    continue;
                }
                let sx = ((dx as u64 * src_w as u64) / dst_w as u64) as u32;
                let sidx = (sy as usize) * src_stride + (sx as usize) * RGBA_BYTES_PER_PIXEL;
                let sample = [
                    source_pixels[sidx],
                    source_pixels[sidx + 1],
                    source_pixels[sidx + 2],
                    source_pixels[sidx + 3],
                ];
                // The object's colour tone applies to the real art only;
                // the synthetic edge-outline carries no source tone.
                let src = match policy {
                    RedactionPolicy::Full => apply_tone_rgba(sample, object.colour_tone),
                    RedactionPolicy::Redact => sample,
                };
                framebuffer.blend_pixel(px as u32, py as u32, src, object.alpha.0);
            }
        }
    }
}

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
