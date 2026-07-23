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
pub const WOLF_ADAPTER_SUPPORT_BOUNDARY: &str = "The Kaifuu Wolf RPG Editor adapter is a bounded SYNTHETIC composition: it drives the KAIFUU-073 encrypted-archive container+crypto substrate (key resolved by local SecretRef, raw key zeroized, never emitted), adds a Shift-JIS text-table codec (binary string-table layout), and patches configured text cells back through repack. Support is GATED by the KAIFUU-120 protection detector (must be `protected`) and the KAIFUU-121 helper boundary (must be `key_resolved`); any other posture is an unsupported variant that emits a semantic capability diagnostic with the claimed-support tuple. It is not commercial Wolf/DXArchive coverage and emits no raw keys, decoded table text, local paths, or retail bytes.";

/// Magic prefix of the synthetic Wolf text-table binary layout.
const WOLF_TEXT_TABLE_MAGIC: &[u8; 16] = b"KFWOLFTBL012\0\0\0\0";

// The Wolf text-table codec (layer 3): a binary Shift-JIS string table.

/// One synthetic Wolf text table: a named table of records, each record a fixed
/// number of Shift-JIS text cells. This is the plaintext codec view; on disk it
/// is the binary string-table layout produced by [`encode_wolf_text_table`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfTextTable {
    /// Stable table name (also the container member id). Synthetic; never retail.
    pub table_name: String,
    /// Number of text cells per record (the table's field width).
    pub field_count: u32,
    /// Row-major records; every record must have exactly `field_count` cells.
    pub records: Vec<Vec<String>>,
}

impl WolfTextTable {
    /// Total decoded text cells in the table.
    pub fn cell_count(&self) -> usize {
        self.records.len() * self.field_count as usize
    }

    /// The container member id this table packs into.
    pub(super) fn member_id(&self) -> String {
        format!("Data/{}.wolftable", self.table_name)
    }
}

/// A configurable patch request: replace the text cell at (table, record, field)
/// with `new_text`. Applied by the adapter before repack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfTextPatchRequest {
    pub table_name: String,
    pub record_index: u32,
    pub field_index: u32,
    /// The replacement text (must be Shift-JIS-encodable).
    pub new_text: String,
}

/// Encode a Wolf text table into its synthetic binary string-table layout.
/// Layout (little-endian):
/// `magic(16) | name_len(u32) | record_count(u32) | field_count(u32) |
/// blob_len(u32) | name(shift_jis) | cells[record*field]{offset(u32),len(u32)} |
/// string_blob(shift_jis)`.
/// The string blob concatenates every cell's Shift-JIS bytes in row-major order,
/// so a patched cell rewrites every downstream `(offset,len)` — a genuine binary
/// layout change, deterministically reconstructed.
pub fn encode_wolf_text_table(table: &WolfTextTable) -> Result<Vec<u8>, WolfAdapterError> {
    let field_count = table.field_count as usize;
    for (record_index, record) in table.records.iter().enumerate() {
        if record.len() != field_count {
            return Err(WolfAdapterError::TableFormat {
                detail: format!(
                    "record {record_index} has {} cells but field_count is {field_count}",
                    record.len()
                ),
            });
        }
    }

    // Build the string blob + per-cell (offset,len) index in row-major order.
    let mut blob: Vec<u8> = Vec::new();
    let mut cells: Vec<(u32, u32)> = Vec::with_capacity(table.cell_count());
    for record in &table.records {
        for cell in record {
            let encoded = encode_shift_jis(cell)?;
            let offset = u32::try_from(blob.len()).map_err(|_| WolfAdapterError::TableFormat {
                detail: "string blob offset overflowed u32".to_string(),
            })?;
            let len = u32::try_from(encoded.len()).map_err(|_| WolfAdapterError::TableFormat {
                detail: "string cell length overflowed u32".to_string(),
            })?;
            blob.extend_from_slice(&encoded);
            cells.push((offset, len));
        }
    }

    let name_bytes = encode_shift_jis(&table.table_name)?;
    let mut out = Vec::new();
    out.extend_from_slice(WOLF_TEXT_TABLE_MAGIC);
    write_u32(&mut out, name_bytes.len())?;
    write_u32(&mut out, table.records.len())?;
    write_u32(&mut out, field_count)?;
    write_u32(&mut out, blob.len())?;
    out.extend_from_slice(&name_bytes);
    for (offset, len) in &cells {
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
    }
    out.extend_from_slice(&blob);
    Ok(out)
}

