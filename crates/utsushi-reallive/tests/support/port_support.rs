// reason: shared engine-port test-support helpers; not every consumer test
// uses every helper.
#![allow(dead_code)]

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, EvidenceTier,
    PackageDescriptor, PackageKind, PackageSource, SinkCapability, SinkResult, TextLine,
    TextSurfaceSink, VfsError, VfsResult,
};
use utsushi_reallive::ReplayEngine;

/// A text sink that just counts (and buffers) emitted lines — used to
/// probe which real scene exercises the text sink.
#[derive(Debug, Default)]
pub struct CollectingTextSink {
    lines: Mutex<Vec<TextLine>>,
}

impl CollectingTextSink {
    pub fn count(&self) -> usize {
        self.lines.lock().expect("CollectingTextSink lock").len()
    }
}

impl TextSurfaceSink for CollectingTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines
            .lock()
            .expect("CollectingTextSink lock")
            .push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.lines.lock().expect("CollectingTextSink lock"))
    }
}

// -------------------------------------------------------------------------
// Asset packages
// -------------------------------------------------------------------------

/// An [`AssetPackage`] that resolves nothing — for structural / synthetic
/// tests where no g00 art is composited (an empty graphics stack renders a
/// background + the localized text overlay).
#[derive(Debug)]
pub struct NullAssetPackage;

impl AssetPackage for NullAssetPackage {
    fn id(&self) -> &'static str {
        "reallive-null"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "reallive-null".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("reallive-null".to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, _id: &AssetId) -> VfsResult<bool> {
        Ok(false)
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        Err(VfsError::AssetMissing { id: id.clone() })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        Err(VfsError::AssetMissing { id: id.clone() })
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

/// Minimal [`AssetPackage`] that resolves `g00/<NAME>.g00` against a real
/// on-disk g00 directory (case-sensitive; the caller supplies the on-disk
/// stem verbatim). Mirrors the render-real-bytes test helper so a real
/// RealLive port composites real g00 art.
#[derive(Debug)]
pub struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    pub fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }
}

fn strip_g00_prefix(logical: &str) -> &str {
    logical.strip_prefix("g00/").unwrap_or(logical)
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "reallive-port-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "reallive-port-g00".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("reallive-port-g00".to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.g00_dir.join(strip_g00_prefix(id.path())).exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let meta = fs::metadata(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let bytes = fs::read(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

// -------------------------------------------------------------------------
// Synthetic Seen.txt envelope
//
// One-scene envelope whose scene 1 emits a Shift-JIS textout run
// ("あいうえお") followed by `msg.pause` — copied verbatim from the
// `replay_scene_synthetic` builder so the engine-port smoke can drive REAL
// decoded text (through the whole scene-index → header → AVG32-inflate →
// bytecode-decode → dispatch chain) without a game corpus.
// -------------------------------------------------------------------------

const SLOT_BYTE_LEN: usize = 8;
const DIRECTORY_BYTE_LEN: usize = 80_000;
const SCENE_HEADER_BYTE_LEN: usize = 0x1d0;

/// A synthetic single-scene [`ReplayEngine`] whose scene 1 emits one
/// Shift-JIS text line.
pub fn synthetic_engine() -> ReplayEngine {
    let blob = build_scene_blob();
    let envelope = build_envelope(1, &blob);
    ReplayEngine::from_seen_bytes(&envelope).expect("synthetic engine builds")
}

fn build_envelope(scene_id: u16, scene_blob: &[u8]) -> Vec<u8> {
    let mut envelope = vec![0u8; DIRECTORY_BYTE_LEN];
    let blob_offset = u32::try_from(DIRECTORY_BYTE_LEN).expect("offset fits in u32");
    let blob_len = u32::try_from(scene_blob.len()).expect("scene blob length fits in u32");
    let slot_base = (scene_id as usize) * SLOT_BYTE_LEN;
    envelope[slot_base..slot_base + 4].copy_from_slice(&blob_offset.to_le_bytes());
    envelope[slot_base + 4..slot_base + 8].copy_from_slice(&blob_len.to_le_bytes());
    envelope.extend_from_slice(scene_blob);
    envelope
}

fn build_scene_blob() -> Vec<u8> {
    let textout: Vec<u8> = vec![
        0x82, 0xa0, // あ
        0x82, 0xa2, // い
        0x82, 0xa4, // う
        0x82, 0xa6, // え
        0x82, 0xa8, // お
    ];
    let pause_command: [u8; 8] = [0x23, 0x01, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00];
    let mut bytecode: Vec<u8> = Vec::new();
    bytecode.extend_from_slice(&textout);
    bytecode.extend_from_slice(&pause_command);

    let compressed = compress_avg32(&bytecode);

    let bytecode_offset_u32 = u32::try_from(SCENE_HEADER_BYTE_LEN).expect("header fits");
    let bytecode_uncompressed_size_u32 =
        u32::try_from(bytecode.len()).expect("decompressed bytecode fits");
    let bytecode_compressed_size_u32 =
        u32::try_from(compressed.len()).expect("compressed bytecode fits");
    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0x000..0x004]
        .copy_from_slice(&u32::try_from(SCENE_HEADER_BYTE_LEN).unwrap().to_le_bytes());
    header[0x004..0x008].copy_from_slice(&10002u32.to_le_bytes());
    header[0x020..0x024].copy_from_slice(&bytecode_offset_u32.to_le_bytes());
    header[0x024..0x028].copy_from_slice(&bytecode_uncompressed_size_u32.to_le_bytes());
    header[0x028..0x02c].copy_from_slice(&bytecode_compressed_size_u32.to_le_bytes());

    let mut blob = header;
    blob.extend_from_slice(&compressed);
    blob
}

