use super::*;

/// One decrypted member (hash-based; no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xp3CryptExtractedMember {
    /// The in-archive member id.
    pub member_id: String,
    /// Decrypted plaintext byte length.
    pub plaintext_byte_len: u64,
    /// sha-256 commitment to the decrypted plaintext (never the plaintext).
    pub plaintext_hash: ProofHash,
    /// The verified adler-32 of the plaintext, formatted `adler32:<8 hex>`.
    pub adler32: String,
}

/// The decrypt/extract manifest: decrypted members as hash-based digests only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xp3CryptManifest {
    /// Decrypted members, in archive order.
    pub members: Vec<Xp3CryptExtractedMember>,
}

/// One decrypted member with its recovered **plaintext bytes** and the stored
/// adler-32 it was verified against. Crate-private: the plaintext never leaves
/// the module boundary except as a one-way hash in a report.
pub(crate) struct Xp3DecryptedMember {
    /// The in-archive member id.
    pub(crate) member_id: String,
    /// The verified decrypted plaintext.
    pub(crate) plaintext: Vec<u8>,
    /// The stored `adlr` adler-32 (of the plaintext) the member verified against.
    pub(crate) stored_adler: u32,
}

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
