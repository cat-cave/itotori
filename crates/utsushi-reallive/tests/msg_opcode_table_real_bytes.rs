//! Byte-derived inventory for the RealLive `msg` command table.
//!
//! This is deliberately a decoder-level scan: registrations cannot make an
//! absent byte appear, and therefore cannot validate their own numbers.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::BTreeMap;
use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    BytecodeElement, DecompressedScene, ReplayEngine, ReplayOpts,
    build_scene_store_from_decompressed, decode_bytecode_stream, decompress_all_scenes,
};

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

fn msg_opcode_counts(scenes: &[DecompressedScene]) -> BTreeMap<(u8, u16, u8), usize> {
    let mut counts = BTreeMap::new();
    for scene in scenes {
        let Ok(elements) = decode_bytecode_stream(&scene.bytecode) else {
            continue;
        };
        for element in elements {
            if let BytecodeElement::Command {
                module_type,
                module_id: 3,
                opcode,
                overload,
                ..
            } = element
            {
                *counts.entry((module_type, opcode, overload)).or_insert(0) += 1;
            }
        }
    }
    counts
}

fn expected_counts(label: &str) -> BTreeMap<(u8, u16, u8), usize> {
    let entries: &[(u16, usize)] = match label {
        "corpus-1" => &[(17, 26_856), (161, 122), (201, 270), (205, 30)],
        "corpus-2" => &[
            (17, 38_661),
            (102, 126),
            (103, 63),
            (104, 63),
            (151, 10_793),
            (152, 63),
            (161, 1),
            (201, 63),
            (205, 75),
            (210, 63),
            (300, 63),
            (301, 63),
            (310, 63),
            (311, 63),
        ],
        other => panic!("unrecognised corpus label: {other}"),
    };
    let mut counts: BTreeMap<(u8, u16, u8), usize> = entries
        .iter()
        .map(|&(opcode, count)| ((0, opcode, 0), count))
        .collect();
    if label == "corpus-1" {
        counts.extend([((0, 400, 1), 7), ((0, 401, 1), 31)]);
    } else if label == "corpus-2" {
        counts.extend([((0, 105, 1), 63), ((0, 105, 2), 118)]);
    }
    counts
}

fn staged_engine(seen: &[u8]) -> ReplayEngine {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen)
        .expect("parse Seen.txt index")
        .entries
        .len();
    let (store, shift_jis, _) =
        build_scene_store_from_decompressed(&decrypted_scenes(seen), index_len)
            .expect("build decoded scene store");
    ReplayEngine::from_store(store, shift_jis)
}

#[test]
#[ignore = "strict real-bytes proof; requires two staged RealLive archives"]
fn decoder_reports_the_msg_opcode_inventory_from_both_real_archives() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(
            "utsushi-reallive decoder_reports_the_msg_opcode_inventory_from_both_real_archives",
        );
        return;
    }
    for corpus in corpora {
        let seen = fs::read(&corpus.seen_txt).expect("read Seen.txt");
        let counts = msg_opcode_counts(&decrypted_scenes(&seen));
        eprintln!("[{}] decoded msg opcode counts: {counts:?}", corpus.label);
        assert_eq!(
            counts,
            expected_counts(corpus.label),
            "{} msg bytes changed",
            corpus.label
        );
    }
}

#[test]
#[ignore = "strict real-bytes proof; requires two staged RealLive archives"]
fn every_decoded_msg_command_resolves_in_both_real_archives() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(
            "utsushi-reallive every_decoded_msg_command_resolves_in_both_real_archives",
        );
        return;
    }
    let opts = ReplayOpts {
        step_budget: 500_000,
        stop_at_first_pause: false,
    };
    for corpus in corpora {
        let seen = fs::read(&corpus.seen_txt).expect("read Seen.txt");
        let engine = staged_engine(&seen);
        let unknown: Vec<_> = engine
            .scene_ids()
            .into_iter()
            .flat_map(|scene| engine.replay_from(scene, &opts).unknown_opcode_keys())
            .filter(|&(_, module_id, _)| module_id == 3)
            .collect();
        assert!(
            unknown.is_empty(),
            "[{}] msg unknown={unknown:?}",
            corpus.label
        );
    }
}
