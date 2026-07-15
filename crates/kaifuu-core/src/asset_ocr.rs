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

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash, sha256_hash_bytes,
    stable_json,
};

/// Schema version of the emitted [`AssetOcrReport`].
pub const ASSET_OCR_SCHEMA_VERSION: &str = "0.1.0";

/// The spec-DAG node id this path is authored for.
pub const ASSET_OCR_SOURCE_NODE_ID: &str = "KAIFUU-026";

/// Canonical id of this path / its public fixture.
pub const ASSET_OCR_FIXTURE_ID: &str = "kaifuu-asset-ocr-ui-title-card";

/// The mechanical support boundary, embedded verbatim in every report.
pub const ASSET_OCR_SUPPORT_BOUNDARY: &str = "Kaifuu asset-OCR is a DETERMINISTIC in-process prototype: it decodes uncompressed (stored-deflate) 8-bit grayscale PNG fixtures and matches fixed-pitch 5x7 glyph cells against a small reference font. It never shells out to an external OCR binary and never reads compressed retail image bytes. Recognized text is published in recovered_text ONLY when every glyph matches exactly (Hamming distance 0); any fuzzy or unrecognized region is marked uncertain, its recovered_text is None, and it is surfaced as a structured finding carrying provenance + confidence + a labelled candidate — OCR output is evidence, never asserted ground-truth translation source.";

/// Pixel intensity strictly below this is treated as ink (foreground text).
const INK_THRESHOLD: u8 = 128;
/// Glyph cell width in pixels.
const GLYPH_W: u32 = 5;
/// Glyph cell height in pixels.
const GLYPH_H: u32 = 7;
/// Horizontal pitch between glyph cells (5 glyph columns + 1 gap column).
const GLYPH_PITCH: u32 = 6;
/// A vertical run of at least this many all-background rows separates lines.
const LINE_GAP: u32 = 2;
/// A horizontal run of at least this many all-background columns separates
/// words (text regions) within a line.
const WORD_GAP: u32 = 2;
/// Total addressable bits in a glyph cell.
const GLYPH_BITS: u32 = GLYPH_W * GLYPH_H;
/// Best-match Hamming distance in `1..=FUZZY_MATCH_MAX` yields a plausible but
/// UNCERTAIN candidate character. A larger distance is unrecognized.
const FUZZY_MATCH_MAX: u32 = 6;

// Each glyph is 7 rows; each row's low 5 bits are the columns left-to-right
// (bit 4 = leftmost). Every glyph deliberately keeps ink in both edge columns
// and in the top and bottom rows so that fixed-pitch tiling stays aligned.

