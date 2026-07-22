//! Kaifuu engine fixture / detector adapters.
//! Clean-room provenance for the RealLive detector
//! - All RealLive format observations are derived from publicly archived
//!   format documentation (Haeleth's RLDEV site,
//!   `https://dev.haeleth.net/rldev.shtml`) and from publicly observable file
//!   shape of owned RealLive titles. No source expression is copied from
//!   RLDEV or rlvm.
//! - rlvm (`https://github.com/eglaysher/rlvm`) is a research anchor only.
//!   Its license is GPLv3+ and is incompatible with itotori's distribution
//!   posture if linked or derived. This crate does NOT depend on rlvm, does
//!   NOT include rlvm headers, does NOT copy rlvm's structure layouts, and
//!   does NOT mechanically translate rlvm code into Rust. If a hypothesis
//!   about RealLive's format was confirmed by reading rlvm, the hypothesis
//!   is re-derived and re-tested against publicly observable bytes before
//!   being encoded here.
//! - The RealLive adapter includes identification/profile, Scene/SEEN
//!   inventory/extraction, and limited length-changing single-scene patch-back
//!   (/). Runtime support remains in Utsushi. All of those
//!   slices inherit the same clean-room posture.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use kaifuu_core::{
    ASSET_INVENTORY_SCHEMA_VERSION, AdapterCapabilities, AdapterCapabilityMatrix, AdapterFailure,
    AdapterFailureSemanticParams, AdapterHelperRequirementDeclaration, ArchiveParameter,
    ArchiveParameterKind, ArchiveParameterSource, AssetInventoryAsset, AssetInventoryAssetKind,
    AssetInventoryAssetRef, AssetInventoryManifest, AssetInventoryPatchMode, AssetInventoryRequest,
    AssetInventorySurface, AssetInventorySurfaceKind, AssetInventoryTextSourceKind, AssetKind,
    AssetList, AssetListRequest, AssetProfile, BridgeBundle, BridgeUnit, Capability,
    CapabilityLevelStatus, CapabilityReport, CapabilityStatus, CodecTransform, ContainerTransform,
    CryptoTransform, DetectRequest, DetectionEvidence, DetectionResult, EncodedStringSlot,
    EncodedStringSlotProtectedSpan, EngineAdapter, EngineProfile, EvidenceStatus, ExtractRequest,
    ExtractionResult, FIXTURE_HELPER_ALLOWLIST_REF_ID, FIXTURE_HELPER_REGISTRY_ID, GameProfile,
    HelperCapability, KaifuuResult, KeyMaterialKind, KeyRequirement,
    LayeredAccessCapabilityContract, LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus,
    LayeredAccessOperationContract, LayeredAccessProfile, LayeredTextSurfaceAccess,
    OperationStatus, PatchBackTransform, PatchPreflightRequest, PatchRef, PatchRequest,
    PatchResult, PlainXp3Entry, PlainXp3InventoryError, ProfileRequest, ProfileRequirement,
    ProtectedSpan, ProtectedSpanMapping, RequirementCategory, RequirementStatus, SecretRef,
    SemanticErrorCode, SourceFingerprint, SurfaceTransform, TextSurface, VerificationResult,
    VerifyRequest, XP3_PLAIN_MAGIC, atomic_write_text, content_hash, deterministic_id,
    normalize_protected_spans, parse_hex_bytes, read_plain_xp3_inventory, require_str, require_u64,
    safe_join_relative, sha256_file_ref,
};
use serde_json::{Value, json};

mod profile_detection_helpers;
use profile_detection_helpers::*;

mod reallive_detector_fsm;
pub(crate) use reallive_detector_fsm::{
    GameexeIniKeyHits, RealLiveFixtureVariant, RealLiveFsmSignals,
};

mod softpal;
pub use softpal::*;

mod nexas;
pub use nexas::*;

mod bgi;
pub use bgi::*;

/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked into the binary at COMPILE time, so a
/// test binary reused from a different (since-removed) worktree points fixture
/// reads at a dead path and fails with an opaque `Os { code: 2, NotFound }`.
/// `cargo test` sets `CARGO_MANIFEST_DIR` in the test binary's RUNTIME
/// environment to the LIVE crate directory of the current invocation; prefer
/// that, falling back to the compile-time constant only when run outside cargo.
/// Lookup only — never writes, so tracked fixtures stay strictly read-only.
#[cfg(test)]
pub(crate) fn test_manifest_dir() -> std::path::PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(
        || std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        std::path::PathBuf::from,
    )
}

