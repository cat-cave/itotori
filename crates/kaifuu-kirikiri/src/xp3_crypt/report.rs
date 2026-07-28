use super::*;

/// The wrong-key probe outcome: a resolvable-but-wrong ref must fail the
/// integrity check with a typed error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptWrongKeyReport {
    /// The wrong secret ref that was attempted.
    pub attempted_secret_ref: SecretRef,
    /// Always `true`: the attempt was refused with a typed error.
    pub typed_error: bool,
    /// The stable diagnostic code the refusal carried.
    pub diagnostic_code: String,
    /// The in-archive member id the integrity failure cited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
}

/// The missing-key probe outcome: an unknown ref must fail resolution with a
/// typed error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptMissingKeyReport {
    /// The unresolved requirement id.
    pub attempted_requirement_id: String,
    /// Always `true`: the attempt was refused with a typed error.
    pub typed_error: bool,
    /// The stable diagnostic code the refusal carried.
    pub diagnostic_code: String,
}

/// The full XP3-crypt smoke report. Redact before serialization via
/// [`Xp3CryptReport::stable_json`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Fixture id.
    pub fixture_id: String,
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// Declared crypt filter / cipher.
    pub crypto_profile: Xp3CryptoProfile,
    /// Declared content codec.
    pub codec: CodecTransform,
    /// Declared extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// The secret requirement id (never raw key material).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key was resolved through.
    pub secret_ref: SecretRef,
    /// One-way sha-256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    /// Key byte length (disclosed; the bytes are not).
    pub key_bytes: u32,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// sha-256 commitment to the encrypted container bytes (which archive was
    /// decrypted).
    pub container_hash: ProofHash,
    /// The decrypt/extract manifest (hash-based).
    pub manifest: Vec<Xp3CryptMemberDigest>,
    /// The valid-key decrypt proof (method + hash over the manifest).
    pub decrypt_proof: KeyValidationProof,
    /// Wrong-key probe outcome.
    pub wrong_key: Xp3CryptWrongKeyReport,
    /// Missing-key probe outcome.
    pub missing_key: Xp3CryptMissingKeyReport,
    /// Overall status.
    pub status: OperationStatus,
}

impl Xp3CryptReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            container: redact_for_log_or_report(&self.container),
            crypto_profile: self.crypto_profile,
            codec: self.codec,
            surface: self.surface,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            container_hash: self.container_hash.clone(),
            manifest: self
                .manifest
                .iter()
                .map(Xp3CryptMemberDigest::redacted_for_report)
                .collect(),
            decrypt_proof: self.decrypt_proof.clone(),
            wrong_key: Xp3CryptWrongKeyReport {
                attempted_secret_ref: self.wrong_key.attempted_secret_ref.clone(),
                typed_error: self.wrong_key.typed_error,
                diagnostic_code: redact_for_log_or_report(&self.wrong_key.diagnostic_code),
                member_id: self
                    .wrong_key
                    .member_id
                    .as_deref()
                    .map(redact_for_log_or_report),
            },
            missing_key: Xp3CryptMissingKeyReport {
                attempted_requirement_id: redact_for_log_or_report(
                    &self.missing_key.attempted_requirement_id,
                ),
                typed_error: self.missing_key.typed_error,
                diagnostic_code: redact_for_log_or_report(&self.missing_key.diagnostic_code),
            },
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no plaintext).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// Build a hash-based member digest from a member id + its decrypted plaintext.
/// Shared by the decrypt manifest and the patch-back verification.
pub(crate) fn member_digest_from_plaintext(
    member_id: &str,
    plaintext: &[u8],
) -> Result<Xp3CryptMemberDigest, Xp3CryptError> {
    Ok(Xp3CryptMemberDigest {
        member_id: member_id.to_string(),
        plaintext_byte_len: plaintext.len() as u64,
        plaintext_hash: ProofHash::new(sha256_hash_bytes(plaintext))
            .map_err(|message| Xp3CryptError::Internal { message })?,
        adler32: format!("adler32:{:08x}", compute_adler32(plaintext)),
    })
}

/// Resolve the fixture's container bytes in-process.
pub(crate) fn resolve_container_bytes(
    source: &Xp3CryptContainerSource,
    fixture_dir: &Path,
) -> Result<Vec<u8>, Xp3CryptError> {
    match source {
        Xp3CryptContainerSource::SyntheticStub => Ok(build_synthetic_crypt_xp3()),
        Xp3CryptContainerSource::LocalFile { path } => std::fs::read(fixture_dir.join(path))
            .map_err(|error| Xp3CryptError::ContainerRead {
                detail: format!("read local crypt XP3: {error}"),
            }),
    }
}
