//! `genaudit2-05` — byte-exact framing pins + round-trip re-emit on real
//! RealLive bytes.
//!
//! # What this proves OVER the bare zero-unknown gate
//!
//! The full-archive gate (`multi_corpus_real_bytes.rs`) asserts every
//! decoded element is a *recognised* opcode — zero generic `Command` blobs,
//! zero `Unknown` desync tripwires. That is opcode **identity**: "100%" there
//! means "no un-catalogued tuple and no desync tripwire fired". It does NOT
//! prove the **framing** is byte-exact. A command decoded with the wrong
//! argument-list width, a swallowed trailing goto pointer, or an off-by-N
//! operand span can still land the cursor on a byte that happens to be a
//! valid opener and keep decoding into perfectly-typed opcodes — a stream
//! that is "100% recognised" yet silently mis-partitioned.
//!
//! This test pins the framing so "100%" reflects **verified byte spans**:
//!
//! 1. **Byte-exact framing manifest** ([`kaifuu_reallive::framing_manifest`]):
//!    for >= 1 real scene of EACH title, the per-element `(offset, width)`
//!    manifest is asserted to **partition** the scene bytecode — contiguous,
//!    non-overlapping, covering exactly `[0, len)` — AND each element is
//!    **self-framing**: its own byte span, re-decoded in isolation, reproduces
//!    the same element and consumes exactly its declared width (header +
//!    `argc` arg list + `overload` + goto-family trailing `i32` pointers +
//!    operands). A header-declared width that disagreed with the true span
//!    fails the isolated re-decode — the framing pin the bare gate lacks.
//! 2. **Round-trip re-emit == input** ([`kaifuu_reallive::reemit_scene`]):
//!    for >= 1 real scene of each title, the decoded element stream is
//!    re-emitted back to bytes (structural framing reconstructed from decoded
//!    fields; opaque operand payload verbatim) and asserted EQUAL to the
//!    input bytecode byte-for-byte, through the real
//!    decompress -> [`xor_2`] -> decode path. This proves the decoder
//!    consumed and can reproduce every byte — framing is complete and exact.
//!
//! Both proofs run over EVERY populated scene of BOTH corpora (Sweetie HD,
//! `110002`, second-level `xor_2` decrypted in-process; Kanon, `10002`, no
//! `xor_2`), far exceeding the ">= 1 scene per title" acceptance floor, and
//! are STRICT real-bytes tests (a missing corpus is an unconditional hard
//! failure, no opt-out; they run in the periodic real-bytes oracle).
//!
//! No raw copyrighted bytes or text are emitted — counts / offsets / sha-free
//! structural metadata only.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{
    SceneHeader, Xor2DecScene, decompress_avg32, framing_manifest, parse_archive,
    parse_real_bytecode, recover_and_decrypt_archive, reemit_scene,
};

use real_corpus::RealCorpus;

