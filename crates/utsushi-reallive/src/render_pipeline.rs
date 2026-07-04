//! UTSUSHI-214 / ALPHA-006b — headless render pipeline, localized text
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
//! E2 per-payload floor, the artifact-kind allow-list (`screenshot`),
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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::g00::{G00Warning, decode_g00};
use crate::gameexe::MessageWindowConfig;
use crate::graphics_objects::{
    GraphicsColourTone, GraphicsObject, GraphicsObjectKind, GraphicsObjectStack, GraphicsPlane,
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
/// image object contributes NO pixels (missing asset package, resolve /
/// open / decode failure, or a zero-extent sprite). The compositor is
/// fail-soft — it keeps rendering the rest of the stack — but the skip is
/// NEVER silent: it is logged under this code AND recorded on the
/// [`RenderReport`] so a consumer can tell an incomplete frame (one that
/// dropped an object, e.g. the un-decodable `BACK.g00` background) from a
/// complete render. See [`SkipReason`] / [`SkippedObject`].
pub const RENDER_PIPELINE_OBJECT_SKIPPED_CODE: &str =
    "utsushi.reallive.render_pipeline.object_skipped";

/// PNG file-magic. Pinned so the deterministic-encoder test can assert
/// the prefix without inlining the magic in the test itself.
pub const PNG_FILE_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// PNG colour type for RGBA: per the spec, value `6`.
pub const PNG_COLOUR_TYPE_RGBA: u8 = 6;

/// Bit depth this encoder writes (`8` bits per channel).
pub const PNG_BIT_DEPTH: u8 = 8;

/// Bytes per pixel (`RGBA = 4`).
pub const RGBA_BYTES_PER_PIXEL: usize = 4;

/// Stable `artifact_kind` the substrate frame sink announces for a
/// rasterized screenshot. Member of the sink's allow-list.
pub const SCREENSHOT_ARTIFACT_KIND: &str = "screenshot";

/// Framebuffer header carried in the IDAT scanlines: every PNG scanline
/// is prefixed with a one-byte filter code. The encoder uses `0` (no
/// filter) so the scanline contents stay byte-identical to the raw
/// framebuffer row.
const PNG_FILTER_NONE: u8 = 0;

/// Copyright-redaction policy applied at the artifact-emit boundary.
///
/// This is NOT hard-enforced inside the compositing loop: the render
/// path can always produce the full-fidelity buffer. The policy only
/// selects what an *emitted* frame carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactionPolicy {
    /// Composite the real decoded g00 art. Used for the PRIVATE,
    /// uncommitted full-fidelity artifact and for locally-authorized
    /// (redaction-off) public frames.
    Full,
    /// Replace every image object's rect with a copyright-safe
    /// EDGE-OUTLINE of the decoded g00 (see [`redact_edge_map`]): the
    /// scene's structure/layout survives for proof value while colour,
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

/// In-process framebuffer. A `width × height` grid of RGBA bytes in
/// row-major order. The render pass writes into the buffer directly;
/// the encoder consumes it byte-for-byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Framebuffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Framebuffer {
    /// Construct a `width × height` framebuffer, initialised to the
    /// fully-transparent (`r=g=b=a=0`) pattern.
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; (width as usize) * (height as usize) * RGBA_BYTES_PER_PIXEL],
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Borrow the raw RGBA bytes in row-major order.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Fill the entire framebuffer with `colour`, **in RGBA order**.
    /// The wipe-object renderer routes through this method.
    pub fn fill(&mut self, colour: WipeColour) {
        let pattern = [colour.red, colour.green, colour.blue, colour.alpha];
        for (index, byte) in self.pixels.iter_mut().enumerate() {
            *byte = pattern[index % RGBA_BYTES_PER_PIXEL];
        }
    }

    /// Copy every pixel of `src` into this framebuffer with its top-left
    /// at `(dst_x, dst_y)` (verbatim overwrite, no blending). Portions
    /// that fall outside this framebuffer are clipped. Used to stack
    /// several rendered message frames into one contact-sheet image for
    /// the message-window diagnostics.
    pub fn blit(&mut self, src: &Framebuffer, dst_x: u32, dst_y: u32) {
        for sy in 0..src.height {
            let py = dst_y + sy;
            if py >= self.height {
                break;
            }
            for sx in 0..src.width {
                let px = dst_x + sx;
                if px >= self.width {
                    break;
                }
                let src_off =
                    ((sy as usize) * (src.width as usize) + sx as usize) * RGBA_BYTES_PER_PIXEL;
                let dst_off =
                    ((py as usize) * (self.width as usize) + px as usize) * RGBA_BYTES_PER_PIXEL;
                self.pixels[dst_off..dst_off + RGBA_BYTES_PER_PIXEL]
                    .copy_from_slice(&src.pixels[src_off..src_off + RGBA_BYTES_PER_PIXEL]);
            }
        }
    }

    /// Whether `(x, y)` addresses a real pixel in this framebuffer.
    fn in_bounds(&self, x: u32, y: u32) -> bool {
        x < self.width && y < self.height
    }

    /// Source-over composite one RGBA `src` pixel at `(x, y)`, modulating
    /// the source alpha by `object_alpha` (`0..=255`). The effective
    /// source coverage is `src.a * object_alpha / 255`; the result is the
    /// standard non-premultiplied source-over of `src` onto the current
    /// destination pixel. `object_alpha == 255` with an opaque `src`
    /// (`src[3] == 255`) writes `src` verbatim. Out-of-bounds coordinates
    /// are clipped (no-op).
    fn blend_pixel(&mut self, x: u32, y: u32, src: [u8; RGBA_BYTES_PER_PIXEL], object_alpha: u8) {
        if x >= self.width || y >= self.height {
            return;
        }
        // Effective coverage in 0..=255.
        let cover = ((src[3] as u32) * (object_alpha as u32)) / 255;
        if cover == 0 {
            return;
        }
        let offset = ((y as usize) * (self.width as usize) + (x as usize)) * RGBA_BYTES_PER_PIXEL;
        let inv = 255 - cover;
        for (channel, &s) in src.iter().take(3).enumerate() {
            let d = self.pixels[offset + channel] as u32;
            // Rounded source-over: (s*cover + d*inv) / 255.
            self.pixels[offset + channel] = ((s as u32 * cover + d * inv + 127) / 255) as u8;
        }
        let da = self.pixels[offset + 3] as u32;
        // out_a = cover + da*(1 - cover); non-premultiplied alpha.
        self.pixels[offset + 3] = (cover + (da * inv + 127) / 255).min(255) as u8;
    }

    /// Blend `colour` across the entire framebuffer, modulating the
    /// fill by `object_alpha`. A wipe object routes through this method so
    /// its recorded object-level alpha (and its own `colour.alpha`) are
    /// applied: an opaque wipe fills verbatim, a fully-transparent-alpha
    /// wipe contributes nothing.
    pub fn fill_blended(&mut self, colour: WipeColour, object_alpha: u8) {
        let src = [colour.red, colour.green, colour.blue, colour.alpha];
        for y in 0..self.height {
            for x in 0..self.width {
                self.blend_pixel(x, y, src, object_alpha);
            }
        }
    }

    /// Source-over blend a filled rectangle of `colour` (its own
    /// `colour.alpha` is honoured) at `(x, y)` with extent `w × h`.
    /// Out-of-bounds portions are clipped. Used to paint the translucent
    /// dialogue-box backdrop behind the localized text so mixed-case
    /// glyphs stay legible over an arbitrary composited background.
    pub fn fill_rect_blended(&mut self, x: u32, y: u32, w: u32, h: u32, colour: WipeColour) {
        let src = [colour.red, colour.green, colour.blue, colour.alpha];
        for py in y..y.saturating_add(h) {
            for px in x..x.saturating_add(w) {
                self.blend_pixel(px, py, src, 0xFF);
            }
        }
    }

    /// Paint a [`TextLayer`] over the framebuffer.
    ///
    /// If the layer carries a [`TextBackdrop`], the translucent box is
    /// blended first so the glyphs read against a controlled backing (the
    /// dialogue-box look). The lines are then rasterised through the
    /// bundled TrueType [`font`] (DejaVu Sans) at `layer.scale`-derived
    /// pixel height, with real horizontal advances + kerning and
    /// anti-aliased coverage. Returns the number of GLYPH-coverage pixels
    /// painted (the backdrop fill is NOT counted), so the non-vacuous
    /// guard in the emit path still rejects a layer whose text drew
    /// nothing.
    pub fn draw_text(&mut self, layer: &TextLayer) -> u64 {
        if let Some(backdrop) = layer.backdrop {
            self.fill_rect_blended(
                backdrop.x,
                backdrop.y,
                backdrop.width,
                backdrop.height,
                backdrop.colour,
            );
        }
        let mut painted = font::draw_lines(self, layer);
        // Paint the separate speaker name box (RealLive NAME_MOD=1) on
        // top, so its backdrop + glyphs land after the message box.
        if let Some(name_box) = &layer.name_box {
            painted += self.draw_text(name_box);
        }
        painted
    }

    /// Paint a [`ChoiceWindow`] selection screen: the config-driven box
    /// backdrop, a highlight strip behind the focused option row, and each
    /// option label as its own cursor-prefixed line (the focused option in
    /// bright white, the rest dimmed). Returns the number of GLYPH-coverage
    /// pixels painted, so the non-vacuous emit guard still rejects a choice
    /// window whose options drew nothing.
    ///
    /// The stronger per-row highlight (vs. the flat [`ChoiceWindow::to_text_layer`])
    /// makes the focused option unambiguous in a diagnostic frame — the
    /// visual proof that selecting option K focuses option K.
    pub fn draw_choice_window(&mut self, choice: &ChoiceWindow) -> u64 {
        // Config-driven box backdrop.
        let backdrop = choice.backdrop;
        self.fill_rect_blended(
            backdrop.x,
            backdrop.y,
            backdrop.width,
            backdrop.height,
            backdrop.colour,
        );
        let mut painted = 0u64;
        for (index, option) in choice.options.iter().enumerate() {
            let focused = index == choice.selected;
            let row_y = choice
                .origin_y
                .saturating_add((index as u32).saturating_mul(choice.line_height));
            if focused {
                // Highlight strip behind the focused option row (a
                // translucent accent so the underlying box still reads).
                self.fill_rect_blended(
                    backdrop.x,
                    row_y.saturating_sub(2),
                    backdrop.width,
                    choice.line_height.saturating_add(4),
                    WipeColour {
                        red: 52,
                        green: 88,
                        blue: 148,
                        alpha: 160,
                    },
                );
            }
            let colour = if focused {
                WipeColour::WHITE
            } else {
                WipeColour {
                    red: 176,
                    green: 182,
                    blue: 200,
                    alpha: 255,
                }
            };
            let row = TextLayer {
                lines: vec![format!("{}{option}", choice.prefix(index))],
                origin_x: choice.origin_x,
                origin_y: row_y,
                scale: choice.scale,
                colour,
                backdrop: None,
                name_box: None,
                line_height: Some(choice.line_height),
            };
            painted += self.draw_text(&row);
        }
        painted
    }

    /// Paint a [`SpatialChoiceWindow`] — the SIDE-BY-SIDE graphical select
    /// (Sweetie HD's route / love-interest pick, driven by
    /// `sel.select_objbtn`). Each option is a panel laid out horizontally;
    /// the focused / hovered option is painted in FULL COLOUR with a bright
    /// border and its name/label below, every other option is DIMMED to
    /// grayscale with a dim border (the real screen greys the un-hovered
    /// characters and colours only the hovered one). Returns the number of
    /// GLYPH-coverage pixels painted (the selected option's name), so the
    /// non-vacuous emit guard still rejects a spatial window that drew no
    /// label.
    ///
    /// The option ART (the character option graphics) is not decoded on
    /// this path, so each panel is a faithful PLACEHOLDER: a per-option
    /// solid fill (full-colour when focused, desaturated + dimmed when not)
    /// standing in for the option's g00 art. Decoding the real option art
    /// is a follow-up; the spatial LAYOUT, the hover colour/grayscale
    /// state, and the name label are the real behaviour.
    pub fn draw_spatial_choice_window(&mut self, choice: &SpatialChoiceWindow) -> u64 {
        let mut painted = 0u64;
        for (index, option) in choice.options.iter().enumerate() {
            let focused = index == choice.selected;
            // Placeholder option-art panel: full colour when focused, a
            // desaturated + dimmed grayscale when not (the real screen
            // renders the un-hovered character grayscale).
            let panel_colour = if focused {
                option.art_colour
            } else {
                desaturate_dim(option.art_colour)
            };
            self.fill_rect_blended(option.x, option.y, option.w, option.h, panel_colour);

            // Border: a bright accent frame around the focused option, a
            // dim frame around the rest — a second, shape-level cue that
            // the selection is unambiguous.
            let (border_colour, border_thickness) = if focused {
                (WipeColour::opaque_rgb(0xFF, 0xE0, 0x66), 5u32)
            } else {
                (WipeColour::opaque_rgb(0x50, 0x54, 0x60), 2u32)
            };
            self.stroke_rect(
                option.x,
                option.y,
                option.w,
                option.h,
                border_thickness,
                border_colour,
            );

            // The focused option's NAME / label in a bottom-centre panel
            // (the real screen shows the hovered character's name + profile
            // at bottom-centre). Only the focused option is labelled, to
            // match the hover behaviour.
            if focused {
                let label_h = choice.label_height.max(1);
                let label_y = option
                    .y
                    .saturating_add(option.h)
                    .saturating_sub(label_h)
                    .max(option.y);
                let backdrop = TextBackdrop {
                    x: option.x,
                    y: label_y,
                    width: option.w,
                    height: label_h,
                    colour: WipeColour {
                        red: 16,
                        green: 20,
                        blue: 34,
                        alpha: 210,
                    },
                };
                let layer = TextLayer {
                    lines: vec![option.label.clone()],
                    origin_x: option.x.saturating_add(choice.label_scale / 2),
                    origin_y: label_y.saturating_add(label_h / 4),
                    scale: choice.label_scale,
                    colour: WipeColour::WHITE,
                    backdrop: Some(backdrop),
                    name_box: None,
                    line_height: Some(label_h),
                };
                painted += self.draw_text(&layer);
            }
        }
        painted
    }

    /// Paint a hollow rectangle border of `colour`, `thickness` px wide,
    /// along the inside edge of the `(x, y, w, h)` rect. Used to frame a
    /// [`SpatialChoiceWindow`] option panel.
    fn stroke_rect(&mut self, x: u32, y: u32, w: u32, h: u32, thickness: u32, colour: WipeColour) {
        let t = thickness.min(w).min(h).max(1);
        // Top + bottom edges.
        self.fill_rect_blended(x, y, w, t, colour);
        self.fill_rect_blended(x, y.saturating_add(h).saturating_sub(t), w, t, colour);
        // Left + right edges.
        self.fill_rect_blended(x, y, t, h, colour);
        self.fill_rect_blended(x.saturating_add(w).saturating_sub(t), y, t, h, colour);
    }
}