const FONT: &[(char, [u8; 7])] = &[
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
    fn from_score(score: f64) -> Self {
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

/// Run the deterministic text-region extractor over an asset.
/// Returns `Err` only when the bytes cannot be decoded as a supported (stored
/// -deflate, 8-bit grayscale) PNG; recognition uncertainty is per-region
/// evidence, never an error.
pub fn run_asset_ocr(request: AssetOcrRequest<'_>) -> KaifuuResult<AssetOcrReport> {
    let image = decode_grayscale_png(request.asset_bytes)?;
    let asset_hash = ProofHash::new(sha256_hash_bytes(request.asset_bytes))?;
    let asset = AssetProvenance {
        asset_name: request.asset_name.to_string(),
        width: image.width,
        height: image.height,
        content_hash: asset_hash.clone(),
    };

    let mut text_regions = Vec::new();
    let mut findings = Vec::new();
    for (index, bounds) in detect_word_regions(&image).into_iter().enumerate() {
        let region_id = format!("region-{:04}", index + 1);
        let (region, finding) =
            build_region(&image, &bounds, &region_id, request.asset_name, &asset_hash)?;
        if let Some(finding) = finding {
            findings.push(finding);
        }
        text_regions.push(region);
    }

    Ok(AssetOcrReport {
        schema_version: ASSET_OCR_SCHEMA_VERSION.to_string(),
        path_id: ASSET_OCR_FIXTURE_ID.to_string(),
        source_node_id: ASSET_OCR_SOURCE_NODE_ID.to_string(),
        support_boundary: ASSET_OCR_SUPPORT_BOUNDARY.to_string(),
        status: OperationStatus::Passed,
        asset,
        text_regions,
        findings,
    })
}

/// A tight bounding box of a detected word region.
#[derive(Debug, Clone, Copy)]
struct RegionBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

fn detect_word_regions(image: &GrayImage) -> Vec<RegionBounds> {
    let mut regions = Vec::new();
    for band in detect_line_bands(image) {
        for (word_left, word_right) in detect_word_spans(image, band.top, band.bottom) {
            regions.push(RegionBounds {
                x: word_left,
                y: band.top,
                width: word_right - word_left + 1,
                height: band.bottom - band.top + 1,
            });
        }
    }
    regions
}

#[derive(Debug, Clone, Copy)]
struct LineBand {
    top: u32,
    bottom: u32,
}

fn detect_line_bands(image: &GrayImage) -> Vec<LineBand> {
    let inky_row: Vec<bool> = (0..image.height)
        .map(|y| (0..image.width).any(|x| image.is_ink(x, y)))
        .collect();
    group_runs(&inky_row, LINE_GAP)
        .into_iter()
        .map(|(top, bottom)| LineBand { top, bottom })
        .collect()
}

fn detect_word_spans(image: &GrayImage, top: u32, bottom: u32) -> Vec<(u32, u32)> {
    let inky_col: Vec<bool> = (0..image.width)
        .map(|x| (top..=bottom).any(|y| image.is_ink(x, y)))
        .collect();
    group_runs(&inky_col, WORD_GAP)
}

/// Group indices with `true` into `(start, end)` inclusive runs, treating a gap
/// of at least `min_gap` consecutive `false` entries as a separator.
fn group_runs(flags: &[bool], min_gap: u32) -> Vec<(u32, u32)> {
    let mut runs = Vec::new();
    let mut start: Option<u32> = None;
    let mut last_true: Option<u32> = None;
    for (index, &flag) in flags.iter().enumerate() {
        let index = index as u32;
        if flag {
            if start.is_none() {
                start = Some(index);
            } else if let (Some(prev), Some(begin)) = (last_true, start)
                && index - prev > min_gap
            {
                runs.push((begin, prev));
                start = Some(index);
            }
            last_true = Some(index);
        }
    }
    if let (Some(begin), Some(prev)) = (start, last_true) {
        runs.push((begin, prev));
    }
    runs
}

fn build_region(
    image: &GrayImage,
    bounds: &RegionBounds,
    region_id: &str,
    asset_name: &str,
    asset_hash: &ProofHash,
) -> KaifuuResult<(TextRegion, Option<AssetOcrFinding>)> {
    let provenance = RegionProvenance {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        asset_name: asset_name.to_string(),
        asset_content_hash: asset_hash.clone(),
    };
    let region_hash = ProofHash::new(sha256_hash_bytes(&image.crop_bytes(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
    )))?;

    let glyph_count = glyph_count_for_width(bounds.width);
    let mut cells = Vec::with_capacity(glyph_count as usize);
    let mut best_chars = Vec::with_capacity(glyph_count as usize);
    let mut scores = Vec::with_capacity(glyph_count as usize);
    let mut all_exact = glyph_count > 0;
    for glyph_index in 0..glyph_count {
        let cell_x = bounds.x + glyph_index * GLYPH_PITCH;
        let pattern = image.sample_glyph(cell_x, bounds.y);
        let (best_char, distance) = match_glyph(pattern);
        let cell_bytes = image.crop_bytes(cell_x, bounds.y, GLYPH_W, GLYPH_H);
        let recognized = distance <= FUZZY_MATCH_MAX;
        if distance != 0 {
            all_exact = false;
        }
        scores.push(if recognized {
            1.0 - f64::from(distance) / f64::from(GLYPH_BITS)
        } else {
            0.0
        });
        best_chars.push(if recognized { Some(best_char) } else { None });
        cells.push(GlyphCell {
            x: cell_x,
            y: bounds.y,
            width: GLYPH_W,
            height: GLYPH_H,
            best_match: if recognized {
                Some(best_char.to_string())
            } else {
                None
            },
            hamming_distance: distance,
            content_hash: ProofHash::new(sha256_hash_bytes(&cell_bytes))?,
        });
    }

    let confidence_score = if scores.is_empty() {
        0.0
    } else {
        scores.iter().sum::<f64>() / scores.len() as f64
    };
    let confidence = OcrConfidence::from_score(confidence_score);
    let is_uncertain = !all_exact;
    let recovered_text = if all_exact {
        Some(best_chars.iter().flatten().collect::<String>())
    } else {
        None
    };
    let candidate_text = build_candidate_text(&best_chars);

    let recognition = OcrRecognition {
        recovered_text,
        confidence_score,
        confidence,
        is_uncertain,
        glyph_cells: cells,
    };
    let region = TextRegion {
        region_id: region_id.to_string(),
        provenance: provenance.clone(),
        content_hash: region_hash.clone(),
        recognition,
    };

    let finding = if is_uncertain {
        let (code, message) = if candidate_text.is_some() {
            (
                "uncertain_text_region",
                "region resembles text but no exact glyph match was found; candidate is evidence, not ground truth",
            )
        } else {
            (
                "unrecognized_region",
                "region contains ink but did not resemble any reference glyph; no text is asserted",
            )
        };
        Some(AssetOcrFinding {
            code: code.to_string(),
            severity: PartialDiagnosticSeverity::P2,
            region_id: region_id.to_string(),
            source: OcrFindingSource {
                provenance,
                content_hash: region_hash,
                confidence_score,
                confidence,
                candidate_text,
            },
            message: message.to_string(),
        })
    } else {
        None
    };

    Ok((region, finding))
}

/// Fixed-pitch glyph count for a word of the given pixel width (monospace
/// assumption: each glyph is [`GLYPH_W`] wide with a one-pixel gap).
fn glyph_count_for_width(width: u32) -> u32 {
    (width + (GLYPH_PITCH - GLYPH_W)) / GLYPH_PITCH
}

fn build_candidate_text(best_chars: &[Option<char>]) -> Option<String> {
    if best_chars.iter().all(Option::is_none) {
        return None;
    }
    Some(
        best_chars
            .iter()
            .map(|slot| slot.unwrap_or('?'))
            .collect::<String>(),
    )
}

/// Return the best-matching reference character and its Hamming distance.
fn match_glyph(pattern: u32) -> (char, u32) {
    let mut best_char = FONT[0].0;
    let mut best_distance = u32::MAX;
    for (character, rows) in FONT {
        let candidate = glyph_pattern(rows);
        let distance = (pattern ^ candidate).count_ones();
        if distance < best_distance {
            best_distance = distance;
            best_char = *character;
        }
    }
    (best_char, best_distance)
}

/// Pack a font glyph's 7x5 rows into a 35-bit pattern (row-major, MSB first).
fn glyph_pattern(rows: &[u8; 7]) -> u32 {
    let mut pattern = 0u32;
    for row in rows {
        pattern = (pattern << GLYPH_W) | u32::from(row & 0b1_1111);
    }
    pattern
}

/// A decoded 8-bit grayscale image, row-major.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrayImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl GrayImage {
    fn pixel(&self, x: u32, y: u32) -> u8 {
        self.pixels[(y * self.width + x) as usize]
    }

    fn is_ink(&self, x: u32, y: u32) -> bool {
        self.pixel(x, y) < INK_THRESHOLD
    }

    /// Row-major grayscale bytes of a sub-rectangle (clamped to the image).
    fn crop_bytes(&self, x: u32, y: u32, width: u32, height: u32) -> Vec<u8> {
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
    fn sample_glyph(&self, x: u32, y: u32) -> u32 {
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

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// Encode an 8-bit grayscale image as an uncompressed (stored-deflate) PNG.
pub fn encode_grayscale_png(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    assert_eq!(
        pixels.len(),
        (width * height) as usize,
        "pixel buffer must be width*height"
    );
    // Raw scanlines: a leading filter byte (0 = None) per row.
    let mut raw = Vec::with_capacity((height * (width + 1)) as usize);
    for row in 0..height {
        raw.push(0);
        let start = (row * width) as usize;
        raw.extend_from_slice(&pixels[start..start + width as usize]);
    }

    let mut out = Vec::new();
    out.extend_from_slice(&PNG_SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // depth=8, grayscale, deflate, filter0, no interlace
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &zlib_store(&raw));
    write_chunk(&mut out, b"IEND", &[]);
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// Wrap `data` in a zlib stream made only of stored (uncompressed) deflate
/// blocks.
fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01]; // CMF/FLG, (0x7801 % 31 == 0)
    let mut offset = 0usize;
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    }
    while offset < data.len() {
        let len = (data.len() - offset).min(0xffff);
        let final_block = offset + len >= data.len();
        out.push(u8::from(final_block));
        out.extend_from_slice(&(len as u16).to_le_bytes());
        out.extend_from_slice(&(!(len as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + len]);
        offset += len;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

/// Decode a stored-deflate 8-bit grayscale PNG. Returns `Err` for any other
/// PNG shape (this prototype does not decode compressed retail images).
pub fn decode_grayscale_png(bytes: &[u8]) -> KaifuuResult<GrayImage> {
    if bytes.len() < 8 || bytes[..8] != PNG_SIGNATURE {
        return Err("asset-ocr: not a PNG (bad signature)".into());
    }
    let mut cursor = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut idat = Vec::new();
    let mut saw_ihdr = false;
    while cursor + 8 <= bytes.len() {
        let length = u32::from_be_bytes(read4(bytes, cursor)?) as usize;
        let kind = &bytes[cursor + 4..cursor + 8];
        let data_start = cursor + 8;
        let data_end = data_start
            .checked_add(length)
            .filter(|end| *end + 4 <= bytes.len())
            .ok_or("asset-ocr: truncated PNG chunk")?;
        let data = &bytes[data_start..data_end];
        match kind {
            b"IHDR" => {
                if data.len() != 13 {
                    return Err("asset-ocr: malformed IHDR".into());
                }
                width = u32::from_be_bytes(read4(data, 0)?);
                height = u32::from_be_bytes(read4(data, 4)?);
                if data[8] != 8 || data[9] != 0 {
                    return Err("asset-ocr: only 8-bit grayscale PNG fixtures are supported".into());
                }
                saw_ihdr = true;
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        cursor = data_end + 4; // skip trailing CRC
    }
    if !saw_ihdr {
        return Err("asset-ocr: PNG missing IHDR".into());
    }
    let raw = zlib_inflate_stored(&idat)?;
    unfilter_grayscale(width, height, &raw)
}

fn zlib_inflate_stored(stream: &[u8]) -> KaifuuResult<Vec<u8>> {
    if stream.len() < 2 {
        return Err("asset-ocr: truncated zlib stream".into());
    }
    let mut cursor = 2usize; // skip CMF/FLG
    let mut out = Vec::new();
    loop {
        if cursor >= stream.len() {
            return Err("asset-ocr: truncated deflate stream".into());
        }
        let header = stream[cursor];
        cursor += 1;
        let final_block = header & 0x01 != 0;
        let btype = (header >> 1) & 0x03;
        if btype != 0 {
            return Err(
                "asset-ocr: only stored (uncompressed) deflate blocks are supported".into(),
            );
        }
        if cursor + 4 > stream.len() {
            return Err("asset-ocr: truncated stored-block header".into());
        }
        let len = u16::from_le_bytes([stream[cursor], stream[cursor + 1]]) as usize;
        cursor += 4; // LEN + NLEN
        if cursor + len > stream.len() {
            return Err("asset-ocr: stored block runs past end".into());
        }
        out.extend_from_slice(&stream[cursor..cursor + len]);
        cursor += len;
        if final_block {
            break;
        }
    }
    Ok(out)
}

fn unfilter_grayscale(width: u32, height: u32, raw: &[u8]) -> KaifuuResult<GrayImage> {
    let stride = width as usize + 1;
    if raw.len() != stride * height as usize {
        return Err("asset-ocr: decoded byte length does not match dimensions".into());
    }
    let w = width as usize;
    let mut pixels = vec![0u8; w * height as usize];
    for row in 0..height as usize {
        let filter = raw[row * stride];
        let filt = &raw[row * stride + 1..row * stride + 1 + w];
        for col in 0..w {
            let a = if col > 0 {
                pixels[row * w + col - 1]
            } else {
                0
            };
            let b = if row > 0 {
                pixels[(row - 1) * w + col]
            } else {
                0
            };
            let c = if row > 0 && col > 0 {
                pixels[(row - 1) * w + col - 1]
            } else {
                0
            };
            let value = match filter {
                0 => filt[col],
                1 => filt[col].wrapping_add(a),
                2 => filt[col].wrapping_add(b),
                3 => filt[col].wrapping_add(((u16::from(a) + u16::from(b)) / 2) as u8),
                4 => filt[col].wrapping_add(paeth(a, b, c)),
                other => return Err(format!("asset-ocr: unsupported PNG filter {other}").into()),
            };
            pixels[row * w + col] = value;
        }
    }
    Ok(GrayImage {
        width,
        height,
        pixels,
    })
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i32::from(a) + i32::from(b) - i32::from(c);
    let pa = (p - i32::from(a)).abs();
    let pb = (p - i32::from(b)).abs();
    let pc = (p - i32::from(c)).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn read4(bytes: &[u8], offset: usize) -> KaifuuResult<[u8; 4]> {
    bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| "asset-ocr: unexpected end of bytes".into())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in data {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
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
mod tests {
    use super::*;

    fn reference_report() -> AssetOcrReport {
        run_asset_ocr(AssetOcrRequest {
            asset_bytes: &render_reference_title_card(),
            asset_name: "title-card.png",
        })
        .expect("reference title card decodes")
    }

    #[test]
    fn committed_public_fixture_png_matches_renderer_bytes() {
        // The public fixture PNG is byte-pinned to `render_reference_title_card`.
        // Set KAIFUU_026_REGEN=1 to (re)write it after an intentional change.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/public/ocr-ui/title-card.png");
        let rendered = render_reference_title_card();
        if std::env::var_os("KAIFUU_026_REGEN").is_some() {
            std::fs::write(&path, &rendered).expect("regen png");
        }
        let committed = std::fs::read(&path).expect("committed fixture png");
        assert_eq!(
            committed, rendered,
            "committed OCR fixture PNG drifted from the renderer; regen with KAIFUU_026_REGEN=1"
        );
    }

    #[test]
    fn png_round_trips_through_the_stored_codec() {
        let png = render_reference_title_card();
        let image = decode_grayscale_png(&png).expect("decode");
        assert_eq!(image.width, 50);
        assert_eq!(image.height, 43);
        // Re-encoding the decoded pixels is byte-identical (determinism).
        let reencoded = encode_grayscale_png(image.width, image.height, &image.pixels);
        assert_eq!(reencoded, png);
    }

    #[test]
    fn detects_five_regions_in_scan_order() {
        let report = reference_report();
        let ids: Vec<&str> = report
            .text_regions
            .iter()
            .map(|region| region.region_id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "region-0001",
                "region-0002",
                "region-0003",
                "region-0004",
                "region-0005"
            ]
        );
    }

    #[test]
    fn confident_regions_recover_exact_text() {
        let report = reference_report();
        let recovered: Vec<String> = report
            .confident_regions()
            .map(|region| region.recognition.recovered_text.clone().unwrap())
            .collect();
        assert_eq!(recovered, ["NEW", "GAME", "LOAD"]);
        for region in report.confident_regions() {
            assert!(!region.recognition.is_uncertain);
            assert_eq!(region.recognition.confidence, OcrConfidence::High);
            // A confident region is NEVER surfaced as a finding.
            assert!(report.finding(&region.region_id).is_none());
        }
    }

    #[test]
    fn uncertain_ocr_becomes_a_finding_not_truth() {
        // The corrupted "LOAD" (region-0004) is a plausible read, but because it
        // is not an EXACT glyph match the region must NOT assert recovered text;
        // instead it is a finding whose candidate is explicitly evidence-only.
        let report = reference_report();
        let region = report
            .text_regions
            .iter()
            .find(|region| region.region_id == "region-0004")
            .expect("corrupted region present");
        assert!(
            region.recognition.recovered_text.is_none(),
            "uncertain OCR must not be asserted as recovered text"
        );
        assert!(region.recognition.is_uncertain);

        let finding = report
            .finding("region-0004")
            .expect("uncertain region is surfaced as a finding");
        assert_eq!(finding.code, "uncertain_text_region");
        assert_eq!(finding.severity, PartialDiagnosticSeverity::P2);
        // The candidate carries provenance + confidence (its "source") and is a
        // labelled candidate — never promoted to recovered_text / truth.
        assert_eq!(finding.source.candidate_text.as_deref(), Some("LOAD"));
        assert!(finding.source.confidence_score > 0.0);
        assert_eq!(finding.source.provenance.width, region.provenance.width);

        // The confident "LOAD" (region-0003) proves the SAME text CAN be truth
        // when the read is exact — so the difference is confidence, not vocab.
        let confident = report
            .text_regions
            .iter()
            .find(|region| region.region_id == "region-0003")
            .unwrap();
        assert_eq!(
            confident.recognition.recovered_text.as_deref(),
            Some("LOAD")
        );
        assert!(report.finding("region-0003").is_none());
    }

    #[test]
    fn noise_block_is_an_unrecognized_finding() {
        let report = reference_report();
        let finding = report
            .finding("region-0005")
            .expect("noise block is a finding");
        assert_eq!(finding.code, "unrecognized_region");
        assert!(finding.source.candidate_text.is_none());
        assert_eq!(finding.source.confidence, OcrConfidence::Low);
    }

    #[test]
    fn regions_and_glyph_cells_carry_stable_content_hashes() {
        let report = reference_report();
        for region in &report.text_regions {
            assert!(region.content_hash.as_str().starts_with("sha256:"));
            assert_eq!(
                region.provenance.asset_content_hash,
                report.asset.content_hash
            );
            for cell in &region.recognition.glyph_cells {
                assert!(cell.content_hash.as_str().starts_with("sha256:"));
                assert_eq!(cell.width, GLYPH_W);
                assert_eq!(cell.height, GLYPH_H);
            }
        }
        // Determinism: two runs produce byte-identical JSON.
        let a = reference_report().stable_json().unwrap();
        let b = reference_report().stable_json().unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn finding_count_matches_uncertain_regions() {
        let report = reference_report();
        let uncertain = report
            .text_regions
            .iter()
            .filter(|region| region.recognition.is_uncertain)
            .count();
        assert_eq!(report.findings.len(), uncertain);
        assert_eq!(report.findings.len(), 2);
    }
}
