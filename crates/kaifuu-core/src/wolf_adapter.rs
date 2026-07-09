//! KAIFUU-012 — Wolf RPG Editor ADAPTER: core text tables extract + patch
//! through the layered container → crypto → codec → patch-back pipeline.
//!
//! This node is an ADAPTER built as a COMPOSITION over the existing Wolf
//! substrate — it reimplements NONE of the crypto or detection:
//!
//! - **Container + crypto (layer 1+2)** — reuses the KAIFUU-073 encrypted-archive
//!   substrate ([`crate::wolf_encrypted_smoke`]): the Wolf-like container is
//!   packed/unpacked by [`pack_encrypted_archive`] / [`decrypt_archive_members`],
//!   the fixture-only XOR crypto key is resolved BY REF through
//!   [`WolfEncryptedFixtureSecretResolver`], and the raw key lives only inside the
//!   zeroize-on-drop [`WolfEncryptedArchiveKey`]. The adapter drives the SAME
//!   layer — a decrypted member's payload just carries a binary text table
//!   instead of a text file. This is the "cite KAIFUU-073 smoke evidence before
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
//!
//! # Gating: detector + helper boundary decide support (never a per-game branch)
//!
//! Every run first combines the KAIFUU-120 protection detector
//! ([`run_wolf_protection_detector`]) and the KAIFUU-121 helper boundary
//! ([`run_wolf_helper_boundary`]) over the fixture's embedded evidence:
//!
//! - the detector must classify the container `protected` (a concrete static-key
//!   requirement), and
//! - the helper boundary must report `key_resolved` (the key resolved locally by
//!   ref).
//!
//! Only then does the adapter extract + patch. Any other posture (an unknown or
//! unsupported protection variant, a missing key, a helper-gated key) is an
//! UNSUPPORTED outcome that emits a semantic capability diagnostic carrying the
//! claimed-support tuple context — never a panic, never a silent drop, and never
//! an extract/patch attempt.
//!
//! # Engine-general (Wolf = data, no per-game branch)
//!
//! A [`WolfTextTableAdapterFixture`] is pure DATA: the detector record, the
//! keyRef-bound helper-boundary profile, the synthetic text tables, and the
//! patch requests. The runner has no per-game branch; every Wolf game is a
//! data-driven fixture.
//!
//! # Evidence is synthetic, redacted, ref-only
//!
//! Fixtures carry NO retail bytes and NO raw key material. The key is resolved by
//! ref and never emitted; every emitted [`WolfTextTableAdapterReport`] carries
//! only ids, refs, byte counts, coordinates, and one-way sha256 hashes — never
//! the decoded table text, the raw key, or a local path.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::registry::capability::CapabilityLevelStatus;
use crate::wolf_encrypted_smoke::{
    WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID, WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
    WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF, WolfEncryptedArchiveKeyExt, WolfEncryptedCryptoProfile,
    WolfEncryptedFixtureSecretResolver, WolfEncryptedSmokeError, WolfPlainMember,
    build_synthetic_wolf_encrypted_archive, decrypt_archive_members, pack_encrypted_archive,
};
use crate::wolf_helper_boundary::{
    WolfHelperBoundaryFixture, WolfHelperBoundaryOutcome, WolfHelperBoundaryProfile,
    run_wolf_helper_boundary,
};
use crate::wolf_protection_detector::{
    WOLF_ENGINE_FAMILY, WolfCapabilityTuple, WolfProtectionDetectorFixture,
    WolfProtectionDetectorFixtureEntry, WolfProtectionProfile, derive_wolf_capability_tuple,
    run_wolf_protection_detector,
};
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, HelperRedactionStatus, KaifuuResult,
    KeyMaterialKind, KeyValidationMethod, KeyValidationProof, OperationStatus, PatchBackTransform,
    ProofHash, SecretRef, SemanticErrorCode, SurfaceTransform, deterministic_id, read_json,
    redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

/// Stable marker prefix for typed display errors from this module.
pub const WOLF_ADAPTER_MARKER: &str = "kaifuu.wolf.adapter";
/// Fixture/report schema version.
pub const WOLF_ADAPTER_SCHEMA_VERSION: &str = "0.1.0";
/// Capability id surfaced by the adapter.
pub const WOLF_ADAPTER_CAPABILITY_ID: &str = "kaifuu-wolf-text-table-adapter";
/// The KAIFUU-073 smoke evidence this adapter's encrypted variant cites.
pub const WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID: &str = WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID;
/// Blunt support boundary included in every report.
pub const WOLF_ADAPTER_SUPPORT_BOUNDARY: &str = "The Kaifuu Wolf RPG Editor adapter is a bounded SYNTHETIC composition: it drives the KAIFUU-073 encrypted-archive container+crypto substrate (key resolved by local SecretRef, raw key zeroized, never emitted), adds a Shift-JIS text-table codec (binary string-table layout), and patches configured text cells back through repack. Support is GATED by the KAIFUU-120 protection detector (must be `protected`) and the KAIFUU-121 helper boundary (must be `key_resolved`); any other posture is an unsupported variant that emits a semantic capability diagnostic with the claimed-support tuple. It is not commercial Wolf/DXArchive coverage and emits no raw keys, decoded table text, local paths, or retail bytes.";

