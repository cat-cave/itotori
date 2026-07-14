//! Choice-render + choice-act diagnostic renderer
//! (`utsushi-choice-render-and-act-fidelity`).
//!
//! Renders the frames the orchestrator visually verifies that a `select`
//! prompt (a) presents its options as a selection SCREEN and (b) that
//! choosing option K drives the branch for option K:
//!
//!   * a CHOICE screen with option 0 focused (cursor + highlight), then the
//!     branch-0 message it leads into, then a CHOICE screen with option 1
//!     focused, then the branch-1 message — a four-panel montage proving
//!     `select option K → branch K`.
//!
//! The selection window box (position / colour / alpha / font-size / insets)
//! is driven from the real Gameexe `#DEFAULT_SEL_WINDOW` → `#WINDOW.NNN`
//! set (nothing hardcoded). The option / branch TEXT is staged English (the
//! product output — legible in the real config-driven box); the layout, the
//! selection cursor, and the branch correspondence are the real engine
//! behaviour. A synthetic select-block drives the ACT half deterministically
//! (a real-bytes choice was not cheaply reachable; the same seams run).
//!
//! Run:
//!   cargo run -p utsushi-reallive --example choice_diag -- <out.png>
//!   (defaults to.private-render/diag/choice-render.png)

use std::collections::HashSet;
use std::path::PathBuf;

use utsushi_reallive::bytecode_element::BytecodeElement;
use utsushi_reallive::vm::{InMemorySceneStore, Scene};
use utsushi_reallive::{
    ChoiceWindow, Framebuffer, Gameexe, HeadlessChoicePolicy, MessageWindowConfig, RedactionPolicy,
    RenderPass, ReplayEngine, ReplayOpts, SEL_MODULE_ID, SEL_MODULE_TYPE, SEL_OPCODE_SELECT,
    TextLayer, TextoutEncoding, WipeColour, encode_png_rgba_deterministic,
};

const META_LINE_LEAD: u8 = 0x0A;
const SELECT_BLOCK_OPEN: u8 = 0x7B;
const SELECT_BLOCK_CLOSE: u8 = 0x7D;
const STORE_REGISTER: [u8; 2] = [0x24, 0xC8];

const OPTION_LEFT: &str = "Follow the quiet path";
const OPTION_RIGHT: &str = "Take the loud road";
const BRANCH_0_MSG: &str = "The quiet path unwinds ahead of you.";
const BRANCH_1_MSG: &str = "The loud road roars to meet you.";

fn command(
    offset: usize,
    mtype: u8,
    mid: u8,
    opcode: u16,
    tail: &[u8],
    targets: Vec<u32>,
) -> BytecodeElement {
    let argc = targets.len() as u16;
    let mut raw = vec![
        0x23,
        mtype,
        mid,
        opcode as u8,
        (opcode >> 8) as u8,
        argc as u8,
        (argc >> 8) as u8,
        0,
    ];
    raw.extend_from_slice(tail);
    let byte_len = if targets.is_empty() {
        raw.len()
    } else {
        // goto-family: byte_len must include the trailing i32 pointers even
        // though the VM reads them from `goto_targets`.
        raw.len().max(8) + targets.len() * 4
    };
    BytecodeElement::Command {
        module_type: mtype,
        module_id: mid,
        opcode,
        arg_count: argc,
        overload: 0,
        goto_targets: targets,
        goto_case_exprs: Vec::new(),
        raw_bytes: raw,
        byte_offset: offset,
        byte_len,
    }
}

fn select_block_tail(options: &[&str]) -> Vec<u8> {
    let mut tail = vec![SELECT_BLOCK_OPEN];
    for (i, option) in options.iter().enumerate() {
        if i > 0 {
            tail.extend_from_slice(&[META_LINE_LEAD, 0x00, 0x00]);
        }
        tail.extend_from_slice(option.as_bytes());
    }
    tail.push(SELECT_BLOCK_CLOSE);
    tail
}

