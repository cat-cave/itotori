//! KiriKiri **XP3-backed VFS handoff**.
//!
//! Utsushi consumes Kaifuu-owned XP3 / profile output through the shared VFS
//! boundary **without owning archive decryption**. The handoff is:
//!
//! 1. **Kaifuu owns the bytes.** Kaifuu detects, profiles, and (for a *plain*
//!    unencrypted XP3) extracts the archive members. Encrypted / helper-required
//!    compressed-payload / protected-executable archives stay Kaifuu's problem
//!    — Utsushi never decrypts anything.
//! 2. **Utsushi consumes the extracted output via the VFS.** Kaifuu hands over an
//!    [`Xp3HandoffManifest`]: a redacted archive id, a one-way content-hash
//!    commitment to the *Kaifuu-owned* archive bytes, an optional secret-ref to
//!    the (Kaifuu-owned) key material, and the already-extracted plaintext
//!    members (in-archive path + bytes). Utsushi mounts those extracted members
//!    into a [`super::MountedVfs`] through the sealed
//!    [`super::AssetArchiveReader`] boundary. It reads them; it never parses the
//!    XP3 container, never touches a key, never decrypts.
//!
//! # Archive-capability boundary (reject-before-claim)
//!
//! The handoff is **gated** exactly like the runtime-profile boundary.
//! The only constructor of an [`Xp3HandoffAdmission`] is [`admit_xp3_handoff`]
//! which returns `Err(`[`Xp3HandoffDiagnostic`]`)` for every out-of-profile
//! archive **before** any VFS reader is built. Because the archive reader (and
//! therefore any KAG replay through the VFS) can only be obtained from an
//! admission, an out-of-profile archive can never reach a KAG runtime-evidence
//! claim: the capability check fails first. See
//! `crates/utsushi-kirikiri` (`xp3_vfs_replay`) for the KAG-replay-through-VFS
//! consumer that this gate protects.
//!
//! # Redaction
//!
//! Every serialized handoff artifact (the [`Xp3HandoffMetadata`] report and the
//! [`Xp3HandoffDiagnostic`]) carries **redacted metadata + secret-refs only** —
//! never archive keys, never protected/local host paths, never private local
//! filenames. Key material is referenced only through a [`SecretRef`]; the
//! archive is referenced only through a one-way [`ProofHash`]. In-archive member
//! ids (e.g. `scenario/intro.ks`) are logical asset paths, not private local
//! filenames, and survive redaction. Every report is funnelled through
//! [`crate::redaction::reject_unredacted_local_paths`] on the way out.
//!
//! No retail bytes and no retail key live here: the fixtures are synthetic
//! plain-XP3 members produced by the Kaifuu extractor in the consumer's tests.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};

use super::archive::sealed::Sealed;
use super::archive::{AssetArchiveReader, CaseFoldedIndex, CaseFoldedIndexEntry};
use super::diagnostics::VfsError;
use super::diagnostics::VfsResult;
use super::id::AssetId;
use super::package::{AssetBytes, PackageSource};
use super::runtime::MountedVfs;
use crate::looks_like_local_path;
use crate::port::impl_map::sha256_hex;
use crate::redaction::reject_unredacted_local_paths;

/// Schema version of the XP3 VFS handoff manifest + report pair.
pub const XP3_HANDOFF_SCHEMA_VERSION: &str = "0.1.0";

/// The canonical package id every XP3-handoff-backed VFS mounts under. Fixed
/// (not the archive id) so it is always a valid lowercase [`AssetId`] package
/// id; the redacted archive id is carried separately as the package
/// [`PackageSource`].
pub const XP3_HANDOFF_PACKAGE_ID: &str = "xp3-handoff";

/// The blunt support boundary surfaced in every handoff report. Explicit that
/// consuming the handoff is Utsushi reading Kaifuu-extracted output through the
/// VFS — NOT Utsushi decrypting an archive.
pub const XP3_HANDOFF_SUPPORT_BOUNDARY: &str = "Utsushi consumes Kaifuu-owned XP3 output through the shared VFS boundary: Kaifuu detects/profiles/extracts the archive (it owns the bytes and any decryption), and hands Utsushi the already-extracted plaintext members plus redacted metadata (a one-way archive content-hash and, where a key was involved, a local secret-ref). Only a plain (unencrypted) XP3 that Kaifuu extracted is admitted; encrypted, helper-required, and other out-of-profile archives are rejected with a typed diagnostic before any VFS reader is built. Utsushi never parses the XP3 container, never touches a key, and never decrypts. Reports carry redacted metadata and secret-refs only — never keys, protected paths, or private local filenames.";

