//! Choice / selection window layout types for the headless render pipeline.
//!
//! Text choices use Gameexe window metadata. Button-object choices use the
//! decoded bounds and image references captured at prompt time; this module
//! deliberately contains no option-count layout rules.

use crate::gameexe::MessageWindowConfig;
use crate::graphics_objects::{HitRect, HitRegionUnavailable, ImageRef, WipeColour};

use super::{TextBackdrop, TextLayer, window_box_geometry};

/// A RealLive text `select` prompt rendered as a cursor-highlighted list in
/// the configured selection window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceWindow {
    /// Localized option labels, top to bottom.
    pub options: Vec<String>,
    /// Focused option, clamped into range at construction.
    pub selected: usize,
    /// The Gameexe-configured selection-window backdrop rectangle.
    pub backdrop: TextBackdrop,
    /// Text origin in framebuffer pixels.
    pub origin_x: u32,
    pub origin_y: u32,
    /// Glyph pixel height.
    pub scale: u32,
    /// Baseline-to-baseline row stride.
    pub line_height: u32,
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
            backdrop: geometry.backdrop,
            origin_x: geometry.origin_x,
            origin_y: geometry.origin_y,
            scale: geometry.scale,
            line_height: geometry.line_height,
        }
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
            backdrop: Some(self.backdrop),
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
    pub fg_slot: usize,
    pub bounds: HitRect,
    pub art: ImageRef,
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
