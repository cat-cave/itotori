//! Executed-path inventory of RealLive command addresses that lack a mount.
//!
//! This is intentionally branch-following rather than a decoded-byte scan:
//! the report only counts a command after the VM has reached and dispatched it.

#[path = "support/real_corpus.rs"]
mod real_corpus;
#[path = "support/xor2_staging.rs"]
mod xor2_staging;

use std::collections::BTreeMap;
use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    HeadlessChoicePolicy, ReplayEngine, ReplayOpts, RlopKey, build_scene_store_from_decompressed,
    decompress_all_scenes,
};

const STEP_BUDGET: u32 = 200_000;

fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut scenes = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = scenes
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);
    xor2_staging::require_xor2_ready(&report).expect("xor2 corpus staging is ready");
    for (scene, decrypted) in scenes.iter_mut().zip(xor2) {
        scene.bytecode = decrypted.bytecode;
    }
    let (store, shift_jis, _) =
        build_scene_store_from_decompressed(&scenes, index_len).expect("build scene store");
    ReplayEngine::from_store(store, shift_jis)
}

fn inventory(engine: &ReplayEngine) -> BTreeMap<RlopKey, usize> {
    let opts = ReplayOpts {
        step_budget: STEP_BUDGET,
        stop_at_first_pause: false,
    };
    let mut counts = BTreeMap::new();
    for scene in engine.scene_ids() {
        let report =
            engine.branch_following_report(scene, &opts, HeadlessChoicePolicy::AlwaysFirst);
        for (key, occurrences) in report.unknown_opcode_occurrences {
            *counts.entry(key).or_insert(0) += occurrences;
        }
    }
    counts
}

#[test]
#[ignore = "real-bytes; requires private inventory row + _2"]
fn reports_every_executed_unknown_opcode_with_overload_and_occurrences() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(
            "reports_every_executed_unknown_opcode_with_overload_and_occurrences",
        );
        return;
    }
    for corpus in corpora {
        let engine = staged_engine(&fs::read(&corpus.seen_txt).expect("read Seen.txt"));
        let mut ranked: Vec<_> = inventory(&engine).into_iter().collect();
        ranked.sort_by_key(|(key, count)| (std::cmp::Reverse(*count), *key));
        eprintln!("[{}] executed unknown inventory: {ranked:?}", corpus.label);
    }
}
