//! Wolf RPG Editor readiness proof.
//! This node COMBINES the two Wolf evidence sources that already exist as their
//! own honest, synthetic-fixture-driven subsystems into ONE per-capability-level
//! readiness report:
//! 1. the Wolf **protection detector**
//!    ([`crate::wolf_protection_detector`]) — magic-byte-signature detector
//!    evidence that classifies a `.wolf`/DXArchive-family container into a
//!    plain / protected / helper-required / unknown [`WolfProtectionProfile`]
//!    and advertises the `identify` (and, for a plain archive, `inventory`)
//!    rungs it may claim; and
//! 2. the Wolf **key/protection helper boundary**
//!    ([`crate::wolf_helper_boundary`]) — the local-only
//!    [`crate::HelperResult`] for a keyRef-bound profile, whose
//!    [`WolfHelperBoundaryOutcome`] (`key_resolved` / `key_missing` /
//!    `helper_required` / `helper_unavailable`) reports whether the key/helper
//!    gate is cleared.
//! # The honest capability-level ladder (never over-claimed)
//! The readiness report distinguishes SIX achieved levels
//! ([`WolfReadinessLevel`]):
//! - `identify` — the detector recognized the Wolf-shaped container.
//! - `inventory` — the detector can list the file table (plain archive).
//! - `helper_required` — the archive is gated behind the key/helper subsystem;
//!   the boundary characterized the exact requirement (or resolved the key
//!   locally by ref) but no extraction parser fixture backs a higher claim.
//! - `extract` — an explicit synthetic EXTRACT fixture proves extraction
//!   AND every lower gate is cleared.
//! - `patch` — an explicit synthetic PATCH fixture proves patch-back
//!   AND extraction is proven AND every lower gate is cleared.
//! - `unsupported` — the protection variant is unrecognized; nothing beyond
//!   a partial identify is proven.
//!   The single source of truth is [`derive_wolf_readiness_level`]: a pure,
//!   total function of the detector-derived profile, the helper-boundary outcome,
//!   and the presence of explicit extract/patch fixture proofs. It can NEVER lift
//!   an `unknown` profile above `unsupported`, and it NEVER claims `extract` or
//!   `patch` without an explicit synthetic fixture proof — the strict-proof
//!   honesty invariant (no aspirational "supported"). Real Wolf archive
//!   extraction / patch-back is a later adapter node; this readiness
//!   proof reports only what the detector + helper-boundary + explicit synthetic
//!   fixtures prove.
//! # Engine-general (Wolf = data, no per-game branch)
//! Every case is pure DATA: an embedded detector record, an optional embedded
//! helper-boundary profile, and optional synthetic extract/patch proofs. The
//! resolver runs the REAL detector and REAL helper-boundary subsystems over the
//! embedded evidence and combines their derived outputs — there is no per-game
//! branch.
//! # Evidence is synthetic, redacted, ref-only
//! Cases carry NO retail bytes and NO raw key material: only synthetic ids,
//! the detector's structured protection signal, the helper boundary's
//! local-scheme secret refs, and sha256 proof hashes. Every emitted report is
//! funnelled through [`redact_for_log_or_report`] / [`stable_json`].

#[cfg(test)]
#[path = "wolf_readiness_tests.rs"]
mod tests;
include!("wolf_readiness_parts/001.rs");
include!("wolf_readiness_parts/002.rs");
