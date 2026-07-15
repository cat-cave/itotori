//! Deterministic text-region detection and glyph recognition for asset OCR.
//!
//! Scans a grayscale image for word regions, Hamming-matches fixed-pitch 5x7
//! glyph cells against the reference font, and emits schema-valid regions plus
//! uncertain findings. Exact matches only become recovered text; everything else
//! is evidence.

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash, sha256_hash_bytes,
};

use super::{
    ASSET_OCR_FIXTURE_ID, ASSET_OCR_SCHEMA_VERSION, ASSET_OCR_SOURCE_NODE_ID,
    ASSET_OCR_SUPPORT_BOUNDARY, AssetOcrFinding, AssetOcrReport, AssetOcrRequest, AssetProvenance,
    FONT, FUZZY_MATCH_MAX, GLYPH_BITS, GLYPH_H, GLYPH_PITCH, GLYPH_W, GlyphCell, GrayImage,
    LINE_GAP, OcrConfidence, OcrFindingSource, OcrRecognition, RegionProvenance, TextRegion,
    WORD_GAP, decode_grayscale_png,
};

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
