//! `utsushi-spatial-image-choice-love-interest` — the ALPHA proof that the
//! SPATIAL / graphical select (Sweetie HD's route / love-interest pick, the
//! game's FIRST choice) is (a) RECOGNIZED as the `sel.select_objbtn`
//! object-button variant (0-unknown preserved), (b) RENDERED as two option
//! images side-by-side with a hover/colour-highlight state (the focused
//! option full-colour, the other desaturated/grayscale) plus the focused
//! option's name, and (c) ACTED on so that selecting side K drives route
//! branch K.
//!
//! This is an additional RENDER modality + option-source on the SAME choice
//! render+act plumbing the text select uses — the ACT half is byte-for-byte
//! the text-select seam (`goto_on($store)` keyed off the resolved choice
//! index via `HeadlessChoicePolicy::Fixed(K)`); only the RENDER modality
//! (side-by-side spatial layout vs. vertical text list) and the select
//! opcode (`select_objbtn` vs. `select`) differ.
//!
//! Synthetic scene (fast + deterministic, CI-friendly) that exercises the
//! REAL seams: the `select_objbtn` command is framed exactly as RealLive's
//! SelectElement (`{ opt \n opt }`), so the VM's real
//! `extract_select_choice_texts` path pulls the option labels, the modality
//! classifier keys on the button-object SelectionControl signal (a
//! `select_objbtn` op → graphical, ≤2 → the SpatialPair layout), and
//! `goto_on($store)` jumps to the
//! branch for the resolved index. A real-bytes Sweetie HD route-select scene
//! was not cheaply reachable on this path; the recognition (opcode `(0,2,4)`)
//! and the act/render seams are the real ones. Real option ART is a
//! follow-up — the panels are faithful placeholders.

use std::collections::HashSet;

use utsushi_reallive::bytecode_element::BytecodeElement;
use utsushi_reallive::vm::{InMemorySceneStore, Scene};
use utsushi_reallive::{
    Framebuffer, HeadlessChoicePolicy, OPCODE_SELECT_OBJBTN, RGBA_BYTES_PER_PIXEL, ReplayEngine,
    ReplayOpts, SEL_MODULE_ID, SEL_MODULE_TYPE, SpatialChoiceWindow, WipeColour,
    encode_png_rgba_deterministic, extract_select_choice_texts,
};

// -- Byte constants for the hand-laid select_objbtn / goto_on scene ---------

const META_LINE_LEAD: u8 = 0x0A;
const SELECT_BLOCK_OPEN: u8 = 0x7B; // '{'
const SELECT_BLOCK_CLOSE: u8 = 0x7D; // '}'
const STORE_REGISTER: [u8; 2] = [0x24, 0xC8]; // `$\xC8` — store-register ref
const MODULE_JMP_TYPE: u8 = 0;
const MODULE_JMP_ID: u8 = 1;
const OPCODE_GOTO: u16 = 0;
const OPCODE_GOTO_ON: u16 = 3;

