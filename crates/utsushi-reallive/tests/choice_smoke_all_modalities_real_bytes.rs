//! `sweetie-real-bytes-choice-smoke-all-modalities` — Sweetie-pilot readiness
//! gate #1.
//!
//! Validates the THREE choice modalities (text list / spatial pair / image
//! grid) against ACTUAL Sweetie HD choice bytecode — not the synthetic seams
//! the modalities were built on. The gate's whole VALUE is to tell us whether
//! the choice modalities + the count-based clothing-vs-route split heuristic
//! actually HOLD on real Sweetie bytes.
//!
//! # What real Sweetie HD choice bytecode actually looks like (the finding)
//!
//! Surveying every `module_sel` command across all 198 scenes of the real
//! Sweetie HD `Seen.txt` (SEEN_START = scene 1), the reality is:
//!
//!  * EVERY real OPTION-BLOCK choice/select is `select_w` at `(module_type=0
//!    module_id=2, opcode=2)` — 117 occurrences, EACH framed with the
//!    `SelectElement` `{ … }` option block (so `extract_select_choice_texts`
//!    recovers the real option count). These include plain dialogue yes/no
//!    choices AND gallery / scene-jump / time-of-day menus.
//!  * The GRAPHICAL route / clothing PICK screens are the `select_objbtn`
//!    button-object ops — REAL opcode `4` (rlvm `AddOpcode(4, 0
//!    "select_objbtn")`), `(0,2,4)`, 33× — NOT the fictional opcode `3` the old
//!    code used (0×), and NOT the `select_w` option-block form. They carry no
//!    inline option block; the graphical presentation is set up by button-object
//!    SelectionControl ops (`objbtn_init=20` / `select_objbtn=4`). Those ops are
//!    the real modality signal ([`selection_control_signal`]).
//!  * The real select_w commands live at `module_type = 0`, which is now
//!    where the choice machinery registers: `SEL_MODULE_TYPE` was corrected
//!    from `1` (a wrong constant misread from a `(1,5,120)` `SYS2` byte) to
//!    `0` (the real RealLive `Sel` module, `RLModule("Sel", 0, 2)`). BEFORE
//!    the fix the real `(0,2,2)` commands never dispatched through the
//!    pipeline (`SelRuntime` / `SelectLongOp` / `choice:<idx>` emission
//!    `goto_on($store)` branch driving) — they were gap-filled by the opcode
//!    CATALOG as `Advance` no-ops, leaving the choice machinery DORMANT
//!    (recognized 0-unknown but never presented, never driving a branch).
//!    AFTER the fix they dispatch through `SelRuntime`: a `choice:<idx>`
//!    surface is emitted per option, the `HeadlessChoicePolicy` resolves it
//!    and the chosen index writes `$store` so `goto_on($store)` drives the
//!    matching branch.
//!
//! # Modality is keyed on the real SelectionControl signal (P1 re-derivation)
//!
//! The retired heuristic `select_modality(variant, count)` split an
//! object-button select on the option count (`2` → `SpatialPair`, `≥3` →
//! `ImageGrid`) — but that count-based route-vs-clothing split had NO
//! real-bytes basis: a 2-option `select_w` and a ≥3-option `select_w` are the
//! SAME opcode. `select_modality` now keys on the REAL SelectionControl
//! SIGNAL: the presence of button-object setup ops in the select's scene. On
//! real Sweetie those setup ops are `objbtn_init` (`(0,2,20)`, 43×) and
//! `select_objbtn` (the REAL opcode `4` — NOT the fictional `3` — `(0,2,4)`
//! 33×). A select whose scene carries them is GRAPHICAL (button-object);
//! a select with none is a plain vertical TEXT list.
//!
//! HONEST finding (from decoding the real button-object scenes): the real
//! route (character-panel) and clothing (costume-strip) PICK screens are the
//! `select_objbtn` button-object ops themselves (no inline option block); the
//! button-object-context `select_w` selects in this corpus are gallery
//! scene-jump / time-of-day menus. The SelectionControl ops do NOT carry a
//! route-vs-clothing discriminator, so pair-vs-grid is only a LAYOUT
//! arrangement of the placed option-buttons (≤2 → side-by-side, ≥3 → grid)
//! not a route-vs-clothing semantic. The prompt's hypothesised `(0,2,30..36)`
//! `(0,2,122)` ops are NOT the story signal — they live in the 999x system
//! menu-builder scenes.
//!
//! # What this gate asserts on real bytes
//!
//!  1. Real select commands EXIST and decode 0-unknown.
//!  2. Every OPTION-BLOCK select is `select_w (0,2,2)`; and the button-object
//!     SelectionControl setup ops (`objbtn_init=20` / `select_objbtn=4`) are
//!     PRESENT — the real graphical modality signal.
//!  3. Modality is derived from that signal, NOT the count: a button-object
//!     select classifies GRAPHICAL (`SpatialPair` for ≤2, `ImageGrid` for ≥3)
//!     while a plain select classifies `TextList`. A 2-option graphical select
//!     and a 2-option plain select classify DIFFERENTLY — proving the count is
//!     no longer the driver (the misclassification is RESOLVED).
//!  4. Branch-following through the select-bearing scenes is 0-unknown AND
//!     now emits `choice:<idx>` surfaces and makes `choices_made > 0` — the
//!     choice machinery is LIVE on real bytes (correct `module_type=0`
//!     registration), and acting on a real select drives a DISTINCT branch:
//!     resolving a select-bearing scene under `Fixed(0)` vs `Fixed(1)`
//!     produces a different executed observation for at least one scene.
//!  5. The render layer lays out the real recovered option structure per its
//!     modality — the route-signature select as the side-by-side
//!     `SpatialChoiceWindow`, the clothing-signature select as the
//!     `ImageGridChoiceWindow` icon strip, the plain text select as the
//!     vertical `ChoiceWindow` — three smoke PNGs for the orchestrator to
//!     visually verify vs the real screenshots (real g00 option ART is a
//!     follow-up; the LAYOUT / modality is the deliverable).
//!
//! Env-gated + STRICT: run with
//! `ITOTORI_REAL_GAME_ROOT=/scratch/itotori-research/sweetie-hd
//!  cargo test -p utsushi-reallive --test choice_smoke_all_modalities_real_bytes -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::vm::SceneStore;
use utsushi_reallive::{
    BytecodeElement, ChoiceWindow, Framebuffer, HeadlessChoicePolicy, ImageGridChoiceWindow,
    RealSceneIndex, ReplayEngine, ReplayOpts, SelectModality, SelectVariant,
    SelectionControlSignal, SpatialChoiceWindow, WipeColour, build_scene_store_from_decompressed,
    decompress_all_scenes, encode_png_rgba_deterministic, extract_select_choice_texts,
    select_modality, selection_control_signal,
};

