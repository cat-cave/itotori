//! Real-bytes acceptance for
//! `reallive-utsushi-decoder-completeness-real-parity`.
//!
//! Proves utsushi's [`decode_bytecode_stream`] reaches **true parity** with
//! the proven `kaifuu-reallive` decompiler (`parse_real_bytecode`) on the two
//! staged RealLive corpora: every populated scene the kaifuu decoder decodes,
//! utsushi decodes too. Before this node utsushi decoded only 133/198 Sweetie
//! HD + 16/79 Kanon scenes (the LOADABLE subset), so a cross-scene
//! Jump/FarCall into an un-decoded-but-present scene surfaced a spurious
//! `SceneNotFound`. The gap was a diverged expression / special-parameter /
//! SelectElement grammar in utsushi's decoder; it is now aligned onto the
//! same grammar the kaifuu decoder uses.
//!
//! Both decoders are handed the **identical** decompressed + `use_xor_2`-
//! decrypted bytes per scene (the dev-only `kaifuu-reallive` recovery is
//! interposed exactly as the headless / full-module replay harnesses do), so
//! any decode divergence is purely a decoder-logic difference, not an input
//! difference.
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE
//! (no opt-out; these `#[ignore]`-d suites run only in the periodic
//! ground-truth oracle, `just real-bytes-oracle`, where corpora are staged).
//! Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//! cargo test -p utsushi-reallive --test decoder_parity_real_bytes --
//! --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{Xor2DecScene, parse_real_bytecode, recover_and_decrypt_archive};
use utsushi_reallive::{RealSceneIndex, decode_bytecode_stream, decompress_all_scenes};

/// Expected populated-scene count per staged corpus, keyed by label. These
/// are the counts the proven `kaifuu-reallive` `multi_corpus_real_bytes`
/// harness pins (Sweetie HD 198, Kanon 79); the parity gate asserts utsushi
/// decodes ALL of them.
fn expected_populated(label: &str) -> Option<usize> {
    match label {
        "corpus-1" => Some(198), // Oshioki Sweetie HD (110002, use_xor_2)
        "corpus-2" => Some(79),  // Kanon (10002, no xor_2)
        _ => None,
    }
}

/// Decompress every populated scene through the AVG32 first-level inflate,
/// then interpose the dev-only `use_xor_2` recovery (a no-op for Kanon), so
/// both decoders see the same plaintext bytecode the kaifuu multi-corpus
/// harness decodes.
fn staged_scene_bytecode(seen_bytes: &[u8]) -> Vec<(u16, Vec<u8>)> {
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, decrypted) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = decrypted.bytecode;
    }
    decompressed
        .into_iter()
        .map(|scene| (scene.scene_id, scene.bytecode))
        .collect()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2)"]
fn utsushi_decode_reaches_kaifuu_parity_on_every_populated_scene() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "utsushi_decode_reaches_kaifuu_parity_on_every_populated_scene \
             (set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    }

    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).unwrap_or_else(|err| {
            panic!(
                "[{}] read {}: {err}",
                corpus.label,
                corpus.seen_txt.display()
            )
        });

        let populated = RealSceneIndex::parse(&bytes)
            .unwrap_or_else(|err| panic!("[{}] parse scene index: {err}", corpus.label))
            .entries
            .len();

        let scenes = staged_scene_bytecode(&bytes);

        let mut kaifuu_ok = 0usize;
        let mut utsushi_ok = 0usize;
        let mut kaifuu_ok_utsushi_fail: Vec<(u16, String)> = Vec::new();
        for (scene_id, bc) in &scenes {
            let kaifuu = parse_real_bytecode(bc);
            let utsushi = decode_bytecode_stream(bc);
            if kaifuu.is_ok() {
                kaifuu_ok += 1;
            }
            if utsushi.is_ok() {
                utsushi_ok += 1;
            }
            // The core parity invariant: no scene the proven kaifuu decoder
            // decodes may fail in utsushi (that scene would be skipped by
            // `build_scene_store` and surface a spurious `SceneNotFound` for a
            // cross-scene Jump/FarCall into it).
            if kaifuu.is_ok()
                && let Err(err) = &utsushi
            {
                kaifuu_ok_utsushi_fail.push((*scene_id, err.to_string()));
            }
        }

        eprintln!(
            "[{}] decode parity: populated={populated} decoded_scenes={} \
             kaifuu_ok={kaifuu_ok} utsushi_ok={utsushi_ok}",
            corpus.label,
            scenes.len(),
        );

        assert!(
            kaifuu_ok_utsushi_fail.is_empty(),
            "[{}] {} scene(s) decode in the proven kaifuu decompiler but FAIL in utsushi \
             (decoder parity broken); first few: {:?}",
            corpus.label,
            kaifuu_ok_utsushi_fail.len(),
            &kaifuu_ok_utsushi_fail[..kaifuu_ok_utsushi_fail.len().min(8)],
        );

        // The kaifuu decoder decodes every populated scene (the proven 100%
        // bar); utsushi now matches it exactly.
        assert_eq!(
            kaifuu_ok, populated,
            "[{}] kaifuu decoded {kaifuu_ok}/{populated} populated scenes (expected all)",
            corpus.label,
        );
        assert_eq!(
            utsushi_ok, kaifuu_ok,
            "[{}] utsushi decode count ({utsushi_ok}) must equal kaifuu decode count ({kaifuu_ok})",
            corpus.label,
        );
        assert_eq!(
            utsushi_ok, populated,
            "[{}] utsushi must decode ALL {populated} populated scenes; got {utsushi_ok}",
            corpus.label,
        );

        // Pin the exact per-title counts the proven kaifuu multi-corpus
        // harness reports (198/198 Sweetie HD, 79/79 Kanon), so a regression
        // that silently drops a scene from either archive fails here.
        if let Some(expected) = expected_populated(corpus.label) {
            assert_eq!(
                populated, expected,
                "[{}] expected {expected} populated scenes for this title; got {populated} \
                 (corpus mis-staged?)",
                corpus.label,
            );
            assert_eq!(
                utsushi_ok, expected,
                "[{}] utsushi must decode {expected}/{expected} scenes",
                corpus.label,
            );
        }
    }

    // Multi-game validation: parity must be proven on >= 2 distinct RealLive
    // titles, mirroring the kaifuu multi-corpus gate.
    assert!(
        corpora.len() >= 2,
        "decoder parity must be proven on >= 2 RealLive corpora; only {} resolved \
         (set {})",
        corpora.len(),
        real_corpus::REAL_GAME_ROOT_2_ENV,
    );
}
