//! `utsushi-choice-render-and-act-fidelity` — the ALPHA playable-minimum
//! CAPSTONE proof that a scene's `select` prompt (a) RENDERS its options as
//! a selection screen and (b) that ACTING on option K drives the branch for
//! option K.
//!
//! The scene is a hand-laid synthetic select-block (fast + deterministic
//! CI-friendly) that exercises the REAL seams, not a shortcut:
//!
//! * The `select` command is framed exactly as RealLive's SelectElement
//!   (`{ option \n option }`), so the VM's real
//!   [`extract_select_choice_texts`] path — the one a real Seen.txt would
//!   hit — pulls the option labels out of the `{... }` block and feeds them
//!   to the choice op, which emits them through the substrate text sink
//!   (tagged `text_surface = "choice:<idx>"`).
//! * The choice resolves through the substrate
//!   [`HeadlessInputScheduler`] + [`HeadlessChoicePolicy`] (NOT a private
//!   wait loop): `Fixed(K)` writes K into the store register, and the
//!   following `goto_on($store, { t0, t1 })` jumps to the branch for K.
//!
//! RENDER proof: the observed choice-option lines lay out into a
//! [`ChoiceWindow`] inside the Gameexe sel-window box; the frame lists ALL
//! options and paints > 0 glyph pixels (a not-rendered regression fails)
//! and choosing option 0 vs 1 highlights DIFFERENT rows (distinct pixels).
//!
//! ACT proof: `branch_following_lines(Fixed(0))` vs `Fixed(1)` yield
//! DIFFERENT subsequent branch messages (a selection-ignored / always-first
//! regression fails).

use std::collections::HashSet;

use utsushi_reallive::bytecode_element::BytecodeElement;
use utsushi_reallive::vm::{InMemorySceneStore, Scene};
use utsushi_reallive::{
    ChoiceWindow, Framebuffer, Gameexe, HeadlessChoicePolicy, MessageWindowConfig, RenderPass,
    ReplayEngine, ReplayOpts, SEL_MODULE_ID, SEL_MODULE_TYPE, SEL_OPCODE_SELECT,
    encode_png_rgba_deterministic, extract_select_choice_texts,
};

// -- Byte constants for the hand-laid select / goto_on / textout scene ------

const META_LINE_LEAD: u8 = 0x0A;
const SELECT_BLOCK_OPEN: u8 = 0x7B; // '{'
const SELECT_BLOCK_CLOSE: u8 = 0x7D; // '}'
const STORE_REGISTER: [u8; 2] = [0x24, 0xC8]; // `$\xC8` — store-register ref
const MODULE_JMP_TYPE: u8 = 0;
const MODULE_JMP_ID: u8 = 1;
const OPCODE_GOTO: u16 = 0;
const OPCODE_GOTO_ON: u16 = 3;