fn textout(offset: usize, text: &str) -> BytecodeElement {
    BytecodeElement::Textout {
        encoding_hint: TextoutEncoding::Other,
        raw_bytes: text.as_bytes().to_vec(),
        byte_offset: offset,
        byte_len: text.len(),
    }
}

/// The same two-branch select scene the acceptance test drives: choosing
/// option K jumps (via `goto_on($store)`) to branch K's message.
fn build_engine() -> ReplayEngine {
    let sel_tail = select_block_tail(&[OPTION_LEFT, OPTION_RIGHT]);
    let select = command(
        0,
        SEL_MODULE_TYPE,
        SEL_MODULE_ID,
        SEL_OPCODE_SELECT,
        &sel_tail,
        Vec::new(),
    );
    let mut off = select.byte_len();

    let goto_on_off = off;
    let mut value_tail = vec![b'('];
    value_tail.extend_from_slice(&STORE_REGISTER);
    value_tail.push(b')');
    // Provisional to measure length.
    let goto_on_probe = command(goto_on_off, 0, 1, 3, &value_tail, vec![0, 0]);
    // goto_on byte_len for pc math: header + value expr (targets read from field).
    let goto_on_len = 8 + value_tail.len();
    off += goto_on_len;

    let t0 = off;
    let textout0 = textout(t0, BRANCH_0_MSG);
    off += textout0.byte_len();
    let goto0_off = off;
    off += 8 + 4;

    let t1 = off;
    let textout1 = textout(t1, BRANCH_1_MSG);
    off += textout1.byte_len();
    let goto1_off = off;
    off += 8 + 4;

    let end = off as u32;

    let goto_on = command(
        goto_on_off,
        0,
        1,
        3,
        &value_tail,
        vec![t0 as u32, t1 as u32],
    );
    // Override byte_len so pc lands on t0 after the yield/resume.
    let goto_on = match goto_on {
        BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            arg_count,
            overload,
            goto_targets,
            goto_case_exprs,
            raw_bytes,
            byte_offset,
            ..
        } => BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            arg_count,
            overload,
            goto_targets,
            goto_case_exprs,
            raw_bytes,
            byte_offset,
            byte_len: goto_on_len,
        },
        other => other,
    };
    let _ = goto_on_probe;
    let goto0 = command(goto0_off, 0, 1, 0, &[], vec![end]);
    let goto1 = command(goto1_off, 0, 1, 0, &[], vec![end]);

    let scene = Scene::new(1, vec![select, goto_on, textout0, goto0, textout1, goto1])
        .expect("scene builds");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut shift_jis: HashSet<(u16, u32)> = HashSet::new();
    shift_jis.insert((1, t0 as u32));
    shift_jis.insert((1, t1 as u32));
    ReplayEngine::from_store(store, shift_jis)
}

fn branch_message(engine: &ReplayEngine, policy: HeadlessChoicePolicy) -> String {
    let opts = ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    };
    engine
        .branch_following_lines(1, &opts, policy)
        .into_iter()
        .find(|line| {
            !line
                .text_surface
                .as_deref()
                .is_some_and(|s| s.starts_with("choice:"))
        })
        .map(|line| line.text)
        .unwrap_or_default()
}

fn choice_frame(
    config: &MessageWindowConfig,
    screen: (u32, u32),
    options: &[String],
    selected: usize,
) -> Framebuffer {
    let mut fb = Framebuffer::new(screen.0, screen.1);
    fb.fill(WipeColour::opaque_rgb(0x14, 0x18, 0x26));
    let cw = ChoiceWindow::from_config(options, selected, config, screen, screen);
    let painted = fb.draw_choice_window(&cw);
    assert!(painted > 0, "choice glyphs must paint");
    fb
}

