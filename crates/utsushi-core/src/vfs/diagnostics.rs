//! Semantic diagnostics for runtime VFS failures.
//!
//! Every variant carries enough context to be a stable conformance signal,
//! and every variant carries an [`AssetId`] (or a package id) — never a raw
//! host path. `Display` output is redaction-safe by construction: it contains
//! only the semantic code, the `AssetId` (which is `vfs://` scoped and
//! engine-neutral), and the package id (a registered public name).

use std::fmt;

use serde::Serialize;

use super::id::AssetId;

/// Stable Utsushi runtime VFS semantic codes.
pub mod codes {
    pub const ASSET_MISSING: &str = "utsushi.vfs.asset_missing";
    pub const ASSET_OUTSIDE_PACKAGE: &str = "utsushi.vfs.asset_outside_package";
    pub const ASSET_PATH_UNSAFE: &str = "utsushi.vfs.asset_path_unsafe";
    pub const ASSET_ENCRYPTED: &str = "utsushi.vfs.asset_encrypted";
    pub const ASSET_HELPER_GATED: &str = "utsushi.vfs.asset_helper_gated";
    pub const ASSET_TRANSFORM_UNSUPPORTED: &str = "utsushi.vfs.asset_transform_unsupported";
    pub const ASSET_NOT_DIRECTORY: &str = "utsushi.vfs.asset_not_directory";
    pub const ASSET_NOT_FILE: &str = "utsushi.vfs.asset_not_file";
    pub const PACKAGE_IO: &str = "utsushi.vfs.package_io";
    pub const RESOURCE_BOUND: &str = "utsushi.vfs.resource_bound";
    pub const INVALID_ASSET_ID: &str = "utsushi.vfs.invalid_asset_id";

    /// The full list of stable Utsushi VFS semantic codes. Conformance
    /// schemas that gate runtime diagnostics by allowed-code list should
    /// include each of these.
    pub const ALL: &[&str] = &[
        ASSET_MISSING,
        ASSET_OUTSIDE_PACKAGE,
        ASSET_PATH_UNSAFE,
        ASSET_ENCRYPTED,
        ASSET_HELPER_GATED,
        ASSET_TRANSFORM_UNSUPPORTED,
        ASSET_NOT_DIRECTORY,
        ASSET_NOT_FILE,
        PACKAGE_IO,
        RESOURCE_BOUND,
        INVALID_ASSET_ID,
    ];
}

/// Kaifuu shared semantic codes referenced from VFS diagnostics. Kept as
/// `pub(crate)` literals so we never drift from the kaifuu-core values; they
/// are duplicated as string constants (and not re-exported) to avoid making
/// `utsushi-core` depend on `kaifuu-core`.
mod kaifuu_codes {
    pub const MISSING_KEY_PROFILE: &str = "kaifuu.missing_capability.key_profile";
    pub const MISSING_KEY_MATERIAL: &str = "kaifuu.missing_key_material";
    pub const MISSING_CRYPTO_CAPABILITY: &str = "kaifuu.missing_capability.crypto";
    pub const MISSING_CONTAINER_CAPABILITY: &str = "kaifuu.missing_capability.container";
    pub const MISSING_CODEC_CAPABILITY: &str = "kaifuu.missing_capability.codec";
    pub const HELPER_UNAVAILABLE: &str = "kaifuu.helper_unavailable";
    pub const UNSUPPORTED_LAYERED_TRANSFORM: &str = "kaifuu.unsupported_layered_transform";
}

