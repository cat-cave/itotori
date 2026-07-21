//! Integration tests for the graphics object stack and the
//! headless render pipeline.
//!
//! Two named entrypoints match the verification commands for this module:
//!
//! - `cargo test -p utsushi-reallive graphics_object_stack_256_objects`
//! - `cargo test -p utsushi-reallive render_wipe_solid_colour_deterministic_png`
//!
//! Both tests cover synthetic stack mechanics. The env-gated
//! `g00_real_bytes.rs` and `render_g00_real_bytes.rs` suites cover real g00
//! decoding and rendering. A third entrypoint
//! (`graphics_pipeline_honours_reallive_real_bytes_gameexe_screen_size`) is
//! env-gated on `ITOTORI_REAL_GAME_ROOT` and pins the real-bytes
//! `SCREENSIZE_MOD=999,1280,720` round-trip through
//! [`utsushi_reallive::SyscallDispatcher::screen_size`]
//! [`utsushi_reallive::RenderPass::new`].

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::EvidenceTier;
use utsushi_reallive::{
    GRAPHICS_OBJECT_SLOT_COUNT, Gameexe, GraphicsObject, GraphicsObjectStack, GraphicsPlane,
    GraphicsStackError, PNG_FILE_MAGIC, RGBA_BYTES_PER_PIXEL, RecordingFrameArtifactSink,
    RenderPass, SyscallDispatcher, TextLayer, WipeColour,
};

/// Unique managed runtime-artifact root under the process temp dir.
fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-graphics-stack-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    let root = RuntimeArtifactRoot::new(&dir);
    root.prepare().expect("prepare managed artifact root");
    root
}

// Default name of the Sweetie HD title directory inside the
// extraction root. Mirrors the existing
// `gameexe_real_bytes.rs` / `syscall_routes_real_bytes.rs`
// constant.

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

    // Acceptance criterion: render walks the populated stack and emits a
    // deterministic PNG through the substrate frame sink. The fg/bg
    // planes carry image-backed objects, which are recorded but NEVER
    // dereferenced into the framebuffer (copyright redaction).
    let mut pass = RenderPass::with_dimensions(1280, 720).expect("non-zero screen");
    let text = TextLayer::localized(vec!["ALPHA".to_string()]);
    let root = temp_artifact_root("stack-256");
    let sink = RecordingFrameArtifactSink::new();
    let a = pass
        .emit_localized_screenshot(&stack, &text, &root, "stack-256", &sink)
        .expect("emit a");
    let b = pass
        .emit_localized_screenshot(&stack, &text, &root, "stack-256", &sink)
        .expect("emit b");
    // Same state → same artifact_id (deterministic SHA-256 of bytes).
    assert_eq!(a.artifact_ref.artifact_id, b.artifact_ref.artifact_id);
    assert_eq!(a.width, Some(1280));
    assert_eq!(a.height, Some(720));
    assert_eq!(a.evidence_tier, EvidenceTier::E2);
    let bytes = fs::read(
        root.artifact_path(&a.artifact_ref.uri)
            .expect("artifact path"),
    )
    .expect("png on disk");
    assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
    let _ = fs::remove_dir_all(root.path());
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

    let text = TextLayer::localized(vec!["WIPE".to_string()]);
    let root_a = temp_artifact_root("wipe-a");
    let root_b = temp_artifact_root("wipe-b");
    let sink_a = RecordingFrameArtifactSink::new();
    let sink_b = RecordingFrameArtifactSink::new();
    let emission_a = pass_a
        .emit_localized_screenshot(&stack, &text, &root_a, "wipe", &sink_a)
        .expect("emit a");
    let emission_b = pass_b
        .emit_localized_screenshot(&stack, &text, &root_b, "wipe", &sink_b)
        .expect("emit b");

    // The two passes must produce the **same** artifact_id (and
    // therefore the same PNG bytes) on identical input state — pinned
    // for the "byte-identical across runs" acceptance criterion.
    assert_eq!(
        emission_a.artifact_ref.artifact_id,
        emission_b.artifact_ref.artifact_id
    );
    let bytes_a = fs::read(
        root_a
            .artifact_path(&emission_a.artifact_ref.uri)
            .expect("path a"),
    )
    .expect("retained a");
    let bytes_b = fs::read(
        root_b
            .artifact_path(&emission_b.artifact_ref.uri)
            .expect("path b"),
    )
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

    // Frame artifact metadata pins: announced at the substrate E2 floor
    // as a `screenshot` artifact.
    assert_eq!(emission_a.frame_index, 0);
    assert_eq!(
        emission_a.evidence_tier,
        EvidenceTier::E2,
        "ALPHA-006b emits through the substrate frame sink at E2"
    );
    assert_eq!(emission_a.artifact_ref.artifact_kind, "screenshot");
    assert_eq!(sink_a.len(), 1);

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
    let other = pass_a
        .emit_localized_screenshot(&other_stack, &text, &root_a, "wipe", &sink_a)
        .expect("emit other");
    assert_ne!(
        other.artifact_ref.artifact_id,
        emission_a.artifact_ref.artifact_id
    );
    let _ = fs::remove_dir_all(root_a.path());
    let _ = fs::remove_dir_all(root_b.path());
}

/// Real-bytes pin (env-gated): with the Sweetie HD `Gameexe.ini`
/// loaded, [`utsushi_reallive::SyscallDispatcher::screen_size`] reports
/// `width=1280, height=720`, and [`utsushi_reallive::RenderPass::new`]
/// honours those dimensions verbatim. Pin for the
/// "render pass observes the `SCREENSIZE_MOD=999,1280,720` Gameexe
/// value and emits a 1280x720 buffer" acceptance criterion.
#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT; opt in with --include-ignored"]
fn graphics_pipeline_honours_reallive_real_bytes_gameexe_screen_size() {
    let Some(gameexe_path) = real_gameexe_ini_path() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive graphics_pipeline_honours_reallive_real_bytes_gameexe_screen_size",
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
    let text = TextLayer::localized(vec!["SCREENSIZE".to_string()]);
    let root = temp_artifact_root("real-screen-size");
    let sink = RecordingFrameArtifactSink::new();
    let emission = pass
        .emit_localized_screenshot(&stack, &text, &root, "screen-size", &sink)
        .expect("emit");
    assert_eq!(emission.width, Some(1280));
    assert_eq!(emission.height, Some(720));
    let bytes = fs::read(
        root.artifact_path(&emission.artifact_ref.uri)
            .expect("path"),
    )
    .expect("retained");
    // PNG IHDR at bytes 16..24 carries width/height big-endian.
    assert_eq!(&bytes[16..20], &1280u32.to_be_bytes());
    assert_eq!(&bytes[20..24], &720u32.to_be_bytes());
    let _ = fs::remove_dir_all(root.path());
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}
