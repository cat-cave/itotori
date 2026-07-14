//! Message-window subsystem diagnostic renderer
//! (`utsushi-message-window-subsystem-fidelity`).
//!
//! Drives a REAL RealLive game through the fixed message-window pipeline
//! and writes the frames the orchestrator visually verifies:
//!
//!   * `<prefix>-01.png` — message #0 ALONE in the Gameexe-configured box
//!     (ONE message per frame, not the whole scene concatenated).
//!   * `<prefix>-seq.png` — the first N (≤3) play-order messages, each
//!     rendered as its OWN frame and stacked vertically, proving one
//!     message per frame across the real click-advance boundary.
//!
//! The box position / colour / alpha / font-size / insets + the `NAME_MOD`
//! name box are all driven from the game's real `#WINDOW.000`
//! (`Gameexe.ini`); nothing is hardcoded. The play-order message stream is
//! the branch-following (single-pass) observation — the order a player
//! sees — NOT the doubled two-pass catalogue.
//!
//! Run:
//!   cargo run -p utsushi-reallive --example msgwin_diag -- \
//!     <gameexe.ini> <seen.txt> <g00_dir> <out_prefix> [staged msgs...]
//!
//! With no trailing args the diag renders the REAL decoded play-order
//! message text (honest: an untranslated title's Japanese source renders as
//! the font's `.notdef` boxes — the layout/box/one-per-frame is what is
//! proven on real bytes). Trailing `Speaker::text` (or `::text` for
//! narration) args render STAGED translated messages instead — the product
//! output: legible English in the SAME real Gameexe-configured box, one per
//! frame, exercising the `NAME_MOD` name box. The box geometry is real
//! either way; only the message CONTENT is staged, exactly as
//! `render_diag.rs` stages its opening line.
//!
//! The `use_xor_2` recovery (encrypted titles, e.g. Sweetie HD) is staged
//! via the dev-only `kaifuu-reallive`; it is a no-op for plaintext titles
//! (Kanon).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    Framebuffer, Gameexe, RedactionPolicy, RenderPass, ReplayEngine, ReplayOpts, TextLayer,
    WipeColour, build_scene_store_from_decompressed, decompress_all_scenes,
    encode_png_rgba_deterministic,
};

// -- On-disk g00 asset package (mirrors render_diag.rs) --------------------

#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}
impl OnDiskG00Package {
    fn host_path(&self, id: &AssetId) -> PathBuf {
        let logical = id.path();
        let stem = logical.strip_prefix("g00/").unwrap_or(logical);
        self.g00_dir.join(stem)
    }
}
impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "msgwin-diag-on-disk-g00"
    }
    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_string()),
            revision: None,
        }
    }
    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }
    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }
    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.host_path(id).exists())
    }
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let meta = std::fs::metadata(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let bytes = std::fs::read(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }
    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

/// Stage a [`ReplayEngine`] from a Seen.txt envelope, running the dev-only
/// `use_xor_2` recovery (no-op for plaintext titles).
fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, dec) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = dec.bytecode;
    }
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    ReplayEngine::from_store(store, shift_jis)
}

const OBSERVE_BUDGET: u32 = 50_000;

fn write_png(path: &Path, fb: &Framebuffer) {
    let bytes = encode_png_rgba_deterministic(fb);
    assert_eq!(
        &bytes[..8],
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    );
    std::fs::write(path, &bytes).unwrap();
    println!(
        "wrote {} ({} bytes, {}x{})",
        path.display(),
        bytes.len(),
        fb.width(),
        fb.height()
    );
}

