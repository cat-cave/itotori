//! `reallive-xor2-sukara-decryptor` — RealLive second-level XOR (`xor_2`)
//! decryptor plus in-process, clean-room recovery of the per-game 16-byte key.
//!
//! # The mechanism (clean-room, restated from rlvm — no source vendored)
//!
//! RealLive scene bytecode for compiler versions `110002` / `1110002` carries
//! a SECOND-LEVEL XOR applied *after* the first-level AVG32 LZSS + 256-byte
//! XOR pass ([`crate::decompress_avg32`]). The algorithm is restated in our
//! own words from rlvm's BSD-licensed `libreallive/compression.cc::Decompress`
//! (the per-game `XorKey` loop) and `scenario.cc` (the `use_xor_2` decision on
//! `compiler_version`, Peter Jolly / Elliot Glaysher):
//!
//! ```text
//! for each XorKey { key[16], xor_offset, xor_length } until the {-1} sentinel:
//!     for i in 0 .. xor_length while (xor_offset + i) < dst_len:
//!         dst[xor_offset + i] ^= key[i % 16]
//! ```
//!
//! Every published rlvm Key/Visual-Arts table (Little Busters, Clannad FV,
//! Snow, Kud Wafter) uses a single segment `xor_offset = 256`,
//! `xor_length = 257`. Sweetie HD / Sukara (`REGNAME = "HADASHI\OSHIOKIHD"`)
//! is **absent** from rlvm's table — so its key is recovered here rather than
//! looked up.
//!
//! # Why the key is RECOVERED in-process, not read from the executable
//!
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
//!
//! # Secret discipline (mechanical, mirrors `kaifuu_core::siglus_static_key`)
//!
//! The raw key lives **only** inside the module-private [`Xor2Key`] (redacting
//! `Debug`, zeroizing `Drop`). It is never serialized, logged, or returned
//! across the module boundary. The public [`Xor2Report`] carries only a
//! one-way sha256 commitment to the key, the key length, the segment
//! offset/length, and scene counts — never the key bytes or any decrypted
//! copyrighted bytecode.

use sha2::{Digest, Sha256};

use crate::opcode::parse_real_bytecode;

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
#[derive(Debug, Clone)]
pub struct Xor2DecScene {
    pub compiler_version: u32,
    pub bytecode: Vec<u8>,
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
        let mut hasher = Sha256::new();
        hasher.update(self.bytes);
        let digest = hasher.finalize();
        let mut out = String::with_capacity(64);
        for byte in digest {
            out.push_str(&format!("{byte:02x}"));
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
/// for `i` in `0 .. 257` while in bounds. Self-inverse (XOR), so the same call
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
        Ok(opcodes) => opcodes.iter().all(|opcode| opcode.is_recognized()),
        Err(_) => false,
    }
}

