use super::*;

// Plain XP3 deterministic writer
// The writer covers the WRITE side of the plain-XP3 patch-back
// claim. established the read-side classification (plain /
// encrypted / compressed / helper-required / unsupported-protected-executable) and
// scoped patch_back to plain XP3 only. adds the
// `archive_rebuild_plain` write surface: take a source-fidelity manifest
// of a plain XP3 archive (entry order, per-segment metadata, stored
// adler32, raw segment payloads) and emit a deterministic XP3 byte
// stream. Rebuilding from an unchanged manifest produces the same bytes
// as the source archive — round-trip is byte-identical.
// The writer never decrypts, never re-encrypts, and never recompresses.
// Compressed segments are passed through verbatim; the writer does not
// claim a decompression or compression capability. Encrypted,
// helper-required, and protected-executable inputs are rejected at
// [`unpack_plain_xp3_to_directory`] before any write surface is exposed.

/// Patch-back mode declared by a writer capability tuple.
/// introduces [`PatchBackMode::ArchiveRebuildPlain`] as the
/// first concrete writer surface: deterministic rebuild of a plain XP3
/// archive from a source-fidelity manifest. No other variant is claimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchBackMode {
    /// Plain XP3 rebuild: the writer takes a manifest produced by
    /// [`unpack_plain_xp3_to_directory`] (or constructed by hand) and
    /// emits a byte-identical archive when the manifest is unchanged.
    ArchiveRebuildPlain,
}

impl PatchBackMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArchiveRebuildPlain => "archive_rebuild_plain",
        }
    }
}

/// Writer capability tuple recorded by the plain XP3 writer.
/// Per the spec acceptance criterion: "Writer capability tuple records
/// patch_back_mode=archive_rebuild_plain". This is a tuple (not a
/// freeform capability map) so the orchestrator can pattern-match on the
/// declared mode without re-parsing capability reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3WriterCapability {
    pub adapter_id: &'static str,
    pub variant: &'static str,
    pub patch_back_mode: PatchBackMode,
}

/// Adapter id under which the writer registers its capability
/// tuple. Distinct from the detector adapter id so callers can
/// fan capability claims across read and write surfaces independently.
pub const PLAIN_XP3_WRITER_ADAPTER_ID: &str = "kaifuu.kirikiri-xp3.plain-writer";

/// Plain-XP3 variant string the writer claims patch-back for.
pub const PLAIN_XP3_WRITER_VARIANT: &str = "plain";

/// Return the writer capability tuple for the plain XP3
/// writer. Always declares
/// `patch_back_mode = PatchBackMode::ArchiveRebuildPlain`; no other
/// variant is claimed.
pub const fn plain_xp3_writer_capability() -> PlainXp3WriterCapability {
    PlainXp3WriterCapability {
        adapter_id: PLAIN_XP3_WRITER_ADAPTER_ID,
        variant: PLAIN_XP3_WRITER_VARIANT,
        patch_back_mode: PatchBackMode::ArchiveRebuildPlain,
    }
}

