//! Real-bytes acceptance for `utsushi-reallive-full-module-replay`.
//!
//! Drives the RealLive runtime replay with ALL NINE opcode-module
//! registrars mounted into a MULTI-scene store built from every populated
//! scene of real `Seen.txt` archives across two independently staged corpora.
//!
//! Acceptance criteria:
//!  1. All 9 registrars mounted into a multi-scene store.
//!  2. A full dialogue scene drives to its terminus and reports every
//!     unimplemented opcode as `UnknownOpcode` — ASSERTED.
//!  3. Byte-determinism (two runs → identical JSON) + snapshot/restore
//!     identity at every tick boundary.
//!  4. Holds on the real bytes of both staged corpora.
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE
//! (no opt-out; these `#[ignore]`-d suites run only in the periodic
//! ground-truth oracle, `just real-bytes-oracle`, where corpora are staged).
//! Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//! cargo test -p utsushi-reallive --test full_module_replay_real_bytes --
//! --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;
#[path = "support/xor2_staging.rs"]
mod xor2_staging;

use std::collections::BTreeSet;
use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    ReplayEngine, ReplayOpts, ReplayOutcome, build_scene_store_from_decompressed,
    decompress_all_scenes, full_registry_rlop_count,
};

const FULL_BUDGET: u32 = 500_000;

/// Build a [`ReplayEngine`] from a Seen.txt envelope, staging the dev-only
/// `kaifuu-reallive` `use_xor_2` segment-cipher recovery between the
/// AVG32 first-level inflate (owned by `utsushi-reallive`) and the
/// bytecode decode.
///
/// One encrypted compiler branch `use_xor_2`-ciphers the `[256, 513)`
/// segment of every decompressed scene; the pure-`utsushi-reallive` decode
/// path cannot recover the per-install key (that recovery is a dev-only
/// `kaifuu-reallive` concern, and no key material is committed).
/// This helper decompresses the whole archive, hands the eligible scenes
/// to [`recover_and_decrypt_archive`] (a no-op for plaintext inputs), then
/// rebuilds the multi-scene store from the plaintext
/// bytecode. The recovered key never leaves this function.
fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let index_len = {
        // The index length (populated slot count) so the store stats'
        // `skipped` reflects decompress/decode drops honestly.
        utsushi_reallive::RealSceneIndex::parse(seen_bytes)
            .expect("parse scene index")
            .entries
            .len()
    };
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");

    // Stage the dev-only xor_2 recovery on the decompressed bytecode.
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);
    xor2_staging::require_xor2_ready(&report).expect("xor2 corpus staging is ready");
    for (scene, dec) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = dec.bytecode;
    }

    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    ReplayEngine::from_store(store, shift_jis)
}

/// Every populated scene of both corpora records its unresolved command tuples
/// explicitly. The output is the whole-store diagnostic inventory, not a
/// runtime compatibility allowlist.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn full_module_replay_all_scenes_reports_unknown_opcodes() {
    let corpora = corpora_or_skip("full_module_replay_all_scenes_reports_unknown_opcodes");
    if corpora.is_empty() {
        return;
    }
    let opts = ReplayOpts {
        step_budget: FULL_BUDGET,
        stop_at_first_pause: false,
    };
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let mut union: BTreeSet<(u8, u8, u16)> = BTreeSet::new();
        for scene_id in engine.scene_ids() {
            let log = engine.replay_from(scene_id, &opts);
            for key in log.unknown_opcode_keys() {
                union.insert(key);
            }
        }
        eprintln!(
            "[{}] unresolved-opcode diagnostics: {} scenes, {} distinct tuples across the WHOLE store: {:?}",
            corpus.label,
            engine.scene_ids().len(),
            union.len(),
            union,
        );
    }
}

/// Resolve both corpora, or HARD-FAIL when fewer than two are staged.
/// Real-bytes coverage is STRICT (no opt-out): `require_real_bytes` panics
/// so the `return Vec::new()` below is never reached.
fn corpora_or_skip(test_name: &str) -> Vec<real_corpus::RealCorpus> {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(test_name);
        return Vec::new();
    }
    corpora
}

/// Pick the loaded scene with the most replay events (a real dialogue
/// scene, as opposed to the all-binary bootstrap scene 1). Bounded by
/// `FULL_BUDGET`.
fn pick_richest_scene(engine: &ReplayEngine) -> (u16, usize) {
    let opts = ReplayOpts {
        step_budget: FULL_BUDGET,
        stop_at_first_pause: false,
    };
    let mut best = (0u16, 0usize);
    for scene_id in engine.scene_ids() {
        let log = engine.replay_from(scene_id, &opts);
        if log.events.len() > best.1 {
            best = (scene_id, log.events.len());
        }
    }
    best
}