/// Desaturate a colour to its Rec.601 luminance and dim it — the
/// grayscale look the spatial select paints on an UN-hovered option
/// panel. Alpha is preserved.
fn desaturate_dim(colour: WipeColour) -> WipeColour {
    // Rec.601 luma in 0..=255 (integer-weighted: 0.299, 0.587, 0.114).
    let luma = ((colour.red as u32 * 299 + colour.green as u32 * 587 + colour.blue as u32 * 114)
        / 1000) as u8;
    // Dim toward black so the un-hovered panel reads as recessed.
    let dimmed = ((luma as u32) * 60 / 100) as u8;
    WipeColour {
        red: dimmed,
        green: dimmed,
        blue: dimmed,
        alpha: colour.alpha,
    }
}

/// A localized text layer painted on top of the rasterised graphics
/// object stack. The `lines` are OUR translated (localized) strings —
/// the render pass paints them through the in-crate bitmap [`font`], so
/// the emitted PNG carries the localized text, never the source g00
/// pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextLayer {
    /// Localized text lines, top to bottom.
    pub lines: Vec<String>,
    /// Top-left origin (framebuffer pixels).
    pub origin_x: u32,
    pub origin_y: u32,
    /// Glyph pixel height (the `em` size the TrueType [`font`] is scaled
    /// to). Named `scale` for source-compatibility; it is now an actual
    /// point size in framebuffer pixels rather than an integer bitmap
    /// upscale. `>= 1`.
    pub scale: u32,
    /// Glyph colour (RGBA).
    pub colour: WipeColour,
    /// Optional translucent backdrop box painted behind the text (the
    /// dialogue-box backing). `None` paints glyphs directly over the
    /// composited frame.
    pub backdrop: Option<TextBackdrop>,
    /// Optional separate speaker name box (RealLive `NAME_MOD=1`),
    /// painted as its own backdrop + glyph layer floating above the main
    /// message box. `None` for narration or `NAME_MOD=0`.
    pub name_box: Option<Box<TextLayer>>,
    /// Optional baseline-to-baseline line advance in framebuffer pixels.
    /// The message window sets this to the `MOJI_SIZE`-derived row stride
    /// (`MOJI_SIZE + MOJI_REP.y + LUBY_SIZE`, scaled) so wrapped lines pack
    /// at the SAME stride the Gameexe-driven box height is sized from
    /// (`box_text_height_virtual`) — the engine's fixed row pitch, not the
    /// font's natural leading. `None` falls back to the font's natural
    /// ascent+descent+leading (narration / name box / [`Self::localized`]).
    pub line_height: Option<u32>,
}

/// A translucent filled box painted behind a [`TextLayer`]'s glyphs so
/// mixed-case dialogue stays legible over an arbitrary background — the
/// VN dialogue-box backing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextBackdrop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Fill colour; its `alpha` controls how much of the frame shows
    /// through.
    pub colour: WipeColour,
}

impl TextLayer {
    /// Construct a text layer with the documented default placement
    /// (origin `(16, 16)`, `24`px glyphs, opaque white, no backdrop).
    pub fn localized(lines: Vec<String>) -> Self {
        Self {
            lines,
            origin_x: 16,
            origin_y: 16,
            scale: 24,
            colour: WipeColour::WHITE,
            backdrop: None,
            name_box: None,
            line_height: None,
        }
    }

    /// Lay out a SINGLE RealLive message inside its Gameexe-configured
    /// dialogue box — the message-window subsystem's core placement.
    ///
    /// `text` is the ONE current message (never a whole scene concatenated
    /// — the caller advances one message per frame). `speaker` is the
    /// message's `NAME`-register speaker, if any. `config` is the real
    /// `#WINDOW.000` set read from `Gameexe.ini`; `screen_size` is the
    /// game's declared virtual space the config coordinates live in
    /// ([`crate::Gameexe::screen_size_px`]); `frame_size` is the actual
    /// framebuffer. The box position / colour / alpha / font-size / insets
    /// are all driven from `config`, scaled `screen_size → frame_size`.
    ///
    /// The message body is WORD-WRAPPED at the `MOJI_CNT` boundary so a
    /// long message does not overflow the box horizontally: the per-line
    /// character budget is turned into a pixel budget (`MOJI_CNT.x` cells of
    /// `MOJI_SIZE + MOJI_REP.x`), clamped to the box inner width (the
    /// `MOJI_POS` left/right insets), and the text is broken on WORD
    /// boundaries within it — the faithful proportional-font approximation
    /// of RealLive's fixed-cell wrap (see [`font::wrap_words`]). Wrapped
    /// lines advance by the `MOJI_SIZE`-derived line height in
    /// [`font::draw_lines`]. The name box is NOT wrapped.
    ///
    /// When `config.name_mod == 1` AND `speaker` is present, a SEPARATE
    /// name box is attached (per `NAME_POS` / `NAME_MOJI_SIZE`); narration
    /// (no speaker) or `NAME_MOD=0` attaches none.
    pub fn message_window(
        text: &str,
        speaker: Option<&str>,
        config: &MessageWindowConfig,
        screen_size: (u32, u32),
        frame_size: (u32, u32),
    ) -> Self {
        Self::message_window_colored(text, speaker, None, config, screen_size, frame_size)
    }

    /// [`Self::message_window`] with an explicit per-speaker dialogue
    /// text colour. When `text_color` is `Some`, BOTH the main dialogue
    /// glyphs and the attached `NAME_MOD=1` name-box glyphs are painted
    /// in that colour (the RealLive `#NAMAE` → `#COLOR_TABLE` speaker
    /// colour); `None` paints opaque white (the legacy default).
    pub fn message_window_colored(
        text: &str,
        speaker: Option<&str>,
        text_color: Option<WipeColour>,
        config: &MessageWindowConfig,
        screen_size: (u32, u32),
        frame_size: (u32, u32),
    ) -> Self {
        let glyph_colour = text_color.unwrap_or(WipeColour::WHITE);
        let scale_y = frame_size.1 as f32 / (screen_size.1.max(1) as f32);
        let scale_x = frame_size.0 as f32 / (screen_size.0.max(1) as f32);
        let to_x = |v: i32| (v as f32 * scale_x).round().max(0.0) as u32;
        let to_y = |v: i32| (v as f32 * scale_y).round().max(0.0) as u32;

        // --- Config-driven box rectangle + text metrics (shared with the
        // choice/selection window via `window_box_geometry`). ---
        // The waku (frame graphic) that sizes a real RealLive window is
        // not decoded in this port, so the box extent is derived from the
        // POS offsets: POS.x is the horizontal inset (symmetric), and the
        // POS origin type + POS.y anchor the vertical band — a documented,
        // config-driven approximation.
        let geometry = window_box_geometry(config, screen_size, frame_size);
        let backdrop = geometry.backdrop;
        let (bx, by) = (backdrop.x, backdrop.y);
        let (r, g, b, alpha) = config.attr_rgba;
        let origin_x = geometry.origin_x;
        let origin_y = geometry.origin_y;
        let scale = geometry.scale;

        // --- Word-wrap the message body at the MOJI_CNT boundary. ---
        // RealLive wraps message text at `MOJI_CNT.x` characters per line.
        // With the game's fixed-width CJK font that is a hard glyph-cell
        // count; we render a PROPORTIONAL Latin font, so the faithful
        // approximation is a PIXEL budget derived from that same character
        // count — `MOJI_CNT.x` cells of `MOJI_SIZE + MOJI_REP.x` px each —
        // wrapped on WORD boundaries so a line reads naturally and never
        // exceeds the engine's line width. That budget is clamped to the
        // box's inner text width (box extent minus the MOJI_POS left/right
        // insets) so no glyph can ever cross the box's right inset even if
        // MOJI_CNT is generous.
        let wrap_width = match config.moji_cnt {
            Some((x_chars, _)) if x_chars > 0 => {
                let cell_w = (config.moji_size as i32 + config.moji_rep.0).max(1);
                to_x(x_chars * cell_w).min(geometry.text_area_width).max(1)
            }
            // No MOJI_CNT declared: wrap at the box's inner text width.
            _ => geometry.text_area_width,
        };
        let lines = font::wrap_words(text, scale as f32, wrap_width as f32);

        // Wrapped lines advance by the MOJI_SIZE-derived ROW STRIDE
        // (MOJI_SIZE + MOJI_REP.y + LUBY_SIZE, scaled) — the SAME stride
        // `box_text_height_virtual` sizes the box from — so N wrapped lines
        // occupy exactly the N-row text area, rather than the font's larger
        // natural leading which would push later lines past the box bottom.
        let line_height = geometry.line_height;

        let mut layer = Self {
            lines,
            origin_x,
            origin_y,
            scale,
            colour: glyph_colour,
            backdrop: Some(backdrop),
            name_box: None,
            line_height: Some(line_height),
        };

        // --- Separate speaker name box (NAME_MOD=1 + a real speaker). ---
        if config.name_mod == 1
            && let Some(name) = speaker.map(str::trim).filter(|s| !s.is_empty())
        {
            let name_scale = ((config.name_moji_size as f32) * scale_y).round().max(10.0) as u32;
            let (name_off_x, name_off_y) = config.name_pos;
            // Height for one line + vertical padding; width sized to the
            // name plus a small horizontal pad.
            let name_h = name_scale + name_scale / 2;
            let approx_glyph_w = (name_scale * 6 / 10).max(1);
            let name_w = (name.chars().count() as u32 + 2) * approx_glyph_w;
            let name_x = bx.saturating_add(to_x(name_off_x.max(0)));
            // NAME_POS.y offsets down from the box top; the box floats
            // ABOVE the message box top by its own height (rlvm places the
            // name waku at `window.y + name_y_offset - namebox_height`).
            let name_top =
                (by as i32 + to_y(name_off_y.max(0)) as i32 - name_h as i32).max(0) as u32;
            let name_backdrop = TextBackdrop {
                x: name_x,
                y: name_top,
                width: name_w,
                height: name_h,
                colour: WipeColour {
                    red: r,
                    green: g,
                    blue: b,
                    alpha,
                },
            };
            layer.name_box = Some(Box::new(Self {
                lines: vec![name.to_string()],
                origin_x: name_x.saturating_add(name_scale / 4),
                origin_y: name_top.saturating_add(name_scale / 6),
                scale: name_scale,
                colour: glyph_colour,
                backdrop: Some(name_backdrop),
                name_box: None,
                // Single-line name: font-natural leading (unchanged).
                line_height: None,
            }));
        }

        layer
    }