fn message_frame(config: &MessageWindowConfig, screen: (u32, u32), text: &str) -> Framebuffer {
    let pass = RenderPass::with_dimensions(screen.0, screen.1).unwrap();
    let stack = utsushi_reallive::GraphicsObjectStack::new();
    let mut fb = pass.rasterise_with_policy(&stack, RedactionPolicy::Full);
    fb.fill(WipeColour::opaque_rgb(0x0e, 0x12, 0x1c));
    let layer = TextLayer::message_window(text, None, config, screen, screen);
    let painted = fb.draw_text(&layer);
    assert!(painted > 0, "message glyphs must paint");
    fb
}

fn main() {
    let out = std::env::args().nth(1).map_or_else(
        || PathBuf::from(".private-render/diag/choice-render.png"),
        PathBuf::from,
    );
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }

    // Real-shaped Gameexe: the sel-window box is #DEFAULT_SEL_WINDOW →
    // #WINDOW.031 (Sweetie-HD-shaped), fully config-driven.
    let ini = b"#SCREENSIZE_MOD=0,1280,720\r\n\
        #DEFAULT_SEL_WINDOW=031\r\n\
        #WINDOW.031.POS=0:120,200\r\n\
        #WINDOW.031.ATTR_MOD=1\r\n\
        #WINDOW.031.ATTR=24,36,66,225,0\r\n\
        #WINDOW.031.MOJI_SIZE=30\r\n\
        #WINDOW.031.MOJI_POS=22,12,32,32\r\n\
        #WINDOW.031.MOJI_CNT=28,6\r\n\
        #WINDOW.031.MOJI_REP=0,16\r\n\
        #WINDOW.000.POS=0:0,470\r\n\
        #WINDOW.000.ATTR_MOD=1\r\n\
        #WINDOW.000.ATTR=12,16,28,220,0\r\n\
        #WINDOW.000.MOJI_SIZE=28\r\n\
        #WINDOW.000.MOJI_POS=18,10,40,40\r\n\
        #WINDOW.000.MOJI_CNT=34,3\r\n\
        #WINDOW.000.MOJI_REP=0,8\r\n";
    let gameexe = Gameexe::parse(ini).expect("parse gameexe");
    let sel_config = gameexe.sel_window();
    let msg_config = gameexe.message_window(0);
    let screen = gameexe.screen_size_px();
    println!(
        "sel_window_index={} sel box origin={} pos=({},{}) attr={:?} moji={}",
        gameexe.sel_window_index(),
        sel_config.origin,
        sel_config.pos_x,
        sel_config.pos_y,
        sel_config.attr_rgba,
        sel_config.moji_size,
    );

    // Drive the ACT half so the branch messages are the REAL resolved
    // branches, not hand-typed.
    let engine = build_engine();
    let options = vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()];
    let branch0 = branch_message(&engine, HeadlessChoicePolicy::Fixed(0));
    let branch1 = branch_message(&engine, HeadlessChoicePolicy::Fixed(1));
    println!("branch0={branch0:?} branch1={branch1:?}");
    assert_ne!(branch0, branch1, "K → different branch");

    // Four-panel montage: choice(0) → branch0 → choice(1) → branch1.
    let panels = [
        choice_frame(&sel_config, screen, &options, 0),
        message_frame(&msg_config, screen, &branch0),
        choice_frame(&sel_config, screen, &options, 1),
        message_frame(&msg_config, screen, &branch1),
    ];
    let gap = 10u32;
    let n = panels.len() as u32;
    let mut sheet = Framebuffer::new(screen.0, screen.1 * n + gap * (n - 1));
    sheet.fill(WipeColour::opaque_rgb(0x00, 0x00, 0x00));
    for (i, panel) in panels.iter().enumerate() {
        sheet.blit(panel, 0, (screen.1 + gap) * i as u32);
    }

    let bytes = encode_png_rgba_deterministic(&sheet);
    assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47], "valid PNG magic");
    std::fs::write(&out, &bytes).unwrap();
    println!(
        "wrote {} ({} bytes, {}x{}) — 4 panels: choice(0), branch0, choice(1), branch1",
        out.display(),
        bytes.len(),
        sheet.width(),
        sheet.height()
    );
}
