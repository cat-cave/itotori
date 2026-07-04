//! Pure-Rust **Softpal / Amuse-Craft ("Pal" engine) PAC container** reader.
//!
//! Softpal ADV (aka Amuse Craft / "Pal"; used by CRYSTALiA, Hearts, Us:track,
//! Unison Shift, …) ships its assets in a single flat `PAC ` archive
//! (`data.pac`, `system.pac`, `csv.pac`, …). This crate owns the **container
//! envelope**: it parses the header + directory index and slices an entry's
//! bytes out deterministically.
//!
//! # Format (all little-endian)
//!
//! - magic `"PAC "` (`50 41 43 20`) @ `0x00`
//! - file **count** `u32` @ `0x08` (e.g. 417 / 160 on the two profiled titles)
//! - a fixed **`0x804`-byte reserved header**; the directory **index** begins
//!   at `0x804`
//! - each index entry is **40 bytes**: `name[32]` (null-terminated ASCII,
//!   uppercase 8.3-style, e.g. `SCRIPT.SRC`, `TEXT.DAT`, `BGM_BASE.PGD`) +
//!   `size` `u32` + `offset` `u32` (absolute)
//! - the first file starts immediately after the index; equivalently, entry-0's
//!   `offset` (the `u32` @ `0x828`) equals `index_end` = `0x804 + count*40`.
//!   This invariant is cross-checked ([`PacError::IndexEndMismatch`]).
//! - **no compression, no index encryption** — an entry's on-disk bytes are its
//!   payload verbatim (`bytes[offset .. offset+size]`).
//!
//! This is GARbro's PAC/AMUSE (`Pac2Opener`) variant. GARbro and the
//! SoftPal-Tool `pac_unpack.py` are **extraction oracles only** — this reader
//! is reimplemented deterministically in Rust and never shells out.
//!
//! # Honest scope: container level, NOT the inner codecs
//!
//! This crate identifies / inventories / extracts **archive entries**. It does
//! **not** decode or decrypt the inner files: the `TEXT.DAT` codec and the
//! `SCRIPT.SRC` (`Sv`-version) disassembler are **separate Softpal nodes**.
//! Extracting `SCRIPT.SRC` here yields its raw (still engine-encoded) bytes,
//! byte-identical to the oracle — nothing more.
//!
//! # Determinism / no shell-outs
//!
//! Pure in-process slicing over an in-memory `&[u8]`. No `Command::new`, no
//! external archiver, no GARbro. Malformed input never panics: every failure is
//! a typed [`PacError`].

mod archive;

pub use archive::{
    PAC_COUNT_OFFSET, PAC_ENTRY_NAME_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
    PAC_MAGIC, PAC_MAX_ENTRIES, PacArchive, PacEntry, PacError,
};

/// Grep-pinnable namespace marker every [`PacError`] display string carries.
/// Lets a caller assert an error originated in this crate without matching on
/// the concrete variant.
pub const SOFTPAL_PAC_ERROR_MARKER: &str = "kaifuu.softpal.pac";

/// One-line capability boundary, mirroring the Softpal detector's
/// `SOFTPAL_SUPPORT_BOUNDARY`: this crate is the CONTAINER reader only.
pub const SOFTPAL_PAC_SUPPORT_BOUNDARY: &str = "kaifuu-softpal PAC reader enumerates and extracts \
    entries of the Softpal `PAC ` container (magic + u32 count @0x08 + 0x804 reserved header + \
    40-byte name/size/offset index) deterministically; TEXT.DAT decoding, SCRIPT.SRC \
    disassembly/decompilation, decryption, and patch-back are NOT claimed (separate Softpal nodes).";
