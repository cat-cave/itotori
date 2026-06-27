//! UTSUSHI-214 integration tests for the graphics object stack and the
//! headless render pipeline.
//!
//! Two named entrypoints match the verification commands pinned in the
//! UTSUSHI-214 spec node:
//!
//! - `cargo test -p utsushi-reallive graphics_object_stack_256_objects`
//! - `cargo test -p utsushi-reallive render_wipe_solid_colour_deterministic_png`
//!
//! Both tests are synthetic per the spec note that "Synthetic fixture
//! acceptable for the stack mechanics; the render pass against a real
//! g00 sprite requires UTSUSHI-146q to land first and is gated as a
//! follow-up test." A third entrypoint
//! (`graphics_pipeline_honours_sweetie_hd_gameexe_screen_size`) is
//! env-gated on `ITOTORI_REAL_GAME_ROOT` and pins the real-bytes
//! `SCREENSIZE_MOD=999,1280,720` round-trip through
//! [`utsushi_reallive::SyscallDispatcher::screen_size`] +
//! [`utsushi_reallive::RenderPass::new`].

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use utsushi_reallive::{
    GRAPHICS_OBJECT_SLOT_COUNT, Gameexe, GraphicsObject, GraphicsObjectStack, GraphicsPlane,
    GraphicsStackError, PNG_FILE_MAGIC, RGBA_BYTES_PER_PIXEL, RenderPass, SyscallDispatcher,
    WipeColour,
};

/// Default name of the Sweetie HD title directory inside the
/// extraction root. Mirrors the existing
/// `gameexe_real_bytes.rs` / `syscall_routes_real_sweetie_hd.rs`
/// constant.

/// Acceptance: allocating 256 objects on a single plane succeeds; the
/// 257th allocation on that plane is typed-rejected; populating the
/// 256-slot fg and bg planes together yields `stack.len() == 512`.
#[test]
fn graphics_object_stack_256_objects() {
    let mut stack = GraphicsObjectStack::new();
    assert_eq!(stack.len(), 0);

    // Fill the foreground plane.
    for slot in 0..GRAPHICS_OBJECT_SLOT_COUNT {
        let mut object = GraphicsObject::image(format!("fg-asset-{slot}"));
        object.layer_order = slot as i32;
        stack
            .set(GraphicsPlane::Foreground, slot, object)
            .expect("foreground slot in range");
    }
    assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 256);
    assert_eq!(stack.plane_len(GraphicsPlane::Background), 0);
    assert_eq!(stack.len(), 256);

    // The 257th allocation on the foreground plane is rejected.
    let overflow = stack.set(
        GraphicsPlane::Foreground,
        GRAPHICS_OBJECT_SLOT_COUNT,
        GraphicsObject::image("overflow"),
    );
    assert_eq!(
        overflow,
        Err(GraphicsStackError::SlotOutOfRange {
            plane: GraphicsPlane::Foreground,
            slot: GRAPHICS_OBJECT_SLOT_COUNT,
        }),
        "stack must reject slot >= 256"
    );

    // Populate the background plane independently and assert the total.
    for slot in 0..GRAPHICS_OBJECT_SLOT_COUNT {
        stack
            .set(
                GraphicsPlane::Background,
                slot,
                GraphicsObject::image(format!("bg-asset-{slot}")),
            )
            .expect("background slot in range");
    }
    assert_eq!(stack.plane_len(GraphicsPlane::Background), 256);
    assert_eq!(stack.len(), 512);

    // Per-slot position assignment is preserved.
    let object = stack
        .get_mut(GraphicsPlane::Foreground, 17)
        .expect("slot 17 populated");
    object.position.x = 320;
    object.position.y = 240;
    let reread = stack
        .get(GraphicsPlane::Foreground, 17)
        .expect("slot 17 still populated");
    assert_eq!(reread.position.x, 320);
    assert_eq!(reread.position.y, 240);

    // Acceptance criterion: render walks the populated stack to produce
    // a deterministic PNG. The fg/bg planes carry image-backed objects
    // (which are recorded but not yet rasterised at UTSUSHI-214; the
    // render pass simply returns the initial framebuffer).
    let mut pass = RenderPass::with_dimensions(1280, 720).expect("non-zero screen");
    let emission_a = pass.render(&stack);
    let emission_b = pass.render(&stack);
    // Same state → same artifact_id (deterministic SHA-256 of bytes).
    assert_eq!(emission_a.artifact_id, emission_b.artifact_id);
    assert_eq!(emission_a.width, 1280);
    assert_eq!(emission_a.height, 720);
    let bytes = pass
        .artifact_store()
        .get(&emission_a.artifact_id)
        .expect("artifact retained");
    assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
}

