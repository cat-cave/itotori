//! `utsushi-graphical-image-choice-select` — the ALPHA proof that the
//! IMAGE-GRID select (Sweetie HD's clothing / costume pick, the game's
//! THIRD choice modality, distinct from the vertical text select and the
//! side-by-side spatial route-select) is (a) RECOGNIZED as the
//! `sel.select_objbtn` object-button variant (0-unknown preserved) and
//! because it offers THREE-plus option buttons, INTERPRETED as the
//! image-grid modality (tagged `choice:<idx>;imagegrid`, distinct from the
//! 2-option pair's `;spatial`), (b) RENDERED as a horizontal STRIP of
//! costume-icon boxes with a highlighted / selected box, followed by a
//! standard dialogue-style CONFIRM (the "pick image → confirm" flow), and
//! (c) ACTED on so that selecting box K drives branch K and the follow-on
//! confirm step resolves.
//!
//! This is an additional RENDER modality + option-source on the SAME
//! choice render+act plumbing the text and spatial selects use — the ACT
//! half is byte-for-byte the text-select seam (`goto_on($store)` keyed off
//! the resolved choice index via `HeadlessChoicePolicy`); only the RENDER
//! modality (image-grid strip + a follow-on confirm) and the option count
//! (3+ vs. the pair's 2) differ. Both graphical modalities ride the SAME
//! `select_objbtn` opcode `(0,2,4)`; the image-grid vs. spatial-pair split
//! is an INTERPRETATION of the one recognized op keyed on option count
//! (≥3 placed buttons → grid), NOT a distinct opcode — the bytecode
//! carries no opcode to tell the two graphical layouts apart.
//!
//! Synthetic scene (fast + deterministic, CI-friendly) that exercises the
//! REAL seams: foreground button objects are created and bound with
//! `objButtonOpts(buf, action, se, group, button_number)`, then the real
//! one-argument `select_objbtn(group)` selects those objects with NO inline
//! text block. The modality classifier keys on that object-button prompt
//! (three placed buttons → the ImageGrid layout), and `goto_on($store)`
//! jumps through the selected button number; each image branch converges on
//! a second, dialogue-style confirm select whose own `goto_on($store)`
//! resolves the confirm. A real-bytes Sweetie HD clothing-select scene was
//! not cheaply reachable on this path; the recognition (opcode `(0,2,4)`)
//! the image-grid interpretation (option-count keyed), and the act/render
//! seams are the real ones. Real costume ART is a follow-up — the icon
//! boxes are faithful placeholders.

use std::collections::HashSet;

use utsushi_reallive::bytecode_element::BytecodeElement;
use utsushi_reallive::vm::{InMemorySceneStore, Scene};
use utsushi_reallive::{
    ChoiceWindow, Framebuffer, HeadlessChoicePolicy, ImageGridChoiceWindow, MessageWindowConfig,
    OBJ_FG_CREATION_ID, OBJ_FG_MODULE_ID, OBJ_FG_MODULE_TYPE, OPCODE_OBJ_BUTTON_OPTS,
    OPCODE_SELECT_OBJBTN, RGBA_BYTES_PER_PIXEL, ReplayEngine, ReplayOpts, SEL_MODULE_ID,
    SEL_MODULE_TYPE, SEL_OPCODE_SELECT, SelectModality, SelectionPromptKind, WipeColour,
    encode_png_rgba_deterministic, extract_select_choice_texts, select_modality,
    selection_control_signal,
};

// -- Byte constants for the hand-laid select scene --------------------------

const META_LINE_LEAD: u8 = 0x0A;
const SELECT_BLOCK_OPEN: u8 = 0x7B; // '{'
const SELECT_BLOCK_CLOSE: u8 = 0x7D; // '}'
const STORE_REGISTER: [u8; 2] = [0x24, 0xC8]; // `$\xC8` — store-register ref
const MODULE_JMP_TYPE: u8 = 0;
const MODULE_JMP_ID: u8 = 1;
const OPCODE_GOTO: u16 = 0;
const OPCODE_GOTO_ON: u16 = 3;

