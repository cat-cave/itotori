use super::*;

// Admission (only produced by clearing the capability gate).

/// A cleared XP3 VFS handoff. **The only constructor is [`admit_xp3_handoff`]**
/// which returns this only for a plain-extracted archive whose members are all
/// safe. Holding one is proof the archive-capability gate was cleared; it is the
/// sole key that unlocks [`Xp3HandoffAdmission::archive_reader`]
/// [`Xp3HandoffAdmission::mount`] — and therefore any KAG replay through the
/// VFS. The fields are private so an admission can never be forged.
#[derive(Debug)]
pub struct Xp3HandoffAdmission {
    archive_id: String,
    content_hash: ProofHash,
    key_ref: Option<SecretRef>,
    members: BTreeMap<String, AssetBytes>,
}

impl Xp3HandoffAdmission {
    /// The redacted public archive id.
    pub fn archive_id(&self) -> &str {
        &self.archive_id
    }

    /// Number of extracted members available through the VFS.
    pub fn member_count(&self) -> usize {
        self.members.len()
    }

    /// The redacted archive-metadata report for this handoff. Carries counts
    /// hashes, in-archive member ids, and a secret-ref — never keys, protected
    /// paths, or private local filenames.
    pub fn metadata(&self) -> Xp3HandoffMetadata {
        Xp3HandoffMetadata {
            schema_version: XP3_HANDOFF_SCHEMA_VERSION.to_string(),
            archive_id: self.archive_id.clone(),
            profile: Xp3HandoffProfile::PlainExtracted,
            content_hash: self.content_hash.clone(),
            member_count: self.members.len() as u64,
            member_ids: self.members.keys().cloned().collect(),
            key_ref: self.key_ref.clone(),
            redaction_status: "redacted".to_string(),
            support_boundary: XP3_HANDOFF_SUPPORT_BOUNDARY.to_string(),
        }
    }

    /// Build the sealed archive reader that serves the extracted members. This
    /// is gated behind the admission: an out-of-profile archive never yields an
    /// admission, so it never yields a reader.
    pub fn archive_reader(&self) -> Arc<Xp3HandoffArchiveReader> {
        Arc::new(Xp3HandoffArchiveReader {
            source_label: self.archive_id.clone(),
            members: self.members.clone(),
            index: OnceLock::new(),
        })
    }

    /// Mount the extracted members into a fresh [`MountedVfs`] under the fixed
    /// [`XP3_HANDOFF_PACKAGE_ID`], carrying the archive content-hash as the
    /// package revision. This is the shared VFS boundary a KAG replay reads
    /// through.
    pub fn mount(&self) -> MountedVfs {
        let mut vfs = MountedVfs::new(
            XP3_HANDOFF_PACKAGE_ID,
            PackageSource::PublicName(self.archive_id.clone()),
        )
        .with_revision(self.content_hash.as_str().to_string());
        vfs.mount_archive(self.archive_reader());
        vfs
    }
}

/// Admit an XP3 VFS handoff, or refuse it with a typed diagnostic.
///
/// The archive-capability gate runs **first**: a non-plain profile is refused
/// with [`Xp3HandoffDiagnostic::OutOfProfileArchive`] before any member is
/// indexed and before any VFS reader could be built. For a plain-extracted
/// archive, every member id is validated as a safe in-archive logical path, and
/// case-folding collisions / an empty handoff are refused too. Only a fully
/// clean handoff yields an [`Xp3HandoffAdmission`].
pub fn admit_xp3_handoff(
    manifest: Xp3HandoffManifest,
) -> Result<Xp3HandoffAdmission, Xp3HandoffDiagnostic> {
    let archive_id = manifest.archive_id;

    // Archive-capability gate FIRST: refuse any non-plain profile before any
    // member handling or reader construction.
    if !manifest.profile.is_admissible() {
        return Err(Xp3HandoffDiagnostic::OutOfProfileArchive {
            archive_id,
            profile: manifest.profile,
            detail: "only a plain (unencrypted) XP3 that Kaifuu extracted is admitted; \
                     Kaifuu owns decryption for every other class"
                .to_string(),
        });
    }

    // The archive id itself must be a redaction-safe public name.
    if let Err(detail) = validate_public_id(&archive_id) {
        return Err(Xp3HandoffDiagnostic::UnsafeMemberId {
            archive_id: "[unnamed-archive]".to_string(),
            detail: format!("archive id is unsafe: {detail}"),
        });
    }

    if manifest.members.is_empty() {
        return Err(Xp3HandoffDiagnostic::EmptyHandoff { archive_id });
    }

    // Validate + fold every member id; refuse traversal / local-path shapes and
    // case-insensitive collisions (the resolver folds ASCII case).
    let mut members: BTreeMap<String, AssetBytes> = BTreeMap::new();
    let mut seen_folded: BTreeMap<String, String> = BTreeMap::new();
    for member in manifest.members {
        if let Err(detail) = validate_member_id(&member.member_id) {
            return Err(Xp3HandoffDiagnostic::UnsafeMemberId { archive_id, detail });
        }
        let folded = fold_ascii(&member.member_id);
        if seen_folded
            .insert(folded, member.member_id.clone())
            .is_some()
        {
            return Err(Xp3HandoffDiagnostic::DuplicateMemberId {
                archive_id,
                member_id: member.member_id,
            });
        }
        members.insert(member.member_id, member.bytes);
    }

    Ok(Xp3HandoffAdmission {
        archive_id,
        content_hash: manifest.content_hash,
        key_ref: manifest.key_ref,
        members,
    })
}