/// Runtime VFS diagnostic enum.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VfsError {
    /// The asset id is structurally invalid.
    InvalidAssetId {
        raw: String,
        reason: AssetIdErrorReason,
    },
    /// The asset does not exist in the requested package.
    AssetMissing { id: AssetId },
    /// The asset id points at a package that is not mounted, or at a path
    /// that escapes its package root.
    AssetOutsidePackage { id: AssetId, package: String },
    /// The logical path attempts a forbidden traversal pattern.
    AssetPathUnsafe {
        package: String,
        logical: String,
        kind: TraversalKind,
    },
    /// The asset is encrypted and the required key/profile capability is
    /// not satisfied.
    AssetEncrypted {
        id: AssetId,
        required_capability: RequiredCapability,
    },
    /// The asset can only be accessed via a bounded helper that is not
    /// available in this run.
    AssetHelperGated { id: AssetId, helper_id: HelperId },
    /// The package cannot decode this asset because the codec or container
    /// transform is unsupported.
    AssetTransformUnsupported {
        id: AssetId,
        transform: TransformKind,
    },
    /// The package was queried for `list` on a non-directory id.
    AssetNotDirectory { id: AssetId },
    /// A read attempted on a directory id.
    AssetNotFile { id: AssetId },
    /// The package's underlying store reported an I/O failure that is not a
    /// missing-file case. The raw OS error message is REDACTED in the
    /// public form; only the [`IoSummary`] enum remains.
    PackageIo { id: AssetId, summary: IoSummary },
    /// The asset id is well-formed but exceeds an implementation-imposed
    /// bound.
    ResourceBound {
        id: AssetId,
        bound: ResourceBoundKind,
    },
}

/// `Result` alias used throughout the VFS module surface.
pub type VfsResult<T> = Result<T, VfsError>;

/// Forbidden traversal-pattern classifier surfaced through
/// [`VfsError::AssetPathUnsafe`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TraversalKind {
    ParentEscape,
    AbsoluteRoot,
    ControlCharacter,
    NulByte,
    BackslashSeparator,
    EmptySegment,
    OverlongSegment,
}

impl TraversalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ParentEscape => "parent_escape",
            Self::AbsoluteRoot => "absolute_root",
            Self::ControlCharacter => "control_character",
            Self::NulByte => "nul_byte",
            Self::BackslashSeparator => "backslash_separator",
            Self::EmptySegment => "empty_segment",
            Self::OverlongSegment => "overlong_segment",
        }
    }
}

/// Capability class required to read an [`VfsError::AssetEncrypted`] asset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RequiredCapability {
    KeyProfile,
    KeyMaterial,
    Crypto,
    Container,
}

impl RequiredCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeyProfile => "key_profile",
            Self::KeyMaterial => "key_material",
            Self::Crypto => "crypto",
            Self::Container => "container",
        }
    }

    fn kaifuu_code(self) -> &'static str {
        match self {
            Self::KeyProfile => kaifuu_codes::MISSING_KEY_PROFILE,
            Self::KeyMaterial => kaifuu_codes::MISSING_KEY_MATERIAL,
            Self::Crypto => kaifuu_codes::MISSING_CRYPTO_CAPABILITY,
            Self::Container => kaifuu_codes::MISSING_CONTAINER_CAPABILITY,
        }
    }
}

/// Layered-transform class surfaced through
/// [`VfsError::AssetTransformUnsupported`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TransformKind {
    Container,
    Crypto,
    Codec,
}

impl TransformKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Container => "container",
            Self::Crypto => "crypto",
            Self::Codec => "codec",
        }
    }

    fn kaifuu_code(self) -> &'static str {
        match self {
            Self::Container => kaifuu_codes::MISSING_CONTAINER_CAPABILITY,
            Self::Crypto => kaifuu_codes::UNSUPPORTED_LAYERED_TRANSFORM,
            Self::Codec => kaifuu_codes::MISSING_CODEC_CAPABILITY,
        }
    }
}

/// Stable public identifier of a bounded helper class. Never a path.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HelperId {
    Named(String),
}

impl HelperId {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Named(name) => name.as_str(),
        }
    }
}

impl fmt::Display for HelperId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Opaque I/O failure classifier. The raw OS error message is intentionally
/// dropped at the boundary; only this enum is preserved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IoSummary {
    NotFound,
    PermissionDenied,
    UnexpectedEof,
    Other,
}

