use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfile {
    pub adapter_id: String,
    pub engine_family: String,
    pub engine_version: Option<String>,
    pub detected_variant: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFingerprint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_root_hash: Option<ProofHash>,
    pub engine_evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<KeyValidationProof>,
}

impl KeyRequirement {
    pub fn sort_key(&self) -> (String, String) {
        (
            self.requirement_id.clone(),
            self.secret_ref.as_str().to_string(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyMaterialKind {
    FixedBytes,
    HexBytes,
    Utf8String,
    ArchivePassword,
    RpgMakerAssetKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValidationProof {
    pub method: KeyValidationMethod,
    pub proof_hash: ProofHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyValidationMethod {
    DecryptHeaderProof,
    ArchiveIndexProof,
    KnownPlaintextProof,
    FixtureRoundTripProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretRefScheme {
    LocalSecret,
    OsKeychain,
    SecretManager,
    Prompt,
}

impl SecretRefScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalSecret => "local-secret",
            Self::OsKeychain => "os-keychain",
            Self::SecretManager => "secret-manager",
            Self::Prompt => "prompt",
        }
    }
}

impl fmt::Display for SecretRefScheme {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyResolutionStatus {
    Resolved,
    Missing,
    HelperRequired,
    ExternalStoreUnavailable,
    PromptCancelled,
    OutOfPolicy,
    Malformed,
    ValidationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedKeyProofRecord {
    pub requirement_id: String,
    pub secret_ref_scheme: SecretRefScheme,
    pub material_kind: KeyMaterialKind,
    pub byte_length: usize,
    pub readiness_status: KeyResolutionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_method: Option<KeyValidationMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_tool_version: Option<String>,
}

impl ResolvedKeyProofRecord {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref_scheme: self.secret_ref_scheme,
            material_kind: self.material_kind,
            byte_length: self.byte_length,
            readiness_status: self.readiness_status,
            validation_method: self.validation_method,
            proof_hash: self.proof_hash.clone(),
            helper_tool_version: self
                .helper_tool_version
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }
}

pub struct ResolvedKeyMaterial {
    bytes: Zeroizing<Vec<u8>>,
}

impl ResolvedKeyMaterial {
    pub(crate) fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes: Zeroizing::new(bytes),
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

impl fmt::Debug for ResolvedKeyMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedKeyMaterial")
            .field(
                "bytes",
                &format_args!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            )
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

#[derive(Default)]
pub struct ResolvedKeySet {
    pub(crate) materials: BTreeMap<String, ResolvedKeyMaterial>,
    pub(crate) proof_records: Vec<ResolvedKeyProofRecord>,
}

impl ResolvedKeySet {
    pub fn get(&self, requirement_id: &str) -> Option<&ResolvedKeyMaterial> {
        self.materials.get(requirement_id)
    }

    pub fn get_bytes(&self, requirement_id: &str) -> Option<&[u8]> {
        self.get(requirement_id).map(ResolvedKeyMaterial::as_bytes)
    }

    pub fn proof_records(&self) -> &[ResolvedKeyProofRecord] {
        &self.proof_records
    }

    pub fn redacted_proof_records(&self) -> Vec<ResolvedKeyProofRecord> {
        self.proof_records
            .iter()
            .map(ResolvedKeyProofRecord::redacted_for_report)
            .collect()
    }
}

impl fmt::Debug for ResolvedKeySet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedKeySet")
            .field(
                "requirement_ids",
                &self.materials.keys().collect::<Vec<_>>(),
            )
            .field("proof_records", &self.redacted_proof_records())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParameter {
    pub parameter_id: String,
    pub name: String,
    pub kind: ArchiveParameterKind,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ArchiveParameterSource>,
}

impl ArchiveParameter {
    pub fn sort_key(&self) -> (String, String) {
        (self.parameter_id.clone(), self.name.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveParameterKind {
    ArchiveFormat,
    Compression,
    CipherScheme,
    Encoding,
    Variant,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveParameterSource {
    AdapterDefault,
    Detected,
    Manual,
    HelperEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperEvidence {
    pub helper_kind: HelperKind,
    pub tool_version: String,
    pub redacted_log_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proof_hashes: Vec<KeyValidationProof>,
}

impl HelperEvidence {
    pub fn normalize(&mut self) {
        self.proof_hashes.sort_by_key(|proof| {
            (
                serde_json::to_string(&proof.method).unwrap_or_default(),
                proof.proof_hash.as_str().to_string(),
            )
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperKind {
    StaticParser,
    KnownKeyDatabaseImport,
    WineLocalWindowsHelper,
    RemoteWindowsHelper,
    ManualKeyEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperResult {
    pub schema_version: String,
    pub fixture_id: String,
    pub helper_result_id: String,
    pub profile_id: String,
    pub helper: HelperProvenance,
    pub capability_level: HelperCapabilityLevel,
    pub execution: HelperExecutionSummary,
    pub diagnostic: HelperDiagnostic,
    pub redaction: HelperRedaction,
    #[serde(default)]
    pub secret_refs: Vec<HelperResultSecretRef>,
    #[serde(default)]
    pub proof_hashes: Vec<KeyValidationProof>,
}

impl HelperResult {
    pub fn normalize(&mut self) {
        self.secret_refs.sort_by_key(|secret| {
            (
                secret.requirement_id.clone(),
                secret.secret_ref.as_str().to_string(),
            )
        });
        self.proof_hashes.sort_by_key(|proof| {
            (
                serde_json::to_string(&proof.method).unwrap_or_default(),
                proof.proof_hash.as_str().to_string(),
            )
        });
    }

    pub fn validate(&self) -> HelperResultValidationResult {
        match serde_json::to_value(self) {
            Ok(value) => validate_helper_result_value(&value),
            Err(_) => HelperResultValidationResult {
                schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
                fixture_id: Some(redact_for_log_or_report(&self.fixture_id)),
                status: OperationStatus::Failed,
                failures: vec![HelperResultValidationFailure {
                    fixture_id: Some(redact_for_log_or_report(&self.fixture_id)),
                    code: "helper_result_serialization_failed".to_string(),
                    field: "$".to_string(),
                    message: "helper result could not be serialized for validation".to_string(),
                }],
            },
        }
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.fixture_id = redact_for_log_or_report(&result.fixture_id);
        result.helper_result_id = redact_for_log_or_report(&result.helper_result_id);
        result.profile_id = redact_for_log_or_report(&result.profile_id);
        result.helper = result.helper.redacted_for_report();
        result.execution = result.execution.redacted_for_report();
        result.diagnostic = result.diagnostic.redacted_for_report();
        result.redaction = result.redaction.redacted_for_report();
        result.secret_refs = result
            .secret_refs
            .iter()
            .map(HelperResultSecretRef::redacted_for_report)
            .collect();
        result
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut result = self.redacted_for_report();
        result.normalize();
        stable_json(&result)
    }
}