/// A `module_sel.select_objbtn` command framed as a real SelectElement:
/// `{ opt0 \n opt1 }`. This is the SPATIAL (object-button) opcode `(0,2,4)`;
/// the option labels live in the `{ ... }` block the VM's
/// `extract_select_choice_texts` walks.
fn select_objbtn_command(offset: usize, options: &[&str]) -> (BytecodeElement, usize) {
    let opcode = OPCODE_SELECT_OBJBTN;
    let mut raw = vec![
        0x23,
        SEL_MODULE_TYPE,
        SEL_MODULE_ID,
        opcode as u8,
        (opcode >> 8) as u8,
        0,
        0,
        0,
    ];
    raw.push(SELECT_BLOCK_OPEN);
    for (i, option) in options.iter().enumerate() {
        if i > 0 {
            raw.extend_from_slice(&[META_LINE_LEAD, 0x00, 0x00]);
        }
        raw.extend_from_slice(option.as_bytes());
    }
    raw.push(SELECT_BLOCK_CLOSE);
    let byte_len = raw.len();
    (
        BytecodeElement::Command {
            module_type: SEL_MODULE_TYPE,
            module_id: SEL_MODULE_ID,
            opcode,
            arg_count: 0,
            overload: 0,
            goto_targets: Vec::new(),
            goto_case_exprs: Vec::new(),
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

fn goto_on_store(offset: usize, targets: Vec<u32>) -> (BytecodeElement, usize) {
    let opcode = OPCODE_GOTO_ON;
    let argc = targets.len() as u16;
    let mut raw = vec![
        0x23,
        MODULE_JMP_TYPE,
        MODULE_JMP_ID,
        opcode as u8,
        (opcode >> 8) as u8,
        argc as u8,
        (argc >> 8) as u8,
        0,
    ];
    raw.push(b'(');
    raw.extend_from_slice(&STORE_REGISTER);
    raw.push(b')');
    let byte_len = raw.len();
    (
        BytecodeElement::Command {
            module_type: MODULE_JMP_TYPE,
            module_id: MODULE_JMP_ID,
            opcode,
            arg_count: argc,
            overload: 0,
            goto_targets: targets,
            goto_case_exprs: Vec::new(),
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

fn goto_command(offset: usize, target: u32) -> (BytecodeElement, usize) {
    let opcode = OPCODE_GOTO;
    let raw = vec![
        0x23,
        MODULE_JMP_TYPE,
        MODULE_JMP_ID,
        opcode as u8,
        (opcode >> 8) as u8,
        0,
        0,
        0,
    ];
    let byte_len = 8 + 4;
    (
        BytecodeElement::Command {
            module_type: MODULE_JMP_TYPE,
            module_id: MODULE_JMP_ID,
            opcode,
            arg_count: 0,
            overload: 0,
            goto_targets: vec![target],
            goto_case_exprs: Vec::new(),
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

fn textout(offset: usize, text: &str) -> (BytecodeElement, usize) {
    let raw = text.as_bytes().to_vec();
    let byte_len = raw.len();
    (
        BytecodeElement::Textout {
            encoding_hint: utsushi_reallive::TextoutEncoding::Other,
            raw_bytes: raw,
            byte_offset: offset,
            byte_len,
        },
        byte_len,
    )
}

// The two route options (love-interest pick). Staged English labels — the
// product output; the option art is a follow-up.
// Paren-free labels: the SelectElement parser treats `(` / `)` as the start
// of a value expression, so option labels must avoid them.
const OPTION_LEFT: &str = "Rin the spirited childhood friend";
const OPTION_RIGHT: &str = "Mei the quiet honor student";
const BRANCH_LEFT_MSG: &str = "Rin's route opens: the spirited path begins.";
const BRANCH_RIGHT_MSG: &str = "Mei's route opens: the quiet path begins.";

/// Build the two-branch spatial-select scene + the Shift-JIS textout set.
fn build_route_select_engine() -> ReplayEngine {
    let mut offset = 0usize;
    let (select_el, select_len) = select_objbtn_command(offset, &[OPTION_LEFT, OPTION_RIGHT]);
    offset += select_len;

    let goto_on_offset = offset;
    let (_probe, goto_on_len) = goto_on_store(goto_on_offset, vec![0, 0]);
    offset += goto_on_len;

    let t0 = offset;
    let (textout0, t0_text_len) = textout(t0, BRANCH_LEFT_MSG);
    offset += t0_text_len;
    let (_probe_goto0, goto0_len) = goto_command(offset, 0);
    offset += goto0_len;

    let t1 = offset;
    let (textout1, t1_text_len) = textout(t1, BRANCH_RIGHT_MSG);
    offset += t1_text_len;
    let goto1_offset = offset;
    let (_probe1, goto1_len) = goto_command(goto1_offset, 0);
    offset += goto1_len;

    let end = offset as u32;

    let (goto_on_el, _) = goto_on_store(goto_on_offset, vec![t0 as u32, t1 as u32]);
    let (goto0_el, _) = goto_command(t0 + t0_text_len, end);
    let (goto1_el, _) = goto_command(goto1_offset, end);

    let scene = Scene::new(
        1,
        vec![
            select_el, goto_on_el, textout0, goto0_el, textout1, goto1_el,
        ],
    )
    .expect("route-select scene builds");

    let mut store = InMemorySceneStore::new();
    store.insert(scene);

    let mut shift_jis: HashSet<(u16, u32)> = HashSet::new();
    shift_jis.insert((1, t0 as u32));
    shift_jis.insert((1, t1 as u32));
    ReplayEngine::from_store(store, shift_jis)
}

fn opts() -> ReplayOpts {
    ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    }
}

/// Option lines the spatial select emitted (the plain `choice:<idx>` base).
fn observed_spatial_choice_lines(
    engine: &ReplayEngine,
    policy: HeadlessChoicePolicy,
) -> Vec<(String, String)> {
    engine
        .branch_following_lines(1, &opts(), policy)
        .into_iter()
        .filter_map(|line| {
            let surface = line.text_surface.as_deref()?;
            if surface.starts_with("choice:") {
                Some((line.text, surface.to_string()))
            } else {
                None
            }
        })
        .collect()
}

fn observed_branch_messages(engine: &ReplayEngine, policy: HeadlessChoicePolicy) -> Vec<String> {
    engine
        .branch_following_lines(1, &opts(), policy)
        .into_iter()
        .filter(|line| {
            !line
                .text_surface
                .as_deref()
                .is_some_and(|s| s.starts_with("choice:"))
        })
        .map(|line| line.text)
        .collect()
}

// -------------------------------------------------------------------------
// RECOGNIZE: the spatial select is the object-button `(0,2,4)` variant. A
// `select_objbtn` op is itself a button-object SelectionControl setup op, so
// the scene's SelectionControl SIGNAL is `ButtonObject` → a graphical
// modality (≤2 placed buttons → the side-by-side pair). Modality is derived
// from the REAL SelectionControl signal, NOT the option count; dispatch emits
// the plain `choice:<idx>` base surface (no marker).
// -------------------------------------------------------------------------

#[test]
fn spatial_select_is_objbtn_and_classifies_graphical_from_the_signal() {
    let (select_el, _) = select_objbtn_command(0, &[OPTION_LEFT, OPTION_RIGHT]);
    let BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        raw_bytes,
        ..
    } = &select_el
    else {
        panic!("select_objbtn is a Command");
    };
    // Recognition: the SPATIAL select is the object-button opcode (0,2,4).
    assert_eq!(
        (*module_type, *module_id, *opcode),
        (SEL_MODULE_TYPE, SEL_MODULE_ID, OPCODE_SELECT_OBJBTN),
        "spatial select is sel.select_objbtn at the real (0,2,4)"
    );
    // The SelectElement `{ ... }` framing yields the two option labels — the
    // same seam a real Seen.txt hits.
    let choices = extract_select_choice_texts(raw_bytes);
    let decoded: Vec<String> = choices
        .iter()
        .map(|b| String::from_utf8(b.clone()).expect("ascii"))
        .collect();
    assert_eq!(
        decoded,
        vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()]
    );

    // Interpretation: the SelectionControl signal from a `select_objbtn`
    // button-object op is `ButtonObject`; ≤2 placed buttons → the SPATIAL pair.
    let signal = utsushi_reallive::selection_control_signal([*opcode]);
    assert_eq!(
        utsushi_reallive::select_modality(signal, 2),
        utsushi_reallive::SelectModality::SpatialPair
    );

    // Dispatch emits the plain `choice:<idx>` base surface — no `;spatial`
    // marker (the graphical modality is a scene-context property).
    let engine = build_route_select_engine();
    let lines = observed_spatial_choice_lines(&engine, HeadlessChoicePolicy::Fixed(0));
    let surfaces: Vec<&str> = lines.iter().map(|(_, s)| s.as_str()).collect();
    assert_eq!(surfaces, vec!["choice:0", "choice:1"]);
}

// -------------------------------------------------------------------------
// ACT: selecting side K drives route branch K (not always-first).
// -------------------------------------------------------------------------

#[test]
fn selecting_side_k_drives_route_branch_k_not_always_first() {
    let engine = build_route_select_engine();

    let branch_left = observed_branch_messages(&engine, HeadlessChoicePolicy::Fixed(0));
    let branch_right = observed_branch_messages(&engine, HeadlessChoicePolicy::Fixed(1));

    assert_eq!(branch_left, vec![BRANCH_LEFT_MSG.to_string()]);
    assert_eq!(branch_right, vec![BRANCH_RIGHT_MSG.to_string()]);
    // Load-bearing: the two SIDES drive DIFFERENT routes. A regression that
    // ignored the side (always-first) would make both equal BRANCH_LEFT.
    assert_ne!(
        branch_left, branch_right,
        "selecting side K must drive route branch K (K → route K)"
    );
}

// -------------------------------------------------------------------------
// RENDER: two option images side-by-side, focused side full-colour vs.
// unfocused side grayscale; focused side shows its name; side 0 vs side 1
// render DIFFERENT frames.
// -------------------------------------------------------------------------

const SCREEN: (u32, u32) = (1280, 720);

fn pixel_at(fb: &Framebuffer, x: u32, y: u32) -> [u8; RGBA_BYTES_PER_PIXEL] {
    let off = ((y as usize) * (fb.width() as usize) + x as usize) * RGBA_BYTES_PER_PIXEL;
    let px = &fb.pixels()[off..off + RGBA_BYTES_PER_PIXEL];
    [px[0], px[1], px[2], px[3]]
}

/// True when a pixel is (near-)grayscale: its three colour channels are all
/// within `tol` of each other. The desaturated un-hovered panel is
/// grayscale; the full-colour hovered panel is chromatic.
fn is_grayish(px: [u8; RGBA_BYTES_PER_PIXEL], tol: i32) -> bool {
    let (r, g, b) = (px[0] as i32, px[1] as i32, px[2] as i32);
    (r - g).abs() <= tol && (g - b).abs() <= tol && (r - b).abs() <= tol
}

fn render_frame(options: &[String], selected: usize) -> (Framebuffer, SpatialChoiceWindow) {
    let mut fb = Framebuffer::new(SCREEN.0, SCREEN.1);
    fb.fill(WipeColour::opaque_rgb(0x10, 0x12, 0x1a));
    let sw = SpatialChoiceWindow::from_options(options, selected, SCREEN);
    let painted = fb.draw_spatial_choice_window(&sw);
    assert!(painted > 0, "the focused option's name label must paint");
    (fb, sw)
}

#[test]
fn spatial_select_renders_side_by_side_with_a_moving_colour_highlight() {
    let options = vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()];

    let (fb_left, sw_left) = render_frame(&options, 0);
    let (fb_right, sw_right) = render_frame(&options, 1);

    // Both options laid out as side-by-side panels (a spatial 2-option
    // layout, not a vertical text list): distinct, non-overlapping columns.
    assert_eq!(sw_left.options.len(), 2, "both options present");
    let p0 = &sw_left.options[0];
    let p1 = &sw_left.options[1];
    assert!(
        p1.x >= p0.x + p0.w,
        "option 1 is to the RIGHT of option 0 (horizontal layout)"
    );
    assert_eq!(p0.y, p1.y, "panels share the vertical band (side-by-side)");
    assert_eq!(sw_left.selected, 0);
    assert_eq!(sw_right.selected, 1);

    // Sample the CENTRE of each panel. In the left-focused frame, panel 0 is
    // full-colour (chromatic) and panel 1 is desaturated (grayish); the
    // right-focused frame flips it. Selected != unselected, visually.
    let c0 = (p0.x + p0.w / 2, p0.y + p0.h / 4); // upper area, above the label band
    let c1 = (p1.x + p1.w / 2, p1.y + p1.h / 4);

    let left_p0 = pixel_at(&fb_left, c0.0, c0.1);
    let left_p1 = pixel_at(&fb_left, c1.0, c1.1);
    let right_p0 = pixel_at(&fb_right, c0.0, c0.1);
    let right_p1 = pixel_at(&fb_right, c1.0, c1.1);

    // Focused panel is chromatic; unfocused panel is grayscale.
    assert!(
        !is_grayish(left_p0, 12),
        "left-focused: panel 0 is full colour (chromatic), got {left_p0:?}"
    );
    assert!(
        is_grayish(left_p1, 12),
        "left-focused: panel 1 is desaturated grayscale, got {left_p1:?}"
    );
    assert!(
        is_grayish(right_p0, 12),
        "right-focused: panel 0 is desaturated grayscale, got {right_p0:?}"
    );
    assert!(
        !is_grayish(right_p1, 12),
        "right-focused: panel 1 is full colour (chromatic), got {right_p1:?}"
    );
    // The SAME panel changes colour/grayscale state as the hover moves —
    // selected != unselected for the identical region.
    assert_ne!(
        left_p0, right_p0,
        "panel 0's pixels differ between focused and unfocused (hover changed it)"
    );

    // The two full frames differ (the highlight moved sides). A
    // not-rendered / selection-ignored / always-first render regression
    // makes the frames equal and FAILS here.
    let png_left = encode_png_rgba_deterministic(&fb_left);
    let png_right = encode_png_rgba_deterministic(&fb_right);
    assert_ne!(
        png_left, png_right,
        "selecting a different side must render a DIFFERENT frame"
    );
    // Valid PNG magic.
    assert_eq!(&png_left[..4], &[0x89, 0x50, 0x4E, 0x47]);

    // The focused option's NAME is the label shown (bottom-centre band).
    assert_eq!(sw_left.char_count(), OPTION_LEFT.chars().count());
    assert_eq!(sw_right.char_count(), OPTION_RIGHT.chars().count());
}