/// Magic prefix of the synthetic Wolf text-table binary layout.
const WOLF_TEXT_TABLE_MAGIC: &[u8; 16] = b"KFWOLFTBL012\0\0\0\0";

// ---------------------------------------------------------------------------
// The Wolf text-table codec (layer 3): a binary Shift-JIS string table.
// ---------------------------------------------------------------------------

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
    fn member_id(&self) -> String {
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
///
/// Layout (little-endian):
/// `magic(16) | name_len(u32) | record_count(u32) | field_count(u32) |
///  blob_len(u32) | name(shift_jis) | cells[record*field]{offset(u32),len(u32)} |
///  string_blob(shift_jis)`.
///
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
fn read_offset_index(bytes: &[u8]) -> Result<Vec<(u32, u32)>, WolfAdapterError> {
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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
        // The container/crypto layer is KAIFUU-073's; surface its typed failure as
        // a redacted container error (its own Display is already redaction-clean).
        Self::Container {
            detail: error.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture (input) schema
// ---------------------------------------------------------------------------

/// One synthetic Wolf text-table adapter fixture — pure data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfTextTableAdapterFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    /// The container's protection posture (KAIFUU-120 detector evidence).
    pub detector: WolfProtectionDetectorFixtureEntry,
    /// The keyRef-bound container-key binding (KAIFUU-121 helper-boundary
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

/// Build a synthetic KAIFUU-121 helper-boundary profile bound to `secret_ref`.
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

// ---------------------------------------------------------------------------
// Report (generated) schema
// ---------------------------------------------------------------------------

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
    fn canonical() -> Self {
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
    /// is proven separately by `source_member_hash` != `patched_member_hash`).
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
    /// The KAIFUU-073 smoke evidence this encrypted variant cites.
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

// ---------------------------------------------------------------------------
// The adapter runner (the composition)
// ---------------------------------------------------------------------------

/// Run the Wolf text-table adapter over a synthetic fixture: gate on the
/// detector + helper boundary, then extract + patch the text tables through the
/// layered container → crypto → codec → patch-back pipeline. Never panics.
pub fn run_wolf_text_table_adapter(
    fixture: &WolfTextTableAdapterFixture,
) -> Result<WolfTextTableAdapterReport, WolfAdapterError> {
    // --- Gate half 1: the KAIFUU-120 protection detector. --------------------
    let detector_report = run_wolf_protection_detector(&WolfProtectionDetectorFixture {
        schema_version: crate::wolf_protection_detector::WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION
            .to_string(),
        detector_set_id: format!("wolf-adapter/{}/detector", fixture.fixture_id),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        entries: vec![fixture.detector.clone()],
    });
    let detector_entry = detector_report
        .entries
        .into_iter()
        .next()
        .expect("single-entry detector fixture yields exactly one entry");
    let protection_profile = detector_entry.profile;

    // --- Gate half 2: the KAIFUU-121 helper boundary. ------------------------
    // Capture the FULL boundary posture — the derived outcome PLUS the boundary's
    // own validation status and findings. The gate consumes all three, so a
    // failed or finding-bearing posture can never be waved through to
    // extract/patch on the strength of its outcome alone.
    let helper_posture = fixture.helper_boundary.as_ref().map(|profile| {
        let report = run_wolf_helper_boundary(&WolfHelperBoundaryFixture {
            schema_version: crate::wolf_helper_boundary::WOLF_HELPER_BOUNDARY_SCHEMA_VERSION
                .to_string(),
            boundary_set_id: format!("wolf-adapter/{}/helper-boundary", fixture.fixture_id),
            source_node_id: fixture.source_node_id.clone(),
            engine_family: fixture.engine_family.clone(),
            profiles: vec![profile.clone()],
        });
        let entry = report
            .entries
            .into_iter()
            .next()
            .expect("single-profile helper-boundary fixture yields exactly one entry");
        HelperBoundaryPosture {
            outcome: entry.outcome,
            status: entry.status,
            finding_count: entry.findings.len(),
        }
    });
    let helper_outcome = helper_posture.as_ref().map(|posture| posture.outcome);

    match classify_gate(
        &fixture.engine_family,
        protection_profile,
        helper_posture.as_ref(),
        detector_entry.status,
    ) {
        None => run_supported(
            fixture,
            protection_profile,
            helper_outcome,
            supported_claimed_support(),
        ),
        Some(diagnostic) => Ok(build_unsupported_report(
            fixture,
            protection_profile,
            helper_outcome,
            diagnostic,
        )),
    }
}

/// Read a fixture JSON and run the adapter against it.
pub fn run_wolf_text_table_adapter_from_path(
    fixture_path: &Path,
) -> Result<WolfTextTableAdapterReport, WolfAdapterError> {
    let fixture: WolfTextTableAdapterFixture =
        read_json(fixture_path).map_err(|error| WolfAdapterError::Internal {
            message: error.to_string(),
        })?;
    run_wolf_text_table_adapter(&fixture)
}

/// The claimed-support tuple for a cleared gate: identify/inventory/extract/patch
/// are supported (proven by the round-trip); helper/runtime stay out of scope.
fn supported_claimed_support() -> WolfCapabilityTuple {
    WolfCapabilityTuple {
        identify: CapabilityLevelStatus::supported(),
        inventory: CapabilityLevelStatus::supported(),
        extract: CapabilityLevelStatus::supported(),
        patch: CapabilityLevelStatus::supported(),
        helper: CapabilityLevelStatus::unsupported(
            "the static key resolved by ref; no dynamic-key helper applies",
        ),
        runtime: CapabilityLevelStatus::unsupported(
            "Wolf runtime replay is a utsushi-wolf node, not this adapter",
        ),
    }
}

/// The gate-relevant view of the KAIFUU-121 helper boundary: the mechanically
/// derived outcome PLUS whether the boundary evidence is itself trustworthy
/// (it PASSED its own KAIFUU-121 validation and raised no findings). The gate
/// requires the success posture on ALL of these — a `key_resolved` outcome
/// carried by a failed/finding-bearing boundary is refused, so the gate cannot
/// be bypassed by an outcome alone.
struct HelperBoundaryPosture {
    outcome: WolfHelperBoundaryOutcome,
    status: OperationStatus,
    finding_count: usize,
}

impl HelperBoundaryPosture {
    /// True iff the boundary evidence itself is trustworthy: it passed its own
    /// KAIFUU-121 validation and raised no findings. Independent of the outcome.
    fn evidence_is_trustworthy(&self) -> bool {
        self.status == OperationStatus::Passed && self.finding_count == 0
    }
}

/// Decide whether the layered pipeline may run, or emit the unsupported-variant
/// diagnostic with the claimed-support tuple context.
fn classify_gate(
    engine_family: &str,
    protection_profile: WolfProtectionProfile,
    helper_posture: Option<&HelperBoundaryPosture>,
    detector_status: OperationStatus,
) -> Option<WolfAdapterCapabilityDiagnostic> {
    // The detector's own claimed-support tuple is the honest floor for an
    // unsupported variant: it is detector-only (never extract/patch).
    let claimed_support = derive_wolf_capability_tuple(protection_profile);

    if engine_family != WOLF_ENGINE_FAMILY {
        return Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::UnknownEngineVariant.as_str().to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "Wolf adapter requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
            claimed_support,
        });
    }
    if detector_status != OperationStatus::Passed {
        return Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::UnknownEngineVariant.as_str().to_string(),
            field: "detector".to_string(),
            message: "the container's protection detector evidence failed its own validation"
                .to_string(),
            claimed_support,
        });
    }

    match protection_profile {
        WolfProtectionProfile::Protected => match helper_posture {
            None => Some(WolfAdapterCapabilityDiagnostic {
                semantic_code: SemanticErrorCode::MissingKeyProfile.as_str().to_string(),
                field: "helperBoundary".to_string(),
                message: "a protected container needs a keyRef-bound helper-boundary profile; none supplied".to_string(),
                claimed_support,
            }),
            Some(posture) => classify_protected_helper_posture(posture, claimed_support),
        },
        WolfProtectionProfile::HelperRequired => {
            Some(WolfAdapterCapabilityDiagnostic {
                semantic_code: SemanticErrorCode::HelperRequired.as_str().to_string(),
                field: "protectionSignal".to_string(),
                message: "a Wolf \"Pro\" per-game dynamic-key container is not supported by this static-key adapter".to_string(),
                claimed_support,
            })
        }
        WolfProtectionProfile::Plain => Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::UnsupportedLayeredTransform.as_str().to_string(),
            field: "protectionSignal".to_string(),
            message: "a plain unencrypted container is out of scope for this encrypted text-table adapter".to_string(),
            claimed_support,
        }),
        WolfProtectionProfile::Unknown => {
            Some(WolfAdapterCapabilityDiagnostic {
                semantic_code: SemanticErrorCode::UnsupportedVariantEncrypted.as_str().to_string(),
                field: "protectionSignal".to_string(),
                message: "an unrecognized Wolf protection variant cannot be extracted or patched"
                    .to_string(),
                claimed_support,
            })
        }
    }
}