fn compress_avg32(input: &[u8]) -> Vec<u8> {
    let mask = [
        0x8B, 0xE5, 0x5D, 0xC3, 0xA1, 0xE0, 0x30, 0x44, 0x00, 0x85, 0xC0, 0x74, 0x09, 0x5F, 0x5E,
        0x33, 0xC0, 0x5B, 0x8B, 0xE5, 0x5D, 0xC3, 0x8B, 0x45, 0x0C, 0x85, 0xC0, 0x75, 0x14, 0x8B,
        0x55, 0xEC, 0x83, 0xC2, 0x20, 0x52, 0x6A, 0x00, 0xE8, 0xF5, 0x28, 0x01, 0x00, 0x83, 0xC4,
        0x08, 0x89, 0x45, 0x0C, 0x8B, 0x45, 0xE4, 0x6A, 0x00, 0x6A, 0x00, 0x50, 0xFF, 0x75, 0x0C,
        0xE8, 0x71, 0xC4, 0x01, 0x00, 0x83, 0xC4, 0x10, 0x89, 0x45, 0xE0, 0x8B, 0x45, 0xB8, 0xA3,
        0x00, 0x00, 0x00, 0x00, 0x8B, 0x45, 0x0C, 0x50, 0xE8, 0x55, 0x28, 0x01, 0x00, 0x83, 0xC4,
        0x04, 0x8B, 0x55, 0xEC, 0x8B, 0x45, 0xE0, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x8B, 0x45, 0xF0,
        0x8B, 0x40, 0x10, 0x8B, 0x4D, 0xF0, 0x83, 0xC1, 0x10, 0x51, 0x52, 0x50, 0xE8, 0xDE, 0xFC,
        0xFF, 0xFF, 0x83, 0xC4, 0x0C, 0xEB, 0x24, 0x6A, 0xFF, 0xFF, 0x75, 0xE4, 0x8B, 0x45, 0xF0,
        0x8B, 0x40, 0x10, 0x83, 0xC0, 0x10, 0x50, 0x68, 0x44, 0x0E, 0x42, 0x00, 0xFF, 0x75, 0x08,
        0xE8, 0x4F, 0x16, 0x00, 0x00, 0x83, 0xC4, 0x10, 0x89, 0x45, 0xF4, 0x8B, 0x45, 0xF4, 0x5F,
        0x5E, 0x5B, 0x8B, 0xE5, 0x5D, 0xC3, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0x55, 0x8B, 0xEC, 0x83, 0xEC, 0x10, 0x53, 0x56,
        0x57, 0x33, 0xFF, 0x33, 0xDB, 0x33, 0xF6, 0x39, 0x7D, 0x10, 0x76, 0x6C, 0x8B, 0x45, 0x0C,
        0x03, 0xC7, 0x33, 0xC9, 0x8A, 0x08, 0xC1, 0xE9, 0x05, 0x8B, 0x55, 0x08, 0x03, 0xD3, 0x8A,
        0x0C, 0x0A, 0x8B, 0x55, 0x0C, 0x03, 0xD7, 0x32, 0x0A, 0x88, 0x0A, 0x43, 0x83, 0xFB, 0x10,
        0x75, 0x05, 0x33, 0xDB, 0xFF, 0x45, 0xF8,
    ];

    let mut out: Vec<u8> = vec![0u8; 8];
    let mut mask_idx: u8 = 8;

    let mut i = 0;
    while i < input.len() {
        let chunk_end = (i + 8).min(input.len());
        let chunk = &input[i..chunk_end];
        let flag_value: u8 = (1u16.wrapping_shl(chunk.len() as u32).wrapping_sub(1)) as u8;
        push_xor(&mut out, flag_value, &mut mask_idx, &mask);
        for byte in chunk {
            push_xor(&mut out, *byte, &mut mask_idx, &mask);
        }
        i = chunk_end;
    }

    out
}

fn push_xor(out: &mut Vec<u8>, byte: u8, mask_idx: &mut u8, mask: &[u8]) {
    let masked = byte ^ mask[*mask_idx as usize % mask.len()];
    out.push(masked);
    *mask_idx = mask_idx.wrapping_add(1);
}

/// A never-registered set for engines whose text offsets are computed by
/// `from_seen_bytes` (kept for symmetry with `from_store` callers).
pub fn empty_shift_jis() -> HashSet<(u16, u32)> {
    HashSet::new()
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A unique, freshly-created temp directory (no `tempfile` dev-dep in this
/// crate). The caller may leave cleanup to the OS temp reaper.
pub fn managed_temp_dir(tag: &str) -> PathBuf {
    let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-reallive-port-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create managed temp dir");
    dir
}