/// Source-fidelity archive structure used by the deterministic writer.
/// Unlike [`PlainXp3Inventory`] (which sorts entries by path and hashes
/// payloads for reporting), [`PlainXp3Archive`] preserves the **source
/// order** of entries and the raw bytes of each segment so the writer
/// can produce a byte-identical rebuild. The struct is the canonical
/// in-memory representation passed between [`read_plain_xp3_archive`]
/// and [`encode_xp3`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3Archive {
    pub schema_version: String,
    pub variant: String,
    pub entries: Vec<PlainXp3ArchiveEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3ArchiveEntry {
    pub path: String,
    pub original_size: u64,
    pub archive_size: u64,
    /// `Some(value)` when the source File chunk carried an `adlr` chunk;
    /// `None` otherwise. The writer preserves this faithfully — absent
    /// adlr chunks are not synthesized.
    pub stored_adler32: Option<u32>,
    pub segments: Vec<PlainXp3ArchiveSegment>,
    /// Concatenated raw segment payloads in source order. The
    /// [`encode_xp3`] writer slices this back into segments by
    /// [`PlainXp3ArchiveSegment::archive_size`].
    #[serde(with = "plain_xp3_payload_serde")]
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3ArchiveSegment {
    pub flags: u32,
    pub original_size: u64,
    pub archive_size: u64,
}

impl PlainXp3ArchiveSegment {
    /// Returns whether the segment is marked compressed (low bit of flags).
    /// The writer does not decompress; this is exposed so callers can
    /// detect compressed-unknown variants before requesting a payload
    /// replacement.
    pub fn is_compressed(&self) -> bool {
        self.flags & 1 != 0
    }
}

mod plain_xp3_payload_serde {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex_encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let hex = String::deserialize(deserializer)?;
        hex_decode(&hex).map_err(serde::de::Error::custom)
    }

    fn hex_encode(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(output, "{byte:02x}");
        }
        output
    }

    fn hex_decode(input: &str) -> Result<Vec<u8>, String> {
        if !input.len().is_multiple_of(2) {
            return Err("hex payload length must be even".to_string());
        }
        let mut output = Vec::with_capacity(input.len() / 2);
        for index in (0..input.len()).step_by(2) {
            let pair = &input[index..index + 2];
            output.push(
                u8::from_str_radix(pair, 16)
                    .map_err(|_| format!("invalid hex byte at offset {index}"))?,
            );
        }
        Ok(output)
    }
}

/// Errors emitted by the plain XP3 writer.
/// Each variant carries enough context for the CLI to surface a
/// semantic diagnostic without leaking secrets or fixture paths. The
/// `Unsupported*` variants are routed before any write side effect —
/// the writer never opens an output file when one of those is raised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlainXp3WriterError {
    /// The source bytes carry encrypted XP3 markers. The writer refuses
    /// to surface an unpack/repack path and forwards the
    /// `kaifuu.unsupported_variant.encrypted` semantic code.
    UnsupportedEncrypted,
    /// The source bytes carry compressed/packed XP3 markers. The writer
    /// refuses to surface an unpack/repack path and forwards the
    /// `kaifuu.unsupported_variant.packed` semantic code.
    UnsupportedCompressed,
    /// The source bytes carry helper-required markers. The writer
    /// refuses to surface an unpack/repack path and forwards the
    /// `kaifuu.helper_required` semantic code.
    UnsupportedHelperRequired,
    /// The source bytes do not start with [`XP3_PLAIN_MAGIC`] and don't
    /// match any other recognized routing marker — the writer treats
    /// this as an unsupported / unknown container and refuses to claim
    /// patch-back.
    UnsupportedProtectedExecutable,
    /// The manifest declares a non-plain `variant` (anything other than
    /// `"plain"`). Forwards the
    /// `kaifuu.unsupported_engine_variant` semantic code.
    UnsupportedVariant(String),
    /// The manifest carries a compressed segment for an entry whose
    /// payload has been replaced (segment archive_size no longer
    /// matches the payload slice length). does not claim
    /// any recompression capability, so this is rejected with the
    /// `kaifuu.unsupported_variant.packed` semantic code.
    UnsupportedCompressedReplacement(String),
    /// Inventory read error encountered while unpacking source bytes.
    InventoryError(PlainXp3InventoryError),
    /// Sizes recorded in the manifest do not match payload byte counts.
    InconsistentManifest(String),
    /// I/O error while reading or writing the directory layout.
    Io(String),
    /// The manifest carries a path that fails Kaifuu's safe-relative-path
    /// rule (see [`validate_safe_relative_path`]).
    UnsafeRelativePath(String),
    /// A path component under the unpack/output root resolved through a
    /// symlink while materializing a payload/manifest file. The read/write was
    /// refused (fd-relative `O_NOFOLLOW` descent) so it could never escape the
    /// intended root. The string is the manifest-declared relative path that
    /// was being materialized. Distinct from [`UnsafeRelativePath`], which is a
    /// pure string-level check: this variant is the real materialization guard
    /// and fires even when the string looked safe but a symlink was planted in
    /// the directory tree (TOCTOU / symlink-traversal hardening).
    SymlinkTraversalRefused(String),
    /// Manifest JSON could not be parsed.
    ManifestParse(String),
}

