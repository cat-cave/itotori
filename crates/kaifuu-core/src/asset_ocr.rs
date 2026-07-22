//! prototype OCR + text-region extraction for image / UI assets.
//! Image and UI assets (title cards, buttons, textures) carry TEXT that may
//! need localization. This node PROTOTYPES the discovery of that text as
//! **structured evidence**: a public-fixture command reads a grayscale image
//! and emits schema-valid text regions, each with provenance (where in the
//! asset) and a stable content hash, plus a per-glyph recognition breakdown.
//! # THE LINE — OCR is NOT truth
//! The single most important property of this path is that **recognized text is
//! never asserted as a ground-truth translation source unless it is exact**. A
//! region is emitted with `recovered_text` **only** when every glyph in it
//! matches a reference glyph with a Hamming distance of zero. The moment any
//! glyph is fuzzy (a plausible-but-inexact read) or unrecognized, the region is
//! marked `is_uncertain = true`, its `recovered_text` is `None`, and it is ALSO
//! surfaced as a structured [`AssetOcrFinding`] whose `source` carries the
//! provenance, the confidence, and the best-effort `candidate_text` — explicitly
//! labelled as a candidate, never as truth. A downstream consumer therefore
//! cannot mistake an uncertain read for a confident one: the confident text
//! lives in `recovered_text`; everything else is a finding.
//! # Bounded prototype (honest scope)
//! This is a DETERMINISTIC prototype, not a production OCR engine:
//! - It decodes **uncompressed (stored-deflate) 8-bit grayscale PNG** fixtures
//!   in-process. It is not a general PNG decoder and does not decode
//!   Huffman-compressed retail image bytes. The public fixture is authored in
//!   this format so the whole path stays dependency-free.
//! - Recognition is a **fixed-pitch 5x7 bitmap-font** matcher (a monospace
//!   assumption): text regions are tiled into 5x7 glyph cells and each cell is
//!   Hamming-matched against a small reference font. This is a genuine, if tiny,
//!   OCR — enough to exercise the exact / fuzzy / unrecognized boundary — not a
//!   heavy learned model.
//!   Everything is pure in-process Rust: there is **no `Command::new`**, no
//!   shell-out to an external OCR binary, and no network. All fixture bytes are
//!   synthetic (rendered in-module by [`render_reference_title_card`]); no
//!   copyrighted asset is vendored.

use serde::{Deserialize, Serialize};

use crate::{KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash, stable_json};

mod png_codec;
pub use self::png_codec::{decode_grayscale_png, encode_grayscale_png};

mod recognize;
pub use self::recognize::run_asset_ocr;

/// Schema version of the emitted [`AssetOcrReport`].
pub const ASSET_OCR_SCHEMA_VERSION: &str = "0.1.0";

/// Provenance node id stamped into generated reports.
pub const ASSET_OCR_SOURCE_NODE_ID: &str = "KAIFUU-026";

/// Canonical id of this path / its public fixture.
pub const ASSET_OCR_FIXTURE_ID: &str = "kaifuu-asset-ocr-ui-title-card";

/// The mechanical support boundary, embedded verbatim in every report.
pub const ASSET_OCR_SUPPORT_BOUNDARY: &str = "Kaifuu asset-OCR is a DETERMINISTIC in-process prototype: it decodes uncompressed (stored-deflate) 8-bit grayscale PNG fixtures and matches fixed-pitch 5x7 glyph cells against a small reference font. It never shells out to an external OCR binary and never reads compressed retail image bytes. Recognized text is published in recovered_text ONLY when every glyph matches exactly (Hamming distance 0); any fuzzy or unrecognized region is marked uncertain, its recovered_text is None, and it is surfaced as a structured finding carrying provenance + confidence + a labelled candidate — OCR output is evidence, never asserted ground-truth translation source.";

/// Pixel intensity strictly below this is treated as ink (foreground text).
pub(super) const INK_THRESHOLD: u8 = 128;
/// Glyph cell width in pixels.
pub(super) const GLYPH_W: u32 = 5;
/// Glyph cell height in pixels.
pub(super) const GLYPH_H: u32 = 7;
/// Horizontal pitch between glyph cells (5 glyph columns + 1 gap column).
pub(super) const GLYPH_PITCH: u32 = 6;
/// A vertical run of at least this many all-background rows separates lines.
pub(super) const LINE_GAP: u32 = 2;
/// A horizontal run of at least this many all-background columns separates
/// words (text regions) within a line.
pub(super) const WORD_GAP: u32 = 2;
/// Total addressable bits in a glyph cell.
pub(super) const GLYPH_BITS: u32 = GLYPH_W * GLYPH_H;
/// Best-match Hamming distance in `1..=FUZZY_MATCH_MAX` yields a plausible but
/// UNCERTAIN candidate character. A larger distance is unrecognized.
pub(super) const FUZZY_MATCH_MAX: u32 = 6;

