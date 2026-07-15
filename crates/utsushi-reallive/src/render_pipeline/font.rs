use std::sync::OnceLock;

use swash::FontRef;
use swash::scale::{Render, ScaleContext, Source};
use swash::zeno::Format;

use super::{Framebuffer, TextLayer};

/// Bundled font bytes. Compiled into the binary; never read from disk
/// or the network at runtime.
const FONT_BYTES: &[u8] = include_bytes!("../../assets/DejaVuSans.ttf");

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
            // A code point the font lacks maps to glyph 0 (`.notdef`
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
                    // 8-bit alpha mask: one coverage byte per pixel
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
/// rasterised at `px` em size through the bundled PROPORTIONAL font
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
