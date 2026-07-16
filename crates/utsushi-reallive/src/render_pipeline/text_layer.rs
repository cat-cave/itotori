//! The localized [`TextLayer`] painter + its dialogue [`TextBackdrop`]
//! backdrop, moved verbatim out of the render-pipeline root module.

use crate::gameexe::MessageWindowConfig;
use crate::graphics_objects::WipeColour;

use super::{font, window_box_geometry};

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
    /// Optional separate speaker name box (RealLive `NAME_MOD=1`)
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
        // POS origin type + POS.y anchor the vertical band — a documented
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
