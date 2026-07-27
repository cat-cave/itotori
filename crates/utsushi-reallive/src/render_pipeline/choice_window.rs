//! Choice / selection window layout types for the headless render pipeline.
//!
//! Text choices use Gameexe window metadata. Button-object choices use the
//! decoded bounds and image references captured at prompt time; this module
//! deliberately contains no option-count layout rules.

use crate::gameexe::{Gameexe, MessageWindowConfig};
use crate::graphics_objects::{HitRect, HitRegionUnavailable, ImageRef, WipeColour};

use super::{TextBackdrop, TextLayer, font, window_box_geometry};

/// The engine's OWN choice-list placement, read from a game's
/// `#SELBTN.<set>.*` block.
///
/// RealLive lays a text `select` out from `BASEPOS` plus a per-option
/// `REPPOS` advance, optionally centred per `CENTERING`. Reading it is
/// what puts option `k` at ITS coordinates instead of stacking every
/// option on the message window's single text origin — where the options
/// overprint each other and the prompt.
///
/// Absent keys yield `None` from [`Self::from_gameexe`]: a game that
/// declares no select block gets the message-window fallback, never a
/// synthesized layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectButtonLayout {
    /// `BASEPOS` — the first option's top-left, in the game's virtual
    /// screen space.
    pub base_pos: (i32, i32),
    /// `REPPOS` — the per-option advance applied `index` times.
    pub rep_pos: (i32, i32),
    /// `CENTERING` — non-zero on an axis centres the option on it.
    pub centering: (i32, i32),
    /// `MOJISIZE` first field — the option glyph height.
    pub moji_size: u32,
}

impl SelectButtonLayout {
    /// Read `#SELBTN.<set>.*`. Returns `None` unless BOTH the base
    /// position and the per-option advance are declared — a partial block
    /// cannot place option `k` and must not be guessed at.
    pub fn from_gameexe(gameexe: &Gameexe, set: u32) -> Option<Self> {
        let key = |suffix: &str| format!("SELBTN.{set:03}.{suffix}");
        let pair = |suffix: &str| -> Option<(i32, i32)> {
            match gameexe.get_int_array(&key(suffix)) {
                Some([x, y, ..]) => Some((*x, *y)),
                _ => None,
            }
        };
        let base_pos = pair("BASEPOS")?;
        let rep_pos = pair("REPPOS")?;
        Some(Self {
            base_pos,
            rep_pos,
            centering: pair("CENTERING").unwrap_or((0, 0)),
            moji_size: match gameexe.get_int_array(&key("MOJISIZE")) {
                Some([size, ..]) if *size > 0 => *size as u32,
                _ => 0,
            },
        })
    }
}

/// A RealLive text `select` prompt rendered as a cursor-highlighted list in
/// the configured selection window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceWindow {
    /// Localized option labels, top to bottom.
    pub options: Vec<String>,
    /// Focused option, clamped into range at construction.
    pub selected: usize,
    /// The Gameexe-configured selection-window backdrop rectangle.
    /// `None` for a `#SELBTN`-placed list, which draws its options over
    /// the scene rather than inside a message box.
    pub backdrop: Option<TextBackdrop>,
    /// Text origin in framebuffer pixels.
    pub origin_x: u32,
    pub origin_y: u32,
    /// Glyph pixel height.
    pub scale: u32,
    /// Baseline-to-baseline row stride.
    pub line_height: u32,
    /// Per-option horizontal advance (`#SELBTN` `REPPOS.x`). `0` keeps
    /// every option on one left edge.
    pub column_stride: i32,
    /// Frame width each option is centred on (`#SELBTN` `CENTERING.x`).
    /// `None` left-aligns at [`Self::origin_x`].
    pub centre_within: Option<u32>,
}

impl ChoiceWindow {
    const CURSOR_PREFIX: &'static str = "> ";
    const IDLE_PREFIX: &'static str = "  ";

    /// Place text options with the same Gameexe-driven geometry used by a
    /// message window.
    pub fn from_config(
        options: &[String],
        selected: usize,
        config: &MessageWindowConfig,
        screen_size: (u32, u32),
        frame_size: (u32, u32),
    ) -> Self {
        let geometry = window_box_geometry(config, screen_size, frame_size);
        let selected = selected.min(options.len().saturating_sub(1));
        Self {
            options: options.to_vec(),
            selected,
            backdrop: Some(geometry.backdrop),
            origin_x: geometry.origin_x,
            origin_y: geometry.origin_y,
            scale: geometry.scale,
            line_height: geometry.line_height,
            column_stride: 0,
            centre_within: None,
        }
    }

