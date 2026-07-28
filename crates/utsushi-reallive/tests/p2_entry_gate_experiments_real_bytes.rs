//! Bounded real-byte experiments for the second corpus entry gate.
//!
//! These tests are deliberately observation-only. They never seed a bank,
//! invent a coordinate, or convert the static catalogue into execution.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_core::input::{InputEvent, PointerButton};
use utsushi_core::substrate::AssetPackage;
use utsushi_reallive::{
    BytecodeElement, ExprNode, HydratedPrimaryClickError, LIVE_SESSION_SCREEN, RealSceneIndex,
    ReplayEngine, build_scene_store_from_decompressed, decode_bytecode_stream,
    decompress_all_scenes, parse_expression,
};

#[path = "support/real_g00_package.rs"]
mod real_g00_package;

const SECONDARY_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_2";
const PRIMARY_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";
const BLOCKED_SCENE: u16 = 8502;
const BLOCKED_PC: u32 = 1236;

fn staged_engine_and_bytes(
    bytes: &[u8],
) -> (ReplayEngine, Vec<utsushi_reallive::DecompressedScene>) {
    let index_len = RealSceneIndex::parse(bytes)
        .expect("parse real scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(bytes).expect("decompress real archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, recovered) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = recovered.bytecode;
    }
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build scene store");
    (ReplayEngine::from_store(store, shift_jis), decompressed)
}

fn root_paths(env_name: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let root = PathBuf::from(env::var_os(env_name)?);
    [root.clone(), root.join("REALLIVEDATA")]
        .into_iter()
        .find_map(|data_root| {
            let seen = ["SEEN.TXT", "Seen.txt"]
                .into_iter()
                .map(|name| data_root.join(name))
                .find(|path| path.is_file())?;
            let gameexe = ["GAMEEXE.INI", "Gameexe.ini"]
                .into_iter()
                .map(|name| data_root.join(name))
                .find(|path| path.is_file())?;
            let g00 = ["G00", "g00"]
                .into_iter()
                .map(|name| data_root.join(name))
                .find(|path| path.is_dir())?;
            Some((seen, gameexe, g00))
        })
}

fn move_to_second_pointer_gate(
    session: &mut utsushi_reallive::LiveSession,
) -> HydratedPrimaryClickError {
    let click = session
        .hydrated_primary_click()
        .expect("first pointer gate is backed by real hydrated art");
    let [press, release] = click.events();
    session
        .send(press)
        .expect("first pointer press is accepted");
    let mut update = session
        .send(release)
        .expect("first pointer release is accepted");
    let mut advances = 0usize;
    for _ in 0..2_000 {
        update = match update.state.waiting_for {
            Some(utsushi_reallive::LiveSessionWait::Advance) => {
                advances += 1;
                session.send(InputEvent::advance())
            }
            Some(utsushi_reallive::LiveSessionWait::Pointer) => {
                let error = session
                    .hydrated_primary_click()
                    .expect_err("the experiment begins at the non-hydrated pointer gate");
                assert_eq!(advances, 73, "the measured pause chain changed");
                return error;
            }
            wait => panic!("unexpected gate before the target pointer boundary: {wait:?}"),
        }
        .expect("the retained VM consumes each observed gate event");
    }
    panic!("did not reach a second pointer gate within the bounded entry path");
}

fn normalized_primary(point: (i32, i32), screen: (i32, i32)) -> InputEvent {
    InputEvent::Pointer {
        x: point.0 as f32 / (screen.0 - 1) as f32,
        y: point.1 as f32 / (screen.1 - 1) as f32,
        button: PointerButton::Primary,
    }
}

