//! UTSUSHI-202 — Real RealLive scene header decoder.
//!
//! This module decodes the fixed `0x1d0`-byte (464-byte) scene header
//! that prefixes every populated scene blob in a RealLive `Seen.txt`
//! envelope. The layout is documented in
//! [`docs/research/reallive-engine.md`] §D, derived from Haeleth's
//! RLDEV documentation and re-tested against the Sweetie HD bytes
//! before being encoded here.
//!
//! # On-blob layout
//!
//! Every offset below is **scene-blob relative** (i.e. measured from
//! the start of the bytes pointed at by a [`crate::RealSceneEntry`]).
//! All multi-byte fields are little-endian `u32`. The header is exactly
//! `0x1d0 = 464` bytes and is followed immediately by the
//! AVG32-compressed bytecode (decoded by the next link in the parsing
//! chain, UTSUSHI-203).
//!
//! ```text
//! 0x000  u32  header_size            (always 0x1d0 = 464)
//! 0x004  u32  compiler_version       (10002 | 110002 | 1110002)
//! 0x008  u32  kidoku_offset          (read-tracking flags region)
//! 0x00c  u32  kidoku_count
//! 0x010  u32  (line_table_count, unparsed — reserved for U-flagged use)
//! 0x014  u32  dramatis_offset
//! 0x018  u32  dramatis_count
//! 0x01c  u32  metadata_block_length  (unparsed — typically 0 in retail)
//! 0x020  u32  bytecode_offset        (AVG32 compressed bytecode start)
//! 0x024  u32  bytecode_uncompressed_size
//! 0x028  u32  bytecode_compressed_size
//! 0x02c  u32  z_minus_one            (debug entrypoint, retail: 0)
//! 0x030  u32  z_minus_two            (debug entrypoint)
//! 0x034  u32  entrypoint_table[0]    \
//! 0x038  u32  entrypoint_table[1]     |
//!  ...                                 > 100 × u32 = 0x190 bytes
//! 0x1c0  u32  entrypoint_table[99]   /
//! 0x1c4  u32  savepoint_message
//! 0x1c8  u32  savepoint_selcom
//! 0x1cc  u32  savepoint_seentop
//! 0x1d0  -- header ends, compressed bytecode follows --
//! ```
//!
//! # Compiler-version policy
//!
//! Three values are recognised in retail RealLive archives:
//! `10002` (pre-1.10), `110002` (1.10, Sweetie HD's value), and
//! `1110002` (1.1110). Any other observed value emits
//! [`SceneHeaderWarning::UnknownCompilerVersion`] and parsing **still
//! succeeds** — the unknown value is preserved on the returned struct
//! so downstream code (the AVG32 decompressor in UTSUSHI-203) can make
//! its own decision about second-level XOR keying. Silent fallback to
//! a "default" version is forbidden by the alpha-gate contract.
//!
//! # Truncated input
//!
//! Any input shorter than [`SCENE_HEADER_BYTE_LEN`] (`0x1d0` = 464) is
//! rejected with [`SceneHeaderError::TruncatedHeader`]. The parser
//! refuses to fabricate zeroed fields out of a short buffer.

use serde::{Deserialize, Serialize};

/// Fixed byte length of the RealLive scene header.
///
/// `0x1d0 = 464`. The value is itself stored in the header's first
/// `u32` (`header_size`) so the format is self-describing, but every
/// real archive we have seen carries `0x1d0` and the alpha-gate
/// contract forbids speculatively-shaped fallbacks.
pub const SCENE_HEADER_BYTE_LEN: usize = 0x1d0;

/// Number of slots in the entrypoint table (offsets `0x34..0x1c4`).
///
/// `0x190 / 4 = 100`. Documented in
/// [`docs/research/reallive-engine.md`] §D: the lattice runs from
/// `0x34` up to but not including `0x1c4` where the three savepoint
/// fields begin.
pub const ENTRYPOINT_TABLE_LEN: usize = 100;

/// Scene-blob relative offset where the entrypoint table starts.
pub const ENTRYPOINT_TABLE_BYTE_OFFSET: usize = 0x34;

/// Scene-blob relative offset where the savepoint triplet starts.
pub const SAVEPOINT_BLOCK_BYTE_OFFSET: usize = 0x1c4;

