//! Boot-dispatch tracer (work-roots resolution scratch tool).
//!
//! Decodes a scene's full bytecode stream and prints the control-flow spine:
//! every Command's `(module_type,module_id,opcode)`, its byte offset, its
//! goto-family targets, and — for cross-scene `jump`/`farcall` (module 5/6) —
//! the first `(expr)` arg (the target scene id) reduced against empty banks.
//! Also annotates, for each goto target byte offset, which Command sits there.
//!
//! Read-only; emits offsets / scene-ids / opcode ids only (no copyrighted text).
//!
//!   cargo run -p utsushi-reallive --example boot_dispatch_scan -- <Seen.txt> <scene>

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

use utsushi_reallive::{
    BytecodeElement, ExprNode, VarBanks, decode_bytecode_stream, decompress_all_scenes, evaluate,
    parse_expression,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: boot_dispatch_scan <Seen.txt> <scene>");
        std::process::exit(2);
    }
    let seen_path = PathBuf::from(&args[1]);
    let seen_bytes = std::fs::read(&seen_path).expect("read Seen.txt");
    let decompressed = decompress_all_scenes(&seen_bytes).expect("decompress scenes");

    // Graph mode: `boot_dispatch_scan <Seen.txt> graph` — print every
    // resolvable cross-scene edge scene->target across the whole archive.
    if args[2] == "graph" {
        let banks = VarBanks::new();
        println!("src,dst,kind");
        for scene in &decompressed {
            let Ok(elements) = decode_bytecode_stream(&scene.bytecode) else {
                println!("{},DESYNC,-", scene.scene_id);
                continue;
            };
            for el in &elements {
                let BytecodeElement::Command {
                    module_type,
                    module_id,
                    opcode,
                    arg_count,
                    raw_bytes,
                    ..
                } = el
                else {
                    continue;
                };
                let is_cross = *module_type == 0
                    && ((*module_id == 1 && *opcode >= 11 && *arg_count >= 1)
                        || *module_id == 5
                        || *module_id == 6);
                if !is_cross {
                    continue;
                }
                let body = &raw_bytes[8.min(raw_bytes.len())..];
                let after = if body.first() == Some(&b'(') {
                    &body[1..]
                } else {
                    body
                };
                if let Ok((node, _)) = parse_expression(after) {
                    let resolved = match &node {
                        ExprNode::IntLiteral(v) => Some(*v),
                        other => evaluate(other, &banks).ok(),
                    };
                    match resolved {
                        Some(v) => {
                            println!("{},{v},op{opcode}", scene.scene_id);
                        }
                        None => println!("{},STORE_REL,op{opcode}", scene.scene_id),
                    }
                }
            }
        }
        return;
    }

    let scene_id: u16 = args[2].parse().expect("scene id");
    let Some(scene) = decompressed.iter().find(|s| s.scene_id == scene_id) else {
        eprintln!("scene {scene_id} not present");
        return;
    };

    let elements = match decode_bytecode_stream(&scene.bytecode) {
        Ok(e) => e,
        Err(err) => {
            println!("scene {scene_id}: stream decode desynced: {err:?}");
            return;
        }
    };

    // Map byte offset -> command signature, so we can annotate goto targets.
    let mut cmd_at: BTreeMap<usize, String> = BTreeMap::new();
    for el in &elements {
        if let BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            byte_offset,
            ..
        } = el
        {
            cmd_at.insert(
                *byte_offset,
                format!("({module_type},{module_id},{opcode})"),
            );
        }
    }

    let banks = VarBanks::new();
    println!("scene {scene_id}: {} elements", elements.len());
    for el in &elements {
        let BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            arg_count,
            goto_targets,
            raw_bytes,
            byte_offset,
            ..
        } = el
        else {
            continue;
        };
        // Print control-flow-relevant commands: jmp module (1)
        // cross-scene jump/farcall (5/6), and sel module (2) — any module_type.
        let interesting = matches!(*module_id, 1 | 5 | 6 | 2);
        if !interesting && goto_targets.is_empty() {
            continue;
        }
        let mut line = format!(
            "  @{byte_offset:>6} cmd=({module_type},{module_id},{opcode}) argc={arg_count}"
        );
        // Cross-scene jump/farcall: decode first arg = target scene id.
        // RealLive puts jump()/farcall()/gosub-real in the Jmp module
        // (0,1,opcode>=11) with the target scene id as an EXPRESSION arg
        // (not an intra-scene byte pointer). module 5/6 are the alt variants.
        if *module_id == 5
            || *module_id == 6
            || (*module_id == 1 && *opcode >= 11 && *arg_count >= 1)
        {
            let body = &raw_bytes[8.min(raw_bytes.len())..];
            let after = if body.first() == Some(&b'(') {
                &body[1..]
            } else {
                body
            };
            match parse_expression(after) {
                Ok((node, _)) => match &node {
                    ExprNode::IntLiteral(v) => {
                        let _ = write!(line, " -> scene {v}");
                    }
                    other => match evaluate(other, &banks) {
                        Ok(v) => {
                            let _ = write!(line, " -> scene {v} (reduced)");
                        }
                        Err(_) => {
                            let _ = write!(line, " -> scene <store-relative: {other:?}>");
                        }
                    },
                },
                Err(e) => {
                    let _ = write!(line, " -> <expr parse err {e:?}>");
                }
            }
        }
        if !goto_targets.is_empty() {
            let mut annotated: Vec<String> = Vec::new();
            for t in goto_targets {
                let at = cmd_at
                    .get(&(*t as usize))
                    .cloned()
                    .unwrap_or_else(|| "<not-a-cmd-start>".to_string());
                annotated.push(format!("{t}:{at}"));
            }
            let _ = write!(line, " goto_targets=[{}]", annotated.join(", "));
        }
        println!("{line}");
    }
}
