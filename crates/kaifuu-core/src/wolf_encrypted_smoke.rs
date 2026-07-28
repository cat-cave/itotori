//! - bounded Wolf encrypted-archive decrypt -> extract -> patch ->
//!   verify smoke.
//!   This module proves one narrow, synthetic Wolf-like encrypted archive path:
//!   a deterministic fixture container is built in-process, its text-bearing
//!   member payloads are encrypted with a fixture-only XOR profile, the key is
//!   resolved by [`SecretRef`], the archive is decrypted/extracted, one trivial
//!   replacement is applied, the archive is re-encrypted/repacked, and the rebuilt
//!   container is decrypted again to verify the patched text is present.
//!   Honest scope: this is NOT commercial Wolf/DXArchive coverage and NOT a real
//!   Wolf cipher. It is a bounded synthetic smoke for the Kaifuu secret-ref and
//!   decrypt/extract/patch/verify contract. Fixture/report data carry only ids,
//!   refs, byte counts, and one-way hashes. Raw key bytes live only inside
//!   [`WolfEncryptedArchiveKey`], whose `Debug` is redacted and whose buffer is
//!   zeroized on drop.

mod model;
pub use model::*;

mod run;
pub use run::*;

#[cfg(test)]
#[path = "wolf_encrypted_smoke_tests.rs"]
mod tests;

#[cfg(test)]
use crate::{OperationStatus, SecretRef};
#[cfg(test)]
use run::apply_trivial_patch;
#[cfg(test)]
use std::path::Path;
