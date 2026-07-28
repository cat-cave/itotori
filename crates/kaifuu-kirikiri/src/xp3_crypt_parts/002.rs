/// Decrypt + verify every member of an encrypted XP3 using the resolved key,
/// returning the recovered **plaintext** per member. Each member is checked
/// against its stored `adlr` adler-32; a wrong key trips the integrity check
/// with a typed [`Xp3CryptError::IntegrityCheckFailed`]. This is the shared
/// decrypt path both the hash-only manifest and the patch-back extract go
/// through, so integrity is verified in exactly one place.
pub(crate) fn decrypt_members(
    container: &[u8],
    key: &Xp3CryptKey,
    scheme: Xp3CryptScheme,
) -> Result<Vec<Xp3DecryptedMember>, Xp3CryptError> {
    let archive =
        read_plain_xp3_archive(container).map_err(|error| Xp3CryptError::ContainerRead {
            detail: error.to_string(),
        })?;

    let mut members = Vec::with_capacity(archive.entries.len());
    for entry in &archive.entries {
        let stored_adler = entry
            .stored_adler32
            .ok_or_else(|| Xp3CryptError::MissingIntegrity {
                member_id: entry.path.clone(),
            })?;
        let plaintext = key.apply_filter(scheme, &entry.payload);
        if compute_adler32(&plaintext) != stored_adler {
            return Err(Xp3CryptError::IntegrityCheckFailed {
                member_id: entry.path.clone(),
            });
        }
        members.push(Xp3DecryptedMember {
            member_id: entry.path.clone(),
            plaintext,
            stored_adler,
        });
    }
    Ok(members)
}

/// Decrypt + extract every member of an encrypted XP3 using the resolved key,
/// verifying each member against its stored `adlr` adler-32, and emit the
/// hash-based manifest (no raw plaintext). A wrong key trips the integrity
/// check with a typed [`Xp3CryptError::IntegrityCheckFailed`].
pub(crate) fn decrypt_and_extract(
    container: &[u8],
    key: &Xp3CryptKey,
    scheme: Xp3CryptScheme,
) -> Result<Xp3CryptManifest, Xp3CryptError> {
    let members = decrypt_members(container, key, scheme)?
        .into_iter()
        .map(|member| {
            Ok(Xp3CryptExtractedMember {
                member_id: member.member_id,
                plaintext_byte_len: member.plaintext.len() as u64,
                plaintext_hash: ProofHash::new(sha256_hash_bytes(&member.plaintext))
                    .map_err(|message| Xp3CryptError::Internal { message })?,
                adler32: format!("adler32:{:08x}", member.stored_adler),
            })
        })
        .collect::<Result<Vec<_>, Xp3CryptError>>()?;
    Ok(Xp3CryptManifest { members })
}

/// Where the encrypted XP3 container bytes come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum Xp3CryptContainerSource {
    /// Build the synthetic encrypted XP3 in-process (public CI; no bytes on
    /// disk).
    SyntheticStub,
    /// Read a scoped local encrypted XP3 in-process (never shelled out to).
    /// Path is relative to the fixture directory.
    LocalFile {
        /// Relative path to the scoped local archive.
        path: String,
    },
}

/// The profiled XP3-crypt fixture. Declares every required field:
/// `engine_family`, `container`, crypto profile, codec, surface, fixture id,
/// and the secret **requirement id** + secret ref (never a raw key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3CryptFixture {
    /// Schema version.
    pub schema_version: String,
    /// Stable fixture id.
    pub fixture_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
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
    /// The secret **requirement id** (never raw key material).
    pub secret_requirement_id: String,
    /// The structured secret ref the decrypt key is published under.
    pub secret_ref: SecretRef,
    /// Where the encrypted container bytes come from.
    pub container_source: Xp3CryptContainerSource,
    /// Declared expected member set (ids, in archive order).
    pub expected_member_ids: Vec<String>,
}

/// Per-member digest in the report (hash-based; no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CryptMemberDigest {
    /// The in-archive member id.
    pub member_id: String,
    /// Decrypted plaintext byte length.
    pub plaintext_byte_len: u64,
    /// sha-256 commitment to the decrypted plaintext.
    pub plaintext_hash: ProofHash,
    /// The verified adler-32 (`adler32:<hex>`).
    pub adler32: String,
}

impl Xp3CryptMemberDigest {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            plaintext_byte_len: self.plaintext_byte_len,
            plaintext_hash: self.plaintext_hash.clone(),
            adler32: redact_for_log_or_report(&self.adler32),
        }
    }
}

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