impl IoSummary {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::PermissionDenied => "permission_denied",
            Self::UnexpectedEof => "unexpected_eof",
            Self::Other => "other",
        }
    }

    /// Map a `std::io::ErrorKind` to an opaque summary, intentionally dropping
    /// the original error message at the boundary.
    pub fn from_io_error_kind(kind: std::io::ErrorKind) -> Self {
        match kind {
            std::io::ErrorKind::NotFound => Self::NotFound,
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            std::io::ErrorKind::UnexpectedEof => Self::UnexpectedEof,
            _ => Self::Other,
        }
    }
}

/// Implementation-imposed resource bound surfaced through
/// [`VfsError::ResourceBound`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ResourceBoundKind {
    FileSizeCap,
    ListCardinalityCap,
    RecursionCap,
}

impl ResourceBoundKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FileSizeCap => "file_size_cap",
            Self::ListCardinalityCap => "list_cardinality_cap",
            Self::RecursionCap => "recursion_cap",
        }
    }
}

/// Reason an asset id failed to parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AssetIdErrorReason {
    MissingScheme,
    EmptyPackage,
    BadPackageChar,
    EmptySegment,
    ParentSegment,
    DotSegment,
    ControlCharacter,
    NulByte,
    BackslashSeparator,
    OverlongSegment,
    OverlongTotal,
}

impl AssetIdErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingScheme => "missing_scheme",
            Self::EmptyPackage => "empty_package",
            Self::BadPackageChar => "bad_package_char",
            Self::EmptySegment => "empty_segment",
            Self::ParentSegment => "parent_segment",
            Self::DotSegment => "dot_segment",
            Self::ControlCharacter => "control_character",
            Self::NulByte => "nul_byte",
            Self::BackslashSeparator => "backslash_separator",
            Self::OverlongSegment => "overlong_segment",
            Self::OverlongTotal => "overlong_total",
        }
    }
}

/// Serializable reference to an asset (or package) suitable for inclusion in
/// `RuntimeAdapterDiagnostic` and `ObservationErrorPayload`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    /// The full `vfs://...` form, or `None` when the original id failed to
    /// parse (in which case `package` is also `None`).
    pub asset_id: Option<String>,
    /// The package id portion, where available.
    pub package: Option<String>,
}

impl AssetRef {
    pub fn from_id(id: &AssetId) -> Self {
        Self {
            asset_id: Some(id.as_str().to_string()),
            package: Some(id.package().to_string()),
        }
    }

    pub fn from_package(package: impl Into<String>) -> Self {
        Self {
            asset_id: None,
            package: Some(package.into()),
        }
    }

    pub fn unknown() -> Self {
        Self {
            asset_id: None,
            package: None,
        }
    }
}