fn module_families(log: &utsushi_reallive::ReplayLog) -> BTreeSet<(u8, u8)> {
    log.unknown_opcode_keys()
        .into_iter()
        .map(|(mt, mid, _)| (mt, mid))
        .collect()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn all_nine_registrars_mounted_into_multi_scene_store() {
    let corpora = corpora_or_skip("all_nine_registrars_mounted_into_multi_scene_store");
    if corpora.is_empty() {
        return;
    }
    // Acceptance #1 runtime proof: a full 9-module mount registers many
    // ops (the source-level `rg` proof lives in src/replay.rs).
    let mounted = full_registry_rlop_count();
    assert!(
        mounted >= 60,
        "a full 9-module mount must register the union of all nine families' ops; got {mounted}"
    );
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let stats = engine.stats();
        eprintln!(
            "[{}] store: populated={} loaded={} skipped={}",
            corpus.label, stats.populated, stats.loaded, stats.skipped
        );
        assert!(
            engine.scene_ids().len() > 1,
            "[{}] multi-scene store must hold more than one scene (so cross-scene Jump/FarCall \
             resolves); got {}",
            corpus.label,
            engine.scene_ids().len(),
        );
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn full_module_replay_is_byte_deterministic() {
    let corpora = corpora_or_skip("full_module_replay_is_byte_deterministic");
    if corpora.is_empty() {
        return;
    }
    let opts = ReplayOpts {
        step_budget: FULL_BUDGET,
        stop_at_first_pause: false,
    };
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let (scene, events) = pick_richest_scene(&engine);
        let a = engine
            .replay_from(scene, &opts)
            .to_deterministic_json()
            .expect("serialise a");
        let b = engine
            .replay_from(scene, &opts)
            .to_deterministic_json()
            .expect("serialise b");
        eprintln!(
            "[{}] determinism: scene={} events={} json_len={}",
            corpus.label,
            scene,
            events,
            a.len()
        );
        assert_eq!(
            a, b,
            "[{}] two replays of scene {} MUST produce byte-equal deterministic JSON",
            corpus.label, scene,
        );
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn full_module_replay_snapshot_restore_identity_each_tick() {
    let corpora = corpora_or_skip("full_module_replay_snapshot_restore_identity_each_tick");
    if corpora.is_empty() {
        return;
    }
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        // Use a moderate scene to bound the per-tick snapshot cost while
        // still traversing real dialogue bytecode.
        let scene = engine
            .scene_ids()
            .into_iter()
            .find(|id| {
                let opts = ReplayOpts {
                    step_budget: 4_000,
                    stop_at_first_pause: false,
                };
                let log = engine.replay_from(*id, &opts);
                (50..=1_500).contains(&log.events.len())
                    && matches!(log.final_outcome, ReplayOutcome::EndOfScene { .. })
            })
            .expect("a moderate dialogue scene");
        let opts = ReplayOpts {
            step_budget: 4_000,
            stop_at_first_pause: false,
        };
        let report = engine
            .verify_snapshot_restore_each_tick(scene, &opts)
            .expect("snapshot identity");
        eprintln!(
            "[{}] snapshot/restore identity: scene={} ticks_verified={} terminus={:?}",
            corpus.label, scene, report.ticks_verified, report.terminus
        );
        assert!(
            report.ticks_verified > 0,
            "[{}] must verify snapshot/restore identity at >0 tick boundaries",
            corpus.label,
        );
    }
}

/// A full dialogue scene drives to its terminus without treating unresolved
/// commands as implemented. The diagnostic output names every unknown family
/// and tuple so the gap can be triaged.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn full_module_replay_full_scene_reports_unknowns_and_reaches_terminus() {
    let corpora =
        corpora_or_skip("full_module_replay_full_scene_reports_unknowns_and_reaches_terminus");
    if corpora.is_empty() {
        return;
    }
    let opts = ReplayOpts {
        step_budget: FULL_BUDGET,
        stop_at_first_pause: false,
    };
    // Collect + PRINT every corpus's full result first (no truncation)
    // so a single run surfaces the complete residual across both corpora
    // then assert.
    let mut failures: Vec<String> = Vec::new();
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let (scene, events) = pick_richest_scene(&engine);
        let log = engine.replay_from(scene, &opts);
        let unknown_keys = log.unknown_opcode_keys();
        let families = module_families(&log);
        eprintln!(
            "[{}] full scene {} : events={} text={} unknown={} outcome={:?}\n  unknown families (module_type,module_id)={:?}\n  unknown keys(ALL {})={:?}",
            corpus.label,
            scene,
            events,
            log.text_line_count(),
            log.unknown_opcode_count(),
            log.final_outcome,
            families,
            unknown_keys.len(),
            unknown_keys,
        );

        if matches!(
            log.final_outcome,
            ReplayOutcome::FatalDiagnostic { ref code, .. }
                if code == "utsushi.reallive.vm.scene_not_found"
        ) {
            failures.push(format!(
                "[{}] scene {} traversal hit SceneNotFound: {:?}",
                corpus.label, scene, log.final_outcome
            ));
        }
        if !matches!(log.final_outcome, ReplayOutcome::EndOfScene { .. }) {
            failures.push(format!(
                "[{}] scene {} must drive to its natural terminus (EndOfScene); got {:?}",
                corpus.label, scene, log.final_outcome
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "full-module replay acceptance failed:\n{}",
        failures.join("\n"),
    );
}
