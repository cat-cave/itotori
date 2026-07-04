//! Pure-Rust **Softpal / Amuse-Craft ("Pal" engine)** reader: the `PAC `
//! container envelope plus the inner `TEXT.DAT` string-pool codec.
//!
//! Softpal ADV (aka Amuse Craft / "Pal"; used by CRYSTALiA, Hearts, Us:track,
//! Unison Shift, …) ships its assets in a single flat `PAC ` archive
//! (`data.pac`, `system.pac`, `csv.pac`, …). This crate owns the **container
//! envelope** — it parses the header + directory index and slices an entry's
//! bytes out deterministically — and the **`TEXT.DAT` codec** ([`TextDat`]):
//! flag-gated keyless decrypt/encrypt plus the record parser that exposes each
//! string's absolute byte offset.
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
//! # Honest scope: PAC container + `TEXT.DAT` codec, NOT the script
//!
//! This crate (a) enumerates / extracts **archive entries** and (b) decodes the
//! **`TEXT.DAT`** string pool (header + flag-gated cipher + record framing +
//! cp932 decode). It does **not** disassemble the `SCRIPT.SRC` (`Sv`-version)
//! bytecode nor resolve which `TEXT.DAT` record a line of dialogue uses, and it
//! does **not** patch edited text back into a repacked pool — those are
//! **separate Softpal nodes**. Extracting `SCRIPT.SRC` here yields its raw
//! (still engine-encoded) bytes, byte-identical to the oracle — nothing more.
//!
//! # Determinism / no shell-outs
//!
//! Pure in-process slicing over an in-memory `&[u8]`. No `Command::new`, no
//! external archiver, no GARbro. Malformed input never panics: every failure is
//! a typed [`PacError`].

mod archive;
mod textdat;

pub use archive::{
    PAC_COUNT_OFFSET, PAC_ENTRY_NAME_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
    PAC_MAGIC, PAC_MAX_ENTRIES, PacArchive, PacEntry, PacError,
};
pub use textdat::{
    EncFlag, TEXTDAT_COUNT_OFFSET, TEXTDAT_FLAG_ENCRYPTED, TEXTDAT_FLAG_PLAINTEXT,
    TEXTDAT_HEADER_BYTE_LEN, TEXTDAT_INITIAL_SHIFT, TEXTDAT_MAGIC_TAIL,
    TEXTDAT_RECORD_INDEX_BYTE_LEN, TEXTDAT_XOR_A, TEXTDAT_XOR_B, TextDat, TextDatError,
    TextDatHeader, TextRecord, decrypt, encrypt, parse_records,
};

/// Grep-pinnable namespace marker every [`PacError`] display string carries.
/// Lets a caller assert an error originated in this crate without matching on
/// the concrete variant.
pub const SOFTPAL_PAC_ERROR_MARKER: &str = "kaifuu.softpal.pac";

/// Grep-pinnable namespace marker every [`TextDatError`] display string
/// carries, mirroring [`SOFTPAL_PAC_ERROR_MARKER`] for the `TEXT.DAT` codec.
pub const SOFTPAL_TEXTDAT_ERROR_MARKER: &str = "kaifuu.softpal.textdat";

/// One-line capability boundary, mirroring the Softpal detector's
/// `SOFTPAL_SUPPORT_BOUNDARY`: this crate is the PAC container reader plus the
/// `TEXT.DAT` string-pool codec.
pub const SOFTPAL_PAC_SUPPORT_BOUNDARY: &str = "kaifuu-softpal enumerates and extracts entries of \
    the Softpal `PAC ` container (magic + u32 count @0x08 + 0x804 reserved header + 40-byte \
    name/size/offset index) deterministically, AND decodes the inner `TEXT.DAT` string pool \
    (16-byte header + flag-gated keyless ROL+XOR decrypt/encrypt + 4-byte-index/cp932/NUL record \
    parser with absolute byte offsets); SCRIPT.SRC disassembly/decompilation, string-pointer \
    resolution, and patch-back are NOT claimed (separate Softpal nodes).";