/// Recover the per-game `xor_2` key from an archive's decompressed scenes and,
/// **iff** the candidate decrypts every `use_xor_2` scene to a clean decode,
/// apply it in place to those scenes. Scenes whose `compiler_version` does not
/// set `use_xor_2` (e.g. Kanon's `10002`) are never touched.
///
/// Returns a sanitized [`Xor2Report`]. The raw key never crosses this boundary.
pub fn recover_and_decrypt_archive(scenes: &mut [Xor2DecScene]) -> Xor2Report {
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
        // No `use_xor_2` scenes: nothing to recover, nothing to decrypt.
        return report;
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
        return report;
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
        for &index in &eligible {
            apply_xor2_segment(&mut scenes[index].bytecode, &key.bytes);
        }
        report.validated = true;
        report.scenes_decrypted = scenes_eligible;
        report.key_sha256 = Some(key.sha256_hex());
    } else {
        report.finding = Some(format!(
            "kaifuu.reallive.xor2.validation_failed: candidate key decrypts only \
             {after_clean}/{scenes_eligible} eligible scenes to a clean decode (the bar is \
             all eligible scenes); no decryption applied"
        ));
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiler_version_gate_matches_rlvm() {
        assert!(compiler_version_uses_xor2(110002));
        assert!(compiler_version_uses_xor2(1110002));
        assert!(!compiler_version_uses_xor2(10002));
        assert!(!compiler_version_uses_xor2(0));
    }

    #[test]
    fn apply_segment_is_self_inverse_and_bounded() {
        let key = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
            0xff, 0x01,
        ];
        // Long enough to cover the whole segment plus tail.
        let mut data: Vec<u8> = (0..700u32).map(|n| (n % 251) as u8).collect();
        let original = data.clone();
        apply_xor2_segment(&mut data, &key);
        // Bytes before the segment and after `offset + length` are untouched.
        assert_eq!(
            &data[..XOR2_SEGMENT_OFFSET],
            &original[..XOR2_SEGMENT_OFFSET]
        );
        assert_eq!(
            &data[XOR2_SEGMENT_OFFSET + XOR2_SEGMENT_LENGTH..],
            &original[XOR2_SEGMENT_OFFSET + XOR2_SEGMENT_LENGTH..]
        );
        // The segment changed.
        assert_ne!(data, original);
        // XOR is self-inverse: applying again restores the plaintext.
        apply_xor2_segment(&mut data, &key);
        assert_eq!(data, original);
    }

    #[test]
    fn short_scene_below_offset_is_untouched() {
        let key = [0xab; XOR2_KEY_LEN];
        let mut data = vec![0x0au8; XOR2_SEGMENT_OFFSET - 1];
        let original = data.clone();
        apply_xor2_segment(&mut data, &key);
        assert_eq!(
            data, original,
            "scene shorter than the segment offset is a no-op"
        );
    }

    /// Synthetic plaintext: a run of `MetaLine(line=0)` triples (`0a 00 00`),
    /// which `parse_real_bytecode` decodes as recognised `MetaLine` opcodes —
    /// no real game bytes. Dominant byte is `0x00`, matching the recovery's
    /// known-plaintext assumption.
    fn synthetic_clean_scene(triples: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(triples * 3);
        for _ in 0..triples {
            v.extend_from_slice(&[0x0a, 0x00, 0x00]);
        }
        v
    }

    #[test]
    fn recovers_and_decrypts_synthetic_corpus_then_validates() {
        let planted = [
            0x97, 0x02, 0xcb, 0x5a, 0x83, 0x0f, 0x5e, 0x30, 0xa7, 0x66, 0xe5, 0x37, 0x62, 0x3f,
            0x9a, 0xdc,
        ];
        // Several long scenes so every lane is well sampled.
        let mut scenes: Vec<Xor2DecScene> = (0..6)
            .map(|n| {
                let mut bytecode = synthetic_clean_scene(220 + n * 7);
                apply_xor2_segment(&mut bytecode, &planted); // "encrypt"
                Xor2DecScene {
                    compiler_version: 110002,
                    bytecode,
                }
            })
            .collect();

        let report = recover_and_decrypt_archive(&mut scenes);
        assert!(report.validated, "candidate must validate: {report:?}");
        assert_eq!(report.scenes_eligible, 6);
        assert_eq!(report.scenes_decrypted, 6);
        assert_eq!(report.after_clean, 6);
        // The published commitment is the sha256 of the planted key — proving
        // recovery without revealing bytes.
        let mut hasher = Sha256::new();
        hasher.update(planted);
        let expected: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(report.key_sha256.as_deref(), Some(expected.as_str()));
        // Every scene is now the original plaintext (decrypted in place).
        for scene in &scenes {
            assert!(decodes_clean(&scene.bytecode));
        }
    }

    #[test]
    fn non_eligible_corpus_is_a_no_op() {
        let mut scenes = vec![
            Xor2DecScene {
                compiler_version: 10002,
                bytecode: synthetic_clean_scene(300),
            },
            Xor2DecScene {
                compiler_version: 10002,
                bytecode: synthetic_clean_scene(10),
            },
        ];
        let before = scenes.clone();
        let report = recover_and_decrypt_archive(&mut scenes);
        assert_eq!(report.scenes_eligible, 0);
        assert!(!report.validated);
        assert!(report.finding.is_none());
        assert!(report.key_sha256.is_none());
        assert_eq!(
            scenes.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
            before.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
            "non-use_xor_2 scenes must be byte-identical (untouched)"
        );
    }

    #[test]
    fn wrong_shaped_corpus_does_not_fake_success() {
        // Eligible scenes whose segment is high-entropy noise that no 16-byte
        // key can turn into clean bytecode: recovery must NOT validate, must
        // surface a finding, and must leave the bytes untouched.
        let mut scenes: Vec<Xor2DecScene> = (0..3)
            .map(|n| {
                let bytecode: Vec<u8> = (0..600u32)
                    .map(|i| ((i.wrapping_mul(2654435761).wrapping_add(n * 7)) >> 13) as u8)
                    .collect();
                Xor2DecScene {
                    compiler_version: 110002,
                    bytecode,
                }
            })
            .collect();
        let before = scenes.clone();
        let report = recover_and_decrypt_archive(&mut scenes);
        assert!(!report.validated, "noise must not validate: {report:?}");
        assert!(report.finding.is_some());
        assert!(report.key_sha256.is_none());
        assert_eq!(report.scenes_decrypted, 0);
        assert_eq!(
            scenes.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
            before.iter().map(|s| &s.bytecode).collect::<Vec<_>>(),
            "a non-validated candidate must never mutate the corpus"
        );
    }

    #[test]
    fn key_debug_is_redacted() {
        let key = Xor2Key { bytes: [0x42; 16] };
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains("42424242"));
    }
}
