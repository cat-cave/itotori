//! `reallive-xor2-sukara-decryptor` — RealLive second-level XOR (`xor_2`)
//! decryptor plus in-process, clean-room recovery of the per-game 16-byte key.
//! # The mechanism (clean-room, restated from rlvm — no source vendored)
//! RealLive scene bytecode for compiler versions `110002` / `1110002` carries
//! a SECOND-LEVEL XOR applied *after* the first-level AVG32 LZSS + 256-byte
//! XOR pass ([`crate::decompress_avg32`]). The algorithm is restated in our
//! own words from rlvm's BSD-licensed `libreallive/compression.cc::Decompress`
//! (the per-game `XorKey` loop) and `scenario.cc` (the `use_xor_2` decision on
//! `compiler_version`, Peter Jolly / Elliot Glaysher):
//! ```text
//! for each XorKey { key[16], xor_offset, xor_length } until the {-1} sentinel:
//! for i in 0.. xor_length while (xor_offset + i) < dst_len:
//! dst[xor_offset + i] ^= key[i % 16]
//! Every published rlvm Key/Visual-Arts table (Little Busters, Clannad FV,
//! Snow, Kud Wafter) uses a single segment `xor_offset = 256`,
//! `xor_length = 257`. Sweetie HD / Sukara (`REGNAME = "HADASHI\OSHIOKIHD"`)
//! is **absent** from rlvm's table — so its key is recovered here rather than
//! looked up.
//! # Why the key is RECOVERED in-process, not read from the executable
//! Forensic finding (this node): the 16-byte key is **not stored as plaintext
//! anywhere in the shipped game** — a full static scan of `RealLive.exe`
//! (2,759,168 bytes, no high-entropy / packed regions), `Start.exe`, and every
//! one of the 2,843 shipped game files found the key under none of its 16
//! cyclic rotations (nor reversed / xor-0xff / nibble-swapped / u32-swapped).
//! The retail interpreter derives the key at run time; it is never on disk.
//! It is therefore recovered here by **in-process static analysis of the
//! game's own encrypted scene corpus** — a cross-scene known-plaintext attack
//! over the `xor_offset = 256` segment whose dominant plaintext byte is `0x00`
//! — and then **validated before consumption**: the candidate is accepted only
//! if it decrypts EVERY eligible scene to bytecode that decodes with zero
//! unknown commands and zero parse failures. A candidate that fails to reach
//! that 100% bar is a structured finding, never a silent or faked success.
//! # Secret discipline (mechanical, mirrors `kaifuu_core::siglus_static_key`)
//! The raw key lives **only** inside the module-private [`Xor2Key`] (redacting
//! `Debug`, zeroizing `Drop`). It is never serialized, logged, or returned
//! across the module boundary. The public [`Xor2Report`] carries only a
//! one-way sha256 commitment to the key, the key length, the segment
//! offset/length, and scene counts — never the key bytes or any decrypted
//! copyrighted bytecode.

use sha2::{Digest, Sha256};

use kaifuu_core::RedactedContentSummary;

use crate::archive::RealLiveSceneIndex;
use crate::decompressor::decompress_avg32;
use crate::opcode::parse_real_bytecode;
use crate::scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader};

/// Decompressed-bytecode offset at which the `xor_2` segment begins.
/// rlvm Key/Visual-Arts constant (`XorKey::xor_offset`).
pub const XOR2_SEGMENT_OFFSET: usize = 0x100; // 256

/// Length in bytes of the `xor_2` segment. rlvm Key/Visual-Arts constant
/// (`XorKey::xor_length`).
pub const XOR2_SEGMENT_LENGTH: usize = 0x101; // 257

/// Period of the repeating `xor_2` key (`key[i % 16]`).
pub const XOR2_KEY_LEN: usize = 16;

/// rlvm `scenario.cc`: compiler versions `110002` and `1110002` set
/// `use_xor_2 = true`; everything else (e.g. Kanon's `10002`) does not.
#[must_use]
pub fn compiler_version_uses_xor2(compiler_version: u32) -> bool {
    matches!(compiler_version, 110002 | 1110002)
}

/// A decompressed scene handed to the archive-level decryptor: its plaintext
/// `compiler_version` (decides `use_xor_2`) plus its decompressed bytecode
/// (decrypted in place when eligible and validated).
#[derive(Clone)]
pub struct Xor2DecScene {
    pub compiler_version: u32,
    pub bytecode: Vec<u8>,
}

impl std::fmt::Debug for Xor2DecScene {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Xor2DecScene")
            .field("compiler_version", &self.compiler_version)
            .field(
                "bytecode",
                &RedactedContentSummary::from_bytes(&self.bytecode),
            )
            .finish()
    }
}