pub const FIXTURE_ADAPTER_ID: &str = "kaifuu.fixture";
pub const XP3_DETECTOR_ADAPTER_ID: &str = "kaifuu.kirikiri_xp3";
pub const SIGLUS_DETECTOR_ADAPTER_ID: &str = "kaifuu.siglus";
pub const REALLIVE_DETECTOR_ADAPTER_ID: &str = "kaifuu.reallive";
const XP3_ARCHIVE_PATH: &str = "data.xp3";
const XP3_MAGIC: &[u8] = b"XP3";
const XP3_ENCRYPTED_MARKER: &str = "XP3-CRYPT";
const XP3_COMPRESSED_MARKER: &str = "XP3-COMPRESSED";
const XP3_HELPER_REQUIRED_MARKER: &str = "XP3-HELPER-REQUIRED";
const XP3_UNKNOWN_MARKER: &str = "XP3-UNKNOWN-VARIANT";
const XP3_GAME_ID: &str = "kaifuu-kirikiri-xp3-synthetic-archive";
const XP3_SUPPORT_BOUNDARY: &str = "XP3 profile fixtures identify synthetic KiriKiri/XP3 archive containers; plain fixture index metadata may be parsed for inventory only, while payload extraction, decompression, decryption, patch-back, and runtime support are not claimed.";
const SIGLUS_SCENE_PATH: &str = "Scene.pck";
const SIGLUS_GAMEEXE_PATH: &str = "Gameexe.dat";
const SIGLUS_SCENE_MAGIC: &[u8] = b"SIGLUS-SCENE-PCK";
const SIGLUS_GAMEEXE_MAGIC: &[u8] = b"SIGLUS-GAMEEXE-DAT";
const SIGLUS_PROFILE_ID: &str = "019ed000-0000-7000-8000-000000091001";
const SIGLUS_GAME_ID: &str = "kaifuu-siglus-synthetic-scene-pck";
const SIGLUS_REAL_GAME_ID: &str = "kaifuu-siglus-real-scene-pck";
const SIGLUS_SUPPORT_BOUNDARY: &str = "Siglus detector profile identifies synthetic Scene.pck/Gameexe.dat fixtures for identify and inventory only; parser, extraction, decryption, patch-back, and runtime support are not claimed.";
// Real (non-synthetic) Siglus signature recognition.
// Provenance: these constants encode the publicly observable file shape of
// real Siglus Scene.pck / Gameexe.dat archives, cross-checked against owned
// Siglus titles (Karetoshi, Gamekoi) and the documented `0x5C` header anchor
// carried by `kaifuu_siglus::archive::SCENE_PCK_HEADER_BYTE_LEN`. No
// copyrighted bytes are embedded — only the structural signature is encoded,
// and recognition stays at identify/inventory level (the Scene.pck parser,
// decryptor, and repacker remain NotImplemented in `kaifuu_siglus`).
// Real Scene.pck opens with a plaintext little-endian header whose first
// dword is the fixed header size (`0x5C` = 92 bytes) and whose second dword
// equals that header size (the first index section begins immediately after
// the header). The remaining header dwords are `(offset, count)`
// index-section pairs whose offsets ascend monotonically and stay within the
// file; real titles expose 10 such ascending offsets before a trailing flag
// pair.
const SIGLUS_SCENE_REAL_HEADER_SIZE: u32 = 0x5C;
// Require a strong leading run of ascending, in-bounds index-section offsets
// so a file that merely opens with `5c 00 00 00` cannot false-positive.
// Real Karetoshi/Gamekoi expose 10; 8 keeps a two-section margin.
const SIGLUS_SCENE_REAL_MIN_ASCENDING_OFFSETS: usize = 8;
// Real Gameexe.dat opens with a zero dword then a `1` version dword, followed
// by an encrypted (high-entropy) payload.
const SIGLUS_GAMEEXE_REAL_VERSION: u32 = 1;
// Minimum body bytes examined for the encrypted-payload entropy gate, and the
// Shannon-entropy floor (bits/byte) the body must clear. Real Gameexe.dat
// bodies measure ~7.97 bits/byte; 6.5 rejects plaintext/low-entropy files
// that merely share the 8-byte prefix.
const SIGLUS_GAMEEXE_REAL_MIN_BODY_LEN: usize = 256;
const SIGLUS_GAMEEXE_REAL_ENTROPY_WINDOW: usize = 4096;
const SIGLUS_GAMEEXE_REAL_MIN_ENTROPY_BITS: f64 = 6.5;

