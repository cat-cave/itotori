//! Real RealLive scene header decoder.
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
//! chain, ).
//!
//! ```text
//! 0x000 u32 header_size (always 0x1d0 = 464)
//! 0x004 u32 compiler_version (10002 | 110002 | 1110002)
//! 0x008 u32 kidoku_offset (read-tracking flags region)
//! 0x00c u32 kidoku_count
//! 0x010 u32 (line_table_count, unparsed — reserved for U-flagged use)
//! 0x014 u32 dramatis_offset
//! 0x018 u32 dramatis_count
//! 0x01c u32 metadata_block_length (unparsed — typically 0 in retail)
//! 0x020 u32 bytecode_offset (AVG32 compressed bytecode start)
//! 0x024 u32 bytecode_uncompressed_size
//! 0x028 u32 bytecode_compressed_size
//! 0x02c u32 z_minus_one (debug entrypoint, retail: 0)
//! 0x030 u32 z_minus_two (debug entrypoint)
//! 0x034 u32 entrypoint_table[0] \
//! 0x038 u32 entrypoint_table[1]
//!  ... > 100 × u32 = 0x190 bytes
//! 0x1c0 u32 entrypoint_table[99]
//! 0x1c4 u32 savepoint_message
//! 0x1c8 u32 savepoint_selcom
//! 0x1cc u32 savepoint_seentop
//! 0x1d0 -- header ends, compressed bytecode follows --
//! ```
//!
//! # Compiler-version policy
//!
//! Three values are recognised in retail RealLive archives:
//! `10002` (pre-1.10), `110002` (1.10, Sweetie HD's value), and
//! `1110002` (1.1110). Any other observed value emits
//! [`SceneHeaderWarning::UnknownCompilerVersion`] and parsing **still
//! succeeds** — the unknown value is preserved on the returned struct
//! so downstream code (the AVG32 decompressor in ) can make
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
    /// `file_offset.. file_offset + byte_len` for an entry). Only
    /// the first `0x1d0` bytes are read; trailing bytes (the AVG32
    /// compressed bytecode) are left to.
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
#[path = "scene_header_tests.rs"]
mod tests;
