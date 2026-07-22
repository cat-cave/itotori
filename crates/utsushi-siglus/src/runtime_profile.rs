//! Siglus `Scene.pck` / `Gameexe.dat` **runtime-profile boundary
//! fixtures** + classifier.
//!
//! The [`crate`]-root `UtsushiSiglusPort` is a substrate-facade scaffold: it
//! renders nothing yet. Before a real Siglus runtime can claim *any* rendered
//! evidence it must clear a **runtime-profile boundary** — the container has to
//! parse inside the supported profile, and the profile's key requirement has to
//! be satisfiable **in-process** (no shell-out, no external helper). This module
//! lands the boundary layer that gates that claim, and the synthetic fixtures
//! that distinguish the five boundary classes.
//!
//! # The five boundary classes
//!
//! class | fixture posture | outcome
//! ------------------|----------------------------------------------------|----------------------------------
//! [`no-key`] | profile declares no key requirement (plaintext) | **admitted** — claim may be built
//! [`zero-key`] | key required, resolves in-process to the zero key | **admitted** — claim may be built
//! [`required-key`] | key required, no in-process material, no helper | **rejected** — typed diagnostic
//! [`helper-req.`] | key required, only an external helper could resolve| **rejected** — typed diagnostic
//! [`out-of-prof.`] | container encoding/compression outside the profile | **rejected** — typed diagnostic
//!
//! [`no-key`]: RuntimeBoundaryClass::NoKey
//! [`zero-key`]: RuntimeBoundaryClass::ZeroKey
//! [`required-key`]: RuntimeBoundaryClass::RequiredKey
//! [`helper-req.`]: RuntimeBoundaryClass::HelperRequired
//! [`out-of-prof.`]: RuntimeBoundaryClass::OutOfProfile
//!
//! # Three load-bearing invariants
//!
//! 1. **Reject-before-claim.** A boundary failure (required-key
//!    helper-required / out-of-profile) short-circuits *before* any
//!    runtime-evidence claim is constructed. This is enforced at the type
//!    level: the only constructor of [`RuntimeEvidenceClaim`] is
//!    [`RuntimeEvidenceClaim::from_admission`], and the only constructor of
//!    [`RuntimeProfileAdmission`] is [`classify_runtime_profile`], which
//!    returns `Err(`[`RuntimeBoundaryDiagnostic`]`)` on every rejected class.
//!    You cannot name a claim without first holding an admission, and you
//!    cannot hold an admission without having cleared the boundary.
//! 2. **Secret-refs only.** Every serialized runtime report (both the admitted
//!    claim and the rejection diagnostic) refers to key material *only* through
//!    a [`SecretRef`] plus a one-way [`ProofHash`]. Raw key bytes live only
//!    inside the module-private, zeroize-on-drop, `Debug`-redacting
//!    [`RuntimeKeyMaterial`] holder and never cross a serialization boundary.
//! 3. **Synthetic bytes.** The fixtures are clearly-fake in-process
//!    `Scene.pck` / `Gameexe.dat` containers built from module constants. No
//!    retail bytes, and no retail key: the zero-key fixture's key *is* the
//!    all-zero identity key, authored here.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use utsushi_core::EvidenceTier;
use utsushi_core::port::impl_map::sha256_hex;
use utsushi_core::substrate::reject_unredacted_local_paths;

/// Schema version of the runtime-profile boundary fixture + report pair.
pub const RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION: &str = "0.1.0";

/// Stable capability id every runtime-profile boundary report carries.
pub const RUNTIME_PROFILE_BOUNDARY_CAPABILITY_ID: &str = "utsushi-siglus-runtime-profile-boundary";

/// Provenance node id stamped into every admitted boundary report.
const RUNTIME_PROFILE_BOUNDARY_SOURCE_NODE_ID: &str = "UTSUSHI-035";

