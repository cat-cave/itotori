//! Runtime virtual filesystem and asset-package boundary.
//!
//! See plan `.plan/.md` for the design rationale and
//! `docs/audits/substrate-honesty.md` §M.1 for the multiplex extension
//! that landed with. The trait surface is engine-neutral
//! read-only, and produces redaction-safe diagnostics.
//!
//! `RuntimeVfs` is implemented by `MountedVfs`, which composes one
//! canonical [`id::AssetId`] package id over an ordered, first-match-wins
//! list of plaintext directories and sealed archive readers. The
//! plaintext-directory case is provided as `PlaintextDirPackage`; archive
//! readers are deferred to follow-up engine nodes (PAK, XP3) and plug in
//! through the sealed [`archive::AssetArchiveReader`] trait.

pub mod archive;
pub mod composite;
pub mod diagnostics;
pub mod id;
pub mod package;
pub mod runtime;
pub mod xp3_handoff;

pub use archive::{AssetArchiveReader, CaseFoldedIndex, CaseFoldedIndexEntry};
pub use composite::{CompositeAssetPackage, CompositeSource};
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
pub use xp3_handoff::{
    XP3_HANDOFF_PACKAGE_ID, XP3_HANDOFF_SCHEMA_VERSION, XP3_HANDOFF_SUPPORT_BOUNDARY,
    Xp3ExtractedMember, Xp3HandoffAdmission, Xp3HandoffArchiveReader, Xp3HandoffDiagnostic,
    Xp3HandoffManifest, Xp3HandoffMetadata, Xp3HandoffProfile, admit_xp3_handoff,
};