    /// Total number of characters across all lines, INCLUDING the
    /// attached name box if any.
    pub fn char_count(&self) -> usize {
        let main: usize = self.lines.iter().map(|line| line.chars().count()).sum();
        main + self.name_box.as_ref().map_or(0, |name| name.char_count())
    }
}

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
/// Every field is derived from a `#WINDOW.NNN` [`MessageWindowConfig`],
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

/// A RealLive `select` prompt rendered as a selection SCREEN: the choice
/// options laid out as a legible, cursor-highlighted list inside the
/// Gameexe-configured selection window (`#DEFAULT_SEL_WINDOW` →
/// `#WINDOW.NNN`, resolved by [`crate::Gameexe::sel_window`]).
///
/// The option strings are OUR translated (localized) choice labels
/// (NextString-safe) — the render paints them through the in-crate bitmap
/// [`font`], never the source g00 pixels. [`ChoiceWindow::from_config`]
/// places the list with the SAME config-driven box math the message window
/// uses ([`window_box_geometry`]); the `selected` option carries a cursor
/// marker (`> `) plus a brighter highlight strip so the frame shows WHICH
/// option the engine has focused.
///
/// This is the visual counterpart to the `select option K → branch K` act:
/// re-rendering with `selected == K` moves the cursor onto option K, and
/// the play stream continues down branch K (see
/// [`crate::ReplayEngine::branch_following_lines`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceWindow {
    /// Localized (translated) option labels, top to bottom.
    pub options: Vec<String>,
    /// Index of the focused / cursor-highlighted option (clamped into
    /// range at construction).
    pub selected: usize,
    /// The Gameexe-configured selection-window backdrop rectangle.
    pub backdrop: TextBackdrop,
    /// Text origin (framebuffer px) of the first option row.
    pub origin_x: u32,
    pub origin_y: u32,
    /// Glyph pixel height (MOJI_SIZE-derived).
    pub scale: u32,
    /// Baseline-to-baseline row stride between stacked options
    /// (MOJI_SIZE + MOJI_REP.y + LUBY_SIZE, scaled) — the engine's fixed
    /// row pitch.
    pub line_height: u32,
}

impl ChoiceWindow {
    /// Cursor prefix for the focused option.
    const CURSOR_PREFIX: &'static str = "> ";
    /// Padding prefix (same width) for the unfocused options, so the
    /// labels stay column-aligned whether or not the cursor is on them.
    const IDLE_PREFIX: &'static str = "  ";

    /// Lay out `options` as a selection screen inside the sel-window
    /// `config` (typically [`crate::Gameexe::sel_window`]), with `selected`
    /// cursor-highlighted. `screen_size` is the game's virtual space the
    /// config lives in; `frame_size` is the framebuffer. Box position /
    /// colour / alpha / font-size / insets are all config-driven.
    pub fn from_config(
        options: &[String],
        selected: usize,
        config: &MessageWindowConfig,
        screen_size: (u32, u32),
        frame_size: (u32, u32),
    ) -> Self {
        let geometry = window_box_geometry(config, screen_size, frame_size);
        let selected = if options.is_empty() {
            0
        } else {
            selected.min(options.len() - 1)
        };
        Self {
            options: options.to_vec(),
            selected,
            backdrop: geometry.backdrop,
            origin_x: geometry.origin_x,
            origin_y: geometry.origin_y,
            scale: geometry.scale,
            line_height: geometry.line_height,
        }
    }

    /// Total number of glyph characters across all option rows, INCLUDING
    /// the cursor / padding prefixes — the non-vacuous-render denominator.
    pub fn char_count(&self) -> usize {
        self.options
            .iter()
            .map(|option| option.chars().count() + Self::CURSOR_PREFIX.chars().count())
            .sum()
    }

    /// The prefix for option `index` (cursor for the focused option, an
    /// equal-width pad otherwise).
    fn prefix(&self, index: usize) -> &'static str {
        if index == self.selected {
            Self::CURSOR_PREFIX
        } else {
            Self::IDLE_PREFIX
        }
    }

    /// A single [`TextLayer`] carrying the box backdrop + every option row
    /// (cursor-prefixed), so the choice screen can flow straight through
    /// the FrameArtifact emit path
    /// ([`RenderPass::emit_localized_screenshot`]) exactly like a
    /// message-window frame. The focused option is cursor-marked; the
    /// stronger per-row highlight is a [`Framebuffer::draw_choice_window`]
    /// nicety not expressible on a single flat layer.
    pub fn to_text_layer(&self) -> TextLayer {
        let lines = self
            .options
            .iter()
            .enumerate()
            .map(|(index, option)| format!("{}{option}", self.prefix(index)))
            .collect();
        TextLayer {
            lines,
            origin_x: self.origin_x,
            origin_y: self.origin_y,
            scale: self.scale,
            colour: WipeColour::WHITE,
            backdrop: Some(self.backdrop),
            name_box: None,
            line_height: Some(self.line_height),
        }
    }
}

/// A single option in a [`SpatialChoiceWindow`]: its localized name /
/// label and the panel rectangle it occupies. `art_colour` is the
/// placeholder fill standing in for the not-yet-decoded option g00 art
/// (full-colour when the option is focused; [`desaturate_dim`]-ed when
/// not).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialOption {
    /// Localized (translated) option label — e.g. the character / route
    /// name shown for the hovered option.
    pub label: String,
    /// Panel top-left (framebuffer px).
    pub x: u32,
    pub y: u32,
    /// Panel extent (framebuffer px).
    pub w: u32,
    pub h: u32,
    /// Placeholder option-art fill (stands in for the decoded g00
    /// character graphic).
    pub art_colour: WipeColour,
}

/// A RealLive `select_objbtn` (object-button) prompt rendered as a
/// SPATIAL, side-by-side graphical select — Sweetie HD's route /
/// love-interest pick (the game's first choice: two characters
/// side-by-side, the hovered one in full colour, the other grayscale,
/// with the hovered one's name shown).
///
/// This is a distinct RENDER modality from the vertical text-list
/// [`ChoiceWindow`]: the options are laid out HORIZONTALLY (one panel
/// per option), and the focused option is cued by COLOUR (full colour
/// vs. desaturated grayscale) + a bright border + a name label, rather
/// than a `> ` cursor on a stacked row. The ACT half is unchanged: the
/// selected index still resolves through the store register + `goto_on`
/// (see [`crate::ReplayEngine::branch_following_lines`]), so option K →
/// route branch K exactly like the text select.
///
/// The option labels are OUR translated (localized) strings; the render
/// paints them through the in-crate bitmap [`font`], never the source
/// g00 pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialChoiceWindow {
    /// The option panels, left to right.
    pub options: Vec<SpatialOption>,
    /// Index of the focused / hovered option (clamped into range at
    /// construction).
    pub selected: usize,
    /// Glyph pixel height for the option name label.
    pub label_scale: u32,
    /// Height (framebuffer px) of the bottom-centre name-label band on
    /// the focused option panel.
    pub label_height: u32,
}

impl SpatialChoiceWindow {
    /// Default palette the placeholder option panels cycle through so two
    /// side-by-side options are visually distinct even before the real
    /// g00 art is decoded. Deterministic per option index.
    const PLACEHOLDER_PALETTE: &'static [WipeColour] = &[
        WipeColour::opaque_rgb(0xC8, 0x4B, 0x6E), // warm rose (left)
        WipeColour::opaque_rgb(0x4B, 0x74, 0xC8), // cool blue (right)
        WipeColour::opaque_rgb(0x5A, 0xA0, 0x60), // green
        WipeColour::opaque_rgb(0xC8, 0x9B, 0x4B), // amber
    ];

    /// Lay out `options` as a horizontal, side-by-side spatial select in
    /// a `screen`-sized framebuffer, with `selected` focused. The panels
    /// split the screen width into equal columns (a small gutter between
    /// them), inset from the frame edges; each gets a placeholder art
    /// colour from [`Self::PLACEHOLDER_PALETTE`].
    ///
    /// `screen` is the framebuffer size in px. The layout is derived from
    /// the frame geometry (a spatial 2-option select occupies the full
    /// screen split down the middle), not a `#WINDOW.NNN` text box — the
    /// object-button select is placed by its button sprites, not a sel
    /// window.
    pub fn from_options(options: &[String], selected: usize, screen: (u32, u32)) -> Self {
        let (sw, sh) = (screen.0.max(1), screen.1.max(1));
        let n = options.len().max(1) as u32;
        let selected = if options.is_empty() {
            0
        } else {
            selected.min(options.len() - 1)
        };
        // Outer margin + inter-panel gutter, scaled modestly to the frame.
        let margin_x = (sw / 24).max(4);
        let margin_y = (sh / 12).max(4);
        let gutter = (sw / 48).max(4);
        let usable_w = sw
            .saturating_sub(margin_x * 2)
            .saturating_sub(gutter * (n - 1))
            .max(n);
        let panel_w = (usable_w / n).max(1);
        let panel_h = sh.saturating_sub(margin_y * 2).max(1);
        let label_scale = (sh / 24).clamp(14, 48);
        let label_height = (label_scale * 2).min(panel_h);

        let spatial_options = options
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let x = margin_x + (panel_w + gutter) * index as u32;
                SpatialOption {
                    label: label.clone(),
                    x,
                    y: margin_y,
                    w: panel_w,
                    h: panel_h,
                    art_colour: Self::PLACEHOLDER_PALETTE[index % Self::PLACEHOLDER_PALETTE.len()],
                }
            })
            .collect();

        Self {
            options: spatial_options,
            selected,
            label_scale,
            label_height,
        }
    }

    /// Total number of glyph characters shown (the focused option's
    /// label) — the non-vacuous-render denominator.
    pub fn char_count(&self) -> usize {
        self.options
            .get(self.selected)
            .map_or(0, |option| option.label.chars().count())
    }
}

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
mod font {
    use std::sync::OnceLock;