/// The blunt support boundary surfaced in every report. Deliberately explicit
/// that clearing the boundary is *admission to attempt rendering*, not a claim
/// that a full Siglus frame was rendered (the runtime VM is still the crate's
/// scaffold).
pub const RUNTIME_PROFILE_BOUNDARY_SUPPORT_BOUNDARY: &str = "Utsushi Siglus runtime-profile boundary classifies a synthetic Scene.pck/Gameexe.dat runtime profile into exactly one of five boundary classes (no-key, zero-key, required-key, helper-required, out-of-profile). Clearing the boundary (no-key/zero-key) is ADMISSION to attempt rendering with an in-process-resolvable key; it is NOT a claim that a Siglus frame was rendered (the runtime VM is the crate scaffold). A boundary failure (required-key/helper-required/out-of-profile) is rejected with a typed diagnostic BEFORE any runtime-evidence claim is constructed. Key material is referenced only through local secret-refs + one-way proof hashes; raw key bytes are never logged, serialized, or written.";

// --- Synthetic container format (NO retail bytes) ---------------------------
//
// A narrow, self-describing runtime-profile container. The header is plaintext
// so the boundary can walk the directory before touching any key. Only the
// per-record payloads carry (optionally key-masked) text.
//
//   Scene.pck: <14B magic><u8 compressionFlag><u32 sceneId><u32 unitCount>
//                unitCount * { <u32 payloadLen><payload bytes> }
//   Gameexe.dat: <14B magic><u8 compressionFlag><u32 entryCount>
//                entryCount * { <u32 payloadLen><payload bytes> }

const SCENE_PCK_MAGIC: &[u8; 14] = b"USIG-SCN-RTPRO";
const GAMEEXE_DAT_MAGIC: &[u8; 14] = b"USIG-GXE-RTPRO";

/// On-wire compression flag: uncompressed (the only in-profile case).
const COMPRESSION_UNCOMPRESSED: u8 = 0;
/// On-wire compression flag: proprietary Siglus LZSS — **out of profile** for
/// the boundary layer (the real codec is a KAIFUU skeleton).
const COMPRESSION_LZSS: u8 = 1;

/// Synthetic scene id the fixtures emit.
const FIXTURE_SCENE_ID: u32 = 35;

/// Clearly-synthetic Scene.pck dialogue units (authored here, not extracted).
const FIXTURE_SCENE_UNITS: &[&str] = &[
    "[synthetic-siglus-runtime-unit-0]",
    "[synthetic-siglus-runtime-unit-1]",
];

/// Clearly-synthetic Gameexe.dat key/value config lines.
const FIXTURE_GAMEEXE_ENTRIES: &[(&str, &str)] = &[
    ("#SCENE.000.NAME", "[synthetic-scene-0]"),
    ("#WINDOW.000.NAME", "[synthetic-window-0]"),
];

/// The all-zero identity key the zero-key fixture is gated by. This is the one
/// place raw "key" bytes exist; they never leave [`RuntimeKeyMaterial`]. XOR
/// with a zero key is the identity transform — a present-but-degenerate key
/// distinct from the no-key case which references no key at all.
const ZERO_KEY_LEN: usize = 16;

#[path = "runtime_profile_fixtures.rs"]
mod runtime_profile_fixtures;
#[path = "runtime_profile_model.rs"]
mod runtime_profile_model;
#[path = "runtime_profile_resolver.rs"]
mod runtime_profile_resolver;
#[path = "runtime_profile_secret.rs"]
mod runtime_profile_secret;

pub use runtime_profile_fixtures::*;
pub use runtime_profile_model::*;
pub use runtime_profile_secret::{ProofHash, SecretRef};

use runtime_profile_resolver::{
    build_gameexe_container, build_scene_container, parse_container, stable_redacted_json,
};
use runtime_profile_secret::RuntimeKeyMaterial;

#[cfg(test)]
#[path = "runtime_profile_tests.rs"]
mod tests;
