//! Public-frame OCR regression tests kept separate from the renderer's
//! existing broad test module so each source file stays below the line cap.

use std::sync::atomic::{AtomicU64, Ordering};

use utsushi_core::RuntimeArtifactRoot;

use super::super::*;
use super::{RasterOcrStatus, sha256_hex};
use crate::graphics_objects::{GraphicsObject, GraphicsObjectStack, GraphicsPlane, WipeColour};

/// Unique managed artifact root under the process temp dir.
fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-render-ocr-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let root = RuntimeArtifactRoot::new(&dir);
    root.prepare().expect("prepare managed artifact root");
    root
}

fn wipe_stack(colour: WipeColour) -> GraphicsObjectStack {
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(GraphicsPlane::Foreground, 0, GraphicsObject::wipe(colour))
        .expect("set wipe");
    stack
}

#[test]
fn scene_screenshot_reads_body_ocr_back_from_written_public_png() {
    let mut pass = RenderPass::with_dimensions(192, 72).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::opaque_rgb(0x10, 0x20, 0x30));
    let text = TextLayer::localized(vec!["…Proof".to_string()]);
    let root = temp_artifact_root("public-pixel-ocr");
    let private_dir = root.path().join("private");
    let sink = RecordingFrameArtifactSink::new();

    let screenshots = pass
        .emit_scene_screenshots(
            &stack,
            &text,
            SceneEmit::frame(&root, "pixel-ocr", &sink, &private_dir, true),
        )
        .expect("emit public frame and independently read it back");

    assert_eq!(screenshots.ocr.status, RasterOcrStatus::Passed);
    assert_eq!(screenshots.ocr.text, "…Proof");
    assert_eq!(screenshots.ocr.unrecognized_glyph_count, 0);
    let public_path = root
        .artifact_path(&screenshots.public.artifact_ref.uri)
        .expect("managed public path");
    let persisted = std::fs::read(public_path).expect("emitted public PNG");
    assert_eq!(screenshots.ocr.frame_sha256, sha256_hex(&persisted));

    let _ = std::fs::remove_dir_all(root.path());
}

#[test]
fn scene_screenshot_ocr_reads_colored_body_without_conflating_name_box() {
    let mut pass = RenderPass::with_dimensions(320, 180).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::opaque_rgb(0x10, 0x20, 0x30));
    let text = TextLayer {
        lines: vec!["Audit 7.".to_string()],
        origin_x: 24,
        origin_y: 92,
        scale: 24,
        colour: WipeColour {
            red: 0xD0,
            green: 0xB0,
            blue: 0x70,
            alpha: 220,
        },
        backdrop: Some(TextBackdrop {
            x: 12,
            y: 80,
            width: 296,
            height: 76,
            colour: WipeColour {
                red: 0x20,
                green: 0x30,
                blue: 0x50,
                alpha: 190,
            },
        }),
        name_box: Some(Box::new(TextLayer {
            lines: vec!["Guide".to_string()],
            origin_x: 24,
            origin_y: 26,
            scale: 20,
            colour: WipeColour::opaque_rgb(0xD0, 0xB0, 0x70),
            backdrop: Some(TextBackdrop {
                x: 12,
                y: 16,
                width: 100,
                height: 44,
                colour: WipeColour::opaque_rgb(0x20, 0x30, 0x50),
            }),
            name_box: None,
            line_height: None,
        })),
        line_height: None,
    };
    let root = temp_artifact_root("styled-public-pixel-ocr");
    let private_dir = root.path().join("private");
    let sink = RecordingFrameArtifactSink::new();

    let screenshots = pass
        .emit_scene_screenshots(
            &stack,
            &text,
            SceneEmit::frame(&root, "styled-pixel-ocr", &sink, &private_dir, true),
        )
        .expect("emit styled public frame and read only its body text back");

    assert_eq!(screenshots.ocr.unrecognized_glyph_count, 0);
    assert_eq!(screenshots.ocr.status, RasterOcrStatus::Passed);
    assert_eq!(screenshots.ocr.text, "Audit 7.");

    let _ = std::fs::remove_dir_all(root.path());
}