    use swash::FontRef;
    use swash::scale::{Render, ScaleContext, Source};
    use swash::zeno::Format;

    use super::{Framebuffer, TextLayer};

    /// Bundled font bytes. Compiled into the binary; never read from disk
    /// or the network at runtime.
    const FONT_BYTES: &[u8] = include_bytes!("../assets/DejaVuSans.ttf");

    /// Parse the bundled font once. The bytes are a fixed compiled-in
    /// asset, so a parse failure is a build-time-shipped-corrupt-asset
    /// bug, not a runtime condition — `expect` is the honest contract.
    fn font() -> FontRef<'static> {
        static FONT: OnceLock<FontRef<'static>> = OnceLock::new();
        *FONT.get_or_init(|| {
            FontRef::from_index(FONT_BYTES, 0).expect("bundled DejaVuSans.ttf must parse")
        })
    }

    /// Rasterise every line of `layer` through the TrueType font (via the
    /// maintained `swash` scaler + `zeno` rasteriser — the `fontations`
    /// stack, `cargo deny`-clean). Returns the count of glyph-coverage
    /// framebuffer pixels painted (coverage `> 0`), so the emit path can
    /// prove the localized text actually drew something.
    pub fn draw_lines(framebuffer: &mut Framebuffer, layer: &TextLayer) -> u64 {
        let font = font();
        let px = layer.scale.max(1) as f32;
        // Per-em-scaled vertical + horizontal metrics.
        let metrics = font.metrics(&[]).scale(px);
        let glyph_metrics = font.glyph_metrics(&[]).scale(px);
        let charmap = font.charmap();
        // Line-to-line advance: the message window pins this to its
        // MOJI_SIZE-derived row stride (`layer.line_height`) so wrapped
        // lines pack into the Gameexe-sized box exactly; otherwise the
        // font's natural ascent + descent + recommended leading.
        let line_advance = match layer.line_height {
            Some(h) => h as f32,
            None => metrics.ascent + metrics.descent.abs() + metrics.leading,
        };
        let colour = layer.colour;
        let mut painted: u64 = 0;

        // Reused per-call scaler context + alpha (8-bit coverage) renderer.
        let mut context = ScaleContext::new();
        let mut scaler = context.builder(font).size(px).hint(false).build();
        let mut render = Render::new(&[Source::Outline]);
        render.format(Format::Alpha);

        for (line_index, line) in layer.lines.iter().enumerate() {
            // Baseline for this line: origin + ascent + N line advances.
            let baseline_y =
                layer.origin_y as f32 + metrics.ascent + (line_index as f32) * line_advance;
            if baseline_y - metrics.ascent >= framebuffer.height as f32 {
                break;
            }
            let mut caret_x = layer.origin_x as f32;

            for character in line.chars() {
                // A code point the font lacks maps to glyph 0 (`.notdef`,
                // the box), so a localized English layer stays provably
                // distinct — at the pixel level — from the untranslated
                // Shift-JIS source.
                let glyph_id = charmap.map(character);
                let advance = glyph_metrics.advance_width(glyph_id);

                let Some(image) = render.render(&mut scaler, glyph_id) else {
                    // No rasterised outline (e.g. a space) — advance only.
                    caret_x += advance;
                    continue;
                };
                let placement = image.placement;
                if placement.width == 0 || placement.height == 0 {
                    caret_x += advance;
                    continue;
                }
                // `placement.left` is the pixel offset right of the pen
                // origin; `placement.top` the offset ABOVE the baseline to
                // the top of the coverage bitmap.
                let base_x = caret_x.round() as i32 + placement.left;
                let base_y = baseline_y.round() as i32 - placement.top;

                for gy in 0..placement.height {
                    for gx in 0..placement.width {
                        // 8-bit alpha mask: one coverage byte per pixel,
                        // row-major, for anti-aliased edges.
                        let cover = image.data[(gy * placement.width + gx) as usize];
                        if cover == 0 {
                            continue;
                        }
                        let px_x = base_x + gx as i32;
                        let px_y = base_y + gy as i32;
                        if px_x < 0 || px_y < 0 {
                            continue;
                        }
                        if !framebuffer.in_bounds(px_x as u32, px_y as u32) {
                            continue;
                        }
                        framebuffer.blend_pixel(
                            px_x as u32,
                            px_y as u32,
                            [colour.red, colour.green, colour.blue, colour.alpha],
                            cover,
                        );
                        painted += 1;
                    }
                }
                caret_x += advance;
            }
        }
        painted
    }

    /// Rendered pixel width of `text` at `px` em size through the bundled
    /// proportional font (sum of glyph advances). The measure the message
    /// wrap and its regression test agree on.
    pub fn line_width(text: &str, px: f32) -> f32 {
        let font = font();
        let glyph_metrics = font.glyph_metrics(&[]).scale(px.max(1.0));
        let charmap = font.charmap();
        text.chars()
            .map(|ch| glyph_metrics.advance_width(charmap.map(ch)))
            .sum()
    }

    /// Greedily word-wrap `text` so that each returned line, when
    /// rasterised at `px` em size through the bundled PROPORTIONAL font,
    /// stays within `max_width` framebuffer pixels.
    ///
    /// This is the message-window body wrap: RealLive breaks message text
    /// at the `MOJI_CNT` character boundary, but that count assumes a
    /// fixed-width CJK cell. Our Latin font is proportional, so wrapping on
    /// WORD boundaries within the MOJI_CNT-derived pixel budget (see
    /// [`super::TextLayer::message_window`]) is the faithful approximation —
    /// the line breaks where the engine's line fills, and the text reads
    /// naturally rather than snapping mid-word. Whitespace runs are
    /// collapsed to single spaces (dialogue carries no significant runs). A
    /// single word wider than `max_width` is hard-broken by characters so
    /// the invariant "no glyph exceeds the box inner width" always holds.
    pub fn wrap_words(text: &str, px: f32, max_width: f32) -> Vec<String> {
        let font = font();
        let glyph_metrics = font.glyph_metrics(&[]).scale(px.max(1.0));
        let charmap = font.charmap();
        let advance = |ch: char| glyph_metrics.advance_width(charmap.map(ch));

        // Degenerate budget or empty text: a single line (unchanged text).
        if max_width <= 0.0 || text.trim().is_empty() {
            return vec![text.to_string()];
        }

        let mut lines: Vec<String> = Vec::new();
        let mut current = String::new();
        let mut current_w = 0.0f32;
        let space_w = line_width(" ", px);

        for word in text.split_whitespace() {
            let word_w = line_width(word, px);
            // Flush the current line if appending this word would overflow.
            if !current.is_empty() && current_w + space_w + word_w > max_width {
                lines.push(std::mem::take(&mut current));
                current_w = 0.0;
            }
            // A single word wider than a whole line: hard-break by chars.
            if word_w > max_width {
                if !current.is_empty() {
                    lines.push(std::mem::take(&mut current));
                }
                let mut piece = String::new();
                let mut piece_w = 0.0f32;
                for ch in word.chars() {
                    let cw = advance(ch);
                    if !piece.is_empty() && piece_w + cw > max_width {
                        lines.push(std::mem::take(&mut piece));
                        piece_w = 0.0;
                    }
                    piece.push(ch);
                    piece_w += cw;
                }
                current = piece;
                current_w = piece_w;
                continue;
            }
            if !current.is_empty() {
                current.push(' ');
                current_w += space_w;
            }
            current.push_str(word);
            current_w += word_w;
        }
        if !current.is_empty() {
            lines.push(current);
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    }
}

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

/// Why a graphics object contributed NO pixels during compositing.
///
/// Every variant corresponds to one fail-soft branch in
/// [`RenderPass::paint_image`]. The compositor keeps rendering the rest
/// of the stack, but the skip is recorded (never silently dropped) so a
/// consumer can tell an incomplete frame from a complete render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    /// No [`AssetPackage`] is bound, so the image ref cannot be
    /// dereferenced at all.
    NoAssetPackage,
    /// The asset package failed to resolve the logical `g00/<key>.g00`
    /// path to an asset id.
    ResolveFailed {
        /// The logical path that failed to resolve.
        logical: String,
        /// Display of the underlying resolve error.
        error: String,
    },
    /// The asset id resolved but the package failed to open its bytes.
    OpenFailed {
        /// The logical path whose bytes failed to open.
        logical: String,
        /// Display of the underlying open error.
        error: String,
    },
    /// [`decode_g00`] returned a hard error on the real bytes (e.g. the
    /// UTSUSHI-216 `BACK.g00` decoder bug). This is the branch that would
    /// otherwise silently drop the dominant scene background.
    DecodeFailed {
        /// Display of the g00 decode error.
        error: String,
    },
    /// The decoded image, or its scaled destination rect, had a zero
    /// dimension, so there was no extent to composite.
    ZeroDims {
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
    },
}

/// A single graphics object that was skipped (dropped, contributing no
/// pixels) during compositing, plus enough detail to be audit-traceable
/// back to the exact object and fail-soft branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedObject {
    /// The image object's asset key (g00 stem, e.g. `BACK`).
    pub asset_key: String,
    /// Plane the skipped object lived on.
    pub plane: GraphicsPlane,
    /// Slot within the plane.
    pub slot: usize,
    /// Why the object was skipped.
    pub reason: SkipReason,
}

/// A non-fatal [`G00Warning`] surfaced while decoding an object's g00
/// asset, tagged with the asset key it came from. These were previously
/// discarded (the `_warnings` binding); they are now carried up to the
/// render result so corpus-level audit can see them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectWarning {
    /// The image object's asset key (g00 stem) the warning came from.
    pub asset_key: String,
    /// The decode warning.
    pub warning: G00Warning,
}

/// Structural record of everything the compositor could NOT fully render
/// while rasterising a stack: the objects it skipped (with reasons) and
/// the non-fatal decode warnings it observed. An empty [`Self::is_empty`]
/// report means the frame is a COMPLETE render of the stack; a non-empty
/// skip list means at least one object was dropped and the frame is
/// incomplete. This is what keeps a render artifact from looking complete
/// when it is not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenderReport {
    /// Objects that contributed no pixels, with the reason for each.
    pub skipped_objects: Vec<SkippedObject>,
    /// Non-fatal g00 decode warnings observed, tagged by asset key.
    pub warnings: Vec<ObjectWarning>,
}

impl RenderReport {
    /// True when nothing was skipped and no decode warning fired — the
    /// frame is a complete render of the stack.
    pub fn is_empty(&self) -> bool {
        self.skipped_objects.is_empty() && self.warnings.is_empty()
    }

    /// True when at least one object was DROPPED (contributed no pixels),
    /// so the rendered frame is incomplete regardless of warnings.
    pub fn is_incomplete(&self) -> bool {
        !self.skipped_objects.is_empty()
    }
}

