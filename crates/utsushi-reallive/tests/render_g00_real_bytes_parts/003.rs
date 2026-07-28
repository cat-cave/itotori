/// True if the two framebuffers differ at any pixel inside the rect.
fn rect_differs(
    a: &utsushi_reallive::Framebuffer,
    b: &utsushi_reallive::Framebuffer,
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
) -> bool {
    for dy in 0..h {
        for dx in 0..w {
            let x = x0 + dx as i32;
            let y = y0 + dy as i32;
            if x < 0 || y < 0 || x >= a.width() as i32 || y >= a.height() as i32 {
                continue;
            }
            if pixel_at(a, x as u32, y as u32) != pixel_at(b, x as u32, y as u32) {
                return true;
            }
        }
    }
    false
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var (title 1)"]
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
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT_2 env var (title 2)"]
fn render_pass_applies_state_and_rasterises_g00_title2_real_bytes() {
    let Some(g00_dir) = real_corpus::g00_dir_for(real_corpus::SECONDARY) else {
        real_corpus::require_real_bytes(
            "utsushi-reallive render_pass_applies_state_and_rasterises_g00_title2_real_bytes (title 2 / ITOTORI_REAL_GAME_ROOT_2)",
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