// Sealed archive reader over the extracted members.

/// Sealed [`AssetArchiveReader`] that serves Kaifuu-extracted XP3 members.
///
/// It holds the **already-extracted** plaintext bytes keyed by in-archive id and
/// serves them through the VFS. It does **not** parse an XP3 container, hold a
/// key, or decrypt — the decryption/extraction happened Kaifuu-side, before the
/// handoff. Constructed only via [`Xp3HandoffAdmission::archive_reader`].
pub struct Xp3HandoffArchiveReader {
    source_label: String,
    members: BTreeMap<String, AssetBytes>,
    index: OnceLock<CaseFoldedIndex>,
}

impl std::fmt::Debug for Xp3HandoffArchiveReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print member bytes.
        formatter
            .debug_struct("Xp3HandoffArchiveReader")
            .field("source_label", &self.source_label)
            .field("member_count", &self.members.len())
            .finish()
    }
}

impl Sealed for Xp3HandoffArchiveReader {}

impl AssetArchiveReader for Xp3HandoffArchiveReader {
    fn source_label(&self) -> &str {
        &self.source_label
    }

    fn case_folded_index(&self) -> VfsResult<&CaseFoldedIndex> {
        Ok(self.index.get_or_init(|| {
            let mut index = CaseFoldedIndex::new();
            // BTreeMap keys iterate in sorted order → deterministic index build.
            for key in self.members.keys() {
                index.insert(key.clone());
            }
            index
        }))
    }

    fn open_entry(&self, entry: &CaseFoldedIndexEntry) -> VfsResult<AssetBytes> {
        match self.members.get(entry.stored_path()) {
            Some(bytes) => Ok(bytes.clone()),
            None => Err(VfsError::AssetMissing {
                id: AssetId::from_parts(XP3_HANDOFF_PACKAGE_ID, entry.stored_path())?,
            }),
        }
    }
}

// Redacted archive-metadata report.

/// The redacted archive-metadata report carried by a handoff. Counts, hashes
/// in-archive member ids, and a secret-ref — never keys, protected paths, or
/// private local filenames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3HandoffMetadata {
    /// Report schema version.
    pub schema_version: String,
    /// The redacted public archive id.
    pub archive_id: String,
    /// The admitted profile (always plain-extracted).
    pub profile: Xp3HandoffProfile,
    /// One-way commitment to the Kaifuu-owned archive bytes.
    pub content_hash: ProofHash,
    /// Number of extracted members.
    pub member_count: u64,
    /// In-archive member ids (public logical paths), sorted.
    pub member_ids: Vec<String>,
    /// The local secret-ref the key is published under, when a key was involved.
    /// Never the key bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    /// Always `"redacted"`.
    pub redaction_status: String,
    /// The blunt support boundary.
    pub support_boundary: String,
}

impl Xp3HandoffMetadata {
    /// Serialize to stable, redaction-swept JSON (secret-refs / hashes only, no
    /// keys, no local paths, no private local filenames). Committable evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

// Validation helpers.

/// Validate a redaction-safe public id (archive id): non-empty, no control
/// bytes, and not a local-path shape.
fn validate_public_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("id must be non-empty".to_string());
    }
    if value.chars().any(|character| {
        let codepoint = character as u32;
        codepoint < 0x20 || codepoint == 0x7F
    }) {
        return Err("id must not contain control characters".to_string());
    }
    if looks_like_local_path(value) {
        return Err("id must not look like a local path".to_string());
    }
    Ok(())
}

/// Validate an in-archive member id as a safe forward-slash logical path.
fn validate_member_id(member_id: &str) -> Result<(), String> {
    if member_id.is_empty() {
        return Err("member id must be non-empty".to_string());
    }
    if member_id.len() > super::super::id::MAX_ASSET_ID_BYTES {
        return Err("member id is too long".to_string());
    }
    if member_id.starts_with('/') {
        return Err("member id must not be absolute".to_string());
    }
    if member_id.ends_with('/') {
        return Err("member id must be a file path, not a directory".to_string());
    }
    if member_id.contains('\\') {
        return Err("member id must use forward slashes".to_string());
    }
    if looks_like_local_path(member_id) {
        return Err("member id must not look like a local path".to_string());
    }
    for segment in member_id.split('/') {
        if segment.is_empty() {
            return Err("member id must not contain an empty segment".to_string());
        }
        if segment == "." || segment == ".." {
            return Err("member id must not contain a traversal segment".to_string());
        }
        if segment.len() > super::super::id::MAX_ASSET_ID_SEGMENT_BYTES {
            return Err("member id has an overlong segment".to_string());
        }
    }
    for character in member_id.chars() {
        if character == '\0' {
            return Err("member id must not contain a null byte".to_string());
        }
        let codepoint = character as u32;
        if codepoint < 0x20 || codepoint == 0x7F {
            return Err("member id must not contain control characters".to_string());
        }
    }
    Ok(())
}

/// ASCII case-fold, matching [`CaseFoldedIndex`]'s folding, for collision checks.
fn fold_ascii(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
}
