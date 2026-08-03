use std::sync::OnceLock;

use sha2::{Digest, Sha256};
use swash::FontRef;
use swash::scale::{Render, ScaleContext, Source};
use swash::zeno::Format;

use super::{
    Framebuffer, TextLayer,
    ocr_readback::OcrLayout,
    pixel_gate::{GlyphRaster, PixelBounds, TextRaster},
};

/// Bundled Japanese-capable font bytes. Compiled into the binary; never read
/// from disk or the network at runtime. This is the renamed, JP-only Noto
/// Serif CJK derivative described in `assets/README.md`; it also covers Latin
/// text used by localized patches.
const FONT_BYTES: &[u8] = include_bytes!("../../assets/ItotoriJapaneseSubset.otf");

/// Parse the bundled font once. The bytes are a fixed compiled-in
/// asset, so a parse failure is a build-time-shipped-corrupt-asset
/// bug, not a runtime condition — `expect` is the honest contract.
fn font() -> FontRef<'static> {
    static FONT: OnceLock<FontRef<'static>> = OnceLock::new();
    *FONT.get_or_init(|| {
        FontRef::from_index(FONT_BYTES, 0).expect("bundled Japanese subset font must parse")
    })
}

/// Rasterise every line of `layer` through the TrueType font (via the
/// maintained `swash` scaler + `zeno` rasteriser — the `fontations`
/// stack, `cargo deny`-clean). Returns the count of glyph-coverage
/// framebuffer pixels painted (coverage `> 0`), so the emit path can
/// prove the localized text actually drew something.
pub fn draw_lines(framebuffer: &mut Framebuffer, layer: &TextLayer) -> u64 {
    rasterise_lines(framebuffer, layer, RasterMode::Normal).coverage_pixels
}

#[derive(Clone, Copy)]
pub(super) enum RasterMode {
    Normal,
    #[cfg(test)]
    ReplacementGlyphs,
    #[cfg(test)]
    DropPixels,
    #[cfg(test)]
    Offset {
        x: i32,
        y: i32,
    },
}