// Secret reference + one-way proof hash (redaction-safe references).

/// A structured, **local** secret reference. Handoff reports name key material
/// only through this — never raw bytes. Mirrors the `SecretRef`
/// discipline: a `scheme:name` string in a local-secret scheme, carrying no raw
/// key material, no local path, no whitespace, no traversal, no null bytes.
///
/// Serializes as its string form. `Debug` is redacted so an accidental `{:?}`
/// never prints the (access-controlled) ref.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretRef(String);

/// The known-good handoff secret-ref scheme prefixes.
const SECRET_REF_SCHEMES: &[&str] = &["local-secret", "os-keychain", "secret-manager", "prompt"];

impl SecretRef {
    /// Validate + construct. Returns `Err` with a stable message if the value is
    /// not a well-formed local secret reference.
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_valid_secret_ref(&value) {
            Ok(Self(value))
        } else {
            Err(
                "secretRef must use a local secret-ref scheme and must not contain raw key \
                 material, local paths, whitespace, parent traversal, or null bytes"
                    .to_string(),
            )
        }
    }

    /// Borrow the underlying `scheme:name` string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_valid_secret_ref(value: &str) -> bool {
    let Some((scheme, name)) = value.split_once(':') else {
        return false;
    };
    if !SECRET_REF_SCHEMES.contains(&scheme) {
        return false;
    }
    if name.is_empty()
        || name.trim() != name
        || name.contains('\0')
        || name.contains('\\')
        || name.contains('/')
        || name.contains("..")
    {
        return false;
    }
    if looks_like_local_path(value) {
        return false;
    }
    name.chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

impl std::fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("SecretRef")
            .field(&"<secret-ref>")
            .finish()
    }
}

impl std::fmt::Display for SecretRef {
    // A secret-ref is a *reference* to key material, not the material itself
    // (the validator forbids raw key bytes / paths in the name), so it is safe
    // to surface in a typed diagnostic message.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// A one-way, 64-char lowercase-hex sha256 commitment. Used to reference the
/// Kaifuu-owned archive bytes in a report *without* carrying the bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofHash(String);

impl ProofHash {
    /// Commit to `bytes` with a sha256 hex digest.
    pub fn commit(bytes: &[u8]) -> Self {
        Self(sha256_hex(bytes))
    }

    /// Borrow the hex digest.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ProofHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("ProofHash").field(&self.0).finish()
    }
}

// Archive capability profile (the Kaifuu-derived routing tier).

/// The archive-capability profile Kaifuu attaches to the handoff. This is the
/// Utsushi-side view of the Kaifuu XP3 capability tier: only a **plain**
/// (unencrypted) XP3 that Kaifuu extracted is admissible; every other class is a
/// research-tier routing diagnostic that the VFS handoff refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3HandoffProfile {
    /// Plain (unencrypted) XP3 that Kaifuu extracted to plaintext members.
    /// **Admissible**: Utsushi may consume the members through the VFS.
    PlainExtracted,
    /// Encrypted XP3. Kaifuu owns decryption and did not hand over plaintext
    /// members; **out of profile** for the VFS handoff.
    Encrypted,
    /// Helper-required XP3: needs an external helper Kaifuu does not run
    /// in-process; **out of profile**.
    HelperRequired,
    /// Compressed-payload / protected-executable / universal-dump and any other
    /// non-plain routing class; **out of profile**.
    Unsupported,
}

impl Xp3HandoffProfile {
    /// Stable kebab-case label for reports/diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlainExtracted => "plain-extracted",
            Self::Encrypted => "encrypted",
            Self::HelperRequired => "helper-required",
            Self::Unsupported => "unsupported",
        }
    }

    /// Whether this profile admits a VFS handoff (only plain-extracted does).
    pub fn is_admissible(self) -> bool {
        matches!(self, Self::PlainExtracted)
    }
}

// Extracted member + manifest (the Kaifuu -> Utsushi handoff shape).

/// One Kaifuu-extracted archive member: an in-archive logical path plus the
/// already-extracted plaintext bytes. This is Utsushi's view of the Kaifuu
/// adapter output — Utsushi never re-derives it from the container.
#[derive(Clone, PartialEq, Eq)]
pub struct Xp3ExtractedMember {
    member_id: String,
    bytes: AssetBytes,
}

