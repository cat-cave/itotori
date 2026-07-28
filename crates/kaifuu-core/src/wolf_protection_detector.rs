//! Wolf RPG Editor archive + protection detector profile fixtures.
//! A *Wolf protection detector profile* records what a Wolf RPG Editor
//! (`.wolf` / DXArchive-family) container reveals about its **protection
//! posture** and mechanically classifies it into one of four detector
//! profiles: [`WolfProtectionProfile::Plain`],
//! [`WolfProtectionProfile::Protected`],
//! [`WolfProtectionProfile::HelperRequired`], and
//! [`WolfProtectionProfile::Unknown`]. It is the Wolf-family sibling of the
//! KiriKiri XP3 capability profile
//! ([`crate::Xp3CapabilityProfileReport`]) and the packed-engine
//! readiness validator ([`crate::PackedReadinessValidationReport`]): it reuses
//! the shared transform vocabulary ([`ContainerTransform`] /
//! [`CryptoTransform`] / [`CodecTransform`] / [`SurfaceTransform`]), the shared
//! capability ladder ([`CapabilityLevel`] / [`CapabilityLevelStatus`]), and the
//! shared semantic-diagnostic taxonomy ([`SemanticErrorCode`]).
//! # Scope (honest boundary — identify-level, synthetic-fixture-driven)
//! This node is a DETECTOR, not a Wolf archive parser. It does NOT open a real
//! `.wolf`/DXA container, walk its file table, or decrypt anything. The
//! fixtures encode the *publicly observable protection posture* a Wolf archive
//! exposes (unencrypted DX archive vs static-key-encrypted vs Wolf "Pro"
//! per-game dynamic-key vs unrecognized) as a small structured signal, and the
//! detector [`derive_wolf_protection_profile`] mechanically classifies that
//! signal into the four profiles with the correct capability tuple and
//! diagnostics. Real Wolf archive extraction / decryption / patch-back is a
//! later adapter node (profile-proof command, helper
//! boundary, encrypted-archive adapter); the dynamic-key helper
//! itself is the continuous-tier boundary. None of those are
//! claimed here.
//! # The mechanical line (computed, never asserted)
//! [`derive_wolf_protection_profile`] is the single source of truth. The
//! profile is a pure function of the recorded protection signal and whether a
//! **concrete key requirement** (secret requirement id) exists:
//! - `unencrypted` → `plain`
//! - `dynamic_key_helper_gated` → `helper_required`
//! - `static_key_protected` WITH a concrete key requirement → `protected`
//! - `static_key_protected` WITHOUT a concrete key requirement → `unknown`
//!   (reports `missing_capability.crypto`)
//! - `unrecognized_protection` → `unknown`
//!   (reports `unknown_engine_variant`)
//!   The capability tuple the detector advertises separates the *identify* and
//!   *inventory* rungs it can claim from the *extract*, *patch*, *helper*, and
//!   *runtime* rungs it can NEVER claim (those are later Wolf nodes). A protected
//!   helper-required / unknown archive can therefore never present a resolved
//!   extract, patch, helper, or runtime capability no matter what the fixture
//!   declares.
//! # Evidence is synthetic, redacted, hash-free-of-keys
//! Fixtures carry NO retail bytes and NO raw key material: only the structured
//! protection signal, the shared transform legs, local-scheme [`SecretRef`]
//! key references, and stable requirement ids. The report is funnelled through
//! [`redact_for_log_or_report`] and serialized via [`stable_json`].

include!("wolf_protection_detector_parts/001.rs");
include!("wolf_protection_detector_parts/002.rs");
include!("wolf_protection_detector_parts/003.rs");
