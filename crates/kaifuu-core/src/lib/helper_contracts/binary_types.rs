use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinaryAllowlist {
    pub entries: Vec<HelperBinaryAllowlistEntry>,
}

impl HelperBinaryAllowlist {
    pub(super) fn normalize(&mut self) {
        self.entries
            .sort_by_key(|entry| entry.allowlist_entry_id.clone());
        self.entries
            .dedup_by_key(|entry| entry.allowlist_entry_id.clone());
        for entry in &mut self.entries {
            entry.capabilities.sort();
            entry.capabilities.dedup();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinaryAllowlistEntry {
    pub allowlist_entry_id: String,
    pub helper_id: String,
    pub platform: String,
    pub helper_version: String,
    pub executable_name: String,
    pub sha256_hash: String,
    pub signature: HelperBinarySignatureMetadata,
    pub capabilities: Vec<HelperCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinarySignatureMetadata {
    pub signature_kind: String,
    pub signer: String,
    pub signature_ref: String,
}

#[derive(Debug, Clone, Copy)]
pub struct HelperBinaryLaunchValidationRequest<'a> {
    pub helper_id: &'a str,
    pub allowlist_entry_id: &'a str,
    pub executable_path: &'a Path,
    pub platform: &'a str,
    pub helper_version: &'a str,
    pub required_capabilities: &'a [HelperCapability],
}

#[derive(Debug, Clone, Copy)]
pub struct HelperRegistryInvocationRequest<'a> {
    pub helper_id: &'a str,
    pub helper_version: &'a str,
    pub allowlist_entry_id: &'a str,
    pub capability: HelperCapability,
    pub input: &'a Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinaryLaunchValidationResult {
    pub schema_version: String,
    pub helper_id: String,
    pub allowlist_entry_id: String,
    pub status: OperationStatus,
    pub observed_hash: Option<String>,
    pub platform: String,
    pub diagnostics: Vec<HelperBinaryLaunchDiagnostic>,
}

impl HelperBinaryLaunchValidationResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            helper_id: redact_for_log_or_report(&self.helper_id),
            allowlist_entry_id: redact_for_log_or_report(&self.allowlist_entry_id),
            status: self.status.clone(),
            observed_hash: self.observed_hash.as_deref().map(redact_helper_hash),
            platform: redact_for_log_or_report(&self.platform),
            diagnostics: self
                .diagnostics
                .iter()
                .map(HelperBinaryLaunchDiagnostic::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinaryLaunchDiagnostic {
    pub helper_id: String,
    pub allowlist_entry_id: String,
    pub code: String,
    pub field: String,
    pub observed_hash: Option<String>,
    pub platform: String,
    pub remediation_code: String,
    pub message: String,
}

impl HelperBinaryLaunchDiagnostic {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            helper_id: redact_for_log_or_report(&self.helper_id),
            allowlist_entry_id: redact_for_log_or_report(&self.allowlist_entry_id),
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            observed_hash: self.observed_hash.as_deref().map(redact_helper_hash),
            platform: redact_for_log_or_report(&self.platform),
            remediation_code: redact_for_log_or_report(&self.remediation_code),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

pub(super) fn redact_helper_hash(hash: &str) -> String {
    if is_sha256_ref(hash) {
        hash.to_string()
    } else {
        redact_for_log_or_report(hash)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRegistryValidationResult {
    pub schema_version: String,
    pub helper_id: Option<String>,
    pub status: OperationStatus,
    pub diagnostics: Vec<HelperRegistryDiagnostic>,
}

impl HelperRegistryValidationResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
            status: self.status.clone(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(HelperRegistryDiagnostic::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRegistryDiagnostic {
    pub helper_id: Option<String>,
    pub code: String,
    pub field: String,
    pub message: String,
}

impl HelperRegistryDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The outcome of a hardened helper-binary launch: the serializable validation
/// verdict plus, on success, the trusted staged copy that IS the execution
/// reference.
/// `staged` is `Some` only when validation passed. It carries the bytes whose
/// hash was validated, in a trusted staging directory (held open on Unix), so a
/// caller launches the staged copy — never the mutable source path — and a swap
/// of the source after validation cannot change what runs.
#[derive(Debug)]
pub struct HelperBinaryLaunchOutcome {
    pub validation: HelperBinaryLaunchValidationResult,
    pub staged: Option<StagedHelperBinary>,
}

impl HelperBinaryLaunchOutcome {
    /// Whether the launch validation passed.
    pub fn passed(&self) -> bool {
        self.validation.status == OperationStatus::Passed
    }
}

/// A helper binary whose validated bytes have been bound to execution through a
/// trusted staging COPY.
/// The bytes were copied ONCE (no-follow) from the source into a trusted
/// staging directory, and [`staged_hash`](Self::staged_hash) is the sha256 of
/// those STAGED bytes. On Unix an open read-only descriptor to the staged copy
/// is retained ([`execution_fd`](Self::execution_fd)) as the execution
/// reference; the mutable source path is never re-opened. The staged copy is
/// removed on drop (the held descriptor remains valid for any in-flight use).
#[derive(Debug)]
pub struct StagedHelperBinary {
    pub(super) path: PathBuf,
    pub(super) hash: String,
    #[cfg(unix)]
    pub(super) fd: std::os::fd::OwnedFd,
}

impl StagedHelperBinary {
    /// Path to the trusted staged copy — the launch target. Distinct from the
    /// (mutable, untrusted) source path.
    pub fn staged_path(&self) -> &Path {
        &self.path
    }

    /// sha256 (`sha256:<hex>`) of the STAGED bytes — the bytes bound to
    /// execution, exactly the bytes that were validated against the allowlist.
    pub fn staged_hash(&self) -> &str {
        &self.hash
    }

    /// The open read-only descriptor to the staged copy: the execution
    /// reference. A launcher should reference this descriptor (or
    /// [`staged_path`](Self::staged_path)) and never re-open the source path.
    #[cfg(unix)]
    pub fn execution_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        use std::os::fd::AsFd;
        self.fd.as_fd()
    }

    /// Verify the STAGED bytes against a registered allowlist hash. On mismatch
    /// the staged copy is consumed (dropped, its file removed) so nothing is
    /// left to execute, and a typed [`HelperBinaryStagingError::StagedHashMismatch`]
    /// is returned — tamper detected at stage time. On match the staged copy is
    /// returned as the bound execution reference.
    pub fn verify_registered_hash(
        self,
        registered_hash: &str,
    ) -> Result<Self, HelperBinaryStagingError> {
        if self.hash == registered_hash {
            Ok(self)
        } else {
            Err(HelperBinaryStagingError::StagedHashMismatch {
                expected: registered_hash.to_string(),
                observed: self.hash.clone(),
            })
        }
    }
}

/// Stage a helper binary into the trusted directory and verify the STAGED bytes
/// against `registered_hash`, binding the validated bytes to execution.
/// This is the standalone hardened primitive behind the registry launch path:
/// the source is copied once (no-follow) into `staging_dir`, the hash is
/// computed from the STAGED copy, and on a match the returned
/// [`StagedHelperBinary`] is the execution reference. A swap of the source path
/// afterwards has no effect. A hash mismatch yields a typed
/// [`HelperBinaryStagingError::StagedHashMismatch`] with nothing left to run.
pub fn stage_and_verify_helper_binary(
    registered_hash: &str,
    source_path: &Path,
    staging_dir: &Path,
    staged_name: &str,
) -> Result<StagedHelperBinary, HelperBinaryStagingError> {
    stage_helper_binary_no_follow(source_path, staging_dir, staged_name)?
        .verify_registered_hash(registered_hash)
}

impl Drop for StagedHelperBinary {
    fn drop(&mut self) {
        // Best-effort removal of the trusted staged copy. On Unix the held
        // descriptor keeps the inode alive for any in-flight use even after the
        // path is unlinked.
        let _ = fs::remove_file(&self.path);
    }
}

/// A typed failure while staging a helper binary into the trusted directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperBinaryStagingError {
    /// The source path does not exist. (Surfaced by the launch validator as a
    /// `missing_binary` diagnostic, not a staging failure.)
    SourceMissing,
    /// The source path is a symlink; the staging copy refuses to chase it out to
    /// attacker-chosen bytes.
    SourceSymlink,
    /// A symlink squatted on (or an entry raced into) the staged leaf inside the
    /// trusted directory; the no-follow, exclusive create refused it.
    StagingSymlink,
    /// The STAGED bytes' hash does not match the registered allowlist hash —
    /// tamper detected at stage time, before anything could be launched.
    StagedHashMismatch { expected: String, observed: String },
    /// An I/O error while reading the source or writing the staged copy.
    Io(String),
    /// Fd-relative no-follow staging is only implemented on Unix.
    Unsupported,
}

impl fmt::Display for HelperBinaryStagingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceMissing => formatter.write_str("helper binary source path is missing"),
            Self::SourceSymlink => {
                formatter.write_str("helper binary source path is a symlink (refused no-follow)")
            }
            Self::StagingSymlink => formatter
                .write_str("a symlink squatted on the trusted staged copy (refused no-follow)"),
            Self::StagedHashMismatch { expected, observed } => write!(
                formatter,
                "staged helper binary hash {observed} does not match registered hash {expected}"
            ),
            Self::Io(message) => write!(formatter, "helper binary staging I/O error: {message}"),
            Self::Unsupported => {
                formatter.write_str("helper binary staging requires a Unix platform")
            }
        }
    }
}

impl std::error::Error for HelperBinaryStagingError {}

/// Deterministic, path-separator-free staged leaf name derived from the
/// allowlist entry id (hashed so no untrusted characters reach the filesystem).
pub(crate) fn staged_helper_binary_name(allowlist_entry_id: &str) -> String {
    format!(
        "kaifuu-helper-staged-{}",
        sha256_hex(allowlist_entry_id.as_bytes())
    )
}
