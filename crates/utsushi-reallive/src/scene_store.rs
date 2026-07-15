//! Multi-scene store construction from a Seen.txt envelope.
//!
//! Decompresses and decodes every populated scene into an
//! [`InMemorySceneStore`], with Shift-JIS textout offsets and skip
//! diagnostics. Shared by the linear-walk and branch-following replay
//! paths so archive load is single-sourced.

use std::collections::HashSet;

use crate::bytecode_element::{BytecodeElement, TextoutEncoding, decode_bytecode_stream};
use crate::decompressor::AvgDecompressor;
use crate::replay::ReplayError;
use crate::scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader};
use crate::scene_index::RealSceneIndex;
use crate::vm::{InMemorySceneStore, Scene, SceneId};

/// The multi-scene store, its `(scene, offset)` Shift-JIS textout set
/// and the build diagnostics — the tuple [`build_scene_store`] returns.
pub type SceneStoreBundle = (InMemorySceneStore, HashSet<(SceneId, u32)>, SceneStoreStats);

/// Diagnostic counts produced while building the multi-scene store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SceneStoreStats {
    /// Populated directory slots observed in the Seen.txt index.
    pub populated: usize,
    /// Scenes that decompressed + decoded into a non-empty element list
    /// and were inserted into the store.
    pub loaded: usize,
    /// Populated scenes that failed to decompress / decode / were empty
    /// and were skipped. A cross-scene Jump/FarCall into a skipped scene
    /// surfaces as a typed `SceneNotFound` at the VM layer, so skips are
    /// never silent.
    pub skipped: usize,
}

/// One decoded scene: its id, decompressed bytecode elements, and the
/// byte offsets of its Shift-JIS-tagged textout runs. Produced by
/// [`decode_one_scene`] and consumed by [`build_scene_store`].
struct DecodedScene {
    scene: Scene,
    shift_jis_offsets: Vec<u32>,
}

/// One decompressed-but-not-yet-decoded scene: its id, plaintext
/// `compiler_version` (decides `use_xor_2`), and its AVG32-decompressed
/// bytecode. This is the seam a real-bytes test uses to interpose the
/// dev-only `kaifuu-reallive` `use_xor_2` segment-cipher recovery between
/// the first-level AVG32 inflate (owned here) and the bytecode decode:
/// the test decompresses the whole archive via [`decompress_all_scenes`]
/// hands the eligible scenes to the recovery, then rebuilds the store via
/// [`build_scene_store_from_decompressed`]. No key material lives in this
/// crate.
#[derive(Debug, Clone)]
pub struct DecompressedScene {
    /// Scene-directory slot id.
    pub scene_id: SceneId,
    /// Plaintext compiler version from the scene header.
    pub compiler_version: u32,
    /// AVG32-decompressed (still `use_xor_2`-ciphered, when eligible)
    /// bytecode bytes.
    pub bytecode: Vec<u8>,
}