/// The absolute diag directory the orchestrator reads for visual verification
/// (the MAIN checkout, not the worktree — it is uncommitted / gitignored).
const DIAG_DIR: &str = "/home/trevor/projects/itotori/.private-render/diag";

/// A real select command located in the real Sweetie HD bytecode.
#[derive(Debug, Clone)]
struct RealSelect {
    scene_id: u16,
    byte_offset: usize,
    module_type: u8,
    module_id: u8,
    opcode: u16,
    option_count: usize,
    options: Vec<Vec<u8>>,
    /// Every `module_id == 2` command opcode present in this select's scene —
    /// the raw material [`selection_control_signal`] classifies the modality
    /// from (button-object SelectionControl setup ops present → graphical).
    scene_sel_opcodes: Vec<u16>,
}

impl RealSelect {
    /// The REAL SelectionControl signal for this select — derived from the
    /// button-object setup ops in its scene, NOT the option count.
    fn signal(&self) -> SelectionControlSignal {
        selection_control_signal(self.scene_sel_opcodes.iter().copied())
    }

    /// The modality `select_modality` classifies this real select into, from
    /// its REAL SelectionControl signal + placed option count.
    fn classified_modality(&self) -> SelectModality {
        select_modality(self.signal(), self.option_count)
    }
}

