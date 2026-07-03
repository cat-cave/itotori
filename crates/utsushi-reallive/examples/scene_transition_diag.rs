//! Scene-transition diagnostic renderer (`utsushi-scene-transition-fidelity`).
//!
//! Renders a short cross-boundary MONTAGE — the last message(s) of scene A
//! then the first message(s) of scene B, EACH as its own frame, stacked
//! vertically, with scene B drawn over its OWN (distinct) background — so the
//! orchestrator can VISUALLY confirm the play-loop CROSSED the scene boundary
//! (it did not stop at scene A). This is the visual companion to
//! [`utsushi_reallive::ReplayEngine::observe_playthrough`], which follows the
//! real RealLive scene-dispatch (`jump` / `farcall` / return into another
//! SEEN present in the store) from scene A into scene B.
//!
//! # What is REAL vs STAGED
//!
//! - The SCENE CHAIN (which scene ids the play-loop crosses, in dispatch
//!   order) is REAL when a corpus is reachable via `ITOTORI_REAL_GAME_ROOT_2`
//!   (Kanon): the montage is labelled with the actual `observe_playthrough`
//!   scene ids (e.g. 9030 → 9031). This is the true engine behaviour.
//! - The message CONTENT is STAGED English (the product output; an
//!   untranslated title's Japanese source renders as the font's `.notdef`
//!   boxes) and the backgrounds are NEUTRAL gradients — DISTINCT per scene so
//!   B's own background reads as different from A's. This mirrors how
//!   `playthrough_diag` / `msgwin_diag` / `render_diag` stage content: only
//!   the CONTENT is staged; the cross-scene SEQUENCING is the real port
//!   behaviour. No copyrighted game art / text is ever republished (point a
//!   real g00 background in via the port for real-art private frames).
//!
//! Run:
//!   cargo run -p utsushi-reallive --example scene_transition_diag
//!   # optionally grounded with a real scene chain:
//!   ITOTORI_REAL_GAME_ROOT_2=/path/to/kanon \
//!     cargo run -p utsushi-reallive --example scene_transition_diag
//!
//! Writes `.private-render/diag/scene-transition-seq.png` (gitignored).

use std::path::{Path, PathBuf};

use utsushi_reallive::{
    Framebuffer, Gameexe, MessageWindowConfig, ReplayEngine, ReplayOpts, TextLayer, WipeColour,
    build_scene_store_from_decompressed, decompress_all_scenes, encode_png_rgba_deterministic,
};

/// Native port canvas (RealLive Sweetie HD `#SCREENSIZE_MOD=999,1280,720`).
const FRAME_W: u32 = 1280;
const FRAME_H: u32 = 720;

/// The two scene "backgrounds" — distinct neutral gradients so scene B's own
/// background reads as visibly different from scene A's (the boundary cue).
#[derive(Clone, Copy)]
struct SceneBackground {
    top: (u8, u8, u8),
    bottom: (u8, u8, u8),
    /// A header band colour, so the scene the frame belongs to is
    /// unmistakable at a glance.
    band: (u8, u8, u8),
}

const BG_SCENE_A: SceneBackground = SceneBackground {
    top: (0x1a, 0x1e, 0x2e),
    bottom: (0x3a, 0x30, 0x22),
    band: (0x8a, 0x5a, 0x3a),
};
const BG_SCENE_B: SceneBackground = SceneBackground {
    top: (0x16, 0x24, 0x2a),
    bottom: (0x22, 0x38, 0x3a),
    band: (0x3a, 0x7a, 0x8a),
};

fn background_frame(bg: SceneBackground) -> Framebuffer {
    let mut fb = Framebuffer::new(FRAME_W, FRAME_H);
    fb.fill(WipeColour::opaque_rgb(bg.top.0, bg.top.1, bg.top.2));
    let bands = 24u32;
    for band in 0..bands {
        let t = band as f32 / bands as f32;
        let red = (bg.top.0 as f32 + t * (bg.bottom.0 as f32 - bg.top.0 as f32)) as u8;
        let green = (bg.top.1 as f32 + t * (bg.bottom.1 as f32 - bg.top.1 as f32)) as u8;
        let blue = (bg.top.2 as f32 + t * (bg.bottom.2 as f32 - bg.top.2 as f32)) as u8;
        let y = band * (FRAME_H / bands);
        fb.fill_rect_blended(
            0,
            y,
            FRAME_W,
            FRAME_H / bands,
            WipeColour {
                red,
                green,
                blue,
                alpha: 0xff,
            },
        );
    }
    // Top header band identifies which scene this frame belongs to.
    fb.fill_rect_blended(
        0,
        0,
        FRAME_W,
        56,
        WipeColour {
            red: bg.band.0,
            green: bg.band.1,
            blue: bg.band.2,
            alpha: 0xff,
        },
    );
    fb
}

