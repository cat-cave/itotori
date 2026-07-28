#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub path: MvMzAssetReplacementPath,
    pub status: OperationStatus,
    pub entries: Vec<MvMzAssetReplacementEntryReport>,
}

impl MvMzAssetReplacementReport {
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzAssetReplacementEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            path_id: redact_for_log_or_report(&self.path_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            path: self.path.clone(),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(MvMzAssetReplacementEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub path_id: String,
    pub surface_id: String,
    pub media_kind: ReplacementMediaKind,
    pub scenario: MvMzAssetReplacementScenario,
    pub outcome: MvMzAssetReplacementOutcome,
    /// `true` only when a patch was produced AND every verify check passed.
    pub replaced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<MvMzReplacementProof>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<MvMzAssetReplacementFinding>,
}

impl MvMzAssetReplacementEntryReport {
    /// The verified replacement patch proof a caller may consume **iff** the
    /// entry passed and replaced. Anything else returns `None`.
    pub fn consumable_proof(&self) -> Option<&MvMzReplacementProof> {
        if self.replaced && self.status == OperationStatus::Passed {
            self.proof.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            path_id: redact_for_log_or_report(&self.path_id),
            surface_id: redact_for_log_or_report(&self.surface_id),
            media_kind: self.media_kind,
            scenario: self.scenario,
            outcome: self.outcome,
            replaced: self.replaced,
            proof: self
                .proof
                .as_ref()
                .map(MvMzReplacementProof::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(MvMzAssetReplacementFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The verified replacement proof. Carries hashes / counts / a secret-ref +
/// commitments only — never the key bytes, never the media bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzReplacementProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub surface_id: String,
    pub media_kind: ReplacementMediaKind,
    /// sha256 of the original (pre-replacement) encrypted asset.
    pub original_encrypted_hash: ProofHash,
    /// sha256 of the intended replacement plaintext (== declared commitment).
    pub replacement_plaintext_hash: ProofHash,
    /// sha256 of the produced patched encrypted asset.
    pub patched_encrypted_hash: ProofHash,
    /// sha256 of decrypt(patched); byte-correct iff it equals the replacement.
    pub decrypted_patched_hash: ProofHash,
    /// `true` iff `decrypt(patched) == replacement`.
    pub decrypt_matches_replacement: bool,
    /// `true` iff the first 16 bytes are exactly the RPGMV header.
    pub header_correct: bool,
    /// `true` iff the non-replaced tail (beyond the XOR prefix) is exact.
    pub tail_bytes_correct: bool,
    /// `true` iff the patched asset differs from the original (a real change).
    pub differs_from_original: bool,
    /// `true` iff decrypt(patched) matches the manifest's declared commitment.
    pub matches_declared_commitment: bool,
    /// `true` iff the resolved key sha256 matched the declared key commitment.
    pub key_commitment_matches: bool,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    pub validation: KeyValidationProof,
    pub redaction_status: crate::HelperRedactionStatus,
}

impl MvMzReplacementProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            surface_id: redact_for_log_or_report(&self.surface_id),
            media_kind: self.media_kind,
            original_encrypted_hash: self.original_encrypted_hash.clone(),
            replacement_plaintext_hash: self.replacement_plaintext_hash.clone(),
            patched_encrypted_hash: self.patched_encrypted_hash.clone(),
            decrypted_patched_hash: self.decrypted_patched_hash.clone(),
            decrypt_matches_replacement: self.decrypt_matches_replacement,
            header_correct: self.header_correct,
            tail_bytes_correct: self.tail_bytes_correct,
            differs_from_original: self.differs_from_original,
            matches_declared_commitment: self.matches_declared_commitment,
            key_commitment_matches: self.key_commitment_matches,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl MvMzAssetReplacementFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
        }
    }
}



pub use run::{MvMzAssetReplacementRequest, run_mv_mz_asset_replacement};
