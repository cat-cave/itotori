//! AVG-derived save format (`SAVE_FORMAT=3`).
//!
//! The observed AVG32 corpus ships three save files under `$GAME/SAVEDATA/`:
//!
//! - `REALLIVE.sav` — per-slot **system save** (24 876 bytes; magic
//!   `AVG_SYSTEM_SAVE`).
//! - `save999.sav` — **global save** (read-text flags, gallery
//!   unlocks; magic `AVG_GLOBAL_SAVE`).
//! - `read.sav` — per-line **read flags** (bitfield keyed by
//!   `(scene_id, kidoku_index)`; magic is the game's display title in
//!   Shift-JIS, e.g. `テスト\u{3000}`).
//!
//! All three share the same 24-byte preamble + null-terminated magic
//! string layout (the **AVG32-derived save format** documented under
//! `docs/research/reallive-engine.md` §J). The preamble has the shape
//! `(u32 leading, u32 compiler_version, [u16; 6] timestamp
//!   u16 padding_a, u16 tail)` and the magic string begins at offset
//! `0x18`. The leading u32 is the file size for `REALLIVE.sav` (the
//! audit-focus item the doc names verbatim); for the other two it is a
//! per-format constant (`0x000000A4` for `save999.sav`
//! `0x00000098` for `read.sav`).
//!
//! # Module structure
//!
//! - [`AvgSavePreamble`] — typed reader/writer for the 24-byte preamble.
//!   Endianness is **little-endian** in both directions; the audit-focus
//!   item "endianness flips between read and write" is structurally
//!   impossible because both helpers route through the same
//!   [`u32::from_le_bytes`] / [`u32::to_le_bytes`] pair.
//! - [`SystemSave`], [`GlobalSave`], [`ReadFlags`] — typed wrappers
//!   that pin the magic string and own the variable-length tail
//!   payload bytes verbatim. The `encode_*` helpers are byte-for-byte
//!   round-trips of the corresponding `decode_*` parsers — the
//!   "synthetic round-trip producing byte-identical output" spec
//!   acceptance criterion is enforced by [`SaveRoundTrip`] in the test
//!   suite.
//! - [`SaveState`] / [`Inspectable`] / [`Restorable`] — the substrate
//!   `SnapshotStore` integration. The on-disk serialiser is **strictly
//!   separate** from the in-memory backing: writing a `SystemSave` to
//!   bytes never touches the substrate; restoring a `SaveState` from
//!   the substrate never touches the disk. This is the spec's
//!   "substrate `SnapshotStore` is the in-memory backing for save
//!   state; on-disk serialiser is separate" pin.
//!
//! # Audit focus
//!
//! - **Writing to the read-only research mount must be banned at the
//!   test layer.** The real-bytes test in
//!   `tests/save_real_bytes.rs` reads observed save bytes
//!   from `$ITOTORI_REAL_GAME_ROOT` (mode 0444, dr-x------) but
//!   the test source has **no** `fs::write` / `fs::create_dir_all`
//!   `OpenOptions::write` calls — the audit grep
//!   `tests/save_real_bytes.rs` keeps the "no writes against the
//!   research mount" invariant pinned.
//! - **Endianness flips between read and write.** Both directions use
//!   little-endian; the [`AvgSavePreamble::encode`] / `decode` pair is
//!   load-bearing for the round-trip test.
//! - **Silently truncating slots.** [`SystemSave::payload`]
//!   [`GlobalSave::payload`] / [`ReadFlags::payload`] carry the
//!   variable-length tail verbatim; the round-trip tests assert
//!   `encoded.len() == decoded.preamble.leading_u32 as usize` for
//!   `REALLIVE.sav` and that the synthetic fixture round-trips
//!   byte-identically.

include!("save_parts/001.rs");
include!("save_parts/002.rs");
include!("save_parts/003.rs");