impl Xp3ExtractedMember {
    /// Construct a member from an in-archive id and its extracted bytes.
    /// Validation of the id happens at [`admit_xp3_handoff`] time so a bad id
    /// surfaces as a typed diagnostic rather than a panic.
    pub fn new(member_id: impl Into<String>, bytes: impl Into<AssetBytes>) -> Self {
        Self {
            member_id: member_id.into(),
            bytes: bytes.into(),
        }
    }

    /// The in-archive logical path of this member.
    pub fn member_id(&self) -> &str {
        &self.member_id
    }

    /// The extracted byte length.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Whether the member is empty.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl std::fmt::Debug for Xp3ExtractedMember {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the extracted bytes (they can be copyrighted content).
        formatter
            .debug_struct("Xp3ExtractedMember")
            .field("member_id", &self.member_id)
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

/// The handoff Kaifuu produces for Utsushi. Carries the redacted archive id, the
/// capability profile, a one-way commitment to the Kaifuu-owned archive bytes
/// an optional secret-ref to the key material, and the extracted members.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Xp3HandoffManifest {
    archive_id: String,
    profile: Xp3HandoffProfile,
    content_hash: ProofHash,
    key_ref: Option<SecretRef>,
    members: Vec<Xp3ExtractedMember>,
}

impl Xp3HandoffManifest {
    /// Construct a handoff manifest under a redacted public archive id, the
    /// Kaifuu-derived capability `profile`, and a one-way `content_hash`
    /// commitment (which Kaifuu computed over the archive bytes it owns).
    pub fn new(
        archive_id: impl Into<String>,
        profile: Xp3HandoffProfile,
        content_hash: ProofHash,
    ) -> Self {
        Self {
            archive_id: archive_id.into(),
            profile,
            content_hash,
            key_ref: None,
            members: Vec::new(),
        }
    }

    /// Attach the local secret-ref the archive key is published under (never the
    /// key bytes).
    pub fn with_key_ref(mut self, key_ref: SecretRef) -> Self {
        self.key_ref = Some(key_ref);
        self
    }

    /// Append one extracted member.
    pub fn with_member(mut self, member: Xp3ExtractedMember) -> Self {
        self.members.push(member);
        self
    }

    /// Append several extracted members.
    pub fn with_members(mut self, members: impl IntoIterator<Item = Xp3ExtractedMember>) -> Self {
        self.members.extend(members);
        self
    }

    /// The redacted public archive id.
    pub fn archive_id(&self) -> &str {
        &self.archive_id
    }

    /// The capability profile.
    pub fn profile(&self) -> Xp3HandoffProfile {
        self.profile
    }
}

// Reject-before-claim diagnostic.

/// Typed, redaction-safe diagnostic for a **refused** XP3 VFS handoff. Holding
/// one is proof that **no** VFS reader (and therefore no KAG runtime-evidence
/// claim) was built for this archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "code")]
pub enum Xp3HandoffDiagnostic {
    /// The archive is not a plain-extracted XP3, so the VFS handoff is refused
    /// before any reader is built. This is the archive-capability gate that sits
    /// in front of the KAG replay.
    OutOfProfileArchive {
        /// The redacted archive id.
        archive_id: String,
        /// The (non-plain) capability profile that was refused.
        profile: Xp3HandoffProfile,
        /// Redaction-safe detail.
        detail: String,
    },
    /// A member id is not a safe in-archive logical path (traversal, absolute
    /// root, control bytes, or a local-path shape). The raw id is intentionally
    /// omitted — it could itself be a leak.
    UnsafeMemberId {
        /// The redacted archive id.
        archive_id: String,
        /// Redaction-safe reason.
        detail: String,
    },
    /// Two members fold to the same case-insensitive id, so the first-match-wins
    /// resolver could not serve them unambiguously.
    DuplicateMemberId {
        /// The redacted archive id.
        archive_id: String,
        /// The in-archive id that collided (a validated-safe logical path).
        member_id: String,
    },
    /// A plain archive admitted with no extracted members — nothing to serve.
    EmptyHandoff {
        /// The redacted archive id.
        archive_id: String,
    },
}

impl Xp3HandoffDiagnostic {
    /// Stable semantic code for this diagnostic.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::OutOfProfileArchive { .. } => "utsushi.vfs.xp3_handoff.out_of_profile_archive",
            Self::UnsafeMemberId { .. } => "utsushi.vfs.xp3_handoff.unsafe_member_id",
            Self::DuplicateMemberId { .. } => "utsushi.vfs.xp3_handoff.duplicate_member_id",
            Self::EmptyHandoff { .. } => "utsushi.vfs.xp3_handoff.empty_handoff",
        }
    }

    /// Serialize to stable, redaction-swept JSON (secret-refs / hashes only, no
    /// keys, no local paths). This is the committable rejection evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

