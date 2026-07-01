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
//! ([`RedactionPolicy::Full`]) or a synthetic redaction marker in place
//! of every image object's rect ([`RedactionPolicy::Redact`], the
//! default). [`RenderPass::emit_scene_screenshots`] writes the
//! full-fidelity buffer to a PRIVATE, uncommitted path (hashable, never
//! committed) and announces the public (policy-selected) buffer through
//! the substrate frame sink — so a committed/CI proof publishes no
//! copyrighted art while a locally-authorized run can toggle redaction
//! off.
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

use crate::g00::decode_g00;
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

/// Opaque synthetic marker painted over an image object's rect when the
/// render pass runs under [`RedactionPolicy::Redact`]. It is a fixed,
/// obviously-synthetic value that shares NONE of the decoded g00 byte
/// content, so a redacted public frame provably embeds no source art
/// while still marking WHERE the (redacted) art would sit.
pub const REDACTION_MARKER: WipeColour = WipeColour {
    red: 0x7F,
    green: 0x00,
    blue: 0x7F,
    alpha: 0xFF,
};

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
    /// Replace every image object's rect with [`REDACTION_MARKER`] so the
    /// emitted frame publishes no copyrighted art. The default for
    /// committed / CI proof.
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

    /// Set a single pixel to `colour` (RGBA order). Out-of-bounds
    /// coordinates are clipped (no-op).
    fn set_pixel(&mut self, x: u32, y: u32, colour: WipeColour) {
        if x >= self.width || y >= self.height {
            return;
        }
        let offset = ((y as usize) * (self.width as usize) + (x as usize)) * RGBA_BYTES_PER_PIXEL;
        self.pixels[offset] = colour.red;
        self.pixels[offset + 1] = colour.green;
        self.pixels[offset + 2] = colour.blue;
        self.pixels[offset + 3] = colour.alpha;
    }

    /// Source-over composite one RGBA `src` pixel at `(x, y)`, modulating
    /// the source alpha by `object_alpha` (`0..=255`). The effective
    /// source coverage is `src.a * object_alpha / 255`; the result is the
    /// standard non-premultiplied source-over of `src` onto the current
    /// destination pixel. `object_alpha == 255` with an opaque `src`
    /// (`src[3] == 255`) writes `src` verbatim, so the opaque path is
    /// byte-identical to [`Self::set_pixel`]. Out-of-bounds coordinates
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

    /// Paint a [`TextLayer`] over the framebuffer using the in-crate
    /// [`font`] bitmap. Each glyph cell is `font::GLYPH_WIDTH ×
    /// font::GLYPH_HEIGHT` font-pixels, scaled up by `layer.scale`, with
    /// a one-font-pixel inter-glyph gap and a two-font-pixel inter-line
    /// gap. Returns the number of set framebuffer pixels (so callers can
    /// assert the layer actually drew something — a blank layer is a
    /// regression).
    pub fn draw_text(&mut self, layer: &TextLayer) -> u64 {
        let scale = layer.scale.max(1);
        let colour = layer.colour;
        let advance_x = (font::GLYPH_WIDTH as u32 + 1) * scale;
        let advance_y = (font::GLYPH_HEIGHT as u32 + 2) * scale;
        let mut set_pixels: u64 = 0;
        for (line_index, line) in layer.lines.iter().enumerate() {
            let line_top = layer.origin_y + (line_index as u32) * advance_y;
            if line_top >= self.height {
                break;
            }
            for (char_index, character) in line.chars().enumerate() {
                let glyph = font::glyph(character);
                let cell_left = layer.origin_x + (char_index as u32) * advance_x;
                if cell_left >= self.width {
                    break;
                }
                for (row, row_bits) in glyph.iter().enumerate() {
                    for col in 0..font::GLYPH_WIDTH {
                        let mask = 1u8 << (font::GLYPH_WIDTH - 1 - col);
                        if row_bits & mask == 0 {
                            continue;
                        }
                        let block_x = cell_left + (col as u32) * scale;
                        let block_y = line_top + (row as u32) * scale;
                        for dy in 0..scale {
                            for dx in 0..scale {
                                let px = block_x + dx;
                                let py = block_y + dy;
                                if px < self.width && py < self.height {
                                    self.set_pixel(px, py, colour);
                                    set_pixels += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        set_pixels
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
    /// Integer upscale factor for each font pixel (`>= 1`).
    pub scale: u32,
    /// Glyph colour (RGBA).
    pub colour: WipeColour,
}

impl TextLayer {
    /// Construct a text layer with the documented default placement
    /// (origin `(16, 16)`, scale `4`, opaque white glyphs).
    pub fn localized(lines: Vec<String>) -> Self {
        Self {
            lines,
            origin_x: 16,
            origin_y: 16,
            scale: 4,
            colour: WipeColour::WHITE,
        }
    }

    /// Total number of characters across all lines.
    pub fn char_count(&self) -> usize {
        self.lines.iter().map(|line| line.chars().count()).sum()
    }
}

/// A compact deterministic 3×5 ASCII bitmap font. Uppercase letters,
/// digits, and common punctuation render as legible glyphs; lowercase
/// maps to uppercase; every other code point (including the non-ASCII
/// Shift-JIS bytes of the untranslated source) renders as a solid
/// "tofu" box, so a localized (English/ASCII) text layer is provably
/// distinct from the Japanese source layer at the pixel level.
mod font {
    /// Glyph cell width in font-pixels.
    pub const GLYPH_WIDTH: usize = 3;
    /// Glyph cell height in font-pixels.
    pub const GLYPH_HEIGHT: usize = 5;

    /// Solid box drawn for any code point with no authored glyph.
    const TOFU: [u8; GLYPH_HEIGHT] = [0b111, 0b111, 0b111, 0b111, 0b111];
    const BLANK: [u8; GLYPH_HEIGHT] = [0, 0, 0, 0, 0];

    /// Return the 5-row bitmap for `character`. Each row's low
    /// [`GLYPH_WIDTH`] bits are columns left→right (MSB of the field is
    /// the left column).
    pub fn glyph(character: char) -> [u8; GLYPH_HEIGHT] {
        let upper = character.to_ascii_uppercase();
        match upper {
            ' ' => BLANK,
            'A' => [0b111, 0b101, 0b111, 0b101, 0b101],
            'B' => [0b110, 0b101, 0b110, 0b101, 0b110],
            'C' => [0b111, 0b100, 0b100, 0b100, 0b111],
            'D' => [0b110, 0b101, 0b101, 0b101, 0b110],
            'E' => [0b111, 0b100, 0b110, 0b100, 0b111],
            'F' => [0b111, 0b100, 0b110, 0b100, 0b100],
            'G' => [0b111, 0b100, 0b101, 0b101, 0b111],
            'H' => [0b101, 0b101, 0b111, 0b101, 0b101],
            'I' => [0b111, 0b010, 0b010, 0b010, 0b111],
            'J' => [0b001, 0b001, 0b001, 0b101, 0b111],
            'K' => [0b101, 0b101, 0b110, 0b101, 0b101],
            'L' => [0b100, 0b100, 0b100, 0b100, 0b111],
            'M' => [0b101, 0b111, 0b111, 0b101, 0b101],
            'N' => [0b101, 0b111, 0b111, 0b111, 0b101],
            'O' => [0b111, 0b101, 0b101, 0b101, 0b111],
            'P' => [0b111, 0b101, 0b111, 0b100, 0b100],
            'Q' => [0b111, 0b101, 0b101, 0b111, 0b001],
            'R' => [0b111, 0b101, 0b110, 0b101, 0b101],
            'S' => [0b111, 0b100, 0b111, 0b001, 0b111],
            'T' => [0b111, 0b010, 0b010, 0b010, 0b010],
            'U' => [0b101, 0b101, 0b101, 0b101, 0b111],
            'V' => [0b101, 0b101, 0b101, 0b101, 0b010],
            'W' => [0b101, 0b101, 0b111, 0b111, 0b101],
            'X' => [0b101, 0b101, 0b010, 0b101, 0b101],
            'Y' => [0b101, 0b101, 0b010, 0b010, 0b010],
            'Z' => [0b111, 0b001, 0b010, 0b100, 0b111],
            '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
            '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
            '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
            '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
            '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
            '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
            '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
            '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
            '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
            '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
            '-' => [0, 0, 0b111, 0, 0],
            '.' => [0, 0, 0, 0, 0b010],
            ',' => [0, 0, 0, 0b010, 0b100],
            '!' => [0b010, 0b010, 0b010, 0, 0b010],
            '?' => [0b111, 0b001, 0b010, 0, 0b010],
            ':' => [0, 0b010, 0, 0b010, 0],
            ';' => [0, 0b010, 0, 0b010, 0b100],
            '\'' => [0b010, 0b010, 0, 0, 0],
            '"' => [0b101, 0b101, 0, 0, 0],
            '/' => [0b001, 0b001, 0b010, 0b100, 0b100],
            '(' => [0b001, 0b010, 0b010, 0b010, 0b001],
            ')' => [0b100, 0b010, 0b010, 0b010, 0b100],
            // Any other code point — including every non-ASCII
            // Shift-JIS byte of the untranslated Japanese source —
            // renders as a solid box.
            _ => TOFU,
        }
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
    /// are replaced by [`REDACTION_MARKER`]; use
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
        let mut framebuffer = Framebuffer::new(self.width, self.height);
        let mut entries: Vec<(GraphicsPlane, i32, usize, &GraphicsObject)> = stack
            .iter_allocated()
            .map(|(plane, slot, object)| (plane, object.layer_order, slot, object))
            .collect();
        entries.sort_by_key(|(plane, layer, slot, _)| (plane.paint_order(), *layer, *slot));
        for (_, _, _, object) in entries {
            if !object.visible {
                continue;
            }
            self.paint_object(&mut framebuffer, object, policy);
        }
        framebuffer
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
    /// image object contributes only [`REDACTION_MARKER`] pixels, so the
    /// emitted PNG publishes no source art. The full-fidelity path is
    /// [`Self::emit_scene_screenshots`].
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
        self.reject_blank_localized(text, text_pixels)?;
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
    ///    `public_redact == true` (the default) image rects carry only
    ///    [`REDACTION_MARKER`]; with `false` the public buffer equals the
    ///    full-fidelity buffer. It is announced through `emit.sink` at E2.
    ///
    /// Redaction is thus a policy at THIS emit boundary — the render path
    /// itself always produces the full-fidelity buffer.
    pub fn emit_scene_screenshots(
        &mut self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        emit: SceneEmit<'_>,
    ) -> Result<SceneScreenshots, RenderEmitError> {
        // Full-fidelity private buffer (always real g00 art).
        let (full_fb, full_text_pixels) =
            self.rasterise_with_text_policy(stack, text, RedactionPolicy::Full);
        self.reject_blank_localized(text, full_text_pixels)?;

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
        })
    }

    /// Reject a non-empty localized text layer that painted zero pixels.
    fn reject_blank_localized(
        &self,
        text: &TextLayer,
        text_pixels: u64,
    ) -> Result<(), RenderEmitError> {
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
        policy: RedactionPolicy,
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
                self.paint_image(framebuffer, object, &image_ref.asset_key, policy);
            }
        }
    }

    /// Dereference an image object's `asset_key` through the bound asset
    /// package, decode the g00 bytes, and composite the decoded bitmap
    /// into `framebuffer` at the object's position, applying its scale
    /// (nearest-neighbour resample), colour tone, and alpha. Under
    /// [`RedactionPolicy::Redact`] the same destination rect is filled
    /// with [`REDACTION_MARKER`] instead of the decoded pixels, so the
    /// emitted frame publishes no source art. If no asset package is
    /// bound, or resolution / decoding fails, the object contributes no
    /// pixels (a fail-soft gap, never a panic).
    fn paint_image(
        &self,
        framebuffer: &mut Framebuffer,
        object: &GraphicsObject,
        asset_key: &str,
        policy: RedactionPolicy,
    ) {
        let Some(assets) = self.assets.as_ref() else {
            return;
        };
        let logical = format!("g00/{asset_key}.g00");
        let Ok(asset_id) = assets.resolve(&logical) else {
            return;
        };
        let Ok(bytes) = assets.open(&asset_id) else {
            return;
        };
        // LIVE decode of the real g00 bytes into an RGBA canvas. The
        // decoder's non-fatal warnings (short-payload zero-extension) are
        // tolerated; a hard decode error yields no pixels.
        let Ok((image, _warnings)) = decode_g00(bytes.as_slice()) else {
            return;
        };
        let src_w = image.width;
        let src_h = image.height;
        if src_w == 0 || src_h == 0 {
            return;
        }
        let dst_w = scale_dimension(src_w, object.scale.x_thousandths);
        let dst_h = scale_dimension(src_h, object.scale.y_thousandths);
        if dst_w == 0 || dst_h == 0 {
            return;
        }
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
                match policy {
                    RedactionPolicy::Redact => {
                        // Redaction: emit only the synthetic marker. No
                        // decoded g00 byte is read into the framebuffer.
                        let marker = [
                            REDACTION_MARKER.red,
                            REDACTION_MARKER.green,
                            REDACTION_MARKER.blue,
                            REDACTION_MARKER.alpha,
                        ];
                        framebuffer.blend_pixel(px as u32, py as u32, marker, object.alpha.0);
                    }
                    RedactionPolicy::Full => {
                        let sx = ((dx as u64 * src_w as u64) / dst_w as u64) as u32;
                        let sidx =
                            (sy as usize) * src_stride + (sx as usize) * RGBA_BYTES_PER_PIXEL;
                        let src = apply_tone_rgba(
                            [
                                image.pixels_rgba[sidx],
                                image.pixels_rgba[sidx + 1],
                                image.pixels_rgba[sidx + 2],
                                image.pixels_rgba[sidx + 3],
                            ],
                            object.colour_tone,
                        );
                        framebuffer.blend_pixel(px as u32, py as u32, src, object.alpha.0);
                    }
                }
            }
        }
    }
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
    let mut out = Vec::with_capacity(data.len() + 16);
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
    out.push(ZLIB_CMF);
    out.push(ZLIB_FLG);

    const MAX_STORED_BLOCK_LEN: usize = 65_535;
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
            let header = if is_final { 0x01u8 } else { 0x00u8 };
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
        // source (non-ASCII) renders as solid tofu boxes — provably
        // different pixels, so the screenshot reflects the localized
        // layer rather than the source.
        let pass = RenderPass::with_dimensions(160, 32).expect("non-zero screen");
        let stack = wipe_stack(WipeColour::BLACK);
        let english = TextLayer::localized(vec!["STELLA-EN".to_string()]);
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