/// Outcome of [`RenderPass::emit_scene_screenshots`]: the public
/// (policy-selected) frame artifact plus the private full-fidelity PNG's
/// on-disk path and content hash.
#[derive(Debug, Clone)]
pub struct SceneScreenshots {
    /// The public frame announced through the substrate sink at E2.
    pub public: FrameArtifact,
    /// On-disk path of the uncommitted full-fidelity PNG (pixels
    /// byte-derived from the decoded g00). Hashable and re-readable.
    pub private_png_path: PathBuf,
    /// SHA-256 hex of the private PNG bytes.
    pub private_png_sha256: String,
    /// The redaction policy the PUBLIC frame was rendered under.
    pub redaction: RedactionPolicy,
    /// Objects that were DROPPED while compositing the full-fidelity
    /// buffer (empty for a complete render). A non-empty list means the
    /// emitted frame does NOT contain every object in the scene — e.g. an
    /// un-decodable `BACK.g00` background reports here as
    /// [`SkipReason::DecodeFailed`] instead of silently succeeding. See
    /// [`Self::is_incomplete`].
    pub skipped_objects: Vec<SkippedObject>,
    /// Non-fatal g00 decode warnings observed while compositing the
    /// full-fidelity buffer (previously discarded).
    pub decode_warnings: Vec<ObjectWarning>,
}

impl SceneScreenshots {
    /// True when at least one object was dropped during compositing, so
    /// the emitted frame is NOT a complete render of the scene. A
    /// consumer treats an incomplete frame as a non-final proof artifact.
    pub fn is_incomplete(&self) -> bool {
        !self.skipped_objects.is_empty()
    }
}

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
    /// Construct a render pass from a [`ScreenSize`] (e.g. the value
    /// parsed from Sweetie HD's `Gameexe.ini` `SCREENSIZE_MOD=999,1280,720`
    /// by [`crate::SyscallDispatcher::screen_size`]).
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
    /// layer). The render order is `(plane: Background first, then
    /// Foreground)`, then within each plane `(layer_order ascending, slot
    /// ascending)`.
    pub fn rasterise_with_policy(
        &self,
        stack: &GraphicsObjectStack,
        policy: RedactionPolicy,
    ) -> Framebuffer {
        self.rasterise_reporting(stack, policy).0
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
        let mut entries: Vec<(GraphicsPlane, i32, usize, &GraphicsObject)> = stack
            .iter_allocated()
            .map(|(plane, slot, object)| (plane, object.layer_order, slot, object))
            .collect();
        entries.sort_by_key(|(plane, layer, slot, _)| (plane.paint_order(), *layer, *slot));
        for (plane, _, slot, object) in entries {
            if !object.visible {
                continue;
            }
            self.paint_object(&mut framebuffer, object, plane, slot, policy, &mut report);
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
    /// [`RedactionPolicy::Redact`] policy, encode the deterministic PNG,
    /// persist it to `root` under a managed `screenshots/<artifact_id>.png`
    /// URI, and announce a [`FrameArtifact`] at [`EvidenceTier::E2`]
    /// through `sink`. This is the public, redacted single-frame emit: an
    /// image object contributes only a copyright-safe edge-outline (see
    /// [`redact_edge_map`]), so the emitted PNG publishes no source art.
    /// The full-fidelity path is [`Self::emit_scene_screenshots`].
    ///
    /// NON-VACUOUS LOCALIZATION PROOF: a non-empty `text` layer that
    /// paints ZERO framebuffer pixels (off-screen origin, all-whitespace,
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
    /// 1. The full-fidelity framebuffer (real decoded g00 composited,
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
            let py = object.position.y + dy as i32;
            if py < 0 || py >= framebuffer.height as i32 {
                continue;
            }
            // Nearest-neighbour source row.
            let sy = ((dy as u64 * src_h as u64) / dst_h as u64) as u32;
            for dx in 0..dst_w {
                let px = object.position.x + dx as i32;
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

/// Build a copyright-safe, non-reconstructable redaction of a decoded
/// g00 image: a monochrome EDGE-OUTLINE (the scene's structure/layout)
/// over a dark base, honouring each source pixel's alpha so the object's
/// SILHOUETTE is preserved while its colour, tone, and texture are
/// discarded. The output is a derived line-drawing — it shares no
/// verbatim run with the source pixel buffer — so a public frame built
/// from it shows the scene's LAYOUT for proof value without republishing
/// any decoded art. Replaces the old opaque solid-marker fill, which
/// painted a solid block over the whole image and showed nothing.
fn redact_edge_map(pixels_rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    // Dark base + light edge; both obviously-synthetic redaction colours.
    const BASE: [i32; 3] = [0x12, 0x10, 0x1A];
    const EDGE: [i32; 3] = [0x9A, 0xA6, 0xC0];
    const THRESHOLD: i32 = 22;
    let w = width as usize;
    let h = height as usize;
    // Rec.601-ish luminance, fixed-point (>>8).
    let luminance = |x: usize, y: usize| -> i32 {
        let idx = (y * w + x) * RGBA_BYTES_PER_PIXEL;
        let r = pixels_rgba[idx] as i32;
        let g = pixels_rgba[idx + 1] as i32;
        let b = pixels_rgba[idx + 2] as i32;
        (r * 54 + g * 183 + b * 19) >> 8
    };
    let mut out = vec![0u8; pixels_rgba.len()];
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) * RGBA_BYTES_PER_PIXEL;
            let alpha = pixels_rgba[idx + 3];
            let x_minus = x.saturating_sub(1);
            let x_plus = (x + 1).min(w - 1);
            let y_minus = y.saturating_sub(1);
            let y_plus = (y + 1).min(h - 1);
            let gradient = (luminance(x_plus, y) - luminance(x_minus, y)).abs()
                + (luminance(x, y_plus) - luminance(x, y_minus)).abs();
            let rgb = if gradient > THRESHOLD {
                // Brighten the edge with the gradient strength.
                let strength = (gradient - THRESHOLD).clamp(0, 255);
                let mix =
                    |base: i32, edge: i32| -> u8 { (base + (edge - base) * strength / 255) as u8 };
                [
                    mix(BASE[0], EDGE[0]),
                    mix(BASE[1], EDGE[1]),
                    mix(BASE[2], EDGE[2]),
                ]
            } else {
                [BASE[0] as u8, BASE[1] as u8, BASE[2] as u8]
            };
            out[idx] = rgb[0];
            out[idx + 1] = rgb[1];
            out[idx + 2] = rgb[2];
            out[idx + 3] = alpha;
        }
    }
    out
}

/// Scale `dimension` (pixels) by `thousandths` (`1000` = identity),
/// rounding to nearest. Negative or zero scale collapses the extent to
/// `0` (the object contributes no pixels); axis mirroring is out of
/// scope for the headless rasteriser.
fn scale_dimension(dimension: u32, thousandths: i32) -> u32 {
    if thousandths <= 0 {
        return 0;
    }
    (((dimension as u64) * (thousandths as u64) + 500) / 1000) as u32
}

/// Apply a signed-thousandths colour tone to a [`WipeColour`]'s RGB
/// channels (alpha is untouched).
fn apply_tone(colour: WipeColour, tone: GraphicsColourTone) -> WipeColour {
    let [r, g, b, a] = apply_tone_rgba([colour.red, colour.green, colour.blue, colour.alpha], tone);
    WipeColour {
        red: r,
        green: g,
        blue: b,
        alpha: a,
    }
}

/// Apply a signed-thousandths colour tone to an RGBA pixel:
/// `channel_out = clamp(channel + tone_thousandths * 255 / 1000)`. The
/// alpha channel is passed through untouched. A [`GraphicsColourTone::NEUTRAL`]
/// tone is the identity transform.
fn apply_tone_rgba(
    pixel: [u8; RGBA_BYTES_PER_PIXEL],
    tone: GraphicsColourTone,
) -> [u8; RGBA_BYTES_PER_PIXEL] {
    let shift = |channel: u8, thousandths: i32| -> u8 {
        if thousandths == 0 {
            return channel;
        }
        let delta = (thousandths * 255) / 1000;
        (channel as i32 + delta).clamp(0, 255) as u8
    };
    [
        shift(pixel[0], tone.red_thousandths),
        shift(pixel[1], tone.green_thousandths),
        shift(pixel[2], tone.blue_thousandths),
        pixel[3],
    ]
}

/// A concrete supported [`FrameArtifactSink`] that validates every
/// announced [`FrameArtifact`] against the substrate contract (E2
/// floor, managed-URI shape, artifact-kind allow-list) and collects the
/// accepted frames. Used by the render-validate CLI surface and the
/// redaction tests.
#[derive(Debug, Default)]
pub struct RecordingFrameArtifactSink {
    frames: std::sync::Mutex<Vec<FrameArtifact>>,
}

impl RecordingFrameArtifactSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// The accepted (validated, E2+) frames in announcement order.
    pub fn frames(&self) -> Vec<FrameArtifact> {
        self.frames.lock().expect("frame sink lock").clone()
    }

    pub fn len(&self) -> usize {
        self.frames.lock().expect("frame sink lock").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl FrameArtifactSink for RecordingFrameArtifactSink {
    fn capability(&self) -> utsushi_core::substrate::SinkCapability {
        utsushi_core::substrate::SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E2,
        }
    }

    fn emit_frame(&self, artifact: FrameArtifact) -> utsushi_core::substrate::SinkResult<()> {
        artifact.validate()?;
        self.frames.lock().expect("frame sink lock").push(artifact);
        Ok(())
    }
}

/// Deterministic SHA-256 hex digest. Sourced through the workspace
/// `sha2` crate (already a transitive dependency); pinned here as a
/// thin helper so the artifact-id derivation has a single home.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Encode `framebuffer` as a deterministic 8-bit RGBA PNG. See the
/// module docstring for the determinism contract.
pub fn encode_png_rgba_deterministic(framebuffer: &Framebuffer) -> Vec<u8> {
    let mut out = Vec::with_capacity(PNG_FILE_MAGIC.len() + framebuffer.pixels().len() + 256);
    out.extend_from_slice(&PNG_FILE_MAGIC);
    write_ihdr_chunk(&mut out, framebuffer.width(), framebuffer.height());
    write_idat_chunk(
        &mut out,
        framebuffer.width(),
        framebuffer.height(),
        framebuffer.pixels(),
    );
    write_iend_chunk(&mut out);
    out
}

fn write_chunk(out: &mut Vec<u8>, chunk_type: [u8; 4], payload: &[u8]) {
    let length = payload.len() as u32;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&chunk_type);
    out.extend_from_slice(payload);
    let mut crc_input = Vec::with_capacity(4 + payload.len());
    crc_input.extend_from_slice(&chunk_type);
    crc_input.extend_from_slice(payload);
    let crc = crc32_ieee(&crc_input);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn write_ihdr_chunk(out: &mut Vec<u8>, width: u32, height: u32) {
    let mut payload = Vec::with_capacity(13);
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    payload.push(PNG_BIT_DEPTH);
    payload.push(PNG_COLOUR_TYPE_RGBA);
    payload.push(0); // compression method 0 (deflate)
    payload.push(0); // filter method 0
    payload.push(0); // interlace method 0 (none)
    write_chunk(out, *b"IHDR", &payload);
}