/// Read just the `(offset,len)` string-table index from an encoded Wolf
/// text-table member. This is the layout skeleton: the per-cell offsets and
/// lengths every downstream string is addressed by. Comparing two members'
/// indexes proves whether a patch actually REWROTE the layout (offsets shifted
/// or lengths changed) versus merely swapped equal-length bytes in place.
pub(super) fn read_offset_index(bytes: &[u8]) -> Result<Vec<(u32, u32)>, WolfAdapterError> {
    let mut cursor = TableCursor::new(bytes);
    let magic = cursor.take(WOLF_TEXT_TABLE_MAGIC.len())?;
    if magic != WOLF_TEXT_TABLE_MAGIC {
        return Err(WolfAdapterError::TableFormat {
            detail: "Wolf text-table magic did not match".to_string(),
        });
    }
    let name_len = cursor.read_u32()? as usize;
    let record_count = cursor.read_u32()? as usize;
    let field_count = cursor.read_u32()? as usize;
    let _blob_len = cursor.read_u32()?;
    let _name = cursor.take(name_len)?;
    let cell_total =
        record_count
            .checked_mul(field_count)
            .ok_or_else(|| WolfAdapterError::TableFormat {
                detail: "record_count * field_count overflowed".to_string(),
            })?;
    let mut cells = Vec::with_capacity(cell_total);
    for _ in 0..cell_total {
        let offset = cursor.read_u32()?;
        let len = cursor.read_u32()?;
        cells.push((offset, len));
    }
    Ok(cells)
}

/// Decode a Wolf text-table binary layout back into its text-cell view.
pub fn decode_wolf_text_table(bytes: &[u8]) -> Result<WolfTextTable, WolfAdapterError> {
    let mut cursor = TableCursor::new(bytes);
    let magic = cursor.take(WOLF_TEXT_TABLE_MAGIC.len())?;
    if magic != WOLF_TEXT_TABLE_MAGIC {
        return Err(WolfAdapterError::TableFormat {
            detail: "Wolf text-table magic did not match".to_string(),
        });
    }
    let name_len = cursor.read_u32()? as usize;
    let record_count = cursor.read_u32()? as usize;
    let field_count = cursor.read_u32()? as usize;
    let blob_len = cursor.read_u32()? as usize;
    let name_bytes = cursor.take(name_len)?.to_vec();
    let cell_total =
        record_count
            .checked_mul(field_count)
            .ok_or_else(|| WolfAdapterError::TableFormat {
                detail: "record_count * field_count overflowed".to_string(),
            })?;
    let mut cells = Vec::with_capacity(cell_total);
    for _ in 0..cell_total {
        let offset = cursor.read_u32()? as usize;
        let len = cursor.read_u32()? as usize;
        cells.push((offset, len));
    }
    let blob = cursor.take(blob_len)?;
    if !cursor.is_finished() {
        return Err(WolfAdapterError::TableFormat {
            detail: "Wolf text-table had trailing bytes".to_string(),
        });
    }

    let table_name = decode_shift_jis(&name_bytes)?;
    let mut records = Vec::with_capacity(record_count);
    let mut cell_iter = cells.into_iter();
    for _ in 0..record_count {
        let mut record = Vec::with_capacity(field_count);
        for _ in 0..field_count {
            let (offset, len) = cell_iter
                .next()
                .ok_or_else(|| WolfAdapterError::TableFormat {
                    detail: "cell index ran past the encoded cell table".to_string(),
                })?;
            let end = offset
                .checked_add(len)
                .ok_or_else(|| WolfAdapterError::TableFormat {
                    detail: "cell (offset,len) overflowed".to_string(),
                })?;
            if end > blob.len() {
                return Err(WolfAdapterError::TableFormat {
                    detail: "cell slice ran past the string blob".to_string(),
                });
            }
            record.push(decode_shift_jis(&blob[offset..end])?);
        }
        records.push(record);
    }
    Ok(WolfTextTable {
        table_name,
        field_count: field_count as u32,
        records,
    })
}