// Each glyph is 7 rows; each row's low 5 bits are the columns left-to-right
// (bit 4 = leftmost). Every glyph deliberately keeps ink in both edge columns
// and in the top and bottom rows so that fixed-pitch tiling stays aligned.

pub(super) const FONT: &[(char, [u8; 7])] = &[
    (
        'A',
        [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
    ),
    (
        'D',
        [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ],
    ),
    (
        'E',
        [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
    ),
    (
        'G',
        [
            0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110,
        ],
    ),
    (
        'L',
        [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
    ),
    (
        'M',
        [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
    ),
    (
        'N',
        [
            0b10001, 0b11001, 0b10101, 0b10101, 0b10011, 0b10001, 0b10001,
        ],
    ),
    (
        'O',
        [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
    ),
    (
        'W',
        [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
        ],
    ),
];

/// A qualitative confidence bucket derived from the numeric score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OcrConfidence {
    /// Every glyph matched exactly.
    High,
    /// Plausible but inexact (fuzzy) matches.
    Medium,
    /// No plausible match.
    Low,
}

impl OcrConfidence {
    pub(super) fn from_score(score: f64) -> Self {
        if score >= 0.999 {
            Self::High
        } else if score >= 0.6 {
            Self::Medium
        } else {
            Self::Low
        }
    }
}

/// Provenance of the whole source asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProvenance {
    /// The asset's file name only (no directory) — never a local path.
    pub asset_name: String,
    pub width: u32,
    pub height: u32,
    /// sha256 of the full source asset bytes.
    pub content_hash: ProofHash,
}

/// Where a text region lives inside the asset, plus a back-reference to the
/// asset it was extracted from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionProvenance {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub asset_name: String,
    pub asset_content_hash: ProofHash,
}

/// One reference-font match attempt for a single glyph cell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphCell {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// The best-matching reference character, present only when the best
    /// Hamming distance is within [`FUZZY_MATCH_MAX`]. `None` = unrecognized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best_match: Option<String>,
    /// Hamming distance of the best match (over [`GLYPH_BITS`] bits).
    pub hamming_distance: u32,
    /// sha256 of the cell's grayscale bytes.
    pub content_hash: ProofHash,
}

/// The recognition verdict for a text region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRecognition {
    /// The recovered text — present ONLY when every glyph matched exactly. When
    /// `None`, the region is uncertain and appears in `findings`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovered_text: Option<String>,
    /// Deterministic 0.0..=1.0 score (mean of per-glyph scores).
    pub confidence_score: f64,
    pub confidence: OcrConfidence,
    /// `true` when this region is NOT confidently recognized. An uncertain
    /// region is never asserted as truth; it is surfaced as a finding.
    pub is_uncertain: bool,
    pub glyph_cells: Vec<GlyphCell>,
}

/// A recovered text region (schema-valid evidence).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRegion {
    /// Deterministic id assigned in scan order (top-to-bottom, left-to-right).
    pub region_id: String,
    pub provenance: RegionProvenance,
    /// sha256 of the region's grayscale bytes.
    pub content_hash: ProofHash,
    pub recognition: OcrRecognition,
}

/// The source half of an uncertain finding: provenance + confidence + the
/// best-effort candidate that is explicitly NOT asserted as truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrFindingSource {
    pub provenance: RegionProvenance,
    pub content_hash: ProofHash,
    pub confidence_score: f64,
    pub confidence: OcrConfidence,
    /// The best-effort read. A CANDIDATE only — never ground truth. `None` when
    /// nothing in the region resembled the reference font.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_text: Option<String>,
}

/// An uncertain / unrecognized region, represented as a finding rather than an
/// asserted text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOcrFinding {
    /// `uncertain_text_region` (a plausible candidate exists) or
    /// `unrecognized_region` (nothing resembled text).
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    /// The region this finding is about.
    pub region_id: String,
    pub source: OcrFindingSource,
    pub message: String,
}

/// The full emitted report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOcrReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub asset: AssetProvenance,
    pub text_regions: Vec<TextRegion>,
    pub findings: Vec<AssetOcrFinding>,
}

impl AssetOcrReport {
    /// The regions a downstream consumer may treat as a confident source: those
    /// with an exact `recovered_text`. Uncertain regions are excluded by
    /// construction.
    pub fn confident_regions(&self) -> impl Iterator<Item = &TextRegion> {
        self.text_regions
            .iter()
            .filter(|region| region.recognition.recovered_text.is_some())
    }

    pub fn finding(&self, region_id: &str) -> Option<&AssetOcrFinding> {
        self.findings
            .iter()
            .find(|finding| finding.region_id == region_id)
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }
}

/// Input to [`run_asset_ocr`].
#[derive(Debug, Clone, Copy)]
pub struct AssetOcrRequest<'a> {
    /// The raw asset bytes (an uncompressed grayscale PNG for this prototype).
    pub asset_bytes: &'a [u8],
    /// The asset's file name only (no directory). Recorded as provenance.
    pub asset_name: &'a str,
}