fn write_idat_chunk(out: &mut Vec<u8>, width: u32, height: u32, pixels: &[u8]) {
    // Build the PNG scanline stream: one filter byte (0 = None) per row,
    // followed by the row's RGBA bytes.
    let row_stride = (width as usize) * RGBA_BYTES_PER_PIXEL;
    let mut scanlines = Vec::with_capacity((height as usize) * (1 + row_stride));
    for row in 0..(height as usize) {
        scanlines.push(PNG_FILTER_NONE);
        let row_start = row * row_stride;
        scanlines.extend_from_slice(&pixels[row_start..row_start + row_stride]);
    }
    let payload = wrap_as_zlib_stored(&scanlines);
    write_chunk(out, *b"IDAT", &payload);
}

fn write_iend_chunk(out: &mut Vec<u8>) {
    write_chunk(out, *b"IEND", &[]);
}

/// Wrap `data` as a zlib stream consisting of one-or-more uncompressed
/// deflate stored blocks (`BTYPE=00`). RFC 1951 caps a stored block at
/// `65_535` bytes; longer payloads are split into multiple blocks. The
/// final block sets the `BFINAL` bit. The zlib header is the
/// well-known `0x78 0x01` (deflate, no compression, no dictionary,
/// `FCHECK` chosen so `(CMF*256 + FLG) % 31 == 0`).
fn wrap_as_zlib_stored(data: &[u8]) -> Vec<u8> {
    // CMF: deflate, 32K window. FLG: FCHECK chosen so the RFC 1950
    // header-check invariant `(CMF*256 + FLG) % 31 == 0` holds.
    const ZLIB_CMF: u8 = 0x78;
    const ZLIB_FLG: u8 = 0x01;
    // Compile-time pin of the invariant; a future tweak to either
    // byte that breaks the header check fails to compile rather than
    // shipping a stream rejected by strict zlib decoders.
    const _: () = assert!(
        ((ZLIB_CMF as u16) * 256 + ZLIB_FLG as u16).is_multiple_of(31),
        "zlib header (CMF, FLG) pair must satisfy (CMF*256 + FLG) % 31 == 0",
    );
    const MAX_STORED_BLOCK_LEN: usize = 65_535;

    let mut out = Vec::with_capacity(data.len() + 16);
    out.push(ZLIB_CMF);
    out.push(ZLIB_FLG);

    if data.is_empty() {
        // Emit a single empty final stored block.
        out.push(0x01); // BFINAL=1, BTYPE=00
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(!0u16).to_le_bytes());
    } else {
        let mut offset = 0usize;
        while offset < data.len() {
            let remaining = data.len() - offset;
            let take = remaining.min(MAX_STORED_BLOCK_LEN);
            let is_final = offset + take == data.len();
            let header = u8::from(is_final);
            out.push(header);
            let len = take as u16;
            let nlen = !len;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&nlen.to_le_bytes());
            out.extend_from_slice(&data[offset..offset + take]);
            offset += take;
        }
    }

    let adler = adler32(data);
    out.extend_from_slice(&adler.to_be_bytes());
    out
}

/// Adler-32 checksum (RFC 1950 / zlib).
pub fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

