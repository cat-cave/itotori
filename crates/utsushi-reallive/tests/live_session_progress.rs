//! A reader has to be able to get somewhere.
//!
//! Every check here drives the SAME live session a browser drives, feeds it
//! the SAME two input shapes a browser can send, and asserts the machine
//! MOVED — distinct instruction pointers, a committed selection the following
//! branch can read, a bounded loop that actually ends. A frame that renders
//! beautifully at one address forever passes a render check and fails a
//! reader, so none of these assert on a frame.
//!
//! The scenes are assembled as BYTES and handed to the real decoder, not as
//! pre-built elements. That is deliberate: the numbers a script actually
//! encodes are part of what is under test, so a check that skipped the
//! decoder could keep passing while the runtime looked for its gates at
//! addresses no script ever writes.

use std::collections::HashSet;
use std::sync::Arc;

use utsushi_core::input::InputEvent;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetMetadata, AssetPackage, CaseRule, PackageDescriptor, PackageKind,
    PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    AssignOp, ExprOp, InMemorySceneStore, LiveSessionWait, ReplayEngine, Scene,
    decode_bytecode_stream,
};

// Byte-level assembly of the encodings the runtime has to recognise.

const COMMAND_LEAD: u8 = 0x23;
const TOKEN_LEAD: u8 = 0x24;
const BACKSLASH: u8 = 0x5C;
const INT_LITERAL: u8 = 0xFF;
const STORE_REGISTER: u8 = 0xC8;

const MSG_MODULE: (u8, u8) = (0, 3);
const SEL_MODULE: (u8, u8) = (0, 2);
const JMP_MODULE: (u8, u8) = (0, 1);
const OBJ_BG_SETTER_MODULE: (u8, u8) = (1, 82);
const OBJ_BG_CREATION_MODULE: (u8, u8) = (1, 72);

/// The dialogue gate: one per line of text a reader clicks through.
const OPCODE_PAUSE: u16 = 17;
/// The button-object selection prompt, in its no-argument shape.
const OPCODE_SELECT_OBJBTN: u16 = 4;
const OPCODE_OBJ_OF_FILE: u16 = 1000;
const OPCODE_OBJ_BUTTON_OPTS: u16 = 1064;
const OPCODE_GOTO: u16 = 0;
const OPCODE_GOTO_UNLESS: u16 = 2;

fn int_literal(value: i32) -> Vec<u8> {
    let mut bytes = vec![TOKEN_LEAD, INT_LITERAL];
    bytes.extend_from_slice(&value.to_le_bytes());
    bytes
}

fn store_ref() -> Vec<u8> {
    vec![TOKEN_LEAD, STORE_REGISTER]
}

fn binary(lhs: Vec<u8>, op: ExprOp, rhs: Vec<u8>) -> Vec<u8> {
    let mut bytes = lhs;
    bytes.extend_from_slice(&[BACKSLASH, op.as_byte()]);
    bytes.extend_from_slice(&rhs);
    bytes
}

fn assignment(target: Vec<u8>, op: AssignOp, value: Vec<u8>) -> Vec<u8> {
    let mut bytes = target;
    bytes.extend_from_slice(&[BACKSLASH, op.as_byte()]);
    bytes.extend_from_slice(&value);
    bytes
}

/// `# <type> <id> <opcode:u16> <argc:u16> <overload>` plus an optional
/// parenthesised argument list and optional trailing jump targets.
fn command(
    module: (u8, u8),
    opcode: u16,
    overload: u8,
    args: &[Vec<u8>],
    targets: &[u32],
) -> Vec<u8> {
    let mut bytes = vec![COMMAND_LEAD, module.0, module.1];
    bytes.extend_from_slice(&opcode.to_le_bytes());
    bytes.extend_from_slice(&(args.len() as u16).to_le_bytes());
    bytes.push(overload);
    if !args.is_empty() {
        bytes.push(b'(');
        for (index, arg) in args.iter().enumerate() {
            if index > 0 {
                bytes.push(b',');
            }
            bytes.extend_from_slice(arg);
        }
        bytes.push(b')');
    }
    for target in targets {
        bytes.extend_from_slice(&target.to_le_bytes());
    }
    bytes
}