/// A text `module_sel` command framed as a real SelectElement:
/// `{ opt0 \n opt1 \n... }`. This fixture uses it only for the follow-on
/// dialogue-style confirm; graphical `select_objbtn` has no inline labels.
fn select_command(offset: usize, opcode: u16, options: &[&str]) -> (BytecodeElement, usize) {
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

fn int_literal(value: i32) -> Vec<u8> {
    let mut raw = vec![0x24, 0xFF];
    raw.extend_from_slice(&value.to_le_bytes());
    raw
}

fn command_with_args(
    offset: usize,
    module_type: u8,
    module_id: u8,
    opcode: u16,
    args: &[Vec<u8>],
) -> (BytecodeElement, usize) {
    let mut raw = vec![
        0x23,
        module_type,
        module_id,
        opcode as u8,
        (opcode >> 8) as u8,
        args.len() as u8,
        0,
        0,
        b'(',
    ];
    for (index, arg) in args.iter().enumerate() {
        if index > 0 {
            raw.push(b',');
        }
        raw.extend_from_slice(arg);
    }
    raw.push(b')');
    let byte_len = raw.len();
    (
        BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            arg_count: args.len() as u16,
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

fn foreground_button_object(offset: usize, slot: i32, asset_key: &str) -> (BytecodeElement, usize) {
    command_with_args(
        offset,
        0,
        OBJ_FG_CREATION_ID,
        1000,
        &[
            int_literal(slot),
            asset_key.as_bytes().to_vec(),
            int_literal(1),
        ],
    )
}

/// Bind a pre-existing foreground object with rlvm's exact five-int
/// `objButtonOpts(buf, action, se, group, button_number)` shape.
fn obj_button_opts(
    offset: usize,
    slot: i32,
    group: i32,
    button_number: i32,
) -> (BytecodeElement, usize) {
    command_with_args(
        offset,
        OBJ_FG_MODULE_TYPE,
        OBJ_FG_MODULE_ID,
        OPCODE_OBJ_BUTTON_OPTS,
        &[
            int_literal(slot),
            int_literal(0),
            int_literal(0),
            int_literal(group),
            int_literal(button_number),
        ],
    )
}

/// A canonical graphical select: `select_objbtn(group)`, with no inline
/// SelectElement option labels. The foreground objects bound above are its
/// complete option source.
fn select_objbtn_command(offset: usize, group: i32) -> (BytecodeElement, usize) {
    command_with_args(
        offset,
        SEL_MODULE_TYPE,
        SEL_MODULE_ID,
        OPCODE_SELECT_OBJBTN,
        &[int_literal(group)],
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

// The three costume options (clothing-box image grid). Staged English
// labels — the product output; the costume icon art is a follow-up.
// Paren-free labels: the SelectElement parser treats `(` / `)` as the
// start of a value expression, so option labels must avoid them.
const COSTUME_A: &str = "Swimsuit high leg";
const COSTUME_B: &str = "Qipao dress";
const COSTUME_C: &str = "School uniform";
const COSTUMES: [&str; 3] = [COSTUME_A, COSTUME_B, COSTUME_C];
const COSTUME_BUTTON_GROUP: i32 = 17;

// The reaction message each costume pick leads into (branch K output).
const REACTION_A: &str = "The high-leg swimsuit draws a sharp look.";
const REACTION_B: &str = "The qipao fits with quiet elegance.";
const REACTION_C: &str = "The school uniform reads as familiar.";

// The follow-on dialogue-style confirm options + outcomes.
const CONFIRM_KEEP: &str = "Leave it as it is";
const CONFIRM_REDO: &str = "Think it over a little more";
const OUTCOME_KEPT: &str = "The costume is settled.";
const OUTCOME_REDO: &str = "Back to the wardrobe for another look.";

/// Build the image-grid clothing-select scene: three foreground objects bound
/// to one `objButtonOpts` group → `select_objbtn(group)` → per-costume
/// reaction → a converged dialogue-style confirm select → confirm outcome.
///
/// Layout (byte offsets computed as we lay elements down):
///   [foreground objects + objButtonOpts] [grid select_objbtn(group)]
///   [goto_on -> rA/rB/rC]
///   rA: textout REACTION_A; goto CONFIRM
///   rB: textout REACTION_B; goto CONFIRM
///   rC: textout REACTION_C; goto CONFIRM
///   CONFIRM: [confirm select] [goto_on -> keep/redo]
///   keep: textout OUTCOME_KEPT; goto END
///   redo: textout OUTCOME_REDO; goto END
///   END
fn build_clothing_select_engine() -> ReplayEngine {
    let mut offset = 0usize;

    let (costume_a_object, costume_a_object_len) = foreground_button_object(offset, 10, COSTUME_A);
    offset += costume_a_object_len;
    // Display order is slot order, while selection returns button_number:
    // A=2, B=0, C=1 proves `$store` receives the binding, not display index.
    let (costume_a_opts, costume_a_opts_len) = obj_button_opts(offset, 10, COSTUME_BUTTON_GROUP, 2);
    offset += costume_a_opts_len;
    let (costume_b_object, costume_b_object_len) = foreground_button_object(offset, 11, COSTUME_B);
    offset += costume_b_object_len;
    let (costume_b_opts, costume_b_opts_len) = obj_button_opts(offset, 11, COSTUME_BUTTON_GROUP, 0);
    offset += costume_b_opts_len;
    let (costume_c_object, costume_c_object_len) = foreground_button_object(offset, 12, COSTUME_C);
    offset += costume_c_object_len;
    let (costume_c_opts, costume_c_opts_len) = obj_button_opts(offset, 12, COSTUME_BUTTON_GROUP, 1);
    offset += costume_c_opts_len;

    let (grid_el, grid_len) = select_objbtn_command(offset, COSTUME_BUTTON_GROUP);
    offset += grid_len;

    let grid_goto_on_offset = offset;
    let (_probe, grid_goto_on_len) = goto_on_store(grid_goto_on_offset, vec![0, 0, 0]);
    offset += grid_goto_on_len;

    // Three reaction branches, each: textout + goto CONFIRM.
    let ra = offset;
    let (ra_text, ra_text_len) = textout(ra, REACTION_A);
    offset += ra_text_len;
    let ra_goto_offset = offset;
    let (_p, ra_goto_len) = goto_command(ra_goto_offset, 0);
    offset += ra_goto_len;

    let rb = offset;
    let (rb_text, rb_text_len) = textout(rb, REACTION_B);
    offset += rb_text_len;
    let rb_goto_offset = offset;
    let (_p, rb_goto_len) = goto_command(rb_goto_offset, 0);
    offset += rb_goto_len;

    let rc = offset;
    let (rc_text, rc_text_len) = textout(rc, REACTION_C);
    offset += rc_text_len;
    let rc_goto_offset = offset;
    let (_p, rc_goto_len) = goto_command(rc_goto_offset, 0);
    offset += rc_goto_len;

    // The follow-on dialogue-style confirm select (2 text options).
    let confirm_offset = offset;
    let (confirm_el, confirm_len) = select_command(
        confirm_offset,
        SEL_OPCODE_SELECT,
        &[CONFIRM_KEEP, CONFIRM_REDO],
    );
    offset += confirm_len;

    let confirm_goto_on_offset = offset;
    let (_p, confirm_goto_on_len) = goto_on_store(confirm_goto_on_offset, vec![0, 0]);
    offset += confirm_goto_on_len;

    // Two confirm outcomes, each: textout + goto END.
    let keep = offset;
    let (keep_text, keep_text_len) = textout(keep, OUTCOME_KEPT);
    offset += keep_text_len;
    let keep_goto_offset = offset;
    let (_p, keep_goto_len) = goto_command(keep_goto_offset, 0);
    offset += keep_goto_len;

    let redo = offset;
    let (redo_text, redo_text_len) = textout(redo, OUTCOME_REDO);
    offset += redo_text_len;
    let redo_goto_offset = offset;
    let (_p, redo_goto_len) = goto_command(redo_goto_offset, 0);
    offset += redo_goto_len;

    let end = offset as u32;

    // Now the real elements with resolved jump targets.
    // `goto_on($store)` indexes by button_number, not display index:
    // B=0, C=1, A=2.
    let (grid_goto_on, _) =
        goto_on_store(grid_goto_on_offset, vec![rb as u32, rc as u32, ra as u32]);
    let (ra_goto, _) = goto_command(ra_goto_offset, confirm_offset as u32);
    let (rb_goto, _) = goto_command(rb_goto_offset, confirm_offset as u32);
    let (rc_goto, _) = goto_command(rc_goto_offset, confirm_offset as u32);
    let (confirm_goto_on, _) =
        goto_on_store(confirm_goto_on_offset, vec![keep as u32, redo as u32]);
    let (keep_goto, _) = goto_command(keep_goto_offset, end);
    let (redo_goto, _) = goto_command(redo_goto_offset, end);

    let scene = Scene::new(
        1,
        vec![
            costume_a_object,
            costume_a_opts,
            costume_b_object,
            costume_b_opts,
            costume_c_object,
            costume_c_opts,
            grid_el,
            grid_goto_on,
            ra_text,
            ra_goto,
            rb_text,
            rb_goto,
            rc_text,
            rc_goto,
            confirm_el,
            confirm_goto_on,
            keep_text,
            keep_goto,
            redo_text,
            redo_goto,
        ],
    )
    .expect("clothing-select scene builds");

    let mut store = InMemorySceneStore::new();
    store.insert(scene);

    let mut shift_jis: HashSet<(u16, u32)> = HashSet::new();
    for off in [ra, rb, rc, keep, redo] {
        shift_jis.insert((1, off as u32));
    }
    ReplayEngine::from_store(store, shift_jis)
}

fn opts() -> ReplayOpts {
    ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    }
}

/// Text-choice lines emitted by the follow-on confirm, tagged `choice:<idx>`.
/// The graphical object-button prompt itself emits no text-choice lines.
fn observed_choice_lines(
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

fn observed_object_button_prompt(engine: &ReplayEngine) -> (i32, Vec<(u16, i32, usize)>) {
    let observation = engine.observe_for_port(1, &opts());
    let object_prompts: Vec<_> = observation
        .selection_prompts
        .into_iter()
        .filter_map(|prompt| match prompt.kind {
            SelectionPromptKind::ObjectButtons { group, options } => Some((
                group,
                options
                    .into_iter()
                    .map(|option| (option.display_index, option.button_number, option.fg_slot))
                    .collect(),
            )),
            SelectionPromptKind::Text => None,
        })
        .collect();
    assert_eq!(
        object_prompts.len(),
        1,
        "one graphical object-button prompt"
    );
    object_prompts.into_iter().next().expect("object prompt")
}

/// Non-choice (branch) messages the resolved path leads into.
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

// RECOGNIZE: the image-grid select is the object-button `(0,2,4)` variant.
// Because a `select_objbtn` op is itself a button-object SelectionControl
// setup and foreground `objButtonOpts` bindings, the scene exposes a real
// object-button prompt → a graphical modality (the ≥3 placed buttons lay out
// as an image grid). The modality is derived from the REAL SelectionControl
// signal, NOT the option count. The graphical prompt has no `choice:<idx>`
// text lines; only the follow-on text confirm does.

#[test]
fn image_grid_select_is_objbtn_and_classifies_graphical_from_the_signal() {
    let (grid_el, _) = select_objbtn_command(0, COSTUME_BUTTON_GROUP);
    let BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        raw_bytes,
        ..
    } = &grid_el
    else {
        panic!("select_objbtn is a Command");
    };
    // Recognition: the image-grid select is the object-button opcode
    // (0,2,4) — the REAL rlvm value.
    assert_eq!(
        (*module_type, *module_id, *opcode),
        (SEL_MODULE_TYPE, SEL_MODULE_ID, OPCODE_SELECT_OBJBTN),
        "image-grid select is sel.select_objbtn at the real (0,2,4)"
    );
    assert!(
        extract_select_choice_texts(raw_bytes).is_empty(),
        "canonical select_objbtn(group) carries no inline text options"
    );

    // Interpretation: a `select_objbtn` plus its foreground object bindings
    // is a `ButtonObject` prompt; with ≥3 placed option-buttons the layout is
    // the IMAGE GRID.
    let signal = selection_control_signal([*opcode]);
    assert_eq!(
        select_modality(signal, COSTUMES.len()),
        SelectModality::ImageGrid
    );

    let engine = build_clothing_select_engine();
    assert_eq!(
        observed_object_button_prompt(&engine),
        (
            COSTUME_BUTTON_GROUP,
            vec![(0, 2, 10), (1, 0, 11), (2, 1, 12)]
        ),
        "the graphical prompt must come from foreground objButtonOpts bindings"
    );

    // The only `choice:<idx>` surfaces belong to the follow-on TEXT confirm;
    // the graphical select emits its object-button prompt instead.
    let lines = observed_choice_lines(&engine, HeadlessChoicePolicy::Scripted(vec![0, 0]));
    let surfaces: Vec<&str> = lines.iter().map(|(_, s)| s.as_str()).collect();
    assert_eq!(
        surfaces,
        vec!["choice:0", "choice:1"],
        "only the follow-on text confirm emits text-choice surfaces"
    );
}

// ACT: selecting box K drives branch K (not always-first), AND the
// follow-on confirm step resolves independently.

#[test]
fn selecting_box_k_drives_branch_k_and_the_confirm_resolves() {
    let engine = build_clothing_select_engine();

    // Pick costume 0 then KEEP: reaction A + kept outcome.
    let a_keep = observed_branch_messages(&engine, HeadlessChoicePolicy::Scripted(vec![0, 0]));
    // Pick costume 1 then KEEP: reaction B (DIFFERENT branch) + kept.
    let b_keep = observed_branch_messages(&engine, HeadlessChoicePolicy::Scripted(vec![1, 0]));
    // Pick costume 2 then KEEP: reaction C + kept.
    let c_keep = observed_branch_messages(&engine, HeadlessChoicePolicy::Scripted(vec![2, 0]));
    // Pick costume 0 then REDO: reaction A + redo outcome (confirm resolves
    // DIFFERENTLY on the same image branch).
    let a_redo = observed_branch_messages(&engine, HeadlessChoicePolicy::Scripted(vec![0, 1]));

    assert_eq!(
        a_keep,
        vec![REACTION_A.to_string(), OUTCOME_KEPT.to_string()]
    );
    assert_eq!(
        b_keep,
        vec![REACTION_B.to_string(), OUTCOME_KEPT.to_string()]
    );
    assert_eq!(
        c_keep,
        vec![REACTION_C.to_string(), OUTCOME_KEPT.to_string()]
    );
    assert_eq!(
        a_redo,
        vec![REACTION_A.to_string(), OUTCOME_REDO.to_string()]
    );

    // Load-bearing: the three BOXES drive DIFFERENT reactions. A regression
    // that ignored the box (always-first) would make all three equal.
    assert_ne!(a_keep, b_keep, "box K must drive branch K (K -> costume K)");
    assert_ne!(b_keep, c_keep, "box K must drive branch K (K -> costume K)");
    // Load-bearing: the follow-on CONFIRM resolves independently — same
    // image branch (A), different confirm choice, different outcome.
    assert_ne!(
        a_keep, a_redo,
        "the follow-on confirm must resolve (keep vs. redo -> different outcome)"
    );
}

// RENDER: a horizontal strip of >=2 costume-icon boxes with a selected
// box (bright/chromatic) vs. unselected (dim grayscale); selecting box 0
// vs. box 1 renders DIFFERENT frames; the follow-on confirm renders as a
// standard dialogue-style ChoiceWindow.

const SCREEN: (u32, u32) = (1280, 720);

fn pixel_at(fb: &Framebuffer, x: u32, y: u32) -> [u8; RGBA_BYTES_PER_PIXEL] {
    let off = ((y as usize) * (fb.width() as usize) + x as usize) * RGBA_BYTES_PER_PIXEL;
    let px = &fb.pixels()[off..off + RGBA_BYTES_PER_PIXEL];
    [px[0], px[1], px[2], px[3]]
}

fn is_grayish(px: [u8; RGBA_BYTES_PER_PIXEL], tol: i32) -> bool {
    let (r, g, b) = (px[0] as i32, px[1] as i32, px[2] as i32);
    (r - g).abs() <= tol && (g - b).abs() <= tol && (r - b).abs() <= tol
}

fn grid_frame(options: &[String], selected: usize) -> (Framebuffer, ImageGridChoiceWindow) {
    let mut fb = Framebuffer::new(SCREEN.0, SCREEN.1);
    fb.fill(WipeColour::opaque_rgb(0x10, 0x12, 0x1a));
    let grid = ImageGridChoiceWindow::from_options(options, selected, SCREEN);
    let painted = fb.draw_image_grid_choice_window(&grid);
    assert!(painted > 0, "the selected box's caption must paint");
    (fb, grid)
}

#[test]
fn image_grid_renders_a_strip_with_a_moving_highlight() {
    let options: Vec<String> = COSTUMES.iter().map(ToString::to_string).collect();

    let (fb0, grid0) = grid_frame(&options, 0);
    let (fb1, grid1) = grid_frame(&options, 1);

    // Three boxes laid out as a horizontal strip (a grid, not a vertical
    // list): distinct, non-overlapping, left-to-right columns sharing the
    // vertical band.
    assert_eq!(grid0.cells.len(), 3, "all three costume boxes present");
    let c0 = &grid0.cells[0];
    let c1 = &grid0.cells[1];
    let c2 = &grid0.cells[2];
    assert!(c1.x >= c0.x + c0.w, "box 1 is right of box 0 (horizontal)");
    assert!(c2.x >= c1.x + c1.w, "box 2 is right of box 1 (horizontal)");
    assert_eq!(c0.y, c1.y, "boxes share the vertical band (a strip)");
    assert_eq!(c1.y, c2.y, "boxes share the vertical band (a strip)");
    assert_eq!(grid0.selected, 0);
    assert_eq!(grid1.selected, 1);

    // Sample the centre of boxes 0 and 1. Box-0-selected frame: box 0 full
    // colour (chromatic), box 1 desaturated (grayish); box-1-selected frame
    // flips it.
    let s0 = (c0.x + c0.w / 2, c0.y + c0.h / 2);
    let s1 = (c1.x + c1.w / 2, c1.y + c1.h / 2);

    let f0_b0 = pixel_at(&fb0, s0.0, s0.1);
    let f0_b1 = pixel_at(&fb0, s1.0, s1.1);
    let f1_b0 = pixel_at(&fb1, s0.0, s0.1);
    let f1_b1 = pixel_at(&fb1, s1.0, s1.1);

    assert!(
        !is_grayish(f0_b0, 12),
        "box-0-selected: box 0 is full colour, got {f0_b0:?}"
    );
    assert!(
        is_grayish(f0_b1, 12),
        "box-0-selected: box 1 is desaturated grayscale, got {f0_b1:?}"
    );
    assert!(
        is_grayish(f1_b0, 12),
        "box-1-selected: box 0 is desaturated grayscale, got {f1_b0:?}"
    );
    assert!(
        !is_grayish(f1_b1, 12),
        "box-1-selected: box 1 is full colour, got {f1_b1:?}"
    );
    // The SAME box changes colour/grayscale state as the selection moves.
    assert_ne!(
        f0_b0, f1_b0,
        "box 0's pixels differ between selected and unselected"
    );

    // The two full frames differ (the highlight moved). A not-rendered
    // selection-ignored / always-first render regression makes the frames
    // equal and FAILS here.
    let png0 = encode_png_rgba_deterministic(&fb0);
    let png1 = encode_png_rgba_deterministic(&fb1);
    assert_ne!(
        png0, png1,
        "selecting a different box must render a DIFFERENT frame"
    );
    assert_eq!(&png0[..4], &[0x89, 0x50, 0x4E, 0x47], "valid PNG magic");

    // The selected box's NAME is the caption shown.
    assert_eq!(grid0.char_count(), COSTUME_A.chars().count());
    assert_eq!(grid1.char_count(), COSTUME_B.chars().count());
}

#[test]
fn follow_on_confirm_renders_as_a_dialogue_style_choice_window() {
    // The confirm step is a standard dialogue-style text select — rendered
    // by the SAME ChoiceWindow the text-select modality uses (reuse, not a
    // new act mechanism). Two options, the selected one cursor-marked.
    let ini = b"#SCREENSIZE_MOD=0,1280,720\r\n\
        #DEFAULT_SEL_WINDOW=031\r\n\
        #WINDOW.031.POS=0:120,200\r\n\
        #WINDOW.031.ATTR_MOD=1\r\n\
        #WINDOW.031.ATTR=24,36,66,225,0\r\n\
        #WINDOW.031.MOJI_SIZE=30\r\n\
        #WINDOW.031.MOJI_POS=22,12,32,32\r\n\
        #WINDOW.031.MOJI_CNT=28,6\r\n\
        #WINDOW.031.MOJI_REP=0,16\r\n";
    let gameexe = utsushi_reallive::Gameexe::parse(ini).expect("parse gameexe");
    let sel_config: MessageWindowConfig = gameexe.sel_window();
    let screen = gameexe.screen_size_px();
    let options = vec![CONFIRM_KEEP.to_string(), CONFIRM_REDO.to_string()];

    let mut fb = Framebuffer::new(screen.0, screen.1);
    fb.fill(WipeColour::opaque_rgb(0x14, 0x18, 0x26));
    let cw = ChoiceWindow::from_config(&options, 0, &sel_config, screen, screen);
    let painted = fb.draw_choice_window(&cw);
    assert!(painted > 0, "confirm choice glyphs must paint");
    assert_eq!(cw.options.len(), 2, "confirm offers two options");
    assert_eq!(cw.selected, 0);

    // Selecting the other confirm option renders a different frame (the
    // cursor/highlight moved) — the confirm's selection is not ignored.
    let mut fb1 = Framebuffer::new(screen.0, screen.1);
    fb1.fill(WipeColour::opaque_rgb(0x14, 0x18, 0x26));
    let cw1 = ChoiceWindow::from_config(&options, 1, &sel_config, screen, screen);
    fb1.draw_choice_window(&cw1);
    let png0 = encode_png_rgba_deterministic(&fb);
    let png1 = encode_png_rgba_deterministic(&fb1);
    assert_ne!(png0, png1, "the confirm cursor must move between options");
}
