//! `sweetie-select-objbtn-button-object-dispatch-drivable` — the LAST
//! pilot-critical choice piece.
//!
//! Proves that the real Sweetie HD `select_objbtn` (`sel (0,2,4)`) GRAPHICAL
//! button-object picks — the route / love-interest and clothing / costume
//! screens, the game's first interaction — are now DRIVABLE end to end:
//! the button-object setup is decoded, the select dispatches as a real
//! choice, and acting on it drives a DISTINCT route branch.
//!
//! # What the real objbtn bytecode looks like (the finding)
//!
//! A real `select_objbtn` carries NO inline `{ … }` option block (unlike
//! `select_w`), so its option SET comes from the surrounding button-object
//! setup ops. Decoding the real Sweetie scenes:
//!
//!  * `objbtn_init` (`sel (0,2,20)`) opens the button group (a setup
//!    boundary — rlvm treats it as a no-op; this port CLEARS the pending
//!    group).
//!  * Each `objButtonOpts` (`obj (1,{81,82},1064)` → rlvm
//!    `GraphicsObject::SetButtonOpts`) places ONE selectable button; its
//!    args carry the button's 0-based ordinal (arg 0) and group id (arg 1
//!    observed `9`). The COUNT of these before the select is the real
//!    option count.
//!  * `select_objbtn` (`sel (0,2,4)`, one group arg) selects over that group.
//!  * The select result reaches the branch via the scene's OWN bytecode:
//!    an expression element `intL[0] = store` (`24 0b 5b.. 5d 5c 1e 24 c8`)
//!    copies the picked index, then `goto_on(intL[0])` (`jmp (0,1,4)`)
//!    jumps to `targets[index]`. Across the archive the goto_on target
//!    count is consistently `objButtonOpts_count + 1`.
//!
//! So the port makes the select DRIVABLE by recovering the button count
//! (VM button-object tracking: `objbtn_init` clears, `objButtonOpts`
//! appends, `select_objbtn` consumes → yields one `choice:<idx>` per
//! button), resolving a headless pick, and writing the chosen index to the
//! store register (mirroring rlvm's `set_store_register(button_number)`).
//! The scene's own `intL[0] = store` + `goto_on(intL[0])` then drive the
//! branch — NO engine-side goto rewrite.
//!
//! Env-gated + STRICT:
//! `ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd
//!  cargo test -p utsushi-reallive --test select_objbtn_dispatch_real_bytes -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::vm::SceneStore;
use utsushi_reallive::{
    BytecodeElement, Framebuffer, HeadlessChoicePolicy, ImageGridChoiceWindow, RealSceneIndex,
    ReplayEngine, ReplayOpts, SpatialChoiceWindow, WipeColour, build_scene_store_from_decompressed,
    decompress_all_scenes, encode_png_rgba_deterministic,
};

/// Absolute diag directory the orchestrator reads for visual verification
/// (the MAIN checkout — uncommitted / gitignored).
const DIAG_DIR: &str = "/home/trevor/projects/itotori/.private-render/diag";

/// `sel` module id.
const SEL_MID: u8 = 2;
/// `select_objbtn` opcode.
const OP_SELECT_OBJBTN: u16 = 4;
/// `objbtn_init` opcode.
const OP_OBJBTN_INIT: u16 = 20;
/// `objButtonOpts` opcode.
const OP_OBJ_BUTTON_OPTS: u16 = 1064;

/// A real `select_objbtn` scene with its decoded button-object setup.
#[derive(Debug, Clone)]
struct ObjbtnScene {
    scene_id: u16,
    /// Number of `objButtonOpts` setup ops before the first
    /// `select_objbtn` — the recovered option COUNT.
    button_count: usize,
    /// Whether an `objbtn_init` setup-boundary op is present.
    has_objbtn_init: bool,
}

fn staged(
    seen_bytes: &[u8],
) -> (
    utsushi_reallive::vm::InMemorySceneStore,
    std::collections::HashSet<(u16, u32)>,
) {
    let index_len = RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (s, d) in decompressed.iter_mut().zip(xor2) {
        s.bytecode = d.bytecode;
    }
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    (store, shift_jis)
}

