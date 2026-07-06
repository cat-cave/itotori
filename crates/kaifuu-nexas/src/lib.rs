//! Pure-Rust **NeXAS engine** resource reader: the `PAC\0` archive container
//! plus the three compression codecs its entries use.
//!
//! NeXAS (used by Majikoi / *Maji de Watashi ni Koi Shinasai!* and the wider
//! ~354-title NeXAS catalogue) ships its assets in category archives —
//! `Bgm.pac`, `Face.pac`, `Script.pac`, `Stand.pac`, `System.pac`, `Voice*.pac`,
//! `Thumbnail.pac`, `Config.pac`, … — each a `PAC\0` container. This crate owns
//! the **container envelope** ([`PacArchive`]): it parses the header + directory
//! index (both the tail Huffman-packed "new" layout observed on Majikoi and the
//! inline "old" layout) and decompresses each entry per the archive-wide
//! `pack_type` — stored, LZSS, Huffman, or zlib-Deflate.
//!
//! # NeXAS `PAC\0` vs Softpal `PAC ` (the `.pac` collision)
//!
//! Both engines use the `.pac` extension with **completely different** formats.
//! The discriminator is the 4th magic byte: NeXAS is `"PAC\0"` (`50 41 43 00`),
//! Softpal is `"PAC "` (`50 41 43 20`). This crate rejects the Softpal magic
//! outright ([`PacError::BadMagic`]); detection keys on magic bytes, never the
//! extension. See `kaifuu-softpal` for the Softpal container.
//!
//! # Format (all little-endian)
//!
//! - magic `"PAC\0"` @ `0x00`
//! - file **count** `u32` @ `0x04`
//! - archive-wide **pack_type** `u32` @ `0x08` ([`Compression`])
//! - directory index: tail Huffman-packed (bytes inverted, then Huffman-decoded
//!   to `count * 0x4C`) or inline at `0x0C`; each entry is a name field plus
//!   `offset` / `unpacked` / `size` `u32`s.
//!
//! # Clean-room provenance / no shell-outs
//!
//! The `PAC\0` format and its LZSS / Huffman / zlib codecs are ported clean-room
//! from GARbro (`ArcFormats/Nexas/ArcPAC.cs`, `LzssStream.cs`,
//! `HuffmanCompression.cs`), MIT-licensed, Copyright (C) 2015-2018 by morkt.
//! This is an independent Rust reimplementation of those documented formats:
//! GARbro is used only as a dev-time format oracle; no GARbro binary is bundled
//! or invoked. Pure in-process work over an in-memory `&[u8]`; malformed input
//! never panics — every failure is a typed error.
//!
//! # Honest scope: PAC container + entry decompression
//!
//! This crate enumerates and extracts archive entries (with decompression). It
//! does **not** interpret the extracted script bytecode, decode NeXAS images
//! (`.grp`), or run any engine — those are separate nodes.

mod archive;
mod huffman;
mod inflate;
mod lzss;

pub use archive::{
    Compression, IndexLayout, NEXAS_COUNT_OFFSET, NEXAS_HEADER_BYTE_LEN,
    NEXAS_NEW_INDEX_ENTRY_BYTE_LEN, NEXAS_NEW_INDEX_NAME_BYTE_LEN, NEXAS_OLD_INDEX_NAME_LENGTHS,
    NEXAS_PAC_MAGIC, NEXAS_PAC_MAX_ENTRIES, NEXAS_PACK_TYPE_OFFSET, PacArchive, PacEntry, PacError,
};
pub use huffman::{HuffmanError, NEXAS_HUFFMAN_ERROR_MARKER};
pub use inflate::{InflateError, NEXAS_INFLATE_ERROR_MARKER, inflate, zlib_decompress};
pub use lzss::decode as lzss_decode;

/// Grep-pinnable namespace marker every [`PacError`] display string carries.
/// Lets a caller assert an error originated in this crate without matching on
/// the concrete variant.
pub const NEXAS_PAC_ERROR_MARKER: &str = "kaifuu.nexas.pac";

/// One-line capability boundary, mirroring the sibling engine crates: this crate
/// is the NeXAS `PAC\0` container reader plus its entry decompression codecs.
pub const NEXAS_PAC_SUPPORT_BOUNDARY: &str = "kaifuu-nexas enumerates and extracts entries of the \
    NeXAS `PAC\\0` container (magic 50 41 43 00 + u32 count @0x04 + u32 pack_type @0x08 + tail \
    Huffman-packed/bit-inverted OR inline directory index) deterministically, decompressing each \
    entry per the archive pack_type (stored / LZSS / canonical-Huffman / zlib-Deflate), and \
    discriminates the NeXAS `PAC\\0` magic from the Softpal `PAC ` magic by the 4th byte \
    (0x00 vs 0x20). Interpreting the extracted script bytecode, decoding NeXAS images, and running \
    the engine are NOT claimed (separate nodes).";
