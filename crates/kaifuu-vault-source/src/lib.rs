//! `kaifuu-vault-source` — the read-only itotori vault-source localCorpus
//! adapter.
//!
//! See `docs/itotori-vault-source-adapter.md` (workspace root) for the
//! authoritative contract. This crate is the Rust implementation. It:
//!
//! - opens `<vault-root>/catalog.db` read-only via `rusqlite` (`mode=ro`);
//! - discovers candidate releases via the catalog;
//! - resolves artifacts via the `artifacts/by-sha/<aa>/<bb>/<hash>.7z` path
//!   layout, verifying sha256 and size;
//! - extracts archives in pure Rust via `sevenz-rust2`, rejecting unsafe
//!   entries before any byte is written to scratch;
//! - validates the embedded `_vault/metadata.json` against the vault's
//!   `embedded-metadata.schema.json` (draft 2020-12) and cross-checks
//!   selected fields against the catalog;
//! - never writes to the vault, never touches `artifacts/by-name/`, never
//!   modifies `catalog.db`.
//!
//! ## Public surface
//!
//! - [`VaultConfig`], [`ScratchConfig`], [`RetentionPolicy`]
//! - [`ClaimQuery`], [`ReleaseCandidate`]
//! - [`ResolvedArtifact`], [`ArtifactSelection`]
//! - [`ExtractedTree`], [`ScratchPaths`]
//! - [`EmbeddedMetadata`], [`EmbeddedSchema`], [`CrossCheckTolerance`],
//!   [`CrossCheckOutcome`]
//! - [`CrossCheckFinding`]
//! - [`LocalCorpusSource`], [`VaultSource`], [`MaterializeOptions`],
//!   [`MaterializeResult`], [`LocalCorpusRegistry`],
//!   [`LocalCorpusCapabilityReport`]
//! - [`VaultSourceError`] (every variant maps 1:1 to the contract's
//!   Failure Modes table)
//! - [`RunOutcome`]

#![warn(missing_docs)]

pub mod catalog;
pub mod config;
pub mod discovery;
pub mod error;
pub mod extraction;
pub mod findings;
pub mod metadata;
pub mod paths;
pub mod resolution;
pub mod retention;
pub mod source;

pub use config::{GameIdSource, RetentionPolicy, ScratchConfig, VaultConfig};
pub use discovery::{ClaimQuery, ReleaseCandidate};
pub use error::{
    SEMANTIC_VAULT_ARTIFACT_HASH_MISMATCH, SEMANTIC_VAULT_ARTIFACT_MISSING,
    SEMANTIC_VAULT_ARTIFACT_SIZE_MISMATCH, SEMANTIC_VAULT_CATALOG_EMBEDDED_MISMATCH,
    SEMANTIC_VAULT_CATALOG_OPEN_FAILED, SEMANTIC_VAULT_CATALOG_SCHEMA_UNSUPPORTED,
    SEMANTIC_VAULT_EMBEDDED_METADATA_INVALID, SEMANTIC_VAULT_EMBEDDED_METADATA_MISSING,
    SEMANTIC_VAULT_EXTRACTION_FAILED, SEMANTIC_VAULT_EXTRACTION_UNSAFE_PATH,
    SEMANTIC_VAULT_RELEASE_NOT_RESOLVED, SEMANTIC_VAULT_ROOT_INCOMPLETE,
    SEMANTIC_VAULT_ROOT_MISSING, SEMANTIC_VAULT_SCRATCH_UNWRITABLE, SUPPORTED_SCHEMA_VERSIONS,
    VaultSourceError,
};
pub use extraction::{ExtractedTree, ScratchPaths};
pub use findings::CrossCheckFinding;
pub use metadata::{CrossCheckOutcome, CrossCheckTolerance, EmbeddedMetadata, EmbeddedSchema};
pub use paths::{ExternalId, GameId, GameIdContext};
pub use resolution::{ArtifactSelection, ResolvedArtifact};
pub use retention::RunOutcome;
pub use source::{
    LocalCorpusCapabilityReport, LocalCorpusRegistry, LocalCorpusSource, MaterializeOptions,
    MaterializeResult, VaultSource,
};