/// A `module_sel.select` command framed as a real SelectElement:
/// `{ opt0 \n opt1 }`. The option labels live in the `{... }` block, NOT a
/// `(...)` arg list — exactly the framing `extract_select_choice_texts`
/// walks on real bytes.
fn select_command(offset: usize, options: &[&str]) -> (BytecodeElement, usize) {
    let opcode = SEL_OPCODE_SELECT;
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
            // `\n`+i16 line marker separating sibling options.
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

/// `goto_on($store, { t0, t1,... })` — indexed jump keyed by the store
/// register (the resolved choice index). The `($\xC8)` value expression
/// lives in the `(...)` arg list; the jump targets are carried in
/// `goto_targets` (the trailing pointers the decoder frames outside `(...)`).
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
    // `($\xC8)` — the store-register value expression.
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

/// A `goto(target)` element (header + one trailing i32 target).
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
    let byte_len = 8 + 4; // header + one i32 pointer
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

/// An ASCII textout run (decodes cleanly as Shift-JIS). The caller records
/// its `(scene, offset)` in the drive's Shift-JIS textout set so it flushes
/// a `TextLine`.
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

const OPTION_LEFT: &str = "Follow the quiet path";
const OPTION_RIGHT: &str = "Take the loud road";
const BRANCH_0_MSG: &str = "The quiet path unwinds ahead of you.";
const BRANCH_1_MSG: &str = "The loud road roars to meet you.";

/// Build the two-branch select scene + the Shift-JIS textout offset set.
///
/// Layout (offsets computed from element lengths):
///   @0 select { LEFT \n RIGHT }
///   @s goto_on($store, { t0, t1 })
///   @t0 textout BRANCH_0; goto END
///   @t1 textout BRANCH_1; goto END
fn build_choice_engine() -> ReplayEngine {
    let mut offset = 0usize;
    let (select_el, select_len) = select_command(offset, &[OPTION_LEFT, OPTION_RIGHT]);
    offset += select_len;

    // Targets are patched after we know the layout, so lay elements first
    // with placeholder targets, then rebuild with the real offsets.
    let goto_on_offset = offset;
    // Provisional to measure goto_on length.
    let (_probe, goto_on_len) = goto_on_store(goto_on_offset, vec![0, 0]);
    offset += goto_on_len;

    let t0 = offset;
    let (textout0, t0_text_len) = textout(t0, BRANCH_0_MSG);
    offset += t0_text_len;
    let (_probe_goto0, goto0_len) = goto_command(offset, 0); // END patched below
    offset += goto0_len;

    let t1 = offset;
    let (textout1, t1_text_len) = textout(t1, BRANCH_1_MSG);
    offset += t1_text_len;
    let goto1_offset = offset;
    let (_probe1, goto1_len) = goto_command(goto1_offset, 0);
    offset += goto1_len;

    let end = offset as u32; // bytecode_len ⇒ is_past_end ⇒ EndOfScene

    // Rebuild the jump-carrying elements with the resolved targets.
    let (goto_on_el, _) = goto_on_store(goto_on_offset, vec![t0 as u32, t1 as u32]);
    let (goto0_el, _) = goto_command(t0 + t0_text_len, end);
    let (goto1_el, _) = goto_command(goto1_offset, end);

    let scene = Scene::new(
        1,
        vec![
            select_el, goto_on_el, textout0, goto0_el, textout1, goto1_el,
        ],
    )
    .expect("choice scene builds");

    let mut store = InMemorySceneStore::new();
    store.insert(scene);

    // Mark both branch textouts so the drive flushes their lines.
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

/// Pull the option labels back out of the play-order stream (the lines the
/// `select` op emitted, tagged `choice:<idx>`), in index order.
fn observed_choice_options(engine: &ReplayEngine, policy: HeadlessChoicePolicy) -> Vec<String> {
    engine
        .branch_following_lines(1, &opts(), policy)
        .into_iter()
        .filter(|line| {
            line.text_surface
                .as_deref()
                .is_some_and(|s| s.starts_with("choice:"))
        })
        .map(|line| line.text)
        .collect()
}

/// Non-choice branch messages the resolved choice led into.
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

// ACT: selecting option K drives branch K

#[test]
fn extract_select_choice_texts_pulls_both_options_from_the_block() {
    // The raw SelectElement `{... }` framing yields exactly the two option
    // labels — the seam a real Seen.txt hits.
    let (select_el, _) = select_command(0, &[OPTION_LEFT, OPTION_RIGHT]);
    let BytecodeElement::Command { raw_bytes, .. } = &select_el else {
        panic!("select is a Command");
    };
    let choices = extract_select_choice_texts(raw_bytes);
    let decoded: Vec<String> = choices
        .iter()
        .map(|bytes| String::from_utf8(bytes.clone()).expect("ascii"))
        .collect();
    assert_eq!(
        decoded,
        vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()]
    );
}

#[test]
fn selecting_option_k_drives_branch_k_not_always_first() {
    let engine = build_choice_engine();

    let branch_0 = observed_branch_messages(&engine, HeadlessChoicePolicy::Fixed(0));
    let branch_1 = observed_branch_messages(&engine, HeadlessChoicePolicy::Fixed(1));

    assert_eq!(
        branch_0,
        vec![BRANCH_0_MSG.to_string()],
        "choosing option 0 must lead into branch 0's message"
    );
    assert_eq!(
        branch_1,
        vec![BRANCH_1_MSG.to_string()],
        "choosing option 1 must lead into branch 1's message"
    );
    // The load-bearing non-vacuous assertion: the branches DIFFER. A
    // regression that ignored the selection (always-first) would make both
    // equal BRANCH_0 and FAIL here.
    assert_ne!(
        branch_0, branch_1,
        "selecting option K must drive DIFFERENT subsequent messages (K → branch K)"
    );
}

// RENDER: the select prompt renders all options as a selection screen

fn sel_config() -> (MessageWindowConfig, (u32, u32)) {
    // A real-shaped Gameexe: DEFAULT_SEL_WINDOW picks the #WINDOW set that
    // frames the choice list — config-driven placement, nothing hardcoded.
    let ini = b"#SCREENSIZE_MOD=0,1280,720\r\n\
        #DEFAULT_SEL_WINDOW=031\r\n\
        #WINDOW.031.POS=0:80,220\r\n\
        #WINDOW.031.ATTR_MOD=1\r\n\
        #WINDOW.031.ATTR=20,32,60,220,0\r\n\
        #WINDOW.031.MOJI_SIZE=28\r\n\
        #WINDOW.031.MOJI_POS=16,8,24,24\r\n\
        #WINDOW.031.MOJI_CNT=30,6\r\n\
        #WINDOW.031.MOJI_REP=0,10\r\n";
    let gameexe = Gameexe::parse(ini).expect("parse gameexe");
    assert_eq!(gameexe.sel_window_index(), 31, "reads #DEFAULT_SEL_WINDOW");
    (gameexe.sel_window(), gameexe.screen_size_px())
}

#[test]
fn choice_screen_renders_all_options_with_a_moving_cursor() {
    let engine = build_choice_engine();
    // The options rendered are the REAL ones the select op emitted.
    let options = observed_choice_options(&engine, HeadlessChoicePolicy::Fixed(0));
    assert_eq!(
        options,
        vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()],
        "the observed choice-option lines are the two select options"
    );

    let (config, screen) = sel_config();
    let frame_size = screen;

    // A choice window focused on option 0, and one on option 1.
    let cw0 = ChoiceWindow::from_config(&options, 0, &config, screen, frame_size);
    let cw1 = ChoiceWindow::from_config(&options, 1, &config, screen, frame_size);

    // Both windows list ALL options.
    assert_eq!(cw0.options.len(), 2);
    assert_eq!(cw1.options.len(), 2);
    assert_eq!(cw0.selected, 0);
    assert_eq!(cw1.selected, 1);

    // The flat emittable layer lists every option (a not-rendered
    // regression — empty list — fails).
    let layer0 = cw0.to_text_layer();
    assert_eq!(layer0.lines.len(), 2, "every option is a line");
    assert!(
        layer0.lines[0].contains(OPTION_LEFT) && layer0.lines[1].contains(OPTION_RIGHT),
        "both option labels are legible in the layer"
    );
    // The cursor marker is on the focused option only.
    assert!(
        layer0.lines[0].starts_with("> "),
        "cursor on focused option 0"
    );
    assert!(layer0.lines[1].starts_with("  "), "no cursor on option 1");

    // Render both to a framebuffer: each paints > 0 glyph pixels (non-vacuous)
    // and the two selections produce DIFFERENT pixels (cursor + highlight
    // moved).
    let mut fb0 = Framebuffer::new(frame_size.0, frame_size.1);
    fb0.fill(utsushi_reallive::WipeColour::opaque_rgb(0x12, 0x16, 0x22));
    let painted0 = fb0.draw_choice_window(&cw0);
    assert!(painted0 > 0, "choice option glyphs must paint");

    let mut fb1 = Framebuffer::new(frame_size.0, frame_size.1);
    fb1.fill(utsushi_reallive::WipeColour::opaque_rgb(0x12, 0x16, 0x22));
    let painted1 = fb1.draw_choice_window(&cw1);
    assert!(painted1 > 0, "choice option glyphs must paint");

    let png0 = encode_png_rgba_deterministic(&fb0);
    let png1 = encode_png_rgba_deterministic(&fb1);
    assert_ne!(
        png0, png1,
        "selecting a different option must render a DIFFERENT frame (cursor moved)"
    );
    // Valid PNG magic.
    assert_eq!(&png0[..4], &[0x89, 0x50, 0x4E, 0x47]);
}