// RealLive detector constants. See the module-level RealLive
// provenance block above `RealLiveProfileDetectorAdapter` for clean-room rules.
const REALLIVE_SEEN_TXT_PATH: &str = "SEEN.TXT";
const REALLIVE_SEEN_GAN_PATH: &str = "SEEN.GAN";
const REALLIVE_GAMEEXE_INI_PATH: &str = "Gameexe.ini";
const REALLIVE_XOR2_VALIDATION_ASSET_REF: &str = "REALLIVEDATA/Seen.txt";
// nested-data-dir-resolved evidence code. Emitted whenever the
// detector walks past the game root and locates a nested REALLIVEDATA/
// subdirectory (e.g. Sweetie HD ships its REALLIVEDATA under a
// Japanese-named title subdir). The evidence carries the on-disk path
// relative to the game root so downstream `extract` / `profile` /
// `verify` can re-use the resolved data dir without re-walking. The
// identifier is namespaced under the stable `kaifuu.reallive.*` evidence
// code namespace so downstream consumers can key off a single stable
// string (supersedes the `reallive_resolved_data_dir`
// kind).
const REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE: &str = "kaifuu.reallive.nested_data_dir_resolved";
// Synthetic fixture short-circuit signatures. Public CI uses these to assert
// detector wiring without needing observed real-game SEEN.TXT bytes. The
// generic envelope check (see `reallive_seen_txt_envelope_ok`) is what
// ALPHA-006 exercises against real titles.
const REALLIVE_SEEN_TXT_MAGIC: &[u8] = b"SEEN\x01";
const REALLIVE_SEEN_GAN_MAGIC: &[u8] = b"GAN\x01";
const REALLIVE_GAMEEXE_INI_MAGIC: &[u8] = b"# RealLive Gameexe.ini fixture";
const REALLIVE_PROFILE_ID: &str = "019ed000-0000-7000-8000-000000172001";
const REALLIVE_GAME_ID: &str = "kaifuu-reallive-synthetic-scene-seen";
const REALLIVE_SUPPORT_BOUNDARY: &str = "RealLive adapter identifies SEEN.TXT/Gameexe.ini/SEEN.GAN fixtures, inventories Scene/SEEN assets, extracts text slots, and supports limited length-changing single-scene slot patch-back through the bundle-driven driver; multi-scene archive rebuild, non-text extraction, image-overlaid .g00 text, and runtime support are not claimed.";

#[derive(Debug, Default, Clone, Copy)]
pub struct FixtureAdapter;

#[derive(Debug, Default, Clone, Copy)]
pub struct Xp3ProfileDetectorAdapter;

#[derive(Debug, Default, Clone, Copy)]
pub struct SiglusProfileDetectorAdapter;

// RealLive engine detector adapter.
// Clean-room provenance:
// - All format observations encoded here are derived from publicly archived
// format documentation (Haeleth's RLDEV site,
// https://dev.haeleth.net/rldev.shtml) and from publicly observable file
// shape of owned RealLive titles. No source expression is copied from
// RLDEV or rlvm.
// - rlvm (https://github.com/eglaysher/rlvm) is a research anchor only. Its
// license is GPLv3+ and is incompatible with itotori's distribution posture
// include rlvm headers, does NOT copy rlvm's structure layouts, and does
// NOT mechanically translate rlvm code into Rust. If a hypothesis about
// RealLive's format was confirmed by reading rlvm, the hypothesis is
// re-derived and re-tested against publicly observable bytes before being
// encoded here.
// - This adapter includes identification/profile, Scene/SEEN inventory and
// extraction, and limited length-changing single-scene patch-back
// (/). Runtime support remains in Utsushi. All of those
// slices inherit the same clean-room posture.
#[derive(Debug, Default, Clone, Copy)]
pub struct RealLiveProfileDetectorAdapter;