#[test]
#[ignore = "requires the existing ITOTORI_REAL_GAME_ROOT_2 Kanon asset root"]
fn p2_script_rectangle_click_advances_without_hydrated_object() {
    let Some((seen, _gameexe, g00)) = root_paths(SECONDARY_ROOT_ENV) else {
        eprintln!("SKIP P2 raw-pointer experiment: {SECONDARY_ROOT_ENV} is unavailable.");
        return;
    };
    let (engine, _) = staged_engine_and_bytes(&fs::read(seen).expect("read secondary Seen.txt"));
    let assets: Arc<dyn AssetPackage> = Arc::new(real_g00_package::RealG00Package::new(g00));
    let (mut session, _) = engine
        .start_live_session_with_assets(9030, assets)
        .expect("secondary entry session starts");
    let HydratedPrimaryClickError::RectangleNotHydrated { rectangle } =
        move_to_second_pointer_gate(&mut session)
    else {
        panic!("the gate must expose a concrete, non-hydrated rectangle");
    };
    assert_eq!(session.state().scene, BLOCKED_SCENE);
    assert_eq!(session.state().pc, BLOCKED_PC);
    assert_eq!(
        session.pointer_gate_values(),
        [
            Some(rectangle.x),
            Some(rectangle.y),
            Some(rectangle.width),
            Some(rectangle.height)
        ]
    );

    let click = session
        .script_rectangle_primary_click()
        .expect("a populated script rectangle must be enough for its cursor poll");
    assert_eq!(click.rectangle, rectangle);
    let [press, release] = click.events();
    let before = session.state();
    let before_values = session.pointer_gate_values();
    let after_press = session.send(press).expect("raw pointer press is delivered");
    let after_press_values = session.pointer_gate_values();
    let after_release = session
        .send(release)
        .expect("raw primary release is delivered");
    let after_release_values = session.pointer_gate_values();

    eprintln!(
        "P2 script-rectangle pointer: rectangle={rectangle:?} pixel={:?} event_kinds=[pointer,raw:primary_release] before={before:?} before_values={before_values:?} after_press={:?} after_press_values={after_press_values:?} after_release={:?} after_release_values={after_release_values:?}",
        click.pixel, after_press.state, after_release.state,
    );
    assert_eq!(
        after_press.state, before,
        "a primary press must not itself cross the poll gate"
    );
    assert!(
        after_release.state.event_index > after_press.state.event_index,
        "the release must be observed by the retained script rather than dropped"
    );
    assert_eq!(
        (
            after_release.state.scene,
            after_release.state.pc,
            after_release.state.waiting_for
        ),
        (
            BLOCKED_SCENE,
            1672,
            Some(utsushi_reallive::LiveSessionWait::Pointer)
        ),
        "the raw cursor gesture must cross the polled branch without an object-selection commit"
    );
}

#[test]
#[ignore = "requires the existing ITOTORI_REAL_GAME_ROOT_2 Kanon asset root"]
fn p2_declared_screen_size_matches_the_live_conversion_candidate() {
    let Some((_seen, gameexe_path, _g00)) = root_paths(SECONDARY_ROOT_ENV) else {
        eprintln!("SKIP P2 coordinate experiment: {SECONDARY_ROOT_ENV} is unavailable.");
        return;
    };
    let gameexe = utsushi_reallive::Gameexe::parse(
        &fs::read(gameexe_path).expect("read secondary Gameexe.ini"),
    )
    .expect("parse secondary Gameexe.ini");
    let declared = gameexe.screen_size_px();
    let fixed = (LIVE_SESSION_SCREEN.0 as u32, LIVE_SESSION_SCREEN.1 as u32);
    let probe = (511, 239);
    let declared_event = normalized_primary(probe, (declared.0 as i32, declared.1 as i32));
    let fixed_event = normalized_primary(probe, LIVE_SESSION_SCREEN);
    eprintln!(
        "P2 coordinate-space: declared={declared:?} fixed={fixed:?} probe={probe:?} declared_event={declared_event:?} fixed_event={fixed_event:?}"
    );
    assert_eq!(
        declared, fixed,
        "the title declaration and fixed live conversion differ"
    );
    assert_eq!(
        declared_event, fixed_event,
        "the two candidate normalizations differ"
    );
}

fn is_int_a_slot(node: &ExprNode, wanted: u16) -> bool {
    matches!(
        node,
        ExprNode::MemoryRef {
            bank: 0,
            index,
        } if matches!(index.as_ref(), ExprNode::IntLiteral(value) if *value == i32::from(wanted))
    )
}

fn assignment_target(node: &ExprNode) -> Option<u16> {
    let ExprNode::Assignment { dest, .. } = node else {
        return None;
    };
    [1000, 1001, 1002, 1003]
        .into_iter()
        .find(|index| is_int_a_slot(dest, *index))
}