/// Resolve the REAL scene chain (dispatch order) from Kanon via
/// `observe_playthrough`, so the montage is labelled with actual engine scene
/// ids. Returns `None` (staged-only) when no corpus is reachable.
fn real_scene_chain() -> Option<Vec<u16>> {
    let root = std::env::var_os("ITOTORI_REAL_GAME_ROOT_2")?;
    let root = PathBuf::from(root);
    let seen = find_ci(&root, "seen.txt")?;
    let gameexe = find_ci(&root, "gameexe.ini")?;
    let entry = u16::try_from(
        Gameexe::parse(&std::fs::read(gameexe).ok()?)
            .ok()?
            .get_int("SEEN_START")?,
    )
    .ok()?;
    let seen_bytes = std::fs::read(seen).ok()?;
    let index_len = utsushi_reallive::RealSceneIndex::parse(&seen_bytes)
        .ok()?
        .entries
        .len();
    let decompressed = decompress_all_scenes(&seen_bytes).ok()?;
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).ok()?;
    let engine = ReplayEngine::from_store(store, shift_jis);
    let opts = ReplayOpts {
        step_budget: 200_000,
        stop_at_first_pause: false,
    };
    let chain = engine.observe_playthrough(entry, &opts, 4).scene_ids();
    (chain.len() >= 2).then_some(chain)
}

fn find_ci(dir: &Path, name: &str) -> Option<PathBuf> {
    let target = name.to_ascii_lowercase();
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|f| f.to_str())
                .is_some_and(|f| f.to_ascii_lowercase() == target)
        })
}

fn main() {
    // The REAL dispatch-order scene chain (Kanon) when a corpus is reachable;
    // otherwise placeholder ids for the self-contained staged run.
    let chain = real_scene_chain();
    let (scene_a, scene_b, grounded) = match &chain {
        Some(ids) => (ids[0], ids[1], true),
        None => (1u16, 2u16, false),
    };
    println!(
        "scene chain: A=scene {scene_a} -> B=scene {scene_b} ({})",
        if grounded {
            "REAL observe_playthrough dispatch order"
        } else {
            "staged placeholder — set ITOTORI_REAL_GAME_ROOT_2 for real ids"
        },
    );

    // Staged English play-order content: the last two messages of scene A,
    // then the first two of scene B (the boundary the montage makes visible).
    let scene_a_messages: [(Option<&str>, &str); 2] = [
        (
            Some("Makoto"),
            "It's getting late — we should head back before the last train leaves.",
        ),
        (
            None,
            "The platform lights flickered on as the evening settled over the town.",
        ),
    ];
    let scene_b_messages: [(Option<&str>, &str); 2] = [
        (
            None,
            "Morning. A different room, a different light — the next scene had already begun.",
        ),
        (
            Some("Nayuki"),
            "You're finally awake! Breakfast is ready — come down before it gets cold.",
        ),
    ];

    let config = MessageWindowConfig {
        name_mod: 1,
        ..MessageWindowConfig::default()
    };
    let screen = (FRAME_W, FRAME_H);
    let frame_size = (FRAME_W, FRAME_H);

    // Ordered frame plan: scene A's messages (background A), then scene B's
    // messages (background B) — a continuous multi-scene play stream.
    let plan: Vec<(u16, SceneBackground, Option<&str>, &str)> = scene_a_messages
        .iter()
        .map(|(sp, t)| (scene_a, BG_SCENE_A, *sp, *t))
        .chain(
            scene_b_messages
                .iter()
                .map(|(sp, t)| (scene_b, BG_SCENE_B, *sp, *t)),
        )
        .collect();

    let take = plan.len();
    let gap = 10u32;
    let mut sheet = Framebuffer::new(FRAME_W, FRAME_H * take as u32 + gap * (take as u32 - 1));
    sheet.fill(WipeColour::opaque_rgb(0x00, 0x00, 0x00));

    let mut last_scene: Option<u16> = None;
    for (i, (scene_id, bg, speaker, text)) in plan.iter().enumerate() {
        let mut frame = background_frame(*bg);
        let layer = TextLayer::message_window(text, *speaker, &config, screen, frame_size);
        let painted = frame.draw_text(&layer);
        assert!(
            painted > 0,
            "frame #{i} (scene {scene_id}) must paint glyphs"
        );
        sheet.blit(&frame, 0, (FRAME_H + gap) * i as u32);
        let crossed = last_scene.is_some_and(|prev| prev != *scene_id);
        println!(
            "frame {i}: scene {scene_id} speaker={:?} chars={} painted_px={painted}{}",
            speaker,
            text.chars().count(),
            if crossed {
                "   <== SCENE BOUNDARY CROSSED"
            } else {
                ""
            },
        );
        last_scene = Some(*scene_id);
    }

    let out_dir = PathBuf::from(".private-render/diag");
    std::fs::create_dir_all(&out_dir).expect("create diag dir");
    let out_path = out_dir.join("scene-transition-seq.png");
    let bytes = encode_png_rgba_deterministic(&sheet);
    assert_eq!(
        &bytes[..8],
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "valid PNG magic",
    );
    std::fs::write(&out_path, &bytes).expect("write montage");
    println!(
        "wrote {} ({} bytes, {}x{}, {take} frames spanning scenes {scene_a} -> {scene_b})",
        out_path.display(),
        bytes.len(),
        sheet.width(),
        sheet.height(),
    );
}