fn corpus_seen() -> Option<PathBuf> {
    real_corpus::corpus_1().map(|c| c.seen_txt)
}

fn staged_store_and_engine(
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

/// Scan every scene for `module_id == 2` select commands carrying a
/// `SelectElement { … }` option block (the real choice/select surface).
fn scan_real_selects(store: &utsushi_reallive::vm::InMemorySceneStore) -> Vec<RealSelect> {
    let mut ids: Vec<u16> = store.scene_ids();
    ids.sort_unstable();
    let mut out = Vec::new();
    for id in ids {
        let scene = store.fetch(id).expect("scene present");
        // Every module_id==2 command opcode in the scene — the SelectionControl
        // signal material (button-object setup ops mark a graphical scene).
        let scene_sel_opcodes: Vec<u16> = scene
            .elements
            .iter()
            .filter_map(|el| match el {
                BytecodeElement::Command {
                    module_id, opcode, ..
                } if *module_id == 2 => Some(*opcode),
                _ => None,
            })
            .collect();
        for el in &scene.elements {
            if let BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                raw_bytes,
                byte_offset,
                ..
            } = el
                && *module_id == 2
                && raw_bytes.contains(&0x7B)
            {
                let options = extract_select_choice_texts(raw_bytes);
                if options.is_empty() {
                    continue; // a brace that is not an option block
                }
                out.push(RealSelect {
                    scene_id: id,
                    byte_offset: *byte_offset,
                    module_type: *module_type,
                    module_id: *module_id,
                    opcode: *opcode,
                    option_count: options.len(),
                    options,
                    scene_sel_opcodes: scene_sel_opcodes.clone(),
                });
            }
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

/// Render a real select's real option structure through the window its REAL
/// SelectionControl-signal modality assigns — the text-list [`ChoiceWindow`]
/// for a plain select, the side-by-side [`SpatialChoiceWindow`] or icon-strip
/// [`ImageGridChoiceWindow`] for a button-object graphical select — write it as
/// `name` under [`DIAG_DIR`], and return the PNG bytes. Option labels are the
/// real JP bytes (rendered `.notdef` — the LAYOUT / modality is what is
/// validated; the real g00 option ART is a follow-up, faithful placeholder).
fn render_smoke_png(
    sel: &RealSelect,
    config: &utsushi_reallive::MessageWindowConfig,
    screen: (u32, u32),
    name: &str,
) -> Vec<u8> {
    let labels: Vec<String> = sel
        .options
        .iter()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .collect();
    let mut fb = Framebuffer::new(screen.0, screen.1);
    fb.fill(WipeColour::opaque_rgb(0x14, 0x18, 0x26));
    let modality = sel.classified_modality();
    let painted = match modality {
        SelectModality::TextList => {
            let cw = ChoiceWindow::from_config(&labels, 0, config, screen, screen);
            fb.draw_choice_window(&cw)
        }
        SelectModality::SpatialPair => {
            let sw = SpatialChoiceWindow::from_options(&labels, 0, screen);
            fb.draw_spatial_choice_window(&sw)
        }
        SelectModality::ImageGrid => {
            let ig = ImageGridChoiceWindow::from_options(&labels, 0, screen);
            fb.draw_image_grid_choice_window(&ig)
        }
    };
    assert!(painted > 0, "the {modality:?} window must paint pixels");
    let bytes = encode_png_rgba_deterministic(&fb);
    assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47], "valid PNG magic");
    fs::create_dir_all(DIAG_DIR).ok();
    let out = PathBuf::from(DIAG_DIR).join(name);
    fs::write(&out, &bytes).expect("write smoke png");
    eprintln!(
        "wrote {} ({} bytes) — scene {} off {:#06x} count={} signal={:?} modality={:?}",
        out.display(),
        bytes.len(),
        sel.scene_id,
        sel.byte_offset,
        sel.option_count,
        sel.signal(),
        modality,
    );
    bytes
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn sweetie_real_bytes_choice_smoke_all_modalities() {
    let Some(seen_path) = corpus_seen() else {
        real_corpus::require_real_bytes("sweetie_real_bytes_choice_smoke_all_modalities");
        return;
    };
    let seen_bytes = fs::read(&seen_path).expect("read Seen.txt");
    let (store, shift_jis) = staged_store_and_engine(&seen_bytes);

    // (1)+(2) Locate the real select commands + characterize the opcode --
    let selects = scan_real_selects(&store);
    assert!(
        !selects.is_empty(),
        "no module_sel SelectElement commands found in real Sweetie HD bytecode"
    );

    let opcodes: BTreeSet<(u8, u8, u16)> = selects
        .iter()
        .map(|s| (s.module_type, s.module_id, s.opcode))
        .collect();
    eprintln!(
        "real select commands: {} across {} scenes; distinct (mt,mid,op) = {:?}",
        selects.len(),
        selects
            .iter()
            .map(|s| s.scene_id)
            .collect::<BTreeSet<_>>()
            .len(),
        opcodes,
    );

    // FINDING: every OPTION-BLOCK select is select_w (0,2,2). The graphical
    // route/clothing PICK screens are NOT these — they are `select_objbtn`
    // button-object ops (REAL opcode 4, no inline option block), and the
    // graphical presentation is set up by the button-object SelectionControl
    // ops (`objbtn_init` = 20, `select_objbtn` = 4). Those are what the modality
    // signal keys on now — NOT the option count.
    for s in &selects {
        assert_eq!(
            (s.module_type, s.module_id, s.opcode),
            (0, 2, SelectVariant::SelectW.opcode()),
            "every real Sweetie option-block select is select_w at (0,2,2); found {:?} at scene {} off {:#06x}",
            (s.module_type, s.module_id, s.opcode),
            s.scene_id,
            s.byte_offset,
        );
        assert_eq!(
            s.module_type,
            utsushi_reallive::SEL_MODULE_TYPE,
            "real select module_type ({}) must match the registered SEL_MODULE_TYPE ({})",
            s.module_type,
            utsushi_reallive::SEL_MODULE_TYPE,
        );
    }

    // The button-object SelectionControl SETUP ops EXIST on real bytes — this
    // is the real graphical signal. `select_objbtn` is the REAL opcode 4 (rlvm
    // `AddOpcode(4, 0, "select_objbtn")`), NOT the fictional 3 the old code
    // used; `objbtn_init` is opcode 20. Count them across the archive.
    let button_object_setup_ops: usize = selects
        .iter()
        .flat_map(|s| s.scene_sel_opcodes.iter().copied())
        .filter(|op| SelectVariant::BUTTON_OBJECT_SETUP_OPCODES.contains(op))
        .count();
    assert!(
        button_object_setup_ops > 0,
        "real Sweetie HD must carry button-object SelectionControl setup ops \
         (objbtn_init=20 / select_objbtn=4) — the real graphical modality signal"
    );
    eprintln!(
        "button-object SelectionControl setup ops seen across select-bearing scenes: \
         {button_object_setup_ops}"
    );

    // A select in a scene WITHOUT button-object setup ops is a plain TEXT
    // list; a select in a scene WITH button-object setup ops is GRAPHICAL —
    // laid out as a side-by-side pair (≤2 buttons) or an icon grid (≥3). The
    // option COUNT no longer decides graphical-vs-text (the retired heuristic).
    let plain_text = selects
        .iter()
        .find(|s| s.signal() == SelectionControlSignal::TextWindow)
        .expect("a plain text-window select (no button-object setup) exists on real bytes");
    let graphical_pair = selects
        .iter()
        .find(|s| s.signal() == SelectionControlSignal::ButtonObject && s.option_count <= 2)
        .expect("a ≤2-option button-object (graphical PAIR) select exists on real bytes");
    let graphical_grid = selects
        .iter()
        .find(|s| s.signal() == SelectionControlSignal::ButtonObject && s.option_count >= 3)
        .expect("a ≥3-option button-object (graphical GRID) select exists on real bytes");

    let route_like = graphical_pair;
    let grid_like = graphical_grid;
    let text_like = plain_text;

    for (label, s) in [
        ("graphical-pair(route)", route_like),
        ("graphical-grid(clothing)", grid_like),
        ("plain-text", text_like),
    ] {
        eprintln!(
            "{label}: scene {} off {:#06x} count={} signal={:?} modality={:?}",
            s.scene_id,
            s.byte_offset,
            s.option_count,
            s.signal(),
            s.classified_modality(),
        );
    }

    // RESOLUTION of the misclassification: modality is derived from the real
    // SelectionControl signal, NOT the option count.
    assert_eq!(
        route_like.classified_modality(),
        SelectModality::SpatialPair,
        "a ≤2-option BUTTON-OBJECT select classifies as the graphical SpatialPair \
         (side-by-side) — from the SelectionControl signal, not the count"
    );
    assert_eq!(
        grid_like.classified_modality(),
        SelectModality::ImageGrid,
        "a ≥3-option BUTTON-OBJECT select classifies as the graphical ImageGrid \
         (icon strip) — from the SelectionControl signal, not the count"
    );
    assert_eq!(
        text_like.classified_modality(),
        SelectModality::TextList,
        "a plain select with NO button-object setup classifies as TextList"
    );
    // The clincher: a graphical PAIR and a plain TEXT select can share the
    // SAME option count (2) yet classify DIFFERENTLY — proving the option
    // count is no longer the driver; the SelectionControl signal is.
    assert_eq!(route_like.option_count, text_like.option_count);
    assert_ne!(
        route_like.classified_modality(),
        text_like.classified_modality(),
        "two 2-option selects classify differently by SelectionControl signal — \
         the count-based misclassification is RESOLVED"
    );

    let engine = ReplayEngine::from_store(store, shift_jis);
    let entry = 1u16; // SEEN_START
    let entry_report =
        engine.branch_following_report(entry, &opts(), HeadlessChoicePolicy::AlwaysFirst);
    assert!(
        entry_report.unknown_opcode_keys.is_empty(),
        "entry scene executed path must be 0-unknown; got {:?}",
        entry_report.unknown_opcode_keys,
    );

    // Drive the select-bearing scenes and confirm: 0-unknown, AND now the
    // real select_w commands dispatch through the SelRuntime — they emit
    // `choice:<idx>` surfaces and make choices through the sel mechanism.
    let select_scenes: BTreeSet<u16> = selects.iter().map(|s| s.scene_id).collect();
    let mut probed = 0usize;
    let mut scenes_with_choices = 0usize;
    let mut total_choices_made = 0u64;
    let mut total_choice_surfaces = 0usize;
    for &scene in select_scenes.iter().take(6) {
        if !engine.scene_ids().contains(&scene) {
            continue;
        }
        let report =
            engine.branch_following_report(scene, &opts(), HeadlessChoicePolicy::AlwaysFirst);
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "select-bearing scene {scene} executed path must be 0-unknown; got {:?}",
            report.unknown_opcode_keys,
        );
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
        if report.choices_made > 0 {
            scenes_with_choices += 1;
        }
        total_choices_made += report.choices_made;
        total_choice_surfaces += choice_surfaces;
        eprintln!(
            "select scene {scene}: choices_made={} choice_surfaces={} \
             scenes_visited={} first_cross_scene={:?}",
            report.choices_made,
            choice_surfaces,
            report.scenes_visited.len(),
            report.first_cross_scene,
        );
        probed += 1;
    }
    assert!(
        probed > 0,
        "must have probed at least one real select-bearing scene"
    );
    // FIXED: the choice machinery is LIVE on real bytes.
    assert!(
        total_choices_made > 0,
        "real select_w must now make choices through the sel mechanism \
         (module_type=0 registration) — total choices_made must be > 0, got 0"
    );
    assert!(
        total_choice_surfaces > 0,
        "real select_w must now emit choice:<idx> surfaces through the SelRuntime \
         — total choice_surfaces must be > 0, got 0"
    );
    assert!(
        scenes_with_choices > 0,
        "at least one real select-bearing scene must resolve a choice"
    );

    // Acting on a real select drives a DISTINCT branch: resolve a
    // select-bearing scene under Fixed(0) vs Fixed(1) and require at least
    // one scene where the two picks produce a different executed observation
    // (different scenes visited, cross-scene target, step count, or text
    // stream). This is the OPPOSITE of the old dormant gap: a different pick
    // now actually drives a different subsequent path.
    let branch_signature = |scene: u16, index: u16| -> (Vec<u16>, Option<u16>, u32, Vec<String>) {
        let report =
            engine.branch_following_report(scene, &opts(), HeadlessChoicePolicy::Fixed(index));
        let lines =
            engine.branch_following_lines(scene, &opts(), HeadlessChoicePolicy::Fixed(index));
        let texts: Vec<String> = lines
            .iter()
            .filter(|l| {
                // Non-choice message text — the branch CONTENT, not the
                // choice prompt itself (both picks surface the same prompt).
                !l.text_surface
                    .as_deref()
                    .is_some_and(|s| s.starts_with("choice:"))
            })
            .map(|l| l.text.clone())
            .collect();
        (
            report.scenes_visited.iter().copied().collect(),
            report.first_cross_scene,
            report.steps,
            texts,
        )
    };
    let mut distinct_branch_scene: Option<u16> = None;
    let mut diverged = 0usize;
    let mut probed_for_divergence = 0usize;
    for &scene in &select_scenes {
        if !engine.scene_ids().contains(&scene) {
            continue;
        }
        // Only meaningful where the AlwaysFirst walk actually made a choice.
        let first_report =
            engine.branch_following_report(scene, &opts(), HeadlessChoicePolicy::AlwaysFirst);
        if first_report.choices_made == 0 {
            continue;
        }
        probed_for_divergence += 1;
        let sig0 = branch_signature(scene, 0);
        let sig1 = branch_signature(scene, 1);
        if sig0 != sig1 {
            diverged += 1;
            eprintln!(
                "DISTINCT BRANCH scene {scene}: pick0 visited={:?} cross={:?} steps={} lines={} \
                 | pick1 visited={:?} cross={:?} steps={} lines={}",
                sig0.0,
                sig0.1,
                sig0.2,
                sig0.3.len(),
                sig1.0,
                sig1.1,
                sig1.2,
                sig1.3.len(),
            );
            if distinct_branch_scene.is_none() {
                distinct_branch_scene = Some(scene);
            }
        }
    }
    eprintln!(
        "divergence scan: probed {probed_for_divergence} choice-making select scenes, \
         {diverged} produced a DISTINCT Fixed(0) vs Fixed(1) observation"
    );
    assert!(
        distinct_branch_scene.is_some(),
        "acting on a real select must drive a DISTINCT branch: no select-bearing \
         scene produced a different executed observation under Fixed(0) vs Fixed(1) \
         — the choice is not driving the branch"
    );

    // The route-signature (button-object, ≤2) renders as the side-by-side
    // SpatialChoiceWindow; the clothing-signature (button-object, ≥3) as the
    // ImageGridChoiceWindow icon strip; the plain text select as the vertical
    // ChoiceWindow — each picked by its real SelectionControl-signal modality.
    let gameexe = real_corpus::corpus_1()
        .and_then(|c| c.gameexe())
        .expect("parse real Gameexe.ini");
    let sel_config = gameexe.sel_window();
    let screen = gameexe.screen_size_px();
    eprintln!(
        "real Gameexe: sel_window_index={} screen={:?}",
        gameexe.sel_window_index(),
        screen,
    );

    let route_png = render_smoke_png(route_like, &sel_config, screen, "smoke-route-select.png");
    let text_png = render_smoke_png(text_like, &sel_config, screen, "smoke-text-choice.png");
    let grid_png = render_smoke_png(grid_like, &sel_config, screen, "smoke-clothing-select.png");
    for png in [&route_png, &text_png, &grid_png] {
        assert!(png.len() > 1000, "smoke PNG must be a non-trivial frame");
        assert_eq!(&png[..4], &[0x89, 0x50, 0x4E, 0x47]);
    }

    eprintln!(
        "GATE OUTCOME: real Sweetie choice machinery is LIVE and modality is now keyed on \
         the REAL SelectionControl signal (button-object setup ops), NOT the option count: \
         {} option-block selects (all select_w at (0,2,2)); button-object setup ops (objbtn_init=20 \
         / select_objbtn=4) present; a button-object select classifies graphical (SpatialPair / \
         ImageGrid) while a plain select classifies TextList — the count-based misclassification \
         is RESOLVED. total choices_made={}, total choice_surfaces={}, distinct-branch scene={:?}.",
        selects.len(),
        total_choices_made,
        total_choice_surfaces,
        distinct_branch_scene,
    );
}

/// Kanon coverage — the SECOND proven corpus. If `ITOTORI_REAL_GAME_ROOT_2`
/// points at a RealLive title with `select` commands, confirm the same fix
/// holds: real selects are `module_id=2` at `module_type=0` (== the
/// corrected `SEL_MODULE_TYPE`) and drive choices through the SelRuntime
/// (`choices_made > 0`). Skips cleanly when corpus 2 is absent or has no
/// inline-option selects.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT_2 (Kanon)"]
fn kanon_real_bytes_choice_machinery_live() {
    let Some(corpus) = real_corpus::corpus_2() else {
        real_corpus::require_real_bytes("kanon_real_bytes_choice_machinery_live");
        return;
    };
    let seen_bytes = fs::read(&corpus.seen_txt).expect("read Kanon Seen.txt");
    let (store, shift_jis) = staged_store_and_engine(&seen_bytes);

    let selects = scan_real_selects(&store);
    eprintln!(
        "Kanon: {} module_sel SelectElement commands; distinct (mt,mid,op) = {:?}",
        selects.len(),
        selects
            .iter()
            .map(|s| (s.module_type, s.module_id, s.opcode))
            .collect::<BTreeSet<_>>(),
    );
    if selects.is_empty() {
        eprintln!("Kanon: no inline-option selects in this corpus — nothing to drive; skipping");
        return;
    }

    // Every real Kanon select must land at the corrected SEL_MODULE_TYPE (0)
    // and module_id 2 — the same addressing the fix registers at.
    for s in &selects {
        assert_eq!(
            (s.module_type, s.module_id),
            (utsushi_reallive::SEL_MODULE_TYPE, 2),
            "Kanon real select at ({},{},{}) must be (SEL_MODULE_TYPE, 2, *)",
            s.module_type,
            s.module_id,
            s.opcode,
        );
    }

    let engine = ReplayEngine::from_store(store, shift_jis);
    let select_scenes: BTreeSet<u16> = selects.iter().map(|s| s.scene_id).collect();
    let mut total_choices_made = 0u64;
    let mut probed = 0usize;
    for &scene in select_scenes.iter().take(12) {
        if !engine.scene_ids().contains(&scene) {
            continue;
        }
        let report =
            engine.branch_following_report(scene, &opts(), HeadlessChoicePolicy::AlwaysFirst);
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "Kanon select-bearing scene {scene} must be 0-unknown; got {:?}",
            report.unknown_opcode_keys,
        );
        total_choices_made += report.choices_made;
        probed += 1;
    }
    assert!(
        probed > 0,
        "must have probed at least one Kanon select scene"
    );
    assert!(
        total_choices_made > 0,
        "Kanon real selects must make choices through the sel mechanism \
         (module_type=0 registration) — total choices_made must be > 0, got 0"
    );
    eprintln!(
        "Kanon GATE: choice machinery LIVE — {} selects, probed {} scenes, \
         total choices_made={}",
        selects.len(),
        probed,
        total_choices_made,
    );
}
