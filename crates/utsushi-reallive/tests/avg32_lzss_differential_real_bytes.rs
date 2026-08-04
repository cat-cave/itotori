//! Real-bytes AVG32 LZSS differential proof, owned by the real-bytes lane.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use utsushi_reallive::{AvgDecompressor, RealSceneIndex, SCENE_HEADER_BYTE_LEN, SceneHeader};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ErrCategory {
    Truncated,
    BackRefOutOfRange,
    UnexpectedEndOfStream,
}

fn kaifuu_category(err: &kaifuu_reallive::DecompressError) -> ErrCategory {
    use kaifuu_reallive::DecompressError as E;
    match err {
        E::TruncatedInput { .. } => ErrCategory::Truncated,
        E::BackReferenceOutOfRange { .. } => ErrCategory::BackRefOutOfRange,
        E::UnexpectedEndOfStream { .. } => ErrCategory::UnexpectedEndOfStream,
    }
}

fn utsushi_category(err: &utsushi_reallive::DecompressError) -> ErrCategory {
    use utsushi_reallive::DecompressError as E;
    match err {
        E::TruncatedInput { .. } => ErrCategory::Truncated,
        E::BackReferenceOutOfRange { .. } => ErrCategory::BackRefOutOfRange,
        E::UnexpectedEndOfStream { .. } => ErrCategory::UnexpectedEndOfStream,
    }
}

fn assert_decoders_agree(label: &str, compressed: &[u8], dst_len: u32) -> Option<Vec<u8>> {
    let kaifuu = kaifuu_reallive::decompress_avg32(compressed, dst_len as usize);
    let utsushi = AvgDecompressor::new().decompress(compressed, dst_len, None, 0);

    match (kaifuu, utsushi) {
        (Ok(k_out), Ok((u_out, warnings))) => {
            assert!(
                warnings.is_empty(),
                "[{label}] runtime decoder emitted warnings under compiler_version=0/None key \\
                 (should be silent for the codec comparison): {warnings:?}",
            );
            assert_eq!(
                k_out,
                u_out,
                "[{label}] DIVERGENCE: extract (kaifuu) and runtime (utsushi) decoders produced \\
                 DIFFERENT bytes for the same AVG32 stream — the runtime would replay different \\
                 bytes than were extracted. kaifuu.len()={}, utsushi.len()={}",
                k_out.len(),
                u_out.len(),
            );
            Some(k_out)
        }
        (Err(k_err), Err(u_err)) => {
            let k_cat = kaifuu_category(&k_err);
            let u_cat = utsushi_category(&u_err);
            assert_eq!(
                k_cat, u_cat,
                "[{label}] error-category DIVERGENCE: extract (kaifuu) rejected as {k_cat:?} \\
                 ({k_err}) but runtime (utsushi) rejected as {u_cat:?} ({u_err}) — the two \\
                 decoders disagree on HOW a malformed stream fails",
            );
            None
        }
        (Ok(k_out), Err(u_err)) => panic!(
            "[{label}] DIVERGENCE: extract (kaifuu) DECODED the stream to {} bytes but runtime \\
             (utsushi) REJECTED it ({u_err}) — the runtime would fail to replay a scene the \\
             extract path accepted",
            k_out.len(),
        ),
        (Err(k_err), Ok((u_out, _))) => panic!(
            "[{label}] DIVERGENCE: runtime (utsushi) DECODED the stream to {} bytes but extract \\
             (kaifuu) REJECTED it ({k_err}) — the extract path would fail to produce a scene the \\
             runtime accepts",
            u_out.len(),
        ),
    }
}

#[test]
fn differential_on_real_scene_bytecode() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes("differential_on_real_scene_bytecode");
        return;
    }

    let mut total_scenes = 0usize;
    for corpus in &corpora {
        let bytes = std::fs::read(&corpus.seen_txt).unwrap_or_else(|err| {
            panic!(
                "[{}] read {}: {err}",
                corpus.label,
                corpus.seen_txt.display()
            )
        });
        let index = RealSceneIndex::parse(&bytes)
            .unwrap_or_else(|err| panic!("[{}] parse scene index: {err}", corpus.label));

        for entry in &index.entries {
            let start = entry.byte_offset as usize;
            let end = start + entry.byte_len as usize;
            let blob = &bytes[start..end];
            if blob.len() < SCENE_HEADER_BYTE_LEN {
                continue;
            }
            let Ok((header, _warnings)) = SceneHeader::parse(blob) else {
                continue;
            };
            let bc_off = header.bytecode_offset as usize;
            let bc_len = header.bytecode_compressed_size as usize;
            if bc_len == 0 || bc_off + bc_len > blob.len() {
                continue;
            }
            let compressed = &blob[bc_off..bc_off + bc_len];
            let label = format!("{}/scene-{}", corpus.label, entry.scene_id);
            let out = assert_decoders_agree(&label, compressed, header.bytecode_uncompressed_size);
            if let Some(out) = out {
                assert_eq!(
                    out.len(),
                    header.bytecode_uncompressed_size as usize,
                    "[{label}] decoded length must equal the declared uncompressed size",
                );
                total_scenes += 1;
            }
        }
    }

    assert!(
        total_scenes > 0,
        "real-bytes differential resolved corpora but decoded zero populated scenes",
    );
    assert!(
        corpora.len() >= 2,
        "AVG32 codec differential must be proven on >= 2 RealLive corpora; only {} resolved",
        corpora.len(),
    );
    eprintln!(
        "AVG32 codec differential: {total_scenes} real scenes byte-identical across decoders"
    );
}