/// Acceptance: a wipe object (full-screen colour) renders to a
/// solid-colour PNG matching the documented colour byte order, and
/// two render passes with the same state produce byte-identical PNGs.
#[test]
fn render_wipe_solid_colour_deterministic_png() {
    // Sweetie HD-shaped framebuffer dimensions
    // (`SCREENSIZE_MOD=999,1280,720`).
    let mut pass_a = RenderPass::with_dimensions(1280, 720).expect("non-zero screen");
    let mut pass_b = RenderPass::with_dimensions(1280, 720).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    let teal = WipeColour::opaque_rgb(0x10, 0x80, 0x80);
    stack
        .set(GraphicsPlane::Foreground, 0, GraphicsObject::wipe(teal))
        .expect("set wipe");

    let emission_a = pass_a.render(&stack);
    let emission_b = pass_b.render(&stack);

    // The two passes must produce the **same** artifact_id (and
    // therefore the same PNG bytes) on identical input state — pinned
    // for the "byte-identical across runs" acceptance criterion.
    assert_eq!(emission_a.artifact_id, emission_b.artifact_id);
    let bytes_a = pass_a
        .artifact_store()
        .get(&emission_a.artifact_id)
        .expect("retained a");
    let bytes_b = pass_b
        .artifact_store()
        .get(&emission_b.artifact_id)
        .expect("retained b");
    assert_eq!(bytes_a, bytes_b);
    assert_eq!(&bytes_a[..8], &PNG_FILE_MAGIC);

    // Framebuffer-level pin: every pixel must be (R, G, B, A) in RGBA
    // order, matching the documented colour byte order.
    let fb = pass_a.rasterise(&stack);
    assert_eq!(fb.width(), 1280);
    assert_eq!(fb.height(), 720);
    assert_eq!(
        fb.pixels().len(),
        1280usize * 720usize * RGBA_BYTES_PER_PIXEL
    );
    let expected = [teal.red, teal.green, teal.blue, teal.alpha];
    for (offset, chunk) in fb.pixels().chunks(4).enumerate() {
        assert_eq!(
            chunk, &expected,
            "pixel {offset} does not carry RGBA in the documented byte order"
        );
    }

    // Frame artifact metadata pins.
    assert_eq!(emission_a.frame_index, 0);
    assert_eq!(
        emission_a.evidence_tier,
        utsushi_core::substrate::EvidenceTier::E1,
        "UTSUSHI-214 spec pins evidence_tier=E1"
    );
    assert_eq!(emission_a.artifact_kind, "frame_capture");

    // Different state → different artifact_id (sanity check that the
    // determinism contract is one-way; identical state must not be
    // accidentally collapsed to the same id as different state).
    let mut other_stack = GraphicsObjectStack::new();
    other_stack
        .set(
            GraphicsPlane::Foreground,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0xFE, 0xFE, 0xFE)),
        )
        .expect("set wipe");
    let other = pass_a.render(&other_stack);
    assert_ne!(other.artifact_id, emission_a.artifact_id);
}

/// Real-bytes pin (env-gated): with the Sweetie HD `Gameexe.ini`
/// loaded, [`utsushi_reallive::SyscallDispatcher::screen_size`] reports
/// `width=1280, height=720`, and [`utsushi_reallive::RenderPass::new`]
/// honours those dimensions verbatim. Pin for the
/// "render pass observes the `SCREENSIZE_MOD=999,1280,720` Gameexe
/// value and emits a 1280x720 buffer" acceptance criterion.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT; opt in with --include-ignored"]
fn graphics_pipeline_honours_sweetie_hd_gameexe_screen_size() {
    let Some(gameexe_path) = real_gameexe_ini_path() else {
        eprintln!(
            "ITOTORI_REAL_GAME_ROOT not set — graphics_pipeline_honours_sweetie_hd_gameexe_screen_size \
             skipped (run with --include-ignored to enable)"
        );
        return;
    };
    let bytes = fs::read(&gameexe_path).expect("Sweetie HD Gameexe.ini readable");
    let gameexe = Gameexe::parse(&bytes).expect("Sweetie HD Gameexe.ini parses");
    let dispatcher = SyscallDispatcher::from_gameexe(&gameexe).expect("dispatcher builds");
    let screen_size = dispatcher
        .screen_size()
        .expect("Sweetie HD declares SCREENSIZE_MOD=999,1280,720");
    assert_eq!(screen_size.mode, 999);
    assert_eq!(screen_size.width, 1280);
    assert_eq!(screen_size.height, 720);

    let mut pass = RenderPass::new(screen_size).expect("non-zero screen");
    assert_eq!(pass.width(), 1280);
    assert_eq!(pass.height(), 720);

    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Foreground,
            0,
            GraphicsObject::wipe(WipeColour::BLACK),
        )
        .expect("set wipe");
    let emission = pass.render(&stack);
    assert_eq!(emission.width, 1280);
    assert_eq!(emission.height, 720);
    let bytes = pass
        .artifact_store()
        .get(&emission.artifact_id)
        .expect("retained");
    // PNG IHDR at bytes 16..24 carries width/height big-endian.
    assert_eq!(&bytes[16..20], &1280u32.to_be_bytes());
    assert_eq!(&bytes[20..24], &720u32.to_be_bytes());
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}
