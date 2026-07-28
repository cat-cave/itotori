/// Prove every out-of-scope `Scene` record is byte-identical and only edited
/// records changed. A structural drift (reorder / count / header change) is an
/// in-profile bug → [`AdapterError::VerifyFailed`].
fn out_of_scope_scene_preserved(
    original: &crate::known_key_smoke::SceneRecordLayout,
    patched: &crate::known_key_smoke::SceneRecordLayout,
    edited_indices: &BTreeSet<u32>,
) -> Result<bool, AdapterError> {
    if original.scene_id != patched.scene_id || original.compression != patched.compression {
        return Err(AdapterError::VerifyFailed {
            detail: "scene header changed across patch".to_string(),
        });
    }
    if original.records.len() != patched.records.len() {
        return Err(AdapterError::VerifyFailed {
            detail: "scene record count changed across patch".to_string(),
        });
    }
    for ((original_index, original_bytes), (patched_index, patched_bytes)) in
        original.records.iter().zip(patched.records.iter())
    {
        if original_index != patched_index {
            return Err(AdapterError::VerifyFailed {
                detail: "scene records reordered across patch".to_string(),
            });
        }
        let edited = edited_indices.contains(original_index);
        if edited {
            if original_bytes == patched_bytes {
                return Err(AdapterError::VerifyFailed {
                    detail: format!("edited unit {original_index} did not change bytes"),
                });
            }
        } else if original_bytes != patched_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

// Pure Gameexe operations

/// Extract a profiled `Gameexe` container with the consumed resolved key.
pub fn extract_gameexe(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<SiglusGameexeExtraction, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    extract_gameexe_with(&profile, container, key.material())
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))
}

/// Identity round-trip for a `Gameexe` container (byte-identical re-emit).
pub fn roundtrip_identity_gameexe(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
) -> Result<IdentityRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    let profile = variant.internal_profile(key);
    let layout = read_gameexe_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let reemitted = reemit_gameexe_records(&layout);
    identity_result(container, &reemitted)
}

/// Apply translated edits to a `Gameexe` container and prove the round-trip:
/// each edited value decodes to the new text and every other entry survives
/// byte-identical.
pub fn apply_gameexe_translation(
    variant: &SiglusSupportedVariant,
    key: &ResolvedSiglusKey,
    container: &[u8],
    edits: &[SiglusTranslatedEdit],
) -> Result<TranslatedRoundTrip, AdapterError> {
    variant.ensure_supported()?;
    if edits.is_empty() {
        return Err(AdapterError::VerifyFailed {
            detail: "translated round-trip requires at least one edit".to_string(),
        });
    }
    let profile = variant.internal_profile(key);
    let material = key.material();

    let original = read_gameexe_record_layout(&profile, container)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;

    let mut current = container.to_vec();
    let mut edited_keys: BTreeSet<String> = BTreeSet::new();
    let mut in_scope_changes = Vec::with_capacity(edits.len());
    for edit in edits {
        edited_keys.insert(edit.target_key.clone());
        current = patch_gameexe_value_with(
            &profile,
            &current,
            &edit.target_key,
            &edit.translated_text,
            material,
        )
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
        in_scope_changes.push(InScopeChange {
            target_key: edit.target_key.clone(),
            changed: false,
            translated_text_hash: hash_text(&edit.translated_text)?,
        });
    }

    // In-scope verify.
    let original_text = extract_gameexe_with(&profile, container, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    let patched_text = extract_gameexe_with(&profile, &current, material)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    for (edit, change) in edits.iter().zip(in_scope_changes.iter_mut()) {
        let before = original_text
            .entries
            .iter()
            .find(|entry| entry.key == edit.target_key);
        let after = patched_text
            .entries
            .iter()
            .find(|entry| entry.key == edit.target_key);
        change.changed = matches!((before, after), (Some(before), Some(after))
            if after.value == edit.translated_text && before.value != edit.translated_text);
        if !change.changed {
            return Err(AdapterError::VerifyFailed {
                detail: format!("gameexe edit {} did not apply in scope", edit.target_key),
            });
        }
    }

    // Out-of-scope byte-identity: match entries by decoded key.
    let patched_layout = read_gameexe_record_layout(&profile, &current)
        .map_err(|error| AdapterError::from_scene(&variant.variant_id, error))?;
    if original.records.len() != patched_layout.records.len() {
        return Err(AdapterError::VerifyFailed {
            detail: "gameexe entry count changed across patch".to_string(),
        });
    }
    let mut out_of_scope_byte_identical = true;
    let mut out_of_scope_record_count = 0u64;
    for ((original_key_bytes, original_value_bytes), (patched_key_bytes, patched_value_bytes)) in
        original.records.iter().zip(patched_layout.records.iter())
    {
        if original_key_bytes != patched_key_bytes {
            return Err(AdapterError::VerifyFailed {
                detail: "gameexe entry key bytes changed across patch".to_string(),
            });
        }
        let decoded_key = original_text
            .entries
            .iter()
            .find(|entry| material.xor_cycle(original_key_bytes) == utf16le_encode(&entry.key))
            .map(|entry| entry.key.clone());
        let edited = decoded_key
            .as_deref()
            .is_some_and(|key| edited_keys.contains(key));
        if edited {
            if original_value_bytes == patched_value_bytes {
                return Err(AdapterError::VerifyFailed {
                    detail: "edited gameexe value did not change bytes".to_string(),
                });
            }
        } else {
            out_of_scope_record_count += 1;
            if original_value_bytes != patched_value_bytes {
                out_of_scope_byte_identical = false;
            }
        }
    }

    Ok(TranslatedRoundTrip {
        patched_hash: hash_bytes(&current)?,
        patched_bytes: current,
        in_scope_changes,
        out_of_scope_byte_identical,
        out_of_scope_record_count,
    })
}

// Reject-on-secret deep scan

/// A reject-on-secret finding (field/where only — never the leaked value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretLeakFinding {
    /// Where the leak was found (`output-bytes` / `report:<path>`).
    pub location: String,
    /// The class of leak (`raw-key` / `decrypted-text`).
    pub kind: String,
}