fn encode_shift_jis(text: &str) -> Result<Vec<u8>, WolfAdapterError> {
    let (bytes, _, had_errors) = encoding_rs::SHIFT_JIS.encode(text);
    if had_errors {
        return Err(WolfAdapterError::CodecEncode {
            detail: "text is not representable in Shift-JIS".to_string(),
        });
    }
    Ok(bytes.into_owned())
}

fn decode_shift_jis(bytes: &[u8]) -> Result<String, WolfAdapterError> {
    let (text, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if had_errors {
        return Err(WolfAdapterError::CodecDecode {
            detail: "byte sequence was not valid Shift-JIS".to_string(),
        });
    }
    Ok(text.into_owned())
}

// Errors

/// Fatal errors for the adapter. Every free-text detail is redacted at `Display`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WolfAdapterError {
    TableFormat { detail: String },
    CodecEncode { detail: String },
    CodecDecode { detail: String },
    PatchTargetMissing { detail: String },
    Container { detail: String },
    Internal { message: String },
}

impl fmt::Display for WolfAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TableFormat { detail } => write!(
                formatter,
                "{WOLF_ADAPTER_MARKER}.table_format: {}",
                redact_for_log_or_report(detail)
            ),
            Self::CodecEncode { detail } => write!(
                formatter,
                "{WOLF_ADAPTER_MARKER}.codec_encode: {}",
                redact_for_log_or_report(detail)
            ),
            Self::CodecDecode { detail } => write!(
                formatter,
                "{WOLF_ADAPTER_MARKER}.codec_decode: {}",
                redact_for_log_or_report(detail)
            ),
            Self::PatchTargetMissing { detail } => write!(
                formatter,
                "{WOLF_ADAPTER_MARKER}.patch_target_missing: {}",
                redact_for_log_or_report(detail)
            ),
            Self::Container { detail } => write!(
                formatter,
                "{WOLF_ADAPTER_MARKER}.container: {}",
                redact_for_log_or_report(detail)
            ),
            Self::Internal { message } => write!(
                formatter,
                "{WOLF_ADAPTER_MARKER}.internal: {}",
                redact_for_log_or_report(message)
            ),
        }
    }
}

impl std::error::Error for WolfAdapterError {}

impl From<WolfEncryptedSmokeError> for WolfAdapterError {
    fn from(error: WolfEncryptedSmokeError) -> Self {
        // The container/crypto layer is 's; surface its typed failure as
        // a redacted container error (its own Display is already redaction-clean).
        Self::Container {
            detail: error.to_string(),
        }
    }
}

// Fixture (input) schema

/// One synthetic Wolf text-table adapter fixture — pure data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfTextTableAdapterFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    /// The container's protection posture (detector evidence).
    pub detector: WolfProtectionDetectorFixtureEntry,
    /// The keyRef-bound container-key binding (helper-boundary
    /// evidence). Present for every keyRef-bound protected variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_boundary: Option<WolfHelperBoundaryProfile>,
    /// The local-scheme ref the container key is resolved by (never key bytes).
    pub secret_ref: SecretRef,
    /// The synthetic Wolf text tables (plaintext view; packed encrypted).
    pub tables: Vec<WolfTextTable>,
    /// The configured text-cell patch requests to apply before repack.
    pub patches: Vec<WolfTextPatchRequest>,
}