impl fmt::Display for PlainXp3WriterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedEncrypted => formatter.write_str(
                "encrypted XP3 archives are not writable by the plain-XP3 writer (semantic: kaifuu.unsupported_variant.encrypted)",
            ),
            Self::UnsupportedCompressed => formatter.write_str(
                "compressed XP3 archives are not writable by the plain-XP3 writer (semantic: kaifuu.unsupported_variant.packed)",
            ),
            Self::UnsupportedHelperRequired => formatter.write_str(
                "helper-required XP3 archives are not writable by the plain-XP3 writer (semantic: kaifuu.helper_required)",
            ),
            Self::UnsupportedProtectedExecutable => formatter.write_str(
                "protected-executable / unknown XP3 containers are not writable (semantic: kaifuu.protected_executable_unsupported)",
            ),
            Self::UnsupportedVariant(variant) => write!(
                formatter,
                "manifest variant {variant:?} is not supported by the plain-XP3 writer (semantic: kaifuu.unsupported_engine_variant)"
            ),
            Self::UnsupportedCompressedReplacement(path) => write!(
                formatter,
                "compressed XP3 entry {path:?} cannot have its payload replaced — the writer does not claim recompression (semantic: kaifuu.unsupported_variant.packed)"
            ),
            Self::InventoryError(error) => write!(formatter, "plain XP3 inventory error: {error}"),
            Self::InconsistentManifest(message) => {
                write!(formatter, "inconsistent plain XP3 manifest: {message}")
            }
            Self::Io(message) => write!(formatter, "plain XP3 writer I/O error: {message}"),
            Self::UnsafeRelativePath(path) => {
                write!(formatter, "unsafe relative manifest path {path:?}")
            }
            Self::SymlinkTraversalRefused(path) => write!(
                formatter,
                "refused symlink traversal materializing manifest path {path:?}: a component under the unpack root is a symlink (semantic: kaifuu.plain_xp3_writer.symlink_traversal_refused)"
            ),
            Self::ManifestParse(message) => {
                write!(formatter, "plain XP3 manifest parse error: {message}")
            }
        }
    }
}

impl std::error::Error for PlainXp3WriterError {}

impl PlainXp3WriterError {
    /// Semantic code (one of the existing `SEMANTIC_*` constants) that
    /// a CLI / orchestrator diagnostic should surface for the error.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedEncrypted => SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED,
            Self::UnsupportedCompressed | Self::UnsupportedCompressedReplacement(_) => {
                SEMANTIC_UNSUPPORTED_VARIANT_PACKED
            }
            Self::UnsupportedHelperRequired => SEMANTIC_HELPER_REQUIRED,
            Self::UnsupportedProtectedExecutable => SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            Self::UnsupportedVariant(_) => SEMANTIC_UNSUPPORTED_ENGINE_VARIANT,
            Self::SymlinkTraversalRefused(_) => "kaifuu.plain_xp3_writer.symlink_traversal_refused",
            Self::InventoryError(_)
            | Self::InconsistentManifest(_)
            | Self::Io(_)
            | Self::UnsafeRelativePath(_)
            | Self::ManifestParse(_) => "kaifuu.plain_xp3_writer.error",
        }
    }
}

/// Plain-XP3 manifest variant identifier written to disk.
pub const PLAIN_XP3_MANIFEST_VARIANT: &str = "plain";

/// Plain-XP3 manifest schema version.
pub const PLAIN_XP3_MANIFEST_SCHEMA_VERSION: &str = "0.1.0";