/// Decompress a single scene blob: slice its compressed bytecode and run
/// the AVG32 first-level XOR + LZSS inflate. Returns the plaintext
/// compiler version plus the decompressed bytecode. The second-level
/// `use_xor_2` segment cipher (Sweetie HD, compiler `110002`) is NOT
/// applied here — a caller that needs it interposes the dev-only
/// `kaifuu-reallive` recovery on [`DecompressedScene::bytecode`].
fn decompress_one_scene(blob: &[u8], scene_id: SceneId) -> Result<DecompressedScene, ReplayError> {
    if blob.len() < SCENE_HEADER_BYTE_LEN {
        return Err(ReplayError::SceneHeaderParse {
            scene: scene_id,
            reason: format!(
                "scene blob length {} is shorter than {SCENE_HEADER_BYTE_LEN}-byte header",
                blob.len()
            ),
        });
    }
    let (header, _header_warnings) =
        SceneHeader::parse(blob).map_err(|err| ReplayError::SceneHeaderParse {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    let bytecode_offset = header.bytecode_offset as usize;
    let compressed_len = header.bytecode_compressed_size as usize;
    let compressed_end =
        bytecode_offset
            .checked_add(compressed_len)
            .ok_or(ReplayError::SliceOverflow {
                scene: scene_id,
                reason: format!(
                    "bytecode_offset {bytecode_offset} + compressed_len {compressed_len} \
                     overflows usize",
                ),
            })?;
    if compressed_end > blob.len() {
        return Err(ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!(
                "compressed_end {compressed_end} exceeds blob.len() {}",
                blob.len()
            ),
        });
    }
    let compressed = &blob[bytecode_offset..compressed_end];

    let (decompressed, _decompress_warnings) = AvgDecompressor::new()
        .decompress(
            compressed,
            header.bytecode_uncompressed_size,
            None,
            header.compiler_version,
        )
        .map_err(|err| ReplayError::DecompressFailed {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    Ok(DecompressedScene {
        scene_id,
        compiler_version: header.compiler_version,
        bytecode: decompressed,
    })
}

/// Decode already-decompressed (and, when applicable, `use_xor_2`-
/// decrypted) bytecode into a [`DecodedScene`].
fn decode_decompressed(
    decompressed: &[u8],
    scene_id: SceneId,
) -> Result<DecodedScene, ReplayError> {
    let elements =
        decode_bytecode_stream(decompressed).map_err(|err| ReplayError::BytecodeDecode {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    if elements.is_empty() {
        return Err(ReplayError::EmptyScene { scene: scene_id });
    }

    // Pre-walk: collect the byte offsets of every Shift-JIS-tagged
    // textout run. The dispatch loop drives `dispatch_textout` only when
    // the VM's (scene, pc) lands on a Shift-JIS run.
    let mut shift_jis_offsets: Vec<u32> = Vec::new();
    for element in &elements {
        if let BytecodeElement::Textout {
            encoding_hint,
            byte_offset,
            ..
        } = element
            && matches!(encoding_hint, TextoutEncoding::ShiftJis)
        {
            shift_jis_offsets.push(u32::try_from(*byte_offset).unwrap_or(u32::MAX));
        }
    }

    let scene =
        Scene::new(scene_id, elements).ok_or(ReplayError::EmptyScene { scene: scene_id })?;
    Ok(DecodedScene {
        scene,
        shift_jis_offsets,
    })
}

/// Decompress + decode a single scene blob (no `use_xor_2` recovery).
fn decode_one_scene(blob: &[u8], scene_id: SceneId) -> Result<DecodedScene, ReplayError> {
    let decompressed = decompress_one_scene(blob, scene_id)?;
    decode_decompressed(&decompressed.bytecode, scene_id)
}

/// Decompress EVERY populated scene of a Seen.txt envelope through the
/// AVG32 first-level inflate, returning one [`DecompressedScene`] per
/// scene that decompressed cleanly. Scenes whose blob slice / header
/// inflate fails are dropped (the same skip policy as
/// [`build_scene_store`]); the returned count vs the index length is the
/// caller's skip diagnostic.
///
/// This is the entry point a real-bytes test uses to stage the dev-only
/// `use_xor_2` recovery: decompress here, decrypt the eligible scenes
/// externally, then rebuild via [`build_scene_store_from_decompressed`].
pub fn decompress_all_scenes(seen_bytes: &[u8]) -> Result<Vec<DecompressedScene>, ReplayError> {
    let index = RealSceneIndex::parse(seen_bytes).map_err(|err| ReplayError::SceneIndexParse {
        reason: err.to_string(),
    })?;
    let mut out = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let scene_id = entry.scene_id;
        if let Ok(decompressed) =
            slice_scene_blob(seen_bytes, scene_id, entry.byte_offset, entry.byte_len)
                .and_then(|blob| decompress_one_scene(blob, scene_id))
        {
            out.push(decompressed);
        }
    }
    Ok(out)
}

/// Build a multi-scene store from a list of already-decompressed (and
/// when applicable, `use_xor_2`-decrypted) scenes. `populated` should be
/// the Seen.txt index length so [`SceneStoreStats::skipped`] reflects the
/// scenes that did not survive decompress + decode.
pub fn build_scene_store_from_decompressed(
    scenes: &[DecompressedScene],
    populated: usize,
) -> Result<SceneStoreBundle, ReplayError> {
    let mut store = InMemorySceneStore::new();
    let mut shift_jis_textout_offsets: HashSet<(SceneId, u32)> = HashSet::new();
    let mut loaded = 0usize;
    for scene in scenes {
        // A scene that fails to decode is SKIPPED (reflected in
        // `skipped`), never silently masked: a cross-scene reference into
        // it would surface a typed `SceneNotFound` at the VM layer.
        if let Ok(decoded) = decode_decompressed(&scene.bytecode, scene.scene_id) {
            for offset in decoded.shift_jis_offsets {
                shift_jis_textout_offsets.insert((scene.scene_id, offset));
            }
            store.insert(decoded.scene);
            loaded += 1;
        }
    }
    let stats = SceneStoreStats {
        populated,
        loaded,
        skipped: populated.saturating_sub(loaded),
    };
    Ok((store, shift_jis_textout_offsets, stats))
}

/// Locate + slice one populated scene's blob out of the Seen.txt
/// envelope by its directory entry. Returns a typed slice-overflow error
/// if the declared range exceeds the envelope.
fn slice_scene_blob(
    seen_bytes: &[u8],
    scene_id: SceneId,
    byte_offset: u64,
    byte_len: u32,
) -> Result<&[u8], ReplayError> {
    let blob_start = usize::try_from(byte_offset).map_err(|_| ReplayError::SliceOverflow {
        scene: scene_id,
        reason: format!("byte_offset {byte_offset} exceeds usize::MAX"),
    })?;
    let blob_len = byte_len as usize;
    let blob_end = blob_start
        .checked_add(blob_len)
        .ok_or(ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!("blob_start {blob_start} + byte_len {blob_len} overflows usize"),
        })?;
    if blob_end > seen_bytes.len() {
        return Err(ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!(
                "blob_end {blob_end} exceeds seen_bytes.len() {}",
                seen_bytes.len()
            ),
        });
    }
    Ok(&seen_bytes[blob_start..blob_end])
}

/// Build a MULTI-scene [`InMemorySceneStore`] from EVERY populated scene
/// in a Seen.txt envelope so cross-scene Jump/FarCall resolves against a
/// real archive. Returns the store, the Shift-JIS textout offset set
/// keyed by `(scene, offset)`, and diagnostic [`SceneStoreStats`].
///
/// A scene that fails to decompress / decode / is empty is SKIPPED (and
/// counted in [`SceneStoreStats::skipped`]) rather than aborting the
/// whole build — an unresolved cross-scene jump into a skipped scene
/// surfaces as a typed `SceneNotFound` at the VM layer, so a genuine gap
/// is never silently masked.
pub fn build_scene_store(seen_bytes: &[u8]) -> Result<SceneStoreBundle, ReplayError> {
    let index = RealSceneIndex::parse(seen_bytes).map_err(|err| ReplayError::SceneIndexParse {
        reason: err.to_string(),
    })?;
    let mut store = InMemorySceneStore::new();
    let mut shift_jis_textout_offsets: HashSet<(SceneId, u32)> = HashSet::new();
    let mut loaded = 0usize;
    let mut skipped = 0usize;
    let populated = index.entries.len();
    for entry in &index.entries {
        let scene_id = entry.scene_id;
        let decoded = slice_scene_blob(seen_bytes, scene_id, entry.byte_offset, entry.byte_len)
            .and_then(|blob| decode_one_scene(blob, scene_id));
        match decoded {
            Ok(decoded) => {
                for offset in decoded.shift_jis_offsets {
                    shift_jis_textout_offsets.insert((scene_id, offset));
                }
                store.insert(decoded.scene);
                loaded += 1;
            }
            Err(_) => {
                skipped += 1;
            }
        }
    }
    let stats = SceneStoreStats {
        populated,
        loaded,
        skipped,
    };
    Ok((store, shift_jis_textout_offsets, stats))
}
