//! Real-bytes regression for `utsushi-stream-decode-desync-scene2-sweetie`.
//!
//! # The bug
//!
//! utsushi's [`decode_bytecode_stream`] hard-failed on Sweetie HD scene 2
//! (the button-object game-select) with
//! `MalformedElement { position: 526 }` — its standalone `0x24`
//! ExpressionElement decoder required the compound-**assignment** form
//! (`<term> \<op:0x14..=0x24> <expr>`) and rejected any `\<op>` byte outside
//! `0x14..=0x24`. On scene 2 an expression element carries a `\<op>` of
//! `0x03`, so the walker desynced and the whole scene was dropped from the
//! carve/replay store. The proven `kaifuu-reallive` decoder frames the same
//! `0x24` element as a **general expression** (`parse_expression`, any op
//! byte after `\`) and decodes the scene cleanly.
//!
//! This surfaced on the game-select carve path, which walks the AVG32-
//! decompressed scenes **without** the `use_xor_2` recovery (Sweetie HD is
//! compiler `110002`). The `decoder_parity_real_bytes` suite could not catch
//! it: it feeds both decoders the `use_xor_2`-decrypted bytes, on which utsushi
//! already framed scene 2 identically to kaifuu. The divergence lived purely
//! in the stricter expression-element grammar and only manifested on the
//! non-decrypted (or otherwise-diverging) byte stream.
//!
//! # What this proves, on REAL bytes (Sweetie HD)
//!
//! 1. **No desync.** [`decode_bytecode_stream`] on the non-decrypted scene-2
//!    bytecode is `Ok` (previously `Err(MalformedElement@526)`), so the carve
//!    walker no longer drops the game-select scene.
//! 2. **Kaifuu structure recovered.** utsushi and kaifuu recover the SAME
//!    intra-scene goto-pointer fan-out (the game-select's `goto_on` targets).
//! 3. **Byte-faithful parity.** On the `use_xor_2`-decrypted (faithful) scene-2
//!    bytecode, utsushi's element boundaries are byte-identical to kaifuu's.
//! 4. **Store load.** [`build_scene_store`] now loads scene 2 (it is present in
//!    the store's scene ids) instead of skipping it.
//!
//! No copyrighted text is asserted — only offsets, element/opcode counts, and
//! goto targets. `#[ignore]`-gated for the periodic oracle; run with:
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> \`
//! `cargo test -p utsushi-reallive --test scene2_desync_regression_real_bytes -- --ignored`

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{
    Xor2DecScene, collect_goto_pointer_sites, parse_real_bytecode_spans,
    recover_and_decrypt_archive,
};
use utsushi_reallive::{
    BytecodeElement, DecompressedScene, build_scene_store, decode_bytecode_stream,
    decompress_all_scenes,
};

/// Scene-directory slot id of the Sweetie HD button-object game-select.
const GAME_SELECT_SCENE_ID: u16 = 2;

/// Decompress every populated scene through the AVG32 first-level inflate
/// (NO `use_xor_2` recovery) — the exact byte stream the game-select carve
/// walks and on which the desync reproduced.
fn decompressed_scenes(seen_bytes: &[u8]) -> Vec<DecompressedScene> {
    decompress_all_scenes(seen_bytes).expect("decompress archive")
}

/// The `use_xor_2`-decrypted bytecode of one scene (the faithful stream the
/// decoder-parity suite uses). The `use_xor_2` key is recovered from the WHOLE
/// archive, so decryption must run over every scene together — decrypting a
/// single scene in isolation cannot recover the key and yields garbage.
fn xor2_decrypted(scenes: &[DecompressedScene], scene_id: u16) -> Vec<u8> {
    let mut archive: Vec<Xor2DecScene> = scenes
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut archive);
    let idx = scenes
        .iter()
        .position(|s| s.scene_id == scene_id)
        .expect("scene present");
    archive[idx].bytecode.clone()
}

/// Element-start byte offsets kaifuu's width-carrying decode produces.
fn kaifuu_boundaries(bytes: &[u8]) -> Vec<usize> {
    let mut off = 0usize;
    parse_real_bytecode_spans(bytes)
        .expect("kaifuu decodes")
        .into_iter()
        .map(|(_, consumed)| {
            let start = off;
            off += consumed;
            start
        })
        .collect()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene2_decodes_without_desync_and_matches_kaifuu() {
    let Some(corpus) = real_corpus::corpus_1() else {
        real_corpus::require_real_bytes(
            "scene2_decodes_without_desync_and_matches_kaifuu (set ITOTORI_REAL_GAME_ROOT)",
        );
        return;
    };
    let seen_bytes = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|err| panic!("read {}: {err}", corpus.seen_txt.display()));

    let scenes = decompressed_scenes(&seen_bytes);
    let scene2 = scenes
        .iter()
        .find(|s| s.scene_id == GAME_SELECT_SCENE_ID)
        .expect("Sweetie HD scene 2 is present");

    // 1. No desync: utsushi decodes the non-decrypted scene-2 bytecode. This
    //    is the exact regression — the old expression-element grammar failed
    //    here with MalformedElement@526.
    let utsushi_nonxor2 = decode_bytecode_stream(&scene2.bytecode)
        .expect("utsushi decodes non-decrypted scene 2 without desync");
    assert!(
        !utsushi_nonxor2.is_empty(),
        "decoded scene 2 must carry elements",
    );

    // 2. Kaifuu structure recovered: the game-select's intra-scene goto-pointer
    //    fan-out is identical between kaifuu and the (now non-desyncing)
    //    utsushi decode. kaifuu is the ground-truth decoder.
    let kaifuu_sites = collect_goto_pointer_sites(&scene2.bytecode)
        .expect("kaifuu collects goto sites on scene 2");
    let mut kaifuu_targets: Vec<i32> = kaifuu_sites.iter().map(|s| s.target).collect();
    kaifuu_targets.sort_unstable();
    kaifuu_targets.dedup();
    assert!(
        kaifuu_sites.len() >= 12 && kaifuu_targets.len() == 7,
        "scene 2 is the game-select: expected >=12 goto-pointer sites over 7 \
         distinct intra-scene targets; got sites={} targets={kaifuu_targets:?}",
        kaifuu_sites.len(),
    );

    // 3. Byte-faithful parity: on the use_xor_2-decrypted (faithful) bytes, the
    //    utsushi and kaifuu element boundaries are byte-identical.
    let decrypted = xor2_decrypted(&scenes, GAME_SELECT_SCENE_ID);
    let utsushi_boundaries: Vec<usize> = decode_bytecode_stream(&decrypted)
        .expect("utsushi decodes decrypted scene 2")
        .iter()
        .map(BytecodeElement::byte_offset)
        .collect();
    assert_eq!(
        utsushi_boundaries,
        kaifuu_boundaries(&decrypted),
        "on the faithful (decrypted) scene-2 bytes, utsushi element boundaries \
         must match kaifuu's exactly",
    );

    // 4. Store load: build_scene_store no longer skips scene 2.
    let (store, _shift_jis, _stats) =
        build_scene_store(&seen_bytes).expect("build scene store from Sweetie HD");
    assert!(
        store.scene_ids().contains(&GAME_SELECT_SCENE_ID),
        "scene 2 (the game-select) must be loaded into the replay store, not skipped",
    );
}