pub(super) fn rasterise_lines(
    framebuffer: &mut Framebuffer,
    layer: &TextLayer,
    mode: RasterMode,
) -> TextRaster {
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
    let mut raster = TextRaster::default();

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
            #[cfg(test)]
            if matches!(mode, RasterMode::ReplacementGlyphs) {
                // A forced resolver outage follows the real failure's visible
                // contract: every requested glyph becomes the same .notdef
                // box while the decoded characters remain intact upstream.
                let side = px.round().max(1.0) as u32;
                let base_x = caret_x.round() as i32;
                let base_y = baseline_y.round() as i32 - side as i32;
                let mut bitmap = vec![0u8; (side * side) as usize];
                for y in 0..side {
                    for x in 0..side {
                        if x == 0 || y == 0 || x + 1 == side || y + 1 == side {
                            bitmap[(y * side + x) as usize] = 0xFF;
                        }
                    }
                }
                let mut signature = Sha256::new();
                signature.update(side.to_le_bytes());
                signature.update(&bitmap);
                raster.glyphs.push(GlyphRaster {
                    source: character,
                    coverage_signature: format!("{:x}", signature.finalize()),
                    line_index,
                    bounds: PixelBounds {
                        left: base_x.max(0) as u32,
                        top: base_y.max(0) as u32,
                        right: (base_x + side as i32 - 1)
                            .min(framebuffer.width as i32 - 1)
                            .max(0) as u32,
                        bottom: (base_y + side as i32 - 1)
                            .min(framebuffer.height as i32 - 1)
                            .max(0) as u32,
                    },
                });
                for y in 0..side {
                    for x in 0..side {
                        if bitmap[(y * side + x) as usize] == 0 {
                            continue;
                        }
                        let px_x = base_x + x as i32;
                        let px_y = base_y + y as i32;
                        if px_x < 0 || px_y < 0 || !framebuffer.in_bounds(px_x as u32, px_y as u32)
                        {
                            continue;
                        }
                        framebuffer.blend_pixel(
                            px_x as u32,
                            px_y as u32,
                            [colour.red, colour.green, colour.blue, colour.alpha],
                            0xFF,
                        );
                        raster.coverage_pixels += 1;
                    }
                }
                caret_x += side as f32;
                continue;
            }
            // Noto Serif CJK JP covers the Japanese source and common target
            // locales. A genuinely unsupported code point still maps to
            // glyph 0 (`.notdef`) rather than disappearing silently.
            let glyph_id = match mode {
                RasterMode::Normal => charmap.map(character),
                #[cfg(test)]
                RasterMode::ReplacementGlyphs
                | RasterMode::DropPixels
                | RasterMode::Offset { .. } => charmap.map(character),
            };
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
            let bounds = PixelBounds {
                left: base_x.max(0) as u32,
                top: base_y.max(0) as u32,
                right: (base_x + placement.width as i32 - 1)
                    .min(framebuffer.width as i32 - 1)
                    .max(0) as u32,
                bottom: (base_y + placement.height as i32 - 1)
                    .min(framebuffer.height as i32 - 1)
                    .max(0) as u32,
            };
            let mut signature = Sha256::new();
            signature.update(placement.width.to_le_bytes());
            signature.update(placement.height.to_le_bytes());
            signature.update(&image.data);
            raster.glyphs.push(GlyphRaster {
                source: character,
                coverage_signature: format!("{:x}", signature.finalize()),
                line_index,
                bounds,
            });

            for gy in 0..placement.height {
                for gx in 0..placement.width {
                    // 8-bit alpha mask: one coverage byte per pixel
                    // row-major, for anti-aliased edges.
                    let cover = image.data[(gy * placement.width + gx) as usize];
                    if cover == 0 {
                        continue;
                    }
                    let (offset_x, offset_y) = match mode {
                        RasterMode::Normal => (0, 0),
                        #[cfg(test)]
                        RasterMode::ReplacementGlyphs | RasterMode::DropPixels => (0, 0),
                        #[cfg(test)]
                        RasterMode::Offset { x, y } => (x, y),
                    };
                    let px_x = base_x + gx as i32 + offset_x;
                    let px_y = base_y + gy as i32 + offset_y;
                    if px_x < 0 || px_y < 0 {
                        continue;
                    }
                    if !framebuffer.in_bounds(px_x as u32, px_y as u32) {
                        continue;
                    }
                    let draws_pixels = match mode {
                        RasterMode::Normal => true,
                        #[cfg(test)]
                        RasterMode::ReplacementGlyphs | RasterMode::Offset { .. } => true,
                        #[cfg(test)]
                        RasterMode::DropPixels => false,
                    };
                    if draws_pixels {
                        framebuffer.blend_pixel(
                            px_x as u32,
                            px_y as u32,
                            [colour.red, colour.green, colour.blue, colour.alpha],
                            cover,
                        );
                    }
                    raster.coverage_pixels += 1;
                }
            }
            caret_x += advance;
        }
    }
    raster
}

/// Paint a layer and retain only source-free geometry for the emitted-frame
/// OCR readback. The layout deliberately receives no decoded character or
/// expected target; matching happens later against the written PNG pixels.
pub(super) fn rasterise_lines_with_ocr(
    framebuffer: &mut Framebuffer,
    layer: &TextLayer,
    layout: &mut OcrLayout,
) -> TextRaster {
    let raster = rasterise_lines(framebuffer, layer, RasterMode::Normal);
    layout.record(&raster, layer);
    raster
}

/// One standard-alphabet glyph template used by public-frame OCR.
#[derive(Clone)]
pub(super) struct OcrGlyphCandidate {
    pub(super) character: char,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) left: i32,
    pub(super) advance: f32,
    pub(super) coverage: Vec<u8>,
}

