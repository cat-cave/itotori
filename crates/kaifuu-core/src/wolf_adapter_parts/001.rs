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
            source_node_id: "synthetic-fixture".to_string(),
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