#[derive(Debug, Clone)]
struct Xp3FixtureState {
    archive_path: std::path::PathBuf,
    archive_exists: bool,
    archive_signature: bool,
    archive_hash: Option<String>,
    variant: Xp3FixtureVariant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Xp3FixtureVariant {
    Plain,
    Encrypted,
    HelperRequired,
    Compressed,
    Unknown,
    NotXp3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SiglusFixtureVariant {
    CompleteSyntheticPair,
    // Both Scene.pck and Gameexe.dat carry the REAL Siglus archive-header
    // signatures (not the synthetic fixture magic). Detected + inventoryable
    // at identify level; parser/extraction/decryption remain unclaimed.
    CompleteRealPair,
    MissingGameexeDat,
    MissingScenePck,
    UnknownNamedPair,
    NotSiglus,
}

#[derive(Debug, Clone)]
struct SiglusFixtureState {
    scene_exists: bool,
    gameexe_exists: bool,
    // `*_signature` is the recognition OR: synthetic fixture magic OR real
    // archive-header signature. Downstream evidence/requirements key off this
    // so both fixture and real inputs satisfy the same detector contract.
    scene_signature: bool,
    gameexe_signature: bool,
    // Whether the REAL (non-synthetic) archive-header signature matched, kept
    // separate so evidence and the detected variant can report honestly which
    // signature class was recognised.
    scene_real: bool,
    gameexe_real: bool,
    scene_hash: Option<String>,
    gameexe_hash: Option<String>,
    variant: SiglusFixtureVariant,
}

// RealLive detector.
// FSM lives in `RealLiveProfileDetectorAdapter::resolve_variant`. The
// algorithm is a small deterministic state machine over presence/absence
// and signature-validity counts: no confidence floats, no thresholds beyond
// what the plan specifies. See §3 for the decision table.

#[derive(Debug, Clone)]
struct RealLiveFixtureState {
    seen_txt_exists: bool,
    seen_txt_envelope_ok: bool,
    seen_txt_synthetic_magic: bool,
    seen_gan_exists: bool,
    seen_gan_synthetic_magic: bool,
    gameexe_ini_exists: bool,
    gameexe_ini_synthetic_magic: bool,
    gameexe_ini_keys: GameexeIniKeyHits,
    g00_count: u64,
    voice_archive_count: u64,
    siglus_scene_pck_present: bool,
    siglus_gameexe_dat_present: bool,
    avg32_pdt_count: u64,
    seen_txt_hash: Option<String>,
    seen_gan_hash: Option<String>,
    gameexe_ini_hash: Option<String>,
    variant: RealLiveFixtureVariant,
    // when the depth-N walk locates a nested REALLIVEDATA/
    // subdirectory, the relative path is recorded here so the detector
    // can surface it as evidence (`kaifuu.reallive.nested_data_dir_resolved`). `None`
    // means the SEEN.TXT/Gameexe.ini lookups fell back to the game root
    // (synthetic fixtures or `kaifuu detect` invoked directly against a
    // REALLIVEDATA-named directory).
    resolved_reallive_data_dir: Option<std::path::PathBuf>,
}

#[path = "fixture_source.rs"]
mod fixture_source;

#[path = "fixture_slots.rs"]
mod fixture_slots;

#[path = "fixture_markup.rs"]
mod fixture_markup;

#[path = "fixture_adapter.rs"]
mod fixture_adapter;

#[path = "xp3_profile.rs"]
mod xp3_profile;

#[path = "xp3_inventory.rs"]
mod xp3_inventory;

#[path = "xp3_adapter.rs"]
mod xp3_adapter;

#[path = "siglus_profile.rs"]
mod siglus_profile;

#[path = "siglus_inventory.rs"]
mod siglus_inventory;

#[path = "siglus_adapter.rs"]
mod siglus_adapter;

#[path = "reallive_profile.rs"]
mod reallive_profile;

#[path = "reallive_inventory.rs"]
mod reallive_inventory;

#[path = "reallive_capabilities.rs"]
mod reallive_capabilities;

#[path = "reallive_patch.rs"]
mod reallive_patch;

#[path = "reallive_adapter.rs"]
mod reallive_adapter;

#[path = "reallive_bridge.rs"]
mod reallive_bridge;

pub fn registry() -> kaifuu_core::AdapterRegistry {
    let mut registry = kaifuu_core::AdapterRegistry::new();
    registry.register(FixtureAdapter);
    registry.register(Xp3ProfileDetectorAdapter);
    registry.register(SiglusProfileDetectorAdapter);
    registry.register(RealLiveProfileDetectorAdapter);
    registry.register(BgiBytecodeAdapter);
    registry.register(SoftpalProfileDetectorAdapter);
    registry.register(NexasProfileDetectorAdapter);
    registry
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