/// RealLive 1.0 / pre-1.10 compiler version. No second-level XOR pass.
pub const COMPILER_VERSION_1_0: u32 = 10002;
/// RealLive 1.10 compiler version. Triggers an optional second-level
/// XOR pass during AVG32 decompression for Key/VisualArts titles.
pub const COMPILER_VERSION_1_10: u32 = 110002;
/// RealLive 1.1110 compiler version. Same XOR posture as 1.10 with a
/// different key window table per the rlvm research anchor.
pub const COMPILER_VERSION_1_1110: u32 = 1_110_002;

/// One slot in the 100-entry entrypoint table at offsets
/// `0x34..0x1c4`.
///
/// Each slot is a single `u32 LE`. The first value of the lattice
/// (`raw[0]`) is documented as the entrypoint count by the RLDEV
/// table, but the on-disk shape is a flat 100-slot array, so we expose
/// every slot with its index and let downstream readers interpret the
/// first slot however the runtime needs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrypointEntry {
    /// Slot index in the 100-entry table. Range: `0..100`.
    pub index: u16,
    /// The raw `u32` value stored at this slot. Sweetie HD scene #0001
    /// pins every populated slot to `0x06` (the "0x06 lattice"
    /// described in `docs/research/reallive-engine.md` §D).
    pub value: u32,
}

/// Typed decode of the 0x1d0-byte RealLive scene header.
///
/// Produced by [`SceneHeader::parse`]. All `u32` fields are decoded
/// little-endian from the scene-blob bytes pointed at by a
/// [`crate::RealSceneEntry`]. The struct also carries the parsed
/// 100-slot entrypoint table so downstream nodes do not have to
/// re-walk the header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneHeader {
    /// Compiler version (`10002 | 110002 | 1110002` in retail).
    /// Out-of-profile values are preserved here verbatim; the parser
    /// emits a [`SceneHeaderWarning::UnknownCompilerVersion`] in that
    /// case but does not rewrite the field.
    pub compiler_version: u32,
    /// Scene-blob offset of the kidoku (read-tracking) table.
    pub kidoku_offset: u32,
    /// Number of entries in the kidoku table.
    pub kidoku_count: u32,
    /// Scene-blob offset of the dramatis-personae table.
    pub dramatis_offset: u32,
    /// Number of entries in the dramatis-personae table.
    pub dramatis_count: u32,
    /// Scene-blob offset where the AVG32-compressed bytecode begins.
    pub bytecode_offset: u32,
    /// Size of the bytecode **after** AVG32 LZ + XOR decompression.
    pub bytecode_uncompressed_size: u32,
    /// Size of the on-disk compressed bytecode payload (before any
    /// AVG32 decompression).
    pub bytecode_compressed_size: u32,
    /// Parsed 100-slot entrypoint lattice (offsets `0x34..0x1c4`).
    pub entrypoint_table: Vec<EntrypointEntry>,
    /// `savepoint_message` runtime setting (offset `0x1c4`).
    pub savepoint_message: u32,
    /// `savepoint_selcom` runtime setting (offset `0x1c8`).
    pub savepoint_selcom: u32,
    /// `savepoint_seentop` runtime setting (offset `0x1cc`).
    pub savepoint_seentop: u32,
    /// `z_minus_one` debug entrypoint (offset `0x2c`). Retail archives
    /// keep this at 0; preserved verbatim.
    pub z_minus_one: u32,
    /// `z_minus_two` debug entrypoint (offset `0x30`).
    pub z_minus_two: u32,
}

/// Non-fatal observation emitted alongside a successful parse.
///
/// The parser returns `Ok((header, warnings))` even when one or more
/// warnings fire — warnings describe out-of-profile but recoverable
/// observations. A *fatal* condition (truncated input) produces an
/// [`SceneHeaderError`] instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneHeaderWarning {
    /// The `compiler_version` field at offset `0x04` does not match any
    /// of the documented retail values
    /// (`10002`, `110002`, `1110002`). The header still parses; the
    /// observed value is preserved on the returned struct so the
    /// AVG32 decompressor can decide whether to attempt a default
    /// keying or refuse the scene.
    UnknownCompilerVersion {
        /// The out-of-profile value observed at `compiler_version`.
        observed: u32,
    },
}

impl std::fmt::Display for SceneHeaderWarning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneHeaderWarning::UnknownCompilerVersion { observed } => write!(
                formatter,
                "utsushi.reallive.unknown_compiler_version: observed compiler_version={observed} \
                 not in documented retail set {{{COMPILER_VERSION_1_0}, {COMPILER_VERSION_1_10}, \
                 {COMPILER_VERSION_1_1110}}}",
            ),
        }
    }
}