fn target_ref_count(bytes: &[u8]) -> usize {
    [1000_i32, 1001, 1002, 1003]
        .into_iter()
        .filter(|index| {
            let mut token = vec![0x24, 0x00, b'[', 0x24, 0xff];
            token.extend(index.to_le_bytes());
            token.push(b']');
            bytes.windows(token.len()).any(|window| window == token)
        })
        .count()
}

#[test]
#[ignore = "requires the existing ITOTORI_REAL_GAME_ROOT_2 Kanon asset root"]
fn p2_backward_slice_classifies_the_rectangle_operand_provenance() {
    let Some((seen, _gameexe, _g00)) = root_paths(SECONDARY_ROOT_ENV) else {
        eprintln!("SKIP P2 provenance experiment: {SECONDARY_ROOT_ENV} is unavailable.");
        return;
    };
    let (_, scenes) = staged_engine_and_bytes(&fs::read(seen).expect("read secondary Seen.txt"));
    let scene = scenes
        .iter()
        .find(|scene| scene.scene_id == BLOCKED_SCENE)
        .expect("blocked scene is present");
    let mut assignments = Vec::new();
    let mut command_consumers = Vec::new();
    for element in decode_bytecode_stream(&scene.bytecode).expect("decode blocked scene") {
        if element.byte_offset() as u32 > BLOCKED_PC {
            break;
        }
        match element {
            BytecodeElement::Expression {
                raw_bytes,
                byte_offset,
                ..
            } => {
                let (node, consumed) = parse_expression(&raw_bytes).expect("parse expression");
                assert_eq!(
                    consumed,
                    raw_bytes.len(),
                    "expression parser must consume its decoded element"
                );
                if let Some(index) = assignment_target(&node) {
                    assignments.push((byte_offset, index, node));
                }
            }
            BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                raw_bytes,
                byte_offset,
                ..
            } => {
                let references = target_ref_count(&raw_bytes);
                if references > 0 {
                    command_consumers.push((
                        byte_offset,
                        module_type,
                        module_id,
                        opcode,
                        references,
                    ));
                }
            }
            _ => {}
        }
    }
    eprintln!(
        "P2 provenance: scene={BLOCKED_SCENE} gate_pc={BLOCKED_PC} standalone_assignments={assignments:?} command_target_references={command_consumers:?}"
    );
    assert!(
        assignments.iter().all(|(_, index, _)| *index == 1000),
        "the bounded slice unexpectedly resolves another rectangle operand locally"
    );
    assert!(
        command_consumers
            .iter()
            .all(|(_, kind, module, opcode, _)| (*kind, *module, *opcode) == (0, 1, 2)),
        "a non-branch command unexpectedly consumes a rectangle operand in the bounded slice"
    );
}

#[test]
#[ignore = "requires the existing ITOTORI_REAL_GAME_ROOT primary asset root"]
fn p2_primary_executed_line_oracle_remains_7750() {
    let Some((seen, gameexe, _g00)) = root_paths(PRIMARY_ROOT_ENV) else {
        eprintln!("SKIP primary regression oracle: {PRIMARY_ROOT_ENV} is unavailable.");
        return;
    };
    let (engine, _) = staged_engine_and_bytes(&fs::read(seen).expect("read primary Seen.txt"));
    let entry =
        utsushi_reallive::Gameexe::parse(&fs::read(gameexe).expect("read primary Gameexe.ini"))
            .expect("parse primary Gameexe.ini")
            .get_int("SEEN_START")
            .and_then(|scene| u16::try_from(scene).ok())
            .expect("primary entry scene");
    let playthrough = engine.observe_playthrough(
        entry,
        &utsushi_reallive::ReplayOpts {
            step_budget: 200_000,
            stop_at_first_pause: false,
        },
        4,
    );
    let executed = playthrough
        .segments
        .iter()
        .filter(|segment| {
            segment.observation.play_order_source
                == utsushi_reallive::PlayOrderSource::BranchFollowing
        })
        .map(|segment| segment.observation.play_order_lines.len())
        .sum::<usize>();
    eprintln!(
        "P2 primary executed-line oracle: scenes={:?} executed_lines={executed}",
        playthrough
            .segments
            .iter()
            .map(|segment| segment.scene_id)
            .collect::<Vec<_>>()
    );
    assert_eq!(executed, 7_750, "primary executed dialogue regressed");
}