impl VfsError {
    /// Stable Utsushi semantic code, e.g. `"utsushi.vfs.asset_missing"`.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::InvalidAssetId { .. } => codes::INVALID_ASSET_ID,
            Self::AssetMissing { .. } => codes::ASSET_MISSING,
            Self::AssetOutsidePackage { .. } => codes::ASSET_OUTSIDE_PACKAGE,
            Self::AssetPathUnsafe { .. } => codes::ASSET_PATH_UNSAFE,
            Self::AssetEncrypted { .. } => codes::ASSET_ENCRYPTED,
            Self::AssetHelperGated { .. } => codes::ASSET_HELPER_GATED,
            Self::AssetTransformUnsupported { .. } => codes::ASSET_TRANSFORM_UNSUPPORTED,
            Self::AssetNotDirectory { .. } => codes::ASSET_NOT_DIRECTORY,
            Self::AssetNotFile { .. } => codes::ASSET_NOT_FILE,
            Self::PackageIo { .. } => codes::PACKAGE_IO,
            Self::ResourceBound { .. } => codes::RESOURCE_BOUND,
        }
    }

    /// Shared kaifuu code where applicable. `None` for purely VFS-level
    /// failures.
    pub fn kaifuu_code(&self) -> Option<&'static str> {
        match self {
            Self::AssetEncrypted {
                required_capability,
                ..
            } => Some(required_capability.kaifuu_code()),
            Self::AssetHelperGated { .. } => Some(kaifuu_codes::HELPER_UNAVAILABLE),
            Self::AssetTransformUnsupported { transform, .. } => Some(transform.kaifuu_code()),
            _ => None,
        }
    }

    /// Asset reference suitable for inclusion in diagnostic reports.
    pub fn asset_ref(&self) -> AssetRef {
        match self {
            Self::InvalidAssetId { .. } => AssetRef::unknown(),
            Self::AssetMissing { id }
            | Self::AssetEncrypted { id, .. }
            | Self::AssetHelperGated { id, .. }
            | Self::AssetTransformUnsupported { id, .. }
            | Self::AssetNotDirectory { id }
            | Self::AssetNotFile { id }
            | Self::PackageIo { id, .. }
            | Self::ResourceBound { id, .. } => AssetRef::from_id(id),
            Self::AssetOutsidePackage { id, package } => AssetRef {
                asset_id: Some(id.as_str().to_string()),
                package: Some(package.clone()),
            },
            Self::AssetPathUnsafe { package, .. } => AssetRef::from_package(package.clone()),
        }
    }

    /// Operator-facing debug rendering. Without the `vfs_debug` feature flag
    /// this is identical to [`Display`].
    pub fn debug_render(&self) -> String {
        // Slice A intentionally does not enable a host-path debug channel;
        // see plan §5 for rationale. The `vfs_debug` feature is reserved for a
        // follow-up node.
        self.to_string()
    }
}

impl fmt::Display for VfsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::InvalidAssetId { reason, .. } => write!(
                formatter,
                "{code}: invalid asset id (reason={})",
                reason.as_str()
            ),
            Self::AssetMissing { id } => write!(formatter, "{code}: asset id={id}"),
            Self::AssetOutsidePackage { id, package } => {
                write!(formatter, "{code}: asset id={id} package={package}")
            }
            Self::AssetPathUnsafe {
                package,
                logical: _,
                kind,
            } => write!(
                formatter,
                "{code}: package={package} kind={}",
                kind.as_str()
            ),
            Self::AssetEncrypted {
                id,
                required_capability,
            } => write!(
                formatter,
                "{code}: asset id={id} required_capability={}",
                required_capability.as_str()
            ),
            Self::AssetHelperGated { id, helper_id } => {
                write!(formatter, "{code}: asset id={id} helper_id={helper_id}")
            }
            Self::AssetTransformUnsupported { id, transform } => write!(
                formatter,
                "{code}: asset id={id} transform={}",
                transform.as_str()
            ),
            Self::AssetNotDirectory { id } => write!(formatter, "{code}: asset id={id}"),
            Self::AssetNotFile { id } => write!(formatter, "{code}: asset id={id}"),
            Self::PackageIo { id, summary } => write!(
                formatter,
                "{code}: asset id={id} summary={}",
                summary.as_str()
            ),
            Self::ResourceBound { id, bound } => {
                write!(formatter, "{code}: asset id={id} bound={}", bound.as_str())
            }
        }
    }
}

