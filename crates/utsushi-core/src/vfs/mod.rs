//! Runtime virtual filesystem and asset-package boundary.
//!
//! See plan `.plan/UTSUSHI-020.md` for the design rationale. The trait
//! surface is engine-neutral, read-only, and produces redaction-safe
//! diagnostics. `RuntimeVfs` is implemented by `MountedVfs`, which routes by
//! the `<package-id>` prefix of an `AssetId` to one of its registered
//! `AssetPackage` implementations. The plaintext directory case is provided
//! as `PlaintextDirPackage`; engine-specific packages (XP3, RGSS3, RPGMVP)
//! live in their own crates and implement `AssetPackage` directly.

pub mod diagnostics;
pub mod id;
pub mod package;
pub mod runtime;

pub use diagnostics::{
    AssetIdErrorReason, AssetRef, HelperId, IoSummary, RequiredCapability, ResourceBoundKind,
    TransformKind, TraversalKind, VfsError, VfsResult, codes,
};
pub use id::{AssetId, MAX_ASSET_ID_BYTES, MAX_ASSET_ID_SEGMENT_BYTES, MAX_PACKAGE_ID_BYTES};
pub use package::{
    AssetBytes, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, PackageDescriptor,
    PackageKind, PackageSource, case_rule_matches, validate_logical_path,
};
pub use runtime::{MountedVfs, PlaintextDirPackage, RuntimeVfs};
