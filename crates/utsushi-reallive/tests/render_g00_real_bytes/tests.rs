use super::synthetic::{run_synthetic_skip_surface_proof, run_synthetic_warning_surface_proof};
use super::title::run_title_render_proof;
use super::*;

#[test]
#[ignore = "real-bytes; requires private inventory row reallive/1/encrypted (title 1)"]
fn render_pass_applies_state_and_rasterises_g00_title1_real_bytes() {
    let Some(g00_dir) = real_corpus::g00_dir_for(real_corpus::PRIMARY) else {
        real_corpus::require_real_bytes(
            "utsushi-reallive render_pass_applies_state_and_rasterises_g00_title1_real_bytes",
        );
        return;
    };
    run_title_render_proof(g00_dir, "title1");
}

#[test]
#[ignore = "real-bytes; requires private inventory row reallive/2/plain (title 2)"]
fn render_pass_applies_state_and_rasterises_g00_title2_real_bytes() {
    let Some(g00_dir) = real_corpus::g00_dir_for(real_corpus::SECONDARY) else {
        real_corpus::require_real_bytes(
            "utsushi-reallive render_pass_applies_state_and_rasterises_g00_title2_real_bytes (title 2 / reallive/2/plain)",
        );
        return;
    };
    run_title_render_proof(g00_dir, "title2");
}

/// Honest-fail-soft proof, enforced continuously in `just ci`.
///
/// This is deliberately NOT `#[ignore]`-gated and needs no real corpus:
/// the undecodable asset is a SYNTHETIC malformed g00 (see
/// [`malformed_type0_g00`]) injected through the ordinary on-disk asset
/// seam. Keeping it in the default test set means the "an emit that
/// dropped an undecodable object must report the skip, not fake success"
/// invariant can never silently regress behind an `--ignored` gate again
/// (the original real-corpus variant went RED — and unnoticed — the moment
/// the g00 decoder was fixed and every corpus g00 started decoding).
#[test]
fn emit_scene_reports_skip_for_undecodable_synthetic_g00() {
    run_synthetic_skip_surface_proof();
}

/// A best-effort decoder warning must be just as non-final as a hard skip.
#[test]
fn emit_scene_reports_warning_for_short_synthetic_g00() {
    run_synthetic_warning_surface_proof();
}
