//! Decoder-level inventory of every observed `Sys` and `Grp` tuple.
//!
//! Registration is deliberately NOT the source of these counts: the command
//! stream is decoded before the runtime registry is constructed, so an absent
//! byte cannot be made to appear by an implementation change.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    BytecodeElement, DecompressedScene, ReplayEngine, ReplayEvent, ReplayOpts,
    build_scene_store_from_decompressed, decode_bytecode_stream, decompress_all_scenes,
};

type CommandKey = (u8, u8, u16, u8);

fn decrypted_scenes(seen_bytes: &[u8]) -> Vec<DecompressedScene> {
    let mut scenes = decompress_all_scenes(seen_bytes).expect("decompress Seen.txt");
    let mut xor2: Vec<Xor2DecScene> = scenes
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, recovered) in scenes.iter_mut().zip(xor2) {
        scene.bytecode = recovered.bytecode;
    }
    scenes
}

/// Counts exact dispatch addresses, including the overload byte.
fn sys_grp_opcode_counts(scenes: &[DecompressedScene]) -> BTreeMap<CommandKey, usize> {
    let mut counts = BTreeMap::new();
    for scene in scenes {
        let Ok(elements) = decode_bytecode_stream(&scene.bytecode) else {
            continue;
        };
        for element in elements {
            if let BytecodeElement::Command {
                module_type,
                module_id: module_id @ (4 | 33),
                opcode,
                overload,
                ..
            } = element
            {
                *counts
                    .entry((module_type, module_id, opcode, overload))
                    .or_insert(0) += 1;
            }
        }
    }
    counts
}

fn staged_engine(scenes: &[DecompressedScene], seen: &[u8]) -> ReplayEngine {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen)
        .expect("parse scene index")
        .entries
        .len();
    let (store, shift_jis, _) =
        build_scene_store_from_decompressed(scenes, index_len).expect("build decoded scene store");
    ReplayEngine::from_store(store, shift_jis)
}

/// Real-byte inventory for the two staged corpora. This test intentionally
/// prints the complete raw decoder surface while its expectations are derived.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn decoder_reports_sys_grp_opcode_inventory_from_both_real_archives() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(
            "utsushi-reallive decoder_reports_sys_grp_opcode_inventory_from_both_real_archives",
        );
        return;
    }
    for corpus in corpora {
        let seen = fs::read(&corpus.seen_txt).expect("read Seen.txt");
        let scenes = decrypted_scenes(&seen);
        let counts = sys_grp_opcode_counts(&scenes);
        eprintln!(
            "[{}] decoded Sys/Grp opcode counts: {counts:?}",
            corpus.label
        );
        let engine = staged_engine(&scenes, &seen);
        let mut unresolved = BTreeMap::new();
        let opts = ReplayOpts {
            step_budget: 500_000,
            stop_at_first_pause: false,
        };
        for scene in engine.scene_ids() {
            for event in engine.replay_from(scene, &opts).events {
                if let ReplayEvent::UnknownOpcode {
                    module_type,
                    module_id: module_id @ (4 | 33),
                    opcode,
                    ..
                } = event
                {
                    *unresolved
                        .entry((module_type, module_id, opcode))
                        .or_insert(0usize) += 1;
                }
            }
        }
        eprintln!(
            "[{}] unresolved Sys/Grp replay counts (overload omitted by diagnostic): {unresolved:?}",
            corpus.label
        );
        assert!(
            !counts.is_empty(),
            "[{}] decoder found no Sys/Grp commands",
            corpus.label
        );
    }
}