/// Scan every scene for a `select_objbtn` and decode its button-object
/// setup (count of `objButtonOpts` before the first select_objbtn, and
/// whether `objbtn_init` is present).
fn scan_objbtn_scenes(store: &utsushi_reallive::vm::InMemorySceneStore) -> Vec<ObjbtnScene> {
    let mut ids: Vec<u16> = store.scene_ids();
    ids.sort_unstable();
    let mut out = Vec::new();
    for id in ids {
        let scene = store.fetch(id).expect("scene present");
        let mut button_count = 0usize;
        let mut has_objbtn_init = false;
        let mut has_select_objbtn = false;
        for el in &scene.elements {
            if let BytecodeElement::Command {
                module_id, opcode, ..
            } = el
            {
                if *module_id == SEL_MID && *opcode == OP_SELECT_OBJBTN {
                    has_select_objbtn = true;
                    break; // count only the setup up to the first select
                }
                if *module_id == SEL_MID && *opcode == OP_OBJBTN_INIT {
                    has_objbtn_init = true;
                }
                if (*module_id == 81 || *module_id == 82) && *opcode == OP_OBJ_BUTTON_OPTS {
                    button_count += 1;
                }
            }
        }
        if has_select_objbtn {
            out.push(ObjbtnScene {
                scene_id: id,
                button_count,
                has_objbtn_init,
            });
        }
    }
    out
}

fn opts() -> ReplayOpts {
    ReplayOpts {
        step_budget: 200_000,
        stop_at_first_pause: false,
    }
}

fn corpus_seen() -> Option<PathBuf> {
    real_corpus::corpus_1().map(|c| c.seen_txt)
}