/// Deep-scan an about-to-be-written output container + its redacted report for
/// secret-shaped material: the raw key bytes, or any decrypted plaintext, must
/// NOT appear in either artifact. Returns findings (locations/kinds only). A
/// non-empty result means the write must be refused.
/// The plaintext probes are the in-memory decoded texts (original + translated);
/// they are NEVER persisted — only used here to prove they did not leak into the
/// output bytes (which hold only XOR-masked text) or the report (which holds only
/// hashes).
pub fn scan_for_secret_leak(
    key: &ResolvedSiglusKey,
    output_bytes: &[u8],
    report_json: &str,
    plaintext_probes: &[String],
) -> Vec<SecretLeakFinding> {
    let mut findings = Vec::new();

    // (1) Raw key must not appear in the output bytes.
    if key.material().appears_in(output_bytes) {
        findings.push(SecretLeakFinding {
            location: "output-bytes".to_string(),
            kind: "raw-key".to_string(),
        });
    }
    // (2) Raw key must not appear in the report bytes.
    if key.material().appears_in(report_json.as_bytes()) {
        findings.push(SecretLeakFinding {
            location: "report".to_string(),
            kind: "raw-key".to_string(),
        });
    }
    // (3) Decrypted plaintext must not appear (UTF-8 or UTF-16LE) in the output.
    for probe in plaintext_probes {
        if probe.is_empty() {
            continue;
        }
        let utf8 = probe.as_bytes();
        let utf16 = utf16le_encode(probe);
        if contains_window(output_bytes, utf8) || contains_window(output_bytes, &utf16) {
            findings.push(SecretLeakFinding {
                location: "output-bytes".to_string(),
                kind: "decrypted-text".to_string(),
            });
        }
        // The report is redacted and text-free; a raw probe string appearing in
        // it would be a redaction regression.
        if report_json.contains(probe.as_str()) {
            findings.push(SecretLeakFinding {
                location: "report".to_string(),
                kind: "decrypted-text".to_string(),
            });
        }
    }
    findings
}

fn contains_window(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

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