    /// Place text options at the game's OWN `#SELBTN` coordinates:
    /// option `k` lands at `BASEPOS + k * REPPOS`, scaled from the
    /// game's virtual screen space into the framebuffer, centred on any
    /// axis `CENTERING` marks.
    ///
    /// This is the placement that keeps N options from collapsing onto
    /// the single message-window text origin. `moji_size` falls back to
    /// the message window's glyph height when the block omits it; nothing
    /// else here is defaulted.
    pub fn from_select_buttons(
        options: &[String],
        selected: usize,
        layout: SelectButtonLayout,
        config: &MessageWindowConfig,
        screen_size: (u32, u32),
        frame_size: (u32, u32),
    ) -> Self {
        let scale_x = frame_size.0 as f32 / screen_size.0.max(1) as f32;
        let scale_y = frame_size.1 as f32 / screen_size.1.max(1) as f32;
        let to_x = |v: i32| (v as f32 * scale_x).round().max(0.0) as u32;
        let to_y = |v: i32| (v as f32 * scale_y).round().max(0.0) as u32;
        let moji_size = if layout.moji_size > 0 {
            layout.moji_size
        } else {
            config.moji_size
        };
        Self {
            options: options.to_vec(),
            selected: selected.min(options.len().saturating_sub(1)),
            backdrop: None,
            origin_x: to_x(layout.base_pos.0),
            origin_y: to_y(layout.base_pos.1),
            scale: ((moji_size as f32) * scale_y).round().max(10.0) as u32,
            line_height: to_y(layout.rep_pos.1).max(1),
            column_stride: (layout.rep_pos.0 as f32 * scale_x).round() as i32,
            centre_within: (layout.centering.0 != 0).then_some(frame_size.0),
        }
    }

    /// Framebuffer x the option at `index` is drawn from, honouring the
    /// per-option advance and horizontal centring.
    pub fn option_origin_x(&self, index: usize) -> u32 {
        if let Some(width) = self.centre_within {
            let label = format!("{}{}", self.prefix(index), self.options[index]);
            let measured = font::line_width(&label, self.scale as f32).round().max(0.0) as u32;
            return width.saturating_sub(measured) / 2;
        }
        let advance = self.column_stride.saturating_mul(index as i32);
        self.origin_x.saturating_add_signed(advance)
    }

    /// Framebuffer y the option at `index` is drawn from.
    pub fn option_origin_y(&self, index: usize) -> u32 {
        self.origin_y
            .saturating_add((index as u32).saturating_mul(self.line_height))
    }

    /// Glyph characters including cursor/padding prefixes.
    pub fn char_count(&self) -> usize {
        self.options
            .iter()
            .map(|option| option.chars().count() + Self::CURSOR_PREFIX.chars().count())
            .sum()
    }

    pub(crate) fn prefix(&self, index: usize) -> &'static str {
        if index == self.selected {
            Self::CURSOR_PREFIX
        } else {
            Self::IDLE_PREFIX
        }
    }

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
            backdrop: self.backdrop,
            name_box: None,
            line_height: Some(self.line_height),
        }
    }
}

/// One selected button object's decoded render metadata. `bounds` is the
/// transformed g00-pattern hit rectangle; `art` is the exact image reference
/// the graphics pass composites at those coordinates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectButtonChoiceOption {
    pub display_index: u16,
    pub button_number: i32,
    pub slot: usize,
    pub bounds: HitRect,
    pub art: ImageRef,
}

impl ObjectButtonChoiceOption {
    /// Whether an authored screen-space pixel is inside this button's decoded
    /// rectangle. Right and bottom edges are exclusive, as in the renderer's
    /// source rectangle convention.
    pub fn contains_pixel(&self, x: i32, y: i32) -> bool {
        let right = self.bounds.x.saturating_add(self.bounds.width);
        let bottom = self.bounds.y.saturating_add(self.bounds.height);
        x >= self.bounds.x && x < right && y >= self.bounds.y && y < bottom
    }
}

/// Explicit failures when decoded button metadata cannot drive rendering.
/// Callers can choose a title-specific fallback only by handling this error;
/// the engine supplies no synthesized pair, strip, grid, palette, or margins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectButtonChoiceWindowBuildError {
    GeometryUnavailable {
        display_index: u16,
        reason: HitRegionUnavailable,
    },
    NonImageArt {
        display_index: u16,
    },
}

/// A button-object prompt overlay. The graphics pass renders the decoded g00
/// art itself; this type only draws focus frames at the prompt's decoded
/// rectangles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectButtonChoiceWindow {
    pub options: Vec<ObjectButtonChoiceOption>,
    pub selected: usize,
}

impl ObjectButtonChoiceWindow {
    pub fn from_metadata(options: Vec<ObjectButtonChoiceOption>, selected: usize) -> Self {
        let selected = selected.min(options.len().saturating_sub(1));
        Self { options, selected }
    }
}