/// Render a route-select frame from the REAL recovered button count. A
/// ≤2-button group lays out as the side-by-side [`SpatialChoiceWindow`]
/// (the route / love-interest pair); a ≥3-button group as the icon-strip
/// [`ImageGridChoiceWindow`]. Positions/count come from the real objbtn
/// setup; the per-button labels are faithful placeholders (the real
/// on-screen art is the g00 button SPRITE — a follow-up).
fn render_route_select(button_count: usize, screen: (u32, u32), name: &str) -> Vec<u8> {
    let labels: Vec<String> = (0..button_count).map(|i| format!("Route {i}")).collect();
    let mut fb = Framebuffer::new(screen.0, screen.1);
    fb.fill(WipeColour::opaque_rgb(0x18, 0x1a, 0x24));
    let painted = if button_count >= 3 {
        let ig = ImageGridChoiceWindow::from_options(&labels, 0, screen);
        fb.draw_image_grid_choice_window(&ig)
    } else {
        let sw = SpatialChoiceWindow::from_options(&labels, 0, screen);
        fb.draw_spatial_choice_window(&sw)
    };
    assert!(painted > 0, "the route-select window must paint pixels");
    let bytes = encode_png_rgba_deterministic(&fb);
    assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47], "valid PNG magic");
    fs::create_dir_all(DIAG_DIR).ok();
    let out = Path::new(DIAG_DIR).join(name);
    fs::write(&out, &bytes).expect("write route-select png");
    eprintln!(
        "wrote {} ({} bytes) — real button_count={}",
        out.display(),
        bytes.len(),
        button_count
    );
    bytes
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn sweetie_real_bytes_select_objbtn_drivable() {
    let Some(seen_path) = corpus_seen() else {
        real_corpus::require_real_bytes("sweetie_real_bytes_select_objbtn_drivable");
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let (store, shift_jis) = staged(&seen_bytes);

    let objbtn_scenes = scan_objbtn_scenes(&store);
    assert!(
        !objbtn_scenes.is_empty(),
        "real Sweetie HD must carry select_objbtn (0,2,4) scenes"
    );
    let with_buttons: Vec<&ObjbtnScene> = objbtn_scenes
        .iter()
        .filter(|s| s.button_count >= 2)
        .collect();
    assert!(
        !with_buttons.is_empty(),
        "at least one select_objbtn scene must recover >1 button from its objButtonOpts setup"
    );
    eprintln!(
        "select_objbtn scenes: {} total; {} with >=2 recovered buttons",
        objbtn_scenes.len(),
        with_buttons.len(),
    );
    for s in objbtn_scenes.iter().take(12) {
        eprintln!(
            "  scene {:>5}: button_count={} objbtn_init={}",
            s.scene_id, s.button_count, s.has_objbtn_init
        );
    }

    let engine = ReplayEngine::from_store(store, shift_jis);

    // The route-select the pilot needs is a SEEN_START-region graphical
    // pair pick (the love-interest choice). Find the first objbtn scene
    // that both recovers >1 choice at replay AND drives a DISTINCT branch
    // under Fixed(0) vs Fixed(1).
    let branch_signature = |scene: u16, index: u16| -> (Vec<u16>, Option<u16>, u32) {
        let report =
            engine.branch_following_report(scene, &opts(), HeadlessChoicePolicy::Fixed(index));
        (
            report.scenes_visited.iter().copied().collect(),
            report.first_cross_scene,
            report.steps,
        )
    };

    let mut proven_scene: Option<u16> = None;
    let mut proven_button_count = 0usize;
    // Every drivable (scene, button_count) — the route-select render picks
    // the smallest-count one (the love-interest PAIR → SpatialPair layout).
    let mut drivable: Vec<(u16, usize)> = Vec::new();
    let mut total_choices_made = 0u64;
    for s in &with_buttons {
        let scene = s.scene_id;
        if !engine.scene_ids().contains(&scene) {
            continue;
        }
        let report =
            engine.branch_following_report(scene, &opts(), HeadlessChoicePolicy::AlwaysFirst);
        // 0-unknown preserved on the executed path.
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "select_objbtn scene {scene} executed path must be 0-unknown; got {:?}",
            report.unknown_opcode_keys,
        );
        // The button-object select now emits choice:<idx> surfaces.
        let lines =
            engine.branch_following_lines(scene, &opts(), HeadlessChoicePolicy::AlwaysFirst);
        let choice_surfaces = lines
            .iter()
            .filter(|l| {
                l.text_surface
                    .as_deref()
                    .is_some_and(|s| s.starts_with("choice:"))
            })
            .count();
        total_choices_made += report.choices_made;
        eprintln!(
            "objbtn scene {scene}: button_count={} choices_made={} choice_surfaces={} visited={}",
            s.button_count,
            report.choices_made,
            choice_surfaces,
            report.scenes_visited.len(),
        );
        if report.choices_made == 0 {
            continue;
        }
        // Acting on the objbtn select drives a DISTINCT branch.
        let sig0 = branch_signature(scene, 0);
        let sig1 = branch_signature(scene, 1);
        if sig0 != sig1 {
            eprintln!(
                "  DRIVABLE scene {scene}: pick0 visited={:?} cross={:?} steps={} | \
                 pick1 visited={:?} cross={:?} steps={}",
                sig0.0, sig0.1, sig0.2, sig1.0, sig1.1, sig1.2,
            );
            drivable.push((scene, s.button_count));
            if proven_scene.is_none() {
                proven_scene = Some(scene);
                proven_button_count = s.button_count;
            }
        }
    }

    assert!(
        total_choices_made > 0,
        "the button-object select_objbtn must now make choices through the sel mechanism \
         — total choices_made must be > 0, got 0 (the graphical pick is still dormant)"
    );
    let proven_scene = proven_scene.expect(
        "acting on a real select_objbtn must drive a DISTINCT route branch: no button-object \
         scene produced a different executed observation under Fixed(0) vs Fixed(1)",
    );
    eprintln!(
        "PROVEN: select_objbtn is DRIVABLE at scene {proven_scene} \
         (button_count={proven_button_count}); total choices_made={total_choices_made}"
    );

    let _ = proven_button_count;

    // The route / love-interest pick is the 2-button PAIR (rendered as the
    // side-by-side SpatialChoiceWindow, matching the real
    // route-select-screen-tutorial.png). Pick the smallest-count drivable
    // objbtn scene for the diag frame.
    let (route_scene, route_count) = *drivable
        .iter()
        .min_by_key(|(_, count)| *count)
        .expect("a drivable objbtn scene");
    eprintln!("route-select diag: scene {route_scene} button_count={route_count}");
    let gameexe = real_corpus::corpus_1()
        .and_then(|c| c.gameexe())
        .expect("parse real Gameexe.ini");
    let screen = gameexe.screen_size_px();
    render_route_select(route_count, screen, "smoke-route-select.png");

    eprintln!(
        "GATE OUTCOME: real Sweetie select_objbtn (0,2,4) graphical picks are DRIVABLE — \
         button-object setup decoded (objbtn_init + objButtonOpts → option count), the select \
         dispatches through the sel mechanism (choices_made>0, choice:<idx> surfaces), and \
         Fixed(0) vs Fixed(1) drives a DISTINCT route branch at scene {proven_scene}. 0-unknown \
         preserved."
    );
}