/// A Shift-JIS text run. The lead byte has to be a real Shift-JIS lead or the
/// runtime will not treat the run as a line.
fn text_run(body: &str) -> Vec<u8> {
    encoding_rs::SHIFT_JIS.encode(body).0.into_owned()
}

fn scene_from_bytes(id: u16, bytes: &[u8]) -> Scene {
    let elements = decode_bytecode_stream(bytes).expect("assembled bytecode decodes");
    Scene::new(id, elements).expect("assembled scene is non-empty")
}

fn engine_over(id: u16, bytes: &[u8], text_offsets: &[u32]) -> ReplayEngine {
    let mut store = InMemorySceneStore::new();
    store.insert(scene_from_bytes(id, bytes));
    let shift_jis: HashSet<(u16, u32)> = text_offsets.iter().map(|off| (id, *off)).collect();
    ReplayEngine::from_store(store, shift_jis)
}

/// Two lines, each behind its own dialogue gate.
///
/// This is the shape of every scripted conversation in the archives: a run of
/// text, then the gate the reader crosses to see the next one. Gutting the
/// gate — pointing it at an address no script encodes — turns the whole
/// conversation into a single uninterrupted burst, which is what the check
/// below refuses to accept.
#[test]
fn each_line_of_dialogue_is_its_own_gate() {
    let mut bytes = Vec::new();
    let first = text_run("いちぎょうめ");
    let mut offsets = vec![0u32];
    bytes.extend_from_slice(&first);
    bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));
    offsets.push(bytes.len() as u32);
    let second = text_run("にぎょうめ");
    bytes.extend_from_slice(&second);
    bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));

    let engine = engine_over(1, &bytes, &offsets);
    let (mut session, initial) = engine.start_live_session(1).expect("session starts");
    assert_eq!(
        initial.state.waiting_for,
        Some(LiveSessionWait::Advance),
        "the first line must park on its own gate, not run into the second",
    );
    let first_pc = initial.state.pc;

    let next = session
        .send(InputEvent::advance())
        .expect("advance drives the retained VM");
    assert_eq!(
        next.state.waiting_for,
        Some(LiveSessionWait::Advance),
        "the second line must park on its own gate",
    );
    assert_ne!(
        next.state.pc, first_pc,
        "an input must move the instruction pointer; staying put is the reader being stuck",
    );
    assert!(
        next.state.event_index > initial.state.event_index,
        "an input must execute real VM transitions",
    );
}

/// A branch condition that READS the store register must not destroy it.
///
/// A script is free to count in the store register and test it on the way
/// round: `store = 4` … `goto_unless (store <= 4)` … `store *= 2` … loop.
/// If evaluating that condition writes its own boolean back into the
/// register, the counter is pinned at 0/1 and a loop written to run twice
/// runs forever — the session then dies on its step budget instead of
/// reaching the line after the loop.
#[test]
fn a_loop_counting_in_the_store_register_terminates() {
    // Layout: [set] [test -> exit] [double] [back] [text] [gate]
    let set = assignment(store_ref(), AssignOp::Plain, int_literal(4));
    let test_offset = set.len() as u32;
    // The exit target is filled in once the sizes below are known.
    let test_len = command(
        JMP_MODULE,
        OPCODE_GOTO_UNLESS,
        0,
        &[binary(store_ref(), ExprOp::Le, int_literal(4))],
        &[0],
    )
    .len() as u32;
    let double = assignment(store_ref(), AssignOp::MulAssign, int_literal(2));
    let back = command(JMP_MODULE, OPCODE_GOTO, 0, &[], &[test_offset]);
    let exit_offset = test_offset + test_len + double.len() as u32 + back.len() as u32;

    let mut bytes = set;
    bytes.extend_from_slice(&command(
        JMP_MODULE,
        OPCODE_GOTO_UNLESS,
        0,
        &[binary(store_ref(), ExprOp::Le, int_literal(4))],
        &[exit_offset],
    ));
    bytes.extend_from_slice(&double);
    bytes.extend_from_slice(&back);
    assert_eq!(bytes.len() as u32, exit_offset, "exit target must be exact");
    let text_offset = bytes.len() as u32;
    bytes.extend_from_slice(&text_run("るーぷのあと"));
    bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));

    let engine = engine_over(1, &bytes, &[text_offset]);
    let (_session, initial) = engine
        .start_live_session(1)
        .expect("the loop must terminate rather than exhaust the step budget");
    assert_eq!(
        initial.state.waiting_for,
        Some(LiveSessionWait::Advance),
        "execution must reach the gate after the loop",
    );
    assert!(
        initial.state.pc >= text_offset,
        "execution must land after the loop, not inside it: pc={} loop_exit={text_offset}",
        initial.state.pc,
    );
}