/// Classify a `protected` container's helper-boundary posture. The gate is
/// non-bypassable: BEFORE trusting the derived outcome, the boundary evidence
/// itself must be trustworthy (it PASSED its own KAIFUU-121 validation with no
/// findings). A `key_resolved` outcome carried by a failed/finding-bearing
/// boundary is refused with a key-validation diagnostic — it never reaches
/// extract/patch. Only a trustworthy `key_resolved` posture clears the gate.
fn classify_protected_helper_posture(
    posture: &HelperBoundaryPosture,
    claimed_support: WolfCapabilityTuple,
) -> Option<WolfAdapterCapabilityDiagnostic> {
    if !posture.evidence_is_trustworthy() {
        return Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::KeyValidationFailed.as_str().to_string(),
            field: "helperBoundary".to_string(),
            message: "the KAIFUU-121 helper-boundary evidence failed its own validation or raised blocking findings; extract/patch refused regardless of the reported outcome".to_string(),
            claimed_support,
        });
    }
    match posture.outcome {
        WolfHelperBoundaryOutcome::KeyResolved => None,
        WolfHelperBoundaryOutcome::KeyMissing => Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::MissingKeyMaterial.as_str().to_string(),
            field: "helperBoundary".to_string(),
            message: "the static container key is not present in the local key store; extract/patch refused".to_string(),
            claimed_support,
        }),
        WolfHelperBoundaryOutcome::HelperRequired
        | WolfHelperBoundaryOutcome::HelperUnavailable => Some(WolfAdapterCapabilityDiagnostic {
            semantic_code: SemanticErrorCode::HelperRequired.as_str().to_string(),
            field: "helperBoundary".to_string(),
            message: "the container key is behind an unrun dynamic-key helper; extract/patch refused".to_string(),
            claimed_support,
        }),
    }
}

