//! Real-bytes screen-size render-pipeline proof, owned by the real-bytes lane.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use utsushi_core::RuntimeArtifactRoot;
use utsushi_reallive::{
    Gameexe, GraphicsObject, GraphicsObjectStack, GraphicsPlane, RecordingFrameArtifactSink,
    RenderPass, SyscallDispatcher, TextLayer, WipeColour,
};

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

#[test]
fn graphics_pipeline_honours_reallive_real_bytes_gameexe_screen_size() {
    let Some(gameexe_path) = real_gameexe_ini_path() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive graphics_pipeline_honours_reallive_real_bytes_gameexe_screen_size",
        );
        return;
    };
    let bytes = fs::read(&gameexe_path).expect("primary_corpus HD Gameexe.ini readable");
    let gameexe = Gameexe::parse(&bytes).expect("primary_corpus HD Gameexe.ini parses");
    let dispatcher = SyscallDispatcher::from_gameexe(&gameexe).expect("dispatcher builds");
    let screen_size = dispatcher
        .screen_size()
        .expect("primary_corpus HD declares SCREENSIZE_MOD=999,1280,720");
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
    assert_eq!(&bytes[16..20], &1280u32.to_be_bytes());
    assert_eq!(&bytes[20..24], &720u32.to_be_bytes());
    let _ = fs::remove_dir_all(root.path());
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}
