//! Real-bytes integration tests for the g00 image-format
//! decoder.
//!
//! Pins the decoder against the primary_corpus HD `$GAME/REALLIVEDATA/g00/`
//! corpus (2,450 files) following the same inventory-backed pattern as
//! `decompressor_real_bytes.rs` / `scene_header_real_bytes.rs`: the
//! tests are feature-gated and only run when the `reallive/1/encrypted`
//! private-inventory row resolves (see `tests/engine_port_real_bytes.rs` for
//! the canonical pattern).
//!
//! # Acceptance criteria pinned here
//!
//! 1. `g00_type0_back_decodes` — primary_corpus HD's
//!    `$GAME/REALLIVEDATA/g00/BACK.g00` (type 0) decodes with non-zero
//!    width, a typed pixel buffer whose length equals
//!    `width * height * 4`, and a first pixel whose RGBA bytes do not
//!    silently match the on-disk byte order (i.e. the BGRA->RGBA
//!    reorder fired). The exact pixel value depends on the LZSS
//!    variant the corpus actually uses; the test pins the structural
//!    acceptance and surfaces the LZSS-variant identification as a
//!    typed warning rather than a hard failure (the warning is the
//!    audit-traceable surface for the
//!    "LZSS distance encoding regression" audit-focus item).
//! 2. `g00_corpus_histogram_real_bytes_2450_files` — directory-wide
//!    histogram across all 2,450 `.g00` files emits a typed
//!    `G00CorpusHistogram` and a `Vec<G00Warning>` containing one
//!    `NoTypeNInCorpus` entry per documented type that is absent in
//!    the corpus.
//! 3. `g00_type2_btn000_decodes_header_and_regions` — primary_corpus HD's
//!    `$GAME/REALLIVEDATA/g00/btn000.g00` (type 2) decodes its
//!    header + region table cleanly. The region rectangles must be
//!    non-degenerate so the `objLoadRegion` opcode at can
//!    consume them.
//!
//! # Multi-game validation status
//!
//! A parser that targets a real engine substrate must be exercised against at
//! least two real corpora before an engine-family support claim. primary_corpus HD is the only
//! RealLive title currently staged. The g00 module mirrors the pattern
//! its sibling parsers landed: real-bytes pinned
//! against the only staged corpus today, with the second-corpus
//! follow-up tracked as a known gap. The commit message records the
//! single-corpus posture explicitly.

#[path = "../support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    G00_TYPE_PALETTED_LZSS, G00_TYPE_RAW_BGR, G00_TYPE_REGIONED_LZSS, G00CorpusHistogram, G00Type,
    G00Warning, decode_g00, probe_g00_pattern_geometry, validate_g00_lzss_content,
};

// Relative path under the primary_corpus HD extraction root to the
// `g00` directory.

/// File name of the type-0 BACK.g00 image pinned by the
/// acceptance criterion.
const PRIMARY_CORPUS_TYPE0_BACK_FILENAME: &str = "BACK.g00";

/// File name of a type-2 region-table image used for the
/// header/region-table real-bytes pin. `btn000.g00` is the
/// alphabetically first type-2 file in the corpus.
const PRIMARY_CORPUS_TYPE2_BTN_FILENAME: &str = "btn000.g00";

/// Expected number of `.g00` files in the primary_corpus HD corpus (pinned by
/// the acceptance block).
const PRIMARY_CORPUS_G00_CORPUS_SIZE: u64 = 2450;

/// Documented BACK.g00 canvas dimensions (header bytes 1-4 LE).
const PRIMARY_CORPUS_BACK_WIDTH: u32 = 1280;
const PRIMARY_CORPUS_BACK_HEIGHT: u32 = 720;

/// Resolve the primary g00 directory through its private-inventory identity.
/// Returns `None` when that row is unavailable so each test can fail loudly.
fn real_g00_dir() -> Option<PathBuf> {
    real_corpus::g00_dir_for(real_corpus::PRIMARY)
}

/// Coherent-image threshold: mean absolute difference between
/// vertically-adjacent pixel rows (RGB channels). Real decoded art sits
/// well below this (photographic backgrounds ≈ 4–6); the pre-fix garbage
/// decode measured ≈ 77 (indistinguishable from random ≈ 85), so this
/// bound makes it impossible for garbage to masquerade as a valid
/// decode. A handful of intrinsically high-frequency assets (a literal
/// `NOISE.g00`, alpha masks) legitimately exceed this — the corpus test
/// asserts a robust *median* and a high coherent-fraction rather than a
/// hard per-file cap so those real assets are not false failures.
const COHERENT_ROW_MAD_MAX: f64 = 20.0;

/// Mean absolute difference between vertically-adjacent rows over the
/// RGB channels of an RGBA buffer. A structural coherence proxy: garbage
/// decodes have no vertical correlation (~77+), real images do (≪ 20).
fn vertical_row_mad(rgba: &[u8], width: usize, height: usize) -> f64 {
    if height < 2 || width == 0 {
        return 0.0;
    }
    let stride = width * 4;
    let mut sum = 0u64;
    let mut n = 0u64;
    for row in 1..height {
        for col in 0..width {
            for ch in 0..3 {
                let a = rgba[row * stride + col * 4 + ch] as i32;
                let b = rgba[(row - 1) * stride + col * 4 + ch] as i32;
                sum += (a - b).unsigned_abs() as u64;
                n += 1;
            }
        }
    }
    sum as f64 / n as f64
}

#[path = "coherence.rs"]
mod coherence;
#[path = "histogram.rs"]
mod histogram;
#[path = "strict.rs"]
mod strict;
#[path = "type0.rs"]
mod type0;
