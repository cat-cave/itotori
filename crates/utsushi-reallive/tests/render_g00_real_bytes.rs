//! Real-bytes proof for the RealLive render pass: graphics-object-state
//! application (Node `utsushi-graphics-object-state-applied`) and real
//! g00 rasterisation + emit-boundary redaction (Node
//! `reallive-render-rasterize-g00-real`).
//!
//! These tests decode REAL g00 art from a staged RealLive corpus and
//! composite it through [`RenderPass`], then assert PIXEL-CATEGORY
//! INVARIANTS only — never an embedded/committed real-art pixel value.
//! They are `#[ignore]`-gated and env-driven, following the crate's
//! real-bytes convention:
//!
//! - `ITOTORI_REAL_GAME_ROOT` — title 1 (Sweetie HD).
//! - `ITOTORI_REAL_GAME_ROOT_2` — title 2 (Kanon).
//!
//! The full-fidelity (real-art) frame is written ONLY to a private
//! uncommitted path under the repo's gitignored `/.private-render/`
//! directory (which lives under `/scratch`); the public frame is
//! redacted by default. No test embeds or asserts a real-art pixel
//! value.

#[path = "support/real_corpus.rs"]
mod real_corpus;
include!("render_g00_real_bytes_parts/001.rs");
include!("render_g00_real_bytes_parts/002.rs");
include!("render_g00_real_bytes_parts/003.rs");