impl WolfTextTableAdapterFixture {
    /// The bounded synthetic fixture: a `protected` container with a locally
    /// resolvable static key, two Shift-JIS text tables, and two patch requests.
    pub fn synthetic() -> Self {
        use crate::wolf_protection_detector::WolfArchiveProtectionSignal;
        use crate::wolf_protection_detector::WolfSecretRequirement;

        let secret_ref = SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF)
            .expect("static synthetic secret ref is valid");
        let detector = WolfProtectionDetectorFixtureEntry {
            fixture_id: "wolf.adapter.protected".to_string(),
            variant: "synthetic-protected-textdb".to_string(),
            container: ContainerTransform::WolfArchive,
            protection_signal: WolfArchiveProtectionSignal::StaticKeyProtected,
            crypto: CryptoTransform::FixedKey,
            codec: CodecTransform::ShiftJisText,
            surface: SurfaceTransform::TableRecord,
            secret_requirements: vec![WolfSecretRequirement {
                requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
                key_ref: Some(secret_ref.clone()),
            }],
            expected_profile: WolfProtectionProfile::Protected,
            expected_semantic_codes: vec![
                SemanticErrorCode::UnsupportedLayeredTransform
                    .as_str()
                    .to_string(),
            ],
        };
        let helper_boundary = Some(synthetic_helper_profile(&secret_ref, true));
        let tables = vec![
            WolfTextTable {
                table_name: "CharacterDB".to_string(),
                field_count: 2,
                records: vec![
                    vec!["hero-name".to_string(), "テスト説明A".to_string()],
                    vec!["mage-name".to_string(), "テスト説明B".to_string()],
                ],
            },
            WolfTextTable {
                table_name: "SystemStrings".to_string(),
                field_count: 1,
                records: vec![
                    vec!["synthetic-menu=start".to_string()],
                    vec!["synthetic-menu=load".to_string()],
                ],
            },
            // An UNCHANGED table: no patch targets it, so the round-trip must
            // leave it byte-identical (exercised by the byte-identical test).
            WolfTextTable {
                table_name: "MenuStrings".to_string(),
                field_count: 1,
                records: vec![
                    vec!["synthetic-title=start".to_string()],
                    vec!["synthetic-title=config".to_string()],
                ],
            },
        ];
        let patches = vec![
            WolfTextPatchRequest {
                table_name: "CharacterDB".to_string(),
                record_index: 0,
                field_index: 1,
                new_text: "テスト説明A-改".to_string(),
            },
            WolfTextPatchRequest {
                table_name: "SystemStrings".to_string(),
                record_index: 0,
                field_index: 0,
                new_text: "synthetic-menu=begin".to_string(),
            },
        ];
        Self {
            schema_version: WOLF_ADAPTER_SCHEMA_VERSION.to_string(),
            fixture_id: "wolf-text-table-adapter-synthetic".to_string(),
            source_node_id: "KAIFUU-012".to_string(),
            engine_family: WOLF_ENGINE_FAMILY.to_string(),
            detector,
            helper_boundary,
            secret_ref,
            tables,
            patches,
        }
    }
}

/// Build a synthetic helper-boundary profile bound to `secret_ref`.
/// `locally_available` toggles the `key_resolved` vs `key_missing` outcome.
fn synthetic_helper_profile(
    secret_ref: &SecretRef,
    locally_available: bool,
) -> WolfHelperBoundaryProfile {
    use crate::wolf_helper_boundary::{
        WolfHelperBoundaryKind, WolfHelperBoundaryOutcome, WolfHelperKeyRequirement,
    };
    WolfHelperBoundaryProfile {
        fixture_id: "wolf.adapter.static-key".to_string(),
        profile_id: "wolf.adapter.static-key".to_string(),
        boundary_kind: WolfHelperBoundaryKind::StaticKeyLocalImport,
        key_requirement: WolfHelperKeyRequirement {
            requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
            key_ref: secret_ref.clone(),
            material_kind: KeyMaterialKind::FixedBytes,
        },
        locally_available,
        expected_outcome: if locally_available {
            WolfHelperBoundaryOutcome::KeyResolved
        } else {
            WolfHelperBoundaryOutcome::KeyMissing
        },
    }
}

// Report (generated) schema

/// The outcome the adapter mechanically reaches: a full extract+patch round-trip
/// (`supported`) or an unsupported variant carrying a semantic diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfAdapterOutcome {
    /// The gate cleared (`protected` + `key_resolved`); the round-trip ran.
    Supported,
    /// An unsupported protection/key posture; extract/patch were refused.
    Unsupported,
}

/// The layered transform legs the adapter drove (identify → patch-back).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterTransformLegs {
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
}

impl WolfAdapterTransformLegs {
    pub(super) fn canonical() -> Self {
        Self {
            container: ContainerTransform::WolfArchive,
            crypto: CryptoTransform::FixedKey,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            codec: CodecTransform::ShiftJisText,
            surface: SurfaceTransform::TableRecord,
            patch_back: PatchBackTransform::RepackArchive,
        }
    }
}