/// The decompressed corpus of a whole SEEN.TXT archive, produced by
/// [`decompress_archive_scenes`] and consumed by the cross-scene `xor_2`
/// key-recovery attack. `scenes[i]` is the decompressed bytecode of the
/// archive scene whose id is `scene_ids[i]`; the two run in lockstep and the
/// recovery functions never reorder [`Self::scenes`], so a caller can map a
/// target scene id to its position with [`Self::position_of`].
#[derive(Clone)]
pub struct DecompressedArchive {
    /// One entry per successfully-decompressed populated scene, in archive
    /// directory order. Handed directly to [`recover_and_decrypt_archive`] /
    /// [`recover_archive_cipher`].
    pub scenes: Vec<Xor2DecScene>,
    /// `scene_ids[i]` is the archive scene id of `scenes[i]`.
    pub scene_ids: Vec<u16>,
}

impl std::fmt::Debug for DecompressedArchive {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DecompressedArchive")
            .field("scenes", &self.scenes)
            .field("scene_ids", &self.scene_ids)
            .finish()
    }
}

impl DecompressedArchive {
    /// Position of `scene_id` inside [`Self::scenes`], if that scene was
    /// present and decompressed. `None` when the scene is absent or failed a
    /// decompress guard.
    #[must_use]
    pub fn position_of(&self, scene_id: u16) -> Option<usize> {
        self.scene_ids.iter().position(|id| *id == scene_id)
    }
}

/// Decompress every populated scene of a RealLive SEEN.TXT archive into the
/// corpus consumed by the cross-scene `xor_2` key-recovery attack
/// ([`recover_and_decrypt_archive`] / [`recover_archive_cipher`]).
/// This is the SINGLE source of truth for the decompress -> [`Xor2DecScene`]
/// corpus loop shared by the extract path (`kaifuu-cli`) and the patchback
/// path (`patchback::bundle_driven`). Both MUST build the corpus identically:
/// a divergence in which scenes feed key recovery — or in the `[256, 513)`
/// known-plaintext sample they contribute — could silently recover a different
/// key on one path than the other.
/// Per-scene guards (a scene failing any guard is skipped, never fatal — the
/// caller surfaces its own target scene's failure with full context):
/// - the declared `(byte_offset, byte_len)` blob must lie inside `archive_bytes`;
/// - the [`SceneHeader`] must parse;
/// - `bytecode_offset` must be `>= SCENE_HEADER_BYTE_LEN` (the bytecode lives
///   after the fixed header — an offset inside the header region is malformed
///   and would decompress header bytes as garbage into the corpus) AND
///   `bytecode_offset + bytecode_compressed_size` must lie inside the blob;
/// - the AVG32 decompression must succeed.
#[must_use]
pub fn decompress_archive_scenes(
    archive_bytes: &[u8],
    index: &RealLiveSceneIndex,
) -> DecompressedArchive {
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    let mut scene_ids: Vec<u16> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let blob_start = entry.byte_offset as usize;
        let blob_end = blob_start + entry.byte_len as usize;
        if blob_end > archive_bytes.len() {
            continue;
        }
        let blob = &archive_bytes[blob_start..blob_end];
        let Ok(header) = SceneHeader::parse(blob) else {
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo < SCENE_HEADER_BYTE_LEN || bo + bc > blob.len() {
            continue;
        }
        let Ok(bytecode) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode,
        });
        scene_ids.push(entry.scene_id);
    }
    DecompressedArchive { scenes, scene_ids }
}

/// Sanitized outcome of [`recover_and_decrypt_archive`]. Counts / offsets /
/// one-way hashes only — never the key bytes or decrypted bytecode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xor2Report {
    pub segment_offset: usize,
    pub segment_length: usize,
    pub key_len: usize,
    /// Total scenes considered.
    pub scenes_total: usize,
    /// Scenes whose `compiler_version` sets `use_xor_2` (the candidates).
    pub scenes_eligible: usize,
    /// Eligible scenes that decoded clean **without** `xor_2` (the masked
    /// baseline — ciphertext mis-decoded as binary textout).
    pub baseline_clean: usize,
    /// Eligible scenes that decode clean **after** the recovered key is
    /// applied. On acceptance this equals `scenes_eligible`.
    pub after_clean: usize,
    /// Eligible scenes actually decrypted in place (non-zero only when
    /// `validated`).
    pub scenes_decrypted: usize,
    /// `true` iff a candidate key decrypted EVERY eligible scene to a clean
    /// decode and was consumed.
    pub validated: bool,
    /// One-way sha256 commitment to the recovered key, surfaced only on
    /// acceptance. Never the key bytes.
    pub key_sha256: Option<String>,
    /// Structured semantic finding when no key could be validated. `None` on
    /// success or when there were simply no eligible scenes.
    pub finding: Option<String>,
}

