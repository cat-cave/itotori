//! Static sel-family scan (`multi-work-carve-live-sweetie-real-bytes-validation`).
//!
//! Finds the archive's GAME-SELECT — the first-screen base-vs-fandisk pick —
//! by STATICALLY decoding every scene and reporting its `module_sel` (0,2,x)
//! surface: the `select_objbtn` (0,2,4) / `objbtn_init` (0,2,20) button-object
//! SelectionControl setup ops (the graphical game-select marker) vs the plain
//! `select`/`select_w` Choice option blocks (in-story text branches).
//!
//! WHY static: the real game-select is reached from the TITLE screen and
//! headless dispatch does NOT cross scenes from the title, so the game-select
//! is unreachable by `observe_playthrough` from `#SEEN_START`. A static decode
//! of each scene's bytecode DOES surface the sel-family opcodes regardless of
//! reachability — exactly the signal the itotori work-scope carve hardens on.
//!
//! Read-only; emits COUNTS + scene ids only (no copyrighted text).
//!
//!   cargo run -p utsushi-reallive --example game_select_scan -- <Seen.txt>
//!   cargo run -p utsushi-reallive --example game_select_scan -- <Seen.txt> <scene>
//!     (second form: dump that scene's cross-scene jump/farcall target scene ids)

use std::path::PathBuf;

use kaifuu_reallive::RealLiveOpcode;
use kaifuu_reallive::parse_scene;
use utsushi_reallive::{
    ExprNode, VarBanks, decode_bytecode_stream, decompress_all_scenes, evaluate,
};

// `module_sel` (module_type=0, module_id=2) SelectionControl button-object
// setup opcodes — the graphical game-select marker (rlvm module_sel.cc).
const OP_SELECT_OBJBTN: u16 = 4;
const OP_OBJBTN_INIT: u16 = 20;
const OP_SELECT_OBJBTN_CANCEL: u16 = 14;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: game_select_scan <Seen.txt> [scene]");
        std::process::exit(2);
    }
    let seen_path = PathBuf::from(&args[1]);
    let seen_bytes = std::fs::read(&seen_path).expect("read Seen.txt");
    let decompressed = decompress_all_scenes(&seen_bytes).expect("decompress scenes");

    if let Some(scene_arg) = args.get(2).and_then(|s| s.parse::<u16>().ok()) {
        dump_cross_scene_targets(&decompressed, scene_arg);
        return;
    }

    println!("scene,parse_ok,objbtn_init,select_objbtn,objbtn_cancel,choice_blocks,goto_on_if");
    for scene in &decompressed {
        // xor2-ciphered / desynced scene — skip (report parse_ok=0).
        let Ok(ops) = parse_scene(&scene.bytecode) else {
            println!("{},0,0,0,0,0,0", scene.scene_id);
            continue;
        };
        let mut objbtn_init = 0u32;
        let mut select_objbtn = 0u32;
        let mut objbtn_cancel = 0u32;
        let mut choice_blocks = 0u32;
        let mut goto_on_if = 0u32;
        for op in &ops {
            match op {
                RealLiveOpcode::SelectionControl { opcode } => match *opcode {
                    OP_SELECT_OBJBTN => select_objbtn += 1,
                    OP_OBJBTN_INIT => objbtn_init += 1,
                    OP_SELECT_OBJBTN_CANCEL => objbtn_cancel += 1,
                    _ => {}
                },
                RealLiveOpcode::Choice { .. } => choice_blocks += 1,
                RealLiveOpcode::If => goto_on_if += 1,
                _ => {}
            }
        }
        if objbtn_init + select_objbtn + objbtn_cancel + choice_blocks > 0 {
            println!(
                "{},1,{objbtn_init},{select_objbtn},{objbtn_cancel},{choice_blocks},{goto_on_if}",
                scene.scene_id
            );
        }
    }
}

/// Dump the distinct cross-scene `jump`/`farcall` (module_id 5 / 6) TARGET
/// scene ids reachable from `scene_id`'s bytecode — the candidate work roots a
/// game-select's `goto_on($store)` dispatches into. The first `(expr)` arg of a
/// cross-scene jump is the target scene id; we evaluate it against empty banks
/// (literal scene ids reduce cleanly; store-relative ones do not and are
/// reported as unresolved).
fn dump_cross_scene_targets(decompressed: &[utsushi_reallive::DecompressedScene], scene_id: u16) {
    let Some(scene) = decompressed.iter().find(|s| s.scene_id == scene_id) else {
        eprintln!("scene {scene_id} not present");
        return;
    };
    // kaifuu's goto-pointer collection (robust where utsushi's stricter stream
    // decoder desyncs) — the count of goto/goto_on branch pointers is the
    // game-select's real fan-out (how many branch targets `goto_on($store)`
    // dispatches into).
    match kaifuu_reallive::collect_goto_pointer_sites(&scene.bytecode) {
        Ok(sites) => println!(
            "scene {scene_id}: kaifuu_goto_pointer_sites={} intra_scene_targets={:?}",
            sites.len(),
            {
                let mut t: Vec<i32> = sites.iter().map(|s| s.target).collect();
                t.sort_unstable();
                t.dedup();
                t
            }
        ),
        Err(err) => println!("scene {scene_id}: kaifuu goto collect failed: {err:?}"),
    }
    let elements = match decode_bytecode_stream(&scene.bytecode) {
        Ok(e) => e,
        Err(err) => {
            println!("scene {scene_id}: utsushi stream decode desynced: {err:?}");
            return;
        }
    };
    let banks = VarBanks::new();
    let mut resolved: Vec<i32> = Vec::new();
    let mut unresolved = 0u32;
    let mut jump_cmds = 0u32;
    for el in &elements {
        let utsushi_reallive::BytecodeElement::Command {
            module_id,
            raw_bytes,
            ..
        } = el
        else {
            continue;
        };
        if *module_id != 5 && *module_id != 6 {
            continue;
        }
        jump_cmds += 1;
        // raw_bytes = 8-byte header + optional "(" arglist ... ; the first arg
        // is the target scene id expression.
        let body = &raw_bytes[8.min(raw_bytes.len())..];
        let after_paren = if body.first() == Some(&b'(') {
            &body[1..]
        } else {
            body
        };
        match utsushi_reallive::parse_expression(after_paren) {
            Ok((node, _)) => match &node {
                ExprNode::IntLiteral(v) => resolved.push(*v),
                other => match evaluate(other, &banks) {
                    Ok(v) => resolved.push(v),
                    Err(_) => unresolved += 1,
                },
            },
            Err(_) => unresolved += 1,
        }
    }
    resolved.sort_unstable();
    resolved.dedup();
    println!(
        "scene {scene_id}: cross_scene_jump_cmds={jump_cmds} resolved_targets={resolved:?} unresolved={unresolved}"
    );
}