impl std::error::Error for VfsError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset_id(raw: &str) -> AssetId {
        AssetId::parse(raw).expect("test asset id parses")
    }

    #[test]
    fn asset_missing_carries_asset_id_and_stable_code() {
        let error = VfsError::AssetMissing {
            id: asset_id("vfs://hello/intro.txt"),
        };
        assert_eq!(error.semantic_code(), "utsushi.vfs.asset_missing");
        let asset_ref = error.asset_ref();
        assert_eq!(asset_ref.asset_id.as_deref(), Some("vfs://hello/intro.txt"));
        assert_eq!(asset_ref.package.as_deref(), Some("hello"));
        assert!(error.kaifuu_code().is_none());
    }

    #[test]
    fn asset_outside_package_carries_package_id() {
        let error = VfsError::AssetOutsidePackage {
            id: asset_id("vfs://unknown/intro.txt"),
            package: "unknown".to_string(),
        };
        assert_eq!(error.semantic_code(), "utsushi.vfs.asset_outside_package");
        let asset_ref = error.asset_ref();
        assert_eq!(asset_ref.package.as_deref(), Some("unknown"));
    }

    #[test]
    fn asset_encrypted_carries_required_capability() {
        let error = VfsError::AssetEncrypted {
            id: asset_id("vfs://hello/encrypted/locked.bin"),
            required_capability: RequiredCapability::Crypto,
        };
        assert_eq!(error.semantic_code(), "utsushi.vfs.asset_encrypted");
        assert_eq!(
            error.kaifuu_code(),
            Some("kaifuu.missing_capability.crypto")
        );
    }

    #[test]
    fn asset_encrypted_key_material_maps_to_kaifuu_missing_key_material() {
        let error = VfsError::AssetEncrypted {
            id: asset_id("vfs://hello/encrypted/locked.bin"),
            required_capability: RequiredCapability::KeyMaterial,
        };
        assert_eq!(error.kaifuu_code(), Some("kaifuu.missing_key_material"));
    }

    #[test]
    fn asset_helper_gated_carries_helper_id() {
        let error = VfsError::AssetHelperGated {
            id: asset_id("vfs://hello/remote.bin"),
            helper_id: HelperId::Named("wine-windows-helper".to_string()),
        };
        assert_eq!(error.semantic_code(), "utsushi.vfs.asset_helper_gated");
        assert_eq!(error.kaifuu_code(), Some("kaifuu.helper_unavailable"));
        let rendered = error.to_string();
        assert!(
            rendered.contains("wine-windows-helper"),
            "rendered display should contain helper id: {rendered}"
        );
    }

    #[test]
    fn asset_transform_unsupported_maps_to_kaifuu_code() {
        let crypto = VfsError::AssetTransformUnsupported {
            id: asset_id("vfs://hello/data.bin"),
            transform: TransformKind::Crypto,
        };
        assert_eq!(
            crypto.kaifuu_code(),
            Some("kaifuu.unsupported_layered_transform")
        );

        let codec = VfsError::AssetTransformUnsupported {
            id: asset_id("vfs://hello/data.bin"),
            transform: TransformKind::Codec,
        };
        assert_eq!(codec.kaifuu_code(), Some("kaifuu.missing_capability.codec"));

        let container = VfsError::AssetTransformUnsupported {
            id: asset_id("vfs://hello/data.bin"),
            transform: TransformKind::Container,
        };
        assert_eq!(
            container.kaifuu_code(),
            Some("kaifuu.missing_capability.container")
        );
    }

    #[test]
    fn package_io_summary_drops_raw_os_message() {
        let raw_os_message = "No such file or directory (os error 2) at /tmp/abc";
        let io_error =
            std::io::Error::new(std::io::ErrorKind::NotFound, raw_os_message.to_string());
        let summary = IoSummary::from_io_error_kind(io_error.kind());
        let error = VfsError::PackageIo {
            id: asset_id("vfs://hello/missing.txt"),
            summary,
        };
        let rendered = error.to_string();
        assert!(!rendered.contains(raw_os_message));
        assert!(!rendered.contains("/tmp/abc"));
        assert!(rendered.contains("not_found"));
    }

    #[test]
    fn display_output_contains_no_host_path_substrings() {
        let cases = [
            VfsError::AssetMissing {
                id: asset_id("vfs://hello/intro.txt"),
            },
            VfsError::AssetOutsidePackage {
                id: asset_id("vfs://nope/intro.txt"),
                package: "nope".to_string(),
            },
            VfsError::AssetPathUnsafe {
                package: "hello".to_string(),
                logical: "/etc/passwd".to_string(),
                kind: TraversalKind::AbsoluteRoot,
            },
            VfsError::AssetEncrypted {
                id: asset_id("vfs://hello/locked.bin"),
                required_capability: RequiredCapability::KeyProfile,
            },
            VfsError::AssetHelperGated {
                id: asset_id("vfs://hello/remote.bin"),
                helper_id: HelperId::Named("public-helper".to_string()),
            },
            VfsError::AssetTransformUnsupported {
                id: asset_id("vfs://hello/data.bin"),
                transform: TransformKind::Crypto,
            },
            VfsError::AssetNotDirectory {
                id: asset_id("vfs://hello/intro.txt"),
            },
            VfsError::AssetNotFile {
                id: asset_id("vfs://hello/dir/"),
            },
            VfsError::PackageIo {
                id: asset_id("vfs://hello/intro.txt"),
                summary: IoSummary::PermissionDenied,
            },
            VfsError::ResourceBound {
                id: asset_id("vfs://hello/big.bin"),
                bound: ResourceBoundKind::FileSizeCap,
            },
            VfsError::InvalidAssetId {
                raw: "vfs://Hello/x".to_string(),
                reason: AssetIdErrorReason::BadPackageChar,
            },
        ];
        for error in &cases {
            let rendered = error.to_string();
            for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
                assert!(
                    !rendered.contains(forbidden),
                    "rendered={rendered} contained forbidden substring {forbidden}"
                );
            }
            // The logical-path field in AssetPathUnsafe is dropped from the
            // public display because the engine-supplied logical can itself be
            // a host path leak.
            if let VfsError::AssetPathUnsafe { logical, .. } = error {
                assert!(
                    !rendered.contains(logical),
                    "logical leaked into display: {rendered}"
                );
            }
        }
    }

    #[test]
    fn debug_render_without_feature_flag_matches_display() {
        let error = VfsError::AssetMissing {
            id: asset_id("vfs://hello/intro.txt"),
        };
        assert_eq!(error.debug_render(), error.to_string());
    }

    #[test]
    fn semantic_codes_all_registered_in_module_list() {
        // Each variant produces a code that is part of the canonical list so
        // a downstream allowed-code validator can not silently drop one.
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        let variants = [
            VfsError::InvalidAssetId {
                raw: String::new(),
                reason: AssetIdErrorReason::MissingScheme,
            }
            .semantic_code(),
            VfsError::AssetMissing {
                id: asset_id("vfs://hello/intro.txt"),
            }
            .semantic_code(),
            VfsError::AssetOutsidePackage {
                id: asset_id("vfs://hello/intro.txt"),
                package: "hello".to_string(),
            }
            .semantic_code(),
            VfsError::AssetPathUnsafe {
                package: "hello".to_string(),
                logical: String::new(),
                kind: TraversalKind::NulByte,
            }
            .semantic_code(),
            VfsError::AssetEncrypted {
                id: asset_id("vfs://hello/intro.txt"),
                required_capability: RequiredCapability::Crypto,
            }
            .semantic_code(),
            VfsError::AssetHelperGated {
                id: asset_id("vfs://hello/intro.txt"),
                helper_id: HelperId::Named("a".to_string()),
            }
            .semantic_code(),
            VfsError::AssetTransformUnsupported {
                id: asset_id("vfs://hello/intro.txt"),
                transform: TransformKind::Crypto,
            }
            .semantic_code(),
            VfsError::AssetNotDirectory {
                id: asset_id("vfs://hello/intro.txt"),
            }
            .semantic_code(),
            VfsError::AssetNotFile {
                id: asset_id("vfs://hello/intro.txt"),
            }
            .semantic_code(),
            VfsError::PackageIo {
                id: asset_id("vfs://hello/intro.txt"),
                summary: IoSummary::Other,
            }
            .semantic_code(),
            VfsError::ResourceBound {
                id: asset_id("vfs://hello/intro.txt"),
                bound: ResourceBoundKind::FileSizeCap,
            }
            .semantic_code(),
        ];
        for code in variants {
            assert!(all.contains(code), "code {code} missing from codes::ALL");
        }
    }
}
