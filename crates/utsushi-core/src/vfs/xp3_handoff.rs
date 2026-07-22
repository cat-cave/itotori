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

#[path = "xp3_handoff/admission.rs"]
mod admission;
pub use admission::{
    Xp3HandoffAdmission, Xp3HandoffArchiveReader, Xp3HandoffMetadata, admit_xp3_handoff,
};

#[cfg(test)]
#[path = "xp3_handoff/tests.rs"]
mod tests;