/// Run the full XP3-crypt smoke from a fixture manifest: resolve the container,
/// resolve the valid secret ref → key, decrypt + extract + verify integrity,
/// then prove the wrong-key and missing-key failure modes are typed errors.
/// Returns a redactable report.
pub fn run_xp3_crypt_smoke_from_fixture(
    fixture: &Xp3CryptFixture,
    fixture_dir: &Path,
) -> Result<Xp3CryptReport, Xp3CryptError> {
    // Declared field sanity: the fixture must match this profile's engine /
    // container, or it is not a valid input for this smoke.
    if fixture.engine_family != XP3_CRYPT_ENGINE_FAMILY {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: format!(
                "engine_family {} is not {XP3_CRYPT_ENGINE_FAMILY}",
                fixture.engine_family
            ),
        });
    }
    if fixture.container != XP3_CRYPT_CONTAINER {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: format!(
                "container {} is not {XP3_CRYPT_CONTAINER}",
                fixture.container
            ),
        });
    }

    let container = resolve_container_bytes(&fixture.container_source, fixture_dir)?;
    let container_hash = ProofHash::new(sha256_hash_bytes(&container))
        .map_err(|message| Xp3CryptError::Internal { message })?;

    let resolver = FixtureSecretResolver::fixture_default();

    // The crypt scheme is DATA: the declared profile selects the byte transform.
    let scheme = fixture.crypto_profile.scheme();

    // (1) Valid secret ref → key → decrypt + extract + verify integrity.
    let key = resolver.resolve(&fixture.secret_requirement_id, &fixture.secret_ref)?;
    let manifest = decrypt_and_extract(&container, key, scheme)?;

    // Declared expectation: the decrypted member set matches.
    let extracted_ids: Vec<&str> = manifest
        .members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    if extracted_ids != fixture.expected_member_ids {
        return Err(Xp3CryptError::ExpectationMismatch {
            detail: "extracted member set did not match declared expected_member_ids".to_string(),
        });
    }

    // (2) Wrong-key probe: a resolvable-but-wrong ref must trip the integrity
    // check with a typed error citing the first member.
    let wrong_ref = SecretRef::new(XP3_CRYPT_WRONG_SECRET_REF)
        .map_err(|message| Xp3CryptError::Internal { message })?;
    let wrong_key = resolver.resolve(&fixture.secret_requirement_id, &wrong_ref)?;
    let wrong_key_report = match decrypt_and_extract(&container, wrong_key, scheme) {
        Err(Xp3CryptError::IntegrityCheckFailed { member_id }) => Xp3CryptWrongKeyReport {
            attempted_secret_ref: wrong_ref,
            typed_error: true,
            diagnostic_code: format!("{XP3_CRYPT_MARKER}.integrity_check_failed"),
            member_id: Some(member_id),
        },
        Err(other) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: format!("wrong key produced the wrong error: {other}"),
            });
        }
        Ok(_) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: "wrong key was silently accepted".to_string(),
            });
        }
    };

    // (3) Missing-key probe: an unknown ref must fail resolution with a typed
    // error, before any decrypt.
    let missing_ref = SecretRef::new(XP3_CRYPT_MISSING_SECRET_REF)
        .map_err(|message| Xp3CryptError::Internal { message })?;
    let missing_key_report = match resolver.resolve(&fixture.secret_requirement_id, &missing_ref) {
        Err(Xp3CryptError::MissingSecret { requirement_id, .. }) => Xp3CryptMissingKeyReport {
            attempted_requirement_id: requirement_id,
            typed_error: true,
            diagnostic_code: format!("{XP3_CRYPT_MARKER}.missing_secret"),
        },
        Err(other) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: format!("missing key produced the wrong error: {other}"),
            });
        }
        Ok(_) => {
            return Err(Xp3CryptError::ExpectationMismatch {
                detail: "missing key ref resolved to material".to_string(),
            });
        }
    };

    // (4) Assemble the report (counts + one-way commitments only).
    let manifest_digests: Vec<Xp3CryptMemberDigest> = manifest
        .members
        .iter()
        .map(|member| Xp3CryptMemberDigest {
            member_id: member.member_id.clone(),
            plaintext_byte_len: member.plaintext_byte_len,
            plaintext_hash: member.plaintext_hash.clone(),
            adler32: member.adler32.clone(),
        })
        .collect();

    // decrypt proof: a hash over the concatenated member plaintext commitments
    // (proves the decrypt produced this exact manifest).
    let mut proof_material = Vec::new();
    for member in &manifest.members {
        proof_material.extend_from_slice(member.member_id.as_bytes());
        proof_material.extend_from_slice(member.plaintext_hash.as_str().as_bytes());
    }
    let decrypt_proof = KeyValidationProof {
        method: KeyValidationMethod::DecryptHeaderProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(&proof_material))
            .map_err(|message| Xp3CryptError::Internal { message })?,
    };

    let report = Xp3CryptReport {
        schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
        capability_id: XP3_CRYPT_CAPABILITY_ID.to_string(),
        source_node_id: fixture.source_node_id.clone(),
        support_boundary: XP3_CRYPT_SUPPORT_BOUNDARY.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        engine_family: fixture.engine_family.clone(),
        container: fixture.container.clone(),
        crypto_profile: fixture.crypto_profile,
        codec: fixture.codec,
        surface: fixture.surface,
        secret_requirement_id: fixture.secret_requirement_id.clone(),
        secret_ref: fixture.secret_ref.clone(),
        key_material_hash: key.material_hash()?,
        key_bytes: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        key_material_kind: KeyMaterialKind::FixedBytes,
        redaction_status: HelperRedactionStatus::Redacted,
        container_hash,
        manifest: manifest_digests,
        decrypt_proof,
        wrong_key: wrong_key_report,
        missing_key: missing_key_report,
        status: OperationStatus::Passed,
    };

    // Runtime no-leak guard: the serialized (redacted) report must never carry
    // the raw key material. This is a hard refusal, not just a test-time check.
    let json = report
        .stable_json()
        .map_err(|error| Xp3CryptError::Internal {
            message: error.to_string(),
        })?;
    if key.appears_in(json.as_bytes()) || wrong_key.appears_in(json.as_bytes()) {
        return Err(Xp3CryptError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}