/// Fatal errors raised by [`SceneHeader::parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneHeaderError {
    /// The input slice is shorter than the fixed
    /// [`SCENE_HEADER_BYTE_LEN`] header. No fields can be parsed.
    TruncatedHeader {
        /// Length of the input slice that was offered.
        observed_len: usize,
        /// Required length (`SCENE_HEADER_BYTE_LEN` = `0x1d0`).
        required_len: usize,
        /// Human-readable diagnostic.
        message: String,
    },
}

impl std::fmt::Display for SceneHeaderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneHeaderError::TruncatedHeader { message, .. } => {
                write!(formatter, "utsushi.reallive.truncated_header: {message}")
            }
        }
    }
}

impl std::error::Error for SceneHeaderError {}

impl SceneHeader {
    /// Parse the first [`SCENE_HEADER_BYTE_LEN`] bytes of a scene blob
    /// into a typed [`SceneHeader`].
    ///
    /// The `blob_bytes` slice is the scene blob the
    /// [`crate::RealSceneIndex`] pointed at (e.g. the bytes from
    /// `file_offset .. file_offset + byte_len` for an entry). Only
    /// the first `0x1d0` bytes are read; trailing bytes (the AVG32
    /// compressed bytecode) are left to UTSUSHI-203.
    ///
    /// On success returns the parsed header **and** the list of
    /// non-fatal warnings observed during the walk. On a fatal
    /// shortfall returns [`SceneHeaderError::TruncatedHeader`] with
    /// enough detail to identify which scene the caller was decoding.
    pub fn parse(blob_bytes: &[u8]) -> Result<(Self, Vec<SceneHeaderWarning>), SceneHeaderError> {
        if blob_bytes.len() < SCENE_HEADER_BYTE_LEN {
            return Err(SceneHeaderError::TruncatedHeader {
                observed_len: blob_bytes.len(),
                required_len: SCENE_HEADER_BYTE_LEN,
                message: format!(
                    "scene blob length {} is shorter than the fixed {}-byte header",
                    blob_bytes.len(),
                    SCENE_HEADER_BYTE_LEN,
                ),
            });
        }

        // `header_size` at 0x00 is informational — every retail archive
        // we have seen carries `0x1d0` here, matching the fixed
        // SCENE_HEADER_BYTE_LEN. We deliberately do not gate parsing
        // on it: a divergent header_size would be a separate audit
        // signal that lives outside this typed decoder.

        let compiler_version = read_u32_le(blob_bytes, 0x04);
        let kidoku_offset = read_u32_le(blob_bytes, 0x08);
        let kidoku_count = read_u32_le(blob_bytes, 0x0c);
        // 0x10 is reserved (likely line-info count, U-flagged) and not
        // surfaced through the typed struct; downstream nodes can
        // re-read it from the raw blob if a hypothesis ever lands.
        let dramatis_offset = read_u32_le(blob_bytes, 0x14);
        let dramatis_count = read_u32_le(blob_bytes, 0x18);
        // 0x1c is metadata_block_length, U-flagged and typically zero
        // in retail; same treatment as 0x10.
        let bytecode_offset = read_u32_le(blob_bytes, 0x20);
        let bytecode_uncompressed_size = read_u32_le(blob_bytes, 0x24);
        let bytecode_compressed_size = read_u32_le(blob_bytes, 0x28);
        let z_minus_one = read_u32_le(blob_bytes, 0x2c);
        let z_minus_two = read_u32_le(blob_bytes, 0x30);

        let mut entrypoint_table: Vec<EntrypointEntry> = Vec::with_capacity(ENTRYPOINT_TABLE_LEN);
        for slot in 0..ENTRYPOINT_TABLE_LEN {
            let byte_offset = ENTRYPOINT_TABLE_BYTE_OFFSET + slot * 4;
            let value = read_u32_le(blob_bytes, byte_offset);
            entrypoint_table.push(EntrypointEntry {
                index: slot as u16,
                value,
            });
        }

        let savepoint_message = read_u32_le(blob_bytes, SAVEPOINT_BLOCK_BYTE_OFFSET);
        let savepoint_selcom = read_u32_le(blob_bytes, SAVEPOINT_BLOCK_BYTE_OFFSET + 4);
        let savepoint_seentop = read_u32_le(blob_bytes, SAVEPOINT_BLOCK_BYTE_OFFSET + 8);

        let mut warnings: Vec<SceneHeaderWarning> = Vec::new();
        if !is_documented_compiler_version(compiler_version) {
            warnings.push(SceneHeaderWarning::UnknownCompilerVersion {
                observed: compiler_version,
            });
        }

        Ok((
            SceneHeader {
                compiler_version,
                kidoku_offset,
                kidoku_count,
                dramatis_offset,
                dramatis_count,
                bytecode_offset,
                bytecode_uncompressed_size,
                bytecode_compressed_size,
                entrypoint_table,
                savepoint_message,
                savepoint_selcom,
                savepoint_seentop,
                z_minus_one,
                z_minus_two,
            },
            warnings,
        ))
    }

