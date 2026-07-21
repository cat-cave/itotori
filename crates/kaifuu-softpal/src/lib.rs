//! Pure-Rust **Softpal / Amuse-Craft ("Pal" engine)** reader: the `PAC `
//! container envelope plus the inner `TEXT.DAT` string-pool codec.
//! Softpal ADV (aka Amuse Craft / "Pal"; used by CRYSTALiA, Hearts, Us:track,
//! Unison Shift, …) ships its assets in a single flat `PAC ` archive
//! (`data.pac`, `system.pac`, `csv.pac`, …). This crate owns the **container
//! envelope** — it parses the header + directory index and slices an entry's
//! bytes out deterministically — and the **`TEXT.DAT` codec** ([`TextDat`]):
//! flag-gated keyless decrypt/encrypt plus the record parser that exposes each
//! string's absolute byte offset.
//! # Format (all little-endian)
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
//!   payload verbatim (`bytes[offset.. offset+size]`).
//!   This is GARbro's PAC/AMUSE (`Pac2Opener`) variant. GARbro and the
//!   SoftPal-Tool `pac_unpack.py` are **extraction oracles only** — this reader
//!   is reimplemented deterministically in Rust and never shells out.
//! # Honest scope: PAC container + `TEXT.DAT` codec + disassembler + patch-back
//! This crate (a) enumerates / extracts **archive entries**, (b) decodes the
//! **`TEXT.DAT`** string pool (header + flag-gated cipher + record framing +
//! cp932 decode), (c) disassembles the **dialogue + speaker + choice
//! surfaces** of the plaintext `SCRIPT.SRC` (`Sv`-version) bytecode
//! ([`ScriptScan`] / [`Disassembly`]): it **derives** the TEXT-SHOW (32-byte) and
//! SELECT (16-byte) commands from the [`opcode`] arity-driven stack walk (the
//! single source of truth) and resolves their 4-byte `TEXT.DAT` pointers to
//! decoded lines, and (d) **patches translated dialogue / choices back**
//! ([`patchback`]): it rebuilds `TEXT.DAT` with new strings (old→new offset map,
//! re-encrypting when the original was), repoints the `SCRIPT.SRC` pointer fields,
//! and drops both as **loose files in the engine's `data\` override directory**
//! (no PAC repack; see [`patchback`] for the validated engine behaviour), and (e) **catalogs the full
//! `Sv20` opcode table** ([`opcode`] / [`OpcodeScan`]): it walks the whole
//! plaintext token stream arity-driven and types *every* command (the 33-entry
//! `0x01..=0x21` opcode table with fixed operand shapes, plus the `Call` engine
//! dispatch surface — TEXT-SHOW / SELECT / every other `(category, function)`
//! built-in), to a **0-unknown exhaustive** accounting on ≥2 real games. It does
//! **not** *execute* the stack machine (evaluate expressions, resolve jumps,
//! drive rendering) — that is the Utsushi Softpal replay runtime, a separate node.
//! # Determinism / no shell-outs
//! Pure in-process slicing over an in-memory `&[u8]`. No `Command::new`, no
//! external archiver, no GARbro. Malformed input never panics: every failure is
//! a typed [`PacError`].

mod archive;
mod opcode;
mod patchback;
mod script;
mod textdat;