impl Xor2Report {
    fn empty(scenes_total: usize, scenes_eligible: usize) -> Self {
        Self {
            segment_offset: XOR2_SEGMENT_OFFSET,
            segment_length: XOR2_SEGMENT_LENGTH,
            key_len: XOR2_KEY_LEN,
            scenes_total,
            scenes_eligible,
            baseline_clean: 0,
            after_clean: 0,
            scenes_decrypted: 0,
            validated: false,
            key_sha256: None,
            finding: None,
        }
    }
}

/// The recovered per-game key. Raw bytes are module-private, redacted in
/// `Debug`, and zeroized on drop; only a one-way sha256 commitment ever
/// escapes.
struct Xor2Key {
    bytes: [u8; XOR2_KEY_LEN],
}

impl Xor2Key {
    fn sha256_hex(&self) -> String {
        use std::fmt::Write as _;
        let mut hasher = Sha256::new();
        hasher.update(self.bytes);
        let digest = hasher.finalize();
        let mut out = String::with_capacity(64);
        for byte in digest {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }
}

impl Drop for Xor2Key {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

impl std::fmt::Debug for Xor2Key {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Xor2Key")
            .field("bytes", &"[REDACTED:kaifuu.secret_redacted]")
            .field("len", &self.bytes.len())
            .finish()
    }
}

/// Apply the `xor_2` segment transform in place: `data[256 + i] ^= key[i % 16]`
/// for `i` in `0.. 257` while in bounds. Self-inverse (XOR), so the same call
/// encrypts or decrypts.
fn apply_xor2_segment(data: &mut [u8], key: &[u8; XOR2_KEY_LEN]) {
    let mut i = 0usize;
    while i < XOR2_SEGMENT_LENGTH {
        let pos = XOR2_SEGMENT_OFFSET + i;
        let Some(slot) = data.get_mut(pos) else { break };
        *slot ^= key[i % XOR2_KEY_LEN];
        i += 1;
    }
}

/// Recover the 16-byte key from the encrypted scene corpus by a cross-scene
/// known-plaintext attack: the same key encrypts the `[256, 513)` segment of
/// every scene, whose modal plaintext byte is `0x00`, so the per-lane modal
/// ciphertext byte is the key byte for that lane (`key[lane] = mode ^ 0x00`).
/// Returns `None` only when no eligible scene reaches the segment.
fn recover_candidate_key(scenes: &[&[u8]]) -> Option<[u8; XOR2_KEY_LEN]> {
    let mut lane_counts = [[0u32; 256]; XOR2_KEY_LEN];
    let mut sampled = false;
    for scene in scenes {
        let mut i = 0usize;
        while i < XOR2_SEGMENT_LENGTH {
            let pos = XOR2_SEGMENT_OFFSET + i;
            let Some(&byte) = scene.get(pos) else { break };
            lane_counts[i % XOR2_KEY_LEN][byte as usize] += 1;
            sampled = true;
            i += 1;
        }
    }
    if !sampled {
        return None;
    }
    let mut key = [0u8; XOR2_KEY_LEN];
    for (lane, counts) in lane_counts.iter().enumerate() {
        let (value, _) = counts
            .iter()
            .enumerate()
            .max_by_key(|(_, count)| **count)
            .expect("256-entry histogram is never empty");
        key[lane] = value as u8;
    }
    Some(key)
}

/// `true` iff the bytecode decodes with zero parse errors and zero
/// unrecognised (`Unknown`) commands — the 100%-decompilation bar.
fn decodes_clean(bytecode: &[u8]) -> bool {
    match parse_real_bytecode(bytecode) {
        Ok(opcodes) => opcodes
            .iter()
            .all(super::opcode::RealLiveOpcode::is_recognized),
        Err(_) => false,
    }
}

/// Recover + validate the per-game key over an archive's decompressed scenes
/// WITHOUT mutating them. Returns the sanitized report plus the validated key
/// (only `Some` when `report.validated`). `report.scenes_decrypted` is left at
/// `0` — application/accounting is the caller's responsibility.
fn recover_validated_key(scenes: &[Xor2DecScene]) -> (Xor2Report, Option<Xor2Key>) {
    let scenes_total = scenes.len();
    let eligible: Vec<usize> = scenes
        .iter()
        .enumerate()
        .filter(|(_, scene)| compiler_version_uses_xor2(scene.compiler_version))
        .map(|(index, _)| index)
        .collect();
    let scenes_eligible = eligible.len();

    let mut report = Xor2Report::empty(scenes_total, scenes_eligible);
    if eligible.is_empty() {
        // No `use_xor_2` scenes: nothing to recover.
        return (report, None);
    }

    report.baseline_clean = eligible
        .iter()
        .filter(|&&index| decodes_clean(&scenes[index].bytecode))
        .count();

    let refs: Vec<&[u8]> = eligible
        .iter()
        .map(|&index| scenes[index].bytecode.as_slice())
        .collect();
    let Some(key_bytes) = recover_candidate_key(&refs) else {
        report.finding = Some(
            "kaifuu.reallive.xor2.key_region_unsampled: no eligible scene reaches the \
             xor_2 segment offset; cannot recover a key"
                .to_string(),
        );
        return (report, None);
    };
    let key = Xor2Key { bytes: key_bytes };

    // Validate on COPIES before consuming: the candidate must decrypt EVERY
    // eligible scene to a clean decode (the 100% bar).
    let mut after_clean = 0usize;
    for &index in &eligible {
        let mut trial = scenes[index].bytecode.clone();
        apply_xor2_segment(&mut trial, &key.bytes);
        if decodes_clean(&trial) {
            after_clean += 1;
        }
    }
    report.after_clean = after_clean;

    if after_clean == scenes_eligible {
        report.validated = true;
        report.key_sha256 = Some(key.sha256_hex());
        (report, Some(key))
    } else {
        report.finding = Some(format!(
            "kaifuu.reallive.xor2.validation_failed: candidate key decrypts only \
             {after_clean}/{scenes_eligible} eligible scenes to a clean decode (the bar is \
             all eligible scenes); no decryption applied"
        ));
        (report, None)
    }
}

/// Recover the per-game `xor_2` key from an archive's decompressed scenes and,
/// **iff** the candidate decrypts every `use_xor_2` scene to a clean decode,
/// apply it in place to those scenes. Scenes whose `compiler_version` does not
/// set `use_xor_2` (e.g. Kanon's `10002`) are never touched.
/// Returns a sanitized [`Xor2Report`]. The raw key never crosses this boundary.
pub fn recover_and_decrypt_archive(scenes: &mut [Xor2DecScene]) -> Xor2Report {
    let (mut report, key) = recover_validated_key(scenes);
    if let Some(key) = key {
        for scene in scenes.iter_mut() {
            if compiler_version_uses_xor2(scene.compiler_version) {
                apply_xor2_segment(&mut scene.bytecode, &key.bytes);
            }
        }
        report.scenes_decrypted = report.scenes_eligible;
    }
    report
}

/// An opaque, validated per-game `xor_2` cipher recovered from an archive's
/// decompressed scenes. The raw 16-byte key is held privately in a
/// zeroize-on-drop, `Debug`-redacted [`Xor2Key`] and never crosses this
/// boundary; the type exposes only in-place segment transforms and the
/// sanitized recovery [`Xor2Report`].
/// Unlike [`recover_and_decrypt_archive`] (which decrypts a whole corpus in
/// place, one direction only), this hands the caller a reusable cipher so a
/// single scene can be **decrypted for editing and then re-encrypted** before
/// it is written back — the patchback round-trip. The transform is XOR and
/// therefore self-inverse: [`Xor2Cipher::apply_segment`] decrypts an encrypted
/// scene and re-encrypts a plaintext one with the same call.
pub struct Xor2Cipher {
    key: Xor2Key,
    report: Xor2Report,
}

impl std::fmt::Debug for Xor2Cipher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Xor2Cipher")
            .field("key", &self.key)
            .field("report", &self.report)
            .finish()
    }
}

