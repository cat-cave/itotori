//! Sparse `VarBanks` adopted into the substrate
//! `Inspectable` / `Restorable` traits.
//!
//! Replaces the dense `[i32; 4096]` representation with sparse
//! `BTreeMap` storage so a snapshot of an unchanged machine stays under
//! 1 KB (only set indices appear). The integer-bank window is clamped to
//! the rlvm-documented **2 000 indices per bank** (per
//! `docs/research/reallive-engine.md` §G); writes past the ceiling emit a
//! [`VarBanksWarning::BankIndexOutOfRange`] and the index is clamped to
//! `BANK_INDEX_CAP - 1` rather than silently returning.
//!
//! # Bank layout
//!
//! - **Integer banks:** `intA`..`intM` (13 banks, bank bytes `0x00..=0x0C`
//!   pinned by the mapping). Each bank stores its values in a
//!   sparse [`BTreeMap<u16, i32>`].
//! - **String banks:** `strS`, `strM`, `strK` (three banks, names per
//!   §G of the research doc). Each bank stores **raw Shift-JIS bytes**
//!   ([`Vec<u8>`]); no UTF-8 lossy round-trip. The byte codes pinned
//!   below (`BANK_BYTE_STR_M = 0x0D` etc.) are local conventions
//!   reserved outside the int-bank window — real-corpus evidence
//!   for string-bank byte addressing is not yet in the research doc, so
//!   the codes are not load-bearing for any expression evaluator path
//!   today and are documented as such.
//! - **Store register:** a single `u32` (rlvm's documented type, see §G).
//!
//! # Substrate integration
//!
//! [`VarBanks`] implements [`utsushi_core::substrate::Inspectable`] and
//! [`utsushi_core::substrate::Restorable`]; the snapshot path serializes
//! the sparse maps as compact JSON strings under the `port.*` namespace
//! and the restore path validates type and shape end-to-end. A
//! round-trip through [`utsushi_core::substrate::InMemorySnapshotStore`]
//! is the load-bearing acceptance evidence in
//! `tests/var_banks.rs`.

#[cfg(test)]
#[path = "var_banks_tests.rs"]
mod tests;
include!("var_banks_parts/001.rs");
include!("var_banks_parts/002.rs");
include!("var_banks_parts/003.rs");
