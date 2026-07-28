//! Wolf binary text-table codec and typed format errors.

use super::*;

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