/// One extracted text table digest (counts + hash; never the decoded text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterTableDigest {
    pub table_name: String,
    pub record_count: u32,
    pub field_count: u32,
    pub text_cell_count: u32,
    /// sha256 of the decrypted binary table member (never the text).
    pub member_hash: ProofHash,
    pub member_byte_len: u64,
}

impl WolfAdapterTableDigest {
    fn redacted_for_report(&self) -> Self {
        Self {
            table_name: redact_for_log_or_report(&self.table_name),
            ..self.clone()
        }
    }
}

/// One patched-cell coordinate (indices only — never the text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterPatchCoordinate {
    pub record_index: u32,
    pub field_index: u32,
}

/// A deterministic per-table patch report: byte-length + hash before/after, plus
/// whether the string-table offset index was rewritten by the patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterTablePatchReport {
    pub table_name: String,
    pub coordinates: Vec<WolfAdapterPatchCoordinate>,
    pub source_member_hash: ProofHash,
    pub patched_member_hash: ProofHash,
    pub source_member_byte_len: u64,
    pub patched_member_byte_len: u64,
    /// True iff the patch REWROTE the string-table offset index — the per-cell
    /// `(offset,len)` table differs after repack (a downstream offset shifted or
    /// a cell length changed). A same-length in-place edit leaves the layout
    /// untouched and keeps this false, even though the member bytes differ (which
    /// is proven separately by `source_member_hash`!= `patched_member_hash`).
    pub layout_changed: bool,
    /// True iff every patched cell decoded to its requested text after repack.
    pub patched_text_verified: bool,
}

impl WolfAdapterTablePatchReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            table_name: redact_for_log_or_report(&self.table_name),
            ..self.clone()
        }
    }
}

/// A semantic capability diagnostic for an unsupported variant, carrying the
/// claimed-support tuple context (acceptance criterion 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterCapabilityDiagnostic {
    pub semantic_code: String,
    pub field: String,
    pub message: String,
    /// The claimed-support tuple context (what the adapter can/can't claim here).
    pub claimed_support: WolfCapabilityTuple,
}

impl WolfAdapterCapabilityDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            semantic_code: self.semantic_code.clone(),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            claimed_support: self.claimed_support.clone(),
        }
    }
}

/// The full adapter report. Serialize through [`WolfTextTableAdapterReport::stable_json`]
/// for redaction discipline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfTextTableAdapterReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub support_boundary: String,
    /// The smoke evidence this encrypted variant cites.
    pub cited_smoke_capability_id: String,
    pub fixture_id: String,
    pub engine_family: String,
    pub outcome: WolfAdapterOutcome,
    pub protection_profile: WolfProtectionProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_outcome: Option<WolfHelperBoundaryOutcome>,
    /// The claimed-support tuple context (present for every outcome).
    pub claimed_support: WolfCapabilityTuple,
    pub transform_legs: WolfAdapterTransformLegs,
    pub secret_requirement_id: String,
    pub secret_ref: SecretRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_material_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<u32>,
    pub key_material_kind: KeyMaterialKind,
    pub redaction_status: HelperRedactionStatus,
    /// Present only for a supported round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_archive_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebuilt_archive_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extract_manifest: Vec<WolfAdapterTableDigest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patch_reports: Vec<WolfAdapterTablePatchReport>,
    /// Number of unchanged tables verified byte-identical after repack.
    pub unchanged_tables_verified: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_proof: Option<KeyValidationProof>,
    /// The semantic capability diagnostics (present for an unsupported variant).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capability_diagnostics: Vec<WolfAdapterCapabilityDiagnostic>,
    pub delta_package_id: String,
    pub status: OperationStatus,
}

