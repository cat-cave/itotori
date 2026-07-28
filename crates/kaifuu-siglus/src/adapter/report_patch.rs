use super::*;

// Report

/// The adapter capability descriptor: the mechanical facts, including
/// `does_key_discovery = false` and `broad_siglus_support = false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusAdapterCapability {
    pub capability_id: String,
    pub engine_family: String,
    /// Always `false`: never shells out.
    pub shells_out: bool,
    /// Always `false`: the adapter consumes a resolved key, never discovers one.
    pub does_key_discovery: bool,
    /// Always `true`: consumes a re-validated resolved key.
    pub consumes_resolved_key: bool,
    /// Always `false`: honest scope — narrow profiled support, not broad Siglus.
    pub broad_siglus_support: bool,
    pub encoding: SiglusKnownKeyEncoding,
    pub compression: SiglusKnownKeyCompression,
    pub redaction_status: HelperRedactionStatus,
    pub support_boundary: String,
}

impl SiglusAdapterCapability {
    fn for_variant(variant: &SiglusSupportedVariant) -> Self {
        Self {
            capability_id: ADAPTER_CAPABILITY_ID.to_string(),
            engine_family: "siglus".to_string(),
            shells_out: false,
            does_key_discovery: false,
            consumes_resolved_key: true,
            broad_siglus_support: false,
            encoding: variant.encoding,
            compression: variant.compression,
            redaction_status: HelperRedactionStatus::Redacted,
            support_boundary: ADAPTER_SUPPORT_BOUNDARY.to_string(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            capability_id: redact_for_log_or_report(&self.capability_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            shells_out: self.shells_out,
            does_key_discovery: self.does_key_discovery,
            consumes_resolved_key: self.consumes_resolved_key,
            broad_siglus_support: self.broad_siglus_support,
            encoding: self.encoding,
            compression: self.compression,
            redaction_status: self.redaction_status,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
        }
    }
}

/// The translated round-trip section of the report (counts + hashes, no text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedRoundTripReport {
    pub in_scope_changes: Vec<InScopeChange>,
    pub out_of_scope_byte_identical: bool,
    pub out_of_scope_record_count: u64,
    pub patched_container_hash: ProofHash,
    pub verified: bool,
}

/// The reject-on-secret section of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectOnSecretReport {
    /// Always `true`: the output + report were deep-scanned before write.
    pub deep_scan_performed: bool,
    /// Number of secret-leak findings (a persisted artifact always carries `0`;
    /// any finding refuses the write before anything is persisted).
    pub finding_count: u64,
    /// The number of plaintext probes checked against the output.
    pub plaintext_probes_checked: u64,
}

/// The redacted adapter patch report (committed as proof). Never carries raw key
/// material or decrypted text — only secret-refs, one-way hashes, and counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterPatchReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub variant_id: String,
    /// The container kind that was patched (`scene` / `gameexe`).
    pub container_kind: String,
    pub secret_ref: SecretRef,
    /// The consumed validation proof (re-checked before use).
    pub key_validation: KeyValidationProof,
    /// One-way commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    pub key_material_kind: KeyMaterialKind,
    pub redaction_status: HelperRedactionStatus,
    pub capability: SiglusAdapterCapability,
    pub identity: IdentityRoundTrip,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_extraction: Option<SceneExtractionReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gameexe_extraction: Option<GameexeExtractionReport>,
    pub translation: TranslatedRoundTripReport,
    pub reject_on_secret: RejectOnSecretReport,
    pub status: OperationStatus,
}

impl AdapterPatchReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            variant_id: redact_for_log_or_report(&self.variant_id),
            container_kind: self.container_kind.clone(),
            secret_ref: self.secret_ref.clone(),
            key_validation: self.key_validation.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            capability: self.capability.redacted_for_report(),
            identity: self.identity.clone(),
            scene_extraction: self.scene_extraction.clone(),
            gameexe_extraction: self.gameexe_extraction.clone(),
            translation: self.translation.clone(),
            reject_on_secret: self.reject_on_secret.clone(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no text).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// FS-owning patch-back driver (reject-before-write)

/// Which profiled container a patch targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusContainerKind {
    Scene,
    Gameexe,
}

impl SiglusContainerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Gameexe => "gameexe",
        }
    }
}