#[test]
fn choice_frame_emits_a_frame_artifact_like_the_message_window() {
    // The choice screen flows through the SAME FrameArtifact emit path a
    // message-window frame uses (`emit_localized_screenshot`), proving a
    // choice frame is announced through the substrate frame sink.
    use utsushi_core::RuntimeArtifactRoot;
    use utsushi_reallive::{GraphicsObjectStack, RecordingFrameArtifactSink};

    let (config, screen) = sel_config();
    let options = vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()];
    let cw = ChoiceWindow::from_config(&options, 1, &config, screen, screen);
    let layer = cw.to_text_layer();

    let mut pass = RenderPass::with_dimensions(screen.0, screen.1).expect("render pass");
    let sink = RecordingFrameArtifactSink::new();
    let dir = std::env::temp_dir().join(format!(
        "utsushi-choice-frame-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = RuntimeArtifactRoot::new(dir);
    root.prepare().expect("prepare artifact root");

    let stack = GraphicsObjectStack::new();
    let artifact = pass
        .emit_localized_screenshot(&stack, &layer, &root, "choice-frame-smoke", &sink)
        .expect("choice frame emits");
    assert_eq!(sink.frames().len(), 1, "one choice FrameArtifact announced");
    assert_eq!(artifact.width, Some(screen.0));
    assert_eq!(artifact.height, Some(screen.1));
}