pub use archive::{
    PAC_COUNT_OFFSET, PAC_ENTRY_NAME_BYTE_LEN, PAC_HEADER_BYTE_LEN, PAC_INDEX_ENTRY_BYTE_LEN,
    PAC_MAGIC, PAC_MAX_ENTRIES, PacArchive, PacEntry, PacError,
};
pub use opcode::{
    CALL_CATEGORY_SELECT, CALL_CATEGORY_TEXT, CallTarget, CommandFamily, Instruction, OpcodeError,
    OpcodeScan, Operand, OperandTag, SELECT_FUNCTION, SOFTPAL_OPCODE_ERROR_MARKER, SV_MAX_OPCODE,
    SV_OPERATOR_TAG, SV_PROGRAM_HEADER_BYTE_LEN, SV_TOKEN_BYTE_LEN, SvOpcode, SvProgramHeader,
    TEXT_TYPE_FUNCTIONS, UnknownToken,
};
pub use patchback::{
    OffsetMap, PATCHBACK_SCRIPT_NAME, PATCHBACK_TEXTDAT_NAME, Patchback, PatchbackError,
    SOFTPAL_PATCHBACK_ERROR_MARKER, TranslationMap, patchback, rebuild_textdat, repoint_script,
};
pub use script::{
    COMMAND_NAME_PTR_OFFSET, COMMAND_TEXT_PTR_OFFSET, ChoiceUnit, DecoupledLabel, DialogueUnit,
    Disassembly, NO_SPEAKER_POINTER, PointerResolution, RawCommand, SCRIPT_COMMAND_MARKER,
    SCRIPT_HEADER_BYTE_LEN, SCRIPT_MAGIC_PREFIX, SELECT_COMMAND_BYTE_LEN, SELECT_MARKER_OFFSET,
    SELECT_WORD_HI, SELECT_WORD_LO, ScriptError, ScriptHeader, ScriptScan,
    TEXT_SHOW_COMMAND_BYTE_LEN, TEXT_SHOW_MARKER_OFFSET, TEXT_SHOW_TYPE_WORDS, TEXT_SHOW_WORD_HI,
    TextRef,
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

/// Grep-pinnable namespace marker every [`ScriptError`] display string carries,
/// mirroring [`SOFTPAL_PAC_ERROR_MARKER`] for the `SCRIPT.SRC` disassembler.
pub const SOFTPAL_SCRIPT_ERROR_MARKER: &str = "kaifuu.softpal.script";

/// One-line capability boundary, mirroring the Softpal detector's
/// `SOFTPAL_SUPPORT_BOUNDARY`: this crate is the PAC container reader plus the
/// `TEXT.DAT` string-pool codec.
pub const SOFTPAL_PAC_SUPPORT_BOUNDARY: &str = "kaifuu-softpal enumerates and extracts entries of \
    the Softpal `PAC ` container (magic + u32 count @0x08 + 0x804 reserved header + 40-byte \
    name/size/offset index) deterministically, decodes the inner `TEXT.DAT` string pool \
    (16-byte header + flag-gated keyless ROL+XOR decrypt/encrypt + 4-byte-index/cp932/NUL record \
    parser with absolute byte offsets), AND disassembles the SCRIPT.SRC dialogue+speaker+choice \
    surfaces (Sv-version plaintext bytecode: TEXT-SHOW 32-byte + SELECT 16-byte commands DERIVED \
    from the Sv20 arity-driven stack walk (the Call 0x17 dispatch stream, single source of truth), \
    their 4-byte TEXT.DAT pointers read from the walk's typed operands and resolved to record \
    boundaries — SELECT labels via both encodings: direct plain immediates and indirect typed-value \
    assignment chains recovered by the same stack walk, with genuine system selects left out-of-pool \
    — byte-locatable pointer fields for patch-back), AND patches translated dialogue+choices back \
    (rebuild TEXT.DAT with an old->new offset map + re-encrypt when the original was, repoint the \
    SCRIPT.SRC pointer fields, drop both as loose files into the engine's data\\ override directory with no PAC repack), AND catalogs the full \
    Sv20 opcode table (arity-driven walk of the whole plaintext token stream: the 33-entry \
    0x01..=0x21 operator table with fixed operand shapes + operand structural tags + the Call \
    (0x17) engine-dispatch surface keyed by (category, function) incl. TEXT-SHOW/SELECT, to a \
    0-unknown exhaustive accounting on two real games); executing the Sv20 stack machine \
    (expression eval, jump resolution, rendering — the Utsushi replay runtime) is NOT claimed.";
