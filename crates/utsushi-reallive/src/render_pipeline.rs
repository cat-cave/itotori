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
//! # Copyright redaction is structural (ALPHA-006b PROJECT LAW)
//!
//! The render pass NEVER dereferences a copyrighted g00 bitmap into the
//! framebuffer. [`GraphicsObjectKind::Image`] objects are recorded but
//! produce zero pixels (see [`RenderPass::paint_object`]); only our own
//! synthetic [`GraphicsObjectKind::Wipe`] fills and the localized
//! [`TextLayer`] (our translated text, rendered through the in-crate
//! bitmap font) are painted. The emitted PNG therefore provably embeds
//! NONE of any source g00 byte content — there is no code path from a
//! decoded `G00Image` to the framebuffer.
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

use sha2::{Digest, Sha256};

use crate::graphics_objects::{
    GraphicsObject, GraphicsObjectKind, GraphicsObjectStack, GraphicsPlane, WipeColour,
};
use crate::syscall::ScreenSize;
use utsushi_core::substrate::{
    EvidenceTier, FrameArtifact, FrameArtifactSink, ObservationArtifactRef, SinkError,
};
use utsushi_core::{RuntimeArtifactKind, RuntimeArtifactRoot, runtime_artifact_uri};

/// Stable diagnostic code emitted by [`RenderPass::new`] when the
/// caller supplies a [`ScreenSize`] with `width == 0` or `height == 0`.
pub const RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE: &str =
    "utsushi.reallive.render_pipeline.zero_screen_size";

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
}

/// The headless render pipeline. Owns a per-pass `frame_index`
/// counter and the framebuffer dimensions. The encoded PNG bytes are
/// persisted on disk through the caller's [`RuntimeArtifactRoot`]; the
/// pass itself retains no bytes.
#[derive(Debug)]
pub struct RenderPass {
    width: u32,
    height: u32,
    frame_index: u64,
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
        })
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

    /// Rasterise `stack` into a fresh framebuffer (no text layer).
    /// The render order is `(plane: Background first, then Foreground)`,
    /// then within each plane `(layer_order ascending, slot ascending)`.
    pub fn rasterise(&self, stack: &GraphicsObjectStack) -> Framebuffer {
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
            self.paint_object(&mut framebuffer, object);
        }
        framebuffer
    }

    /// Rasterise `stack`, then paint the localized `text` layer on top.
    /// This is the frame the screenshot emission encodes.
    pub fn rasterise_with_text(
        &self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
    ) -> Framebuffer {
        let mut framebuffer = self.rasterise(stack);
        framebuffer.draw_text(text);
        framebuffer
    }

    /// Rasterise `stack` + the localized `text` layer, encode the
    /// deterministic PNG, persist it to `root` under a managed
    /// `screenshots/<artifact_id>.png` URI, and announce a
    /// [`FrameArtifact`] at [`EvidenceTier::E2`] through `sink`.
    ///
    /// COPYRIGHT REDACTION: this path NEVER dereferences a g00 bitmap.
    /// Only the synthetic [`GraphicsObjectKind::Wipe`] fills and the
    /// localized `text` layer reach the framebuffer; the emitted PNG
    /// embeds zero source-asset bytes.
    pub fn emit_localized_screenshot(
        &mut self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        root: &RuntimeArtifactRoot,
        run_id: &str,
        sink: &dyn FrameArtifactSink,
    ) -> Result<FrameArtifact, RenderEmitError> {
        let framebuffer = self.rasterise_with_text(stack, text);
        let png_bytes = encode_png_rgba_deterministic(&framebuffer);
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

    fn paint_object(&self, framebuffer: &mut Framebuffer, object: &GraphicsObject) {
        match &object.kind {
            GraphicsObjectKind::Wipe { colour } => {
                framebuffer.fill(*colour);
            }
            GraphicsObjectKind::Image { .. } => {
                // COPYRIGHT REDACTION (ALPHA-006b PROJECT LAW): the
                // image_ref is recorded on the object but its g00
                // bitmap is NEVER decoded into the framebuffer. There
                // is no `decode_g00` call reachable from here, so no
                // source-asset byte can leak into the emitted PNG.
            }
        }
    }
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
        let mut pass = RenderPass::with_dimensions(16, 16).expect("non-zero screen");
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
    fn image_object_paints_no_pixels_redaction() {
        // GraphicsObjectKind::Image must NOT be dereferenced into the
        // framebuffer: an Image-only stack rasterises to the initial
        // transparent pattern.
        let pass = RenderPass::with_dimensions(4, 4).expect("non-zero screen");
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(
                GraphicsPlane::Background,
                0,
                GraphicsObject::image("SYNTH_BG"),
            )
            .expect("set image");
        let fb = pass.rasterise(&stack);
        assert!(
            fb.pixels().iter().all(|&byte| byte == 0),
            "Image objects must paint zero pixels (copyright redaction)"
        );
    }
}