/// The no-argument button-object prompt is a real gate, and committing it
/// hands the following branch the number of the button that was picked.
///
/// The buttons are declared the way the archives declare them: created on the
/// background object plane, and bound with a short `objButtonOpts` that names
/// neither a group nor a return number. Every part of that has to line up —
/// the prompt asking for the default group, the binding belonging to it, the
/// scan looking at the plane the buttons are actually on — or the prompt
/// finds nothing, advances past itself, and the branch after it reads a
/// register nobody wrote.
#[test]
fn the_button_prompt_gates_and_returns_the_button_that_was_picked() {
    let mut bytes = Vec::new();
    for slot in 0..2i32 {
        bytes.extend_from_slice(&command(
            OBJ_BG_CREATION_MODULE,
            OPCODE_OBJ_OF_FILE,
            2,
            &[
                int_literal(slot),
                format!("\"BTN{slot:03}\"").into_bytes(),
                int_literal(1),
                int_literal(slot * 100),
                int_literal(0),
            ],
            &[],
        ));
        bytes.extend_from_slice(&command(
            OBJ_BG_SETTER_MODULE,
            OPCODE_OBJ_BUTTON_OPTS,
            1,
            &[int_literal(slot), int_literal(9), int_literal(0)],
            &[],
        ));
    }
    bytes.extend_from_slice(&command(SEL_MODULE, OPCODE_SELECT_OBJBTN, 1, &[], &[]));
    let after_prompt = bytes.len() as u32;
    // `goto_unless (store == 1)` -> the "picked the second button" line.
    let branch_len = command(
        JMP_MODULE,
        OPCODE_GOTO_UNLESS,
        0,
        &[binary(store_ref(), ExprOp::Equ, int_literal(1))],
        &[0],
    )
    .len() as u32;
    let first_line_len = {
        let mut probe = text_run("いちばんめ");
        probe.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));
        probe.len() as u32
    };
    let second_offset = after_prompt + branch_len + first_line_len;
    bytes.extend_from_slice(&command(
        JMP_MODULE,
        OPCODE_GOTO_UNLESS,
        0,
        &[binary(store_ref(), ExprOp::Equ, int_literal(1))],
        &[second_offset],
    ));
    let first_offset = bytes.len() as u32;
    bytes.extend_from_slice(&text_run("いちばんめ"));
    bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));
    assert_eq!(bytes.len() as u32, second_offset, "branch target is exact");
    bytes.extend_from_slice(&text_run("にばんめ"));
    bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));

    let engine = engine_over(1, &bytes, &[first_offset, second_offset]);
    let assets: Arc<dyn AssetPackage> = Arc::new(EmptyPackage);
    let (mut session, initial) = engine
        .start_live_session_with_assets(1, assets)
        .expect("session starts");
    assert_eq!(
        initial.state.waiting_for,
        Some(LiveSessionWait::Choice { choice_count: 2 }),
        "the prompt must park as a two-option gate, not advance past itself",
    );

    let picked = session
        .send(InputEvent::choice(1))
        .expect("committing a choice drives the retained VM");
    assert!(
        picked.state.pc >= second_offset,
        "picking the second button must take the branch written for it: pc={} expected>={second_offset}",
        picked.state.pc,
    );
    assert!(
        picked.state.pc != initial.state.pc,
        "a committed selection must move the instruction pointer",
    );
}