impl WolfTextTableAdapterReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            cited_smoke_capability_id: redact_for_log_or_report(&self.cited_smoke_capability_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            outcome: self.outcome,
            protection_profile: self.protection_profile,
            helper_outcome: self.helper_outcome,
            claimed_support: self.claimed_support.clone(),
            transform_legs: self.transform_legs.clone(),
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            source_archive_hash: self.source_archive_hash.clone(),
            rebuilt_archive_hash: self.rebuilt_archive_hash.clone(),
            extract_manifest: self
                .extract_manifest
                .iter()
                .map(WolfAdapterTableDigest::redacted_for_report)
                .collect(),
            patch_reports: self
                .patch_reports
                .iter()
                .map(WolfAdapterTablePatchReport::redacted_for_report)
                .collect(),
            unchanged_tables_verified: self.unchanged_tables_verified,
            verify_proof: self.verify_proof.clone(),
            capability_diagnostics: self
                .capability_diagnostics
                .iter()
                .map(WolfAdapterCapabilityDiagnostic::redacted_for_report)
                .collect(),
            delta_package_id: redact_for_log_or_report(&self.delta_package_id),
            status: self.status.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// Verify the rebuilt archive: patched cells decode to the requested text and
/// unchanged tables are byte-identical. Returns the finalized patch reports and
/// the count of unchanged tables verified.
pub(super) fn verify_round_trip(
    source: &[WolfPlainMember],
    verified: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
    mut patch_reports: Vec<WolfAdapterTablePatchReport>,
) -> Result<(Vec<WolfAdapterTablePatchReport>, u32), WolfAdapterError> {
    let patched_member_ids: std::collections::BTreeSet<String> = patches
        .iter()
        .map(|patch| table_member_id(&patch.table_name))
        .collect();

    // Every patched table's cells must decode to the requested new text.
    for report in &mut patch_reports {
        let member_id = table_member_id(&report.table_name);
        let member = verified
            .iter()
            .find(|member| member.member_id == member_id)
            .ok_or_else(|| WolfAdapterError::Internal {
                message: "verified archive dropped a patched table".to_string(),
            })?;
        let table = decode_wolf_text_table(&member.plaintext)?;
        let mut all_ok = true;
        for coordinate in &report.coordinates {
            let expected = patches
                .iter()
                .find(|patch| {
                    table_member_id(&patch.table_name) == member_id
                        && patch.record_index == coordinate.record_index
                        && patch.field_index == coordinate.field_index
                })
                .map(|patch| patch.new_text.as_str());
            let actual = table
                .records
                .get(coordinate.record_index as usize)
                .and_then(|record| record.get(coordinate.field_index as usize))
                .map(String::as_str);
            if expected != actual {
                all_ok = false;
            }
        }
        report.patched_text_verified = all_ok;
        if !all_ok {
            return Err(WolfAdapterError::Internal {
                message: "a patched cell did not decode to its requested text after repack"
                    .to_string(),
            });
        }
    }

    // Every unchanged table must be byte-identical after repack.
    let mut unchanged_tables_verified = 0u32;
    for source_member in source {
        if patched_member_ids.contains(&source_member.member_id) {
            continue;
        }
        let verified_member = verified
            .iter()
            .find(|member| member.member_id == source_member.member_id)
            .ok_or_else(|| WolfAdapterError::Internal {
                message: "verified archive dropped an unchanged table".to_string(),
            })?;
        if verified_member.plaintext != source_member.plaintext {
            return Err(WolfAdapterError::Internal {
                message: "an unchanged table was not byte-identical after repack".to_string(),
            });
        }
        unchanged_tables_verified += 1;
    }

    Ok((patch_reports, unchanged_tables_verified))
}

pub(super) fn build_verify_proof(
    verified: &[WolfPlainMember],
) -> Result<KeyValidationProof, WolfAdapterError> {
    let mut proof_material = Vec::new();
    for member in verified {
        proof_material.extend_from_slice(member.member_id.as_bytes());
        proof_material.extend_from_slice(proof_hash(&member.plaintext)?.as_str().as_bytes());
    }
    Ok(KeyValidationProof {
        method: KeyValidationMethod::FixtureRoundTripProof,
        proof_hash: proof_hash(&proof_material)?,
    })
}

/// The container member id a table name packs into (kept in sync with
/// [`WolfTextTable::member_id`]).
pub(super) fn table_member_id(table_name: &str) -> String {
    format!("Data/{table_name}.wolftable")
}

pub(super) fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfAdapterError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| WolfAdapterError::Internal { message })
}

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