/// A decoded 8-bit grayscale image, row-major.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrayImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl GrayImage {
    pub(super) fn pixel(&self, x: u32, y: u32) -> u8 {
        self.pixels[(y * self.width + x) as usize]
    }

    pub(super) fn is_ink(&self, x: u32, y: u32) -> bool {
        self.pixel(x, y) < INK_THRESHOLD
    }

    /// Row-major grayscale bytes of a sub-rectangle (clamped to the image).
    pub(super) fn crop_bytes(&self, x: u32, y: u32, width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::with_capacity((width * height) as usize);
        for row in y..y + height {
            for col in x..x + width {
                bytes.push(if row < self.height && col < self.width {
                    self.pixel(col, row)
                } else {
                    u8::MAX
                });
            }
        }
        bytes
    }

    /// Sample a [`GLYPH_W`]x[`GLYPH_H`] cell into a 35-bit ink pattern.
    pub(super) fn sample_glyph(&self, x: u32, y: u32) -> u32 {
        let mut pattern = 0u32;
        for row in 0..GLYPH_H {
            for col in 0..GLYPH_W {
                let sx = x + col;
                let sy = y + row;
                let ink = sx < self.width && sy < self.height && self.is_ink(sx, sy);
                pattern = (pattern << 1) | u32::from(ink);
            }
        }
        pattern
    }
}

/// Render the reference title-card fixture: an 8-bit grayscale PNG
/// with three confidently-recognizable words, one plausible-but-corrupted word,
/// and one non-text noise block. The committed public fixture is byte-pinned to
/// this function's output.
pub fn render_reference_title_card() -> Vec<u8> {
    const WIDTH: u32 = 50;
    const HEIGHT: u32 = 43;
    const MARGIN_X: u32 = 3;
    let mut pixels = vec![u8::MAX; (WIDTH * HEIGHT) as usize];
    let mut put = |x: u32, y: u32| {
        if x < WIDTH && y < HEIGHT {
            pixels[(y * WIDTH + x) as usize] = 0;
        }
    };

    // Line 0 (y=3): "NEW" and "GAME" separated by a three-column word gap.
    draw_word(&mut put, "NEW", MARGIN_X, 3);
    draw_word(&mut put, "GAME", MARGIN_X + word_width("NEW") + 3, 3);
    // Line 1 (y=13): "LOAD" — confidently recognized.
    draw_word(&mut put, "LOAD", MARGIN_X, 13);
    // Line 2 (y=23): a corrupted "LOAD" — the 'A' crossbar is erased, so it is a
    // plausible-but-uncertain read that must NOT be asserted as truth.
    draw_corrupted_load(&mut put, MARGIN_X, 23);
    // Line 3 (y=33): a checkerboard noise block that resembles no glyph.
    draw_noise_block(&mut put, MARGIN_X, 33);

    encode_grayscale_png(WIDTH, HEIGHT, &pixels)
}

fn word_width(word: &str) -> u32 {
    (word.chars().count() as u32) * GLYPH_PITCH - 1
}

fn font_glyph(character: char) -> [u8; 7] {
    FONT.iter()
        .find(|(candidate, _)| *candidate == character)
        .map_or([0; 7], |(_, rows)| *rows)
}

fn draw_glyph_rows(put: &mut impl FnMut(u32, u32), rows: &[u8; 7], x: u32, y: u32) {
    for (row_index, row) in rows.iter().enumerate() {
        for col in 0..GLYPH_W {
            let bit = (row >> (GLYPH_W - 1 - col)) & 1;
            if bit == 1 {
                put(x + col, y + row_index as u32);
            }
        }
    }
}

fn draw_word(put: &mut impl FnMut(u32, u32), word: &str, x: u32, y: u32) {
    for (index, character) in word.chars().enumerate() {
        let cell_x = x + (index as u32) * GLYPH_PITCH;
        draw_glyph_rows(put, &font_glyph(character), cell_x, y);
    }
}

fn draw_corrupted_load(put: &mut impl FnMut(u32, u32), x: u32, y: u32) {
    let glyphs = ['L', 'O', 'A', 'D'];
    for (index, character) in glyphs.iter().enumerate() {
        let cell_x = x + (index as u32) * GLYPH_PITCH;
        let mut rows = font_glyph(*character);
        if *character == 'A' {
            rows[3] = 0b10001; // erase the crossbar -> best match stays 'A', but fuzzy
        }
        draw_glyph_rows(put, &rows, cell_x, y);
    }
}

fn draw_noise_block(put: &mut impl FnMut(u32, u32), x: u32, y: u32) {
    let rows: [u8; 7] = [
        0b10101, 0b01010, 0b10101, 0b01010, 0b10101, 0b01010, 0b10101,
    ];
    draw_glyph_rows(put, &rows, x, y);
}

#[cfg(test)]
#[path = "asset_ocr_tests.rs"]
mod tests;