/// Repeated inputs at a live boundary have to keep producing NEW addresses.
///
/// This is the shape of the failure that prompted all of the above: input
/// after input, real VM work each time, and the same address at the end of
/// every one of them. Counting distinct instruction pointers is what tells
/// those two apart.
#[test]
fn repeated_inputs_reach_distinct_addresses() {
    let mut bytes = Vec::new();
    let mut offsets = Vec::new();
    for index in 0..6 {
        offsets.push(bytes.len() as u32);
        bytes.extend_from_slice(&text_run(&format!("ぎょう{index}")));
        bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));
    }

    let engine = engine_over(1, &bytes, &offsets);
    let (mut session, initial) = engine.start_live_session(1).expect("session starts");
    let mut seen = HashSet::from([initial.state.pc]);
    for _ in 0..5 {
        let update = session.send(InputEvent::advance()).expect("advance");
        seen.insert(update.state.pc);
    }
    assert_eq!(
        seen.len(),
        6,
        "six gates must produce six distinct addresses, got {seen:?}",
    );
}

/// A screen that waits by SPINNING rather than by queueing is still a wait.
///
/// Some screens are written as a loop that samples the input device and
/// branches back to the top; nothing is ever queued, so a runtime whose only
/// boundary is a queued gate has nowhere to stop and burns its whole step
/// budget instead of showing the reader anything. Re-entering an identical
/// state with no input available proves the loop cannot leave on its own —
/// which makes it a boundary, and makes the reader's next input the event it
/// was sampling for.
#[test]
fn a_screen_that_waits_by_spinning_is_a_boundary_the_reader_can_cross() {
    let mut bytes = command(JMP_MODULE, OPCODE_GOTO, 0, &[], &[0]);
    let text_offset = bytes.len() as u32;
    bytes.extend_from_slice(&text_run("るーぷをぬけた"));
    bytes.extend_from_slice(&command(MSG_MODULE, OPCODE_PAUSE, 0, &[], &[]));

    let engine = engine_over(1, &bytes, &[text_offset]);
    let (mut session, initial) = engine
        .start_live_session(1)
        .expect("a spinning screen must park, not exhaust the step budget");
    assert_eq!(
        initial.state.waiting_for,
        Some(LiveSessionWait::Pointer),
        "the spin must be reported as a wait the reader can act on",
    );
    assert_eq!(initial.state.pc, 0, "the session parks inside the loop");

    let next = session
        .send(InputEvent::advance())
        .expect("acting on the boundary drives the retained VM");
    assert!(
        next.state.pc >= text_offset,
        "the reader's input must let the loop take its exit: pc={} expected>={text_offset}",
        next.state.pc,
    );
    assert_eq!(
        next.state.waiting_for,
        Some(LiveSessionWait::Advance),
        "and land on the gate that follows the loop",
    );
}

/// An asset package with nothing in it: the prompt's gate and return value
/// must not depend on art being resolvable.
#[derive(Debug)]
struct EmptyPackage;

impl AssetPackage for EmptyPackage {
    fn id(&self) -> &'static str {
        "live-session-progress"
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

    fn exists(&self, _id: &AssetId) -> VfsResult<bool> {
        Ok(false)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        Err(VfsError::AssetMissing { id: id.clone() })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        Err(VfsError::AssetMissing { id: id.clone() })
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}