fn build_unsupported_report(
    fixture: &WolfTextTableAdapterFixture,
    protection_profile: WolfProtectionProfile,
    helper_outcome: Option<WolfHelperBoundaryOutcome>,
    diagnostic: WolfAdapterCapabilityDiagnostic,
) -> WolfTextTableAdapterReport {
    let claimed_support = diagnostic.claimed_support.clone();
    WolfTextTableAdapterReport {
        schema_version: WOLF_ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: WOLF_ADAPTER_SUPPORT_BOUNDARY.to_string(),
        cited_smoke_capability_id: WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        outcome: WolfAdapterOutcome::Unsupported,
        protection_profile,
        helper_outcome,
        claimed_support,
        transform_legs: WolfAdapterTransformLegs::canonical(),
        secret_requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: None,
        key_bytes: None,
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        source_archive_hash: None,
        rebuilt_archive_hash: None,
        extract_manifest: Vec::new(),
        patch_reports: Vec::new(),
        unchanged_tables_verified: 0,
        verify_proof: None,
        capability_diagnostics: vec![diagnostic],
        delta_package_id: deterministic_id("kaifuu-wolf-adapter-delta", 12),
        status: OperationStatus::Passed,
    }
}

/// Drive the full extract → patch → repack → verify round-trip for a cleared gate.
fn run_supported(
    fixture: &WolfTextTableAdapterFixture,
    protection_profile: WolfProtectionProfile,
    helper_outcome: Option<WolfHelperBoundaryOutcome>,
    claimed_support: WolfCapabilityTuple,
) -> Result<WolfTextTableAdapterReport, WolfAdapterError> {
    // Resolve the container key BY REF (KAIFUU-073 crypto layer). The key never
    // leaves the resolver's zeroize-on-drop holder.
    let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
    let key = resolver.resolve(WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID, &fixture.secret_ref)?;
    let key_material_hash = key.material_hash()?;
    let key_bytes = u32::try_from(key.byte_len()).unwrap_or(u32::MAX);

    // Layer 1+2: build the synthetic encrypted source container (KAIFUU-073
    // container+crypto), packing each text table's binary layout as a member.
    let source_members = encode_tables_to_members(&fixture.tables)?;
    let source_archive = pack_encrypted_archive(&source_members, key)?;
    let source_archive_hash = proof_hash(&source_archive)?;

    // Layer 1+2 (inverse): decrypt + extract the members.
    let extracted = decrypt_archive_members(&source_archive, key)?;

    // Layer 3: decode each member's Shift-JIS text table + build the manifest.
    let mut extract_manifest = Vec::with_capacity(extracted.len());
    for member in &extracted {
        let table = decode_wolf_text_table(&member.plaintext)?;
        extract_manifest.push(WolfAdapterTableDigest {
            table_name: table.table_name.clone(),
            record_count: table.records.len() as u32,
            field_count: table.field_count,
            text_cell_count: table.cell_count() as u32,
            member_hash: proof_hash(&member.plaintext)?,
            member_byte_len: member.plaintext.len() as u64,
        });
    }

    // Layer 3+4: apply the configured patches, re-encode, and record per-table
    // deterministic patch reports.
    let (patched_members, patch_reports) = apply_patches(&extracted, &fixture.patches)?;

    // Layer 1+2 (repack): re-encrypt + repack through the same container layer.
    let rebuilt_archive = pack_encrypted_archive(&patched_members, key)?;
    let rebuilt_archive_hash = proof_hash(&rebuilt_archive)?;

    // Verify: re-decrypt + re-decode and confirm the patched text is present and
    // every unchanged table is byte-identical.
    let verified = decrypt_archive_members(&rebuilt_archive, key)?;
    let (patch_reports, unchanged_tables_verified) =
        verify_round_trip(&extracted, &verified, &fixture.patches, patch_reports)?;
    let verify_proof = build_verify_proof(&verified)?;

    let report = WolfTextTableAdapterReport {
        schema_version: WOLF_ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: WOLF_ADAPTER_SUPPORT_BOUNDARY.to_string(),
        cited_smoke_capability_id: WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        outcome: WolfAdapterOutcome::Supported,
        protection_profile,
        helper_outcome,
        claimed_support,
        transform_legs: WolfAdapterTransformLegs::canonical(),
        secret_requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: Some(key_material_hash),
        key_bytes: Some(key_bytes),
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        source_archive_hash: Some(source_archive_hash),
        rebuilt_archive_hash: Some(rebuilt_archive_hash),
        extract_manifest,
        patch_reports,
        unchanged_tables_verified,
        verify_proof: Some(verify_proof),
        capability_diagnostics: Vec::new(),
        delta_package_id: deterministic_id("kaifuu-wolf-adapter-delta", 12),
        status: OperationStatus::Passed,
    };

    // No-leak guard: the emitted report must never carry the raw key.
    let json = report
        .stable_json()
        .map_err(|error| WolfAdapterError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) {
        return Err(WolfAdapterError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }
    Ok(report)
}

fn encode_tables_to_members(
    tables: &[WolfTextTable],
) -> Result<Vec<WolfPlainMember>, WolfAdapterError> {
    tables
        .iter()
        .map(|table| {
            Ok(WolfPlainMember {
                member_id: table.member_id(),
                plaintext: encode_wolf_text_table(table)?,
            })
        })
        .collect()
}

/// Apply the configured patch requests to the extracted members, returning the
/// patched members and a per-table deterministic patch report (pre-verification).
fn apply_patches(
    extracted: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
) -> Result<(Vec<WolfPlainMember>, Vec<WolfAdapterTablePatchReport>), WolfAdapterError> {
    let mut patched_members = Vec::with_capacity(extracted.len());
    let mut reports: Vec<WolfAdapterTablePatchReport> = Vec::new();

    for member in extracted {
        let mut table = decode_wolf_text_table(&member.plaintext)?;
        let member_patches: Vec<&WolfTextPatchRequest> = patches
            .iter()
            .filter(|patch| table_member_id(&patch.table_name) == member.member_id)
            .collect();

        if member_patches.is_empty() {
            patched_members.push(member.clone());
            continue;
        }

        let mut coordinates = Vec::with_capacity(member_patches.len());
        for patch in &member_patches {
            let record = table
                .records
                .get_mut(patch.record_index as usize)
                .ok_or_else(|| WolfAdapterError::PatchTargetMissing {
                    detail: format!(
                        "record {} out of range for table {}",
                        patch.record_index, patch.table_name
                    ),
                })?;
            let cell = record.get_mut(patch.field_index as usize).ok_or_else(|| {
                WolfAdapterError::PatchTargetMissing {
                    detail: format!(
                        "field {} out of range for table {}",
                        patch.field_index, patch.table_name
                    ),
                }
            })?;
            cell.clone_from(&patch.new_text);
            coordinates.push(WolfAdapterPatchCoordinate {
                record_index: patch.record_index,
                field_index: patch.field_index,
            });
        }

        let patched_bytes = encode_wolf_text_table(&table)?;
        // `layout_changed` proves EXACTLY the offset-table rewrite it claims: the
        // (offset,len) string-table index differs after repack (a downstream
        // offset shifted or a cell length changed). A same-length patch that only
        // swaps blob bytes in place changes the member (hashes differ) but NOT the
        // layout — this stays honestly false for it.
        let layout_changed =
            read_offset_index(&member.plaintext)? != read_offset_index(&patched_bytes)?;
        reports.push(WolfAdapterTablePatchReport {
            table_name: table.table_name.clone(),
            coordinates,
            source_member_hash: proof_hash(&member.plaintext)?,
            patched_member_hash: proof_hash(&patched_bytes)?,
            source_member_byte_len: member.plaintext.len() as u64,
            patched_member_byte_len: patched_bytes.len() as u64,
            layout_changed,
            // Filled in during verification.
            patched_text_verified: false,
        });
        patched_members.push(WolfPlainMember {
            member_id: member.member_id.clone(),
            plaintext: patched_bytes,
        });
    }

    Ok((patched_members, reports))
}

/// Verify the rebuilt archive: patched cells decode to the requested text and
/// unchanged tables are byte-identical. Returns the finalized patch reports and
/// the count of unchanged tables verified.
fn verify_round_trip(
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

fn build_verify_proof(
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
fn table_member_id(table_name: &str) -> String {
    format!("Data/{table_name}.wolftable")
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfAdapterError> {
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

/// Assert the KAIFUU-073 substrate is present (a compile+link-time composition
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
mod tests {
    use super::*;

    fn fixture() -> WolfTextTableAdapterFixture {
        WolfTextTableAdapterFixture::synthetic()
    }

    // --- Codec round-trips, including multi-byte Shift-JIS. ------------------

    #[test]
    fn text_table_codec_round_trips_shift_jis() {
        let table = WolfTextTable {
            table_name: "CharacterDB".to_string(),
            field_count: 2,
            records: vec![
                vec!["hero".to_string(), "テスト".to_string()],
                vec!["mage".to_string(), "説明".to_string()],
            ],
        };
        let bytes = encode_wolf_text_table(&table).expect("encode");
        let decoded = decode_wolf_text_table(&bytes).expect("decode");
        assert_eq!(decoded, table);
    }

    #[test]
    fn text_table_bytes_are_shift_jis_not_utf8() {
        // A multi-byte Japanese cell must be stored as Shift-JIS, so the UTF-8
        // byte sequence must NOT appear verbatim in the encoded table.
        let table = WolfTextTable {
            table_name: "T".to_string(),
            field_count: 1,
            records: vec![vec!["テスト".to_string()]],
        };
        let bytes = encode_wolf_text_table(&table).expect("encode");
        let utf8 = "テスト".as_bytes();
        assert!(
            !bytes.windows(utf8.len()).any(|window| window == utf8),
            "UTF-8 bytes leaked into the Shift-JIS table"
        );
    }

    // --- THE crux: the extract → patch round-trip on the synthetic fixture. --

    #[test]
    fn adapter_extracts_and_patches_text_tables_round_trip() {
        let report = run_wolf_text_table_adapter(&fixture()).expect("adapter runs");
        assert_eq!(report.outcome, WolfAdapterOutcome::Supported);
        assert_eq!(report.status, OperationStatus::Passed);
        assert_eq!(report.protection_profile, WolfProtectionProfile::Protected);
        assert_eq!(
            report.helper_outcome,
            Some(WolfHelperBoundaryOutcome::KeyResolved)
        );

        // All three tables extracted.
        assert_eq!(report.extract_manifest.len(), 3);
        // Two tables patched (CharacterDB + SystemStrings); MenuStrings untouched.
        assert_eq!(report.patch_reports.len(), 2);
        for patch in &report.patch_reports {
            assert!(patch.patched_text_verified);
            // Every patch changed the member bytes (hashes differ).
            assert_ne!(
                patch.source_member_hash.as_str(),
                patch.patched_member_hash.as_str()
            );
        }

        // `layout_changed` proves EXACTLY the offset-table rewrite it claims —
        // not merely that bytes differ. The CharacterDB patch lengthens a cell, so
        // downstream offsets are rewritten (true). The SystemStrings patch is a
        // same-length swap ("=start" -> "=begin"): the member bytes differ but the
        // (offset,len) index is untouched, so it is honestly false.
        let character = report
            .patch_reports
            .iter()
            .find(|report| report.table_name == "CharacterDB")
            .expect("CharacterDB was patched");
        let system = report
            .patch_reports
            .iter()
            .find(|report| report.table_name == "SystemStrings")
            .expect("SystemStrings was patched");
        assert!(
            character.layout_changed,
            "a length-changing patch must rewrite the offset table"
        );
        assert_eq!(
            character
                .source_member_byte_len
                .cmp(&character.patched_member_byte_len),
            std::cmp::Ordering::Less,
            "the CharacterDB member grew (its cell got longer)"
        );
        assert!(
            !system.layout_changed,
            "a same-length patch must NOT be reported as an offset-table rewrite"
        );
        assert_eq!(
            system.source_member_byte_len, system.patched_member_byte_len,
            "the same-length patch keeps the member byte length"
        );
        assert_ne!(
            system.source_member_hash.as_str(),
            system.patched_member_hash.as_str(),
            "the same-length patch still changed the member bytes"
        );

        // One unchanged table (MenuStrings) is verified byte-identical.
        assert_eq!(report.unchanged_tables_verified, 1);
        assert_ne!(
            report.source_archive_hash.as_ref().unwrap().as_str(),
            report.rebuilt_archive_hash.as_ref().unwrap().as_str()
        );
        assert!(report.verify_proof.is_some());
    }

    // --- Unchanged tables stay byte-identical when only one is patched. -----

    #[test]
    fn unchanged_tables_are_byte_identical() {
        let mut fixture = fixture();
        // Patch only the first table.
        fixture
            .patches
            .retain(|patch| patch.table_name == "CharacterDB");
        let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs");
        assert_eq!(report.patch_reports.len(), 1);
        // The untouched SystemStrings + MenuStrings tables are verified
        // byte-identical after repack.
        assert_eq!(report.unchanged_tables_verified, 2);
    }

    // --- Engine-general: a different data-driven fixture round-trips too. ----

    #[test]
    fn adapter_is_engine_general_data_driven() {
        let mut fixture = fixture();
        // Swap in a completely different table set + patch (a different "game").
        fixture.tables = vec![WolfTextTable {
            table_name: "ItemDB".to_string(),
            field_count: 1,
            records: vec![vec!["potion=synthetic".to_string()]],
        }];
        fixture.patches = vec![WolfTextPatchRequest {
            table_name: "ItemDB".to_string(),
            record_index: 0,
            field_index: 0,
            new_text: "elixir=synthetic".to_string(),
        }];
        let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs");
        assert_eq!(report.outcome, WolfAdapterOutcome::Supported);
        assert_eq!(report.extract_manifest.len(), 1);
        assert_eq!(report.patch_reports.len(), 1);
        assert!(report.patch_reports[0].patched_text_verified);
    }

    // --- Keys stay ref-only + the report is redaction-clean. ----------------

    #[test]
    fn report_is_redaction_clean_and_keys_are_ref_only() {
        let report = run_wolf_text_table_adapter(&fixture()).expect("adapter runs");
        let json = report.stable_json().expect("stable json");
        // The reportable secret ref survives; the raw key does not.
        assert!(json.contains(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF));
        assert!(!json.contains("K073-WOLF-FIXTURE"));
        // No decoded table text (ASCII or Shift-JIS UTF-8) leaks.
        assert!(!json.contains("synthetic-menu=start"));
        assert!(!json.contains("テスト説明A"));
        assert!(!json.contains("テスト説明A-改"));
        // No private paths.
        assert!(!json.contains("/home/"));
        assert!(!json.contains("/scratch/"));
        // It cites the KAIFUU-073 smoke evidence.
        assert!(json.contains(WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID));
    }

    #[test]
    fn report_redacts_local_paths_in_ids() {
        let mut fixture = fixture();
        fixture.fixture_id = "/home/trevor/private/wolf/leak.wolf".to_string();
        let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs");
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
    }

    // --- Unsupported variant: missing key → semantic diagnostic + tuple. ----

    #[test]
    fn missing_key_is_unsupported_with_semantic_diagnostic() {
        let mut fixture = fixture();
        // Flip the helper boundary to key-unavailable and swap in a missing ref.
        let secret_ref =
            SecretRef::new(crate::wolf_encrypted_smoke::WOLF_ENCRYPTED_SMOKE_MISSING_SECRET_REF)
                .unwrap();
        fixture.secret_ref = secret_ref.clone();
        fixture.helper_boundary = Some(synthetic_helper_profile(&secret_ref, false));

        let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs (unsupported)");
        assert_eq!(report.outcome, WolfAdapterOutcome::Unsupported);
        assert!(report.extract_manifest.is_empty());
        assert!(report.patch_reports.is_empty());
        assert_eq!(report.capability_diagnostics.len(), 1);
        let diagnostic = &report.capability_diagnostics[0];
        assert_eq!(
            diagnostic.semantic_code,
            SemanticErrorCode::MissingKeyMaterial.as_str()
        );
        // The claimed-support tuple context is present + never claims extract/patch.
        assert!(diagnostic.claimed_support.extract.is_unsupported());
        assert!(diagnostic.claimed_support.patch.is_unsupported());
        // No key material hash is emitted for an unsupported variant.
        assert!(report.key_material_hash.is_none());
    }

    // --- The KAIFUU-121 gate is NON-BYPASSABLE: a failed helper posture is -----
    // --- refused even though its DERIVED outcome is key_resolved. -------------

    #[test]
    fn failed_helper_posture_is_unsupported_and_not_bypassable() {
        let mut fixture = fixture();
        // A helper-boundary profile whose derived outcome is `key_resolved`
        // (static-key import, key locally available) but which FAILS its own
        // KAIFUU-121 validation: the declared expectation lies about the outcome,
        // so the boundary raises a finding and reports status=Failed. A gate that
        // only read the outcome would wave this straight through to extract/patch.
        let mut profile = synthetic_helper_profile(&fixture.secret_ref, true);
        profile.expected_outcome = WolfHelperBoundaryOutcome::HelperUnavailable;
        fixture.helper_boundary = Some(profile.clone());

        // Bait check: the boundary itself STILL derives `key_resolved` (the value
        // a bypassable gate would have trusted) even though its status is Failed.
        let boundary = run_wolf_helper_boundary(&WolfHelperBoundaryFixture {
            schema_version: crate::wolf_helper_boundary::WOLF_HELPER_BOUNDARY_SCHEMA_VERSION
                .to_string(),
            boundary_set_id: "wolf-adapter/gate-test/helper-boundary".to_string(),
            source_node_id: fixture.source_node_id.clone(),
            engine_family: fixture.engine_family.clone(),
            profiles: vec![profile],
        });
        let entry = &boundary.entries[0];
        assert_eq!(entry.outcome, WolfHelperBoundaryOutcome::KeyResolved);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(!entry.findings.is_empty());

        // The honest gate refuses: Unsupported, no extract/patch, no key material.
        let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs (unsupported)");
        assert_eq!(report.outcome, WolfAdapterOutcome::Unsupported);
        assert!(report.extract_manifest.is_empty());
        assert!(report.patch_reports.is_empty());
        assert!(report.key_material_hash.is_none());
        assert!(report.source_archive_hash.is_none());
        // The report still records the derived outcome for provenance...
        assert_eq!(
            report.helper_outcome,
            Some(WolfHelperBoundaryOutcome::KeyResolved)
        );
        // ...proving the gate refused DESPITE a key_resolved outcome: the diagnostic
        // is a key-validation failure, and the tuple never claims extract/patch.
        assert_eq!(report.capability_diagnostics.len(), 1);
        let diagnostic = &report.capability_diagnostics[0];
        assert_eq!(
            diagnostic.semantic_code,
            SemanticErrorCode::KeyValidationFailed.as_str()
        );
        assert!(diagnostic.claimed_support.extract.is_unsupported());
        assert!(diagnostic.claimed_support.patch.is_unsupported());
    }

    // --- Unsupported variant: an unknown protection variant is refused. ------

    #[test]
    fn unknown_protection_variant_is_unsupported() {
        use crate::wolf_protection_detector::WolfArchiveProtectionSignal;
        let mut fixture = fixture();
        // Unrecognized protection → detector classifies Unknown.
        fixture.detector.protection_signal = WolfArchiveProtectionSignal::UnrecognizedProtection;
        fixture.detector.crypto = CryptoTransform::Unknown;
        fixture.detector.secret_requirements = vec![];
        fixture.detector.expected_profile = WolfProtectionProfile::Unknown;
        fixture.detector.expected_semantic_codes =
            vec![SemanticErrorCode::UnknownEngineVariant.as_str().to_string()];
        fixture.helper_boundary = None;

        let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs (unsupported)");
        assert_eq!(report.outcome, WolfAdapterOutcome::Unsupported);
        assert_eq!(report.protection_profile, WolfProtectionProfile::Unknown);
        assert_eq!(
            report.capability_diagnostics[0].semantic_code,
            SemanticErrorCode::UnsupportedVariantEncrypted.as_str()
        );
    }

    // --- A malformed patch coordinate is a typed error, not a panic. --------

    #[test]
    fn out_of_range_patch_is_typed_error() {
        let mut fixture = fixture();
        fixture.patches = vec![WolfTextPatchRequest {
            table_name: "CharacterDB".to_string(),
            record_index: 99,
            field_index: 0,
            new_text: "x".to_string(),
        }];
        let err = run_wolf_text_table_adapter(&fixture).expect_err("out-of-range patch fails");
        assert!(matches!(err, WolfAdapterError::PatchTargetMissing { .. }));
        assert!(err.to_string().starts_with(WOLF_ADAPTER_MARKER));
    }

    // --- The report round-trips through JSON. -------------------------------

    #[test]
    fn report_round_trips_through_json() {
        let report = run_wolf_text_table_adapter(&fixture()).expect("adapter runs");
        let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
        let round: WolfTextTableAdapterReport = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round, report.redacted_for_report());
    }

    // --- The fixture loads from disk + runs (the public path). ---------------

    #[test]
    fn fixture_loads_from_disk_and_round_trips() {
        let path = crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/wolf/adapter.text-table.json");
        let report = run_wolf_text_table_adapter_from_path(&path).expect("adapter runs from path");
        assert_eq!(report.outcome, WolfAdapterOutcome::Supported);
        assert_eq!(report.extract_manifest.len(), 3);
        // The disk fixture carries an UNCHANGED table (MenuStrings) with no patch
        // request, so the byte-identical property is genuinely exercised: exactly
        // one unchanged table is verified byte-identical after repack.
        assert_eq!(report.patch_reports.len(), 2);
        assert_eq!(report.unchanged_tables_verified, 1);
    }

    // --- The secret ref must be a local scheme (mirrors the substrate). ------

    #[test]
    fn synthetic_fixture_uses_a_local_secret_ref() {
        assert_eq!(
            fixture().secret_ref.scheme(),
            crate::SecretRefScheme::LocalSecret
        );
    }
}
