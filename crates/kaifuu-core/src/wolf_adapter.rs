//! Wolf RPG Editor ADAPTER: core text tables extract + patch
//! through the layered container → crypto → codec → patch-back pipeline.
//! This node is an ADAPTER built as a COMPOSITION over the existing Wolf
//! substrate — it reimplements NONE of the crypto or detection:
//! - **Container + crypto (layer 1+2)** — reuses the encrypted-archive
//!   substrate ([`crate::wolf_encrypted_smoke`]): the Wolf-like container is
//!   packed/unpacked by [`pack_encrypted_archive`] / [`decrypt_archive_members`],
//!   the fixture-only XOR crypto key is resolved BY REF through
//!   [`WolfEncryptedFixtureSecretResolver`], and the raw key lives only inside the
//!   zeroize-on-drop [`WolfEncryptedArchiveKey`]. The adapter drives the SAME
//!   layer — a decrypted member's payload just carries a binary text table
//!   instead of a text file. This is the "cite smoke evidence before
//!   broad support claims" gate made mechanical.
//! - **Codec (layer 3)** — this node adds the Wolf text-table codec: a binary
//!   string-table layout (record/field cells addressed by (offset,len) into a
//!   Shift-JIS string blob) that [`decode_wolf_text_table`] extracts into text
//!   cells and [`encode_wolf_text_table`] reconstructs. Patching a cell to a
//!   different byte length rewrites every downstream string offset — a real
//!   binary-layout change (the "String table reconstruction" audit focus).
//! - **Patch-back (layer 4)** — a configurable patch engine applies a LIST of
//!   [`WolfTextPatchRequest`]s by (table, record, field) coordinate, re-encodes
//!   the affected tables, and repacks/re-encrypts through the same container+
//!   crypto layer. The round-trip verifies the patched text is present and every
//!   unchanged table is byte-identical.
//! # Gating: detector + helper boundary decide support (never a per-game branch)
//! Every run first combines the protection detector
//! ([`run_wolf_protection_detector`]) and the helper boundary
//! ([`run_wolf_helper_boundary`]) over the fixture's embedded evidence:
//! - the detector must classify the container `protected` (a concrete static-key
//!   requirement), and
//! - the helper boundary must report `key_resolved` (the key resolved locally by
//!   ref).
//!   Only then does the adapter extract + patch. Any other posture (an unknown or
//!   unsupported protection variant, a missing key, a helper-gated key) is an
//!   UNSUPPORTED outcome that emits a semantic capability diagnostic carrying the
//!   claimed-support tuple context — never a panic, never a silent drop, and never
//!   an extract/patch attempt.
//! # Engine-general (Wolf = data, no per-game branch)
//! A [`WolfTextTableAdapterFixture`] is pure DATA: the detector record, the
//! keyRef-bound helper-boundary profile, the synthetic text tables, and the
//! patch requests. The runner has no per-game branch; every Wolf game is a
//! data-driven fixture.
//! # Evidence is synthetic, redacted, ref-only
//! Fixtures carry NO retail bytes and NO raw key material. The key is resolved by
//! ref and never emitted; every emitted [`WolfTextTableAdapterReport`] carries
//! only ids, refs, byte counts, coordinates, and one-way sha256 hashes — never
//! the decoded table text, the raw key, or a local path.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::wolf_encrypted_smoke::{
    WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID, WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
    WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF, WolfEncryptedCryptoProfile, WolfEncryptedSmokeError,
    WolfPlainMember, build_synthetic_wolf_encrypted_archive,
};
#[cfg(test)]
use crate::wolf_helper_boundary::{WolfHelperBoundaryFixture, run_wolf_helper_boundary};
use crate::wolf_helper_boundary::{WolfHelperBoundaryOutcome, WolfHelperBoundaryProfile};
use crate::wolf_protection_detector::{
    WOLF_ENGINE_FAMILY, WolfCapabilityTuple, WolfProtectionDetectorFixtureEntry,
    WolfProtectionProfile,
};
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, HelperRedactionStatus, KaifuuResult,
    KeyMaterialKind, KeyValidationMethod, KeyValidationProof, OperationStatus, PatchBackTransform,
    ProofHash, SecretRef, SemanticErrorCode, SurfaceTransform, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

mod run;

pub use run::{run_wolf_text_table_adapter, run_wolf_text_table_adapter_from_path};

/// Stable marker prefix for typed display errors from this module.
pub const WOLF_ADAPTER_MARKER: &str = "kaifuu.wolf.adapter";
/// Fixture/report schema version.
pub const WOLF_ADAPTER_SCHEMA_VERSION: &str = "0.1.0";
/// Capability id surfaced by the adapter.
pub const WOLF_ADAPTER_CAPABILITY_ID: &str = "kaifuu-wolf-text-table-adapter";
/// The smoke evidence this adapter's encrypted variant cites.
pub const WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID: &str = WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID;
/// Blunt support boundary included in every report.
pub const WOLF_ADAPTER_SUPPORT_BOUNDARY: &str = "The Kaifuu Wolf RPG Editor adapter is a bounded SYNTHETIC composition: it drives the  encrypted-archive container+crypto substrate (key resolved by local SecretRef, raw key zeroized, never emitted), adds a Shift-JIS text-table codec (binary string-table layout), and patches configured text cells back through repack. Support is GATED by the  protection detector (must be `protected`) and the  helper boundary (must be `key_resolved`); any other posture is an unsupported variant that emits a semantic capability diagnostic with the claimed-support tuple. It is not commercial Wolf/DXArchive coverage and emits no raw keys, decoded table text, local paths, or retail bytes.";

/// Magic prefix of the synthetic Wolf text-table binary layout.
const WOLF_TEXT_TABLE_MAGIC: &[u8; 16] = b"KFWOLFTBL012\0\0\0\0";

// The Wolf text-table codec (layer 3): a binary Shift-JIS string table.

mod codec;
pub use codec::*;

mod fixture;
pub use fixture::*;

mod report;
pub use report::*;

mod verification;
use verification::{build_verify_proof, proof_hash, table_member_id, verify_round_trip};

fn write_u32(out: &mut Vec<u8>, value: usize) -> Result<(), WolfAdapterError> {
    let value = u32::try_from(value).map_err(|_| WolfAdapterError::TableFormat {
        detail: "table u32 field overflow".to_string(),
    })?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

/// Assert the substrate is present (a compile+link-time composition
/// anchor; the adapter drives the same synthetic container builder).
#[doc(hidden)]
pub fn cited_smoke_source_archive_len() -> usize {
    build_synthetic_wolf_encrypted_archive().len()
}

struct TableCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> TableCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], WolfAdapterError> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| WolfAdapterError::TableFormat {
                detail: "table cursor overflowed".to_string(),
            })?;
        if end > self.bytes.len() {
            return Err(WolfAdapterError::TableFormat {
                detail: "table ended early".to_string(),
            });
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn read_u32(&mut self) -> Result<u32, WolfAdapterError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .expect("take(4) returns four bytes");
        Ok(u32::from_le_bytes(bytes))
    }

    fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
#[path = "wolf_adapter_tests.rs"]
mod tests;
