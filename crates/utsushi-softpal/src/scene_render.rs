//! Copyright-safe **layout-probe** frame render + deterministic PNG emission.
//!
//! Softpal ships no background-CG decode in this runtime's scope, so the
//! rendered frame is not a photographic composite — it is a **layout probe**:
//! the message-box geometry, an optional name box, and per-wrapped-line text
//! *extent* bars sized to the decoded dialogue. The default export edge-redacts
//! that geometry to a structure-only outline: layout stays inspectable while no
//! glyph pixels leave the process. The decoded dialogue text (emitted through
//! the substrate text sink at `E1`) is the localization proof; the frame proves
//! only *where* it would be laid out.

use thiserror::Error;

/// Frame canvas width, in pixels.
pub const FRAME_WIDTH: u32 = 800;
/// Frame canvas height, in pixels.
pub const FRAME_HEIGHT: u32 = 600;

/// Characters per wrapped dialogue line (drives extent-bar count/width).
const CHARS_PER_LINE: usize = 46;
/// Maximum wrapped lines drawn into the message box.
const MAX_LINES: usize = 4;
/// Left edge of the text-extent bars, in pixels.
const BAR_LEFT: usize = 60;
/// Right bound of a full-width text-extent bar, in pixels.
const BAR_MAX_RIGHT: usize = 740;

/// Public artifact policy for a rendered Softpal layout frame.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SoftpalRedaction {
    /// Emit only the structure edge-outline of the layout. The safe default.
    #[default]
    EdgeOutline,
    /// Keep the filled layout in memory for a locally authorized caller. The
    /// production port never persists this mode by default.
    Full,
}

/// Rasterized RGBA layout frame ready for deterministic PNG encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoftpalFrame {
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Row-major RGBA8 pixels.
    pub pixels_rgba: Vec<u8>,
}

/// Render or PNG-encode failure.
#[derive(Debug, Error)]
pub enum SoftpalRenderError {
    /// PNG's 32-bit dimension field cannot carry the requested size.
    #[error("utsushi.softpal.render.png_dimension_overflow")]
    PngDimensionOverflow,
    /// The frame dimensions and buffer length disagreed.
    #[error("utsushi.softpal.render.invalid_canvas")]
    InvalidCanvas,
}

/// Render a message-box layout probe for one dialogue line. `speaker` present
/// draws a name box; the text is wrapped and drawn as extent bars, never glyphs.
#[must_use]
pub fn render_dialogue_frame(
    speaker: Option<&str>,
    text: &str,
    policy: SoftpalRedaction,
) -> SoftpalFrame {
    let width = FRAME_WIDTH as usize;
    let height = FRAME_HEIGHT as usize;
    let mut canvas = vec![0u8; width * height * 4];

    // Dialogue message box across the lower third.
    fill_rect(&mut canvas, width, 40, 430, 760, 570, [40, 44, 60, 255]);
    // Name box above the message box when a speaker is present.
    if speaker.is_some_and(|name| !name.trim().is_empty()) {
        fill_rect(&mut canvas, width, 40, 396, 240, 426, [60, 50, 74, 255]);
    }

    // One extent bar per wrapped line, width proportional to that line's length.
    let char_count = text.chars().count();
    for (line_index, chunk_len) in wrapped_line_lengths(char_count, CHARS_PER_LINE, MAX_LINES)
        .into_iter()
        .enumerate()
    {
        let top = 452 + line_index * 28;
        let span = (chunk_len * (BAR_MAX_RIGHT - BAR_LEFT)) / CHARS_PER_LINE.max(1);
        let right = (BAR_LEFT + span).min(BAR_MAX_RIGHT);
        fill_rect(
            &mut canvas,
            width,
            BAR_LEFT,
            top,
            right,
            top + 16,
            [205, 208, 220, 255],
        );
    }

    if policy == SoftpalRedaction::EdgeOutline {
        canvas = redact_edge_outline(&canvas, width, height);
    }
    SoftpalFrame {
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        pixels_rgba: canvas,
    }
}

/// The per-wrapped-line character lengths for `char_count` characters wrapped at
/// `chars_per_line`, capped at `max_lines` (a long line's overflow is clamped
/// into the last bar so the layout stays bounded).
fn wrapped_line_lengths(char_count: usize, chars_per_line: usize, max_lines: usize) -> Vec<usize> {
    if char_count == 0 {
        return Vec::new();
    }
    let mut remaining = char_count;
    let mut lengths = Vec::new();
    while remaining > 0 && lengths.len() < max_lines {
        let take = remaining.min(chars_per_line);
        lengths.push(take);
        remaining -= take;
    }
    lengths
}

fn fill_rect(
    canvas: &mut [u8],
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    rgba: [u8; 4],
) {
    let height = canvas.len() / (width * 4);
    for y in y0..y1.min(height) {
        for x in x0..x1.min(width) {
            let index = (y * width + x) * 4;
            canvas[index..index + 4].copy_from_slice(&rgba);
        }
    }
}

