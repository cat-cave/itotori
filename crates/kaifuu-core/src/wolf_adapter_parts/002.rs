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