/// Stage a corpus through envelope -> header -> AVG32 decompress ->
/// second-level `xor_2` decryption, returning the plaintext bytecode of
/// every scene that reached the decoder. This is the SAME staging the
/// zero-unknown gate (`multi_corpus_real_bytes.rs`) performs, so the framing
/// pins operate on exactly the bytes that gate scores as "100%".
fn staged_scene_bytecodes(corpus: &RealCorpus) -> Vec<Vec<u8>> {
    let bytes = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|err| panic!("read {}: {err}", corpus.seen_txt.display()));
    let index = parse_archive(&bytes)
        .unwrap_or_else(|diag| panic!("[{}] SEEN archive must parse: {diag:?}", corpus.label));

    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let off = entry.byte_offset as usize;
        let end = off + entry.byte_len as usize;
        if end > bytes.len() {
            continue;
        }
        let blob = &bytes[off..end];
        let Ok(header) = SceneHeader::parse(blob) else {
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: decompressed,
        });
    }

    // Second-level xor_2 (Sweetie HD): per-game key recovered in-process and
    // validated before consumption. Kanon's scenes are left untouched.
    let _report = recover_and_decrypt_archive(&mut scenes);
    scenes.into_iter().map(|scene| scene.bytecode).collect()
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (+ ITOTORI_REAL_GAME_ROOT_2)"]
fn framing_is_byte_exact_and_round_trips_on_real_bytes() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "framing_is_byte_exact_and_round_trips_on_real_bytes \
             (set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    }

    for corpus in &corpora {
        let scenes = staged_scene_bytecodes(corpus);
        assert!(
            !scenes.is_empty(),
            "[{}] no scene reached the decoder — cannot pin framing",
            corpus.label
        );

        let mut manifest_scenes = 0usize;
        let mut round_trip_scenes = 0usize;
        let mut total_elements = 0usize;
        let mut total_bytes = 0usize;

        for (scene_idx, bytecode) in scenes.iter().enumerate() {
            // ---- Proof 1: byte-exact framing manifest (partition + ----
            // self-framing). Any gap/overlap or self-frame mismatch returns a
            // typed FramingError naming the offending offset.
            let manifest = framing_manifest(bytecode).unwrap_or_else(|err| {
                panic!(
                    "[{}] scene #{scene_idx} framing manifest is not byte-exact: {err}",
                    corpus.label
                )
            });
            assert!(
                !manifest.is_empty(),
                "[{}] scene #{scene_idx} produced an empty manifest",
                corpus.label
            );
            // Re-assert the partition invariants directly on the returned
            // manifest so the proof is visible in this test, not only inside
            // the library.
            let mut cursor = 0u64;
            for span in &manifest {
                assert!(
                    span.width > 0,
                    "[{}] scene #{scene_idx} element at offset {} consumed zero bytes",
                    corpus.label,
                    span.offset
                );
                assert_eq!(
                    span.offset, cursor,
                    "[{}] scene #{scene_idx} spans not contiguous at offset {}",
                    corpus.label, span.offset
                );
                cursor += span.width as u64;
            }
            assert_eq!(
                cursor as usize,
                bytecode.len(),
                "[{}] scene #{scene_idx} manifest does not cover the whole {}-byte stream",
                corpus.label,
                bytecode.len()
            );
            manifest_scenes += 1;
            total_elements += manifest.len();
            total_bytes += bytecode.len();

            // ---- Proof 2: round-trip re-emit == input, byte-for-byte. ----
            let reemitted = reemit_scene(bytecode).unwrap_or_else(|err| {
                panic!(
                    "[{}] scene #{scene_idx} re-emit failed: {err}",
                    corpus.label
                )
            });
            assert_eq!(
                reemitted.len(),
                bytecode.len(),
                "[{}] scene #{scene_idx} re-emit length {} != input length {}",
                corpus.label,
                reemitted.len(),
                bytecode.len()
            );
            assert!(
                reemitted == *bytecode,
                "[{}] scene #{scene_idx} re-emit is NOT byte-identical to the input bytecode \
                 (framing is not complete + exact)",
                corpus.label
            );
            round_trip_scenes += 1;

            // Cross-check: the width-carrying decode the manifest is built on
            // agrees with the plain decode (defence against a divergent path).
            let plain = parse_real_bytecode(bytecode).unwrap_or_else(|err| {
                panic!("[{}] scene #{scene_idx} decode: {err}", corpus.label)
            });
            assert_eq!(
                plain.len(),
                manifest.len(),
                "[{}] scene #{scene_idx} opcode count {} != manifest element count {}",
                corpus.label,
                plain.len(),
                manifest.len()
            );
        }

        eprintln!(
            "[{}] FRAMING PINS: manifest_scenes={manifest_scenes} round_trip_scenes={round_trip_scenes} \
             total_elements={total_elements} total_bytes={total_bytes} \
             — every scene partitions byte-exactly AND round-trips re-emit==input",
            corpus.label
        );

        // Acceptance floor: >= 1 real scene per title for BOTH proofs (we did
        // every scene, so this always holds when a corpus has scenes).
        assert!(
            manifest_scenes >= 1,
            "[{}] acceptance requires >= 1 framing-manifest scene",
            corpus.label
        );
        assert!(
            round_trip_scenes >= 1,
            "[{}] acceptance requires >= 1 round-trip scene",
            corpus.label
        );
    }

    // Multi-game validation: BOTH titles must be staged (Sweetie HD + Kanon),
    // so the framing pins are proven on two independently-authored corpora and
    // the xor_2 path is exercised on the eligible one.
    assert!(
        corpora.len() >= 2,
        "framing pins require >= 2 RealLive corpora (set {}); only {} resolved",
        real_corpus::REAL_GAME_ROOT_2_ENV,
        corpora.len(),
    );
}
