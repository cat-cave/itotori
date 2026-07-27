use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperProvenance {
    pub helper_id: String,
    pub helper_version: String,
    pub helper_kind: HelperKind,
}

impl HelperProvenance {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            helper_id: redact_for_log_or_report(&self.helper_id),
            helper_version: redact_for_log_or_report(&self.helper_version),
            helper_kind: self.helper_kind,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperCapabilityLevel {
    StaticAnalysis,
    LocalKeyImport,
    ManualEntry,
    WineLocal,
    WindowsLocal,
    RemoteWindows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperResultExecutionMode {
    NotExecuted,
    InProcess,
    PlatformHelper,
    RemoteHelper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperExecutionFilesystemAccess {
    None,
    TempOnly,
    ReadOnlyWorkspace,
    LocalGameReadOnly,
    HostInherited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperExecutionSummary {
    pub mode: HelperResultExecutionMode,
    pub platform: String,
    pub bounded: bool,
    pub timeout_ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    pub network_access: bool,
    pub filesystem_access: HelperExecutionFilesystemAccess,
}

impl HelperExecutionSummary {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            mode: self.mode,
            platform: redact_for_log_or_report(&self.platform),
            bounded: self.bounded,
            timeout_ms: self.timeout_ms,
            duration_ms: self.duration_ms,
            network_access: self.network_access,
            filesystem_access: self.filesystem_access,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperDiagnostic {
    pub code: HelperDiagnosticCode,
    pub message: String,
}

impl HelperDiagnostic {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperDiagnosticCode {
    Success,
    MissingKey,
    WrongKey,
    HelperRequired,
    HelperUnavailable,
    HelperAuthorizationDenied,
    HelperTimeout,
    ValidationFailed,
    UnsupportedProtectedExecutable,
    RedactionFailure,
}

impl HelperDiagnosticCode {
    pub fn semantic_code(self) -> &'static str {
        match self {
            Self::Success => "kaifuu.helper_result.success",
            Self::MissingKey => SEMANTIC_MISSING_KEY_MATERIAL,
            Self::WrongKey | Self::ValidationFailed => SEMANTIC_KEY_VALIDATION_FAILED,
            Self::HelperRequired => SEMANTIC_HELPER_REQUIRED,
            Self::HelperUnavailable => SEMANTIC_HELPER_UNAVAILABLE,
            Self::HelperAuthorizationDenied => SEMANTIC_HELPER_AUTHORIZATION_DENIED,
            Self::HelperTimeout => SEMANTIC_HELPER_TIMEOUT,
            Self::UnsupportedProtectedExecutable => SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            Self::RedactionFailure => SEMANTIC_HELPER_REDACTION_FAILURE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperRedaction {
    pub status: HelperRedactionStatus,
    pub redacted_log_hash: ProofHash,
}

impl HelperRedaction {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status,
            redacted_log_hash: self.redacted_log_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperRedactionStatus {
    NotRequired,
    Redacted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperResultSecretRef {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub material_kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<KeyValidationProof>,
}

impl HelperResultSecretRef {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            material_kind: self.material_kind,
            bytes: self.bytes,
            validation: self.validation.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalKeyImportSource {
    ManualKeyEntry,
    KnownKeyDatabaseImport,
}

#[derive(Clone, PartialEq, Eq)]
pub struct LocalKeyImportRequest {
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    pub source_hash: ProofHash,
    pub redaction_status: HelperRedactionStatus,
    pub source: LocalKeyImportSource,
    pub material: Vec<u8>,
}

impl fmt::Debug for LocalKeyImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalKeyImportRequest")
            .field("secret_ref", &self.secret_ref)
            .field("key_purpose", &self.key_purpose)
            .field("engine_profile_id", &self.engine_profile_id)
            .field("source_hash", &self.source_hash)
            .field("redaction_status", &self.redaction_status)
            .field("source", &self.source)
            .field(
                "material",
                &format_args!(
                    "[REDACTED:{}; byte_len={}]",
                    SEMANTIC_SECRET_REDACTED,
                    self.material.len()
                ),
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKeyImportResult {
    pub schema_version: String,
    pub import_id: String,
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    pub source_hash: ProofHash,
    pub material_hash: ProofHash,
    pub material_bytes: usize,
    pub redaction_status: HelperRedactionStatus,
    pub source: LocalKeyImportSource,
    pub stored_local_ref: bool,
    pub diagnostics: Vec<LocalKeyImportDiagnostic>,
}

impl LocalKeyImportResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            import_id: redact_for_log_or_report(&self.import_id),
            secret_ref: self.secret_ref.clone(),
            key_purpose: redact_for_log_or_report(&self.key_purpose),
            engine_profile_id: redact_for_log_or_report(&self.engine_profile_id),
            source_hash: self.source_hash.clone(),
            material_hash: self.material_hash.clone(),
            material_bytes: self.material_bytes,
            redaction_status: self.redaction_status,
            source: self.source,
            stored_local_ref: self.stored_local_ref,
            diagnostics: self
                .diagnostics
                .iter()
                .map(LocalKeyImportDiagnostic::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKeyImportDiagnostic {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl LocalKeyImportDiagnostic {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[path = "lib/siglus_parser_boundary.rs"]
mod siglus_parser_boundary;
pub use siglus_parser_boundary::*;

// KiriKiri XP3 profile proof
// `kaifuu xp3 profile-proof --fixture <path> --output <path>` consumes a
// fixture JSON file describing a single XP3 archive case (plain, encrypted,
// helper-required, or unsupported-protected-executable), classifies the
// archive bytes via the shared header / inventory machinery
// and emits a redacted proof report. The command never decrypts, extracts,
// or patches encrypted bytes — plain XP3 is the only variant for which we
// claim detect / extract / patch_back capability; every other classification
// fails closed before any extract or patch claim is made (acceptance
// criterion: "Unsupported cases fail before extract or patch claims are
// made").
// The redaction surface follows the SiglusParserBoundaryReport pattern:
// fixture id, profile id, archive id, support boundary text, diagnostic
// fields/messages, and any free-form remediation text run through
// `redact_for_log_or_report`. Archive paths are never written verbatim;
// the proof carries only an archive hash plus the relative path the
// fixture declares (and rejects absolute / traversal paths up front).
