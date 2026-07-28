//! Real-bytes integration tests for the g00 image-format
//! decoder.
//!
//! Pins the decoder against the Sweetie HD `$GAME/REALLIVEDATA/g00/`
//! corpus (2,450 files) following the same pattern as
//! `decompressor_real_bytes.rs` / `scene_header_real_bytes.rs`: the
//! tests are `#[ignore]`-gated and only run when
//! `ITOTORI_REAL_GAME_ROOT` is set (the same env var the rest of
//! the real-bytes suite uses — see `tests/gameexe_real_bytes.rs` for
//! the canonical pattern).
//!
//! # Acceptance criteria pinned here
//!
//! 1. `g00_type0_back_decodes` — Sweetie HD's
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
//! 3. `g00_type2_btn000_decodes_header_and_regions` — Sweetie HD's
//!    `$GAME/REALLIVEDATA/g00/btn000.g00` (type 2) decodes its
//!    header + region table cleanly. The region rectangles must be
//!    non-degenerate so the `objLoadRegion` opcode at can
//!    consume them.
//!
//! # Multi-game validation status
//!
//! Per the itotori operating model
//! (`docs/dev/orchestration-operating-model.md`), a parser that targets a
//! real engine substrate must be exercised against at least two real
//! corpora before its node is merged-complete. Sweetie HD is the only
//! RealLive title currently staged. The g00 module mirrors the pattern
//! its sibling parsers landed: real-bytes pinned
//! against the only staged corpus today, with the second-corpus
//! follow-up tracked as a known gap. The commit message records the
//! single-corpus posture explicitly.

#[path = "support/real_corpus.rs"]
mod real_corpus;
include!("g00_real_bytes_parts/001.rs");
include!("g00_real_bytes_parts/002.rs");