impl std::fmt::Display for Xp3HandoffDiagnostic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::OutOfProfileArchive {
                archive_id,
                profile,
                detail,
            } => write!(
                formatter,
                "{code}: archive {archive_id} profile {} is out of profile for the VFS handoff \
                 ({detail}); no VFS reader built, no KAG runtime-evidence claim",
                profile.as_str()
            ),
            Self::UnsafeMemberId { archive_id, detail } => write!(
                formatter,
                "{code}: archive {archive_id} carries an unsafe member id ({detail})"
            ),
            Self::DuplicateMemberId {
                archive_id,
                member_id,
            } => write!(
                formatter,
                "{code}: archive {archive_id} member id {member_id} folds to a duplicate"
            ),
            Self::EmptyHandoff { archive_id } => write!(
                formatter,
                "{code}: archive {archive_id} admitted plain but carries no extracted members"
            ),
        }
    }
}

impl std::error::Error for Xp3HandoffDiagnostic {}

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
    if member_id.len() > super::id::MAX_ASSET_ID_BYTES {
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
        if segment.len() > super::id::MAX_ASSET_ID_SEGMENT_BYTES {
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

/// Serialize a value to compact JSON and run the substrate's local-path
/// redaction sweep over the serialized form.
fn stable_redacted_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json_value = serde_json::to_value(value)
        .map_err(|error| format!("xp3 handoff report serialization failed: {error}"))?;
    reject_unredacted_local_paths("", &json_value)
        .map_err(|error| format!("xp3 handoff report failed redaction sweep: {error}"))?;
    serde_json::to_string(&json_value)
        .map_err(|error| format!("xp3 handoff report re-serialization failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::RuntimeVfs;

    fn hash(bytes: &[u8]) -> ProofHash {
        ProofHash::commit(bytes)
    }

    fn plain_manifest() -> Xp3HandoffManifest {
        Xp3HandoffManifest::new(
            "public-fixture:kirikiri-plain-xp3",
            Xp3HandoffProfile::PlainExtracted,
            hash(b"synthetic-plain-xp3-bytes"),
        )
        .with_member(Xp3ExtractedMember::new(
            "scenario/intro.ks",
            b"*start\n#Alice\nHello there.\n".to_vec(),
        ))
        .with_member(Xp3ExtractedMember::new(
            "system/config.tjs",
            b"; config\n".to_vec(),
        ))
    }

    #[test]
    fn plain_handoff_admits_and_serves_members_through_the_vfs() {
        let admission = admit_xp3_handoff(plain_manifest()).expect("plain handoff admits");
        assert_eq!(admission.member_count(), 2);

        let vfs = admission.mount();
        let id = vfs.resolve("scenario/intro.ks").expect("resolve member");
        let bytes = vfs.open(&id).expect("open member");
        assert_eq!(bytes.as_slice(), b"*start\n#Alice\nHello there.\n");

        // Case-folded resolution reaches the same member.
        let folded = vfs
            .resolve("SCENARIO/INTRO.KS")
            .expect("case-folded resolve");
        assert_eq!(folded.path(), "scenario/intro.ks");
    }

    #[test]
    fn out_of_profile_archive_is_refused_before_any_reader() {
        for profile in [
            Xp3HandoffProfile::Encrypted,
            Xp3HandoffProfile::HelperRequired,
            Xp3HandoffProfile::Unsupported,
        ] {
            let manifest = Xp3HandoffManifest::new(
                "public-fixture:kirikiri-encrypted-xp3",
                profile,
                hash(b"synthetic-encrypted-xp3-bytes"),
            )
            .with_member(Xp3ExtractedMember::new("scenario/intro.ks", b"x".to_vec()));
            let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
            match diagnostic {
                Xp3HandoffDiagnostic::OutOfProfileArchive {
                    profile: refused, ..
                } => assert_eq!(refused, profile),
                other => panic!("expected OutOfProfileArchive, got {other:?}"),
            }
        }
    }

    #[test]
    fn out_of_profile_diagnostic_serializes_cleanly() {
        let manifest = Xp3HandoffManifest::new(
            "public-fixture:kirikiri-encrypted-xp3",
            Xp3HandoffProfile::Encrypted,
            hash(b"bytes"),
        )
        .with_key_ref(SecretRef::new("local-secret:kirikiri.archive.key.v1").unwrap())
        .with_member(Xp3ExtractedMember::new("scenario/intro.ks", b"x".to_vec()));
        let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
        assert_eq!(
            diagnostic.semantic_code(),
            "utsushi.vfs.xp3_handoff.out_of_profile_archive"
        );
        let json = diagnostic.stable_json().expect("stable json");
        // The serde `tag = "code"` carries the camelCase variant discriminant.
        assert!(json.contains("outOfProfileArchive"));
        // No raw key / local path leaked into the rejection evidence.
        assert!(!json.contains("/home/"));
    }

    #[test]
    fn metadata_report_carries_secret_ref_and_hash_but_no_key_or_path() {
        let key_bytes = b"THIS-IS-RAW-ARCHIVE-KEY-MATERIAL";
        let manifest = plain_manifest()
            .with_key_ref(SecretRef::new("local-secret:kirikiri.archive.key.v1").unwrap());
        let admission = admit_xp3_handoff(manifest).expect("admit");
        let metadata = admission.metadata();
        let json = metadata.stable_json().expect("stable json");

        // The secret-ref and content hash are present.
        assert!(json.contains("local-secret:kirikiri.archive.key.v1"));
        assert!(json.contains(admission.metadata().content_hash.as_str()));
        // In-archive member ids survive (they are logical paths, not secrets).
        assert!(json.contains("scenario/intro.ks"));
        // No raw key material.
        assert!(!json.contains(std::str::from_utf8(key_bytes).unwrap()));
        assert_eq!(metadata.redaction_status, "redacted");
    }

    #[test]
    fn unsafe_member_id_is_refused() {
        for bad in ["../escape.ks", "/abs.ks", "a/../b.ks", "dir/"] {
            let manifest = Xp3HandoffManifest::new(
                "public-fixture:plain",
                Xp3HandoffProfile::PlainExtracted,
                hash(b"x"),
            )
            .with_member(Xp3ExtractedMember::new(bad, b"x".to_vec()));
            let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
            assert!(
                matches!(diagnostic, Xp3HandoffDiagnostic::UnsafeMemberId { .. }),
                "bad id {bad} should be refused, got {diagnostic:?}"
            );
        }
    }

    #[test]
    fn duplicate_case_folded_member_id_is_refused() {
        let manifest = Xp3HandoffManifest::new(
            "public-fixture:plain",
            Xp3HandoffProfile::PlainExtracted,
            hash(b"x"),
        )
        .with_member(Xp3ExtractedMember::new("scenario/Intro.ks", b"a".to_vec()))
        .with_member(Xp3ExtractedMember::new("scenario/intro.ks", b"b".to_vec()));
        let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
        assert!(matches!(
            diagnostic,
            Xp3HandoffDiagnostic::DuplicateMemberId { .. }
        ));
    }

    #[test]
    fn empty_plain_handoff_is_refused() {
        let manifest = Xp3HandoffManifest::new(
            "public-fixture:plain",
            Xp3HandoffProfile::PlainExtracted,
            hash(b"x"),
        );
        let diagnostic = admit_xp3_handoff(manifest).expect_err("must refuse");
        assert!(matches!(
            diagnostic,
            Xp3HandoffDiagnostic::EmptyHandoff { .. }
        ));
    }

    #[test]
    fn archive_reader_index_is_built_once() {
        let admission = admit_xp3_handoff(plain_manifest()).expect("admit");
        let reader = admission.archive_reader();
        let first = std::ptr::from_ref(reader.case_folded_index().unwrap());
        let second = std::ptr::from_ref(reader.case_folded_index().unwrap());
        assert_eq!(first, second, "OnceLock must hand back the same index");
    }

    #[test]
    fn secret_ref_rejects_bad_shapes() {
        assert!(SecretRef::new("local-secret:kirikiri.key.v1").is_ok());
        assert!(SecretRef::new("plain-key").is_err());
        assert!(SecretRef::new("local-secret:/home/user/key").is_err());
        assert!(SecretRef::new("local-secret:../escape").is_err());
        assert!(SecretRef::new("bogus:name").is_err());
    }

    #[test]
    fn descriptor_reports_composite_backed_handoff_package() {
        let admission = admit_xp3_handoff(plain_manifest()).expect("admit");
        let vfs = admission.mount();
        let descriptors = vfs.packages();
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].id, XP3_HANDOFF_PACKAGE_ID);
    }
}