/// Rasterise a fixed, reviewable target-language alphabet independently of
/// the rendered message. This is a candidate library, not a projection of
/// decoded/replayed text.
pub(super) fn ocr_candidates(scale: u32) -> Vec<OcrGlyphCandidate> {
    const CANDIDATE_ALPHABET: &str = concat!(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        "!\\\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
        "…‘’“”–—¡¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß",
        "àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ"
    );
    let font = font();
    let px = scale.max(1) as f32;
    let glyph_metrics = font.glyph_metrics(&[]).scale(px);
    let charmap = font.charmap();
    let mut context = ScaleContext::new();
    let mut scaler = context.builder(font).size(px).hint(false).build();
    let mut render = Render::new(&[Source::Outline]);
    render.format(Format::Alpha);

    CANDIDATE_ALPHABET
        .chars()
        .filter_map(|character| {
            let glyph_id = charmap.map(character);
            if glyph_id == 0 {
                return None;
            }
            let advance = glyph_metrics.advance_width(glyph_id);
            let image = render.render(&mut scaler, glyph_id)?;
            let placement = image.placement;
            (placement.width > 0 && placement.height > 0).then(|| OcrGlyphCandidate {
                character,
                width: placement.width,
                height: placement.height,
                left: placement.left,
                advance,
                coverage: image.data.clone(),
            })
        })
        .collect()
}

/// Standard space advance for gap-only word reconstruction in OCR output.
pub(super) fn ocr_space_advance(scale: u32) -> f32 {
    let font = font();
    let glyph_metrics = font.glyph_metrics(&[]).scale(scale.max(1) as f32);
    glyph_metrics.advance_width(font.charmap().map(' '))
}

#[cfg(test)]
pub(super) fn rasterise_lines_for_test(
    framebuffer: &mut Framebuffer,
    layer: &TextLayer,
    replacement_glyphs: bool,
    drop_pixels: bool,
    offset: (i32, i32),
) -> TextRaster {
    let mode = if replacement_glyphs {
        RasterMode::ReplacementGlyphs
    } else if drop_pixels {
        RasterMode::DropPixels
    } else if offset != (0, 0) {
        RasterMode::Offset {
            x: offset.0,
            y: offset.1,
        }
    } else {
        RasterMode::Normal
    };
    rasterise_lines(framebuffer, layer, mode)
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

#[cfg(test)]
mod tests {
    use super::*;

    // 128 evenly-spaced kanji from the 6,355-kanji JIS X 0208 repertoire.
    // This deliberately comes from the standard, not from any renderer input
    // or fixture. It covers the repertoire from U+4E00 through U+9FA0, so a
    // corpus-derived subset cannot satisfy this assertion accidentally.
    const JIS_X_0208_KANJI_SAMPLE: &str = concat!(
        "一亀付佞俳傀儺冕刀創勹卦叨呉哨喧嚆圧埼墸太妬媛孱寛尽峩巌幇廏",
        "弭得性悠愡憚戡抜挑掫撈攬斧昨暼朴枡栫梳椰槁橈欧殲汢泣涕渡滄潰瀛",
        "焼燿犯獪瑞産疉瘠皸睚砦礇禺穎竝策簀粢級綟縟纔羶聞胝膈興芙茨菟蒂",
        "蕁藥蛆蝣衂裔襾訝誠謔豁貽起蹙輌辻逧邁酬釿鋺鏗間陝雁霾韮風饕驅鬮",
        "鯨鴆鷄黒龠"
    );

    #[test]
    fn bundled_font_maps_standard_jis_x_0208_kanji_to_real_glyphs() {
        let charmap = font().charmap();
        assert_eq!(JIS_X_0208_KANJI_SAMPLE.chars().count(), 128);

        for character in JIS_X_0208_KANJI_SAMPLE.chars() {
            assert_ne!(
                charmap.map(character),
                0,
                "the JIS X 0208 sample character {character:?} must not map to .notdef"
            );
        }
    }
}