    /// Encode the typed header back to its `0x1d0`-byte on-disk form.
    ///
    /// Used by the round-trip unit tests in this module to prove the
    /// decoder/encoder pair is byte-exact. The encoder is `pub` because
    /// downstream tooling (e.g. an asset-synthesis test in a successor
    /// node) will want it; it intentionally does NOT take an
    /// out-of-band `header_size` argument — the constant
    /// [`SCENE_HEADER_BYTE_LEN`] is written at offset `0x00`. Slots not
    /// covered by typed fields (`0x10`, `0x1c`) are written as zero.
    ///
    /// # Panics
    ///
    /// Does not panic. The output vector is pre-sized and every write
    /// stays within bounds by construction.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0u8; SCENE_HEADER_BYTE_LEN];
        write_u32_le(&mut out, 0x00, SCENE_HEADER_BYTE_LEN as u32);
        write_u32_le(&mut out, 0x04, self.compiler_version);
        write_u32_le(&mut out, 0x08, self.kidoku_offset);
        write_u32_le(&mut out, 0x0c, self.kidoku_count);
        // 0x10 reserved (line_table_count, unparsed) — left zero.
        write_u32_le(&mut out, 0x14, self.dramatis_offset);
        write_u32_le(&mut out, 0x18, self.dramatis_count);
        // 0x1c reserved (metadata_block_length, unparsed) — left zero.
        write_u32_le(&mut out, 0x20, self.bytecode_offset);
        write_u32_le(&mut out, 0x24, self.bytecode_uncompressed_size);
        write_u32_le(&mut out, 0x28, self.bytecode_compressed_size);
        write_u32_le(&mut out, 0x2c, self.z_minus_one);
        write_u32_le(&mut out, 0x30, self.z_minus_two);

        // Entrypoint table: write whatever the struct carries up to
        // ENTRYPOINT_TABLE_LEN slots. Slots not provided by the struct
        // remain zero. Slots beyond the table cap are ignored (and the
        // round-trip test asserts the decoder always produces exactly
        // ENTRYPOINT_TABLE_LEN slots, so the truncation case is only
        // reachable from synthetic constructors).
        for entry in self.entrypoint_table.iter().take(ENTRYPOINT_TABLE_LEN) {
            let slot = entry.index as usize;
            if slot >= ENTRYPOINT_TABLE_LEN {
                continue;
            }
            let byte_offset = ENTRYPOINT_TABLE_BYTE_OFFSET + slot * 4;
            write_u32_le(&mut out, byte_offset, entry.value);
        }

        write_u32_le(
            &mut out,
            SAVEPOINT_BLOCK_BYTE_OFFSET,
            self.savepoint_message,
        );
        write_u32_le(
            &mut out,
            SAVEPOINT_BLOCK_BYTE_OFFSET + 4,
            self.savepoint_selcom,
        );
        write_u32_le(
            &mut out,
            SAVEPOINT_BLOCK_BYTE_OFFSET + 8,
            self.savepoint_seentop,
        );

        out
    }
}

/// `true` when the supplied `compiler_version` matches one of the
/// three documented retail values. Centralised so the warning emission
/// site and any downstream code use the same predicate.
pub fn is_documented_compiler_version(version: u32) -> bool {
    matches!(
        version,
        COMPILER_VERSION_1_0 | COMPILER_VERSION_1_10 | COMPILER_VERSION_1_1110,
    )
}