impl Xor2Cipher {
    /// The sanitized recovery report (counts / offsets / one-way key sha256).
    #[must_use]
    pub fn report(&self) -> &Xor2Report {
        &self.report
    }

    /// Apply the `xor_2` segment transform to one scene's decompressed
    /// bytecode in place (`data[256 + i] ^= key[i % 16]` over `[256, 513)`).
    /// Self-inverse: decrypts an encrypted scene, re-encrypts a plaintext one.
    /// Scenes shorter than the segment offset are a no-op.
    pub fn apply_segment(&self, bytecode: &mut [u8]) {
        apply_xor2_segment(bytecode, &self.key.bytes);
    }
}

/// Recover + validate the per-game `xor_2` key over a whole archive's
/// decompressed scenes and return a reusable [`Xor2Cipher`], WITHOUT mutating
/// the scenes. The candidate must decrypt EVERY `use_xor_2` scene to a clean
/// decode (the same 100% bar as [`recover_and_decrypt_archive`]).
/// # Errors
/// Returns the sanitized [`Xor2Report`] when the archive has no `use_xor_2`
/// scenes, no eligible scene reaches the segment, no key can be sampled, or no
/// candidate validates. The caller decides whether that is fatal.
pub fn recover_archive_cipher(scenes: &[Xor2DecScene]) -> Result<Xor2Cipher, Xor2Report> {
    let (report, key) = recover_validated_key(scenes);
    match key {
        Some(key) => Ok(Xor2Cipher { key, report }),
        None => Err(report),
    }
}

#[cfg(test)]
#[path = "xor2_tests.rs"]
mod tests;