/// Rasterise the observed graphics stack + ONE message into a full frame.
// reason: a diagnostic renderer over distinct render inputs; a params struct
// would relocate the arity without clarity.
#[allow(clippy::too_many_arguments)]
fn render_message_frame(
    pass: &RenderPass,
    stack: &utsushi_reallive::GraphicsObjectStack,
    text: &str,
    speaker: Option<&str>,
    color: Option<[u8; 3]>,
    config: &utsushi_reallive::MessageWindowConfig,
    screen_size: (u32, u32),
    frame_size: (u32, u32),
) -> Framebuffer {
    // Full-fidelity private frame: real g00 art under the message box.
    let mut fb = pass.rasterise_with_policy(stack, RedactionPolicy::Full);
    // If the executed path composited no background, lay a neutral gradient
    // so the box still reads against something (never fakes game art).
    if stack.is_empty() {
        fb.fill(WipeColour::opaque_rgb(0x1a, 0x1e, 0x2c));
    }
    let text_color = color.map(|[r, g, b]| WipeColour::opaque_rgb(r, g, b));
    let layer = TextLayer::message_window_colored(
        text,
        speaker,
        text_color,
        config,
        screen_size,
        frame_size,
    );
    let painted = fb.draw_text(&layer);
    assert!(painted > 0, "message glyphs must paint");
    fb
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!(
            "usage: msgwin_diag <gameexe.ini> <seen.txt> <g00_dir> <out_prefix>\n\
             e.g. .private-render/diag/msgwin-kanon"
        );
        std::process::exit(2);
    }
    let gameexe_path = PathBuf::from(&args[1]);
    let seen_path = PathBuf::from(&args[2]);
    let g00_dir = PathBuf::from(&args[3]);
    let out_prefix = PathBuf::from(&args[4]);
    if let Some(parent) = out_prefix.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    // Optional staged translated messages ("Speaker::text" or "::text").
    let staged: Vec<(Option<String>, String)> = args[5..]
        .iter()
        .map(|arg| match arg.split_once("::") {
            Some((speaker, text)) if !speaker.trim().is_empty() => {
                (Some(speaker.trim().to_string()), text.to_string())
            }
            Some((_, text)) => (None, text.to_string()),
            None => (None, arg.clone()),
        })
        .collect();

    // --- Config-driven box from the real Gameexe.ini. ---
    let gameexe_bytes = std::fs::read(&gameexe_path).expect("read Gameexe.ini");
    let gameexe = Gameexe::parse(&gameexe_bytes).expect("parse Gameexe.ini");
    let config = gameexe.message_window(0);
    let screen_size = gameexe.screen_size_px();
    let entry_scene =
        u16::try_from(gameexe.get_int("SEEN_START").expect("#SEEN_START")).expect("scene id");
    println!(
        "config: screen={screen_size:?} entry_scene={entry_scene} origin={} pos=({},{}) \
         attr_rgba={:?} moji_size={} name_mod={}",
        config.origin,
        config.pos_x,
        config.pos_y,
        config.attr_rgba,
        config.moji_size,
        config.name_mod,
    );

    // Render at the game's own screen size so the box matches the engine
    // geometry (Kanon 640x480 vs. the rlvm oracle; Sweetie 1280x720).
    let frame_size = screen_size;

    // --- Real play-order message stream (branch-following, single pass). ---
    // Install the #NAMAE + #COLOR_TABLE resolver so a leading 【…】 name
    // prefix in a spoken line resolves into a speaker + text colour.
    let resolver = gameexe.namae_resolver();
    println!("namae_resolver: {} keys", resolver.len());
    let seen_bytes = std::fs::read(&seen_path).expect("read Seen.txt");
    let engine = staged_engine(&seen_bytes).with_namae_resolver(gameexe.namae_resolver());
    let opts = ReplayOpts {
        step_budget: OBSERVE_BUDGET,
        stop_at_first_pause: false,
    };
    // The #SEEN_START scene is often the title/menu, which spins
    // headlessly and yields no dialogue. Fall back to the first
    // dialogue-bearing scene in the store so the diag shows a real
    // play-order message. (All candidates are real decoded bytecode.)
    let mut driven_scene = entry_scene;
    let mut observation = engine.observe_for_port(entry_scene, &opts);
    if observation.play_order_lines.is_empty() {
        for scene in engine.scene_ids() {
            let candidate = engine.observe_for_port(scene, &opts);
            if !candidate.play_order_lines.is_empty() {
                driven_scene = scene;
                observation = candidate;
                break;
            }
        }
    }
    // Message stream to render: real decoded play order, OR the staged
    // translated messages when supplied.
    let used_staged = !staged.is_empty();
    let messages: Vec<(Option<String>, Option<[u8; 3]>, String)> = if used_staged {
        // Staged translated messages: resolve each speaker's colour from
        // the real #NAMAE + #COLOR_TABLE tables by its display key.
        staged
            .into_iter()
            .map(|(speaker, text)| {
                let color = speaker
                    .as_deref()
                    .and_then(|name| resolver.resolve(name))
                    .map(|resolved| resolved.color);
                (speaker, color, text)
            })
            .collect()
    } else {
        observation
            .play_order_lines
            .iter()
            .map(|line| (line.speaker.clone(), line.color, line.text.clone()))
            .collect()
    };
    println!(
        "driven_scene={driven_scene} real_play_order={} rendering={} messages \
         (one per frame; staged_translation={used_staged}); graphics_objects={}",
        observation.play_order_lines.len(),
        messages.len(),
        observation.scene.graphics_stack.len(),
    );
    assert!(
        !messages.is_empty(),
        "no message to render (no play-order message and no staged messages)"
    );

    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package { g00_dir });
    let pass = RenderPass::with_dimensions(frame_size.0, frame_size.1)
        .unwrap()
        .with_assets(Arc::clone(&assets));
    let stack = &observation.scene.graphics_stack;

    // --- <prefix>-01.png: message #0 ALONE. ---
    let (first_speaker, first_color, first_text) = &messages[0];
    let frame0 = render_message_frame(
        &pass,
        stack,
        first_text,
        first_speaker.as_deref(),
        *first_color,
        &config,
        screen_size,
        frame_size,
    );
    write_png(
        &out_prefix.with_extension("").with_file_name(format!(
            "{}-01.png",
            out_prefix.file_name().unwrap().to_string_lossy()
        )),
        &frame0,
    );

    // --- <prefix>-seq.png: first ≤3 messages, each its OWN frame, stacked. ---
    let take = messages.len().min(3);
    let gap = 8u32;
    let mut sheet = Framebuffer::new(
        frame_size.0,
        frame_size.1 * take as u32 + gap * (take as u32 - 1),
    );
    sheet.fill(WipeColour::opaque_rgb(0x00, 0x00, 0x00));
    for (i, (speaker, color, text)) in messages.iter().take(take).enumerate() {
        let frame = render_message_frame(
            &pass,
            stack,
            text,
            speaker.as_deref(),
            *color,
            &config,
            screen_size,
            frame_size,
        );
        sheet.blit(&frame, 0, (frame_size.1 + gap) * i as u32);
    }
    write_png(
        &out_prefix.with_extension("").with_file_name(format!(
            "{}-seq.png",
            out_prefix.file_name().unwrap().to_string_lossy()
        )),
        &sheet,
    );

    // These are PRIVATE full-fidelity frames (real g00 art) written to the
    // gitignored.private-render/diag for orchestrator visual verification
    // — never committed.
    println!("done: {} messages rendered one-per-frame", messages.len());
}