/// CRC-32 (IEEE-802.3 polynomial, used by PNG and zlib).
pub fn crc32_ieee(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        let index = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = table[index] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphics_objects::{GraphicsObject, WipeColour};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn reallive_real_bytes_screen_size() -> ScreenSize {
        ScreenSize {
            mode: 999,
            width: 1280,
            height: 720,
        }
    }

    /// Unique managed artifact root under the process temp dir.
    fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "utsushi-render-pipeline-{tag}-{}-{nonce}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let root = RuntimeArtifactRoot::new(&dir);
        root.prepare().expect("prepare managed artifact root");
        root
    }

    fn wipe_stack(colour: WipeColour) -> GraphicsObjectStack {
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(GraphicsPlane::Foreground, 0, GraphicsObject::wipe(colour))
            .expect("set wipe");
        stack
    }

    #[test]
    fn adler32_known_vector() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E60398);
    }

    #[test]
    fn adler32_of_empty_is_one() {
        assert_eq!(adler32(&[]), 1);
    }

    #[test]
    fn crc32_known_vector_matches_png_spec() {
        assert_eq!(crc32_ieee(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn crc32_of_empty_is_zero() {
        assert_eq!(crc32_ieee(&[]), 0);
    }

    #[test]
    fn zlib_stored_round_trips_short_payload_through_known_header() {
        let wrapped = wrap_as_zlib_stored(b"hi");
        assert_eq!(wrapped[0], 0x78);
        assert_eq!(wrapped[1], 0x01);
        assert_eq!(wrapped[2], 0x01);
        assert_eq!(&wrapped[3..5], &2u16.to_le_bytes());
        assert_eq!(&wrapped[5..7], &(!2u16).to_le_bytes());
        assert_eq!(&wrapped[7..9], b"hi");
        assert_eq!(&wrapped[9..13], &adler32(b"hi").to_be_bytes());
    }

    #[test]
    fn zlib_stored_splits_at_64k_boundary() {
        let payload = vec![0xAAu8; 65_535 + 10];
        let wrapped = wrap_as_zlib_stored(&payload);
        let expected_len = 2 + 5 + 65_535 + 5 + 10 + 4;
        assert_eq!(wrapped.len(), expected_len);
        assert_eq!(wrapped[2], 0x00);
        let second_block_header = 2 + 5 + 65_535;
        assert_eq!(wrapped[second_block_header], 0x01);
    }

    #[test]
    fn render_pass_rejects_zero_screen_size() {
        let result = RenderPass::with_dimensions(0, 720);
        assert!(matches!(
            result,
            Err(RenderPassBuildError::ZeroScreenSize { width: 0, .. })
        ));
        let result = RenderPass::with_dimensions(1280, 0);
        assert!(matches!(
            result,
            Err(RenderPassBuildError::ZeroScreenSize { height: 0, .. })
        ));
    }

    #[test]
    fn render_pass_honours_reallive_real_bytes_screen_size() {
        let pass = RenderPass::new(reallive_real_bytes_screen_size()).expect("non-zero screen");
        assert_eq!(pass.width(), 1280);
        assert_eq!(pass.height(), 720);
    }

    #[test]
    fn deterministic_png_starts_with_magic_and_contains_expected_chunks() {
        let pass = RenderPass::with_dimensions(4, 2).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::opaque_rgb(0x12, 0x34, 0x56));
        let bytes = encode_png_rgba_deterministic(&pass.rasterise(&stack));
        assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
        assert_eq!(&bytes[8..12], &13u32.to_be_bytes());
        assert_eq!(&bytes[12..16], b"IHDR");
        let tail = &bytes[bytes.len() - 12..];
        assert_eq!(&tail[0..4], &0u32.to_be_bytes());
        assert_eq!(&tail[4..8], b"IEND");
    }

    #[test]
    fn wipe_smoke_fills_buffer_with_documented_colour_byte_order() {
        let pass = RenderPass::with_dimensions(2, 2).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::opaque_rgb(0xFF, 0x00, 0x00));
        let fb = pass.rasterise(&stack);
        let pixels = fb.pixels();
        assert_eq!(pixels.len(), 16);
        for chunk in pixels.chunks(4) {
            assert_eq!(chunk, &[0xFF, 0x00, 0x00, 0xFF]);
        }
    }

    #[test]
    fn emit_localized_screenshot_announces_e2_screenshot_through_substrate_sink() {
        let mut pass = RenderPass::with_dimensions(64, 32).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::opaque_rgb(0x10, 0x20, 0x30));
        let text = TextLayer::localized(vec!["HELLO".to_string()]);
        let root = temp_artifact_root("emit-e2");
        let sink = RecordingFrameArtifactSink::new();

        let artifact = pass
            .emit_localized_screenshot(&stack, &text, &root, "render-validate-test", &sink)
            .expect("emit localized screenshot");

        // Announced through the substrate sink at E2.
        assert_eq!(artifact.evidence_tier, EvidenceTier::E2);
        assert_eq!(
            artifact.artifact_ref.artifact_kind,
            SCREENSHOT_ARTIFACT_KIND
        );
        assert_eq!(sink.len(), 1);
        assert_eq!(sink.frames()[0], artifact);

        // The PNG is a real hashable file on disk whose bytes hash to
        // the announced artifact_id.
        let path = root
            .artifact_path(&artifact.artifact_ref.uri)
            .expect("artifact path");
        let bytes = std::fs::read(&path).expect("png on disk");
        assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
        assert_eq!(sha256_hex(&bytes), artifact.artifact_ref.artifact_id);

        let _ = std::fs::remove_dir_all(root.path());
    }

    #[test]
    fn emit_rejects_offscreen_origin_zero_text_screenshot() {
        // A non-empty localized layer whose origin is entirely
        // off-screen paints ZERO text pixels. The emit path MUST refuse
        // it rather than announce a vacuous E2 localization proof.
        let mut pass = RenderPass::with_dimensions(64, 32).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::opaque_rgb(0x10, 0x20, 0x30));
        let mut text = TextLayer::localized(vec!["HELLO".to_string()]);
        text.origin_x = 10_000;
        text.origin_y = 10_000;
        let root = temp_artifact_root("emit-offscreen-zero-text");
        let sink = RecordingFrameArtifactSink::new();

        // Pre-condition: this layer genuinely paints nothing.
        let (_, painted) = pass.rasterise_with_text(&stack, &text);
        assert_eq!(painted, 0, "off-screen origin must paint zero pixels");

        let result = pass.emit_localized_screenshot(&stack, &text, &root, "zero-text", &sink);
        assert!(matches!(
            result,
            Err(RenderEmitError::BlankLocalizedText { char_count: 5, .. })
        ));
        // No frame announced and the frame index did not advance, so no
        // vacuous screenshot leaked into the substrate.
        assert!(sink.is_empty());
        assert_eq!(pass.next_frame_index(), 0);
        let _ = std::fs::remove_dir_all(root.path());
    }

    #[test]
    fn emit_rejects_all_whitespace_zero_text_screenshot() {
        // An all-whitespace localized layer has chars but paints nothing
        // (space is the BLANK glyph); it must be rejected too.
        let mut pass = RenderPass::with_dimensions(128, 48).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);
        let text = TextLayer::localized(vec!["   ".to_string()]);
        let root = temp_artifact_root("emit-whitespace-zero-text");
        let sink = RecordingFrameArtifactSink::new();

        let (_, painted) = pass.rasterise_with_text(&stack, &text);
        assert_eq!(painted, 0, "all-whitespace must paint zero pixels");

        let result = pass.emit_localized_screenshot(&stack, &text, &root, "ws", &sink);
        assert!(matches!(
            result,
            Err(RenderEmitError::BlankLocalizedText { char_count: 3, .. })
        ));
        assert!(sink.is_empty());
        let _ = std::fs::remove_dir_all(root.path());
    }

    #[test]
    fn emit_accepts_real_text_that_paints_pixels() {
        // Control case: the same guard lets a real localized layer
        // through, so the rejection above is not a blanket refusal.
        let mut pass = RenderPass::with_dimensions(128, 48).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);
        let text = TextLayer::localized(vec!["HELLO".to_string()]);
        let root = temp_artifact_root("emit-real-text");
        let sink = RecordingFrameArtifactSink::new();
        pass.emit_localized_screenshot(&stack, &text, &root, "real", &sink)
            .expect("real localized text emits");
        assert_eq!(sink.len(), 1);
        let _ = std::fs::remove_dir_all(root.path());
    }

    fn kanon_like_config() -> MessageWindowConfig {
        // Kanon-shaped: top-left origin, bottom box, full width (POS.x=0),
        // narration only (NAME_MOD=0).
        MessageWindowConfig {
            origin: 0,
            pos_x: 0,
            pos_y: 345,
            attr_rgba: (100, 100, 160, 200),
            moji_size: 25,
            moji_pad: (19, 0, 53, 0),
            moji_cnt: Some((22, 3)),
            moji_rep: (-1, 3),
            ruby_size: 0,
            name_mod: 0,
            message_mod: 0,
            name_moji_size: 25,
            name_pos: (0, 0),
        }
    }

    #[test]
    fn message_window_renders_one_message_not_the_whole_scene() {
        // The message window carries exactly the ONE current message —
        // never a whole scene concatenated. This is the regression guard
        // for the "all messages in one box" defect: laying out three
        // messages must produce THREE single-line layers, not one
        // three-line box.
        let messages = ["First message.", "Second message.", "Third message."];
        let cfg = kanon_like_config();
        for text in messages {
            let layer = TextLayer::message_window(text, None, &cfg, (640, 480), (640, 480));
            assert_eq!(
                layer.lines,
                vec![text.to_string()],
                "each frame renders exactly one message"
            );
        }
        // A flatten-all layer (the OLD behaviour) is structurally distinct:
        // it would hold every message in one layer. Assert message_window
        // never does that.
        let one = TextLayer::message_window(messages[0], None, &cfg, (640, 480), (640, 480));
        assert_eq!(one.lines.len(), 1, "one message per frame, not flattened");
    }

    #[test]
    fn message_window_box_is_driven_by_gameexe_values() {
        // Kanon POS=0:0,345 in 640x480 → a bottom, full-width box: top at
        // y=345, spanning the full width. Change the config and the box
        // moves — proving it is config-driven, not hardcoded.
        let cfg = kanon_like_config();
        let layer = TextLayer::message_window("narration", None, &cfg, (640, 480), (640, 480));
        let backdrop = layer.backdrop.expect("message box has a backdrop");
        assert_eq!(backdrop.x, 0, "POS.x=0 → box hugs the left edge");
        assert_eq!(backdrop.y, 345, "POS.y=345 → box top at the configured y");
        assert_eq!(backdrop.width, 640, "POS.x=0 → full-width box");
        assert_eq!(backdrop.height, 480 - 345, "box extends to the bottom edge");
        // Colour + alpha come straight from ATTR.
        assert_eq!(
            (
                backdrop.colour.red,
                backdrop.colour.green,
                backdrop.colour.blue,
                backdrop.colour.alpha
            ),
            (100, 100, 160, 200)
        );
        // Font size is MOJI_SIZE (scale 1.0 here).
        assert_eq!(layer.scale, 25);

        // Same config scaled 2x horizontally / 1.5x vertically to a
        // 1280x720 frame moves the box proportionally.
        let scaled = TextLayer::message_window("narration", None, &cfg, (640, 480), (1280, 720));
        let scaled_box = scaled.backdrop.expect("backdrop");
        assert_eq!(scaled_box.width, 1280, "full width scales to the frame");
        assert_eq!(scaled_box.y, (345.0 * 1.5_f32).round() as u32);
    }

    #[test]
    fn message_window_moving_pos_moves_the_box() {
        // Independent proof the box is not hardcoded: a DIFFERENT POS
        // yields a DIFFERENT rect.
        let mut cfg = kanon_like_config();
        cfg.pos_x = 40;
        cfg.pos_y = 300;
        let layer = TextLayer::message_window("x", None, &cfg, (640, 480), (640, 480));
        let backdrop = layer.backdrop.expect("backdrop");
        assert_eq!(backdrop.x, 40);
        assert_eq!(backdrop.y, 300);
        assert_eq!(backdrop.width, 640 - 2 * 40, "symmetric horizontal inset");
    }

    #[test]
    fn message_window_wraps_long_message_at_moji_cnt_within_the_box() {
        // A Sweetie-shaped window: 1280x720, MOJI_SIZE=36, MOJI_CNT=22,3,
        // MOJI_REP=0,2, MOJI_POS=48,0,12,0, POS bottom-anchored inset 220.
        let cfg = MessageWindowConfig {
            origin: 2,
            pos_x: 220,
            pos_y: 0,
            attr_rgba: (10, 16, 24, 220),
            moji_size: 36,
            moji_pad: (48, 0, 12, 0),
            moji_cnt: Some((22, 3)),
            moji_rep: (0, 2),
            ruby_size: 0,
            name_mod: 1,
            message_mod: 0,
            name_moji_size: 25,
            name_pos: (18, 26),
        };
        let screen = (1280u32, 720u32);

        // A message far longer than one MOJI_CNT line.
        let long = "The rain kept falling long after the festival lanterns \
                    had gone dark, and neither of us wanted to be the first \
                    to say goodnight.";
        let layer = TextLayer::message_window(long, None, &cfg, screen, screen);

        // Non-vacuous #1: it actually wrapped to multiple lines.
        assert!(
            layer.lines.len() >= 2,
            "a long message must wrap to >=2 lines, got {:?}",
            layer.lines
        );

        // Non-vacuous #2: the WHOLE message on one line would overflow the
        // box inner width — so wrapping was genuinely required. Disabling
        // the wrap (a single-line layer) fails THIS assertion because the
        // one line's width exceeds the inner width.
        let backdrop = layer.backdrop.expect("message box backdrop");
        let (_, _, _pad_left, pad_right) = cfg.moji_pad;
        let inner_right = backdrop.x + backdrop.width - pad_right.max(0) as u32;
        let inner_width = (inner_right - layer.origin_x) as f32;
        assert!(
            font::line_width(long, layer.scale as f32) > inner_width,
            "the single-line message must be wider than the box (else the \
             wrap test is vacuous)"
        );

        // Every wrapped line stays within the box's right inset: no glyph
        // advances past the inner right edge.
        for line in &layer.lines {
            let w = font::line_width(line, layer.scale as f32);
            assert!(
                w <= inner_width,
                "wrapped line {line:?} width {w} exceeds box inner width {inner_width}"
            );
        }

        // A short message stays a single line (wrapping is body-only, not
        // an unconditional line split).
        let short = TextLayer::message_window("Yes.", None, &cfg, screen, screen);
        assert_eq!(short.lines, vec!["Yes.".to_string()]);
    }

    #[test]
    fn message_window_name_box_present_only_with_speaker_and_name_mod() {
        let mut cfg = kanon_like_config();
        cfg.name_mod = 1;
        cfg.name_moji_size = 25;
        cfg.name_pos = (18, 26);

        // Speaker + NAME_MOD=1 → a separate name box layer.
        let with_speaker =
            TextLayer::message_window("Hello.", Some("Yuuichi"), &cfg, (640, 480), (640, 480));
        let name_box = with_speaker
            .name_box
            .as_ref()
            .expect("NAME_MOD=1 + speaker → name box");
        assert_eq!(name_box.lines, vec!["Yuuichi".to_string()]);
        assert!(name_box.backdrop.is_some(), "name box has its own backdrop");

        // Narration (no speaker) → NO name box, even with NAME_MOD=1.
        let narration = TextLayer::message_window("Hello.", None, &cfg, (640, 480), (640, 480));
        assert!(
            narration.name_box.is_none(),
            "narration renders no name box"
        );

        // NAME_MOD=0 → NO name box, even with a speaker.
        cfg.name_mod = 0;
        let mod_off =
            TextLayer::message_window("Hello.", Some("Yuuichi"), &cfg, (640, 480), (640, 480));
        assert!(mod_off.name_box.is_none(), "NAME_MOD=0 renders no name box");
    }

    #[test]
    fn message_window_name_box_glyphs_paint() {
        // The name box actually draws: painting a message-window layer with
        // a name box paints MORE glyph pixels than the same message with no
        // speaker (the name glyphs are additive).
        let mut cfg = kanon_like_config();
        cfg.name_mod = 1;
        let pass = RenderPass::with_dimensions(640, 480).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);

        let narration =
            TextLayer::message_window("Hello there.", None, &cfg, (640, 480), (640, 480));
        let named =
            TextLayer::message_window("Hello there.", Some("Nayuki"), &cfg, (640, 480), (640, 480));
        let (_, narration_px) = pass.rasterise_with_text(&stack, &narration);
        let (_, named_px) = pass.rasterise_with_text(&stack, &named);
        assert!(narration_px > 0, "message glyphs paint");
        assert!(
            named_px > narration_px,
            "the name box adds glyph pixels ({named_px} vs {narration_px})"
        );
    }

    #[test]
    fn alpha_transparent_wipe_contributes_no_pixels() {
        // Object-level alpha IS applied by paint_object: a Wipe whose
        // object alpha is TRANSPARENT contributes NOTHING (it leaves the
        // destination unchanged), rather than fully filling.
        use crate::graphics_objects::GraphicsAlpha;
        let pass = RenderPass::with_dimensions(2, 2).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        // Opaque white background, then a transparent-alpha black wipe on
        // top: the transparent wipe must leave the white background intact.
        let mut background = GraphicsObject::wipe(WipeColour::WHITE);
        background.layer_order = 0;
        let mut transparent = GraphicsObject::wipe(WipeColour::opaque_rgb(0x11, 0x22, 0x33));
        transparent.layer_order = 1;
        transparent.alpha = GraphicsAlpha::TRANSPARENT;
        stack
            .set(GraphicsPlane::Foreground, 0, background)
            .expect("set background");
        stack
            .set(GraphicsPlane::Foreground, 1, transparent)
            .expect("set transparent");
        let fb = pass.rasterise(&stack);
        for chunk in fb.pixels().chunks(RGBA_BYTES_PER_PIXEL) {
            assert_eq!(
                chunk,
                &[0xFF, 0xFF, 0xFF, 0xFF],
                "a transparent-alpha wipe must contribute no pixels (object alpha IS applied)"
            );
        }
    }

    #[test]
    fn alpha_half_wipe_blends_toward_background() {
        // A half-alpha wipe blends halfway between its colour and the
        // background: proof object-level alpha reaches the compositor.
        use crate::graphics_objects::GraphicsAlpha;
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut background = GraphicsObject::wipe(WipeColour::BLACK);
        background.layer_order = 0;
        let mut half = GraphicsObject::wipe(WipeColour::WHITE);
        half.layer_order = 1;
        half.alpha = GraphicsAlpha(128);
        stack
            .set(GraphicsPlane::Foreground, 0, background)
            .expect("bg");
        stack.set(GraphicsPlane::Foreground, 1, half).expect("half");
        let fb = pass.rasterise(&stack);
        let pixel = &fb.pixels()[..4];
        // 255*128/255 rounded ~= 128 over black.
        assert!(
            (120..=136).contains(&(pixel[0] as u32)),
            "half-alpha white over black must be ~mid-grey, got {pixel:?}"
        );
        assert_eq!(pixel[0], pixel[1]);
        assert_eq!(pixel[1], pixel[2]);
    }

    #[test]
    fn two_emissions_with_same_state_produce_byte_identical_pngs() {
        let mut pass_a = RenderPass::with_dimensions(48, 24).expect("non-zero screen");
        let mut pass_b = RenderPass::with_dimensions(48, 24).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::WHITE);
        let text = TextLayer::localized(vec!["ABC".to_string()]);
        let root_a = temp_artifact_root("det-a");
        let root_b = temp_artifact_root("det-b");
        let sink_a = RecordingFrameArtifactSink::new();
        let sink_b = RecordingFrameArtifactSink::new();

        let a = pass_a
            .emit_localized_screenshot(&stack, &text, &root_a, "det", &sink_a)
            .expect("emit a");
        let b = pass_b
            .emit_localized_screenshot(&stack, &text, &root_b, "det", &sink_b)
            .expect("emit b");
        assert_eq!(a.artifact_ref.artifact_id, b.artifact_ref.artifact_id);
        let bytes_a = std::fs::read(root_a.artifact_path(&a.artifact_ref.uri).unwrap()).unwrap();
        let bytes_b = std::fs::read(root_b.artifact_path(&b.artifact_ref.uri).unwrap()).unwrap();
        assert_eq!(bytes_a, bytes_b);

        let _ = std::fs::remove_dir_all(root_a.path());
        let _ = std::fs::remove_dir_all(root_b.path());
    }

    #[test]
    fn frame_index_advances_per_emission() {
        // Framebuffer must be large enough for the default text origin
        // (16, 16) + scale-4 glyph to actually paint, otherwise the
        // non-vacuous-localization guard (correctly) rejects the emit.
        let mut pass = RenderPass::with_dimensions(64, 64).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);
        let text = TextLayer::localized(vec!["X".to_string()]);
        let root = temp_artifact_root("frame-index");
        let sink = RecordingFrameArtifactSink::new();
        let first = pass
            .emit_localized_screenshot(&stack, &text, &root, "fi", &sink)
            .expect("emit 0");
        assert_eq!(first.frame_index, 0);
        let second = pass
            .emit_localized_screenshot(&stack, &text, &root, "fi", &sink)
            .expect("emit 1");
        assert_eq!(second.frame_index, 1);
        let _ = std::fs::remove_dir_all(root.path());
    }

    #[test]
    fn draw_text_sets_pixels_for_ascii_and_differs_from_blank() {
        let pass = RenderPass::with_dimensions(128, 32).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);
        let text = TextLayer::localized(vec!["STELLA".to_string()]);
        let mut fb = pass.rasterise(&stack);
        let set = fb.draw_text(&text);
        assert!(set > 0, "ASCII text must set framebuffer pixels");

        // The same framebuffer without text is byte-different.
        let blank = pass.rasterise(&stack);
        assert_ne!(fb.pixels(), blank.pixels());
    }

    #[test]
    fn english_layer_differs_from_japanese_source_layer() {
        // Localized English renders as legible glyphs; the Japanese
        // source (outside DejaVu Sans' coverage) renders as `.notdef`
        // boxes — provably different pixels, so the screenshot reflects
        // the localized layer rather than the source.
        let pass = RenderPass::with_dimensions(320, 64).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);
        let english = TextLayer::localized(vec!["Stella-EN".to_string()]);
        let japanese = TextLayer::localized(vec!["ステラ".to_string()]);
        let mut fb_en = pass.rasterise(&stack);
        let mut fb_ja = pass.rasterise(&stack);
        fb_en.draw_text(&english);
        fb_ja.draw_text(&japanese);
        assert_ne!(
            fb_en.pixels(),
            fb_ja.pixels(),
            "English and Japanese text layers must produce different pixels"
        );
    }

    /// Render a single glyph on a black canvas and return (painted-pixel
    /// count, count of DISTINCT non-black RGBA values). Legible
    /// anti-aliased glyphs have MANY distinct edge shades; a flat solid
    /// tofu box has ~one.
    fn glyph_shape(character: char) -> (u64, usize) {
        let pass = RenderPass::with_dimensions(96, 96).expect("non-zero screen");
        let mut fb = pass.rasterise(&wipe_stack(WipeColour::BLACK));
        let mut layer = TextLayer::localized(vec![character.to_string()]);
        layer.origin_x = 8;
        layer.origin_y = 8;
        layer.scale = 64;
        let painted = fb.draw_text(&layer);
        let mut distinct: std::collections::BTreeSet<[u8; 4]> = std::collections::BTreeSet::new();
        for chunk in fb.pixels().chunks(RGBA_BYTES_PER_PIXEL) {
            if chunk != [0x00, 0x00, 0x00, 0xFF] {
                distinct.insert([chunk[0], chunk[1], chunk[2], chunk[3]]);
            }
        }
        (painted, distinct.len())
    }

    #[test]
    fn font_renders_legible_antialiased_glyphs_not_tofu() {
        // A real font produces PROPORTIONAL glyphs with ANTI-ALIASED
        // edges: a wide 'W' paints many more pixels than a narrow 'i', and
        // each glyph carries multiple distinct coverage shades (not one
        // flat block). A tofu/solid-box font would make these equal and
        // single-shade.
        let (w_painted, w_shades) = glyph_shape('W');
        let (i_painted, i_shades) = glyph_shape('i');
        assert!(
            w_painted > i_painted * 3 / 2,
            "proportional font: 'W' ({w_painted}px) must be much wider than 'i' ({i_painted}px)"
        );
        assert!(
            w_shades >= 4 && i_shades >= 4,
            "anti-aliased glyphs must carry multiple edge shades (not a flat tofu box): \
             W={w_shades} i={i_shades}"
        );
    }

    #[test]
    fn font_distinguishes_mixed_case() {
        // The old 3x5 bitmap folded lowercase to uppercase; the real font
        // must render 'a' and 'A' as genuinely different shapes.
        let pass = RenderPass::with_dimensions(64, 64).expect("non-zero screen");
        let mut lower = pass.rasterise(&wipe_stack(WipeColour::BLACK));
        let mut upper = pass.rasterise(&wipe_stack(WipeColour::BLACK));
        let mut la = TextLayer::localized(vec!["a".to_string()]);
        la.scale = 48;
        let mut ua = la.clone();
        ua.lines = vec!["A".to_string()];
        lower.draw_text(&la);
        upper.draw_text(&ua);
        assert_ne!(
            lower.pixels(),
            upper.pixels(),
            "lowercase 'a' and uppercase 'A' must render as distinct glyphs (mixed case)"
        );
    }

    #[test]
    fn redact_edge_map_shows_structure_and_is_not_solid() {
        // An image with a real vertical edge (left black | right white)
        // must redact to a structure-bearing edge-outline: MULTIPLE
        // distinct colours (base + edge), not a single solid fill.
        let (w, h) = (8u32, 4u32);
        let mut pixels = vec![0u8; (w * h) as usize * RGBA_BYTES_PER_PIXEL];
        for y in 0..h {
            for x in 0..w {
                let idx = ((y * w + x) as usize) * RGBA_BYTES_PER_PIXEL;
                let v = if x >= w / 2 { 0xFF } else { 0x00 };
                pixels[idx] = v;
                pixels[idx + 1] = v;
                pixels[idx + 2] = v;
                pixels[idx + 3] = 0xFF;
            }
        }
        let edges = redact_edge_map(&pixels, w, h);
        assert_eq!(edges.len(), pixels.len());
        let distinct: std::collections::BTreeSet<[u8; 4]> = edges
            .chunks(RGBA_BYTES_PER_PIXEL)
            .map(|c| [c[0], c[1], c[2], c[3]])
            .collect();
        assert!(
            distinct.len() >= 2,
            "edge-outline of a structured image must NOT be a single solid colour; \
             got {} distinct colours",
            distinct.len()
        );
        // Alpha is preserved (silhouette survives).
        assert!(edges.chunks(RGBA_BYTES_PER_PIXEL).all(|c| c[3] == 0xFF));
        // The edge-outline is NOT the source art.
        assert_ne!(edges, pixels, "redaction must transform, not copy, the art");
    }

    #[test]
    fn redact_edge_map_of_flat_image_is_solid_base() {
        // A featureless (edgeless) image has no structure to outline, so
        // it redacts to the solid dark base — confirming the edges in the
        // test above genuinely came from image structure.
        let (w, h) = (6u32, 6u32);
        let pixels = vec![0x40u8; (w * h) as usize * RGBA_BYTES_PER_PIXEL];
        let edges = redact_edge_map(&pixels, w, h);
        let distinct: std::collections::BTreeSet<[u8; 3]> = edges
            .chunks(RGBA_BYTES_PER_PIXEL)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        assert_eq!(
            distinct.len(),
            1,
            "a flat image has no edges, so it redacts to a single base colour"
        );
    }

    #[test]
    fn layer_order_paints_higher_value_last_within_a_plane() {
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut lower = GraphicsObject::wipe(WipeColour::BLACK);
        lower.layer_order = 0;
        let mut higher = GraphicsObject::wipe(WipeColour::WHITE);
        higher.layer_order = 1;
        stack
            .set(GraphicsPlane::Foreground, 0, lower)
            .expect("set lower");
        stack
            .set(GraphicsPlane::Foreground, 1, higher)
            .expect("set higher");
        let fb = pass.rasterise(&stack);
        assert_eq!(fb.pixels(), &[0xFF, 0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn foreground_plane_paints_after_background_regardless_of_layer_order() {
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut bg = GraphicsObject::wipe(WipeColour::WHITE);
        bg.layer_order = 999;
        let mut fg = GraphicsObject::wipe(WipeColour::BLACK);
        fg.layer_order = 0;
        stack.set(GraphicsPlane::Background, 0, bg).expect("set bg");
        stack.set(GraphicsPlane::Foreground, 0, fg).expect("set fg");
        let fb = pass.rasterise(&stack);
        assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
    }

    #[test]
    fn invisible_objects_are_skipped() {
        let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        let mut hidden = GraphicsObject::wipe(WipeColour::WHITE);
        hidden.visible = false;
        stack
            .set(GraphicsPlane::Foreground, 0, hidden)
            .expect("set hidden");
        let fb = pass.rasterise(&stack);
        assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn image_object_without_asset_package_contributes_nothing() {
        // With no AssetPackage bound there is nothing to dereference, so
        // an Image-only stack rasterises to the initial transparent
        // pattern under EITHER policy (the g00 binding is what produces
        // pixels — see the real-bytes suite for the composited case).
        let pass = RenderPass::with_dimensions(4, 4).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(
                GraphicsPlane::Background,
                0,
                GraphicsObject::image("SYNTH_BG"),
            )
            .expect("set image");
        assert!(!pass.has_assets());
        for policy in [RedactionPolicy::Full, RedactionPolicy::Redact] {
            let fb = pass.rasterise_with_policy(&stack, policy);
            assert!(
                fb.pixels().iter().all(|&byte| byte == 0),
                "an image object with no asset package contributes zero pixels ({policy:?})"
            );
        }
    }

    #[test]
    fn public_toggle_maps_redact_flag() {
        assert_eq!(
            RedactionPolicy::public_toggle(true),
            RedactionPolicy::Redact
        );
        assert_eq!(RedactionPolicy::public_toggle(false), RedactionPolicy::Full);
    }

    #[test]
    fn apply_tone_neutral_is_identity_and_positive_lightens() {
        let base = [0x40u8, 0x40, 0x40, 0xFF];
        assert_eq!(
            apply_tone_rgba(base, GraphicsColourTone::NEUTRAL),
            base,
            "neutral tone is identity"
        );
        let lightened = apply_tone_rgba(
            base,
            GraphicsColourTone {
                red_thousandths: 1000,
                green_thousandths: 0,
                blue_thousandths: 0,
            },
        );
        assert_eq!(lightened[0], 0xFF, "+1000 red drives channel to white");
        assert_eq!(lightened[1], 0x40, "other channels untouched");
        assert_eq!(lightened[3], 0xFF, "alpha untouched by tone");
    }

    #[test]
    fn scale_dimension_rounds_and_floors_nonpositive() {
        assert_eq!(scale_dimension(100, 1000), 100, "identity");
        assert_eq!(scale_dimension(100, 500), 50, "half");
        assert_eq!(scale_dimension(100, 2000), 200, "double");
        assert_eq!(scale_dimension(100, 0), 0, "zero scale => no extent");
        assert_eq!(scale_dimension(100, -500), 0, "negative scale => no extent");
    }
}