/// Read a little-endian `u32` from `bytes` at `offset`.
///
/// Caller is responsible for bounds: every call site in this module is
/// preceded by an explicit `blob_bytes.len() >= SCENE_HEADER_BYTE_LEN`
/// guard at the entry to [`SceneHeader::parse`].
fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[offset..offset + 4]);
    u32::from_le_bytes(buf)
}

/// Write a little-endian `u32` into `bytes` at `offset`.
fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic header that mirrors the documented Sweetie HD
    /// scene #0001 values. Used as the round-trip baseline.
    fn reallive_real_bytes_scene_one_synthetic() -> SceneHeader {
        let mut entrypoint_table: Vec<EntrypointEntry> = Vec::with_capacity(ENTRYPOINT_TABLE_LEN);
        // Per docs/research/reallive-engine.md §D, the on-disk lattice
        // for Sweetie HD scene #0001 carries `0x00000003` at slot 0
        // (this is z_minus_two as seen in the raw bytes? wait — z_minus_two
        // is at 0x30 and is u32=3. The entrypoint lattice at 0x34 itself
        // is `0x06` repeated). So slot 0 of the entrypoint table is 6.
        for slot in 0..ENTRYPOINT_TABLE_LEN {
            entrypoint_table.push(EntrypointEntry {
                index: slot as u16,
                value: 0x06,
            });
        }
        SceneHeader {
            compiler_version: COMPILER_VERSION_1_10,
            kidoku_offset: 464,
            kidoku_count: 1,
            dramatis_offset: 468,
            dramatis_count: 0,
            bytecode_offset: 468,
            bytecode_uncompressed_size: 1660,
            bytecode_compressed_size: 1062,
            entrypoint_table,
            savepoint_message: 0,
            savepoint_selcom: 0,
            savepoint_seentop: 0,
            z_minus_one: 0,
            z_minus_two: 3,
        }
    }

    #[test]
    fn truncated_input_raises_truncated_header_not_zero_state() {
        let bytes = vec![0u8; SCENE_HEADER_BYTE_LEN - 1];
        let err = SceneHeader::parse(&bytes)
            .expect_err("input one byte short of the header must be truncated");
        match err {
            SceneHeaderError::TruncatedHeader {
                observed_len,
                required_len,
                message,
            } => {
                assert_eq!(observed_len, SCENE_HEADER_BYTE_LEN - 1);
                assert_eq!(required_len, SCENE_HEADER_BYTE_LEN);
                assert!(
                    message.contains("shorter than the fixed"),
                    "diagnostic must describe the shortfall; got: {message}",
                );
            }
        }
    }

    #[test]
    fn empty_input_raises_truncated_header() {
        let err = SceneHeader::parse(&[]).expect_err("empty input must refuse silent zero-state");
        match err {
            SceneHeaderError::TruncatedHeader { observed_len, .. } => {
                assert_eq!(observed_len, 0);
            }
        }
    }

    #[test]
    fn round_trip_encode_decode_is_byte_exact() {
        let header = reallive_real_bytes_scene_one_synthetic();
        let encoded = header.encode();
        assert_eq!(
            encoded.len(),
            SCENE_HEADER_BYTE_LEN,
            "encoded header must be exactly the fixed length",
        );
        let (decoded, warnings) =
            SceneHeader::parse(&encoded).expect("synthetic encoded header parses");
        assert!(
            warnings.is_empty(),
            "synthetic uses a documented compiler version; no warnings expected; got: {warnings:?}",
        );
        assert_eq!(decoded, header, "round-trip must be byte-exact");
    }

    #[test]
    fn out_of_profile_compiler_version_emits_warning_and_still_parses() {
        let mut header = reallive_real_bytes_scene_one_synthetic();
        header.compiler_version = 0xDEAD_BEEF;
        let encoded = header.encode();
        let (decoded, warnings) = SceneHeader::parse(&encoded)
            .expect("out-of-profile compiler version must still parse (warning, not error)");
        assert_eq!(
            decoded.compiler_version, 0xDEAD_BEEF,
            "the unknown value must be preserved verbatim, not silently rewritten",
        );
        assert_eq!(
            warnings.len(),
            1,
            "exactly one warning expected; got: {warnings:?}"
        );
        match &warnings[0] {
            SceneHeaderWarning::UnknownCompilerVersion { observed } => {
                assert_eq!(*observed, 0xDEAD_BEEF);
            }
        }
    }

    #[test]
    fn documented_compiler_versions_emit_no_warning() {
        for version in [
            COMPILER_VERSION_1_0,
            COMPILER_VERSION_1_10,
            COMPILER_VERSION_1_1110,
        ] {
            let mut header = reallive_real_bytes_scene_one_synthetic();
            header.compiler_version = version;
            let encoded = header.encode();
            let (_decoded, warnings) =
                SceneHeader::parse(&encoded).expect("documented compiler version parses");
            assert!(
                warnings.is_empty(),
                "version {version} is documented; no warning expected; got: {warnings:?}",
            );
        }
    }

    #[test]
    fn entrypoint_table_has_exactly_one_hundred_slots() {
        let header = reallive_real_bytes_scene_one_synthetic();
        let encoded = header.encode();
        let (decoded, _warnings) = SceneHeader::parse(&encoded).expect("synthetic parses");
        assert_eq!(
            decoded.entrypoint_table.len(),
            ENTRYPOINT_TABLE_LEN,
            "entrypoint table is a fixed 100-slot lattice (offsets 0x34..0x1c4)",
        );
        for (slot, entry) in decoded.entrypoint_table.iter().enumerate() {
            assert_eq!(
                entry.index as usize, slot,
                "slot indices must be 0..100 in ascending order",
            );
        }
    }

    #[test]
    fn entrypoint_table_byte_offsets_are_pinned() {
        // Sanity: ENTRYPOINT_TABLE_BYTE_OFFSET + ENTRYPOINT_TABLE_LEN*4
        // must equal SAVEPOINT_BLOCK_BYTE_OFFSET, and the savepoint
        // triplet (3 * 4 = 12 bytes) plus SAVEPOINT_BLOCK_BYTE_OFFSET
        // must equal SCENE_HEADER_BYTE_LEN. If any of these drift the
        // header window is structurally wrong.
        assert_eq!(
            ENTRYPOINT_TABLE_BYTE_OFFSET + ENTRYPOINT_TABLE_LEN * 4,
            SAVEPOINT_BLOCK_BYTE_OFFSET,
            "entrypoint table runs exactly up to the savepoint block",
        );
        assert_eq!(
            SAVEPOINT_BLOCK_BYTE_OFFSET + 3 * 4,
            SCENE_HEADER_BYTE_LEN,
            "savepoint triplet closes the 0x1d0-byte header",
        );
    }

    #[test]
    fn display_messages_carry_typed_error_codes() {
        let err = SceneHeader::parse(&[]).unwrap_err();
        let rendered = err.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.truncated_header:"),
            "error Display must carry the typed code prefix; got: {rendered}",
        );

        let warning = SceneHeaderWarning::UnknownCompilerVersion {
            observed: 0xDEAD_BEEF,
        };
        let rendered = warning.to_string();
        assert!(
            rendered.starts_with("utsushi.reallive.unknown_compiler_version:"),
            "warning Display must carry the typed code prefix; got: {rendered}",
        );
    }

    #[test]
    fn parser_pins_each_documented_field_at_its_documented_offset() {
        // Construct a header where every typed field has a distinct
        // sentinel so a swapped offset would surface as a value
        // mismatch. The entrypoint slots get unique values too.
        let mut entrypoint_table: Vec<EntrypointEntry> = Vec::with_capacity(ENTRYPOINT_TABLE_LEN);
        for slot in 0..ENTRYPOINT_TABLE_LEN {
            entrypoint_table.push(EntrypointEntry {
                index: slot as u16,
                value: 0x1_0000 + slot as u32,
            });
        }
        let header = SceneHeader {
            compiler_version: COMPILER_VERSION_1_0,
            kidoku_offset: 0x1111_1111,
            kidoku_count: 0x2222_2222,
            dramatis_offset: 0x3333_3333,
            dramatis_count: 0x4444_4444,
            bytecode_offset: 0x5555_5555,
            bytecode_uncompressed_size: 0x6666_6666,
            bytecode_compressed_size: 0x7777_7777,
            entrypoint_table,
            savepoint_message: 0x8888_8888,
            savepoint_selcom: 0x9999_9999,
            savepoint_seentop: 0xAAAA_AAAA,
            z_minus_one: 0xBBBB_BBBB,
            z_minus_two: 0xCCCC_CCCC,
        };
        let encoded = header.encode();
        let (decoded, warnings) =
            SceneHeader::parse(&encoded).expect("sentinel-loaded synthetic parses");
        assert!(warnings.is_empty());
        assert_eq!(decoded, header);
    }
}
