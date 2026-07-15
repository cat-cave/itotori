//! Choice / selection window layout types for the headless render pipeline.
//!
//! Extracted from the parent [`crate::render_pipeline`] module so the
//! text-list, spatial, and image-grid choice modalities live in their own
//! ≤500-line child. Public items are re-exported from the parent to keep
//! the crate API path unchanged.

use crate::gameexe::MessageWindowConfig;
use crate::graphics_objects::WipeColour;

use super::{TextBackdrop, TextLayer, window_box_geometry};

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
    /// config lives in; `frame_size` is the framebuffer. Box position
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
    pub(crate) fn prefix(&self, index: usize) -> &'static str {
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

/// A single option in a [`SpatialChoiceWindow`]: its localized name
/// label and the panel rectangle it occupies. `art_colour` is the
/// placeholder fill standing in for the not-yet-decoded option g00 art
/// (full-colour when the option is focused; desaturated-and-dimmed when
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
/// SPATIAL, side-by-side graphical select — Sweetie HD's route
/// love-interest pick (the game's first choice: two characters
/// side-by-side, the hovered one in full colour, the other grayscale
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

/// A single box in an [`ImageGridChoiceWindow`]: its localized name
/// label and the small icon rectangle it occupies. `art_colour` is the
/// placeholder fill standing in for the not-yet-decoded costume-icon g00
/// art (full-colour when selected; desaturated-and-dimmed when not).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageGridCell {
    /// Localized (translated) option label — e.g. the costume name shown
    /// in the caption when this box is selected.
    pub label: String,
    /// Box top-left (framebuffer px).
    pub x: u32,
    pub y: u32,
    /// Box extent (framebuffer px).
    pub w: u32,
    pub h: u32,
    /// Placeholder icon fill (stands in for the decoded costume g00 art).
    pub art_colour: WipeColour,
}

/// A RealLive `select_objbtn` (object-button) prompt rendered as an
/// IMAGE GRID — Sweetie HD's clothing / costume pick, the game's THIRD
/// choice modality: a horizontal STRIP of small costume-icon boxes near
/// the top of the frame, one highlighted, and (in the real flow) a
/// follow-on dialogue-style CONFIRM once a box is picked ("pick image →
/// confirm").
///
/// This is a distinct RENDER modality from BOTH the vertical text-list
/// [`ChoiceWindow`] AND the side-by-side [`SpatialChoiceWindow`]: the
/// options are laid out as a horizontal GRID of many small icon boxes
/// (rather than two big character panels or a vertical list), and the
/// selected box is cued by a bright highlight border + full colour
/// a caption naming it. A select is a GRAPHICAL button-object modality when
/// its scene carries button-object SelectionControl setup ops (`objbtn_init`
/// `select_objbtn`, the REAL opcodes 20 / 4) — see
/// [`crate::SelectionControlSignal`] / [`crate::select_modality`]. Within a
/// button-object select the image-GRID vs. side-by-side-PAIR choice is a
/// LAYOUT arrangement of the placed option-buttons (≥3 → grid), tagged
/// `choice:<idx>;imagegrid`.
///
/// The ACT half is unchanged: the selected index still resolves through
/// the store register + `goto_on` (see
/// [`crate::ReplayEngine::branch_following_lines`]), so selecting box K
/// drives branch K exactly like the text / spatial select; the follow-on
/// confirm is a subsequent standard select rendered as a [`ChoiceWindow`].
///
/// The option labels are OUR translated (localized) strings; the render
/// paints them through the in-crate bitmap [`font`], never the source g00
/// pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageGridChoiceWindow {
    /// The icon boxes, left to right.
    pub cells: Vec<ImageGridCell>,
    /// Index of the selected / highlighted box (clamped into range at
    /// construction).
    pub selected: usize,
    /// Glyph pixel height for the selected-option caption.
    pub caption_scale: u32,
    /// Caption band top-left x (framebuffer px).
    pub caption_x: u32,
    /// Caption band width (framebuffer px).
    pub caption_width: u32,
    /// Caption band height (framebuffer px).
    pub caption_height: u32,
    /// Vertical gap between the icon strip and the caption band (px).
    pub caption_gap: u32,
}

impl ImageGridChoiceWindow {
    /// Default palette the placeholder icon boxes cycle through so the
    /// costume options are visually distinct even before the real g00 art
    /// is decoded. Deterministic per box index.
    const PLACEHOLDER_PALETTE: &'static [WipeColour] = &[
        WipeColour::opaque_rgb(0x6E, 0xB4, 0xD8), // sky
        WipeColour::opaque_rgb(0xD8, 0x6E, 0x9B), // rose
        WipeColour::opaque_rgb(0x8E, 0xC8, 0x74), // leaf
        WipeColour::opaque_rgb(0xD8, 0xB4, 0x6E), // gold
        WipeColour::opaque_rgb(0xA0, 0x8E, 0xD8), // violet
        WipeColour::opaque_rgb(0xD8, 0x8E, 0x6E), // clay
    ];

    /// Lay out `options` as a horizontal image-grid strip near the top of
    /// a `screen`-sized framebuffer, with `selected` highlighted. The
    /// boxes split the usable strip width into equal small icon cells (a
    /// gutter between them); each gets a placeholder art colour from
    /// [`Self::PLACEHOLDER_PALETTE`]. A caption band under the strip shows
    /// the selected option's name.
    ///
    /// `screen` is the framebuffer size in px. The strip is placed by the
    /// object-button sprites (the costume icons), not a `#WINDOW.NNN` text
    /// box — matching the real clothing-strip layout at the top of the
    /// scene.
    pub fn from_options(options: &[String], selected: usize, screen: (u32, u32)) -> Self {
        let (sw, sh) = (screen.0.max(1), screen.1.max(1));
        let n = options.len().max(1) as u32;
        let selected = if options.is_empty() {
            0
        } else {
            selected.min(options.len() - 1)
        };
        let margin_x = (sw / 16).max(4);
        let strip_top = (sh / 12).max(4);
        let gutter = (sw / 96).max(3);
        let usable_w = sw
            .saturating_sub(margin_x * 2)
            .saturating_sub(gutter * (n - 1))
            .max(n);
        let cell_w = (usable_w / n).max(1);
        // Square-ish icon boxes, capped so a long strip stays a strip.
        let cell_h = cell_w.min(sh / 4).max(1);
        let caption_scale = (sh / 26).clamp(14, 44);
        let caption_height = (caption_scale * 2).min(sh.saturating_sub(strip_top + cell_h).max(1));
        let caption_gap = (sh / 40).max(2);

        let cells = options
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let x = margin_x + (cell_w + gutter) * index as u32;
                ImageGridCell {
                    label: label.clone(),
                    x,
                    y: strip_top,
                    w: cell_w,
                    h: cell_h,
                    art_colour: Self::PLACEHOLDER_PALETTE[index % Self::PLACEHOLDER_PALETTE.len()],
                }
            })
            .collect();

        Self {
            cells,
            selected,
            caption_scale,
            caption_x: margin_x,
            caption_width: sw.saturating_sub(margin_x * 2).max(1),
            caption_height,
            caption_gap,
        }
    }

    /// Total number of glyph characters shown (the selected option's
    /// caption label) — the non-vacuous-render denominator.
    pub fn char_count(&self) -> usize {
        self.cells
            .get(self.selected)
            .map_or(0, |cell| cell.label.chars().count())
    }
}
