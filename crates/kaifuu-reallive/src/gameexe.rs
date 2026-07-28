//! Gameexe.ini Shift-JIS line walker and key-family classifier.
//! Clean-room provenance (/)
//! - The key-family catalogue is derived from publicly archived Haeleth
//!   RLDEV documentation plus the RealLive key surface inventory at
//!   `docs/research/reallive-engine.md` §B (which itself was assembled from
//!   RLDEV plus byte-level counts taken against observed real bytes).
//!   No expression is copied from rlvm.
//! - replaces the previous 10-prefix hard-coded subset with a
//!   pattern-based classifier covering the documented RealLive surface.
//!   Keys that still don't match a documented family are recorded with a
//!   typed [`UnknownReason`] and paired with a
//!   `kaifuu.reallive.inventory.unknown_gameexe_key` warning, so no byte is
//!   silently dropped.
//! - Multi-game validation: the Gameexe.ini key-naming convention is
//!   hard-coded by the RealLive engine compiler — the catalogue
//!   generalises across titles even though byte-level evidence here is
//!   from one corpus only. Second-corpus retroactive validation is welcome
//!   but not blocking (see test file header).

mod parser;
#[cfg(test)]
#[path = "gameexe_tests.rs"]
mod tests;
include!("gameexe_parts/001.rs");
include!("gameexe_parts/002.rs");
include!("gameexe_parts/003.rs");
include!("gameexe_parts/004.rs");