fn redact_edge_outline(source: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut redacted = vec![0u8; source.len()];
    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) * 4;
            if source[index + 3] == 0 || !is_alpha_edge(source, width, height, x, y) {
                continue;
            }
            redacted[index..index + 4].copy_from_slice(&[224, 224, 224, 255]);
        }
    }
    redacted
}

fn is_alpha_edge(source: &[u8], width: usize, height: usize, x: usize, y: usize) -> bool {
    [
        (x.checked_sub(1), Some(y)),
        (x.checked_add(1), Some(y)),
        (Some(x), y.checked_sub(1)),
        (Some(x), y.checked_add(1)),
    ]
    .iter()
    .any(|(nx, ny)| match (nx, ny) {
        (Some(nx), Some(ny)) if *nx < width && *ny < height => {
            source[(*ny * width + *nx) * 4 + 3] == 0
        }
        _ => true,
    })
}

/// Encode a rasterized frame as a deterministic RGBA PNG (stored-zlib IDAT).
///
/// # Errors
///
/// Returns [`SoftpalRenderError`] when the dimensions overflow PNG's field or
/// disagree with the buffer length.
pub fn encode_softpal_png(frame: &SoftpalFrame) -> Result<Vec<u8>, SoftpalRenderError> {
    let width =
        usize::try_from(frame.width).map_err(|_| SoftpalRenderError::PngDimensionOverflow)?;
    let height =
        usize::try_from(frame.height).map_err(|_| SoftpalRenderError::PngDimensionOverflow)?;
    let row_len = width
        .checked_mul(4)
        .ok_or(SoftpalRenderError::InvalidCanvas)?;
    if row_len.checked_mul(height) != Some(frame.pixels_rgba.len()) {
        return Err(SoftpalRenderError::InvalidCanvas);
    }
    let mut scanlines = Vec::with_capacity(frame.pixels_rgba.len() + height);
    for row in frame.pixels_rgba.chunks_exact(row_len) {
        scanlines.push(0);
        scanlines.extend_from_slice(row);
    }
    let mut png = Vec::with_capacity(scanlines.len() + 128);
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&frame.width.to_be_bytes());
    ihdr.extend_from_slice(&frame.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    push_chunk(&mut png, *b"IHDR", &ihdr);
    push_chunk(&mut png, *b"IDAT", &zlib_stored(&scanlines));
    push_chunk(&mut png, *b"IEND", &[]);
    Ok(png)
}

fn zlib_stored(input: &[u8]) -> Vec<u8> {
    let mut output = vec![0x78, 0x01];
    for (index, chunk) in input.chunks(65_535).enumerate() {
        output.push(u8::from((index + 1) * 65_535 >= input.len()));
        let length = chunk.len() as u16;
        output.extend_from_slice(&length.to_le_bytes());
        output.extend_from_slice(&(!length).to_le_bytes());
        output.extend_from_slice(chunk);
    }
    output.extend_from_slice(&adler32(input).to_be_bytes());
    output
}

fn push_chunk(output: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(&kind);
    output.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(kind.len() + data.len());
    crc_input.extend_from_slice(&kind);
    crc_input.extend_from_slice(data);
    output.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn adler32(input: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in input {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn crc32(input: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in input {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_outline_default_keeps_geometry_but_discards_fills() {
        let filled =
            render_dialogue_frame(Some("Alice"), "a dialogue line", SoftpalRedaction::Full);
        let redacted = render_dialogue_frame(
            Some("Alice"),
            "a dialogue line",
            SoftpalRedaction::default(),
        );
        // The redacted frame carries only the gray edge colour or transparency.
        assert!(
            redacted
                .pixels_rgba
                .chunks_exact(4)
                .all(|pixel| { pixel == [0, 0, 0, 0] || pixel == [224, 224, 224, 255] })
        );
        // Redaction actually changed the pixels (filled boxes were present).
        assert_ne!(filled.pixels_rgba, redacted.pixels_rgba);
        // Some structure survived (the box edges).
        assert!(
            redacted.pixels_rgba.chunks_exact(4).any(|p| p[3] == 255),
            "edge outline retains message-box geometry"
        );
    }

    #[test]
    fn png_output_is_deterministic_with_png_magic() {
        let frame = render_dialogue_frame(None, "narration only", SoftpalRedaction::default());
        let first = encode_softpal_png(&frame).expect("encode");
        let second = encode_softpal_png(&frame).expect("encode");
        assert_eq!(first, second, "deterministic PNG");
        assert_eq!(&first[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn empty_text_still_renders_the_message_box_geometry() {
        let frame = render_dialogue_frame(None, "", SoftpalRedaction::default());
        assert_eq!(frame.width, FRAME_WIDTH);
        assert!(frame.pixels_rgba.chunks_exact(4).any(|p| p[3] == 255));
    }
}