/// Filesystem-owning patch-back: read the profiled container at `input_path`,
/// apply the translated edits, VERIFY the round-trip, deep-scan for secret
/// leaks, and only then atomically write the patched container to `output_path`
/// (and the redacted report to `report_path`, if given).
/// Reject-before-write ordering (nothing is written until all pass):
/// 1. capability gate (unsupported variant → `Err`, no write),
/// 2. read input,
/// 3. identity round-trip + translated round-trip + verify (in-profile failure →
///    `Err`, no write),
/// 4. reject-on-secret deep scan (leak → `Err`, no write),
/// 5. atomic write of output + report.
pub fn patch_container_file(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    kind: SiglusContainerKind,
    input_path: &Path,
    output_path: &Path,
    report_path: Option<&Path>,
    edits: &[SiglusTranslatedEdit],
) -> Result<AdapterPatchReport, AdapterError> {
    // (1) Capability gate BEFORE touching the filesystem.
    variant.ensure_supported()?;

    // (2) Read input.
    let container = std::fs::read(input_path).map_err(|error| AdapterError::Io {
        detail: format!("reading input container: {error}"),
    })?;

    // (3) Identity + translated round-trips + verify (in-memory).
    let (identity, translation, scene_report, gameexe_report, plaintext_probes) = match kind {
        SiglusContainerKind::Scene => {
            let identity = roundtrip_identity_scene(variant, key, &container)?;
            let extraction = extract_scene(variant, key, &container)?;
            let translation = apply_scene_translation(variant, key, &container, edits)?;
            let probes = scene_plaintext_probes(&extraction, edits);
            let report = scene_extraction_report(&extraction)?;
            (identity, translation, Some(report), None, probes)
        }
        SiglusContainerKind::Gameexe => {
            let identity = roundtrip_identity_gameexe(variant, key, &container)?;
            let extraction = extract_gameexe(variant, key, &container)?;
            let translation = apply_gameexe_translation(variant, key, &container, edits)?;
            let probes = gameexe_plaintext_probes(&extraction, edits);
            let report = gameexe_extraction_report(&extraction)?;
            (identity, translation, None, Some(report), probes)
        }
    };

    if !identity.byte_identical {
        return Err(AdapterError::VerifyFailed {
            detail: "identity round-trip was not byte-identical".to_string(),
        });
    }
    if !translation.verified() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip did not verify (in-scope change or out-of-scope preservation failed)"
                .to_string(),
        });
    }

    // Build the redacted report body.
    let mut report = AdapterPatchReport {
        schema_version: ADAPTER_SCHEMA_VERSION.to_string(),
        capability_id: ADAPTER_CAPABILITY_ID.to_string(),
        source_node_id: ADAPTER_SOURCE_NODE_ID.to_string(),
        engine_family: "siglus".to_string(),
        support_boundary: ADAPTER_SUPPORT_BOUNDARY.to_string(),
        variant_id: variant.variant_id.clone(),
        container_kind: kind.as_str().to_string(),
        secret_ref: key.secret_ref().clone(),
        key_validation: key.validation().clone(),
        key_material_hash: key
            .material_hash()
            .map_err(|error| AdapterError::Internal {
                message: format!("key commitment: {error}"),
            })?,
        key_bytes: u32::try_from(key.key_byte_len()).unwrap_or(u32::MAX),
        key_material_kind: key.material_kind,
        redaction_status: HelperRedactionStatus::Redacted,
        capability: SiglusAdapterCapability::for_variant(variant),
        identity,
        scene_extraction: scene_report,
        gameexe_extraction: gameexe_report,
        translation: TranslatedRoundTripReport {
            in_scope_changes: translation.in_scope_changes.clone(),
            out_of_scope_byte_identical: translation.out_of_scope_byte_identical,
            out_of_scope_record_count: translation.out_of_scope_record_count,
            patched_container_hash: translation.patched_hash.clone(),
            verified: translation.verified(),
        },
        reject_on_secret: RejectOnSecretReport {
            deep_scan_performed: true,
            finding_count: 0,
            plaintext_probes_checked: plaintext_probes.len() as u64,
        },
        status: OperationStatus::Passed,
    };

    // (4) Reject-on-secret deep scan of the ABOUT-TO-BE-WRITTEN artifacts.
    let report_json = report
        .stable_json()
        .map_err(|error| AdapterError::Internal {
            message: format!("report serialization: {error}"),
        })?;
    let findings = scan_for_secret_leak(
        key,
        &translation.patched_bytes,
        &report_json,
        &plaintext_probes,
    );
    if !findings.is_empty() {
        return Err(AdapterError::SecretLeak {
            finding_count: findings.len() as u64,
            first_finding: format!("{}:{}", findings[0].location, findings[0].kind),
        });
    }

    // (5) Atomic writes — output first, then the redacted report.
    atomic_write_bytes(output_path, &translation.patched_bytes).map_err(|error| {
        AdapterError::Io {
            detail: format!("writing patched output: {error}"),
        }
    })?;
    if let Some(report_path) = report_path {
        // Re-serialize post-scan (identical content) and write.
        atomic_write_text(report_path, &report_json).map_err(|error| AdapterError::Io {
            detail: format!("writing report: {error}"),
        })?;
    }

    report.reject_on_secret.finding_count = 0;
    Ok(report)
}

// Profiled fixture builders (encode with a resolved key — no retail bytes)

/// Build a profiled `Scene` container by masking each unit's UTF-16LE text with
/// the resolved key. Fixture support: the bytes it produces round-trip through
/// the adapter's own reader (proving the codec is symmetric); no retail bytes.
pub fn build_profiled_scene_container(
    key: &ResolvedSiglusKey,
    scene_id: u32,
    units: &[(u32, &str)],
) -> Vec<u8> {
    let records = units
        .iter()
        .map(|(unit_index, text)| (*unit_index, key.material().xor_cycle(&utf16le_encode(text))))
        .collect();
    reemit_scene_records(&SceneRecordLayout {
        scene_id,
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}

/// Build a profiled `Gameexe` container by masking each key/value with the
/// resolved key.
pub fn build_profiled_gameexe_container(
    key: &ResolvedSiglusKey,
    entries: &[(&str, &str)],
) -> Vec<u8> {
    let records = entries
        .iter()
        .map(|(config_key, value)| {
            (
                key.material().xor_cycle(&utf16le_encode(config_key)),
                key.material().xor_cycle(&utf16le_encode(value)),
            )
        })
        .collect();
    reemit_gameexe_records(&GameexeRecordLayout {
        compression: SiglusKnownKeyCompression::Uncompressed,
        records,
    })
}
