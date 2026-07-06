//! Kaifuu engine fixture / detector adapters.
//!
//! Clean-room provenance for the RealLive detector (KAIFUU-172):
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
//! - The RealLive detector is identify-only. Extraction, decompilation, and
//!   patching live in KAIFUU-173/KAIFUU-174 (Kaifuu) and UTSUSHI-146
//!   (runtime port). All of those nodes inherit the same clean-room posture.

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

/// Resolve this crate's manifest directory for locating tracked test fixtures.
///
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
// Real (non-synthetic) Siglus signature recognition (KAIFUU-091).
//
// Provenance: these constants encode the publicly observable file shape of
// real Siglus Scene.pck / Gameexe.dat archives, cross-checked against owned
// Siglus titles (Karetoshi, Gamekoi) and the documented `0x5C` header anchor
// carried by `kaifuu_siglus::archive::SCENE_PCK_HEADER_BYTE_LEN`. No
// copyrighted bytes are embedded — only the structural signature is encoded,
// and recognition stays at identify/inventory level (the Scene.pck parser,
// decryptor, and repacker remain NotImplemented in `kaifuu_siglus`).
//
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

// RealLive detector constants (KAIFUU-172). See the module-level RealLive
// provenance block above `RealLiveProfileDetectorAdapter` for clean-room rules.
const REALLIVE_SEEN_TXT_PATH: &str = "SEEN.TXT";
const REALLIVE_SEEN_GAN_PATH: &str = "SEEN.GAN";
const REALLIVE_GAMEEXE_INI_PATH: &str = "Gameexe.ini";
// KAIFUU-192 nested-data-dir-resolved evidence code. Emitted whenever the
// detector walks past the game root and locates a nested REALLIVEDATA/
// subdirectory (e.g. Sweetie HD ships its REALLIVEDATA under a
// Japanese-named title subdir). The evidence carries the on-disk path
// relative to the game root so downstream `extract` / `profile` /
// `verify` can re-use the resolved data dir without re-walking. The
// identifier is namespaced under the stable `kaifuu.reallive.*` evidence
// code namespace so downstream consumers can key off a single stable
// string (KAIFUU-192 supersedes the KAIFUU-189 `reallive_resolved_data_dir`
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
const REALLIVE_SUPPORT_BOUNDARY: &str = "RealLive detector profile identifies SEEN.TXT/Gameexe.ini/SEEN.GAN fixtures for identify and (in a single later slice) profile/asset-inventory only; parser, extraction, decryption, patch-back, and runtime support are not claimed.";

// Softpal ADV (Amuse Craft / "Pal") engine detector (SOFTPAL-DETECTOR).
//
// Provenance: these constants encode the publicly observable file shape of the
// Softpal ADV System, cross-checked against two owned titles (Kizuna Kirameku
// Koi Iroha / v21465 and Dimension Totsu Lovers / v60663). No copyrighted bytes
// are embedded — only fixed format signatures (the same magics any Softpal
// title exposes) are encoded, and recognition stays at identify level: PAC
// extraction, SCRIPT.SRC decompilation, TEXT.DAT decode/decrypt, and repack are
// intentionally NOT claimed (they are later Softpal nodes; the Softpal core is
// not implemented yet).
//
// Signatures (all observed on both real titles):
//   * `dll/Pal.dll` present — the definitive Softpal ("Pal" engine) marker.
//   * `.pac` archives open with magic `PAC ` (`50 41 43 20`) and, in the case
//     of `data.pac`, list `SCRIPT.SRC` and `TEXT.DAT` entries in the file table.
//   * The `SCRIPT.SRC` payload opens with `Sv20` (`53 76 32 30`); the `Sv`
//     followed by a two-digit version tolerates other script-format revisions
//     (e.g. `Sv10`).
//   * The `TEXT.DAT` payload opens with a one-byte encryption flag then
//     `TEXT_LIST__`; the flag is `$` (encrypted — v21465) or `_` (plaintext —
//     v60663), so BOTH real titles' enc-flag states are recognised.
pub const SOFTPAL_DETECTOR_ADAPTER_ID: &str = "kaifuu.softpal";
// `PAC ` — trailing space is part of the 4-byte magic.
const SOFTPAL_PAC_MAGIC: &[u8] = b"PAC ";
const SOFTPAL_DATA_PAC_NAME: &str = "data.pac";
const SOFTPAL_PAL_DLL_DIR: &str = "dll";
const SOFTPAL_PAL_DLL_NAME: &str = "Pal.dll";
const SOFTPAL_SCRIPT_SRC_NAME: &str = "SCRIPT.SRC";
const SOFTPAL_TEXT_DAT_NAME: &str = "TEXT.DAT";
// Entry-name byte sequences searched for inside a `.pac` file table.
const SOFTPAL_SCRIPT_SRC_ENTRY: &[u8] = b"SCRIPT.SRC";
const SOFTPAL_TEXT_DAT_ENTRY: &[u8] = b"TEXT.DAT";
// `SCRIPT.SRC` payload magic prefix (`Sv`, then a two-digit version).
const SOFTPAL_SCRIPT_SRC_MAGIC_PREFIX: &[u8] = b"Sv";
// `TEXT.DAT` payload tag following the one-byte encryption flag.
const SOFTPAL_TEXT_LIST_TAG: &[u8] = b"TEXT_LIST__";
// Encryption-flag byte that precedes `TEXT_LIST__`: `$` encrypted, `_` plaintext.
const SOFTPAL_TEXT_DAT_ENC_ENCRYPTED: u8 = b'$';
const SOFTPAL_TEXT_DAT_ENC_PLAINTEXT: u8 = b'_';
// Bound the PAC file-table prefix scan so a multi-megabyte / tens-of-MB `.pac`
// is never fully read merely to recognise its entry names. Real `data.pac`
// tables list `SCRIPT.SRC`/`TEXT.DAT` within the first few KB (v21465 @16092,
// v60663 @7812); a 1 MiB window gives a wide margin for larger archives'
// file tables while staying bounded and identify-level.
const SOFTPAL_PAC_TABLE_SCAN_LEN: usize = 1 << 20;
// Sanity bound on the PAC entry count (LE u32 @ offset 8) so a file that merely
// opens with `PAC ` cannot pass the container check with a garbage table.
const SOFTPAL_PAC_MAX_ENTRIES: u32 = 1_000_000;
const SOFTPAL_PROFILE_ID: &str = "019ed000-0000-7000-8000-0000000c1001";
const SOFTPAL_GAME_ID: &str = "kaifuu-softpal-detected-title";
const SOFTPAL_SUPPORT_BOUNDARY: &str = "Softpal detector identifies the Amuse Craft/Pal (Softpal ADV) engine by Pal.dll, a PAC archive listing SCRIPT.SRC/TEXT.DAT, and the Sv-version/TEXT_LIST script magics, for identify only; PAC extraction, SCRIPT.SRC decompilation, TEXT.DAT decode/decryption, patch-back, and runtime support are not claimed.";

// NeXAS engine detector (NEXAS-DETECTOR). NeXAS ships its assets in category
// `.pac` archives (Bgm/Config/Face/Script/Se/Stand/System/Thumbnail/Visual/
// Voice*.pac) whose container magic is `"PAC\0"` (`50 41 43 00`) — the 4th byte
// is a NUL, which is exactly what distinguishes it from the Softpal `"PAC "`
// (`50 41 43 20`, 4th byte a space) container. Both engines reuse the `.pac`
// extension, so detection keys on the MAGIC BYTES, never the extension. No
// copyrighted bytes are embedded — only the fixed container signature (magic +
// sane count @0x04 + small pack_type @0x08) and the well-known category-archive
// names. The NeXAS engine is statically linked into the game exe and ships NO
// Pal.dll, so a NeXAS title never trips the Softpal detector. Identify-only
// here: the actual PAC extraction + per-entry decompression lives in the
// `kaifuu-nexas` crate (a later capability), reported Unsupported by this
// detector.
pub const NEXAS_DETECTOR_ADAPTER_ID: &str = "kaifuu.nexas";
// NeXAS container magic: "PAC" then a NUL byte (Softpal's is "PAC" + space).
const NEXAS_PAC_MAGIC: &[u8] = b"PAC\0";
// Byte offsets of the little-endian u32 count / pack_type within the header.
const NEXAS_COUNT_OFFSET: usize = 0x04;
const NEXAS_PACK_TYPE_OFFSET: usize = 0x08;
const NEXAS_HEADER_BYTE_LEN: usize = 0x0C;
// Sanity bounds guarding against a random file that merely opens with "PAC\0".
const NEXAS_PAC_MAX_ENTRIES: u32 = 1_000_000;
// GARbro's NeXAS Compression enum tops out at 4 (DeflateOrNone); allow a small
// margin so an unusual-but-plausible pack_type is still recognised without
// admitting a garbage dword.
const NEXAS_PACK_TYPE_MAX: u32 = 8;
// Well-known NeXAS category-archive base names (corroborating evidence, not
// required for detection). Matched case-insensitively against `*.pac` stems.
const NEXAS_CATEGORY_ARCHIVES: &[&str] = &[
    "bgm",
    "config",
    "effect",
    "face",
    "script",
    "se",
    "stand",
    "system",
    "thumbnail",
    "visual",
    "voice",
    "voice2",
    "voice3",
    "voice4",
];
const NEXAS_PROFILE_ID: &str = "019ed000-0000-7000-8000-0000000e1001";
const NEXAS_GAME_ID: &str = "kaifuu-nexas-detected-title";
const NEXAS_SUPPORT_BOUNDARY: &str = "NeXAS detector identifies the NeXAS engine by its `PAC\\0` container magic (50 41 43 00, 4th byte NUL — distinct from Softpal `PAC ` 50 41 43 20) with a sane count @0x04 and small pack_type @0x08, plus the well-known category-archive names (Bgm/Face/Script/Stand/System/Voice*.pac), for identify only; PAC extraction and per-entry decompression (stored/LZSS/Huffman/zlib-Deflate) live in the kaifuu-nexas crate, and script decode, image decode, patch-back, and runtime support are not claimed by this detector.";

#[derive(Debug, Default, Clone, Copy)]
pub struct FixtureAdapter;

#[derive(Debug, Default, Clone, Copy)]
pub struct Xp3ProfileDetectorAdapter;

#[derive(Debug, Default, Clone, Copy)]
pub struct SiglusProfileDetectorAdapter;

// RealLive engine detector adapter (KAIFUU-172).
//
// Clean-room provenance:
// - All format observations encoded here are derived from publicly archived
//   format documentation (Haeleth's RLDEV site,
//   https://dev.haeleth.net/rldev.shtml) and from publicly observable file
//   shape of owned RealLive titles. No source expression is copied from
//   RLDEV or rlvm.
// - rlvm (https://github.com/eglaysher/rlvm) is a research anchor only. Its
//   license is GPLv3+ and is incompatible with itotori's distribution posture
//   if linked or derived. This crate does NOT depend on rlvm, does NOT
//   include rlvm headers, does NOT copy rlvm's structure layouts, and does
//   NOT mechanically translate rlvm code into Rust. If a hypothesis about
//   RealLive's format was confirmed by reading rlvm, the hypothesis is
//   re-derived and re-tested against publicly observable bytes before being
//   encoded here.
// - This detector is identify-only. Extraction, decompilation, and patching
//   live in KAIFUU-173/KAIFUU-174 (Kaifuu) and UTSUSHI-146 (runtime port).
//   All of those nodes inherit the same clean-room posture.
#[derive(Debug, Default, Clone, Copy)]
pub struct RealLiveProfileDetectorAdapter;

// Softpal ADV (Amuse Craft / "Pal") engine detector. Identify-only: it
// classifies `engine=softpal` from Pal.dll / PAC+SCRIPT.SRC/TEXT.DAT / script
// magics; PAC extraction, decompilation, decryption, and patch-back are later
// Softpal nodes and are reported Unsupported here. See the `SOFTPAL_*`
// constants above for the signature provenance and false-positive rationale.
#[derive(Debug, Default, Clone, Copy)]
pub struct SoftpalProfileDetectorAdapter;

// NeXAS engine detector adapter. Identify-only: classifies `engine=nexas` from
// the `PAC\0` container magic (+ sane header + category-archive names); PAC
// extraction / decompression live in the `kaifuu-nexas` crate and are reported
// Unsupported here. See the `NEXAS_*` constants above for signature provenance.
#[derive(Debug, Default, Clone, Copy)]
pub struct NexasProfileDetectorAdapter;

impl FixtureAdapter {
    fn source_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join("source.json")
    }

    fn read_source(game_dir: &Path) -> KaifuuResult<(String, Value)> {
        let source_text = fs::read_to_string(Self::source_path(game_dir))?;
        let source = serde_json::from_str(&source_text)?;
        Ok((source_text, source))
    }

    fn source_locale(source: &Value) -> String {
        source["sourceLocale"]
            .as_str()
            .unwrap_or("ja-JP")
            .to_string()
    }

    fn requirements(source_present: bool) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: "source.json".to_string(),
                status: if source_present {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "fixture games require a plaintext source.json manifest".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "host_os".to_string(),
                status: RequirementStatus::Satisfied,
                description: "fixture adapter uses portable JSON file IO and has no engine runtime platform constraint".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "decryption_key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "fixture projects are plaintext JSON and do not require user-provided keys".to_string(),
                placeholder: None,
                secret: true,
            },
        ]
    }

    fn text_surface_from_fixture_name(name: &str) -> TextSurface {
        match name {
            "narration" => TextSurface::Narration,
            "speaker_name" => TextSurface::SpeakerName,
            "choice_label" => TextSurface::ChoiceLabel,
            "ui_label" => TextSurface::UiLabel,
            "tutorial_text" => TextSurface::TutorialText,
            "database_entry" => TextSurface::DatabaseEntry,
            "song_title" => TextSurface::SongTitle,
            "image_text" => TextSurface::ImageText,
            "metadata_text" => TextSurface::MetadataText,
            _ => TextSurface::Dialogue,
        }
    }

    fn patch_failure(
        error_code: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure {
            error_code: error_code.into(),
            adapter: FIXTURE_ADAPTER_ID.to_string(),
            engine: Some("fixture".to_string()),
            detected_variant: Some("plain-json-source".to_string()),
            asset_ref: Some(asset_ref.into()),
            required_capability: Some(Capability::LineParityPatching),
            support_boundary: support_boundary.into(),
            remediation: Some(remediation.into()),
        }
    }

    fn protected_span_patch_failures(
        entry: &kaifuu_core::PatchExportEntry,
        required_spans: &[ProtectedSpan],
    ) -> Vec<AdapterFailure> {
        let mut failures = Vec::new();
        let mut required_spans_by_raw = BTreeMap::<&str, Vec<&ProtectedSpan>>::new();
        for span in required_spans {
            if span.raw.is_empty() {
                continue;
            }
            required_spans_by_raw
                .entry(span.raw.as_str())
                .or_default()
                .push(span);
        }

        let mut declared_counts = BTreeMap::<&str, usize>::new();
        let mut declared_ranges = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
        let mut matched_source_identities = BTreeSet::<String>::new();
        for mapping in &entry.protected_span_mappings {
            if mapping.raw.is_empty() {
                continue;
            }
            *declared_counts.entry(mapping.raw.as_str()).or_default() += 1;
            if !mapping.matches_target_text(&entry.target_text) {
                failures.push(Self::patch_failure(
                    "protected_span_mapping_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires protectedSpanMappings to point at raw text in targetText",
                    format!(
                        "Align protectedSpanMappings for protected span {:?} in sourceUnitKey {}",
                        mapping.raw, entry.source_unit_key
                    ),
                ));
                continue;
            }
            if let Some(source_spans) = required_spans_by_raw.get(mapping.raw.as_str())
                && !Self::protected_span_mapping_source_identity_matches(
                    mapping,
                    source_spans,
                    &mut matched_source_identities,
                )
            {
                failures.push(Self::patch_failure(
                    "protected_span_mapping_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires duplicate protectedSpanMappings to reference a real source protected span identity",
                    format!(
                        "Align sourceSpanId/sourceStartByte/sourceEndByte for protected span {:?} in sourceUnitKey {}",
                        mapping.raw, entry.source_unit_key
                    ),
                ));
                continue;
            }
            if !declared_ranges
                .entry(mapping.raw.as_str())
                .or_default()
                .insert((mapping.target_start, mapping.target_end))
            {
                failures.push(Self::patch_failure(
                    "protected_span_duplicate_mapping",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires duplicate protected spans to use distinct targetText ranges",
                    format!(
                        "Map each protected span {:?} occurrence to a distinct target byte range in sourceUnitKey {}",
                        mapping.raw, entry.source_unit_key
                    ),
                ));
            }
        }

        let mut protected_raws = BTreeSet::new();
        for raw in required_spans_by_raw.keys().chain(declared_counts.keys()) {
            protected_raws.insert(*raw);
        }
        for raw in protected_raws {
            let required_count = required_spans_by_raw.get(raw).map_or(0, std::vec::Vec::len);
            let declared_count = declared_counts.get(raw).copied().unwrap_or_default();
            if declared_count < required_count {
                failures.push(Self::patch_failure(
                    "protected_span_missing",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires protectedSpanMappings to account for every protected span in the source unit",
                    format!(
                        "Add protectedSpanMappings for protected span {raw:?} in sourceUnitKey {}",
                        entry.source_unit_key
                    ),
                ));
            }

            let required_count = required_count.max(declared_count);
            let actual_count = entry.target_text.match_indices(raw).count();
            let distinct_declared_count = declared_ranges.get(raw).map_or(0, BTreeSet::len);
            if actual_count < required_count || distinct_declared_count < declared_count {
                failures.push(Self::patch_failure(
                    "protected_span_missing",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires targetText to preserve protected span raw text",
                    format!(
                        "Restore protected span {raw:?} in targetText for sourceUnitKey {}",
                        entry.source_unit_key
                    ),
                ));
            }
        }
        failures
    }

    fn protected_span_mapping_source_identity_matches(
        mapping: &ProtectedSpanMapping,
        source_spans: &[&ProtectedSpan],
        matched_source_identities: &mut BTreeSet<String>,
    ) -> bool {
        let duplicate_raw = source_spans.len() > 1;
        if duplicate_raw && !mapping.has_source_identity() {
            return false;
        }

        if !mapping.has_source_identity() {
            return true;
        }

        let Some(source_span) = source_spans.iter().find(|source_span| {
            mapping.matches_source_span(
                &source_span.raw,
                Some(source_span.start),
                Some(source_span.end),
                source_span.span_id.as_deref(),
            )
        }) else {
            return false;
        };

        let source_identity_key = if let Some(span_id) = source_span.span_id.as_deref() {
            format!("{span_id}:{}:{}", source_span.start, source_span.end)
        } else {
            format!("{}:{}", source_span.start, source_span.end)
        };
        matched_source_identities.insert(source_identity_key)
    }

    fn profile_from_source(&self, source_text: &str, source: &Value) -> KaifuuResult<GameProfile> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "Synthetic plain JSON fixture with text units in source.json".to_string(),
        );

        let asset = self.asset_from_source(source_text, source)?;
        let layered_access = LayeredAccessProfile::plaintext_identity_for_asset(
            asset.asset_id.clone(),
            asset.path.clone(),
            &asset.text_surfaces,
            "/units/*/sourceText",
        );
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 1),
            game_id: source["gameId"]
                .as_str()
                .unwrap_or("fixture-game")
                .to_string(),
            title: source["title"]
                .as_str()
                .unwrap_or("Fixture Game")
                .to_string(),
            source_locale: Self::source_locale(source),
            engine: EngineProfile {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                engine_family: "fixture".to_string(),
                engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                detected_variant: "plain-json-source".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![asset],
            layered_access: Some(layered_access),
            capabilities: self.capabilities().reports,
            requirements: Self::requirements(true),
            metadata,
        };
        profile.normalize();
        Ok(profile)
    }

    fn asset_from_source(&self, source_text: &str, source: &Value) -> KaifuuResult<AssetProfile> {
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let mut text_surfaces = units
            .iter()
            .map(|unit| {
                Self::text_surface_from_fixture_name(
                    unit["textSurface"].as_str().unwrap_or("dialogue"),
                )
            })
            .collect::<Vec<_>>();
        text_surfaces.sort_by_key(|surface| serde_json::to_string(surface).unwrap_or_default());
        text_surfaces.dedup();
        Ok(AssetProfile {
            asset_id: "source.json".to_string(),
            path: "source.json".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces,
            source_hash: Some(content_hash(source_text)),
            patching: CapabilityReport::limited(
                Capability::LineParityPatching,
                "patches existing fixture units by sourceUnitKey; new, deleted, and reordered units are not supported",
            ),
        })
    }

    fn asset_inventory_from_source(
        &self,
        source_text: &str,
        source: &Value,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "Synthetic plain JSON fixture asset inventory; non-text surfaces are reported from explicit fixture metadata and are not OCR results"
                .to_string(),
        );

        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("asset-inventory", 1),
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            source_locale: Self::source_locale(source),
            assets: self.asset_inventory_assets_from_source(source_text, source)?,
            surfaces: self.asset_inventory_surfaces_from_source(source)?,
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata,
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn asset_inventory_assets_from_source(
        &self,
        source_text: &str,
        source: &Value,
    ) -> KaifuuResult<Vec<AssetInventoryAsset>> {
        let mut assets = vec![AssetInventoryAsset {
            asset_id: "source.json".to_string(),
            asset_key: "source.json".to_string(),
            asset_kind: AssetInventoryAssetKind::Script,
            path: Some("source.json".to_string()),
            source_hash: Some(content_hash(source_text)),
            metadata: BTreeMap::new(),
        }];

        for asset in source["assets"].as_array().map_or(&[][..], Vec::as_slice) {
            let asset_id = require_str(asset, "assetId")?;
            let asset_key = require_str(asset, "assetKey")?;
            let asset_kind = Self::asset_inventory_asset_kind(require_str(asset, "assetKind")?)?;
            let path = asset["path"].as_str().map(str::to_string);
            let source_hash = asset["sourceHash"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(content_hash(&format!("{asset_key}:{}", asset["assetKind"]))));
            assets.push(AssetInventoryAsset {
                asset_id: asset_id.to_string(),
                asset_key: asset_key.to_string(),
                asset_kind,
                path,
                source_hash,
                metadata: Self::string_metadata(asset.get("metadata"))?,
            });
        }

        Ok(assets)
    }

    fn asset_inventory_surfaces_from_source(
        &self,
        source: &Value,
    ) -> KaifuuResult<Vec<AssetInventorySurface>> {
        source["assetSurfaces"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .enumerate()
            .map(|(index, surface)| {
                let surface_id = surface["surfaceId"]
                    .as_str().map_or_else(|| deterministic_id("asset-surface", index + 1), str::to_string);
                let source_text = surface["sourceText"].as_str().map(str::to_string);
                let source_hash = surface["sourceHash"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| source_text.as_deref().map(content_hash));
                let limitation = surface["patchingLimitation"]
                    .as_str()
                    .unwrap_or("fixture adapter reports this asset surface but cannot patch or edit non-text assets");
                Ok(AssetInventorySurface {
                    surface_id,
                    asset_surface_kind: Self::asset_inventory_surface_kind(require_str(
                        surface,
                        "assetSurfaceKind",
                    )?)?,
                    source_asset_ref: Self::asset_inventory_asset_ref(surface)?,
                    source_location: surface.get("sourceLocation").cloned(),
                    source_text,
                    source_hash,
                    text_source_kind: Self::asset_inventory_text_source_kind(require_str(
                        surface,
                        "textSourceKind",
                    )?)?,
                    patch_mode: Self::asset_inventory_patch_mode(require_str(
                        surface,
                        "patchMode",
                    )?)?,
                    patching: CapabilityReport::unsupported(
                        Capability::AssetTextPatching,
                        limitation,
                    ),
                    patch_payload: None,
                    metadata_hash: None,
                    notes: surface["notes"]
                        .as_array()
                        .map_or(&[][..], Vec::as_slice)
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                })
            })
            .collect()
    }

    fn asset_inventory_asset_ref(surface: &Value) -> KaifuuResult<AssetInventoryAssetRef> {
        let asset_ref = surface
            .get("sourceAssetRef")
            .ok_or("asset surface missing sourceAssetRef")?;
        Ok(AssetInventoryAssetRef {
            asset_id: require_str(asset_ref, "assetId")?.to_string(),
            asset_key: asset_ref["assetKey"].as_str().map(str::to_string),
        })
    }

    fn string_metadata(value: Option<&Value>) -> KaifuuResult<BTreeMap<String, String>> {
        let Some(value) = value else {
            return Ok(BTreeMap::new());
        };
        let object = value.as_object().ok_or("metadata must be a JSON object")?;
        let mut metadata = BTreeMap::new();
        for (key, value) in object {
            let Some(value) = value.as_str() else {
                return Err(format!("metadata.{key} must be a string").into());
            };
            metadata.insert(key.clone(), value.to_string());
        }
        Ok(metadata)
    }

    fn asset_inventory_asset_kind(kind: &str) -> KaifuuResult<AssetInventoryAssetKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn asset_inventory_surface_kind(kind: &str) -> KaifuuResult<AssetInventorySurfaceKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn asset_inventory_text_source_kind(kind: &str) -> KaifuuResult<AssetInventoryTextSourceKind> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn asset_inventory_patch_mode(kind: &str) -> KaifuuResult<AssetInventoryPatchMode> {
        Ok(serde_json::from_value(Value::String(kind.to_string()))?)
    }

    fn protected_spans_for_unit(unit: &Value, text: &str) -> KaifuuResult<Vec<ProtectedSpan>> {
        let mut spans = Self::parse_fixture_markup_spans(text)?;
        spans.extend(Self::explicit_protected_spans_for_unit(unit, text)?);
        let mut spans = normalize_protected_spans(text, spans)?;
        for (index, span) in spans.iter_mut().enumerate() {
            if span.span_id.is_none() {
                span.span_id = Some(deterministic_id("span", index + 1));
            }
        }
        Ok(spans)
    }

    fn encoded_string_slot_for_unit(
        unit: &Value,
        protected_spans: &[ProtectedSpan],
    ) -> KaifuuResult<Option<EncodedStringSlot>> {
        let Some(slot_value) = unit.get("encodedStringSlot") else {
            return Ok(None);
        };
        let mut slot: EncodedStringSlot = serde_json::from_value(slot_value.clone())?;
        if slot.protected_spans.is_empty() {
            slot.protected_spans = protected_spans
                .iter()
                .filter(|span| !span.raw.is_empty())
                .map(|span| {
                    EncodedStringSlotProtectedSpan::new(span.raw.clone()).with_source_identity(
                        span.span_id.clone(),
                        span.start,
                        span.end,
                    )
                })
                .collect();
        }
        Ok(Some(slot))
    }

    fn source_slot_bytes_for_unit(unit: &Value) -> KaifuuResult<Option<Vec<u8>>> {
        unit.get("encodedStringSlot")
            .and_then(|slot| slot.get("sourceBytesHex"))
            .and_then(Value::as_str)
            .map(parse_hex_bytes)
            .transpose()
            .map_err(Into::into)
    }

    fn patch_preflight_failures(
        &self,
        source: &Value,
        patch_export: &kaifuu_core::PatchExport,
    ) -> KaifuuResult<Vec<AdapterFailure>> {
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let mut source_hashes = BTreeMap::new();
        let mut source_protected_spans = BTreeMap::new();
        let mut encoded_slots = BTreeMap::new();
        let mut seen_source_unit_keys = BTreeSet::new();
        let mut duplicate_source_unit_keys = BTreeSet::new();

        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            let unit_source_text = require_str(unit, "sourceText")?;
            if !seen_source_unit_keys.insert(key.to_string()) {
                duplicate_source_unit_keys.insert(key.to_string());
                continue;
            }
            let protected_spans = Self::protected_spans_for_unit(unit, unit_source_text)?;
            if let Some(slot) = Self::encoded_string_slot_for_unit(unit, &protected_spans)? {
                encoded_slots.insert(
                    key.to_string(),
                    (slot, Self::source_slot_bytes_for_unit(unit)?),
                );
            }
            source_hashes.insert(key.to_string(), content_hash(unit_source_text));
            source_protected_spans.insert(key.to_string(), protected_spans);
        }

        if !duplicate_source_unit_keys.is_empty() {
            let duplicate_keys = duplicate_source_unit_keys
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(vec![Self::patch_failure(
                "duplicate_source_unit_key_in_source",
                format!("source.json#{duplicate_keys}"),
                "fixture patching requires source.json units to have unique sourceUnitKey values",
                format!(
                    "Fix duplicate source.json sourceUnitKey values before applying this export: {duplicate_keys}"
                ),
            )]);
        }

        let mut failures = Vec::new();
        let mut entries_by_source_unit_key = BTreeMap::new();
        for entry in &patch_export.entries {
            if entries_by_source_unit_key
                .insert(entry.source_unit_key.as_str(), entry)
                .is_some()
            {
                failures.push(Self::patch_failure(
                    "duplicate_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires at most one patch entry per sourceUnitKey",
                    format!(
                        "Remove duplicate patch entries for sourceUnitKey {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
            }

            let Some(current_hash) = source_hashes.get(&entry.source_unit_key) else {
                failures.push(Self::patch_failure(
                    "unmatched_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching only updates existing source.json units by sourceUnitKey",
                    format!(
                        "Re-extract the fixture or remove patch entry {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
                continue;
            };

            if current_hash != &entry.source_hash {
                failures.push(Self::patch_failure(
                    "source_hash_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires PatchExportEntry.sourceHash to match the current sourceText hash",
                    format!(
                        "Re-extract sourceUnitKey {} and regenerate the patch export before applying it",
                        entry.source_unit_key
                    ),
                ));
            }

            let required_spans = source_protected_spans
                .get(&entry.source_unit_key)
                .expect("source hashes and protected spans should have matching keys");
            failures.extend(Self::protected_span_patch_failures(entry, required_spans));

            if let Some((slot, current_slot_bytes)) = encoded_slots.get(&entry.source_unit_key) {
                let report = slot.preflight(
                    &entry.target_text,
                    &entry.protected_span_mappings,
                    current_slot_bytes.as_deref(),
                );
                failures.extend(report.diagnostics.into_iter().map(|diagnostic| {
                    AdapterFailure::encoded_string_slot_preflight(
                        FIXTURE_ADAPTER_ID,
                        "fixture",
                        "plain-json-source",
                        format!(
                            "source.json#{}#{}",
                            entry.source_unit_key, diagnostic.slot_id
                        ),
                        diagnostic,
                    )
                }));
            }
        }

        Ok(failures)
    }

    fn explicit_protected_spans_for_unit(
        unit: &Value,
        text: &str,
    ) -> KaifuuResult<Vec<ProtectedSpan>> {
        unit["protectedSpans"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|span| {
                let raw = require_str(span, "raw")?;
                let (start, end) = Self::fixture_span_offsets(
                    text,
                    raw,
                    require_u64(span, "start")?,
                    require_u64(span, "end")?,
                );
                Ok(ProtectedSpan::new(
                    require_str(span, "kind")?,
                    raw,
                    start,
                    end,
                    span["preserveMode"].as_str().unwrap_or(""),
                ))
            })
            .collect()
    }

    fn fixture_span_offsets(text: &str, raw: &str, start: u64, end: u64) -> (u64, u64) {
        if Self::span_range_matches(text, raw, start, end) {
            return (start, end);
        }
        let Some(byte_start) = Self::char_offset_to_byte(text, start) else {
            return (start, end);
        };
        let Some(byte_end) = Self::char_offset_to_byte(text, end) else {
            return (start, end);
        };
        if Self::span_range_matches(text, raw, byte_start, byte_end) {
            return (byte_start, byte_end);
        }
        (start, end)
    }

    fn span_range_matches(text: &str, raw: &str, start: u64, end: u64) -> bool {
        let Ok(start) = usize::try_from(start) else {
            return false;
        };
        let Ok(end) = usize::try_from(end) else {
            return false;
        };
        start < end
            && end <= text.len()
            && text.is_char_boundary(start)
            && text.is_char_boundary(end)
            && &text[start..end] == raw
    }

    fn char_offset_to_byte(text: &str, offset: u64) -> Option<u64> {
        let offset = usize::try_from(offset).ok()?;
        if offset == text.chars().count() {
            return Some(text.len() as u64);
        }
        text.char_indices()
            .nth(offset)
            .map(|(byte_offset, _)| byte_offset as u64)
    }

    fn parse_fixture_markup_spans(text: &str) -> KaifuuResult<Vec<ProtectedSpan>> {
        let mut spans = Vec::new();
        let mut index = 0;
        while index < text.len() {
            let parsed = match text.as_bytes()[index] {
                b'{' => Some(Self::parse_braced_placeholder(text, index)),
                b'<' => Some(Self::parse_angle_markup(text, index)),
                b'\\' => Self::parse_backslash_markup(text, index),
                _ => None,
            };
            if let Some((span, next_index)) = parsed {
                spans.push(span);
                index = next_index;
                continue;
            }
            let next_char = text[index..]
                .chars()
                .next()
                .ok_or("fixture parser index must point at a UTF-8 character")?;
            index += next_char.len_utf8();
        }
        Ok(spans)
    }

    fn parse_braced_placeholder(text: &str, start: usize) -> (ProtectedSpan, usize) {
        let content_start = start + 1;
        let Some(relative_end) = text[content_start..].find('}') else {
            let raw = &text[start..];
            return (
                ProtectedSpan::control_markup(
                    raw,
                    start as u64,
                    text.len() as u64,
                    "unknown_unclosed_placeholder",
                    vec![],
                ),
                text.len(),
            );
        };
        let content_end = content_start + relative_end;
        let end = content_end + 1;
        let raw = &text[start..end];
        let name = &text[content_start..content_end];
        let span = if Self::is_fixture_placeholder_name(name) {
            ProtectedSpan::variable_placeholder(raw, start as u64, end as u64, name)
        } else {
            ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                "unknown_placeholder",
                vec![name.to_string()],
            )
        };
        (span, end)
    }

    fn is_fixture_placeholder_name(name: &str) -> bool {
        !name.is_empty()
            && name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'_' | b'-' | b'.' | b':' | b'[' | b']')
            })
    }

    fn parse_angle_markup(text: &str, start: usize) -> (ProtectedSpan, usize) {
        let content_start = start + 1;
        let Some(relative_end) = text[content_start..].find('>') else {
            let raw = &text[start..];
            return (
                ProtectedSpan::control_markup(
                    raw,
                    start as u64,
                    text.len() as u64,
                    "unknown_unclosed_tag",
                    vec![],
                ),
                text.len(),
            );
        };
        let content_end = content_start + relative_end;
        let end = content_end + 1;
        if let Some(span) = Self::parse_ruby_markup(text, start, content_start, content_end, end) {
            return (span, end);
        }
        (
            Self::parse_control_tag(text, start, content_start, content_end, end),
            end,
        )
    }

    fn parse_ruby_markup(
        text: &str,
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    ) -> Option<ProtectedSpan> {
        let content = &text[content_start..content_end];
        let equals_index = content.find('=')?;
        let name = content[..equals_index].trim();
        if !matches!(name, "ruby" | "furigana") {
            return None;
        }
        let values_start = content_start + equals_index + 1;
        let values = &text[values_start..content_end];
        let separator_index = values.find('|')?;
        let base_start = values_start;
        let base_end = values_start + separator_index;
        let annotation_start = base_end + 1;
        let annotation_end = content_end;
        let annotation_text = &text[annotation_start..annotation_end];
        let raw = &text[start..end];
        let mut span = ProtectedSpan::new(
            "ruby_annotation",
            raw,
            start as u64,
            end as u64,
            "locale_policy",
        );
        span.parsed_name = Some(name.to_string());
        span.arguments = Some(vec![
            text[base_start..base_end].to_string(),
            annotation_text.to_string(),
        ]);
        span.base_start_byte = Some(base_start as u64);
        span.base_end_byte = Some(base_end as u64);
        span.annotation_start_byte = Some(annotation_start as u64);
        span.annotation_end_byte = Some(annotation_end as u64);
        span.annotation_text = Some(annotation_text.to_string());
        span.display_mode = Some(name.to_string());
        Some(span)
    }

    fn parse_control_tag(
        text: &str,
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    ) -> ProtectedSpan {
        let content = text[content_start..content_end].trim();
        let raw = &text[start..end];
        let (parsed_name, arguments) = Self::control_tag_metadata(content);
        ProtectedSpan::control_markup(raw, start as u64, end as u64, parsed_name, arguments)
    }

    fn control_tag_metadata(content: &str) -> (String, Vec<String>) {
        if content.is_empty() {
            return ("unknown_empty_tag".to_string(), vec![]);
        }
        if let Some(closing) = content.strip_prefix('/') {
            let name = Self::normalize_fixture_markup_name(closing);
            return (name, vec!["close".to_string()]);
        }
        let separator = content
            .char_indices()
            .find(|(_, character)| matches!(character, '=' | ':' | ' ' | '\t'));
        let Some((separator_index, separator_char)) = separator else {
            return (Self::normalize_fixture_markup_name(content), vec![]);
        };
        let name = Self::normalize_fixture_markup_name(&content[..separator_index]);
        let argument_text = content[separator_index + separator_char.len_utf8()..].trim();
        let arguments = if argument_text.is_empty() {
            vec![]
        } else {
            argument_text
                .split([',', '|'])
                .map(str::trim)
                .filter(|argument| !argument.is_empty())
                .map(str::to_string)
                .collect()
        };
        (name, arguments)
    }

    fn normalize_fixture_markup_name(name: &str) -> String {
        let name = name.trim();
        if name.is_empty() {
            "unknown_markup".to_string()
        } else {
            name.to_ascii_lowercase()
        }
    }

    fn parse_backslash_markup(text: &str, start: usize) -> Option<(ProtectedSpan, usize)> {
        let after_slash = start + 1;
        let Some(next) = text[after_slash..].chars().next() else {
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_trailing_backslash",
                vec![],
            ));
        };
        if matches!(next, '.' | '|' | '!') {
            let end = after_slash + next.len_utf8();
            return Some((
                ProtectedSpan::control_markup(
                    &text[start..end],
                    start as u64,
                    end as u64,
                    "wait",
                    vec![next.to_string()],
                ),
                end,
            ));
        }
        if !next.is_ascii_alphabetic() {
            return Some(Self::parse_symbol_backslash_markup(
                text,
                start,
                after_slash,
                next,
            ));
        }
        let code_end = text[after_slash..]
            .char_indices()
            .take_while(|(_, character)| character.is_ascii_alphabetic())
            .last()
            .map(|(index, character)| after_slash + index + character.len_utf8())?;
        if !text[code_end..].starts_with('[') {
            let code = &text[after_slash..code_end];
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                code_end,
                Self::normalize_fixture_markup_name(code),
                vec!["missing_bracket".to_string()],
            ));
        }
        let argument_start = code_end + 1;
        let Some(relative_end) = text[argument_start..].find(']') else {
            let code = &text[after_slash..code_end];
            return Some(Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_unclosed_backslash_command",
                vec![code.to_string()],
            ));
        };
        let argument_end = argument_start + relative_end;
        let end = argument_end + 1;
        let code = &text[after_slash..code_end];
        let argument = &text[argument_start..argument_end];
        let raw = &text[start..end];
        let upper_code = code.to_ascii_uppercase();
        let mut span = match upper_code.as_str() {
            "N" | "NAME" => ProtectedSpan::variable_placeholder(
                raw,
                start as u64,
                end as u64,
                format!("name[{argument}]"),
            ),
            "V" | "VAR" => ProtectedSpan::variable_placeholder(
                raw,
                start as u64,
                end as u64,
                format!("variable[{argument}]"),
            ),
            "C" | "COLOR" => ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                "color",
                vec![argument.to_string()],
            ),
            _ => ProtectedSpan::control_markup(
                raw,
                start as u64,
                end as u64,
                Self::normalize_fixture_markup_name(code),
                vec![argument.to_string()],
            ),
        };
        span.parsed_name = Some(match upper_code.as_str() {
            "N" | "NAME" => "name_variable".to_string(),
            "V" | "VAR" => "runtime_variable".to_string(),
            "C" | "COLOR" => "color".to_string(),
            _ => Self::normalize_fixture_markup_name(code),
        });
        span.arguments = Some(vec![argument.to_string()]);
        Some((span, end))
    }

    fn parse_symbol_backslash_markup(
        text: &str,
        start: usize,
        after_slash: usize,
        command: char,
    ) -> (ProtectedSpan, usize) {
        let command_end = after_slash + command.len_utf8();
        if text[command_end..].starts_with('[') {
            let argument_start = command_end + 1;
            if let Some(relative_end) = text[argument_start..].find(']') {
                let argument_end = argument_start + relative_end;
                let end = argument_end + 1;
                return Self::unknown_backslash_markup(
                    text,
                    start,
                    end,
                    "unknown_backslash_command",
                    vec![
                        command.to_string(),
                        text[argument_start..argument_end].to_string(),
                    ],
                );
            }
            return Self::unknown_backslash_markup(
                text,
                start,
                text.len(),
                "unknown_unclosed_backslash_command",
                vec![command.to_string()],
            );
        }

        Self::unknown_backslash_markup(
            text,
            start,
            command_end,
            "unknown_backslash_command",
            vec![command.to_string()],
        )
    }

    fn unknown_backslash_markup(
        text: &str,
        start: usize,
        end: usize,
        parsed_name: impl Into<String>,
        arguments: Vec<String>,
    ) -> (ProtectedSpan, usize) {
        (
            ProtectedSpan::control_markup(
                &text[start..end],
                start as u64,
                end as u64,
                parsed_name,
                arguments,
            ),
            end,
        )
    }
}

impl EngineAdapter for FixtureAdapter {
    fn id(&self) -> &'static str {
        FIXTURE_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            FIXTURE_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::limited(
                    Capability::Patching,
                    "writes source.json only; does not rebuild engine archives or binary assets",
                ),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::limited(
                    Capability::NonTextSurfaceExtraction,
                    "reports explicit fixture asset metadata only; does not perform OCR, audio analysis, font inspection, or video frame analysis",
                ),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::limited(
                    Capability::LineParityPatching,
                    "requires patch entries to match existing sourceUnitKey values",
                ),
                CapabilityReport::supported(Capability::ContainerAccess),
                CapabilityReport::supported(Capability::CryptoAccess),
                CapabilityReport::supported(Capability::CodecAccess),
                CapabilityReport::limited(
                    Capability::PatchBack,
                    "rewrites plaintext source.json; archive rebuild and binary patch-back are not supported",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "image, audio, video, and external asset text are outside the fixture format",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages are handled by kaifuu-delta, not this engine adapter",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "fixture projects are plaintext JSON and never encrypted",
                ),
                CapabilityReport::unsupported(
                    Capability::KeyProfile,
                    "fixture projects do not use user-provided keys",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime validation belongs to Utsushi fixture plumbing",
                ),
            ],
            AdapterCapabilityMatrix::new(
                FIXTURE_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::partial(vec![
                    "writes source.json only; does not rebuild engine archives or binary assets"
                        .to_string(),
                    "requires patch entries to match existing sourceUnitKey values".to_string(),
                ]),
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity())
        .with_helper_requirements(vec![AdapterHelperRequirementDeclaration::new(
            FIXTURE_HELPER_REGISTRY_ID,
            vec![HelperCapability::FixtureInvocation],
            FIXTURE_HELPER_ALLOWLIST_REF_ID,
        )])
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let source_path = Self::source_path(request.game_dir);
        if !source_path.exists() {
            return Ok(DetectionResult {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                evidence: vec![DetectionEvidence {
                    path: "source.json".to_string(),
                    kind: "required_manifest".to_string(),
                    status: EvidenceStatus::Missing,
                    detail: "source.json is required for the fixture engine".to_string(),
                }],
                requirements: Self::requirements(false),
                capabilities: self.capabilities().reports,
            });
        }
        let source_text = fs::read_to_string(&source_path)?;
        let Ok(source) = serde_json::from_str::<Value>(&source_text) else {
            return Ok(DetectionResult {
                adapter_id: FIXTURE_ADAPTER_ID.to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: None,
                evidence: vec![DetectionEvidence {
                    path: "source.json".to_string(),
                    kind: "fixture_source".to_string(),
                    status: EvidenceStatus::Invalid,
                    detail: "source.json exists but is not valid JSON".to_string(),
                }],
                requirements: Self::requirements(true),
                capabilities: self.capabilities().reports,
            });
        };
        let detected = source["units"].is_array();
        Ok(DetectionResult {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "fixture".to_string()),
            engine_version: detected.then(|| env!("CARGO_PKG_VERSION").to_string()),
            detected_variant: detected.then(|| "plain-json-source".to_string()),
            evidence: vec![DetectionEvidence {
                path: "source.json".to_string(),
                kind: "fixture_source".to_string(),
                status: if detected {
                    EvidenceStatus::Matched
                } else {
                    EvidenceStatus::Missing
                },
                detail: if detected {
                    "source.json contains a units array".to_string()
                } else {
                    "source.json exists but is missing units".to_string()
                },
            }],
            requirements: Self::requirements(true),
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        self.profile_from_source(&source_text, &source)
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        Ok(AssetList {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            assets: vec![self.asset_from_source(&source_text, &source)?],
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        self.asset_inventory_from_source(&source_text, &source)
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let (source_text, source) = Self::read_source(request.game_dir)?;
        let profile = self.profile_from_source(&source_text, &source)?;
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let source_locale = Self::source_locale(&source);
        let bridge_units = units
            .iter()
            .enumerate()
            .map(|(index, unit)| {
                let source_unit_key = require_str(unit, "sourceUnitKey")?;
                let text = require_str(unit, "sourceText")?;
                let protected_spans = Self::protected_spans_for_unit(unit, text)?;
                Ok(BridgeUnit {
                    bridge_unit_id: deterministic_id("bridge-unit", index + 1),
                    source_unit_key: source_unit_key.to_string(),
                    occurrence_id: format!("occurrence-{}", index + 1),
                    source_hash: content_hash(text),
                    source_locale: source_locale.clone(),
                    source_text: text.to_string(),
                    speaker: unit["speaker"].as_str().unwrap_or("").to_string(),
                    text_surface: unit["textSurface"]
                        .as_str()
                        .unwrap_or("dialogue")
                        .to_string(),
                    protected_spans,
                    patch_ref: PatchRef {
                        asset_id: "source.json".to_string(),
                        write_mode: "replace".to_string(),
                        source_unit_key: source_unit_key.to_string(),
                    },
                })
            })
            .collect::<KaifuuResult<Vec<_>>>()?;
        Ok(ExtractionResult {
            adapter_id: FIXTURE_ADAPTER_ID.to_string(),
            profile,
            bridge: BridgeBundle {
                schema_version: "0.1.0".to_string(),
                bridge_id: deterministic_id("bridge", 1),
                source_bundle_hash: content_hash(&source_text),
                source_locale,
                extractor_name: "kaifuu-fixture".to_string(),
                extractor_version: env!("CARGO_PKG_VERSION").to_string(),
                units: bridge_units,
            },
            warnings: vec![],
        })
    }

    fn patch_preflight(
        &self,
        request: kaifuu_core::PatchPreflightRequest<'_>,
    ) -> KaifuuResult<PatchResult> {
        let (_source_text, source) = Self::read_source(request.game_dir)?;
        let failures = self.patch_preflight_failures(&source, request.patch_export)?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-preflight", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            output_hash: content_hash("fixture patch preflight without output"),
            failures,
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let source_path = Self::source_path(request.game_dir);
        let source_text = fs::read_to_string(&source_path)?;
        let mut source: Value = serde_json::from_str(&source_text)?;
        let units = source["units"]
            .as_array()
            .ok_or("fixture source missing units")?;
        let preflight_failures = self.patch_preflight_failures(&source, request.patch_export)?;
        if !preflight_failures.is_empty() {
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures: preflight_failures,
            });
        }
        let mut source_hashes = BTreeMap::new();
        let mut source_protected_spans = BTreeMap::new();
        let mut seen_source_unit_keys = BTreeSet::new();
        let mut duplicate_source_unit_keys = BTreeSet::new();
        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            let unit_source_text = require_str(unit, "sourceText")?;
            if !seen_source_unit_keys.insert(key.to_string()) {
                duplicate_source_unit_keys.insert(key.to_string());
                continue;
            }
            source_hashes.insert(key.to_string(), content_hash(unit_source_text));
            source_protected_spans.insert(
                key.to_string(),
                Self::protected_spans_for_unit(unit, unit_source_text)?,
            );
        }

        if !duplicate_source_unit_keys.is_empty() {
            let duplicate_keys = duplicate_source_unit_keys
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures: vec![Self::patch_failure(
                    "duplicate_source_unit_key_in_source",
                    format!("source.json#{duplicate_keys}"),
                    "fixture patching requires source.json units to have unique sourceUnitKey values",
                    format!(
                        "Fix duplicate source.json sourceUnitKey values before applying this export: {duplicate_keys}"
                    ),
                )],
            });
        }

        let mut failures = Vec::new();
        let mut entries_by_source_unit_key = BTreeMap::new();
        for entry in &request.patch_export.entries {
            if entries_by_source_unit_key
                .insert(entry.source_unit_key.as_str(), entry)
                .is_some()
            {
                failures.push(Self::patch_failure(
                    "duplicate_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires at most one patch entry per sourceUnitKey",
                    format!(
                        "Remove duplicate patch entries for sourceUnitKey {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
            }

            let Some(current_hash) = source_hashes.get(&entry.source_unit_key) else {
                failures.push(Self::patch_failure(
                    "unmatched_source_unit_key",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching only updates existing source.json units by sourceUnitKey",
                    format!(
                        "Re-extract the fixture or remove patch entry {} before applying this export",
                        entry.source_unit_key
                    ),
                ));
                continue;
            };

            if current_hash != &entry.source_hash {
                failures.push(Self::patch_failure(
                    "source_hash_mismatch",
                    format!("source.json#{}", entry.source_unit_key),
                    "fixture patching requires PatchExportEntry.sourceHash to match the current sourceText hash",
                    format!(
                        "Re-extract sourceUnitKey {} and regenerate the patch export before applying it",
                        entry.source_unit_key
                    ),
                ));
            }

            let required_spans = source_protected_spans
                .get(&entry.source_unit_key)
                .expect("source hashes and protected spans should have matching keys");
            failures.extend(Self::protected_span_patch_failures(entry, required_spans));
        }

        if !failures.is_empty() {
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures,
            });
        }

        let units = source["units"]
            .as_array_mut()
            .ok_or("fixture source missing units")?;
        let mut remaining_entries = entries_by_source_unit_key;
        for unit in units {
            let key = require_str(unit, "sourceUnitKey")?;
            if let Some(entry) = remaining_entries.remove(key) {
                unit["targetText"] = json!(entry.target_text);
            }
        }
        if !remaining_entries.is_empty() {
            let unapplied_keys = remaining_entries
                .keys()
                .copied()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(PatchResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("patch-result", 1),
                patch_export_id: request.patch_export.patch_export_id.clone(),
                status: OperationStatus::Failed,
                output_hash: content_hash(&source_text),
                failures: vec![Self::patch_failure(
                    "validated_patch_entry_not_applied",
                    format!("source.json#{unapplied_keys}"),
                    "fixture patching must apply every validated PatchExportEntry exactly once",
                    format!(
                        "Re-extract the fixture or regenerate the patch export; unapplied sourceUnitKey values: {unapplied_keys}"
                    ),
                )],
            });
        }

        let output_path = safe_join_relative(request.output_dir, "source.json")?;
        let patched_text = format!("{}\n", serde_json::to_string_pretty(&source)?);
        atomic_write_text(&output_path, &patched_text)?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(&patched_text),
            failures: vec![],
        })
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let source_path = Self::source_path(request.game_dir);
        let source_text = fs::read_to_string(&source_path)?;
        let source: Value = serde_json::from_str(&source_text)?;
        let status = if source["units"].is_array() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("verify", 1),
            status,
            output_hash: content_hash(&source_text),
            failures: vec![],
        })
    }
}

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

impl Xp3ProfileDetectorAdapter {
    fn archive_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(XP3_ARCHIVE_PATH)
    }

    fn inspect(game_dir: &Path) -> Xp3FixtureState {
        let archive_path = Self::archive_path(game_dir);
        let archive_exists = archive_path.is_file();
        let bytes = fs::read(&archive_path).unwrap_or_default();
        let archive_signature = bytes.starts_with(XP3_MAGIC);
        let marker_text = Self::legacy_marker_text(&bytes);
        let variant = if !archive_signature {
            if archive_exists {
                Xp3FixtureVariant::Unknown
            } else {
                Xp3FixtureVariant::NotXp3
            }
        } else if marker_text.contains(&XP3_UNKNOWN_MARKER.to_ascii_lowercase()) {
            Xp3FixtureVariant::Unknown
        } else if marker_text.contains(&XP3_HELPER_REQUIRED_MARKER.to_ascii_lowercase()) {
            Xp3FixtureVariant::HelperRequired
        } else if marker_text.contains(&XP3_ENCRYPTED_MARKER.to_ascii_lowercase())
            || marker_text.contains("kaifuu-xp3-encrypted")
        {
            Xp3FixtureVariant::Encrypted
        } else if marker_text.contains(&XP3_COMPRESSED_MARKER.to_ascii_lowercase())
            || marker_text.contains("kaifuu-xp3-compressed")
        {
            Xp3FixtureVariant::Compressed
        } else {
            Xp3FixtureVariant::Plain
        };
        let archive_hash = archive_exists
            .then(|| sha256_file_ref(&archive_path).ok())
            .flatten();
        Xp3FixtureState {
            archive_path,
            archive_exists,
            archive_signature,
            archive_hash,
            variant,
        }
    }

    fn legacy_marker_text(bytes: &[u8]) -> String {
        if !bytes.starts_with(b"XP3\r\n") || bytes.starts_with(XP3_PLAIN_MAGIC) {
            return String::new();
        }
        String::from_utf8_lossy(&bytes[..bytes.len().min(128)]).to_ascii_lowercase()
    }

    fn detected_variant(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "xp3-plain-container",
            Xp3FixtureVariant::Encrypted => "xp3-encrypted-container",
            Xp3FixtureVariant::HelperRequired => "xp3-helper-required-container",
            Xp3FixtureVariant::Compressed => "xp3-compressed-container",
            Xp3FixtureVariant::Unknown => "xp3-unknown-container",
            Xp3FixtureVariant::NotXp3 => "not-xp3",
        }
    }

    fn profile_id(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "019ed000-0000-7000-8000-000000095001",
            Xp3FixtureVariant::Encrypted => "019ed000-0000-7000-8000-000000095002",
            Xp3FixtureVariant::Compressed => "019ed000-0000-7000-8000-000000095003",
            Xp3FixtureVariant::HelperRequired => "019ed000-0000-7000-8000-000000095004",
            Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => {
                "019ed000-0000-7000-8000-000000095099"
            }
        }
    }

    fn archive_parameter_variant(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "plain",
            Xp3FixtureVariant::Encrypted => "encrypted",
            Xp3FixtureVariant::HelperRequired => "helper_required",
            Xp3FixtureVariant::Compressed => "compressed",
            Xp3FixtureVariant::Unknown => "unknown",
            Xp3FixtureVariant::NotXp3 => "not-xp3",
        }
    }

    fn is_detected(variant: Xp3FixtureVariant) -> bool {
        matches!(
            variant,
            Xp3FixtureVariant::Plain
                | Xp3FixtureVariant::Encrypted
                | Xp3FixtureVariant::HelperRequired
                | Xp3FixtureVariant::Compressed
        )
    }

    fn can_inventory(variant: Xp3FixtureVariant) -> bool {
        matches!(
            variant,
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Compressed
        )
    }

    fn profile_from_state(&self, state: Xp3FixtureState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: Self::profile_id(state.variant).to_string(),
            game_id: format!("{XP3_GAME_ID}-{}", Self::detected_variant(state.variant)),
            title: "KiriKiri XP3 fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "kiri_kiri_xp3".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: state.key_requirements()?,
            archive_parameters: state.archive_parameters(),
            helper_evidence: None,
            assets: state.asset_profiles(),
            layered_access: Some(state.layered_access_profile()),
            capabilities: self.capabilities().reports,
            requirements: state.profile_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }

    fn inventory_from_state(&self, state: Xp3FixtureState) -> KaifuuResult<AssetInventoryManifest> {
        if state.variant == Xp3FixtureVariant::Encrypted {
            return Err(Self::diagnostic_error(Self::crypto_boundary_failure(
                state.variant,
            )));
        }
        if state.variant == Xp3FixtureVariant::HelperRequired {
            return Err(Self::diagnostic_error(Self::helper_required_failure(
                state.variant,
            )));
        }
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let archive_bytes = fs::read(&state.archive_path)?;
        let xp3_inventory =
            read_plain_xp3_inventory(&archive_bytes).map_err(Self::inventory_reader_error)?;
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("xp3-inventory", 95),
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(&xp3_inventory.entries),
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: state.metadata(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, XP3_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("kiri_kiri_xp3")
                .detected_variant(variant)
                .asset_ref(XP3_ARCHIVE_PATH)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn invalid_input_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        match variant {
            Xp3FixtureVariant::Unknown => Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(variant),
                "XP3 bytes or names were present without a profiled synthetic KAIFUU-095 variant",
                "add a profiled synthetic fixture or private-local aggregate evidence before claiming support",
            ),
            Xp3FixtureVariant::NotXp3 => Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(variant),
                "XP3 profile fixtures require a data.xp3 file with a synthetic XP3 header",
                "run detection with a KAIFUU-095 XP3 fixture directory or select another adapter",
            ),
            Xp3FixtureVariant::Plain
            | Xp3FixtureVariant::Encrypted
            | Xp3FixtureVariant::HelperRequired
            | Xp3FixtureVariant::Compressed => Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::ContainerAccess,
                Self::detected_variant(variant),
                XP3_SUPPORT_BOUNDARY,
                "use detect, profile, or asset-inventory output only",
            ),
        }
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn parser_boundary_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::ContainerAccess,
            Self::detected_variant(variant),
            "XP3 index/entry metadata is parsed for inventory, but payload extraction, decompression, and decryption are outside KAIFUU-095 profile fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    fn crypto_boundary_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::MissingCryptoCapability,
            Capability::CryptoAccess,
            Self::detected_variant(variant),
            "encrypted XP3 inventory requires crypto support and resolved key material; no decryption is implemented",
            "add an explicit crypto-capable XP3 adapter before inventory or extraction",
        )
    }

    fn helper_required_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::HelperRequired,
            Capability::KeyProfile,
            Self::detected_variant(variant),
            "this XP3 profile requires an external helper before archive table access",
            "run an approved helper or provide a future helper result before inventory or extraction",
        )
    }

    fn inventory_reader_error(error: PlainXp3InventoryError) -> Box<dyn std::error::Error> {
        let failure = match error {
            PlainXp3InventoryError::UnsupportedEncrypted => {
                Self::crypto_boundary_failure(Xp3FixtureVariant::Encrypted)
            }
            PlainXp3InventoryError::UnsupportedIndexEncoding(_) => Self::unsupported_failure(
                SemanticErrorCode::MissingCodecCapability,
                Capability::CodecAccess,
                Self::detected_variant(Xp3FixtureVariant::Compressed),
                format!("plain XP3 inventory supports only uncompressed index tables: {error}"),
                "use a fixture with an uncompressed XP3 index table or add codec support",
            ),
            PlainXp3InventoryError::MalformedHeader
            | PlainXp3InventoryError::Truncated(_)
            | PlainXp3InventoryError::InvalidOffset(_)
            | PlainXp3InventoryError::InvalidChunk(_)
            | PlainXp3InventoryError::InvalidUtf16Path
            | PlainXp3InventoryError::DuplicateEntry(_) => Self::unsupported_failure(
                SemanticErrorCode::MissingContainerCapability,
                Capability::ContainerAccess,
                Self::detected_variant(Xp3FixtureVariant::Plain),
                format!("plain XP3 inventory could not parse the fixture file table: {error}"),
                "use a well-formed plain XP3 fixture with unique file entries",
            ),
        };
        Self::diagnostic_error(failure)
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: Xp3FixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        let mut failures = vec![Self::parser_boundary_failure(variant)];
        if variant == Xp3FixtureVariant::Encrypted {
            failures.push(Self::crypto_boundary_failure(variant));
        }
        if variant == Xp3FixtureVariant::HelperRequired {
            failures.push(Self::helper_required_failure(variant));
        }
        if variant == Xp3FixtureVariant::Compressed {
            failures.push(Self::unsupported_failure(
                SemanticErrorCode::MissingCodecCapability,
                Capability::CodecAccess,
                detected_variant.clone(),
                "compressed XP3 payload handling is outside KAIFUU-095 profile fixtures",
                "provide future adapter decompression support before extraction or patching",
            ));
        }
        failures.push(Self::unsupported_failure(
            SemanticErrorCode::MissingPatchBackCapability,
            Capability::PatchBack,
            detected_variant,
            "XP3 patch-back/repack support is not implemented by the detector profile",
            "add an explicit patch-back adapter before writing patched XP3 output",
        ));
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("xp3-patch", 95),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(XP3_SUPPORT_BOUNDARY),
            failures,
        }
    }
}

impl Xp3FixtureState {
    fn engine_evidence(&self) -> Vec<String> {
        if self.archive_exists {
            vec![XP3_ARCHIVE_PATH.to_string()]
        } else {
            vec![]
        }
    }

    fn asset_profiles(&self) -> Vec<AssetProfile> {
        if !self.archive_exists {
            return vec![];
        }
        vec![AssetProfile {
            asset_id: "kirikiri-xp3-archive".to_string(),
            path: XP3_ARCHIVE_PATH.to_string(),
            asset_kind: AssetKind::Archive,
            text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
            source_hash: self.archive_hash.clone(),
            patching: CapabilityReport::unsupported(
                Capability::Patching,
                "XP3 detector profile does not decrypt, extract payloads, decompress, repack, or patch archives",
            ),
        }]
    }

    fn inventory_assets(&self, entries: &[PlainXp3Entry]) -> Vec<AssetInventoryAsset> {
        if !self.archive_exists {
            return vec![];
        }
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "signatureMatched".to_string(),
            self.archive_signature.to_string(),
        );
        metadata.insert(
            "detectedVariant".to_string(),
            Xp3ProfileDetectorAdapter::detected_variant(self.variant).to_string(),
        );
        metadata.insert("entryCount".to_string(), entries.len().to_string());
        metadata.insert(
            "profileId".to_string(),
            Xp3ProfileDetectorAdapter::profile_id(self.variant).to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            "plain XP3 index table parsed for inventory only; payload extraction and patch-back are unsupported".to_string(),
        );
        let mut assets = vec![AssetInventoryAsset {
            asset_id: "kirikiri-xp3-archive".to_string(),
            asset_key: XP3_ARCHIVE_PATH.to_string(),
            asset_kind: AssetInventoryAssetKind::Archive,
            path: Some(XP3_ARCHIVE_PATH.to_string()),
            source_hash: self.archive_hash.clone(),
            metadata,
        }];

        assets.extend(entries.iter().enumerate().map(|(index, entry)| {
            let mut metadata = BTreeMap::new();
            metadata.insert("archivePath".to_string(), XP3_ARCHIVE_PATH.to_string());
            metadata.insert("archiveSize".to_string(), entry.archive_size.to_string());
            metadata.insert("compressed".to_string(), entry.compressed.to_string());
            metadata.insert("originalSize".to_string(), entry.original_size.to_string());
            metadata.insert(
                "profileId".to_string(),
                Xp3ProfileDetectorAdapter::profile_id(self.variant).to_string(),
            );
            metadata.insert("segmentCount".to_string(), entry.segment_count.to_string());
            if let Some(stored_adler32) = &entry.stored_adler32 {
                metadata.insert("storedAdler32".to_string(), stored_adler32.clone());
            }
            AssetInventoryAsset {
                asset_id: format!("kirikiri-xp3-entry-{index:04}"),
                asset_key: entry.path.clone(),
                asset_kind: xp3_inventory_asset_kind(&entry.path),
                path: Some(entry.path.clone()),
                source_hash: entry.payload_hash.clone(),
                metadata,
            }
        }));
        assets
    }

    fn archive_parameters(&self) -> Vec<ArchiveParameter> {
        let mut parameters = vec![
            ArchiveParameter {
                parameter_id: "xp3-archive-format".to_string(),
                name: "archiveFormat".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: "xp3".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            },
            ArchiveParameter {
                parameter_id: "xp3-profile-variant".to_string(),
                name: "variant".to_string(),
                kind: ArchiveParameterKind::Variant,
                value: Xp3ProfileDetectorAdapter::archive_parameter_variant(self.variant)
                    .to_string(),
                source: Some(ArchiveParameterSource::Detected),
            },
        ];
        match self.variant {
            Xp3FixtureVariant::Encrypted => parameters.push(ArchiveParameter {
                parameter_id: "xp3-cipher-scheme".to_string(),
                name: "cipherScheme".to_string(),
                kind: ArchiveParameterKind::CipherScheme,
                value: "fixture-key-profile-marker".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::HelperRequired => parameters.push(ArchiveParameter {
                parameter_id: "xp3-helper-requirement".to_string(),
                name: "helperRequirement".to_string(),
                kind: ArchiveParameterKind::Variant,
                value: "fixture-helper-required".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::Compressed => parameters.push(ArchiveParameter {
                parameter_id: "xp3-compression".to_string(),
                name: "compression".to_string(),
                kind: ArchiveParameterKind::Compression,
                value: "compressed".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => {}
        }
        parameters
    }

    fn key_requirements(&self) -> KaifuuResult<Vec<KeyRequirement>> {
        if !matches!(
            self.variant,
            Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
        ) {
            return Ok(vec![]);
        }
        Ok(vec![KeyRequirement {
            requirement_id: "kirikiri-xp3-key-profile".to_string(),
            secret_ref: SecretRef::new(
                "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
            )?,
            kind: KeyMaterialKind::ArchivePassword,
            bytes: None,
            validation: None,
        }])
    }

    fn layered_access_profile(&self) -> LayeredAccessProfile {
        let (crypto, key_material_status, helper_status, key_requirement_refs) = match self.variant
        {
            Xp3FixtureVariant::Encrypted => (
                CryptoTransform::KeyProfile,
                LayeredAccessKeyMaterialStatus::Missing,
                LayeredAccessHelperStatus::Unavailable,
                vec!["kirikiri-xp3-key-profile".to_string()],
            ),
            Xp3FixtureVariant::HelperRequired => (
                CryptoTransform::HelperGated,
                LayeredAccessKeyMaterialStatus::HelperGated,
                LayeredAccessHelperStatus::Unavailable,
                vec!["kirikiri-xp3-key-profile".to_string()],
            ),
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Compressed => (
                CryptoTransform::NullKey,
                LayeredAccessKeyMaterialStatus::NotRequired,
                LayeredAccessHelperStatus::NotRequired,
                vec![],
            ),
            Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => (
                CryptoTransform::Unknown,
                LayeredAccessKeyMaterialStatus::Missing,
                LayeredAccessHelperStatus::Unavailable,
                vec![],
            ),
        };
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces: vec![LayeredTextSurfaceAccess {
                surface_id: "kirikiri-xp3-archive#dialogue".to_string(),
                asset_id: "kirikiri-xp3-archive".to_string(),
                path: XP3_ARCHIVE_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-xp3-archive".to_string(),
                container: ContainerTransform::Xp3,
                crypto,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status,
                helper_status,
                key_requirement_refs,
                notes: vec![
                    "detector-only layered access record; plain inventory may list XP3 entries, but script decoding, extraction, and patch-back are not claimed".to_string(),
                ],
            }],
        };
        profile.normalize();
        profile
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        let mut requirements = vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: XP3_ARCHIVE_PATH.to_string(),
                status: if self.archive_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "synthetic XP3 archive header fixture".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "XP3 archive parser/rebuilder boundary is unsupported for KAIFUU-095"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ];
        if matches!(
            self.variant,
            Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
        ) {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "kirikiri-xp3-key-profile".to_string(),
                status: RequirementStatus::Missing,
                description: if self.variant == Xp3FixtureVariant::HelperRequired {
                    "XP3 helper-required payload is detected, but helper execution is outside the detector profile"
                } else {
                    "encrypted XP3 payload is detected, but key resolution is outside the detector profile"
                }
                .to_string(),
                placeholder: Some("KAIFUU_KIRIKIRI_XP3_KEY_PROFILE".to_string()),
                secret: true,
            });
        }
        if self.variant == Xp3FixtureVariant::Compressed {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-decompressor".to_string(),
                status: RequirementStatus::Unsupported,
                description: "compressed XP3 payload handling is outside the detector profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            });
        }
        if self.variant == Xp3FixtureVariant::Unknown {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::File,
                key: "xp3-synthetic-profile-marker".to_string(),
                status: RequirementStatus::Unsupported,
                description: "XP3 header was present without a profiled synthetic fixture variant"
                    .to_string(),
                placeholder: None,
                secret: false,
            });
        }
        requirements
    }

    fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: XP3_ARCHIVE_PATH.to_string(),
                status: RequirementStatus::Satisfied,
                description: "synthetic XP3 detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "kirikiri-xp3-key-profile".to_string(),
                status: RequirementStatus::NotRequired,
                description: if matches!(
                    self.variant,
                    Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
                ) {
                    "encrypted XP3 profile metadata names the key requirement, but detector-only profiles do not resolve local key material"
                } else {
                    "key material is not required for this synthetic XP3 profile"
                }
                .to_string(),
                placeholder: None,
                secret: true,
            },
        ]
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("fixtureOnly".to_string(), "true".to_string());
        metadata.insert(
            "profileDiagnostics.encryptedPayload".to_string(),
            (self.variant == Xp3FixtureVariant::Encrypted).to_string(),
        );
        if self.variant == Xp3FixtureVariant::HelperRequired {
            metadata.insert(
                "profileDiagnostics.helperRequired".to_string(),
                "true".to_string(),
            );
        }
        metadata.insert(
            "profileDiagnostics.compressedPayload".to_string(),
            (self.variant == Xp3FixtureVariant::Compressed).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unknownVariant".to_string(),
            (self.variant == Xp3FixtureVariant::Unknown).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            XP3_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}

impl EngineAdapter for Xp3ProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        XP3_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu KiriKiri XP3 profile fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Xp3],
            supported_crypto: vec![CryptoTransform::NullKey, CryptoTransform::KeyProfile],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("identify/profile generation reads only synthetic XP3 headers, markers, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Xp3],
            supported_crypto: vec![CryptoTransform::NullKey, CryptoTransform::KeyProfile],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("inventory parses synthetic plain XP3 index metadata and reports archive member rows; payload extraction, decompression, decryption, and patch-back are unsupported".to_string()),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(XP3_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            XP3_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "KAIFUU-095 is an XP3 detector/profile fixture only",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "KAIFUU-095 does not patch or rebuild XP3 archives",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "XP3 container access is limited to synthetic plain-index inventory; extraction and rebuild are outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "encrypted XP3 payload handling is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "compressed XP3 payload handling and script decoding are outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "XP3 patch-back/repack support is outside the detector profile",
                ),
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "encrypted XP3 diagnostics name the key requirement, but no key support is claimed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/KiriKiri work, not this detector fixture",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted payloads are identified only and are never decrypted by this profile",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no XP3 text surfaces are patched by this detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to detector-only XP3 profiles",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for XP3 detector fixtures",
                ),
            ],
            AdapterCapabilityMatrix::new(
                XP3_DETECTOR_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::unsupported(
                    "KAIFUU-095 is an XP3 detector/profile fixture only; payload extraction, decompression, decryption, and patch-back are outside the detector profile",
                ),
                CapabilityLevelStatus::unsupported(
                    "XP3 patch-back/repack support is outside the detector profile (KAIFUU-XP3 patch backlog)",
                ),
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant == Xp3FixtureVariant::Unknown;
        let mut result = DetectionResult {
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "kiri_kiri_xp3".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![DetectionEvidence {
                path: XP3_ARCHIVE_PATH.to_string(),
                kind: "synthetic_xp3_archive_signature".to_string(),
                status: evidence_status(state.archive_exists, state.archive_signature),
                detail: signature_detail(
                    state.archive_exists,
                    state.archive_signature,
                    "XP3 synthetic archive signature",
                ),
            }],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        Ok(AssetList {
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            assets: state.asset_profiles(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.inventory_from_state(Self::inspect(request.game_dir))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        if state.variant == Xp3FixtureVariant::Encrypted {
            return Err(Self::diagnostic_error(Self::crypto_boundary_failure(
                state.variant,
            )));
        }
        if state.variant == Xp3FixtureVariant::HelperRequired {
            return Err(Self::diagnostic_error(Self::helper_required_failure(
                state.variant,
            )));
        }
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            state.variant,
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("xp3-verify", 95),
            status: OperationStatus::Failed,
            output_hash: content_hash(XP3_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                "runtime/parser verification is outside the XP3 detector profile",
                "use detect, profile, or asset-inventory only",
            )],
        })
    }
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

impl SiglusProfileDetectorAdapter {
    fn scene_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(SIGLUS_SCENE_PATH)
    }

    fn gameexe_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(SIGLUS_GAMEEXE_PATH)
    }

    fn inspect(game_dir: &Path) -> SiglusFixtureState {
        let scene_path = Self::scene_path(game_dir);
        let gameexe_path = Self::gameexe_path(game_dir);
        let scene_exists = scene_path.is_file();
        let gameexe_exists = gameexe_path.is_file();
        let scene_synthetic = file_starts_with(&scene_path, SIGLUS_SCENE_MAGIC);
        let gameexe_synthetic = file_starts_with(&gameexe_path, SIGLUS_GAMEEXE_MAGIC);
        // Only probe the real archive-header signature when the synthetic magic
        // did not already match, so a synthetic fixture is never re-classified.
        let scene_real = !scene_synthetic && siglus_scene_pck_real_signature_ok(&scene_path);
        let gameexe_real =
            !gameexe_synthetic && siglus_gameexe_dat_real_signature_ok(&gameexe_path);
        let scene_signature = scene_synthetic || scene_real;
        let gameexe_signature = gameexe_synthetic || gameexe_real;
        let any_real = scene_real || gameexe_real;
        let variant = match (
            scene_signature,
            gameexe_signature,
            scene_exists,
            gameexe_exists,
        ) {
            (true, true, _, _) if any_real => SiglusFixtureVariant::CompleteRealPair,
            (true, true, _, _) => SiglusFixtureVariant::CompleteSyntheticPair,
            (true, false, _, _) => SiglusFixtureVariant::MissingGameexeDat,
            (false, true, _, _) => SiglusFixtureVariant::MissingScenePck,
            (false, false, true, _) | (false, false, _, true) => {
                SiglusFixtureVariant::UnknownNamedPair
            }
            _ => SiglusFixtureVariant::NotSiglus,
        };
        SiglusFixtureState {
            scene_exists,
            gameexe_exists,
            scene_signature,
            gameexe_signature,
            scene_real,
            gameexe_real,
            scene_hash: scene_exists
                .then(|| sha256_file_ref(&scene_path).ok())
                .flatten(),
            gameexe_hash: gameexe_exists
                .then(|| sha256_file_ref(&gameexe_path).ok())
                .flatten(),
            variant,
        }
    }

    fn detected_variant(variant: SiglusFixtureVariant) -> &'static str {
        match variant {
            SiglusFixtureVariant::CompleteSyntheticPair => "scene-pck-gameexe-dat-synthetic",
            SiglusFixtureVariant::CompleteRealPair => "scene-pck-gameexe-dat-real",
            SiglusFixtureVariant::MissingGameexeDat => "scene-pck-missing-gameexe-dat",
            SiglusFixtureVariant::MissingScenePck => "gameexe-dat-missing-scene-pck",
            SiglusFixtureVariant::UnknownNamedPair => "unknown-siglus-named-files",
            SiglusFixtureVariant::NotSiglus => "not-siglus",
        }
    }

    fn is_detected(variant: SiglusFixtureVariant) -> bool {
        matches!(
            variant,
            SiglusFixtureVariant::CompleteSyntheticPair | SiglusFixtureVariant::CompleteRealPair
        )
    }

    fn can_inventory(variant: SiglusFixtureVariant) -> bool {
        Self::is_detected(variant)
    }

    fn profile_from_state(&self, state: SiglusFixtureState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let is_real = matches!(state.variant, SiglusFixtureVariant::CompleteRealPair);
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: SIGLUS_PROFILE_ID.to_string(),
            game_id: if is_real {
                SIGLUS_REAL_GAME_ID.to_string()
            } else {
                SIGLUS_GAME_ID.to_string()
            },
            title: if is_real {
                "Siglus title (detector profile)".to_string()
            } else {
                "Siglus fixture".to_string()
            },
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "siglus".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: SIGLUS_SCENE_PATH.to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: state.asset_profiles(),
            layered_access: Some(state.layered_access_profile()),
            capabilities: self.capabilities().reports,
            requirements: state.profile_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }

    fn inventory_from_state(
        &self,
        state: SiglusFixtureState,
    ) -> KaifuuResult<AssetInventoryManifest> {
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("siglus-inventory", 91),
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(),
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: state.metadata(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, SIGLUS_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("siglus")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::CodecAccess,
            variant,
            SIGLUS_SCENE_PATH,
            "Siglus Scene.pck parsing/decompilation is outside KAIFUU-091 detector fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    fn invalid_input_failure(variant: SiglusFixtureVariant) -> AdapterFailure {
        let (code, required_capability, asset_ref, support_boundary, remediation) = match variant {
            SiglusFixtureVariant::MissingGameexeDat => (
                SemanticErrorCode::MissingContainerCapability,
                Capability::AssetListing,
                SIGLUS_GAMEEXE_PATH,
                "Siglus detector profile requires both synthetic Scene.pck and Gameexe.dat signatures before profiling or inventory",
                "provide the complete synthetic Scene.pck/Gameexe.dat signature pair or treat this input as a diagnostic-only partial fixture",
            ),
            SiglusFixtureVariant::MissingScenePck => (
                SemanticErrorCode::MissingContainerCapability,
                Capability::AssetListing,
                SIGLUS_SCENE_PATH,
                "Siglus detector profile requires both synthetic Scene.pck and Gameexe.dat signatures before profiling or inventory",
                "provide the complete synthetic Scene.pck/Gameexe.dat signature pair or treat this input as a diagnostic-only partial fixture",
            ),
            SiglusFixtureVariant::UnknownNamedPair => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                "Scene.pck/Gameexe.dat",
                "Scene.pck/Gameexe.dat names were present without recognized synthetic KAIFUU-091 Siglus signatures",
                "use the complete synthetic signature pair fixture or add an explicit adapter for this Siglus variant before profiling or inventory",
            ),
            SiglusFixtureVariant::NotSiglus => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                "Scene.pck/Gameexe.dat",
                "Siglus detector profile requires recognized synthetic Scene.pck/Gameexe.dat fixture evidence",
                "run detection with a complete synthetic Siglus fixture or select another adapter",
            ),
            SiglusFixtureVariant::CompleteSyntheticPair
            | SiglusFixtureVariant::CompleteRealPair => (
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::CodecAccess,
                SIGLUS_SCENE_PATH,
                SIGLUS_SUPPORT_BOUNDARY,
                "use identify or asset-inventory output only",
            ),
        };
        Self::unsupported_failure(
            code,
            required_capability,
            Self::detected_variant(variant),
            asset_ref,
            support_boundary,
            remediation,
        )
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: SiglusFixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("siglus-patch", 91),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(SIGLUS_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::MissingContainerCapability,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    SIGLUS_SCENE_PATH,
                    "Siglus Scene.pck archive container access is not implemented by the detector profile",
                    "use identify or asset-inventory output only",
                ),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingCryptoCapability,
                    Capability::CryptoAccess,
                    detected_variant.clone(),
                    SIGLUS_SCENE_PATH,
                    "Siglus encrypted payload handling is not implemented by the detector profile",
                    "provide future adapter crypto support before extraction or patching",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    SIGLUS_SCENE_PATH,
                    "Siglus patch-back/repack support is not implemented by the detector profile",
                    "add an explicit patch-back adapter before writing patched Scene.pck output",
                ),
            ],
        }
    }
}

impl SiglusFixtureState {
    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.scene_exists {
            evidence.push(SIGLUS_SCENE_PATH.to_string());
        }
        if self.gameexe_exists {
            evidence.push(SIGLUS_GAMEEXE_PATH.to_string());
        }
        evidence
    }

    fn asset_profiles(&self) -> Vec<AssetProfile> {
        let mut assets = Vec::new();
        if self.scene_exists {
            assets.push(AssetProfile {
                asset_id: "siglus-scene-pck".to_string(),
                path: SIGLUS_SCENE_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
                source_hash: self.scene_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "Siglus detector profile does not parse, decrypt, repack, or patch Scene.pck",
                ),
            });
        }
        if self.gameexe_exists {
            assets.push(AssetProfile {
                asset_id: "siglus-gameexe-dat".to_string(),
                path: SIGLUS_GAMEEXE_PATH.to_string(),
                asset_kind: AssetKind::Metadata,
                text_surfaces: vec![TextSurface::MetadataText],
                source_hash: self.gameexe_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "Siglus detector profile does not patch Gameexe.dat metadata",
                ),
            });
        }
        assets
    }

    fn inventory_assets(&self) -> Vec<AssetInventoryAsset> {
        let mut assets = Vec::new();
        if self.scene_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "signatureMatched".to_string(),
                self.scene_signature.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; archive entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "siglus-scene-pck".to_string(),
                asset_key: SIGLUS_SCENE_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(SIGLUS_SCENE_PATH.to_string()),
                source_hash: self.scene_hash.clone(),
                metadata,
            });
        }
        if self.gameexe_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "signatureMatched".to_string(),
                self.gameexe_signature.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "metadata identified only; secondary-key discovery is not implemented".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "siglus-gameexe-dat".to_string(),
                asset_key: SIGLUS_GAMEEXE_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Metadata,
                path: Some(SIGLUS_GAMEEXE_PATH.to_string()),
                source_hash: self.gameexe_hash.clone(),
                metadata,
            });
        }
        assets
    }

    fn layered_access_profile(&self) -> LayeredAccessProfile {
        let mut surfaces = Vec::new();
        if self.scene_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "siglus-scene-pck#dialogue".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                path: SIGLUS_SCENE_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-scene-package".to_string(),
                container: ContainerTransform::SiglusPck,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only layered access record; no parser, normalized script text, or archive entry listing is claimed".to_string(),
                ],
            });
        }
        if self.gameexe_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "siglus-gameexe-dat#metadata".to_string(),
                asset_id: "siglus-gameexe-dat".to_string(),
                path: SIGLUS_GAMEEXE_PATH.to_string(),
                text_surface: TextSurface::MetadataText,
                surface_transform: SurfaceTransform::BinaryOffset,
                surface_selector: "aggregate-only:synthetic-gameexe-metadata".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only metadata record; secondary-key derivation is outside this profile".to_string(),
                ],
            });
        }
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces,
        };
        profile.normalize();
        profile
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        let mut requirements = vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_SCENE_PATH.to_string(),
                status: if self.scene_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: if self.scene_real {
                    "real Siglus Scene.pck archive-header signature".to_string()
                } else {
                    "synthetic Siglus Scene.pck signature fixture".to_string()
                },
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_GAMEEXE_PATH.to_string(),
                status: if self.gameexe_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: if self.gameexe_real {
                    "real Siglus Gameexe.dat archive-header signature".to_string()
                } else {
                    "synthetic Siglus Gameexe.dat signature fixture".to_string()
                },
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "siglus-secondary-key".to_string(),
                status: RequirementStatus::Missing,
                description: "encrypted Siglus payload is detected, but key resolution is outside the detector profile".to_string(),
                placeholder: Some("KAIFUU_SIGLUS_SECONDARY_KEY_PROFILE".to_string()),
                secret: true,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "siglus-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene.pck parser/decompiler boundary is unsupported for KAIFUU-091".to_string(),
                placeholder: None,
                secret: false,
            },
        ];
        if self.variant == SiglusFixtureVariant::UnknownNamedPair {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::File,
                key: "siglus-synthetic-signature".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene.pck/Gameexe.dat names were present without recognized synthetic fixture signatures".to_string(),
                placeholder: None,
                secret: false,
            });
        }
        requirements
    }

    fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_SCENE_PATH.to_string(),
                status: if self.scene_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "synthetic Siglus Scene.pck detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_GAMEEXE_PATH.to_string(),
                status: if self.gameexe_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "synthetic Siglus Gameexe.dat detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "siglus-secondary-key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "key material is not accepted by the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: true,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "siglus-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        // Real archive-header signatures are not fixtures; report honestly so
        // downstream consumers do not treat a real Siglus title as synthetic.
        // Synthetic fixtures keep `fixtureOnly=true` (byte-identical output);
        // a real pair reports `false`.
        let real_pair = matches!(self.variant, SiglusFixtureVariant::CompleteRealPair);
        metadata.insert("fixtureOnly".to_string(), (!real_pair).to_string());
        metadata.insert(
            "profileDiagnostics.missingPair".to_string(),
            (!self.scene_signature || !self.gameexe_signature).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unknownVariant".to_string(),
            (self.variant == SiglusFixtureVariant::UnknownNamedPair).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.encryptedPayload".to_string(),
            self.scene_signature.to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            SIGLUS_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}

impl EngineAdapter for SiglusProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        SIGLUS_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu Siglus detector profile fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::SiglusPck],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("identify/profile generation reads only synthetic file names, signatures, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::Identity, SurfaceTransform::ArchiveEntry, SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::SiglusPck],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("inventory reports only top-level Scene.pck/Gameexe.dat assets and hashes; no archive entry parser is claimed".to_string()),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(SIGLUS_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            SIGLUS_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "KAIFUU-091 is a Siglus detector/profile fixture only",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "KAIFUU-091 does not patch or rebuild Siglus assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "Scene.pck archive parsing is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "encrypted Siglus payload handling is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "Siglus script decode/decompile support is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "Siglus patch-back/repack support is outside the detector profile",
                ),
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "encrypted payload diagnostics name the key requirement, but no key support is claimed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/Siglus work, not this detector fixture",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted payloads are identified only and are never decrypted by this profile",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no Siglus text surfaces are patched by this detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to detector-only Siglus profiles",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for Siglus detector fixtures",
                ),
            ],
            AdapterCapabilityMatrix::identify_only(
                SIGLUS_DETECTOR_ADAPTER_ID,
                "Siglus detector profile is identify-only; Scene.pck/Gameexe.dat archive parsing, extraction, decryption, and patch-back are unsupported (KAIFUU-091)",
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant != SiglusFixtureVariant::NotSiglus;
        let mut result = DetectionResult {
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "siglus".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: SIGLUS_SCENE_PATH.to_string(),
                    kind: if state.scene_real {
                        "real_siglus_scene_pck_signature".to_string()
                    } else {
                        "synthetic_siglus_scene_pck_signature".to_string()
                    },
                    status: evidence_status(state.scene_exists, state.scene_signature),
                    detail: signature_detail(
                        state.scene_exists,
                        state.scene_signature,
                        if state.scene_real {
                            "Scene.pck real archive-header signature"
                        } else {
                            "Scene.pck synthetic signature"
                        },
                    ),
                },
                DetectionEvidence {
                    path: SIGLUS_GAMEEXE_PATH.to_string(),
                    kind: if state.gameexe_real {
                        "real_siglus_gameexe_dat_signature".to_string()
                    } else {
                        "synthetic_siglus_gameexe_dat_signature".to_string()
                    },
                    status: evidence_status(state.gameexe_exists, state.gameexe_signature),
                    detail: signature_detail(
                        state.gameexe_exists,
                        state.gameexe_signature,
                        if state.gameexe_real {
                            "Gameexe.dat real archive-header signature"
                        } else {
                            "Gameexe.dat synthetic signature"
                        },
                    ),
                },
            ],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        Ok(AssetList {
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            assets: state.asset_profiles(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.inventory_from_state(Self::inspect(request.game_dir))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        let variant = Self::detected_variant(state.variant);
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            variant,
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        let variant = Self::detected_variant(state.variant).to_string();
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("siglus-verify", 91),
            status: OperationStatus::Failed,
            output_hash: content_hash(SIGLUS_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                variant,
                SIGLUS_SCENE_PATH,
                "runtime/parser verification is outside the Siglus detector profile",
                "use detect, profile, or asset-inventory only",
            )],
        })
    }
}

// =====================================================================
// RealLive detector (KAIFUU-172).
//
// FSM lives in `RealLiveProfileDetectorAdapter::resolve_variant`. The
// algorithm is a small deterministic state machine over presence/absence
// and signature-validity counts: no confidence floats, no thresholds beyond
// what the plan specifies. See KAIFUU-172 §3 for the decision table.
// =====================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealLiveFixtureVariant {
    CompleteSyntheticTriple,
    PositiveLiveLayout,
    AmbiguousSiglusOverlap,
    UnsupportedAvg32Lineage,
    UnknownEngineVariant,
    NotRealLive,
}

#[derive(Debug, Default, Clone, Copy)]
struct GameexeIniKeyHits {
    gameexe_version: bool,
    regname: bool,
    g00_key: bool,
    koe_key: bool,
    seen_key: bool,
}

impl GameexeIniKeyHits {
    fn any(self) -> bool {
        self.gameexe_version || self.regname || self.g00_key || self.koe_key || self.seen_key
    }
}

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
    // KAIFUU-189: when the depth-N walk locates a nested REALLIVEDATA/
    // subdirectory, the relative path is recorded here so the detector
    // can surface it as evidence (`kaifuu.reallive.nested_data_dir_resolved`). `None`
    // means the SEEN.TXT/Gameexe.ini lookups fell back to the game root
    // (synthetic fixtures or `kaifuu detect` invoked directly against a
    // REALLIVEDATA-named directory).
    resolved_reallive_data_dir: Option<std::path::PathBuf>,
}

impl RealLiveProfileDetectorAdapter {
    // KAIFUU-189: depth-N descent that locates the REALLIVEDATA/ engine
    // asset root inside an arbitrary game directory tree. Sweetie HD
    // ships its REALLIVEDATA at
    // `<game_root>/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/`
    // (depth 2 from the install root); pointing `kaifuu detect` at the
    // install root must walk the title subdir before reporting any
    // RealLive marker missing. See `docs/audits/real-bytes-validation-2026-06-24.md`
    // §2.1 and `kaifuu_reallive::detector` for the depth bound rationale.
    //
    // I/O errors are swallowed into `None` here because this helper feeds
    // a detector that already tolerates "directory unreadable" elsewhere
    // (e.g. extract / profile flows). The kaifuu-reallive detector
    // surfaces three-state outcomes for callers that care about the
    // difference (see `kaifuu_reallive::RealLiveDetectError`).
    fn resolve_reallive_data_dir(game_dir: &Path) -> Option<std::path::PathBuf> {
        kaifuu_reallive::detect_reallive_data_dir(game_dir)
            .ok()
            .flatten()
            .map(|evidence| evidence.reallive_data_path)
    }

    // Returns the effective data-root for SEEN.TXT/Gameexe.ini/extension
    // lookups: the resolved REALLIVEDATA subdir when found, else
    // `game_dir` itself. Keeps synthetic fixtures (which ship SEEN.TXT
    // at the game root) working without a REALLIVEDATA marker.
    fn effective_data_dir<'a>(game_dir: &'a Path, resolved: Option<&'a Path>) -> &'a Path {
        resolved.unwrap_or(game_dir)
    }

    fn seen_txt_path(game_dir: &Path) -> std::path::PathBuf {
        let resolved = Self::resolve_reallive_data_dir(game_dir);
        Self::seen_txt_path_with_resolved(game_dir, resolved.as_deref())
    }

    fn seen_txt_path_with_resolved(game_dir: &Path, resolved: Option<&Path>) -> std::path::PathBuf {
        let effective = Self::effective_data_dir(game_dir, resolved);
        case_insensitive_find(effective, REALLIVE_SEEN_TXT_PATH)
            .unwrap_or_else(|| effective.join(REALLIVE_SEEN_TXT_PATH))
    }

    fn seen_gan_path_with_resolved(game_dir: &Path, resolved: Option<&Path>) -> std::path::PathBuf {
        let effective = Self::effective_data_dir(game_dir, resolved);
        case_insensitive_find(effective, REALLIVE_SEEN_GAN_PATH)
            .unwrap_or_else(|| effective.join(REALLIVE_SEEN_GAN_PATH))
    }

    fn gameexe_ini_path_with_resolved(
        game_dir: &Path,
        resolved: Option<&Path>,
    ) -> std::path::PathBuf {
        let effective = Self::effective_data_dir(game_dir, resolved);
        case_insensitive_find(effective, REALLIVE_GAMEEXE_INI_PATH)
            .unwrap_or_else(|| effective.join(REALLIVE_GAMEEXE_INI_PATH))
    }

    fn inspect(game_dir: &Path) -> RealLiveFixtureState {
        let resolved_reallive_data_dir = Self::resolve_reallive_data_dir(game_dir);
        let seen_txt_path =
            Self::seen_txt_path_with_resolved(game_dir, resolved_reallive_data_dir.as_deref());
        let seen_gan_path =
            Self::seen_gan_path_with_resolved(game_dir, resolved_reallive_data_dir.as_deref());
        let gameexe_ini_path =
            Self::gameexe_ini_path_with_resolved(game_dir, resolved_reallive_data_dir.as_deref());
        let seen_txt_exists = seen_txt_path.is_file();
        let seen_gan_exists = seen_gan_path.is_file();
        let gameexe_ini_exists = gameexe_ini_path.is_file();
        let seen_txt_synthetic_magic = file_starts_with(&seen_txt_path, REALLIVE_SEEN_TXT_MAGIC);
        let seen_gan_synthetic_magic = file_starts_with(&seen_gan_path, REALLIVE_SEEN_GAN_MAGIC);
        let gameexe_ini_synthetic_magic =
            file_starts_with(&gameexe_ini_path, REALLIVE_GAMEEXE_INI_MAGIC);
        let seen_txt_envelope_ok =
            seen_txt_synthetic_magic || reallive_seen_txt_envelope_ok(&seen_txt_path);
        let gameexe_ini_keys = if gameexe_ini_exists {
            reallive_gameexe_ini_key_hits(&gameexe_ini_path)
        } else {
            GameexeIniKeyHits::default()
        };
        let effective_extension_dir =
            Self::effective_data_dir(game_dir, resolved_reallive_data_dir.as_deref());
        let (g00_count, voice_archive_count, avg32_pdt_count) =
            reallive_extension_counts(effective_extension_dir);
        // Siglus cross-check stays anchored to the game root: Siglus
        // markers (`Scene.pck`, `Gameexe.dat`) never live inside a
        // RealLive `REALLIVEDATA/` subtree.
        let siglus_scene_pck_present = case_insensitive_find(game_dir, "Scene.pck").is_some();
        let siglus_gameexe_dat_present = case_insensitive_find(game_dir, "Gameexe.dat").is_some();
        let variant = Self::resolve_variant(
            seen_txt_exists,
            seen_txt_envelope_ok,
            seen_txt_synthetic_magic,
            seen_gan_exists,
            gameexe_ini_exists,
            gameexe_ini_synthetic_magic,
            gameexe_ini_keys,
            g00_count,
            voice_archive_count,
            siglus_scene_pck_present,
            siglus_gameexe_dat_present,
            avg32_pdt_count,
        );
        let resolved_relative = resolved_reallive_data_dir.as_deref().map(|resolved| {
            resolved
                .strip_prefix(game_dir)
                .map_or_else(|_| resolved.to_path_buf(), std::path::Path::to_path_buf)
        });
        RealLiveFixtureState {
            seen_txt_exists,
            seen_txt_envelope_ok,
            seen_txt_synthetic_magic,
            seen_gan_exists,
            seen_gan_synthetic_magic,
            gameexe_ini_exists,
            gameexe_ini_synthetic_magic,
            gameexe_ini_keys,
            g00_count,
            voice_archive_count,
            siglus_scene_pck_present,
            siglus_gameexe_dat_present,
            avg32_pdt_count,
            seen_txt_hash: seen_txt_exists
                .then(|| sha256_file_ref(&seen_txt_path).ok())
                .flatten(),
            seen_gan_hash: seen_gan_exists
                .then(|| sha256_file_ref(&seen_gan_path).ok())
                .flatten(),
            gameexe_ini_hash: gameexe_ini_exists
                .then(|| sha256_file_ref(&gameexe_ini_path).ok())
                .flatten(),
            variant,
            resolved_reallive_data_dir: resolved_relative,
        }
    }

    // reason: cohesive variant resolver over distinct fixture selectors; splitting into a struct would just move the fields.
    #[allow(clippy::too_many_arguments)]
    fn resolve_variant(
        seen_txt_exists: bool,
        seen_txt_envelope_ok: bool,
        seen_txt_synthetic_magic: bool,
        seen_gan_exists: bool,
        gameexe_ini_exists: bool,
        gameexe_ini_synthetic_magic: bool,
        gameexe_ini_keys: GameexeIniKeyHits,
        g00_count: u64,
        voice_archive_count: u64,
        siglus_scene_pck_present: bool,
        siglus_gameexe_dat_present: bool,
        avg32_pdt_count: u64,
    ) -> RealLiveFixtureVariant {
        let any_reallive_marker = seen_txt_exists
            || seen_gan_exists
            || gameexe_ini_exists
            || g00_count > 0
            || voice_archive_count > 0;
        if !any_reallive_marker {
            return RealLiveFixtureVariant::NotRealLive;
        }
        let siglus_overlap = siglus_scene_pck_present || siglus_gameexe_dat_present;
        if siglus_overlap {
            return RealLiveFixtureVariant::AmbiguousSiglusOverlap;
        }
        // Public-CI synthetic short-circuit: both magic bytes present.
        if seen_txt_synthetic_magic && gameexe_ini_synthetic_magic {
            return RealLiveFixtureVariant::CompleteSyntheticTriple;
        }
        // AVG32 lineage: SEEN.TXT envelope present, .PDT present, no
        // RealLive-specific Gameexe.ini keys.
        if seen_txt_exists && seen_txt_envelope_ok && avg32_pdt_count > 0 && !gameexe_ini_keys.any()
        {
            return RealLiveFixtureVariant::UnsupportedAvg32Lineage;
        }
        // Positive live layout: SEEN.TXT envelope OK + Gameexe.ini with
        // RealLive-specific key + no Siglus markers and no AVG32 PDT.
        if seen_txt_exists
            && seen_txt_envelope_ok
            && gameexe_ini_exists
            && gameexe_ini_keys.any()
            && avg32_pdt_count == 0
        {
            return RealLiveFixtureVariant::PositiveLiveLayout;
        }
        // Otherwise: a name-shaped RealLive layout (SEEN.TXT, Gameexe.ini,
        // SEEN.GAN, or .g00/.ovk/.koe/.nwk present) without sufficient
        // evidence to identify positively. Mark unknown so the operator
        // sees the diagnostic loudly instead of silently passing.
        let _ = seen_gan_exists; // already accounted for in any_reallive_marker
        RealLiveFixtureVariant::UnknownEngineVariant
    }

    fn detected_variant(variant: RealLiveFixtureVariant) -> &'static str {
        match variant {
            RealLiveFixtureVariant::CompleteSyntheticTriple => "reallive-synthetic-triple",
            RealLiveFixtureVariant::PositiveLiveLayout => "reallive-positive-live-layout",
            RealLiveFixtureVariant::AmbiguousSiglusOverlap => "ambiguous-reallive-siglus-overlap",
            RealLiveFixtureVariant::UnsupportedAvg32Lineage => "avg32-lineage-seen-txt",
            RealLiveFixtureVariant::UnknownEngineVariant => "unknown-reallive-named-files",
            RealLiveFixtureVariant::NotRealLive => "not-reallive",
        }
    }

    fn is_detected(variant: RealLiveFixtureVariant) -> bool {
        matches!(
            variant,
            RealLiveFixtureVariant::CompleteSyntheticTriple
                | RealLiveFixtureVariant::PositiveLiveLayout
        )
    }

    fn can_inventory(variant: RealLiveFixtureVariant) -> bool {
        Self::is_detected(variant)
    }

    fn profile_from_state(&self, state: RealLiveFixtureState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: REALLIVE_PROFILE_ID.to_string(),
            game_id: REALLIVE_GAME_ID.to_string(),
            title: "RealLive fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "reallive".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: REALLIVE_SEEN_TXT_PATH.to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: state.asset_profiles(),
            layered_access: Some(state.layered_access_profile()),
            capabilities: self.capabilities().reports,
            requirements: state.profile_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }

    fn inventory_from_state(
        &self,
        state: RealLiveFixtureState,
    ) -> KaifuuResult<AssetInventoryManifest> {
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("reallive-inventory", 172),
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(),
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: state.metadata(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, REALLIVE_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("reallive")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::CodecAccess,
            variant,
            REALLIVE_SEEN_TXT_PATH,
            "RealLive SEEN.TXT/Scene parsing/decompilation is outside KAIFUU-172 detector fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    fn invalid_input_failure(variant: RealLiveFixtureVariant) -> AdapterFailure {
        let (code, required_capability, asset_ref, support_boundary, remediation) = match variant {
            RealLiveFixtureVariant::AmbiguousSiglusOverlap => (
                SemanticErrorCode::AmbiguousEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive detector requires unambiguous RealLive evidence; co-presence of Siglus markers (Scene.pck/Gameexe.dat) blocks identification.",
                "audit the input directory; remove or relocate cross-engine markers, or report the layout as a new engine variant",
            ),
            RealLiveFixtureVariant::UnsupportedAvg32Lineage => (
                SemanticErrorCode::UnsupportedEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive detector does not claim AVG32 lineage support; AVG32-shaped SEEN.TXT inputs are out of scope.",
                "add an AVG32-specific detector (separate node) before localizing this title",
            ),
            RealLiveFixtureVariant::UnknownEngineVariant => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive marker names were present without recognized RealLive SEEN.TXT envelope and Gameexe.ini key evidence",
                "provide a complete synthetic RealLive fixture or add an explicit adapter for this RealLive variant before profiling or inventory",
            ),
            RealLiveFixtureVariant::NotRealLive => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive detector profile requires recognized SEEN.TXT/Gameexe.ini fixture evidence",
                "run detection with a complete synthetic RealLive fixture or select another adapter",
            ),
            RealLiveFixtureVariant::CompleteSyntheticTriple
            | RealLiveFixtureVariant::PositiveLiveLayout => (
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::CodecAccess,
                REALLIVE_SEEN_TXT_PATH,
                REALLIVE_SUPPORT_BOUNDARY,
                "use identify or asset-inventory output only",
            ),
        };
        Self::unsupported_failure(
            code,
            required_capability,
            Self::detected_variant(variant),
            asset_ref,
            support_boundary,
            remediation,
        )
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: RealLiveFixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-patch", 172),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(REALLIVE_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::MissingContainerCapability,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    REALLIVE_SEEN_TXT_PATH,
                    "RealLive SEEN.TXT archive container access is not implemented by the detector profile",
                    "use identify or asset-inventory output only",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    REALLIVE_SEEN_TXT_PATH,
                    "RealLive patch-back/repack support is not implemented by the detector profile",
                    "add an explicit patch-back adapter before writing patched SEEN.TXT output",
                ),
            ],
        }
    }
}

impl RealLiveFixtureState {
    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.seen_txt_exists {
            evidence.push(REALLIVE_SEEN_TXT_PATH.to_string());
        }
        if self.seen_gan_exists {
            evidence.push(REALLIVE_SEEN_GAN_PATH.to_string());
        }
        if self.gameexe_ini_exists {
            evidence.push(REALLIVE_GAMEEXE_INI_PATH.to_string());
        }
        evidence
    }

    fn asset_profiles(&self) -> Vec<AssetProfile> {
        let mut assets = Vec::new();
        if self.seen_txt_exists {
            assets.push(AssetProfile {
                asset_id: "reallive-seen-txt".to_string(),
                path: REALLIVE_SEEN_TXT_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
                source_hash: self.seen_txt_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "RealLive detector profile does not parse, repack, or patch SEEN.TXT",
                ),
            });
        }
        if self.seen_gan_exists {
            assets.push(AssetProfile {
                asset_id: "reallive-seen-gan".to_string(),
                path: REALLIVE_SEEN_GAN_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![],
                source_hash: self.seen_gan_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "RealLive detector profile does not parse or patch SEEN.GAN",
                ),
            });
        }
        if self.gameexe_ini_exists {
            assets.push(AssetProfile {
                asset_id: "reallive-gameexe-ini".to_string(),
                path: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                asset_kind: AssetKind::Metadata,
                text_surfaces: vec![TextSurface::MetadataText],
                source_hash: self.gameexe_ini_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "RealLive detector profile does not patch Gameexe.ini metadata",
                ),
            });
        }
        assets
    }

    fn inventory_assets(&self) -> Vec<AssetInventoryAsset> {
        let mut assets = Vec::new();
        if self.seen_txt_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "syntheticMagicMatched".to_string(),
                self.seen_txt_synthetic_magic.to_string(),
            );
            metadata.insert(
                "envelopeValid".to_string(),
                self.seen_txt_envelope_ok.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; archive entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "reallive-seen-txt".to_string(),
                asset_key: REALLIVE_SEEN_TXT_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(REALLIVE_SEEN_TXT_PATH.to_string()),
                source_hash: self.seen_txt_hash.clone(),
                metadata,
            });
        }
        if self.seen_gan_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "syntheticMagicMatched".to_string(),
                self.seen_gan_synthetic_magic.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; animation entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "reallive-seen-gan".to_string(),
                asset_key: REALLIVE_SEEN_GAN_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(REALLIVE_SEEN_GAN_PATH.to_string()),
                source_hash: self.seen_gan_hash.clone(),
                metadata,
            });
        }
        if self.gameexe_ini_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "syntheticMagicMatched".to_string(),
                self.gameexe_ini_synthetic_magic.to_string(),
            );
            metadata.insert(
                "gameexeVersionKeyPresent".to_string(),
                self.gameexe_ini_keys.gameexe_version.to_string(),
            );
            metadata.insert(
                "regnameKeyPresent".to_string(),
                self.gameexe_ini_keys.regname.to_string(),
            );
            metadata.insert(
                "g00KeyPresent".to_string(),
                self.gameexe_ini_keys.g00_key.to_string(),
            );
            metadata.insert(
                "koeKeyPresent".to_string(),
                self.gameexe_ini_keys.koe_key.to_string(),
            );
            metadata.insert(
                "seenKeyPresent".to_string(),
                self.gameexe_ini_keys.seen_key.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "metadata identified only; full Gameexe.ini parsing is not implemented".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "reallive-gameexe-ini".to_string(),
                asset_key: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Metadata,
                path: Some(REALLIVE_GAMEEXE_INI_PATH.to_string()),
                source_hash: self.gameexe_ini_hash.clone(),
                metadata,
            });
        }
        assets
    }

    fn layered_access_profile(&self) -> LayeredAccessProfile {
        let mut surfaces = Vec::new();
        if self.seen_txt_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "reallive-seen-txt#dialogue".to_string(),
                asset_id: "reallive-seen-txt".to_string(),
                path: REALLIVE_SEEN_TXT_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-seen-archive".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only layered access record; no Scene/SEEN parser, normalized script text, or archive entry listing is claimed".to_string(),
                ],
            });
        }
        if self.gameexe_ini_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "reallive-gameexe-ini#metadata".to_string(),
                asset_id: "reallive-gameexe-ini".to_string(),
                path: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                text_surface: TextSurface::MetadataText,
                surface_transform: SurfaceTransform::Identity,
                surface_selector: "aggregate-only:synthetic-gameexe-ini-metadata".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only metadata record; full Gameexe.ini parsing is outside this profile".to_string(),
                ],
            });
        }
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces,
        };
        profile.normalize();
        profile
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_SEEN_TXT_PATH.to_string(),
                status: if self.seen_txt_envelope_ok {
                    RequirementStatus::Satisfied
                } else if self.seen_txt_exists {
                    RequirementStatus::Unsupported
                } else {
                    RequirementStatus::Missing
                },
                description: "RealLive SEEN.TXT envelope (synthetic magic or generic shape)".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                status: if self.gameexe_ini_keys.any() {
                    RequirementStatus::Satisfied
                } else if self.gameexe_ini_exists {
                    RequirementStatus::Unsupported
                } else {
                    RequirementStatus::Missing
                },
                description: "RealLive Gameexe.ini with at least one RealLive-specific key (#GAMEEXE_VERSION, #REGNAME, #G00*, #KOE*, #SEEN*)".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "reallive-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene/SEEN parser/decompiler boundary is unsupported for KAIFUU-172".to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }

    fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_SEEN_TXT_PATH.to_string(),
                status: if self.seen_txt_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "RealLive SEEN.TXT detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                status: if self.gameexe_ini_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "RealLive Gameexe.ini detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "reallive-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("fixtureOnly".to_string(), "true".to_string());
        metadata.insert(
            "profileDiagnostics.ambiguousSiglusOverlap".to_string(),
            (self.siglus_scene_pck_present || self.siglus_gameexe_dat_present).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.avg32PdtPresent".to_string(),
            (self.avg32_pdt_count > 0).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.gameexeIniKeyHits".to_string(),
            self.gameexe_ini_keys.any().to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert("g00Count".to_string(), self.g00_count.to_string());
        metadata.insert(
            "voiceArchiveCount".to_string(),
            self.voice_archive_count.to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            REALLIVE_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}

impl EngineAdapter for RealLiveProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        REALLIVE_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu RealLive Scene/SEEN inventory adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText],
            supported_patch_back: vec![PatchBackTransform::Identity],
            support_boundary: Some("identify/profile generation reads SEEN.TXT envelope bytes, Gameexe.ini ASCII prefixes, top-level marker counts, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![
                SurfaceTransform::Identity,
                SurfaceTransform::ArchiveEntry,
                SurfaceTransform::BinaryOffset,
            ],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::Archive],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BytecodeDecompile],
            supported_patch_back: vec![PatchBackTransform::Identity],
            support_boundary: Some("Scene/SEEN + Gameexe.ini bridge inventory plus bounded asset reference catalogue (.g00 / .koe / .ovk / .nwk)".to_string()),
        };
        let extract = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Extraction],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::Archive],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BytecodeDecompile],
            supported_patch_back: vec![
                PatchBackTransform::Identity,
                PatchBackTransform::ReplaceFile,
                PatchBackTransform::RecompileBytecode,
            ],
            support_boundary: Some("Scene/SEEN bridge unit extraction with stable KAIFUU-173 slot ids (length-changing bundle-driven patch-back at the Patch contract)".to_string()),
        };
        let patch = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Patching, Capability::PatchBack],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::Archive],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BytecodeDecompile],
            supported_patch_back: vec![PatchBackTransform::RecompileBytecode],
            support_boundary: Some(
                "Length-changing slot replacement: bundle-driven patch-back rewrites the offset table and recalculates jump targets, so a translation that grows or shrinks the Shift-JIS body round-trips byte-correct. Genuinely-unencodable edits (a non-Shift-JIS codepoint, a goto target left strictly inside an edited body, or a scene-packing overflow) are rejected with the typed kaifuu.reallive.patchback_* Fatal."
                    .to_string(),
            ),
        };
        AdapterCapabilities::new(
            REALLIVE_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::supported(Capability::ContainerAccess),
                CapabilityReport::supported(Capability::CodecAccess),
                CapabilityReport::supported(Capability::PatchBack),
                CapabilityReport::limited(
                    Capability::Patching,
                    "length-changing Scene/SEEN text-slot replacement (offset table rewritten + jump targets recalculated) applied through the bundle-driven driver; limited to one scene-scoped bundle per call and to the configured text scope (dialogue/speaker/choice), not image-overlaid .g00 text",
                ),
                CapabilityReport::limited(
                    Capability::AssetTextPatching,
                    "Scene/SEEN dialogue/speaker/choice slots only; image-overlaid text inside .g00 is not in scope",
                ),
                CapabilityReport::limited(
                    Capability::LineParityPatching,
                    "patch-back is per-slot, not per-line; the KAIFUU-052 line-parity contract is not claimed at this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "RealLive voice archive obfuscation handling is outside this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::KeyProfile,
                    "alpha-vertical RealLive titles do not require user-provided keys; encrypted variants are a separate node",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to UTSUSHI-146, not this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted SEEN.TXT is out of scope at KAIFUU-174",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to RealLive at this slice",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for RealLive fixtures",
                ),
            ],
            AdapterCapabilityMatrix::new(
                REALLIVE_DETECTOR_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::partial(vec![
                    "Scene parser (KAIFUU-173) covers text slots but not all asset surfaces"
                        .to_string(),
                    "image-overlaid text inside .g00 is not in scope".to_string(),
                ]),
                CapabilityLevelStatus::unsupported(
                    "no full multi-scene archive-rebuild patch path yet; KAIFUU-053 reports patch as Unsupported at the matrix even though KAIFUU-174 supports length-changing single-scene slot replacement through the bundle-driven driver",
                ),
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract,
            patch,
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant != RealLiveFixtureVariant::NotRealLive;
        // KAIFUU-189: when the depth-N walk found a nested REALLIVEDATA/,
        // the SEEN.TXT/SEEN.GAN/Gameexe.ini evidence paths are reported
        // relative to the game root with the REALLIVEDATA/ prefix so
        // downstream tools (and human auditors) see exactly where the
        // detector read its bytes. When no nested dir was resolved, the
        // bare top-level names are kept for backward compatibility with
        // the existing synthetic fixtures.
        let resolved_data_dir_display = state
            .resolved_reallive_data_dir
            .as_deref()
            .map(path_to_forward_slash);
        let seen_txt_evidence_path =
            nest_evidence_path(resolved_data_dir_display.as_deref(), REALLIVE_SEEN_TXT_PATH);
        let seen_gan_evidence_path =
            nest_evidence_path(resolved_data_dir_display.as_deref(), REALLIVE_SEEN_GAN_PATH);
        let gameexe_ini_evidence_path = nest_evidence_path(
            resolved_data_dir_display.as_deref(),
            REALLIVE_GAMEEXE_INI_PATH,
        );

        let mut evidence_rows = vec![
            DetectionEvidence {
                path: seen_txt_evidence_path,
                kind: "reallive_seen_txt_envelope".to_string(),
                status: evidence_status(state.seen_txt_exists, state.seen_txt_envelope_ok),
                detail: signature_detail(
                    state.seen_txt_exists,
                    state.seen_txt_envelope_ok,
                    "SEEN.TXT envelope",
                ),
            },
            DetectionEvidence {
                path: seen_gan_evidence_path,
                kind: "reallive_seen_gan_marker".to_string(),
                status: evidence_status(state.seen_gan_exists, state.seen_gan_synthetic_magic),
                detail: signature_detail(
                    state.seen_gan_exists,
                    state.seen_gan_synthetic_magic,
                    "SEEN.GAN marker",
                ),
            },
            DetectionEvidence {
                path: gameexe_ini_evidence_path,
                kind: "reallive_gameexe_ini_keys".to_string(),
                status: evidence_status(state.gameexe_ini_exists, state.gameexe_ini_keys.any()),
                detail: gameexe_ini_detail(state.gameexe_ini_exists, state.gameexe_ini_keys),
            },
            DetectionEvidence {
                path: "*.g00".to_string(),
                kind: "reallive_g00_extension_count".to_string(),
                status: if state.g00_count > 0 {
                    EvidenceStatus::Matched
                } else {
                    EvidenceStatus::Missing
                },
                detail: format!("RealLive .g00 image asset count: {}", state.g00_count),
            },
            DetectionEvidence {
                path: "*.ovk|*.koe|*.nwk".to_string(),
                kind: "reallive_voice_archive_count".to_string(),
                status: if state.voice_archive_count > 0 {
                    EvidenceStatus::Matched
                } else {
                    EvidenceStatus::Missing
                },
                detail: format!(
                    "RealLive voice archive extension count: {}",
                    state.voice_archive_count
                ),
            },
            DetectionEvidence {
                path: "Scene.pck".to_string(),
                kind: "siglus_cross_check_scene_pck".to_string(),
                status: if state.siglus_scene_pck_present {
                    EvidenceStatus::Invalid
                } else {
                    EvidenceStatus::Missing
                },
                detail: if state.siglus_scene_pck_present {
                    "Scene.pck co-present (Siglus marker)".to_string()
                } else {
                    "Scene.pck not present".to_string()
                },
            },
            DetectionEvidence {
                path: "Gameexe.dat".to_string(),
                kind: "siglus_cross_check_gameexe_dat".to_string(),
                status: if state.siglus_gameexe_dat_present {
                    EvidenceStatus::Invalid
                } else {
                    EvidenceStatus::Missing
                },
                detail: if state.siglus_gameexe_dat_present {
                    "Gameexe.dat co-present (Siglus marker)".to_string()
                } else {
                    "Gameexe.dat not present".to_string()
                },
            },
            DetectionEvidence {
                path: "*.pdt".to_string(),
                kind: "avg32_cross_check_pdt_count".to_string(),
                status: if state.avg32_pdt_count > 0 {
                    EvidenceStatus::Invalid
                } else {
                    EvidenceStatus::Missing
                },
                detail: format!(
                    "AVG32 .PDT image asset count (informational): {}",
                    state.avg32_pdt_count
                ),
            },
        ];

        if let Some(resolved_display) = resolved_data_dir_display.as_deref() {
            evidence_rows.push(DetectionEvidence {
                path: resolved_display.to_string(),
                kind: REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE.to_string(),
                status: EvidenceStatus::Matched,
                detail: format!(
                    "RealLive REALLIVEDATA/ engine asset root resolved at relative path {resolved_display} (KAIFUU-189 depth-N descent)",
                ),
            });
        }

        let mut result = DetectionResult {
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "reallive".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: evidence_rows,
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        Ok(AssetList {
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            assets: state.asset_profiles(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.inventory_from_state(Self::inspect(request.game_dir))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let resolved = Self::resolve_reallive_data_dir(request.game_dir);
        let seen_path = Self::seen_txt_path(request.game_dir);
        let archive_bytes = fs::read(&seen_path)?;
        let scene_index = match kaifuu_reallive::parse_archive(&archive_bytes) {
            Ok(index) => index,
            Err(diag) => {
                return Err(Self::diagnostic_error(Self::parser_failure(
                    Self::detected_variant(state.variant),
                    diag.code.as_str(),
                    &diag.message,
                )));
            }
        };
        // Unified extract/patch path (adapter-unify): extract projects each
        // scene through the SAME SceneHeader + AVG32-decompress +
        // `produce_bundle` pipeline `patch` uses, minting the deterministic
        // bridgeUnitIds `patch` re-derives — so a PatchExport keyed on
        // extract's ids resolves in patch with no id mismatch. Gameexe.ini
        // feeds the producer's NAMAE speaker resolution (best-effort;
        // absent -> empty inventory).
        let gameexe_path =
            Self::gameexe_ini_path_with_resolved(request.game_dir, resolved.as_deref());
        let gameexe_bytes = fs::read(&gameexe_path).unwrap_or_default();
        let gameexe_inventory = kaifuu_reallive::parse_gameexe_inventory(&gameexe_bytes);
        let produced =
            Self::produce_scene_bundles(&archive_bytes, &scene_index, &gameexe_inventory);
        let mut units: Vec<BridgeUnit> = Vec::new();
        for (_scene_id, bundle) in &produced {
            for unit in &bundle.bundle.units {
                units.push(Self::bridge_unit_from_v02(unit));
            }
        }
        let profile = self.profile_from_state(state.clone())?;
        let bridge = BridgeBundle {
            schema_version: "0.1.0".to_string(),
            bridge_id: deterministic_id("reallive-bridge", 174),
            source_bundle_hash: kaifuu_core::sha256_hash_bytes(&archive_bytes),
            source_locale: "ja-JP".to_string(),
            extractor_name: "kaifuu-reallive".to_string(),
            extractor_version: env!("CARGO_PKG_VERSION").to_string(),
            units,
        };
        Ok(ExtractionResult {
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            profile,
            bridge,
            warnings: vec![],
        })
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        // Length-preserving budget check: every PatchExportEntry whose
        // target Shift-JIS bytes exceed the source slot's byte budget
        // emits an OffsetOverflow failure. Other failures (unknown slot,
        // encode failure) are deferred to the real `patch` call.
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        }
        let seen_path = Self::seen_txt_path(request.game_dir);
        let Ok(archive_bytes) = fs::read(&seen_path) else {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        };
        let Ok(scene_index) = kaifuu_reallive::parse_archive(&archive_bytes) else {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        };
        let mut scenes = Vec::new();
        for entry in &scene_index.entries {
            let blob = &archive_bytes[entry.byte_offset as usize
                ..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
            let outcome =
                kaifuu_reallive::parse_scene_into_ast(blob, entry.scene_id, entry.byte_offset);
            if let Some(scene) = outcome.scene {
                scenes.push(scene);
            }
        }
        let failures = self.preflight_failures(
            request.patch_export,
            Self::detected_variant(state.variant),
            &scenes,
        );
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-preflight", 174),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            output_hash: content_hash(&kaifuu_core::sha256_hash_bytes(&archive_bytes)),
            failures,
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        }
        let resolved = Self::resolve_reallive_data_dir(request.game_dir);
        let seen_path = Self::seen_txt_path(request.game_dir);
        let archive_bytes = fs::read(&seen_path)?;
        // Synthetic-magic-only fixtures (KAIFUU-172 detector smoke) do not
        // present a parseable archive envelope. Return the legacy
        // unsupported-patch result so the detector contract stays observable
        // through `patch`.
        let Ok(scene_index) = kaifuu_reallive::parse_archive(&archive_bytes) else {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        };
        let variant = Self::detected_variant(state.variant);
        let patch_export_id = request.patch_export.patch_export_id.clone();
        let failed = |failures: Vec<AdapterFailure>| PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-patch", 174),
            patch_export_id: patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: kaifuu_core::sha256_hash_bytes(&archive_bytes),
            failures,
        };

        // Canonical patch-back route (KAIFUU-211 / ALPHA-006c): rebuild
        // the v0.2 BridgeBundle per scene via `produce_bundle`, match the
        // PatchExport entries to bridge units by `bridgeUnitId`, enforce the
        // KAIFUU-174 length-preserving budget, and apply through
        // `bundle_driven::apply_translated_bundle`. Gameexe.ini feeds the
        // producer's voice/asset inventory (best-effort; absent ->
        // empty).
        let gameexe_path =
            Self::gameexe_ini_path_with_resolved(request.game_dir, resolved.as_deref());
        let gameexe_bytes = fs::read(&gameexe_path).unwrap_or_default();
        let gameexe_inventory = kaifuu_reallive::parse_gameexe_inventory(&gameexe_bytes);

        // Unified extract/patch path (adapter-unify): patch rebuilds the
        // per-scene v0.2 bridge through the SAME `produce_scene_bundles`
        // walk `extract` uses, so the PatchExport's bridgeUnitIds (minted
        // by extract) match the ids re-derived here.
        let produced_scenes =
            Self::produce_scene_bundles(&archive_bytes, &scene_index, &gameexe_inventory);
        let mut matched_entry_ids: BTreeSet<String> = BTreeSet::new();
        let mut touched: Vec<(u16, serde_json::Value)> = Vec::new();
        // Length-CHANGING patch-back (reallive-adapter-expose-length-changing-
        // patchback): the KAIFUU-174 adapter routes every matched edit straight
        // through `bundle_driven::apply_translated_bundle`, which rewrites the
        // archive offset table and recalculates jump targets so a translation
        // that grows or shrinks the Shift-JIS body round-trips byte-correct.
        // There is NO length-preserving budget gate here — a plain length change
        // is a supported edit, not a failure. Genuinely-unencodable edits (a
        // non-Shift-JIS codepoint, a goto target left strictly inside an edited
        // body, a scene-packing overflow) are rejected by the driver itself with
        // its typed `kaifuu.reallive.patchback_*` Fatal, surfaced below.
        for (scene_id, produced) in &produced_scenes {
            let mut translated_json = produced.json.clone();
            let mut scene_matched = 0usize;
            if let Some(units_json) = translated_json["units"].as_array_mut() {
                for (i, unit) in produced.bundle.units.iter().enumerate() {
                    if let Some(export_entry) = request
                        .patch_export
                        .entries
                        .iter()
                        .find(|e| e.bridge_unit_id == unit.bridge_unit_id)
                    {
                        units_json[i]["target"] = serde_json::json!({
                            "locale": request.patch_export.target_locale,
                            "text": export_entry.target_text,
                        });
                        matched_entry_ids.insert(export_entry.bridge_unit_id.clone());
                        scene_matched += 1;
                    }
                }
            }
            if scene_matched == 0 {
                continue;
            }
            // No silent partial: a touched scene must translate EVERY one
            // of its bridge units (the v0.2 TranslatedBundle contract
            // requires a target per unit).
            if scene_matched != produced.bundle.units.len() {
                return Ok(failed(vec![Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    variant,
                    REALLIVE_SEEN_TXT_PATH,
                    format!(
                        "scene {scene:04} is partially translated ({scene_matched}/{total} \
                         bridge units); the bundle-driven patch-back requires a target for \
                         every unit in a patched scene",
                        scene = scene_id,
                        total = produced.bundle.units.len()
                    ),
                    "translate every unit of the scene, or re-extract a scene-scoped bundle",
                )]));
            }
            touched.push((*scene_id, translated_json));
        }

        // Any export entry that matched no bridge unit is a stale/unknown
        // reference — surface it as a typed failure.
        let unmatched: Vec<AdapterFailure> = request
            .patch_export
            .entries
            .iter()
            .filter(|e| !matched_entry_ids.contains(&e.bridge_unit_id))
            .map(|e| {
                Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    variant,
                    e.source_unit_key.clone(),
                    "PatchExportEntry bridgeUnitId is not present in any scene's v0.2 bridge",
                    "re-extract the bridge bundle before re-applying this patch",
                )
            })
            .collect();
        if !unmatched.is_empty() {
            return Ok(failed(unmatched));
        }

        let passed = |output_hash: String| PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-patch", 174),
            patch_export_id: patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash,
            failures: vec![],
        };
        let write_output = |bytes: &[u8]| -> KaifuuResult<()> {
            let output_path =
                kaifuu_core::safe_join_relative(request.output_dir, REALLIVE_SEEN_TXT_PATH)?;
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&output_path, bytes)?;
            Ok(())
        };

        // Empty export (or one that touched no scene) is an identity
        // patch: emit the source archive unchanged.
        if touched.is_empty() {
            write_output(&archive_bytes)?;
            return Ok(passed(kaifuu_core::sha256_hash_bytes(&archive_bytes)));
        }
        // The bundle-driven driver patches one source BridgeBundle (one
        // scene) per call. Multi-scene exports are out of scope for the
        // detector fixture's patch surface.
        if touched.len() > 1 {
            return Ok(failed(vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::PatchBack,
                variant,
                REALLIVE_SEEN_TXT_PATH,
                format!(
                    "patch export spans {} scenes; the fixture patch surface applies one \
                     scene-scoped bundle per call",
                    touched.len()
                ),
                "split the export into per-scene bundles and patch each scene separately",
            )]));
        }

        let (_scene_id, translated_json) = &touched[0];
        let translated = match kaifuu_reallive::TranslatedBundleV02::from_json(translated_json) {
            Ok(translated) => translated,
            Err(err) => {
                return Ok(failed(vec![
                    Self::patchback_v02_failure_to_adapter_failure(variant, err),
                ]));
            }
        };
        match kaifuu_reallive::apply_translated_bundle(
            &archive_bytes,
            &translated,
            // The fixture patch surface applies the FULL curated bundle it is
            // handed (dialogue + any choices), so it declares the widest alpha
            // scope; a dialogue-only bundle simply has no choice units.
            &kaifuu_reallive::PatchbackOpts::shift_jis(
                kaifuu_reallive::TranslationScope::DialogueAndChoices,
            ),
        ) {
            Ok(patched) => {
                write_output(&patched)?;
                Ok(passed(kaifuu_core::sha256_hash_bytes(&patched)))
            }
            Err(err) => Ok(failed(vec![
                Self::patchback_v02_failure_to_adapter_failure(variant, err),
            ])),
        }
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        let variant = Self::detected_variant(state.variant).to_string();
        let seen_path = Self::seen_txt_path(request.game_dir);
        let Ok(archive_bytes) = fs::read(&seen_path) else {
            return Ok(VerificationResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("reallive-verify", 174),
                status: OperationStatus::Failed,
                output_hash: content_hash(REALLIVE_SUPPORT_BOUNDARY),
                failures: vec![Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::Verification,
                    variant,
                    REALLIVE_SEEN_TXT_PATH,
                    "patched SEEN.TXT not present at the requested game directory",
                    "run patch first to populate the output directory",
                )],
            });
        };
        let mut failures = Vec::new();
        match kaifuu_reallive::parse_archive(&archive_bytes) {
            Ok(index) => {
                for entry in &index.entries {
                    let blob = &archive_bytes[entry.byte_offset as usize
                        ..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
                    let outcome = kaifuu_reallive::parse_scene_into_ast(
                        blob,
                        entry.scene_id,
                        entry.byte_offset,
                    );
                    if outcome.scene.is_none() {
                        failures.push(Self::unsupported_failure(
                            SemanticErrorCode::UnsupportedLayeredTransform,
                            Capability::Verification,
                            variant.clone(),
                            REALLIVE_SEEN_TXT_PATH,
                            "verify scene re-parse failed",
                            "re-run patch with a corrected translated bundle",
                        ));
                    }
                }
            }
            Err(diag) => {
                failures.push(Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::Verification,
                    variant.clone(),
                    REALLIVE_SEEN_TXT_PATH,
                    format!("verify archive re-parse failed: {}", diag.message),
                    "re-run patch with a corrected translated bundle",
                ));
            }
        }
        let status = if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-verify", 174),
            status,
            output_hash: kaifuu_core::sha256_hash_bytes(&archive_bytes),
            failures,
        })
    }
}

impl RealLiveProfileDetectorAdapter {
    fn parser_failure(variant: &str, diagnostic_code: &str, message: &str) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::UnsupportedLayeredTransform,
                REALLIVE_DETECTOR_ADAPTER_ID,
                format!("RealLive parser rejected SEEN.TXT: {diagnostic_code}: {message}"),
            )
            .engine("reallive")
            .detected_variant(variant)
            .asset_ref(REALLIVE_SEEN_TXT_PATH)
            .required_capability(Capability::CodecAccess)
            .remediation(
                "audit SEEN.TXT bytes against the KAIFUU-173 envelope shape and re-run extract",
            ),
        )
    }

    fn preflight_failures(
        &self,
        patch_export: &kaifuu_core::PatchExport,
        variant: &str,
        scenes: &[kaifuu_reallive::Scene],
    ) -> Vec<AdapterFailure> {
        let mut failures = Vec::new();
        for entry in &patch_export.entries {
            // Locate the slot.
            let mut found_slot = None;
            for scene in scenes {
                for slot in &scene.strings {
                    if slot.slot_id.as_str() == entry.source_unit_key {
                        found_slot = Some(slot);
                        break;
                    }
                }
                if found_slot.is_some() {
                    break;
                }
            }
            if found_slot.is_none() {
                failures.push(Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::PatchBack,
                    variant,
                    &entry.source_unit_key,
                    "PatchExportEntry sourceUnitKey is not present in the parsed Scene/SEEN AST",
                    "re-extract the bridge bundle before re-applying this patch",
                ));
                continue;
            }
            // Check the target is Shift-JIS-representable. Length is NOT
            // budgeted here: the bundle-driven patch path is length-changing
            // (offset table rewritten + jump targets recalculated), so a
            // translation that grows or shrinks the body is a supported edit,
            // not a preflight failure. Only a genuinely-unencodable target
            // (a codepoint outside Shift-JIS) is rejected at preflight.
            match kaifuu_reallive::encode_shift_jis_slot(&entry.target_text) {
                Ok(_encoded) => {}
                Err(err) => {
                    failures.push(Self::unsupported_failure(
                        SemanticErrorCode::UnsupportedLayeredTransform,
                        Capability::PatchBack,
                        variant,
                        &entry.source_unit_key,
                        format!("Shift-JIS encode failure: {err}"),
                        "replace characters outside Shift-JIS with mappable substitutes",
                    ));
                }
            }
        }
        failures
    }

    fn patchback_v02_failure_to_adapter_failure(
        variant: &str,
        err: kaifuu_reallive::PatchbackError,
    ) -> AdapterFailure {
        // The v0.2 `PatchbackError` Display already carries its stable
        // `kaifuu.reallive.patchback_*` code, so the message is the
        // single source of the diagnostic code.
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::UnsupportedLayeredTransform,
                REALLIVE_DETECTOR_ADAPTER_ID,
                format!("patch-back rejected: {err}"),
            )
            .engine("reallive")
            .detected_variant(variant)
            .asset_ref(REALLIVE_SEEN_TXT_PATH)
            .required_capability(Capability::PatchBack)
            .remediation(
                "review the translated bundle against the bundle-driven patch-back contract \
                 (kaifuu.reallive.patchback_* semantic codes)",
            ),
        )
    }

    // Shared extract/patch scene-walk (adapter-unify): parse each scene's
    // `SceneHeader`, AVG32-decompress its bytecode, and project it into a
    // v0.2 `BridgeBundle` via `bridge::produce_bundle`. Both `extract` and
    // `patch` drive off this ONE path, so the deterministic bridgeUnitIds a
    // PatchExport is keyed on (from `extract`) are exactly the ids
    // `produce_bundle` re-derives during `patch` — no id-scheme divergence.
    // A scene whose header does not parse, whose compressed range runs past
    // the blob, whose bytecode fails to decompress, or that carries no
    // translatable text unit is skipped (it has no v0.2 bridge units and is
    // carried verbatim by the repacker).
    fn produce_scene_bundles(
        archive_bytes: &[u8],
        scene_index: &kaifuu_reallive::RealLiveSceneIndex,
        gameexe_inventory: &kaifuu_reallive::GameexeInventoryReport,
    ) -> Vec<(u16, kaifuu_reallive::ProducedBundle)> {
        let mut bundles = Vec::new();
        for entry in &scene_index.entries {
            let blob = &archive_bytes[entry.byte_offset as usize
                ..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
            let Ok(header) = kaifuu_reallive::SceneHeader::parse(blob) else {
                continue;
            };
            let bytecode_start = header.bytecode_offset as usize;
            let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
            if bytecode_end > blob.len() {
                continue;
            }
            let Ok(decompressed) = kaifuu_reallive::decompress_avg32(
                &blob[bytecode_start..bytecode_end],
                header.bytecode_uncompressed_size as usize,
            ) else {
                continue;
            };
            let opts = kaifuu_reallive::BridgeOpts {
                game_id: REALLIVE_GAME_ID,
                game_version: "1.0.0",
                source_profile_id: REALLIVE_PROFILE_ID,
                source_locale: "ja-JP",
                extractor_name: "kaifuu-reallive-bridge",
                extractor_version: "0.1.0",
                scene_kidoku_count: header.kidoku_count,
            };
            let Ok(produced) = kaifuu_reallive::produce_bundle(
                entry.scene_id,
                blob,
                &decompressed,
                gameexe_inventory,
                &opts,
            ) else {
                continue;
            };
            bundles.push((entry.scene_id, produced));
        }
        bundles
    }

    // Project a validated v0.2 localization unit onto the v0.1
    // `kaifuu_core::BridgeUnit` the `ExtractionResult.bridge` contract
    // carries. The `bridgeUnitId` / `sourceUnitKey` / `sourceHash` are the
    // deterministic values `produce_bundle` minted, so a PatchExport keyed
    // on them resolves against the same producer during `patch`.
    fn bridge_unit_from_v02(unit: &kaifuu_core::LocalizationUnitV02) -> BridgeUnit {
        let speaker = unit
            .speaker
            .as_ref()
            .and_then(|speaker| speaker.raw_speaker_text.clone())
            .unwrap_or_default();
        let protected_spans = unit
            .spans
            .iter()
            .map(Self::protected_span_from_v02)
            .collect();
        BridgeUnit {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            occurrence_id: unit.occurrence_id.clone(),
            source_hash: unit.source_hash.clone(),
            source_locale: unit.source_locale.clone(),
            source_text: unit.source_text.clone(),
            speaker,
            text_surface: unit.surface_kind.clone(),
            protected_spans,
            patch_ref: PatchRef {
                asset_id: "reallive-seen-txt".to_string(),
                write_mode: "replace".to_string(),
                source_unit_key: unit.source_unit_key.clone(),
            },
        }
    }

    fn protected_span_from_v02(span: &kaifuu_core::BridgeSpanV02) -> ProtectedSpan {
        let mut mapped = ProtectedSpan::new(
            span.span_kind.clone(),
            span.raw.clone(),
            span.start_byte,
            span.end_byte,
            span.preserve_mode.clone(),
        );
        mapped.parsed_name = span
            .parsed_name
            .as_ref()
            .and_then(|value| value.as_str())
            .map(str::to_string);
        mapped
    }
}

// Case-insensitive direct-child lookup.
//
// The lookup mirrors the existing `ArchiveDetectionScan.file_name_count`
// case-insensitive pattern. Returns the resolved path on a hit so callers
// can read its bytes; returns None if no direct child matches the lowercase
// name. Used only against `game_dir` (no recursion); RealLive top-level
// markers are always at the game root per Haeleth's public documentation.
fn case_insensitive_find(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    let target = name.to_ascii_lowercase();
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        if let Some(entry_name) = entry.file_name().to_str()
            && entry_name.to_ascii_lowercase() == target
        {
            return Some(entry.path());
        }
    }
    None
}

// KAIFUU-189: walks the effective RealLive data dir (the resolved
// REALLIVEDATA subdir or, when no marker was found, the game root) up
// to two directory levels deep to count corroborating extensions and
// the AVG32 disqualifier. The depth-2 bound captures Sweetie HD's
// observed layout (`<REALLIVEDATA>/g00/*.g00`,
// `<REALLIVEDATA>/koe/*.koe`, etc.) without descending into save /
// debug subtrees that ship with some retail installers. See
// `docs/audits/real-bytes-validation-2026-06-24.md` §2.1 for the
// `find <REALLIVEDATA> -maxdepth 2` reference command that fixed the
// 2,450 `.g00` / 139 `.koe` corpus counts.
fn reallive_extension_counts(dir: &Path) -> (u64, u64, u64) {
    let mut g00_count: u64 = 0;
    let mut voice_archive_count: u64 = 0;
    let mut pdt_count: u64 = 0;
    walk_reallive_extension_dir(
        dir,
        2,
        0,
        &mut g00_count,
        &mut voice_archive_count,
        &mut pdt_count,
    );
    (g00_count, voice_archive_count, pdt_count)
}

fn walk_reallive_extension_dir(
    dir: &Path,
    max_depth: usize,
    current_depth: usize,
    g00_count: &mut u64,
    voice_archive_count: &mut u64,
    pdt_count: &mut u64,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if current_depth < max_depth {
                walk_reallive_extension_dir(
                    &path,
                    max_depth,
                    current_depth + 1,
                    g00_count,
                    voice_archive_count,
                    pdt_count,
                );
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(extension) = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
        else {
            continue;
        };
        match extension.as_str() {
            "g00" => *g00_count += 1,
            "ovk" | "koe" | "nwk" => *voice_archive_count += 1,
            "pdt" => *pdt_count += 1,
            _ => {}
        }
    }
}

// Generic real-shape SEEN.TXT envelope check (KAIFUU-188).
//
// Derivation: every RealLive title since AVG32 stores SEEN.TXT as a fixed
// 10,000-slot directory of (u32_le offset, u32_le size) pairs at file
// offset 0. Each slot is 8 bytes; an unused slot is zeroed. See
// `docs/research/reallive-engine.md` §C and the Sweetie HD verification
// in `docs/audits/real-bytes-validation-2026-06-24.md` §2.8.
//
// We accept any file that is at least 80,000 bytes long (the fixed
// directory), contains at least one non-zero slot, and whose every
// non-zero slot resolves to a payload range inside the file. We do not
// parse scene bytecode.
fn reallive_seen_txt_envelope_ok(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let file_len = metadata.len();
    if file_len < kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    match kaifuu_reallive::parse_archive(&bytes) {
        Ok(index) => !index.entries.is_empty(),
        Err(_) => false,
    }
}

// Read up to 64 KiB of Gameexe.ini and check for the documented
// RealLive-specific ASCII key prefixes. The detector intentionally only
// looks at ASCII prefixes; full Gameexe parsing (including Shift-JIS
// values) is a KAIFUU-174 concern.
fn reallive_gameexe_ini_key_hits(path: &Path) -> GameexeIniKeyHits {
    let Ok(bytes) = fs::read(path) else {
        return GameexeIniKeyHits::default();
    };
    let limit = std::cmp::min(bytes.len(), 64 * 1024);
    let slice = &bytes[..limit];
    let text = String::from_utf8_lossy(slice);
    let mut hits = GameexeIniKeyHits::default();
    for raw_line in text.lines() {
        let line = raw_line.trim_start();
        if !line.starts_with('#') {
            continue;
        }
        // Uppercase the key portion only (before '=' or whitespace) for
        // robustness, then match the RealLive Gameexe.ini key prefixes that
        // are positive engine evidence. These prefixes are documented on
        // Haeleth's RLDEV site (https://dev.haeleth.net/rldev.shtml) and
        // observable in any RealLive title's Gameexe.ini; none are copied
        // from rlvm source. This match is the single source of truth.
        let key_end = line
            .find(|c: char| c == '=' || c.is_whitespace())
            .unwrap_or(line.len());
        let key = line[..key_end].to_ascii_uppercase();
        if key == "#GAMEEXE_VERSION" {
            hits.gameexe_version = true;
        } else if key == "#REGNAME" {
            hits.regname = true;
        } else if key.starts_with("#G00") {
            hits.g00_key = true;
        } else if key.starts_with("#KOE") {
            hits.koe_key = true;
        } else if key.starts_with("#SEEN") {
            hits.seen_key = true;
        }
    }
    hits
}

fn gameexe_ini_detail(exists: bool, keys: GameexeIniKeyHits) -> String {
    if !exists {
        return "Gameexe.ini missing".to_string();
    }
    if !keys.any() {
        return "Gameexe.ini present but no RealLive-specific keys matched".to_string();
    }
    let mut matched = Vec::new();
    if keys.gameexe_version {
        matched.push("#GAMEEXE_VERSION");
    }
    if keys.regname {
        matched.push("#REGNAME");
    }
    if keys.g00_key {
        matched.push("#G00*");
    }
    if keys.koe_key {
        matched.push("#KOE*");
    }
    if keys.seen_key {
        matched.push("#SEEN*");
    }
    format!("Gameexe.ini RealLive keys matched: {}", matched.join(", "))
}

// =====================================================================
// Softpal ADV (Amuse Craft / "Pal") engine detector.
//
// Detection is a small deterministic decision over three independent,
// Softpal-specific signals (see the `SOFTPAL_*` constant provenance block):
//   1. `dll/Pal.dll` present            — definitive Pal-engine marker.
//   2. a `.pac` (`PAC ` magic) whose file table names both `SCRIPT.SRC`
//      and `TEXT.DAT`                    — the ADV script/text container.
//   3. loose `SCRIPT.SRC` (`Sv<nn>`) AND `TEXT.DAT` (`[$_]TEXT_LIST__`)
//      script magics                     — enc-flag-robust script pair.
// Any one of (1), (2), or (3) classifies `engine=softpal` at identify level.
// =====================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SoftpalVariant {
    // `dll/Pal.dll` present — the strongest, definitive Softpal signal.
    PalDll,
    // A `.pac` archive lists both `SCRIPT.SRC` and `TEXT.DAT` (no Pal.dll).
    PacScripts,
    // Loose `SCRIPT.SRC` + `TEXT.DAT` script magics (no Pal.dll, no PAC table).
    LooseScripts,
    // A `.pac` opened with `PAC ` magic but its table did not name the Softpal
    // scripts, or a Softpal-named file was present without a recognised
    // signature. Diagnostic — reported, but NOT `detected` (false-positive
    // guard: bare `PAC ` magic is not enough to claim the Softpal engine).
    UnknownPacOnly,
    NotSoftpal,
}

#[derive(Debug, Clone)]
struct SoftpalState {
    pal_dll_present: bool,
    // Any `.pac` in the game dir opened with the `PAC ` magic.
    pac_present: bool,
    // A `.pac` whose file table names both `SCRIPT.SRC` and `TEXT.DAT`.
    pac_scripts: bool,
    // Relative name of the `.pac` that matched the scripts signature.
    scripts_pac_name: Option<String>,
    // Loose `SCRIPT.SRC` opening with the `Sv<nn>` script magic.
    loose_script_src: bool,
    // Loose `TEXT.DAT` opening with `[$_]TEXT_LIST__`.
    loose_text_dat: bool,
    // Encryption-flag byte observed on a loose `TEXT.DAT` (`$`/`_`), if any.
    text_dat_enc_flag: Option<u8>,
    variant: SoftpalVariant,
}

impl SoftpalState {
    fn enc_flag_label(&self) -> &'static str {
        match self.text_dat_enc_flag {
            Some(SOFTPAL_TEXT_DAT_ENC_ENCRYPTED) => "encrypted ($)",
            Some(SOFTPAL_TEXT_DAT_ENC_PLAINTEXT) => "plaintext (_)",
            _ => "unobserved",
        }
    }

    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.pal_dll_present {
            evidence.push(format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"));
        }
        if let Some(name) = &self.scripts_pac_name {
            evidence.push(name.clone());
        } else if self.pac_present {
            evidence.push("*.pac".to_string());
        }
        if self.loose_script_src {
            evidence.push(SOFTPAL_SCRIPT_SRC_NAME.to_string());
        }
        if self.loose_text_dat {
            evidence.push(SOFTPAL_TEXT_DAT_NAME.to_string());
        }
        evidence
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("engineFamily".to_string(), "softpal".to_string());
        metadata.insert(
            "signal.palDll".to_string(),
            self.pal_dll_present.to_string(),
        );
        metadata.insert(
            "signal.pacScripts".to_string(),
            self.pac_scripts.to_string(),
        );
        metadata.insert(
            "signal.looseScriptSrc".to_string(),
            self.loose_script_src.to_string(),
        );
        metadata.insert(
            "signal.looseTextDat".to_string(),
            self.loose_text_dat.to_string(),
        );
        metadata.insert(
            "textDatEncFlag".to_string(),
            self.enc_flag_label().to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            SOFTPAL_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"),
                status: if self.pal_dll_present {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "Softpal Pal.dll engine marker".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SOFTPAL_DATA_PAC_NAME.to_string(),
                status: if self.pac_scripts {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "Softpal PAC archive listing SCRIPT.SRC and TEXT.DAT".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "softpal-pac-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description:
                    "PAC archive parsing / SCRIPT.SRC decompilation / TEXT.DAT decode are outside the Softpal detector (later Softpal nodes)"
                        .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }
}

impl SoftpalProfileDetectorAdapter {
    fn pal_dll_path(game_dir: &Path) -> Option<std::path::PathBuf> {
        let dll_dir = case_insensitive_find(game_dir, SOFTPAL_PAL_DLL_DIR)?;
        if !dll_dir.is_dir() {
            return None;
        }
        case_insensitive_find(&dll_dir, SOFTPAL_PAL_DLL_NAME).filter(|path| path.is_file())
    }

    // Recognise a `.pac` whose file table names both `SCRIPT.SRC` and
    // `TEXT.DAT`. Reads only a bounded header/table prefix (never the whole
    // archive) and requires the `PAC ` magic plus a sane entry count before
    // searching for the entry names, so a bare `PAC ` file cannot false-positive.
    fn pac_names_softpal_scripts(path: &Path) -> bool {
        let Some(prefix) = read_file_prefix(path, SOFTPAL_PAC_TABLE_SCAN_LEN) else {
            return false;
        };
        if !prefix.starts_with(SOFTPAL_PAC_MAGIC) {
            return false;
        }
        let Some(entry_count) = read_u32_le(&prefix, 8) else {
            return false;
        };
        if entry_count == 0 || entry_count > SOFTPAL_PAC_MAX_ENTRIES {
            return false;
        }
        bytes_contains(&prefix, SOFTPAL_SCRIPT_SRC_ENTRY)
            && bytes_contains(&prefix, SOFTPAL_TEXT_DAT_ENTRY)
    }

    fn pac_has_magic(path: &Path) -> bool {
        read_file_prefix(path, SOFTPAL_PAC_MAGIC.len())
            .is_some_and(|prefix| prefix.starts_with(SOFTPAL_PAC_MAGIC))
    }

    // Loose `SCRIPT.SRC` opens with `Sv` followed by a two-digit version
    // (`Sv20` observed; `Sv<nn>` tolerates other script-format revisions).
    fn loose_script_src_ok(path: &Path) -> bool {
        let Some(prefix) = read_file_prefix(path, 4) else {
            return false;
        };
        prefix.len() >= 4
            && prefix.starts_with(SOFTPAL_SCRIPT_SRC_MAGIC_PREFIX)
            && prefix[2].is_ascii_digit()
            && prefix[3].is_ascii_digit()
    }

    // Loose `TEXT.DAT` opens with a one-byte encryption flag (`$` encrypted or
    // `_` plaintext) followed by `TEXT_LIST__`. Returns the flag byte so the
    // detector can report enc-flag robustness across variants.
    fn loose_text_dat_flag(path: &Path) -> Option<u8> {
        let want = 1 + SOFTPAL_TEXT_LIST_TAG.len();
        let prefix = read_file_prefix(path, want)?;
        if prefix.len() < want {
            return None;
        }
        let flag = prefix[0];
        if flag != SOFTPAL_TEXT_DAT_ENC_ENCRYPTED && flag != SOFTPAL_TEXT_DAT_ENC_PLAINTEXT {
            return None;
        }
        if &prefix[1..want] == SOFTPAL_TEXT_LIST_TAG {
            Some(flag)
        } else {
            None
        }
    }

    fn inspect(game_dir: &Path) -> SoftpalState {
        let pal_dll_present = Self::pal_dll_path(game_dir).is_some();

        // Scan the game dir's `.pac` archives (bounded). `data.pac` carries the
        // scripts, but iterate all `.pac` to stay robust to packaging variants.
        let mut pac_present = false;
        let mut pac_scripts = false;
        let mut scripts_pac_name: Option<String> = None;
        if let Ok(entries) = fs::read_dir(game_dir) {
            let mut pac_paths: Vec<std::path::PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("pac"))
                })
                .collect();
            // Deterministic order; probe `data.pac` first so it wins the report.
            pac_paths.sort();
            pac_paths.sort_by_key(|path| {
                !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(SOFTPAL_DATA_PAC_NAME))
            });
            for path in pac_paths {
                if Self::pac_has_magic(&path) {
                    pac_present = true;
                }
                if !pac_scripts && Self::pac_names_softpal_scripts(&path) {
                    pac_scripts = true;
                    scripts_pac_name = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_string);
                }
            }
        }

        let loose_script_src = case_insensitive_find(game_dir, SOFTPAL_SCRIPT_SRC_NAME)
            .is_some_and(|path| Self::loose_script_src_ok(&path));
        let text_dat_enc_flag = case_insensitive_find(game_dir, SOFTPAL_TEXT_DAT_NAME)
            .and_then(|path| Self::loose_text_dat_flag(&path));
        let loose_text_dat = text_dat_enc_flag.is_some();

        let variant = if pal_dll_present {
            SoftpalVariant::PalDll
        } else if pac_scripts {
            SoftpalVariant::PacScripts
        } else if loose_script_src && loose_text_dat {
            SoftpalVariant::LooseScripts
        } else if pac_present || loose_script_src || loose_text_dat {
            SoftpalVariant::UnknownPacOnly
        } else {
            SoftpalVariant::NotSoftpal
        };

        SoftpalState {
            pal_dll_present,
            pac_present,
            pac_scripts,
            scripts_pac_name,
            loose_script_src,
            loose_text_dat,
            text_dat_enc_flag,
            variant,
        }
    }

    fn detected_variant(variant: SoftpalVariant) -> &'static str {
        match variant {
            SoftpalVariant::PalDll => "pal-dll",
            SoftpalVariant::PacScripts => "pac-script-src-text-dat",
            SoftpalVariant::LooseScripts => "loose-script-src-text-dat",
            SoftpalVariant::UnknownPacOnly => "unknown-softpal-signature",
            SoftpalVariant::NotSoftpal => "not-softpal",
        }
    }

    fn is_detected(variant: SoftpalVariant) -> bool {
        matches!(
            variant,
            SoftpalVariant::PalDll | SoftpalVariant::PacScripts | SoftpalVariant::LooseScripts
        )
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, SOFTPAL_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("softpal")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::ContainerAccess,
            variant,
            SOFTPAL_DATA_PAC_NAME,
            "Softpal PAC extraction / SCRIPT.SRC decompilation / TEXT.DAT decode is outside the detector",
            "use identify (detect/profile) output only; do not request asset-list, extract, or patch for this detector",
        )
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: SoftpalVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-patch", 12),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::MissingContainerCapability,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    SOFTPAL_DATA_PAC_NAME,
                    "Softpal PAC archive container access is not implemented by the detector",
                    "use identify output only",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    SOFTPAL_DATA_PAC_NAME,
                    "Softpal patch-back/repack support is not implemented by the detector",
                    "add an explicit Softpal patch-back adapter before writing patched PAC output",
                ),
            ],
        }
    }

    fn profile_from_state(&self, state: SoftpalState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(state.variant),
                format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"),
                "Softpal detector requires a recognised Pal.dll / PAC+SCRIPT.SRC/TEXT.DAT / script-magic signature",
                "run detect against a Softpal title or select another adapter",
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: SOFTPAL_PROFILE_ID.to_string(),
            game_id: SOFTPAL_GAME_ID.to_string(),
            title: "Softpal title (detector profile)".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "softpal".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "softpal-pac-archive".to_string(),
                name: "pacArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: SOFTPAL_DATA_PAC_NAME.to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: vec![],
            layered_access: None,
            capabilities: self.capabilities().reports,
            requirements: state.detection_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }
}

impl EngineAdapter for SoftpalProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        SOFTPAL_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu Softpal ADV (Amuse Craft/Pal) detector adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some(
                "identify/profile reads only file names, container magics, and script signatures"
                    .to_string(),
            ),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(SOFTPAL_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            SOFTPAL_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::unsupported(
                    Capability::AssetListing,
                    "Softpal PAC entry listing is a later Softpal node, not the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetInventory,
                    "Softpal asset inventory is a later Softpal node, not the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "the Softpal detector does not extract PAC archives",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "the Softpal detector does not patch or rebuild Softpal assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "PAC archive parsing is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "TEXT.DAT/PAC decryption is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "SCRIPT.SRC decompilation / TEXT.DAT decode is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "Softpal patch-back/repack support is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/Softpal work, not this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted TEXT.DAT payloads are identified only, never decrypted",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no Softpal text surfaces are patched by this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to the detector-only Softpal profile",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed by the Softpal detector",
                ),
            ],
            AdapterCapabilityMatrix::identify_only(
                SOFTPAL_DETECTOR_ADAPTER_ID,
                "Softpal detector is identify-only; PAC extraction, SCRIPT.SRC decompilation, TEXT.DAT decode/decryption, and patch-back are unsupported (later Softpal nodes)",
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory: unsupported(vec![Capability::AssetListing, Capability::AssetInventory]),
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = state.variant == SoftpalVariant::UnknownPacOnly;
        let mut result = DetectionResult {
            adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "softpal".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"),
                    kind: "softpal_pal_dll".to_string(),
                    status: if state.pal_dll_present {
                        EvidenceStatus::Matched
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.pal_dll_present {
                        "dll/Pal.dll present (definitive Softpal engine marker)".to_string()
                    } else {
                        "dll/Pal.dll not found".to_string()
                    },
                },
                DetectionEvidence {
                    path: state
                        .scripts_pac_name
                        .clone()
                        .unwrap_or_else(|| SOFTPAL_DATA_PAC_NAME.to_string()),
                    kind: "softpal_pac_script_text_entries".to_string(),
                    status: if state.pac_scripts {
                        EvidenceStatus::Matched
                    } else if state.pac_present {
                        EvidenceStatus::Invalid
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.pac_scripts {
                        "PAC archive (\"PAC \" magic) lists SCRIPT.SRC and TEXT.DAT entries"
                            .to_string()
                    } else if state.pac_present {
                        "a .pac with \"PAC \" magic is present but does not list SCRIPT.SRC/TEXT.DAT"
                            .to_string()
                    } else {
                        "no Softpal PAC archive found".to_string()
                    },
                },
                DetectionEvidence {
                    path: SOFTPAL_SCRIPT_SRC_NAME.to_string(),
                    kind: "softpal_script_src_magic".to_string(),
                    status: if state.loose_script_src {
                        EvidenceStatus::Matched
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.loose_script_src {
                        "loose SCRIPT.SRC opens with the Sv<nn> script magic".to_string()
                    } else {
                        "no loose SCRIPT.SRC with the Sv<nn> magic".to_string()
                    },
                },
                DetectionEvidence {
                    path: SOFTPAL_TEXT_DAT_NAME.to_string(),
                    kind: "softpal_text_dat_magic".to_string(),
                    status: if state.loose_text_dat {
                        EvidenceStatus::Matched
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.loose_text_dat {
                        format!(
                            "loose TEXT.DAT opens with [$_]TEXT_LIST__ (enc flag: {})",
                            state.enc_flag_label()
                        )
                    } else {
                        "no loose TEXT.DAT with the [$_]TEXT_LIST__ magic".to_string()
                    },
                },
            ],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::AssetListing,
            Self::detected_variant(state.variant),
            SOFTPAL_DATA_PAC_NAME,
            "Softpal PAC entry listing is a later Softpal node, not the detector",
            "use identify (detect/profile) output only",
        )))
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::AssetInventory,
            Self::detected_variant(state.variant),
            SOFTPAL_DATA_PAC_NAME,
            "Softpal asset inventory is a later Softpal node, not the detector",
            "use identify (detect/profile) output only",
        )))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            Self::detected_variant(state.variant),
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-verify", 12),
            status: OperationStatus::Failed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                SOFTPAL_DATA_PAC_NAME,
                "runtime/parser verification is outside the Softpal detector",
                "use detect or profile only",
            )],
        })
    }
}

// ---- NeXAS engine detector ------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NexasVariant {
    // At least one `.pac` opens with the `PAC\0` magic and a sane header
    // (count + pack_type) — the definitive NeXAS container signal.
    NexasPac,
    // A file opens with the `PAC\0` magic but its header (count / pack_type) is
    // out of range. Diagnostic — reported, but NOT `detected` (a bare magic is
    // not enough to claim the NeXAS engine).
    UnknownPacOnly,
    NotNexas,
}

#[derive(Debug, Clone)]
struct NexasState {
    // A `.pac` opened with the `PAC\0` magic AND a sane count + pack_type.
    nexas_pac: bool,
    // A `.pac` opened with the `PAC\0` magic but a header out of range.
    unknown_pac_magic: bool,
    // Relative name of the `.pac` that first matched the NeXAS signature.
    primary_pac_name: Option<String>,
    // Category-archive base names present (case-insensitive), e.g. "system".
    category_hits: Vec<String>,
    // Observed pack_type words across the recognised NeXAS archives (sorted).
    pack_types: Vec<u32>,
    variant: NexasVariant,
}

impl NexasState {
    fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if let Some(name) = &self.primary_pac_name {
            evidence.push(name.clone());
        }
        evidence.extend(self.category_hits.iter().map(|hit| format!("{hit}.pac")));
        evidence
    }

    fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("engineFamily".to_string(), "nexas".to_string());
        metadata.insert("signal.pacMagic".to_string(), self.nexas_pac.to_string());
        metadata.insert(
            "signal.categoryArchives".to_string(),
            self.category_hits.len().to_string(),
        );
        metadata.insert(
            "packTypes".to_string(),
            self.pack_types
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            NEXAS_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }

    fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: "*.pac".to_string(),
                status: if self.nexas_pac {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "NeXAS `PAC\\0`-magic category archive (Bgm/Face/Script/System/Voice*.pac)"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "nexas-pac-reader".to_string(),
                status: RequirementStatus::Unsupported,
                description:
                    "PAC extraction + per-entry decompression are provided by the kaifuu-nexas crate, outside this detector"
                        .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }
}

impl NexasProfileDetectorAdapter {
    // Recognise a NeXAS `.pac`: `PAC\0` magic (4th byte NUL, NOT the Softpal
    // space), a sane count @0x04, and a small pack_type @0x08. Returns
    // `Some(Some(pack_type))` for a valid NeXAS header, `Some(None)` when the
    // magic matched but the header is out of range, and `None` when the magic
    // is not `PAC\0` at all (e.g. a Softpal `"PAC "` archive).
    fn nexas_pac_header(path: &Path) -> Option<Option<u32>> {
        let prefix = read_file_prefix(path, NEXAS_HEADER_BYTE_LEN)?;
        if prefix.len() < NEXAS_HEADER_BYTE_LEN || !prefix.starts_with(NEXAS_PAC_MAGIC) {
            return None;
        }
        let count = read_u32_le(&prefix, NEXAS_COUNT_OFFSET)?;
        let pack_type = read_u32_le(&prefix, NEXAS_PACK_TYPE_OFFSET)?;
        if count == 0 || count > NEXAS_PAC_MAX_ENTRIES || pack_type > NEXAS_PACK_TYPE_MAX {
            return Some(None);
        }
        Some(Some(pack_type))
    }

    fn inspect(game_dir: &Path) -> NexasState {
        let mut nexas_pac = false;
        let mut unknown_pac_magic = false;
        let mut primary_pac_name: Option<String> = None;
        let mut category_hits: Vec<String> = Vec::new();
        let mut pack_types: Vec<u32> = Vec::new();

        if let Ok(entries) = fs::read_dir(game_dir) {
            let mut pac_paths: Vec<std::path::PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("pac"))
                })
                .collect();
            pac_paths.sort();
            for path in pac_paths {
                let stem = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(str::to_ascii_lowercase);
                if let Some(stem) = &stem
                    && NEXAS_CATEGORY_ARCHIVES.contains(&stem.as_str())
                {
                    category_hits.push(stem.clone());
                }
                match Self::nexas_pac_header(&path) {
                    Some(Some(pack_type)) => {
                        nexas_pac = true;
                        if !pack_types.contains(&pack_type) {
                            pack_types.push(pack_type);
                        }
                        if primary_pac_name.is_none() {
                            primary_pac_name = path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .map(str::to_string);
                        }
                    }
                    Some(None) => unknown_pac_magic = true,
                    None => {}
                }
            }
        }
        category_hits.sort();
        category_hits.dedup();
        pack_types.sort_unstable();

        let variant = if nexas_pac {
            NexasVariant::NexasPac
        } else if unknown_pac_magic {
            NexasVariant::UnknownPacOnly
        } else {
            NexasVariant::NotNexas
        };

        NexasState {
            nexas_pac,
            unknown_pac_magic,
            primary_pac_name,
            category_hits,
            pack_types,
            variant,
        }
    }

    fn detected_variant(variant: NexasVariant) -> &'static str {
        match variant {
            NexasVariant::NexasPac => "pac-magic",
            NexasVariant::UnknownPacOnly => "unknown-nexas-signature",
            NexasVariant::NotNexas => "not-nexas",
        }
    }

    fn is_detected(variant: NexasVariant) -> bool {
        matches!(variant, NexasVariant::NexasPac)
    }

    fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, NEXAS_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("nexas")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::ContainerAccess,
            variant,
            "*.pac",
            "NeXAS PAC extraction / decompression is provided by the kaifuu-nexas crate, not this detector",
            "use identify (detect/profile) output only; call the kaifuu-nexas reader for extraction",
        )
    }

    fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: NexasVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("nexas-patch", 12),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(NEXAS_SUPPORT_BOUNDARY),
            failures: vec![
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    "*.pac",
                    "NeXAS patch-back/repack support is not implemented",
                    "add an explicit NeXAS patch-back adapter before writing patched PAC output",
                ),
            ],
        }
    }

    fn profile_from_state(&self, state: NexasState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(state.variant),
                "*.pac",
                "NeXAS detector requires a `PAC\\0`-magic archive with a sane header",
                "run detect against a NeXAS title or select another adapter",
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: NEXAS_PROFILE_ID.to_string(),
            game_id: NEXAS_GAME_ID.to_string(),
            title: "NeXAS title (detector profile)".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: NEXAS_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "nexas".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "nexas-pac-archive".to_string(),
                name: "pacArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: state
                    .primary_pac_name
                    .clone()
                    .unwrap_or_else(|| "*.pac".to_string()),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: vec![],
            layered_access: None,
            capabilities: self.capabilities().reports,
            requirements: state.detection_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }
}

impl EngineAdapter for NexasProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        NEXAS_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu NeXAS engine detector adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some(
                "identify/profile reads only file names and the fixed PAC container header"
                    .to_string(),
            ),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(NEXAS_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            NEXAS_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::unsupported(
                    Capability::AssetListing,
                    "NeXAS PAC entry listing is provided by the kaifuu-nexas crate, not the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetInventory,
                    "NeXAS asset inventory is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "the NeXAS detector does not extract PAC archives (use kaifuu-nexas)",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "the NeXAS detector does not patch or rebuild NeXAS assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "PAC container access is provided by the kaifuu-nexas crate",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "NeXAS archives are unencrypted; no crypto access is claimed by the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "per-entry decompression is provided by the kaifuu-nexas crate",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "NeXAS patch-back/repack support is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/NeXAS work, not this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "NeXAS PAC payloads are compressed, not encrypted",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no NeXAS text surfaces are patched by this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to the detector-only NeXAS profile",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed by the NeXAS detector",
                ),
            ],
            AdapterCapabilityMatrix::identify_only(
                NEXAS_DETECTOR_ADAPTER_ID,
                "NeXAS detector is identify-only; PAC extraction + per-entry decompression are provided by the kaifuu-nexas crate",
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory: unsupported(vec![Capability::AssetListing, Capability::AssetInventory]),
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = state.variant == NexasVariant::UnknownPacOnly;
        let mut result = DetectionResult {
            adapter_id: NEXAS_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "nexas".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: state
                        .primary_pac_name
                        .clone()
                        .unwrap_or_else(|| "*.pac".to_string()),
                    kind: "nexas_pac_magic".to_string(),
                    status: if state.nexas_pac {
                        EvidenceStatus::Matched
                    } else if state.unknown_pac_magic {
                        EvidenceStatus::Invalid
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.nexas_pac {
                        format!(
                            "a .pac opens with the NeXAS \"PAC\\0\" magic (50 41 43 00) and a sane header (pack_types: {})",
                            state
                                .pack_types
                                .iter()
                                .map(u32::to_string)
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    } else if state.unknown_pac_magic {
                        "a .pac opens with the \"PAC\\0\" magic but the count/pack_type header is out of range".to_string()
                    } else {
                        "no .pac with the NeXAS \"PAC\\0\" magic (Softpal \"PAC \" is a different engine)".to_string()
                    },
                },
                DetectionEvidence {
                    path: "*.pac".to_string(),
                    kind: "nexas_category_archives".to_string(),
                    status: if state.category_hits.is_empty() {
                        EvidenceStatus::Missing
                    } else {
                        EvidenceStatus::Matched
                    },
                    detail: if state.category_hits.is_empty() {
                        "no NeXAS category-archive names (Bgm/Face/Script/System/Voice*.pac) present"
                            .to_string()
                    } else {
                        format!(
                            "NeXAS category archives present: {}",
                            state
                                .category_hits
                                .iter()
                                .map(|hit| format!("{hit}.pac"))
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    },
                },
            ],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::AssetListing,
            Self::detected_variant(state.variant),
            "*.pac",
            "NeXAS PAC entry listing is provided by the kaifuu-nexas crate, not the detector",
            "use identify (detect/profile) output only",
        )))
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::AssetInventory,
            Self::detected_variant(state.variant),
            "*.pac",
            "NeXAS asset inventory is outside the detector",
            "use identify (detect/profile) output only",
        )))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            Self::detected_variant(state.variant),
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("nexas-verify", 12),
            status: OperationStatus::Failed,
            output_hash: content_hash(NEXAS_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                "*.pac",
                "runtime/parser verification is outside the NeXAS detector",
                "use detect or profile only",
            )],
        })
    }
}

// Bounded byte-substring search used to recognise Softpal PAC entry names in a
// header/table prefix. `haystack` is at most `SOFTPAL_PAC_TABLE_SCAN_LEN` and
// `needle` is a short entry name, so the naive scan is comfortably bounded.
fn bytes_contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn file_starts_with(path: &Path, expected: &[u8]) -> bool {
    fs::read(path).is_ok_and(|bytes| bytes.starts_with(expected))
}

// Read up to `len` leading bytes of `path` without loading the whole file
// (Scene.pck archives are multi-megabyte; the detector only needs the header).
fn read_file_prefix(path: &Path, len: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(buf)
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

// Shannon entropy (bits/byte) over `bytes`. Used only to distinguish an
// encrypted Siglus Gameexe.dat payload from a plaintext file that happens to
// share the 8-byte prefix; not a cryptographic measure.
fn shannon_entropy_bits(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &byte in bytes {
        counts[byte as usize] += 1;
    }
    let len = bytes.len() as f64;
    let mut entropy = 0.0;
    for &count in &counts {
        if count > 0 {
            let probability = count as f64 / len;
            entropy -= probability * probability.log2();
        }
    }
    entropy
}

// Recognise a REAL (non-synthetic) Siglus `Scene.pck` archive by its plaintext
// header shape: the header-size dword equals the fixed `0x5C`, the second
// dword equals that header size (the first index section starts immediately
// after the header), and the header's `(offset, count)` index-section pairs
// expose a monotonically ascending, in-bounds run of offsets. Identify-level
// only: the archive body is neither parsed nor decrypted here. See the
// `SIGLUS_SCENE_REAL_*` constants for provenance and the false-positive
// analysis in the KAIFUU-091 tests.
fn siglus_scene_pck_real_signature_ok(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let file_len = metadata.len();
    let header_len = u64::from(SIGLUS_SCENE_REAL_HEADER_SIZE);
    // The first index section starts at `header_size`, so a real archive is
    // always strictly longer than its header.
    if file_len <= header_len {
        return false;
    }
    let header_size_usize = SIGLUS_SCENE_REAL_HEADER_SIZE as usize;
    let Some(header) = read_file_prefix(path, header_size_usize) else {
        return false;
    };
    if header.len() < header_size_usize {
        return false;
    }
    let Some(header_size) = read_u32_le(&header, 0) else {
        return false;
    };
    if header_size != SIGLUS_SCENE_REAL_HEADER_SIZE {
        return false;
    }
    let Some(first_offset) = read_u32_le(&header, 4) else {
        return false;
    };
    if first_offset != header_size {
        return false;
    }
    // Header layout: `header_size` dword followed by `(offset, count)` pairs.
    // Walk the offset slots (odd dword indices) and count the leading run that
    // is strictly ascending, at/after the header, and inside the file.
    let dword_count = (header_size / 4) as usize;
    let mut previous_offset = 0u32;
    let mut ascending_offsets = 0usize;
    let mut index = 1usize;
    while index < dword_count {
        let Some(offset) = read_u32_le(&header, index * 4) else {
            break;
        };
        if u64::from(offset) >= file_len
            || offset <= previous_offset
            || u64::from(offset) < header_len
        {
            break;
        }
        previous_offset = offset;
        ascending_offsets += 1;
        index += 2;
    }
    ascending_offsets >= SIGLUS_SCENE_REAL_MIN_ASCENDING_OFFSETS
}

// Recognise a REAL (non-synthetic) Siglus `Gameexe.dat` by its plaintext
// 8-byte prefix (a zero dword followed by the `1` version dword) plus an
// encrypted, high-entropy payload. Identify-level only: the payload is not
// decrypted. The entropy gate keeps a plaintext file that happens to share
// the prefix from false-positiving.
fn siglus_gameexe_dat_real_signature_ok(path: &Path) -> bool {
    let Some(prefix) = read_file_prefix(path, 8 + SIGLUS_GAMEEXE_REAL_ENTROPY_WINDOW) else {
        return false;
    };
    if prefix.len() < 8 + SIGLUS_GAMEEXE_REAL_MIN_BODY_LEN {
        return false;
    }
    let Some(reserved) = read_u32_le(&prefix, 0) else {
        return false;
    };
    let Some(version) = read_u32_le(&prefix, 4) else {
        return false;
    };
    if reserved != 0 || version != SIGLUS_GAMEEXE_REAL_VERSION {
        return false;
    }
    shannon_entropy_bits(&prefix[8..]) >= SIGLUS_GAMEEXE_REAL_MIN_ENTROPY_BITS
}

// KAIFUU-189: normalises a `Path` to a forward-slash string for the
// JSON-serialised `DetectionEvidence.path` field. Detector evidence is
// always reported with `/` separators because the detection report is
// platform-portable.
fn path_to_forward_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

// KAIFUU-189: prepends the resolved REALLIVEDATA/ relative path to a
// top-level marker file name so the evidence row points at the actual
// on-disk location. Falls back to the bare marker name when no nested
// dir was resolved (synthetic-fixture compatibility).
fn nest_evidence_path(resolved_data_dir: Option<&str>, marker: &str) -> String {
    match resolved_data_dir {
        Some(dir) if !dir.is_empty() => format!("{dir}/{marker}"),
        _ => marker.to_string(),
    }
}

fn xp3_inventory_asset_kind(path: &str) -> AssetInventoryAssetKind {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("ks" | "tjs" | "txt") => AssetInventoryAssetKind::Script,
        Some("png" | "jpg" | "jpeg" | "bmp" | "webp") => AssetInventoryAssetKind::Image,
        Some("ogg" | "wav" | "mp3" | "m4a") => AssetInventoryAssetKind::Audio,
        Some("ttf" | "otf") => AssetInventoryAssetKind::Font,
        _ => AssetInventoryAssetKind::Unknown,
    }
}

fn evidence_status(exists: bool, signature_matches: bool) -> EvidenceStatus {
    if signature_matches {
        EvidenceStatus::Matched
    } else if exists {
        EvidenceStatus::Invalid
    } else {
        EvidenceStatus::Missing
    }
}

fn signature_detail(exists: bool, signature_matches: bool, label: &str) -> String {
    match (exists, signature_matches) {
        (_, true) => format!("{label} matched"),
        (true, false) => {
            format!("{label} is present but does not match the synthetic fixture signature")
        }
        (false, false) => format!("{label} is missing"),
    }
}

pub fn registry() -> kaifuu_core::AdapterRegistry {
    let mut registry = kaifuu_core::AdapterRegistry::new();
    registry.register(FixtureAdapter);
    registry.register(Xp3ProfileDetectorAdapter);
    registry.register(SiglusProfileDetectorAdapter);
    registry.register(RealLiveProfileDetectorAdapter);
    registry.register(SoftpalProfileDetectorAdapter);
    registry.register(NexasProfileDetectorAdapter);
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::{
        Capability, GoldenAssertionStatus, GoldenByteEquivalenceMode, GoldenHarnessRequest,
        PatchExport, ProtectedSpanMapping, XP3_PLAIN_MAGIC, read_json, run_round_trip_golden,
        sha256_hash_bytes, stable_json,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    fn repo_root() -> std::path::PathBuf {
        crate::test_manifest_dir().join("../..")
    }

    fn public_fixture_dir() -> std::path::PathBuf {
        repo_root().join("fixtures/hello-game")
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-engine-fixture-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_game(name: &str) -> std::path::PathBuf {
        let dir = temp_dir(name);
        fs::write(
            dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 6,
          "end": 14
        }
      ]
    }
  ]
}
"#,
        )
        .unwrap();
        dir
    }

    fn hello_fixture_dir() -> PathBuf {
        crate::test_manifest_dir().join("../../fixtures/hello-game")
    }

    fn expected_asset_inventory_path() -> PathBuf {
        hello_fixture_dir().join("asset-inventory.expected.json")
    }

    fn patch_export_for(extraction: &ExtractionResult) -> PatchExport {
        let target_text = "Hello, {player}.".to_string();
        PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![kaifuu_core::PatchExportEntry {
                bridge_unit_id: extraction.bridge.units[0].bridge_unit_id.clone(),
                source_unit_key: extraction.bridge.units[0].source_unit_key.clone(),
                source_hash: extraction.bridge.units[0].source_hash.clone(),
                protected_span_mappings: protected_span_mappings_for_target(
                    &target_text,
                    &extraction.bridge.units[0].protected_spans,
                ),
                target_text,
            }],
        }
    }

    fn protected_span_mappings_for_target(
        target_text: &str,
        protected_spans: &[ProtectedSpan],
    ) -> Vec<ProtectedSpanMapping> {
        let mut search_start = 0;
        protected_spans
            .iter()
            .filter(|span| !span.raw.is_empty())
            .map(|span| {
                let relative_start = target_text[search_start..]
                    .find(&span.raw)
                    .unwrap_or_else(|| panic!("target text should contain {:?}", span.raw));
                let target_start = search_start + relative_start;
                let target_end = target_start + span.raw.len();
                search_start = target_end;
                ProtectedSpanMapping::new(&span.raw, target_start as u64, target_end as u64)
                    .with_source_identity(span.span_id.clone(), span.start, span.end)
            })
            .collect()
    }

    #[test]
    fn parses_fixture_markup_into_engine_neutral_spans() {
        let text = "名前は\\N[1]、{player}<color=red><wait=30><ruby=依代|よりしろ><mystery tag>";
        let unit = json!({ "protectedSpans": [] });
        let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

        for span in &spans {
            assert_eq!(
                &text[span.start as usize..span.end as usize],
                span.raw,
                "span should map back to source bytes: {span:?}"
            );
        }

        let placeholder = spans
            .iter()
            .find(|span| span.raw == "{player}")
            .expect("placeholder span");
        assert_eq!(placeholder.kind, "variable_placeholder");
        assert_eq!(placeholder.preserve_mode, "map");
        assert_eq!(placeholder.variable_name.as_deref(), Some("player"));

        let name_variable = spans
            .iter()
            .find(|span| span.raw == "\\N[1]")
            .expect("name variable span");
        assert_eq!(name_variable.kind, "variable_placeholder");
        assert_eq!(name_variable.parsed_name.as_deref(), Some("name_variable"));
        assert_eq!(name_variable.variable_name.as_deref(), Some("name[1]"));

        let color = spans
            .iter()
            .find(|span| span.raw == "<color=red>")
            .expect("color span");
        assert_eq!(color.kind, "control_markup");
        assert_eq!(color.parsed_name.as_deref(), Some("color"));
        assert_eq!(color.arguments.as_deref(), Some(&["red".to_string()][..]));

        let wait = spans
            .iter()
            .find(|span| span.raw == "<wait=30>")
            .expect("wait span");
        assert_eq!(wait.parsed_name.as_deref(), Some("wait"));
        assert_eq!(wait.arguments.as_deref(), Some(&["30".to_string()][..]));

        let ruby = spans
            .iter()
            .find(|span| span.raw == "<ruby=依代|よりしろ>")
            .expect("ruby span");
        assert_eq!(ruby.kind, "ruby_annotation");
        assert_eq!(ruby.annotation_text.as_deref(), Some("よりしろ"));
        assert_eq!(ruby.display_mode.as_deref(), Some("ruby"));

        let unknown = spans
            .iter()
            .find(|span| span.raw == "<mystery tag>")
            .expect("unknown tag span");
        assert_eq!(unknown.kind, "control_markup");
        assert_eq!(unknown.parsed_name.as_deref(), Some("mystery"));
        assert_eq!(unknown.arguments.as_deref(), Some(&["tag".to_string()][..]));
    }

    #[test]
    fn protects_unknown_and_malformed_backslash_markup_conservatively() {
        let text = "未知\\Q[alpha]と\\1[42]と\\#と\\N[broken";
        let unit = json!({ "protectedSpans": [] });
        let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

        for raw in ["\\Q[alpha]", "\\1[42]", "\\#", "\\N[broken"] {
            let span = spans
                .iter()
                .find(|span| span.raw == raw)
                .unwrap_or_else(|| panic!("missing protected span {raw}"));
            assert_eq!(span.kind, "control_markup");
            assert_eq!(
                &text[span.start as usize..span.end as usize],
                span.raw,
                "span should map back to source bytes: {span:?}"
            );
        }

        let symbol_command = spans
            .iter()
            .find(|span| span.raw == "\\1[42]")
            .expect("symbol command span");
        assert_eq!(
            symbol_command.parsed_name.as_deref(),
            Some("unknown_backslash_command")
        );
        assert_eq!(
            symbol_command.arguments.as_deref(),
            Some(&["1".to_string(), "42".to_string()][..])
        );

        let malformed = spans
            .iter()
            .find(|span| span.raw == "\\N[broken")
            .expect("malformed command span");
        assert_eq!(
            malformed.parsed_name.as_deref(),
            Some("unknown_unclosed_backslash_command")
        );
        assert_eq!(malformed.arguments.as_deref(), Some(&["N".to_string()][..]));
    }

    #[test]
    fn explicit_fixture_spans_are_normalized_to_byte_offsets() {
        let text = "こんにちは、{player}。";
        let unit = json!({
            "protectedSpans": [
                {
                    "kind": "placeholder",
                    "raw": "{player}",
                    "start": 6,
                    "end": 14
                }
            ]
        });

        let spans = FixtureAdapter::protected_spans_for_unit(&unit, text).unwrap();

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].kind, "variable_placeholder");
        assert_eq!(spans[0].start, 18);
        assert_eq!(spans[0].end, 26);
        assert_eq!(spans[0].variable_name.as_deref(), Some("player"));
    }

    #[test]
    fn extracts_multi_surface_public_fixture_to_golden_bridge_snapshot() {
        let fixture_dir = public_fixture_dir();
        let extraction = FixtureAdapter
            .extract(ExtractRequest {
                game_dir: &fixture_dir,
            })
            .unwrap();
        let actual = stable_json(&extraction.bridge).unwrap();
        let expected =
            fs::read_to_string(repo_root().join("fixtures/hello-game/expected/bridge-v0.1.json"))
                .unwrap();

        assert_eq!(actual, expected);
        assert_eq!(extraction.bridge.units.len(), 11);

        let surfaces = extraction
            .bridge
            .units
            .iter()
            .map(|unit| unit.text_surface.as_str())
            .collect::<BTreeSet<_>>();
        assert!(surfaces.len() >= 5);
        for required in [
            "dialogue",
            "speaker_name",
            "choice_label",
            "ui_label",
            "tutorial_text",
            "database_entry",
            "image_text",
        ] {
            assert!(surfaces.contains(required), "missing surface {required}");
        }

        let span_kinds = extraction
            .bridge
            .units
            .iter()
            .flat_map(|unit| unit.protected_spans.iter())
            .map(|span| span.kind.as_str())
            .collect::<BTreeSet<_>>();
        assert!(span_kinds.contains("variable_placeholder"));
        assert!(span_kinds.contains("control_markup"));
    }

    #[test]
    fn public_fixture_surface_coverage_matrix_matches_source() {
        let fixture_dir = public_fixture_dir();
        let source: Value =
            serde_json::from_str(&fs::read_to_string(fixture_dir.join("source.json")).unwrap())
                .unwrap();
        let matrix: Value = serde_json::from_str(
            &fs::read_to_string(fixture_dir.join("surface-coverage-v0.2.json")).unwrap(),
        )
        .unwrap();

        let target_locales = source["targetLocales"].as_array().unwrap();
        let locale_branches = source["localeBranches"].as_array().unwrap();
        assert!(target_locales.len() >= 2);
        assert!(locale_branches.len() >= 2);
        assert_eq!(
            matrix["localeBranches"].as_array().unwrap().len(),
            locale_branches.len()
        );

        let mut source_surface_units = BTreeMap::<String, Vec<String>>::new();
        for unit in source["units"].as_array().unwrap() {
            let surface = unit["textSurface"].as_str().unwrap().to_string();
            let key = unit["sourceUnitKey"].as_str().unwrap().to_string();
            source_surface_units.entry(surface).or_default().push(key);
        }

        let mut matrix_surface_units = BTreeMap::<String, Vec<String>>::new();
        for surface in matrix["surfaces"].as_array().unwrap() {
            let surface_kind = surface["surfaceKind"].as_str().unwrap().to_string();
            let unit_keys = surface["unitKeys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap().to_string())
                .collect::<Vec<_>>();
            assert_eq!(
                surface["unitCount"].as_u64().unwrap() as usize,
                unit_keys.len()
            );
            matrix_surface_units.insert(surface_kind, unit_keys);
        }
        assert_eq!(matrix_surface_units, source_surface_units);

        let span_kinds = matrix["protectedSpanCoverage"]
            .as_array()
            .unwrap()
            .iter()
            .map(|span| span["spanKind"].as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert!(span_kinds.contains("variable_placeholder"));
        assert!(span_kinds.contains("control_markup"));

        for bundle in matrix["expectedBridgeBundles"].as_array().unwrap() {
            let path = bundle["path"].as_str().unwrap();
            assert!(
                repo_root().join(path).is_file(),
                "missing expected bundle {path}"
            );
        }
    }

    #[test]
    fn fixture_uses_engine_adapter_trait_for_round_trip() {
        let game_dir = temp_game("round-trip");
        let adapter: &dyn EngineAdapter = &FixtureAdapter;
        let detection = adapter
            .detect(DetectRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        assert!(detection.detected);

        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        assert_eq!(extraction.bridge.units.len(), 1);
        assert_eq!(extraction.profile.engine.adapter_id, FIXTURE_ADAPTER_ID);

        let output_dir = game_dir.join("patched");
        let patch_export = patch_export_for(&extraction);
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(patch.status, OperationStatus::Passed);
        let verify = adapter
            .verify(VerifyRequest {
                game_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(verify.status, OperationStatus::Passed);
        let patched = fs::read_to_string(output_dir.join("source.json")).unwrap();
        assert!(patched.contains("Hello, {player}."));
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn round_trip_golden_harness_reports_fixture_byte_identity_as_unsupported() {
        let game_dir = temp_game("golden-round-trip");
        let work_dir = game_dir.join("golden-work");
        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &game_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: None,
                translated_source_bridge: None,
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Passed);
        assert!(report.failures.is_empty());
        let byte_phase = report
            .phases
            .iter()
            .find(|phase| phase.phase == "byte_equivalence")
            .expect("byte equivalence phase");
        assert_eq!(byte_phase.status, GoldenAssertionStatus::Skipped);
        assert!(
            byte_phase
                .support_boundary
                .as_deref()
                .unwrap_or("")
                .contains("rewrites source.json")
        );
        assert!(report.phases.iter().any(|phase| {
            phase.phase == "unchanged_output_equivalence"
                && phase.status == GoldenAssertionStatus::Passed
        }));

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn round_trip_golden_harness_asserts_assets_via_inventory_and_capability() {
        // KAIFUU-032: the real fixture adapter, driven in adapter-neutral
        // AssertInventory mode. Even though the public fixture happens to ship a
        // source.json, the harness asserts asset preservation + emits
        // capability-aware unsupported-asset diagnostics purely from the adapter's
        // asset inventory + capability reports — the source.json layout is never
        // assumed by the asset-assertion path.
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-inventory-assert");

        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::AssertInventory,
                translated_patch_export: None,
                translated_source_bridge: None,
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Passed);
        assert!(report.failures.is_empty());

        // Adapter-neutral preservation phase passed (no source.json byte compare).
        let preservation = report
            .phases
            .iter()
            .find(|phase| phase.phase == "inventory_asset_preservation")
            .expect("inventory preservation phase");
        assert_eq!(preservation.status, GoldenAssertionStatus::Passed);
        assert!(
            !report
                .phases
                .iter()
                .any(|phase| phase.phase == "byte_equivalence")
        );

        // The fixture's 6 capability-unsupported asset surfaces each produce a
        // typed capability-aware diagnostic keyed on AssetTextPatching.
        let diagnostics: Vec<_> = report
            .phases
            .iter()
            .filter(|phase| phase.phase == "asset_capability_diagnostic")
            .collect();
        assert_eq!(
            diagnostics.len(),
            6,
            "one diagnostic per unsupported surface"
        );
        assert!(diagnostics.iter().all(|phase| {
            phase.status == GoldenAssertionStatus::Skipped
                && phase.required_capability == Some(Capability::AssetTextPatching)
                && phase.asset_ref.as_deref() != Some("source.json")
        }));

        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn round_trip_golden_harness_applies_public_v02_translated_patch() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-v02");
        let patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Passed);
        assert!(report.failures.is_empty());
        for phase_name in [
            "translated_patch_contract",
            "translated_source_compatibility",
            "translated_patch_conversion",
            "translated_patch",
            "translated_target_equivalence",
            "translated_verify",
        ] {
            assert!(
                report.phases.iter().any(|phase| {
                    phase.phase == phase_name && phase.status == GoldenAssertionStatus::Passed
                }),
                "missing passed phase {phase_name}"
            );
        }

        let patched = fs::read_to_string(work_dir.join("translated-patch/source.json")).unwrap();
        assert!(patched.contains("Bonjour, {player}."));
        assert!(patched.contains("La porte du crepuscule"));
        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn public_fixture_round_trip_report_matches_reviewed_golden_artifact() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-report-artifact");
        let patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "byte-identical round-trip is not claimed unless --expect-byte-identical is set for an adapter known to support byte-stable patching"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();
        let actual = report.stable_json().unwrap();
        let expected =
            fs::read_to_string(fixture_dir.join("expected/round-trip-golden-report-v0.1.json"))
                .unwrap();

        assert_eq!(actual, expected);
        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn round_trip_golden_harness_cites_exact_unit_for_translated_patch_failure() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-v02-negative");
        let mut patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["targetText"] = json!("Bonjour.");
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.phase == "translated_source_compatibility"
                && failure.source_unit_key.as_deref() == Some("hello.scene.001.line.001")
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("#hello.scene.001.line.001")
                && failure.code == "translated_protected_span_mapping_mismatch"
        }));
        assert!(!work_dir.join("translated-patch/source.json").exists());
        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn round_trip_golden_harness_rejects_stale_v02_source_hash_before_translation() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-v02-stale");
        let mut patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["sourceHash"] =
            json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
        let source_bridge: Value =
            read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();

        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: Some(&source_bridge),
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Failed);
        let failure = report
            .failures
            .iter()
            .find(|failure| failure.code == "translated_source_hash_mismatch")
            .expect("source hash mismatch failure");
        assert_eq!(
            failure.source_unit_key.as_deref(),
            Some("hello.scene.001.line.001")
        );
        assert!(failure.asset_ref.as_deref().unwrap_or("").contains('#'));
        assert!(
            !report
                .phases
                .iter()
                .any(|phase| phase.phase == "translated_patch")
        );
        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn round_trip_golden_harness_requires_source_bridge_for_v02_source_hash_compatibility() {
        let fixture_dir = public_fixture_dir();
        let work_dir = temp_dir("golden-public-v02-stale-no-bridge");
        let mut patch_export: Value =
            read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
        patch_export["entries"][0]["sourceHash"] =
            json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");

        let report = run_round_trip_golden(
            &registry(),
            GoldenHarnessRequest {
                game_dir: &fixture_dir,
                work_dir: &work_dir,
                adapter_id: Some(FIXTURE_ADAPTER_ID),
                byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                    support_boundary:
                        "fixture adapter rewrites source.json as pretty JSON and writes targetText fields"
                            .to_string(),
                },
                translated_patch_export: Some(&patch_export),
                translated_source_bridge: None,
            },
        )
        .unwrap();

        assert_eq!(report.status, OperationStatus::Failed);
        let failure = report
            .failures
            .iter()
            .find(|failure| failure.code == "translated_source_bridge_required")
            .expect("missing source bridge failure");
        assert_eq!(failure.phase, "translated_source_compatibility");
        assert_eq!(failure.actual.as_deref(), Some("missing source bridge"));
        assert!(!report.phases.iter().any(|phase| {
            phase.phase == "translated_patch_conversion" || phase.phase == "translated_patch"
        }));
        assert!(!work_dir.join("translated-patch/source.json").exists());
        let _ = fs::remove_dir_all(work_dir);
    }

    #[test]
    fn unmatched_patch_source_unit_key_fails_without_full_pass() {
        let game_dir = temp_game("unmatched-key");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        patch_export.entries[0].source_unit_key = "missing.scene.line".to_string();

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "unmatched_source_unit_key"
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("missing.scene.line")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn source_hash_mismatch_fails_without_full_pass() {
        let game_dir = temp_game("stale-hash");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        patch_export.entries[0].source_hash = "stale-source-hash".to_string();

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "source_hash_mismatch"
                && failure.required_capability == Some(Capability::LineParityPatching)
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn missing_protected_span_in_patch_target_fails_without_writing_output() {
        let game_dir = temp_game("missing-protected-span");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        patch_export.entries[0].target_text = "Hello.".to_string();

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_missing"
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("hello.scene.001.line.001")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn empty_protected_span_mappings_do_not_bypass_source_required_spans() {
        let game_dir = temp_game("empty-mappings-missing-protected-span");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        patch_export.entries[0].target_text = "Hello.".to_string();
        patch_export.entries[0].protected_span_mappings.clear();

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_missing"
                && failure
                    .remediation
                    .as_deref()
                    .unwrap_or("")
                    .contains("{player}")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn empty_protected_span_mappings_fail_even_when_target_contains_raw_span() {
        let game_dir = temp_game("empty-mappings-unrepresented-protected-span");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        patch_export.entries[0].protected_span_mappings.clear();

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_missing"
                && failure.support_boundary.contains("protectedSpanMappings")
                && failure
                    .remediation
                    .as_deref()
                    .unwrap_or("")
                    .contains("{player}")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn duplicate_raw_protected_spans_require_distinct_target_mappings() {
        let game_dir = temp_game("duplicate-raw-protected-spans");
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "{name} meets {name}.",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 0,
          "end": 6
        },
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 13,
          "end": 19
        }
      ]
    }
  ]
}
"#,
        )
        .unwrap();
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let unit = &extraction.bridge.units[0];
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 13),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![kaifuu_core::PatchExportEntry {
                bridge_unit_id: unit.bridge_unit_id.clone(),
                source_unit_key: unit.source_unit_key.clone(),
                source_hash: unit.source_hash.clone(),
                target_text: "{name} and {name}.".to_string(),
                protected_span_mappings: vec![
                    ProtectedSpanMapping::new("{name}", 0, 6),
                    ProtectedSpanMapping::new("{name}", 0, 6),
                ],
            }],
        };

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_duplicate_mapping"
                || failure.error_code == "protected_span_missing"
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn duplicate_raw_protected_spans_require_valid_source_identity() {
        let game_dir = temp_game("duplicate-raw-protected-span-identity");
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "{name} meets {name}.",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 0,
          "end": 6
        },
        {
          "kind": "placeholder",
          "raw": "{name}",
          "start": 13,
          "end": 19
        }
      ]
    }
  ]
}
"#,
        )
        .unwrap();
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let unit = &extraction.bridge.units[0];
        let first_span = &unit.protected_spans[0];
        let second_span = &unit.protected_spans[1];
        let patch_entry = |protected_span_mappings| kaifuu_core::PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: "{name} and {name}.".to_string(),
            protected_span_mappings,
        };
        let patch_export = |patch_export_id, protected_span_mappings| PatchExport {
            patch_export_id,
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![patch_entry(protected_span_mappings)],
        };

        let missing_identity = patch_export(
            deterministic_id("patch", 14),
            vec![
                ProtectedSpanMapping::new("{name}", 0, 6),
                ProtectedSpanMapping::new("{name}", 11, 17),
            ],
        );
        let wrong_identity = patch_export(
            deterministic_id("patch", 15),
            vec![
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    first_span.span_id.clone(),
                    first_span.start,
                    first_span.end,
                ),
                ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                    second_span.span_id.clone(),
                    20,
                    26,
                ),
            ],
        );
        let reused_identity = patch_export(
            deterministic_id("patch", 16),
            vec![
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    first_span.span_id.clone(),
                    first_span.start,
                    first_span.end,
                ),
                ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                    first_span.span_id.clone(),
                    first_span.start,
                    first_span.end,
                ),
            ],
        );
        let valid = patch_export(
            deterministic_id("patch", 17),
            vec![
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    second_span.span_id.clone(),
                    second_span.start,
                    second_span.end,
                ),
                ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                    first_span.span_id.clone(),
                    first_span.start,
                    first_span.end,
                ),
            ],
        );

        for (index, patch_export) in [missing_identity, wrong_identity, reused_identity]
            .iter()
            .enumerate()
        {
            let output_dir = game_dir.join(format!("patched-invalid-{index}"));
            let patch = adapter
                .patch(PatchRequest {
                    game_dir: &game_dir,
                    patch_export,
                    output_dir: &output_dir,
                })
                .unwrap();

            assert_eq!(patch.status, OperationStatus::Failed);
            assert!(patch.failures.iter().any(|failure| {
                failure.error_code == "protected_span_mapping_mismatch"
                    || failure.error_code == "protected_span_missing"
            }));
            assert!(!output_dir.join("source.json").exists());
        }

        let output_dir = game_dir.join("patched-valid");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &valid,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Passed, "{patch:?}");
        assert!(output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn empty_protected_span_mappings_fail_for_source_control_markup() {
        let game_dir = temp_game("empty-mappings-control-markup");
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "待って<wait=30>から進む。",
      "protectedSpans": []
    }
  ]
}
"#,
        )
        .unwrap();
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let unit = &extraction.bridge.units[0];
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 12),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![kaifuu_core::PatchExportEntry {
                bridge_unit_id: unit.bridge_unit_id.clone(),
                source_unit_key: unit.source_unit_key.clone(),
                source_hash: unit.source_hash.clone(),
                target_text: "Wait, then continue.".to_string(),
                protected_span_mappings: vec![],
            }],
        };

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_missing"
                && failure
                    .remediation
                    .as_deref()
                    .unwrap_or("")
                    .contains("<wait=30>")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn shared_contract_mappings_missing_from_target_fail_without_writing_output() {
        let game_dir = temp_game("shared-contract-missing-protected-span");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let unit = &extraction.bridge.units[0];
        let patch_export_value = json!({
            "schemaVersion": "0.1.0",
            "patchExportId": deterministic_id("patch", 11),
            "sourceBridgeId": extraction.bridge.bridge_id.clone(),
            "sourceLocale": extraction.bridge.source_locale.clone(),
            "targetLocale": "en-US",
            "entries": [
                {
                    "entryId": deterministic_id("patchentry", 11),
                    "bridgeUnitId": unit.bridge_unit_id.clone(),
                    "sourceUnitKey": unit.source_unit_key.clone(),
                    "sourceHash": unit.source_hash.clone(),
                    "targetText": "Hello.",
                    "protectedSpanMappings": [
                        {
                            "raw": "{player}",
                            "targetStart": 7,
                            "targetEnd": 15
                        }
                    ]
                }
            ]
        });
        assert!(
            patch_export_value["entries"][0]
                .get("protectedSpans")
                .is_none(),
            "regression payload must not use Rust-only protectedSpans"
        );
        let patch_export = PatchExport::from_value(&patch_export_value).unwrap();

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "protected_span_missing"
                && failure
                    .remediation
                    .as_deref()
                    .unwrap_or("")
                    .contains("{player}")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn validation_failure_preserves_existing_output_file() {
        let game_dir = temp_game("failed-preserves-output");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        patch_export.entries[0].source_hash = "stale-source-hash".to_string();

        let output_dir = game_dir.join("patched");
        fs::create_dir_all(&output_dir).unwrap();
        let existing_output = output_dir.join("source.json");
        fs::write(&existing_output, "preexisting output\n").unwrap();

        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert_eq!(
            fs::read_to_string(&existing_output).unwrap(),
            "preexisting output\n"
        );
        let temp_entries = fs::read_dir(&output_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".source.json.tmp-")
            })
            .count();
        assert_eq!(temp_entries, 0);
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn duplicate_patch_source_unit_key_fails_without_writing_output() {
        let game_dir = temp_game("duplicate-key");
        let adapter = FixtureAdapter;
        let extraction = adapter
            .extract(ExtractRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut patch_export = patch_export_for(&extraction);
        let mut duplicate_entry = patch_export.entries[0].clone();
        duplicate_entry.target_text = "Ignored duplicate should fail.".to_string();
        patch_export.entries.push(duplicate_entry);

        let output_dir = game_dir.join("patched");
        let patch = adapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "duplicate_source_unit_key"
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("hello.scene.001.line.001")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn duplicate_source_unit_key_in_source_fails_without_writing_output() {
        let game_dir = temp_game("duplicate-source-key");
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "最初の行。",
      "protectedSpans": []
    },
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "二番目の行。",
      "protectedSpans": []
    }
  ]
}
"#,
        )
        .unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 1),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![kaifuu_core::PatchExportEntry {
                bridge_unit_id: deterministic_id("bridge-unit", 2),
                source_unit_key: "hello.scene.001.line.001".to_string(),
                source_hash: content_hash("二番目の行。"),
                target_text: "Second line.".to_string(),
                protected_span_mappings: vec![],
            }],
        };

        let output_dir = game_dir.join("patched");
        let patch = FixtureAdapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &patch_export,
                output_dir: &output_dir,
            })
            .unwrap();

        assert_eq!(patch.status, OperationStatus::Failed);
        assert!(patch.failures.iter().any(|failure| {
            failure.error_code == "duplicate_source_unit_key_in_source"
                && failure
                    .asset_ref
                    .as_deref()
                    .unwrap_or("")
                    .contains("hello.scene.001.line.001")
        }));
        assert!(!output_dir.join("source.json").exists());
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn fixture_text_surface_parsing_stays_in_fixture_adapter() {
        assert_eq!(
            FixtureAdapter::text_surface_from_fixture_name("speaker_name"),
            TextSurface::SpeakerName
        );
        assert_eq!(
            FixtureAdapter::text_surface_from_fixture_name("image_text"),
            TextSurface::ImageText
        );
        assert_eq!(
            FixtureAdapter::text_surface_from_fixture_name("unknown_fixture_surface"),
            TextSurface::Dialogue
        );
    }

    #[test]
    fn capabilities_report_unsupported_patching_limitations() {
        let capabilities = FixtureAdapter.capabilities();
        assert!(capabilities.key_requirements.is_empty());
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::AssetInventory
                && report.status == kaifuu_core::CapabilityStatus::Supported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::NonTextSurfaceExtraction
                && report.status == kaifuu_core::CapabilityStatus::Limited
                && report
                    .limitation
                    .as_deref()
                    .unwrap_or("")
                    .contains("does not perform OCR")
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::LineParityPatching
                && report.status == kaifuu_core::CapabilityStatus::Limited
                && report
                    .limitation
                    .as_deref()
                    .unwrap_or("")
                    .contains("sourceUnitKey")
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::ContainerAccess
                && report.status == kaifuu_core::CapabilityStatus::Supported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::CryptoAccess
                && report.status == kaifuu_core::CapabilityStatus::Supported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::CodecAccess
                && report.status == kaifuu_core::CapabilityStatus::Supported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::PatchBack
                && report.status == kaifuu_core::CapabilityStatus::Limited
        }));
        assert!(capabilities.access_contract.is_some());
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::AssetTextPatching
                && report.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::DeltaPatching
                && report.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::EncryptedInput
                && report.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::KeyProfile
                && report.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
        assert!(capabilities.reports.iter().any(|report| {
            report.capability == Capability::RuntimeVm
                && report.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
    }

    // KAIFUU-053: detector level-matrix snapshot tests. Each detector must
    // emit a stable typed matrix so consumers can rely on the strict gate.
    #[test]
    fn fixture_adapter_level_matrix_is_stable() {
        use kaifuu_core::{CapabilityLevel, CapabilityLevelStatus};
        let matrix = FixtureAdapter.capabilities().level_matrix;
        assert_eq!(matrix.adapter_id, FIXTURE_ADAPTER_ID);
        assert!(matrix.supports(CapabilityLevel::Identify));
        assert!(matrix.supports(CapabilityLevel::Inventory));
        assert!(matrix.supports(CapabilityLevel::Extract));
        // Patch is Partial — not Supported — per fixture line-parity policy.
        assert!(!matrix.supports(CapabilityLevel::Patch));
        assert!(matrix.patch.is_partial());
        if let CapabilityLevelStatus::Partial { limitations } = &matrix.patch {
            assert!(
                limitations.iter().any(|l| l.contains("source.json")),
                "expected line-parity limitation"
            );
        }
    }

    #[test]
    fn xp3_detector_level_matrix_is_identify_and_inventory_only() {
        use kaifuu_core::CapabilityLevel;
        let matrix = Xp3ProfileDetectorAdapter.capabilities().level_matrix;
        assert_eq!(matrix.adapter_id, XP3_DETECTOR_ADAPTER_ID);
        assert!(matrix.supports(CapabilityLevel::Identify));
        assert!(matrix.supports(CapabilityLevel::Inventory));
        assert!(matrix.extract.is_unsupported());
        assert!(matrix.patch.is_unsupported());
    }

    #[test]
    fn siglus_detector_level_matrix_is_identify_only() {
        use kaifuu_core::CapabilityLevel;
        let matrix = SiglusProfileDetectorAdapter.capabilities().level_matrix;
        assert_eq!(matrix.adapter_id, SIGLUS_DETECTOR_ADAPTER_ID);
        assert!(matrix.supports(CapabilityLevel::Identify));
        // Higher rungs are identify-only — explicit conservative override.
        assert!(matrix.inventory.is_unsupported());
        assert!(matrix.extract.is_unsupported());
        assert!(matrix.patch.is_unsupported());
    }

    #[test]
    fn reallive_detector_level_matrix_extract_partial_patch_unsupported() {
        use kaifuu_core::CapabilityLevel;
        let matrix = RealLiveProfileDetectorAdapter.capabilities().level_matrix;
        assert_eq!(matrix.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
        assert!(matrix.supports(CapabilityLevel::Identify));
        assert!(matrix.supports(CapabilityLevel::Inventory));
        // Extract is Partial per plan: Scene parser covers text only.
        assert!(!matrix.supports(CapabilityLevel::Extract));
        assert!(matrix.extract.is_partial());
        // No full patch path yet at this slice.
        assert!(matrix.patch.is_unsupported());
    }

    #[test]
    fn detectors_level_matrices_do_not_overclaim_against_reports() {
        use kaifuu_core::AdapterCapabilityMatrix;
        for capabilities in [
            FixtureAdapter.capabilities(),
            Xp3ProfileDetectorAdapter.capabilities(),
            SiglusProfileDetectorAdapter.capabilities(),
            RealLiveProfileDetectorAdapter.capabilities(),
            SoftpalProfileDetectorAdapter.capabilities(),
        ] {
            let derived = AdapterCapabilityMatrix::derive_from_reports(
                &capabilities.adapter_id,
                &capabilities.reports,
            );
            assert!(
                capabilities
                    .level_matrix
                    .first_overclaim_against(&derived)
                    .is_none(),
                "{} declared level_matrix overclaims against per-Capability reports",
                capabilities.adapter_id
            );
        }
    }

    // ---- Softpal detector tests ------------------------------------------
    //
    // Synthetic fixtures carry only the fixed Softpal FORMAT signatures (the
    // same magics any Softpal title exposes); no copyrighted content bytes are
    // embedded or committed. The real two-title validation lives behind an
    // env-gated `#[ignore]` integration test (see
    // `tests/live_softpal_detector_test.rs`).

    // Build a synthetic Softpal `.pac`: `PAC ` magic, a sane entry count, then
    // a header/table region naming `SCRIPT.SRC` and `TEXT.DAT` (as the real
    // `data.pac` file table does).
    fn synthetic_softpal_pac(with_scripts: bool) -> Vec<u8> {
        let mut pac = Vec::new();
        pac.extend_from_slice(b"PAC "); // magic 50 41 43 20
        pac.extend_from_slice(&[0u8; 4]); // reserved
        pac.extend_from_slice(&2u32.to_le_bytes()); // entry count @ offset 8
        pac.extend_from_slice(&[0u8; 32]); // header padding
        if with_scripts {
            pac.extend_from_slice(b"SCRIPT.SRC\0\0\0\0\0\0");
            pac.extend_from_slice(&[0u8; 8]);
            pac.extend_from_slice(b"TEXT.DAT\0\0\0\0\0\0\0\0");
            pac.extend_from_slice(&[0u8; 16]);
        } else {
            // Some other, non-Softpal-script entry names.
            pac.extend_from_slice(b"IMAGE00.PNG\0\0\0\0\0");
            pac.extend_from_slice(&[0u8; 16]);
        }
        pac
    }

    fn detect_softpal(dir: &Path) -> DetectionResult {
        SoftpalProfileDetectorAdapter
            .detect(DetectRequest { game_dir: dir })
            .unwrap()
    }

    #[test]
    fn softpal_detects_pal_dll_marker() {
        let dir = temp_dir("softpal-pal-dll");
        fs::create_dir_all(dir.join("dll")).unwrap();
        fs::write(dir.join("dll/Pal.dll"), b"MZ\x90\x00 synthetic pe stub").unwrap();

        let detection = detect_softpal(&dir);
        assert!(detection.detected, "Pal.dll must classify as Softpal");
        assert_eq!(detection.engine_family.as_deref(), Some("softpal"));
        assert_eq!(detection.detected_variant.as_deref(), Some("pal-dll"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn softpal_detects_pac_listing_script_and_text() {
        let dir = temp_dir("softpal-pac-scripts");
        fs::write(dir.join("data.pac"), synthetic_softpal_pac(true)).unwrap();

        let detection = detect_softpal(&dir);
        assert!(detection.detected, "PAC + SCRIPT.SRC/TEXT.DAT must detect");
        assert_eq!(detection.engine_family.as_deref(), Some("softpal"));
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("pac-script-src-text-dat")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn softpal_detects_loose_scripts_across_both_enc_flags() {
        // The two owned titles differ in the TEXT.DAT enc flag: `$` encrypted
        // (v21465) and `_` plaintext (v60663). The detector must recognise both.
        for (name, enc_flag, want_label) in [
            ("softpal-loose-enc", b'$', "encrypted ($)"),
            ("softpal-loose-plain", b'_', "plaintext (_)"),
        ] {
            let dir = temp_dir(name);
            fs::write(dir.join("SCRIPT.SRC"), b"Sv20\x00\x00\x00\x00synthetic").unwrap();
            let mut text_dat = vec![enc_flag];
            text_dat.extend_from_slice(b"TEXT_LIST__");
            text_dat.extend_from_slice(&[0u8; 16]);
            fs::write(dir.join("TEXT.DAT"), &text_dat).unwrap();

            let detection = detect_softpal(&dir);
            assert!(
                detection.detected,
                "{name}: loose Sv20 SCRIPT.SRC + [$_]TEXT_LIST__ TEXT.DAT must detect"
            );
            assert_eq!(detection.engine_family.as_deref(), Some("softpal"));
            assert_eq!(
                detection.detected_variant.as_deref(),
                Some("loose-script-src-text-dat")
            );
            let text_evidence = detection
                .evidence
                .iter()
                .find(|e| e.kind == "softpal_text_dat_magic")
                .expect("text.dat evidence row");
            assert_eq!(text_evidence.status, EvidenceStatus::Matched);
            assert!(
                text_evidence.detail.contains(want_label),
                "{name}: enc flag `{want_label}` must be reported, got {:?}",
                text_evidence.detail
            );
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn softpal_rejects_unrelated_directory() {
        let dir = temp_dir("softpal-negative");
        fs::write(dir.join("readme.txt"), b"not a softpal game").unwrap();
        fs::write(dir.join("config.ini"), b"[settings]\nvolume=100\n").unwrap();

        let detection = detect_softpal(&dir);
        assert!(!detection.detected, "unrelated dir must not detect Softpal");
        assert_eq!(detection.engine_family, None);
        assert_eq!(detection.detected_variant, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn softpal_bare_pac_magic_without_scripts_is_not_detected() {
        // False-positive guard: a `.pac` with the generic `PAC ` magic but no
        // SCRIPT.SRC/TEXT.DAT entries must NOT claim the Softpal engine.
        let dir = temp_dir("softpal-bare-pac");
        fs::write(dir.join("data.pac"), synthetic_softpal_pac(false)).unwrap();

        let detection = detect_softpal(&dir);
        assert!(
            !detection.detected,
            "bare PAC magic without Softpal scripts must not detect"
        );
        assert_eq!(detection.engine_family, None);
        // Diagnostic-only variant is surfaced, but detection stays false.
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("unknown-softpal-signature")
        );
        let pac_evidence = detection
            .evidence
            .iter()
            .find(|e| e.kind == "softpal_pac_script_text_entries")
            .expect("pac evidence row");
        assert_eq!(pac_evidence.status, EvidenceStatus::Invalid);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn softpal_detector_level_matrix_is_identify_only() {
        use kaifuu_core::CapabilityLevel;
        let matrix = SoftpalProfileDetectorAdapter.capabilities().level_matrix;
        assert_eq!(matrix.adapter_id, SOFTPAL_DETECTOR_ADAPTER_ID);
        assert!(matrix.supports(CapabilityLevel::Identify));
        assert!(matrix.inventory.is_unsupported());
        assert!(matrix.extract.is_unsupported());
        assert!(matrix.patch.is_unsupported());
    }

    #[test]
    fn softpal_extract_list_and_inventory_are_unsupported() {
        let dir = temp_dir("softpal-unsupported-ops");
        fs::create_dir_all(dir.join("dll")).unwrap();
        fs::write(dir.join("dll/Pal.dll"), b"MZ synthetic").unwrap();
        let adapter = SoftpalProfileDetectorAdapter;

        assert!(
            adapter.extract(ExtractRequest { game_dir: &dir }).is_err(),
            "extract must be unsupported (no PAC extraction claim)"
        );
        assert!(
            adapter
                .list_assets(AssetListRequest { game_dir: &dir })
                .is_err(),
            "list_assets must be unsupported"
        );
        assert!(
            adapter
                .asset_inventory(AssetInventoryRequest { game_dir: &dir })
                .is_err(),
            "asset_inventory must be unsupported"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn softpal_profile_classifies_engine_softpal() {
        let dir = temp_dir("softpal-profile");
        fs::write(dir.join("data.pac"), synthetic_softpal_pac(true)).unwrap();
        let profile = SoftpalProfileDetectorAdapter
            .profile(ProfileRequest { game_dir: &dir })
            .unwrap();
        assert_eq!(profile.engine.engine_family, "softpal");
        assert_eq!(profile.engine.adapter_id, SOFTPAL_DETECTOR_ADAPTER_ID);
        assert_eq!(profile.engine.detected_variant, "pac-script-src-text-dat");
        assert_eq!(
            profile.metadata.get("engineFamily").map(String::as_str),
            Some("softpal")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn softpal_registered_in_engine_registry() {
        assert!(
            registry().get(SOFTPAL_DETECTOR_ADAPTER_ID).is_some(),
            "Softpal detector must be registered in the shared engine registry"
        );
    }

    fn siglus_fixture_dir(name: &str, scene: Option<&[u8]>, gameexe: Option<&[u8]>) -> PathBuf {
        let dir = temp_dir(name);
        if let Some(scene) = scene {
            fs::write(dir.join(SIGLUS_SCENE_PATH), scene).unwrap();
        }
        if let Some(gameexe) = gameexe {
            fs::write(dir.join(SIGLUS_GAMEEXE_PATH), gameexe).unwrap();
        }
        dir
    }

    // Build a REALISTIC (non-synthetic) Siglus `Scene.pck` bearing the real
    // archive-header signature: `header_size` dword `0x5C`, a second dword
    // equal to the header size, then `ascending_offsets` `(offset, count)`
    // index-section pairs whose offsets ascend and stay in bounds, followed by
    // a body large enough to keep every offset valid. Contains NO copyrighted
    // bytes — only the structural signature shape observed on real titles.
    fn realistic_real_scene_pck(ascending_offsets: usize) -> Vec<u8> {
        let header_size: u32 = 0x5C;
        let dword_count = (header_size / 4) as usize; // 23 dwords in the header
        let mut header = vec![0u32; dword_count];
        header[0] = header_size;
        let mut offset = header_size;
        let mut produced = 0usize;
        let mut idx = 1usize;
        while idx + 1 < dword_count && produced < ascending_offsets {
            header[idx] = offset; // ascending index-section offset
            header[idx + 1] = 7; // arbitrary index-section count
            offset += 0x100;
            produced += 1;
            idx += 2;
        }
        let body_len = offset as usize + 0x100;
        let mut bytes = Vec::with_capacity(body_len);
        for value in &header {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.resize(body_len, 0);
        bytes
    }

    // Build a REALISTIC (non-synthetic) Siglus `Gameexe.dat`: the plaintext
    // 8-byte prefix (zero dword + `1` version dword) then a maximum-entropy
    // body standing in for the encrypted payload (every byte value 0..=255
    // appears equally → 8.0 bits/byte). No copyrighted bytes.
    fn realistic_real_gameexe_dat() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        for i in 0..4096usize {
            bytes.push((i % 256) as u8);
        }
        bytes
    }

    fn adapter_failure_from_error(error: Box<dyn std::error::Error>) -> AdapterFailure {
        serde_json::from_str(&error.to_string()).unwrap()
    }

    fn xp3_fixture_dir(name: &str, archive: &[u8]) -> PathBuf {
        let dir = temp_dir(name);
        fs::write(dir.join(XP3_ARCHIVE_PATH), archive).unwrap();
        dir
    }

    #[derive(Clone, Copy)]
    struct Xp3TestEntry<'a> {
        path: &'a str,
        payload: &'a [u8],
        compressed: bool,
        adler32: u32,
    }

    fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(XP3_PLAIN_MAGIC);
        bytes.extend_from_slice(&0_u64.to_le_bytes());

        let mut segment_offsets = Vec::new();
        for entry in entries {
            segment_offsets.push(bytes.len() as u64);
            bytes.extend_from_slice(entry.payload);
        }

        let index_offset = bytes.len() as u64;
        let mut index = Vec::new();
        for (entry, offset) in entries.iter().zip(segment_offsets) {
            let mut file = Vec::new();
            let path_units = entry.path.encode_utf16().collect::<Vec<_>>();
            let mut info = Vec::new();
            info.extend_from_slice(&0_u32.to_le_bytes());
            info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            info.extend_from_slice(&(path_units.len() as u16).to_le_bytes());
            for unit in path_units {
                info.extend_from_slice(&unit.to_le_bytes());
            }
            append_xp3_chunk(&mut file, b"info", &info);

            let mut segment = Vec::new();
            segment.extend_from_slice(&(u32::from(entry.compressed)).to_le_bytes());
            segment.extend_from_slice(&offset.to_le_bytes());
            segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
            append_xp3_chunk(&mut file, b"segm", &segment);
            append_xp3_chunk(&mut file, b"adlr", &entry.adler32.to_le_bytes());
            append_xp3_chunk(&mut index, b"File", &file);
        }

        bytes.push(0);
        bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&index);
        bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
            .copy_from_slice(&index_offset.to_le_bytes());
        bytes
    }

    fn append_xp3_chunk(output: &mut Vec<u8>, name: &[u8; 4], content: &[u8]) {
        output.extend_from_slice(name);
        output.extend_from_slice(&(content.len() as u64).to_le_bytes());
        output.extend_from_slice(content);
    }

    #[test]
    fn xp3_profile_records_cover_plain_encrypted_compressed_and_unknown_cases() {
        let cases: &[(&str, &[u8], &str)] = &[
            (
                "xp3-plain",
                b"XP3\r\nfixture-only plain archive",
                "xp3-plain-container",
            ),
            (
                "xp3-encrypted",
                b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
                "xp3-encrypted-container",
            ),
            (
                "xp3-compressed",
                b"XP3\r\nXP3-COMPRESSED\nfixture-only compressed archive",
                "xp3-compressed-container",
            ),
        ];
        let adapter = Xp3ProfileDetectorAdapter;

        for (name, bytes, variant) in cases {
            let game_dir = xp3_fixture_dir(name, bytes);
            let detection = adapter
                .detect(DetectRequest {
                    game_dir: &game_dir,
                })
                .unwrap();
            assert!(detection.detected, "{variant} should be detected");
            assert_eq!(detection.engine_family.as_deref(), Some("kiri_kiri_xp3"));
            assert_eq!(detection.detected_variant.as_deref(), Some(*variant));

            let profile = adapter
                .profile(ProfileRequest {
                    game_dir: &game_dir,
                })
                .unwrap();
            assert_eq!(profile.engine.adapter_id, XP3_DETECTOR_ADAPTER_ID);
            assert_eq!(profile.engine.detected_variant, *variant);
            let validation = profile.validate();
            assert_eq!(
                validation.status,
                OperationStatus::Passed,
                "{:?}",
                validation.failures
            );
            assert!(profile.archive_parameters.iter().any(|parameter| {
                parameter.kind == ArchiveParameterKind::ArchiveFormat && parameter.value == "xp3"
            }));
            assert!(profile.capabilities.iter().any(|capability| {
                capability.capability == Capability::Extraction
                    && capability.status == CapabilityStatus::Unsupported
            }));
            assert!(
                profile
                    .metadata
                    .get("supportBoundary")
                    .unwrap()
                    .contains("not claimed")
            );
            if *variant == "xp3-encrypted-container" {
                assert!(detection.requirements.iter().any(|requirement| {
                    requirement.key == "kirikiri-xp3-key-profile"
                        && requirement.status == RequirementStatus::Missing
                }));
                assert_eq!(profile.key_requirements.len(), 1);
                assert!(profile.requirements.iter().any(|requirement| {
                    requirement.key == "kirikiri-xp3-key-profile"
                        && requirement.status == RequirementStatus::NotRequired
                }));
            } else {
                assert!(profile.key_requirements.is_empty());
            }
            if *variant == "xp3-compressed-container" {
                assert!(
                    profile
                        .archive_parameters
                        .iter()
                        .any(|parameter| { parameter.kind == ArchiveParameterKind::Compression })
                );
            }

            let _ = fs::remove_dir_all(game_dir);
        }

        let unknown_dir = xp3_fixture_dir(
            "xp3-unknown",
            b"XP3\r\nXP3-UNKNOWN-VARIANT\nfixture-only unknown archive",
        );
        let unknown_detection = adapter
            .detect(DetectRequest {
                game_dir: &unknown_dir,
            })
            .unwrap();
        assert!(!unknown_detection.detected);
        assert_eq!(
            unknown_detection.detected_variant.as_deref(),
            Some("xp3-unknown-container")
        );
        assert!(unknown_detection.requirements.iter().any(|requirement| {
            requirement.key == "xp3-synthetic-profile-marker"
                && requirement.status == RequirementStatus::Unsupported
        }));
        let unknown_failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest {
                    game_dir: &unknown_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(unknown_failure.error_code, "kaifuu.unknown_engine_variant");
        assert_eq!(
            unknown_failure.required_capability,
            Some(Capability::Detection)
        );

        let _ = fs::remove_dir_all(unknown_dir);
    }

    #[test]
    fn xp3_plain_inventory_reports_file_entries_sizes_hashes_and_profile_id() {
        let game_dir = xp3_fixture_dir(
            "xp3-plain-inventory",
            &plain_xp3_fixture(&[
                Xp3TestEntry {
                    path: "scenario/intro.ks",
                    payload: b"hello xp3",
                    compressed: false,
                    adler32: 0x1111_2222,
                },
                Xp3TestEntry {
                    path: "scenario/compressed.ks",
                    payload: b"compressed payload bytes",
                    compressed: true,
                    adler32: 0x3333_4444,
                },
            ]),
        );

        let inventory = Xp3ProfileDetectorAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();

        assert_eq!(inventory.validate().status, OperationStatus::Passed);
        assert_eq!(inventory.assets.len(), 3);
        assert_eq!(inventory.assets[0].asset_key, XP3_ARCHIVE_PATH);
        assert_eq!(
            inventory.assets[0]
                .metadata
                .get("profileId")
                .map(String::as_str),
            Some("019ed000-0000-7000-8000-000000095001")
        );
        let compressed = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/compressed.ks")
            .unwrap();
        assert_eq!(compressed.asset_kind, AssetInventoryAssetKind::Script);
        let compressed_hash = sha256_hash_bytes(b"compressed payload bytes");
        assert_eq!(
            compressed.source_hash.as_deref(),
            Some(compressed_hash.as_str())
        );
        assert_eq!(
            compressed.metadata.get("originalSize").map(String::as_str),
            Some("24")
        );
        assert_eq!(
            compressed.metadata.get("archiveSize").map(String::as_str),
            Some("24")
        );
        assert_eq!(
            compressed.metadata.get("compressed").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            compressed.metadata.get("storedAdler32").map(String::as_str),
            Some("adler32:33334444")
        );

        let plain = inventory
            .assets
            .iter()
            .find(|asset| asset.asset_key == "scenario/intro.ks")
            .unwrap();
        assert_eq!(
            plain.metadata.get("compressed").map(String::as_str),
            Some("false")
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn xp3_plain_profile_marker_detection_ignores_member_payload_substrings() {
        let game_dir = xp3_fixture_dir(
            "xp3-plain-payload-marker",
            &plain_xp3_fixture(&[Xp3TestEntry {
                path: "scenario/intro.ks",
                payload: b"dialogue mentions XP3-CRYPT as literal text",
                compressed: false,
                adler32: 0,
            }]),
        );

        let detection = Xp3ProfileDetectorAdapter
            .detect(DetectRequest {
                game_dir: &game_dir,
            })
            .unwrap();

        assert!(detection.detected);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("xp3-plain-container")
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn xp3_encrypted_and_helper_required_inventory_stop_with_diagnostics() {
        let encrypted_dir = xp3_fixture_dir(
            "xp3-encrypted-inventory",
            b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive",
        );
        let encrypted_failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &encrypted_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(
            encrypted_failure.error_code,
            "kaifuu.missing_capability.crypto"
        );

        let helper_dir = xp3_fixture_dir(
            "xp3-helper-required-inventory",
            b"XP3\r\nXP3-HELPER-REQUIRED\nfixture-only helper archive",
        );
        let helper_failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &helper_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(helper_failure.error_code, "kaifuu.helper_required");

        let _ = fs::remove_dir_all(encrypted_dir);
        let _ = fs::remove_dir_all(helper_dir);
    }

    #[test]
    fn xp3_extract_returns_serialized_semantic_boundary_failure() {
        let game_dir = xp3_fixture_dir(
            "xp3-extract-boundary",
            b"XP3\r\nXP3-COMPRESSED\nfixture-only compressed archive",
        );
        let failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &game_dir,
                })
                .unwrap_err(),
        );

        assert_eq!(failure.error_code, "kaifuu.missing_capability.container");
        assert_eq!(
            failure.required_capability,
            Some(Capability::ContainerAccess)
        );
        assert_eq!(failure.asset_ref.as_deref(), Some(XP3_ARCHIVE_PATH));
        assert!(!failure.support_boundary.is_empty());

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn xp3_extract_and_patch_wording_distinguishes_index_parsing_from_payload_extraction() {
        // Regression (KAIFUU-162): plain XP3 inventory now parses the index /
        // entry metadata, so the extract + patch boundary failures must NOT
        // imply archive entry parsing is entirely absent. They must say the
        // metadata IS parsed, while extraction / decompression / decryption of
        // the payload is what is out of scope for this detector profile.
        let game_dir = xp3_fixture_dir(
            "xp3-boundary-wording",
            &plain_xp3_fixture(&[Xp3TestEntry {
                path: "scenario/intro.ks",
                payload: b"hello xp3",
                compressed: false,
                adler32: 0x1111_2222,
            }]),
        );

        // --- extract: the container-boundary failure carries the new wording. ---
        let extract_failure = adapter_failure_from_error(
            Xp3ProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &game_dir,
                })
                .unwrap_err(),
        );
        let boundary = extract_failure.support_boundary.clone();
        // The stale claim ("entry parsing is entirely absent") is gone.
        assert!(
            !boundary.contains("archive entry parsing is outside"),
            "stale entry-parsing-absent wording still present: {boundary}"
        );
        // Metadata parsing is acknowledged as done...
        assert!(
            boundary.contains("metadata is parsed for inventory"),
            "boundary must acknowledge index/entry metadata parsing: {boundary}"
        );
        // ...while payload extraction / decompression / decryption is the limit.
        for out_of_scope in ["extraction", "decompression", "decryption"] {
            assert!(
                boundary.contains(out_of_scope),
                "boundary must name {out_of_scope} as out of scope: {boundary}"
            );
        }

        // --- patch: same container-boundary distinction + a separate
        //     patch-back (rebuild) failure. ---
        let output_dir = game_dir.join("patched");
        let patch = Xp3ProfileDetectorAdapter
            .patch(PatchRequest {
                game_dir: &game_dir,
                patch_export: &PatchExport {
                    patch_export_id: deterministic_id("xp3-boundary-patch", 95),
                    source_locale: "ja-JP".to_string(),
                    target_locale: "en-US".to_string(),
                    entries: vec![],
                },
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(patch.status, OperationStatus::Failed);
        // The container-boundary failure carries the metadata-parsed / payload-out
        // distinction, never the stale "entry parsing is outside" claim.
        assert!(
            patch.failures.iter().any(|failure| {
                failure
                    .support_boundary
                    .contains("metadata is parsed for inventory")
                    && failure.support_boundary.contains("extraction")
                    && !failure
                        .support_boundary
                        .contains("archive entry parsing is outside")
            }),
            "patch container-boundary wording not updated: {:?}",
            patch.failures
        );
        // Patch-back / repack (rebuild) is separately reported as unimplemented.
        assert!(
            patch.failures.iter().any(|failure| failure
                .support_boundary
                .contains("patch-back/repack support is not implemented")),
            "patch must still report rebuild support out of scope: {:?}",
            patch.failures
        );

        // --- inventory support-boundary snapshot: distinguishes index parsing
        //     from payload extraction / decompression / decryption. ---
        let contract = Xp3ProfileDetectorAdapter
            .capabilities()
            .access_contract
            .expect("XP3 adapter declares a layered access contract");
        let inventory_boundary = contract
            .inventory
            .support_boundary
            .expect("plain XP3 inventory declares a support boundary");
        assert!(
            inventory_boundary.contains("index metadata"),
            "inventory boundary must acknowledge index metadata parsing: {inventory_boundary}"
        );
        assert!(
            inventory_boundary.contains("extraction")
                && inventory_boundary.contains("decompression")
                && inventory_boundary.contains("decryption")
                && inventory_boundary.contains("patch-back are unsupported"),
            "inventory boundary must name payload extraction as out of scope: {inventory_boundary}"
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn siglus_only_complete_synthetic_pair_is_profileable_and_inventoryable() {
        let complete_dir = siglus_fixture_dir(
            "siglus-complete-pair",
            Some(SIGLUS_SCENE_MAGIC),
            Some(SIGLUS_GAMEEXE_MAGIC),
        );
        let missing_pair_dir =
            siglus_fixture_dir("siglus-missing-pair", Some(SIGLUS_SCENE_MAGIC), None);
        let unknown_dir = siglus_fixture_dir(
            "siglus-unknown-named-pair",
            Some(b"unknown scene bytes"),
            Some(b"unknown gameexe bytes"),
        );
        let adapter = SiglusProfileDetectorAdapter;

        let complete_detection = adapter
            .detect(DetectRequest {
                game_dir: &complete_dir,
            })
            .unwrap();
        assert!(complete_detection.detected);
        assert_eq!(
            complete_detection.detected_variant.as_deref(),
            Some("scene-pck-gameexe-dat-synthetic")
        );
        assert!(
            adapter
                .profile(ProfileRequest {
                    game_dir: &complete_dir
                })
                .is_ok()
        );
        assert!(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &complete_dir
                })
                .is_ok()
        );

        let missing_detection = adapter
            .detect(DetectRequest {
                game_dir: &missing_pair_dir,
            })
            .unwrap();
        assert!(!missing_detection.detected);
        assert_eq!(
            missing_detection.detected_variant.as_deref(),
            Some("scene-pck-missing-gameexe-dat")
        );
        assert!(missing_detection.requirements.iter().any(|requirement| {
            requirement.key == SIGLUS_GAMEEXE_PATH
                && requirement.status == RequirementStatus::Missing
        }));
        let missing_failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest {
                    game_dir: &missing_pair_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(
            missing_failure.error_code,
            "kaifuu.missing_capability.container"
        );
        assert_eq!(
            missing_failure.required_capability,
            Some(Capability::AssetListing)
        );
        assert_eq!(
            missing_failure.detected_variant.as_deref(),
            Some("scene-pck-missing-gameexe-dat")
        );
        assert!(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &missing_pair_dir
                })
                .is_err()
        );

        let unknown_detection = adapter
            .detect(DetectRequest {
                game_dir: &unknown_dir,
            })
            .unwrap();
        assert!(!unknown_detection.detected);
        assert_eq!(
            unknown_detection.detected_variant.as_deref(),
            Some("unknown-siglus-named-files")
        );
        assert!(unknown_detection.requirements.iter().any(|requirement| {
            requirement.key == "siglus-synthetic-signature"
                && requirement.status == RequirementStatus::Unsupported
        }));
        let unknown_failure = adapter_failure_from_error(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &unknown_dir,
                })
                .unwrap_err(),
        );
        assert_eq!(unknown_failure.error_code, "kaifuu.unknown_engine_variant");
        assert_eq!(
            unknown_failure.required_capability,
            Some(Capability::Detection)
        );
        assert_eq!(
            unknown_failure.detected_variant.as_deref(),
            Some("unknown-siglus-named-files")
        );

        let _ = fs::remove_dir_all(complete_dir);
        let _ = fs::remove_dir_all(missing_pair_dir);
        let _ = fs::remove_dir_all(unknown_dir);
    }

    #[test]
    fn siglus_detects_real_signature_pair_at_identify_level() {
        let real_dir = siglus_fixture_dir(
            "siglus-real-signature-pair",
            Some(&realistic_real_scene_pck(10)),
            Some(&realistic_real_gameexe_dat()),
        );
        let adapter = SiglusProfileDetectorAdapter;

        let detection = adapter
            .detect(DetectRequest {
                game_dir: &real_dir,
            })
            .unwrap();
        assert!(
            detection.detected,
            "real Scene.pck + Gameexe.dat signatures must be detected"
        );
        assert_eq!(detection.engine_family.as_deref(), Some("siglus"));
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("scene-pck-gameexe-dat-real")
        );
        // Evidence reports the REAL signature class honestly, not synthetic.
        let scene_evidence = detection
            .evidence
            .iter()
            .find(|row| row.path == SIGLUS_SCENE_PATH)
            .expect("Scene.pck evidence row");
        assert_eq!(scene_evidence.kind, "real_siglus_scene_pck_signature");
        assert_eq!(scene_evidence.status, EvidenceStatus::Matched);
        let gameexe_evidence = detection
            .evidence
            .iter()
            .find(|row| row.path == SIGLUS_GAMEEXE_PATH)
            .expect("Gameexe.dat evidence row");
        assert_eq!(gameexe_evidence.kind, "real_siglus_gameexe_dat_signature");
        assert_eq!(gameexe_evidence.status, EvidenceStatus::Matched);

        // Profile + inventory succeed at identify level and report honestly.
        let profile = adapter
            .profile(ProfileRequest {
                game_dir: &real_dir,
            })
            .unwrap();
        assert_eq!(
            profile.engine.detected_variant,
            "scene-pck-gameexe-dat-real"
        );
        assert_eq!(profile.game_id, "kaifuu-siglus-real-scene-pck");
        assert_eq!(profile.title, "Siglus title (detector profile)");
        assert_eq!(
            profile.metadata.get("fixtureOnly").map(String::as_str),
            Some("false")
        );
        assert!(
            adapter
                .asset_inventory(AssetInventoryRequest {
                    game_dir: &real_dir
                })
                .is_ok()
        );

        // Stays identify/inventory-level: extraction and patching still fail
        // with the documented boundary (no overclaim of decrypt/repack).
        assert!(
            adapter
                .extract(ExtractRequest {
                    game_dir: &real_dir
                })
                .is_err(),
            "detector must not claim extraction on real bytes"
        );

        let _ = fs::remove_dir_all(real_dir);
    }

    #[test]
    fn siglus_synthetic_pair_still_detected_after_real_signature_support() {
        // Regression guard: adding real-signature recognition must not drop
        // the synthetic-fixture path (no-legacy-compat: both work).
        let synthetic_dir = siglus_fixture_dir(
            "siglus-synthetic-still-detected",
            Some(SIGLUS_SCENE_MAGIC),
            Some(SIGLUS_GAMEEXE_MAGIC),
        );
        let adapter = SiglusProfileDetectorAdapter;
        let detection = adapter
            .detect(DetectRequest {
                game_dir: &synthetic_dir,
            })
            .unwrap();
        assert!(detection.detected);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("scene-pck-gameexe-dat-synthetic")
        );
        let scene_evidence = detection
            .evidence
            .iter()
            .find(|row| row.path == SIGLUS_SCENE_PATH)
            .expect("Scene.pck evidence row");
        assert_eq!(scene_evidence.kind, "synthetic_siglus_scene_pck_signature");
        let profile = adapter
            .profile(ProfileRequest {
                game_dir: &synthetic_dir,
            })
            .unwrap();
        assert_eq!(
            profile.metadata.get("fixtureOnly").map(String::as_str),
            Some("true")
        );
        assert_eq!(profile.game_id, "kaifuu-siglus-synthetic-scene-pck");
        let _ = fs::remove_dir_all(synthetic_dir);
    }

    #[test]
    fn siglus_real_signature_does_not_false_positive() {
        let adapter = SiglusProfileDetectorAdapter;

        // A Scene.pck opening with the 0x5C header but only a short (<8)
        // ascending offset run is NOT recognized as a real archive.
        let weak_scene = siglus_fixture_dir(
            "siglus-weak-ascending-offsets",
            Some(&realistic_real_scene_pck(3)),
            Some(&realistic_real_gameexe_dat()),
        );
        let weak_detection = adapter
            .detect(DetectRequest {
                game_dir: &weak_scene,
            })
            .unwrap();
        assert!(
            !weak_detection.detected,
            "0x5C header with a short offset run must not be recognized"
        );

        // An unrelated file that merely opens with `5c 00 00 00` then
        // non-ascending garbage is rejected.
        let mut noisy = vec![0x5Cu8, 0x00, 0x00, 0x00];
        noisy.extend_from_slice(&[0xFF; 0x60]);
        let noisy_scene = siglus_fixture_dir(
            "siglus-noisy-0x5c-prefix",
            Some(&noisy),
            Some(&realistic_real_gameexe_dat()),
        );
        assert!(
            !adapter
                .detect(DetectRequest {
                    game_dir: &noisy_scene,
                })
                .unwrap()
                .detected
        );

        // A Gameexe.dat with the correct 8-byte prefix but a low-entropy
        // (all-zero) body is rejected by the entropy gate.
        let mut low_entropy_gameexe = Vec::new();
        low_entropy_gameexe.extend_from_slice(&0u32.to_le_bytes());
        low_entropy_gameexe.extend_from_slice(&1u32.to_le_bytes());
        low_entropy_gameexe.resize(8 + 4096, 0);
        let low_entropy_dir = siglus_fixture_dir(
            "siglus-low-entropy-gameexe",
            Some(&realistic_real_scene_pck(10)),
            Some(&low_entropy_gameexe),
        );
        let low_detection = adapter
            .detect(DetectRequest {
                game_dir: &low_entropy_dir,
            })
            .unwrap();
        assert!(
            !low_detection.detected,
            "low-entropy Gameexe.dat body must not be recognized as encrypted"
        );

        // A plain text pair is not Siglus at all.
        let text_dir = siglus_fixture_dir(
            "siglus-plain-text",
            Some(b"just some plain text that is not a Siglus archive at all"),
            Some(b"another plain text file"),
        );
        let text_detection = adapter
            .detect(DetectRequest {
                game_dir: &text_dir,
            })
            .unwrap();
        assert!(!text_detection.detected);
        assert_eq!(
            text_detection.detected_variant.as_deref(),
            Some("unknown-siglus-named-files")
        );

        let _ = fs::remove_dir_all(weak_scene);
        let _ = fs::remove_dir_all(noisy_scene);
        let _ = fs::remove_dir_all(low_entropy_dir);
        let _ = fs::remove_dir_all(text_dir);
    }

    // Real-corpus validation (≥2 titles). Ignored by default because it needs
    // owned, uncommitted Siglus game trees; point `KAIFUU_SIGLUS_REAL_DIRS` at
    // a `:`-separated list of directories each holding a real `Scene.pck` +
    // `Gameexe.dat` (e.g. materialized Karetoshi + Gamekoi) and run with
    // `--ignored`. Reads only the header signature; commits no game bytes.
    #[test]
    #[ignore = "requires owned Siglus corpus via KAIFUU_SIGLUS_REAL_DIRS"]
    fn siglus_detects_real_corpus_titles() {
        let Ok(dirs) = std::env::var("KAIFUU_SIGLUS_REAL_DIRS") else {
            panic!("set KAIFUU_SIGLUS_REAL_DIRS to a :-separated list of Siglus game dirs");
        };
        let adapter = SiglusProfileDetectorAdapter;
        let mut recognized = 0usize;
        for dir in dirs.split(':').filter(|d| !d.is_empty()) {
            let game_dir = PathBuf::from(dir);
            let detection = adapter
                .detect(DetectRequest {
                    game_dir: &game_dir,
                })
                .unwrap();
            eprintln!(
                "[siglus-real-corpus] {dir} detected={} variant={:?}",
                detection.detected, detection.detected_variant
            );
            assert!(
                detection.detected,
                "real Siglus title must be detected: {dir}"
            );
            assert_eq!(
                detection.detected_variant.as_deref(),
                Some("scene-pck-gameexe-dat-real"),
                "real Siglus title must report the real variant: {dir}"
            );
            recognized += 1;
        }
        assert!(
            recognized >= 2,
            "expected >=2 real Siglus titles, recognized {recognized}"
        );
    }

    #[test]
    fn siglus_extract_returns_serialized_semantic_boundary_failure() {
        let game_dir = siglus_fixture_dir(
            "siglus-extract-boundary",
            Some(SIGLUS_SCENE_MAGIC),
            Some(SIGLUS_GAMEEXE_MAGIC),
        );
        let failure = adapter_failure_from_error(
            SiglusProfileDetectorAdapter
                .extract(ExtractRequest {
                    game_dir: &game_dir,
                })
                .unwrap_err(),
        );

        assert_eq!(failure.error_code, "kaifuu.unsupported_layered_transform");
        assert_eq!(failure.required_capability, Some(Capability::CodecAccess));
        assert_eq!(failure.asset_ref.as_deref(), Some(SIGLUS_SCENE_PATH));
        assert!(failure.support_boundary.contains("parsing/decompilation"));
        assert!(
            failure
                .remediation
                .as_deref()
                .unwrap_or("")
                .contains("do not request extract")
        );

        let _ = fs::remove_dir_all(game_dir);
    }

    // -----------------------------------------------------------------
    // RealLive detector tests (KAIFUU-172).
    //
    // Synthetic fixtures only; no rlvm code is read or linked. The
    // `reallive_fixture_dir` helper writes top-level RealLive marker files
    // into a fresh temp dir per test. Real-game evidence flows in at
    // ALPHA-006.
    // -----------------------------------------------------------------

    fn synthetic_seen_txt(scene_count: u32) -> Vec<u8> {
        // Concrete public-CI envelope shape: magic + LE count + 8-byte
        // synthetic table-of-contents entry per scene. Derived from
        // Haeleth's RLDEV public format documentation; no rlvm structure
        // is copied.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(REALLIVE_SEEN_TXT_MAGIC);
        bytes.extend_from_slice(&scene_count.to_le_bytes());
        for index in 0..scene_count {
            bytes.extend_from_slice(&(index as u64).to_le_bytes());
        }
        bytes.extend_from_slice(b"synthetic-scene-payload");
        bytes
    }

    fn synthetic_gameexe_ini() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(REALLIVE_GAMEEXE_INI_MAGIC);
        bytes.extend_from_slice(
            b"\n#GAMEEXE_VERSION=1.0\n#REGNAME=KaifuuFixture\\RealLive\n#G00BUF=8\n#KOEPAC=koe.ovk\n",
        );
        bytes
    }

    fn reallive_fixture_dir(name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let dir = temp_dir(name);
        for (rel_path, bytes) in files {
            let path = dir.join(rel_path);
            fs::write(&path, bytes).unwrap();
        }
        dir
    }

    #[test]
    fn detects_reallive_on_complete_synthetic_triple_fixture() {
        let dir = reallive_fixture_dir(
            "reallive-complete-synthetic-triple",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(2)),
                (REALLIVE_SEEN_GAN_PATH, REALLIVE_SEEN_GAN_MAGIC),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
                ("image.g00", b"\0"),
                ("voice.ovk", b"\0"),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
        assert!(detection.detected);
        assert_eq!(detection.engine_family.as_deref(), Some("reallive"));
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("reallive-synthetic-triple")
        );
        let profile = adapter.profile(ProfileRequest { game_dir: &dir }).unwrap();
        assert_eq!(profile.engine.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
        assert_eq!(profile.engine.engine_family, "reallive");
        assert_eq!(profile.profile_id, REALLIVE_PROFILE_ID);
        let inventory = adapter
            .asset_inventory(AssetInventoryRequest { game_dir: &dir })
            .unwrap();
        assert!(
            inventory
                .assets
                .iter()
                .any(|asset| asset.asset_key == REALLIVE_SEEN_TXT_PATH),
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detects_reallive_on_positive_live_layout_with_gameexe_ini_key_hits() {
        // Generic envelope: no synthetic SEEN.TXT magic; just the real
        // 10,000-slot fixed-offset-table shape (KAIFUU-188) with one
        // populated slot at slot 1. Gameexe.ini has #GAMEEXE_VERSION
        // present without the synthetic-magic prefix. Mirrors what a real
        // RealLive title looks like at the SEEN.TXT + Gameexe.ini layer.
        let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
        let payload_offset = directory_byte_len as u32;
        let payload: &[u8] = b"generic-shape-payload";
        let mut seen_bytes = vec![0u8; directory_byte_len + payload.len()];
        let slot1 = 8usize;
        seen_bytes[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
        seen_bytes[slot1 + 4..slot1 + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        seen_bytes[directory_byte_len..].copy_from_slice(payload);
        let dir = reallive_fixture_dir(
            "reallive-positive-live-layout",
            &[
                (REALLIVE_SEEN_TXT_PATH, &seen_bytes),
                (
                    REALLIVE_GAMEEXE_INI_PATH,
                    b"#GAMEEXE_VERSION=1.0\n#G00BUF=8\n",
                ),
                ("image.g00", b"\0"),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
        assert!(detection.detected, "{detection:#?}");
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("reallive-positive-live-layout")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn detects_reallive_when_seen_txt_lives_under_nested_reallivedata_subdir() {
        // KAIFUU-189 regression: when SEEN.TXT / Gameexe.ini live under
        // a REALLIVEDATA/ subdirectory at depth 2 (Sweetie HD shape:
        // `<root>/<JP title subdir>/REALLIVEDATA/`), the detector must
        // resolve the data dir and treat the files as engine evidence
        // even though they're not at game-root depth 1.
        let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
        let payload_offset = directory_byte_len as u32;
        let payload: &[u8] = b"nested-shape-payload";
        let mut seen_bytes = vec![0u8; directory_byte_len + payload.len()];
        let slot1 = 8usize;
        seen_bytes[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
        seen_bytes[slot1 + 4..slot1 + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        seen_bytes[directory_byte_len..].copy_from_slice(payload);

        let game_dir = temp_dir("reallive-nested-realivedata");
        let nested_dir = game_dir
            .join("オシオキSweetie＋Sweets!! HD_DL版")
            .join("REALLIVEDATA");
        fs::create_dir_all(&nested_dir).unwrap();
        fs::write(nested_dir.join(REALLIVE_SEEN_TXT_PATH), &seen_bytes).unwrap();
        fs::write(
            nested_dir.join(REALLIVE_GAMEEXE_INI_PATH),
            b"#GAMEEXE_VERSION=1.0\n#REGNAME=KaifuuFixture\\RealLive\n#KOEPAC=koe.ovk\n",
        )
        .unwrap();
        // .g00 / .koe in nested asset subdirs (depth 2 inside REALLIVEDATA
        // — Sweetie HD ships them as `REALLIVEDATA/g00/*.g00` etc).
        fs::create_dir_all(nested_dir.join("g00")).unwrap();
        fs::write(nested_dir.join("g00/image.g00"), b"\0").unwrap();
        fs::create_dir_all(nested_dir.join("koe")).unwrap();
        fs::write(nested_dir.join("koe/voice.koe"), b"\0").unwrap();

        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter
            .detect(DetectRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        assert!(
            detection.detected,
            "depth-N descent must find REALLIVEDATA under JP-named parent; got: {detection:#?}"
        );
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("reallive-positive-live-layout")
        );
        // The resolved-data-dir evidence row must appear and carry the
        // relative path with forward-slash separators.
        let resolved_row = detection
            .evidence
            .iter()
            .find(|row| row.kind == REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE)
            .expect("resolved REALLIVEDATA evidence row must be emitted");
        assert_eq!(resolved_row.status, EvidenceStatus::Matched);
        assert!(
            resolved_row.path.ends_with("/REALLIVEDATA"),
            "resolved data dir path must end with `/REALLIVEDATA`, got `{}`",
            resolved_row.path
        );
        // SEEN.TXT / Gameexe.ini evidence paths must be reported relative
        // to the game root, prefixed with the resolved data dir.
        let seen_row = detection
            .evidence
            .iter()
            .find(|row| row.kind == "reallive_seen_txt_envelope")
            .expect("SEEN.TXT envelope row must be present");
        assert_eq!(seen_row.status, EvidenceStatus::Matched);
        assert!(
            seen_row.path.ends_with("/REALLIVEDATA/SEEN.TXT"),
            "SEEN.TXT evidence path must include the resolved REALLIVEDATA prefix; got `{}`",
            seen_row.path
        );
        // .g00 / .koe extension counts must reflect the depth-2 walk
        // inside REALLIVEDATA (the asset subdirs).
        let g00_row = detection
            .evidence
            .iter()
            .find(|row| row.kind == "reallive_g00_extension_count")
            .expect("g00 count row must be present");
        assert_eq!(g00_row.status, EvidenceStatus::Matched);
        assert!(
            g00_row.detail.contains("count: 1"),
            "g00 extension count must reflect the file under REALLIVEDATA/g00/ subdir; got `{}`",
            g00_row.detail
        );
        let voice_row = detection
            .evidence
            .iter()
            .find(|row| row.kind == "reallive_voice_archive_count")
            .expect("voice archive count row must be present");
        assert_eq!(voice_row.status, EvidenceStatus::Matched);
        assert!(
            voice_row.detail.contains("count: 1"),
            "voice archive count must reflect the file under REALLIVEDATA/koe/ subdir; got `{}`",
            voice_row.detail
        );
        let _ = fs::remove_dir_all(game_dir);
    }

    #[test]
    fn does_not_emit_resolved_data_dir_evidence_when_no_nested_reallivedata_present() {
        // KAIFUU-189 regression: synthetic fixtures that ship SEEN.TXT
        // at the game root (no nested REALLIVEDATA/ marker) must keep
        // emitting the original bare-marker evidence paths so the
        // public-CI golden fixtures stay byte-stable.
        let dir = reallive_fixture_dir(
            "reallive-no-nested-data-dir",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(2)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
                ("image.g00", b"\0"),
                ("voice.ovk", b"\0"),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
        assert!(detection.detected);
        let resolved_row = detection
            .evidence
            .iter()
            .find(|row| row.kind == REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE);
        assert!(
            resolved_row.is_none(),
            "no nested REALLIVEDATA/ marker means no resolved-data-dir evidence row; got {resolved_row:?}",
        );
        let seen_row = detection
            .evidence
            .iter()
            .find(|row| row.kind == "reallive_seen_txt_envelope")
            .expect("SEEN.TXT envelope row must be present");
        assert_eq!(seen_row.path, REALLIVE_SEEN_TXT_PATH);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_when_siglus_scene_pck_co_present_with_ambiguous_engine_variant_error() {
        let dir = reallive_fixture_dir(
            "reallive-ambiguous-siglus-scene-pck",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
                ("Scene.pck", b"SIGLUS-SCENE-PCK"),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
        assert!(!detection.detected);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("ambiguous-reallive-siglus-overlap")
        );
        let failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest { game_dir: &dir })
                .unwrap_err(),
        );
        assert_eq!(failure.error_code, "kaifuu.ambiguous_engine_variant");
        assert_eq!(failure.engine.as_deref(), Some("reallive"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_when_gameexe_dat_co_present_with_ambiguous_engine_variant_error() {
        let dir = reallive_fixture_dir(
            "reallive-ambiguous-gameexe-dat",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
                ("Gameexe.dat", b"SIGLUS-GAMEEXE-DAT"),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let failure = adapter_failure_from_error(
            adapter
                .asset_inventory(AssetInventoryRequest { game_dir: &dir })
                .unwrap_err(),
        );
        assert_eq!(failure.error_code, "kaifuu.ambiguous_engine_variant");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_on_avg32_pdt_layout_with_unsupported_engine_variant_error() {
        let dir = reallive_fixture_dir(
            "reallive-avg32-pdt-layout",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                ("Gameexe.ini", b"# AVG32 lineage placeholder\n"),
                ("image.PDT", b"\0"),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
        assert!(!detection.detected);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("avg32-lineage-seen-txt")
        );
        let failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest { game_dir: &dir })
                .unwrap_err(),
        );
        assert_eq!(failure.error_code, "kaifuu.unsupported_engine_variant");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_on_invalid_seen_txt_envelope_with_unknown_engine_variant_error() {
        let dir = reallive_fixture_dir(
            "reallive-invalid-seen-envelope",
            &[
                (REALLIVE_SEEN_TXT_PATH, &[0u8; 4]),
                (REALLIVE_GAMEEXE_INI_PATH, b""),
            ],
        );
        let adapter = RealLiveProfileDetectorAdapter;
        let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
        assert!(!detection.detected);
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("unknown-reallive-named-files")
        );
        let failure = adapter_failure_from_error(
            adapter
                .profile(ProfileRequest { game_dir: &dir })
                .unwrap_err(),
        );
        assert_eq!(failure.error_code, "kaifuu.unknown_engine_variant");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn does_not_detect_reallive_on_hello_game_fixture_without_emitting_diagnostic() {
        let dir = hello_fixture_dir();
        let detection = RealLiveProfileDetectorAdapter
            .detect(DetectRequest { game_dir: &dir })
            .unwrap();
        assert!(!detection.detected);
        assert!(detection.detected_variant.is_none());
        assert!(detection.engine_family.is_none());
    }

    #[test]
    fn does_not_detect_reallive_on_xp3_fixture_without_misclassifying() {
        let dir = xp3_fixture_dir(
            "reallive-cross-check-xp3",
            b"XP3\r\nfixture-only plain archive",
        );
        let detection = RealLiveProfileDetectorAdapter
            .detect(DetectRequest { game_dir: &dir })
            .unwrap();
        assert!(!detection.detected);
        assert!(detection.detected_variant.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn does_not_detect_reallive_on_siglus_only_fixture_without_misclassifying() {
        let dir = siglus_fixture_dir(
            "reallive-cross-check-siglus",
            Some(SIGLUS_SCENE_MAGIC),
            Some(SIGLUS_GAMEEXE_MAGIC),
        );
        let detection = RealLiveProfileDetectorAdapter
            .detect(DetectRequest { game_dir: &dir })
            .unwrap();
        assert!(!detection.detected);
        assert!(detection.detected_variant.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_extract_request_with_unsupported_layered_transform_error() {
        let dir = reallive_fixture_dir(
            "reallive-extract-unsupported",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ],
        );
        let failure = adapter_failure_from_error(
            RealLiveProfileDetectorAdapter
                .extract(ExtractRequest { game_dir: &dir })
                .unwrap_err(),
        );
        assert_eq!(failure.error_code, "kaifuu.unsupported_layered_transform");
        assert_eq!(failure.required_capability, Some(Capability::CodecAccess));
        assert_eq!(failure.asset_ref.as_deref(), Some(REALLIVE_SEEN_TXT_PATH));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_patch_request_with_unsupported_failures() {
        let dir = reallive_fixture_dir(
            "reallive-patch-unsupported",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ],
        );
        let export = PatchExport {
            patch_export_id: "kaifuu-reallive-export-001".to_string(),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let output_dir = temp_dir("reallive-patch-output");
        let result = RealLiveProfileDetectorAdapter
            .patch(PatchRequest {
                game_dir: &dir,
                patch_export: &export,
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(result.status, OperationStatus::Failed);
        assert!(!result.failures.is_empty());
        assert!(
            result
                .failures
                .iter()
                .any(|failure| { failure.error_code == "kaifuu.missing_capability.container" })
        );
        assert!(
            result
                .failures
                .iter()
                .any(|failure| { failure.error_code == "kaifuu.missing_capability.patch_back" })
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_reallive_verify_request_with_unsupported_layered_transform_error() {
        let dir = reallive_fixture_dir(
            "reallive-verify-unsupported",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ],
        );
        let result = RealLiveProfileDetectorAdapter
            .verify(VerifyRequest { game_dir: &dir })
            .unwrap();
        assert_eq!(result.status, OperationStatus::Failed);
        assert!(
            result
                .failures
                .iter()
                .any(|failure| { failure.error_code == "kaifuu.unsupported_layered_transform" })
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reallive_detection_evidence_lists_seen_txt_gameexe_ini_seen_gan_and_g00_counts() {
        let dir = reallive_fixture_dir(
            "reallive-detection-evidence-coverage",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_SEEN_GAN_PATH, REALLIVE_SEEN_GAN_MAGIC),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
                ("image.g00", b"\0"),
                ("voice.ovk", b"\0"),
            ],
        );
        let detection = RealLiveProfileDetectorAdapter
            .detect(DetectRequest { game_dir: &dir })
            .unwrap();
        let evidence_paths: BTreeSet<_> = detection
            .evidence
            .iter()
            .map(|evidence| evidence.path.as_str())
            .collect();
        for expected in [
            REALLIVE_SEEN_TXT_PATH,
            REALLIVE_SEEN_GAN_PATH,
            REALLIVE_GAMEEXE_INI_PATH,
            "*.g00",
            "*.ovk|*.koe|*.nwk",
            "Scene.pck",
            "Gameexe.dat",
            "*.pdt",
        ] {
            assert!(
                evidence_paths.contains(expected),
                "missing evidence path {expected}"
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reallive_adapter_capabilities_report_supported_extract_patch_verify_for_kaifuu_174() {
        let capabilities = RealLiveProfileDetectorAdapter.capabilities();
        assert_eq!(capabilities.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
        let supported: Vec<Capability> = capabilities
            .reports
            .iter()
            .filter(|report| report.status == CapabilityStatus::Supported)
            .map(|report| report.capability.clone())
            .collect();
        for required in [
            Capability::Detection,
            Capability::ProfileGeneration,
            Capability::AssetListing,
            Capability::AssetInventory,
            Capability::Extraction,
            Capability::Verification,
            Capability::ContainerAccess,
            Capability::CodecAccess,
            Capability::PatchBack,
        ] {
            assert!(
                supported.contains(&required),
                "missing supported {required:?}; got: {supported:?}"
            );
        }
        // Patching / AssetTextPatching / LineParityPatching are Limited
        // because KAIFUU-174 is length-preserving only.
        for limited in [
            Capability::Patching,
            Capability::AssetTextPatching,
            Capability::LineParityPatching,
        ] {
            assert!(
                capabilities.reports.iter().any(|report| {
                    report.capability == limited && report.status == CapabilityStatus::Limited
                }),
                "missing limited capability {limited:?}"
            );
        }
        // Still Unsupported.
        for unsupported in [
            Capability::CryptoAccess,
            Capability::RuntimeVm,
            Capability::EncryptedInput,
            Capability::KeyProfile,
            Capability::DeltaPatching,
            Capability::NonTextSurfaceExtraction,
        ] {
            assert!(
                capabilities.reports.iter().any(|report| {
                    report.capability == unsupported
                        && report.status == CapabilityStatus::Unsupported
                }),
                "missing unsupported capability {unsupported:?}"
            );
        }
        let access = capabilities
            .access_contract
            .as_ref()
            .expect("RealLive adapter must declare a layered access contract");
        assert_eq!(access.identify.status, CapabilityStatus::Supported);
        assert_eq!(access.inventory.status, CapabilityStatus::Supported);
        assert_eq!(access.extract.status, CapabilityStatus::Supported);
        assert_eq!(access.patch.status, CapabilityStatus::Supported);
    }

    #[test]
    fn reallive_detection_report_redacts_game_dir_for_logs_and_reports() {
        let dir = reallive_fixture_dir(
            "reallive-detection-redaction",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ],
        );
        let detection = RealLiveProfileDetectorAdapter
            .detect(DetectRequest { game_dir: &dir })
            .unwrap();
        let serialized = stable_json(&detection.redacted_for_report()).unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        assert!(
            !serialized.contains(&dir_str),
            "raw game dir leaked into detection report"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reallive_profile_emits_stable_uuidv7_profile_id_across_runs() {
        let dir_one = reallive_fixture_dir(
            "reallive-stable-profile-one",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ],
        );
        let dir_two = reallive_fixture_dir(
            "reallive-stable-profile-two",
            &[
                (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
                (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ],
        );
        let first = RealLiveProfileDetectorAdapter
            .profile(ProfileRequest { game_dir: &dir_one })
            .unwrap();
        let second = RealLiveProfileDetectorAdapter
            .profile(ProfileRequest { game_dir: &dir_two })
            .unwrap();
        assert_eq!(first.profile_id, REALLIVE_PROFILE_ID);
        assert_eq!(first.profile_id, second.profile_id);
        let _ = fs::remove_dir_all(dir_one);
        let _ = fs::remove_dir_all(dir_two);
    }

    #[test]
    fn reallive_registry_registration_appears_in_adapter_list() {
        let registry = registry();
        let adapters: Vec<_> = registry
            .adapters()
            .iter()
            .map(|adapter| adapter.id())
            .collect();
        assert!(adapters.contains(&REALLIVE_DETECTOR_ADAPTER_ID));
    }

    // -----------------------------------------------------------------
    // KAIFUU-174 — RealLive Scene/SEEN bridge inventory + patch-back
    // adapter tests.
    // -----------------------------------------------------------------

    fn reallive_174_fixture_dir(name: &str) -> PathBuf {
        // Build a writable temp dir containing the bridge-inventory-001
        // SEEN.TXT / Gameexe.ini fixtures from the kaifuu-reallive crate.
        let src_dir = crate::test_manifest_dir()
            .join("../kaifuu-reallive/tests/fixtures/bridge-inventory-001");
        let seen_bytes = fs::read(src_dir.join("SEEN.TXT")).unwrap();
        let gameexe_bytes = fs::read(src_dir.join("Gameexe.ini")).unwrap();
        let dir = temp_dir(name);
        fs::write(dir.join(REALLIVE_SEEN_TXT_PATH), &seen_bytes).unwrap();
        fs::write(dir.join(REALLIVE_GAMEEXE_INI_PATH), &gameexe_bytes).unwrap();
        dir
    }

    #[test]
    fn reallive_adapter_extract_emits_bridge_bundle_with_scene_dialogue_units() {
        let dir = reallive_174_fixture_dir("kaifuu-174-extract-bridge-bundle");
        let result = RealLiveProfileDetectorAdapter
            .extract(ExtractRequest { game_dir: &dir })
            .unwrap();
        assert_eq!(result.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
        assert!(!result.bridge.units.is_empty());
        let surfaces: BTreeSet<_> = result
            .bridge
            .units
            .iter()
            .map(|u| u.text_surface.clone())
            .collect();
        // Adapter-unify: extract now shares `patch`'s produce_bundle path, so
        // the emitted surfaces are exactly `produce_bundle`'s v0.2
        // `surfaceKind`s — `dialogue` and `choice_label`. The former
        // `speaker_name` surface is gone: a speaker is embedded on the
        // dialogue unit's `speaker` field (NAMAE-resolved), not minted as a
        // standalone translatable unit.
        assert!(surfaces.contains("dialogue"));
        assert!(surfaces.contains("choice_label"));
        // Deterministic source-unit keys (produce_bundle scheme), NOT the
        // former random-UUID inventory ids — this is what lets a PatchExport
        // keyed on extract's ids resolve during patch.
        let dialogue = result
            .bridge
            .units
            .iter()
            .find(|u| u.text_surface == "dialogue")
            .expect("dialogue unit present");
        assert_eq!(dialogue.source_text, "Hello");
        assert_eq!(dialogue.source_unit_key, "reallive:scene-0001#0000");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reallive_adapter_patch_round_trips_unchanged_archive_byte_for_byte() {
        let dir = reallive_174_fixture_dir("kaifuu-174-patch-identity");
        let export = PatchExport {
            patch_export_id: "kaifuu-reallive-empty-export".to_string(),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let output_dir = temp_dir("kaifuu-174-patch-identity-out");
        let result = RealLiveProfileDetectorAdapter
            .patch(PatchRequest {
                game_dir: &dir,
                patch_export: &export,
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(result.status, OperationStatus::Passed);
        let patched = fs::read(output_dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
        let original = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
        assert_eq!(patched, original);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(output_dir);
    }

    // Build a PatchExport that translates EVERY extracted unit (the
    // adapter's "no silent partial" rule requires a target per unit in a
    // touched scene). `override_dialogue` replaces the "Hello" dialogue
    // unit's target; every other unit is carried through identity (source
    // text as its own target, which is length-preserving by construction).
    fn reallive_all_units_export(
        extract: &ExtractionResult,
        override_dialogue: &str,
    ) -> PatchExport {
        let entries = extract
            .bridge
            .units
            .iter()
            .map(|unit| kaifuu_core::PatchExportEntry {
                bridge_unit_id: unit.bridge_unit_id.clone(),
                source_unit_key: unit.source_unit_key.clone(),
                source_hash: unit.source_hash.clone(),
                target_text: if unit.text_surface == "dialogue" {
                    override_dialogue.to_string()
                } else {
                    unit.source_text.clone()
                },
                protected_span_mappings: vec![],
            })
            .collect();
        PatchExport {
            patch_export_id: "kaifuu-reallive-all-units".to_string(),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries,
        }
    }

    // Decompress the AVG32-compressed bytecode of scene 1 from a patched
    // SEEN.TXT so a translated sentinel can be asserted on the plaintext
    // bytecode (the on-disk archive stores the bytecode compressed, so a raw
    // byte search would split the sentinel across LZSS flag bytes).
    fn reallive_decompressed_scene_1(archive_bytes: &[u8]) -> Vec<u8> {
        let index = kaifuu_reallive::parse_archive(archive_bytes).expect("patched archive parses");
        let entry = index
            .entries
            .iter()
            .find(|e| e.scene_id == 1)
            .expect("scene 1 present");
        let blob = &archive_bytes
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
        let header =
            kaifuu_reallive::SceneHeader::parse(blob).expect("patched scene header parses");
        let start = header.bytecode_offset as usize;
        let end = start + header.bytecode_compressed_size as usize;
        kaifuu_reallive::decompress_avg32(
            &blob[start..end],
            header.bytecode_uncompressed_size as usize,
        )
        .expect("patched bytecode decompresses")
    }

    #[test]
    fn reallive_adapter_patch_round_trips_length_preserving_translation() {
        let dir = reallive_174_fixture_dir("kaifuu-174-patch-length-preserving");
        // Extract via the unified produce_bundle path; the PatchExport is
        // keyed on extract's deterministic bridgeUnitIds, which patch
        // re-derives — so the round-trip resolves with no id mismatch.
        let extract = RealLiveProfileDetectorAdapter
            .extract(ExtractRequest { game_dir: &dir })
            .unwrap();
        // "Hello" (5 Shift-JIS bytes) -> "World" (5 bytes): length-preserving.
        let export = reallive_all_units_export(&extract, "World");
        let output_dir = temp_dir("kaifuu-174-patch-length-preserving-out");
        let result = RealLiveProfileDetectorAdapter
            .patch(PatchRequest {
                game_dir: &dir,
                patch_export: &export,
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(
            result.status,
            OperationStatus::Passed,
            "failures: {:?}",
            result.failures
        );
        // The patched scene decompresses to bytecode carrying the translated
        // dialogue body byte-for-byte, and re-extract observes it as the new
        // dialogue source text — a byte-correct round trip.
        let patched = fs::read(output_dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
        let decompressed = reallive_decompressed_scene_1(&patched);
        assert!(
            decompressed.windows(5).any(|w| w == b"World"),
            "translated dialogue body 'World' missing from patched bytecode"
        );
        assert!(
            !decompressed.windows(5).any(|w| w == b"Hello"),
            "source dialogue body 'Hello' still present after length-preserving patch"
        );
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(output_dir);
    }

    #[test]
    fn reallive_adapter_patch_applies_length_changing_translation_through_bundle_driver() {
        // reallive-adapter-expose-length-changing-patchback: the adapter routes
        // a LENGTH-CHANGING edit straight through the bundle-driven driver
        // (offset table rewritten + jump targets recalculated) instead of the
        // old length-preserving budget gate. "Hello" (5 Shift-JIS bytes) ->
        // "Hello there" (11 bytes) grows the body; the patch must SUCCEED and
        // round-trip byte-correct.
        let dir = reallive_174_fixture_dir("kaifuu-174-patch-length-changing");
        let extract = RealLiveProfileDetectorAdapter
            .extract(ExtractRequest { game_dir: &dir })
            .unwrap();
        let export = reallive_all_units_export(&extract, "Hello there");
        let output_dir = temp_dir("kaifuu-174-patch-length-changing-out");
        let result = RealLiveProfileDetectorAdapter
            .patch(PatchRequest {
                game_dir: &dir,
                patch_export: &export,
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(
            result.status,
            OperationStatus::Passed,
            "failures: {:?}",
            result.failures
        );
        let patched = fs::read(output_dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
        let original = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
        // A length change grows the archive: the patched bytes are NOT the
        // source bytes (offset table + scene body rewritten), and the archive
        // still re-parses.
        assert_ne!(
            patched, original,
            "length-changing patch must rewrite bytes"
        );
        let reparsed = kaifuu_reallive::parse_archive(&patched).expect("patched archive re-parses");
        assert!(!reparsed.entries.is_empty());
        // The patched scene re-decompiles to bytecode carrying the LONGER
        // translated body, with the source body gone, and zero unknown opcodes.
        let decompressed = reallive_decompressed_scene_1(&patched);
        assert!(
            decompressed.windows(11).any(|w| w == b"Hello there"),
            "longer translated dialogue body 'Hello there' missing from patched bytecode"
        );
        assert!(
            !decompressed.windows(5).any(|w| w == b"Hello")
                || decompressed.windows(11).any(|w| w == b"Hello there"),
            "source-only 'Hello' body must not survive a length-changing replacement"
        );
        let ops = kaifuu_reallive::parse_real_bytecode(&decompressed)
            .expect("patched scene bytecode re-decompiles");
        let unknown = ops
            .iter()
            .filter(|o| matches!(o, kaifuu_reallive::RealLiveOpcode::Unknown { .. }))
            .count();
        assert_eq!(
            unknown, 0,
            "zero unknown opcodes required after length change"
        );
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(output_dir);
    }

    #[test]
    fn reallive_adapter_patch_rejects_unencodable_target_with_typed_patchback_failure() {
        // reallive-adapter-expose-length-changing-patchback reframe: a plain
        // length change is NO LONGER a failure (the adapter routes through the
        // length-changing bundle-driven driver). This test asserts a
        // GENUINELY-unencodable edit is still rejected loudly and typed. The
        // target "Hi 😀" both CHANGES length (so it exercises the length-
        // changing path) AND carries U+1F600, a codepoint that has no Shift-JIS
        // mapping — the RealLive Textout body cannot represent it. The driver
        // therefore returns kaifuu.reallive.patchback_target_encode_failure
        // Fatal (surfaced as the kaifuu.unsupported_layered_transform semantic
        // error), NOT because the byte length changed.
        let dir = reallive_174_fixture_dir("kaifuu-174-patch-unencodable");
        let extract = RealLiveProfileDetectorAdapter
            .extract(ExtractRequest { game_dir: &dir })
            .unwrap();
        let export = reallive_all_units_export(&extract, "Hi 😀");
        let output_dir = temp_dir("kaifuu-174-patch-unencodable-out");
        let result = RealLiveProfileDetectorAdapter
            .patch(PatchRequest {
                game_dir: &dir,
                patch_export: &export,
                output_dir: &output_dir,
            })
            .unwrap();
        assert_eq!(result.status, OperationStatus::Failed);
        // The rejection is the DRIVER's typed patch-back failure (the length
        // change itself was accepted and routed through the bundle-driven
        // path; the unmappable codepoint is what the encoder cannot represent).
        // The driver-mapped remediation names the stable
        // `kaifuu.reallive.patchback_*` code family, distinguishing this from
        // the adapter's other unsupported paths. (The support_boundary carries
        // the exact `kaifuu.reallive.patchback_target_encode_failure` code but
        // is report-redacted because the driver message embeds the unit UUID.)
        assert!(
            result.failures.iter().any(|f| {
                f.error_code == "kaifuu.unsupported_layered_transform"
                    && f.required_capability == Some(Capability::PatchBack)
                    && f.remediation
                        .as_deref()
                        .is_some_and(|r| r.contains("kaifuu.reallive.patchback_"))
            }),
            "failures: {:?}",
            result.failures
        );
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(output_dir);
    }

    #[test]
    fn reallive_adapter_layered_access_profile_describes_scene_and_gameexe_surfaces() {
        let dir = reallive_174_fixture_dir("kaifuu-174-layered-profile");
        let profile = RealLiveProfileDetectorAdapter
            .profile(ProfileRequest { game_dir: &dir })
            .unwrap();
        let layered = profile
            .layered_access
            .as_ref()
            .expect("layered access profile present");
        let surface_ids: BTreeSet<&str> = layered
            .surfaces
            .iter()
            .map(|s| s.surface_id.as_str())
            .collect();
        assert!(
            surface_ids
                .iter()
                .any(|id| id.starts_with("reallive-seen-txt"))
        );
        assert!(
            surface_ids
                .iter()
                .any(|id| id.starts_with("reallive-gameexe-ini"))
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fixture_asset_inventory_reports_non_text_surfaces_without_patching_support() {
        let game_dir = hello_fixture_dir();
        let manifest = FixtureAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();

        assert_eq!(manifest.validate().status, OperationStatus::Passed);
        assert_eq!(manifest.assets.len(), 11);
        assert_eq!(manifest.surfaces.len(), 6);
        let surface_kinds = manifest
            .surfaces
            .iter()
            .map(|surface| serde_json::to_string(&surface.asset_surface_kind).unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            surface_kinds,
            [
                "\"credits\"",
                "\"font\"",
                "\"image_text\"",
                "\"song_title\"",
                "\"ui_art\"",
                "\"video\"",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
        );
        assert!(manifest.surfaces.iter().all(|surface| {
            surface.patching.capability == Capability::AssetTextPatching
                && surface.patching.status == kaifuu_core::CapabilityStatus::Unsupported
        }));
        assert!(
            manifest.surfaces.iter().all(|surface| {
                surface.text_source_kind != AssetInventoryTextSourceKind::OcrHint
            })
        );
        assert!(manifest.surfaces.iter().any(|surface| {
            surface.asset_surface_kind == AssetInventorySurfaceKind::Font
                && surface.source_text.is_none()
                && surface.text_source_kind == AssetInventoryTextSourceKind::NotApplicable
        }));
    }

    #[test]
    fn fixture_asset_inventory_metadata_round_trips_stably() {
        let game_dir = hello_fixture_dir();
        let manifest = FixtureAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        // `AssetInventoryManifest::stable_json` is report-safe: it routes
        // through the centralized redaction policy, so the public serialization
        // is a fixed point (re-serializing the round-tripped manifest is
        // stable) rather than a lossless round-trip of the raw struct. Non
        // sensitive asset metadata still survives redaction.
        let serialized = manifest.stable_json().unwrap();
        let round_tripped: AssetInventoryManifest = serde_json::from_str(&serialized).unwrap();

        assert_eq!(round_tripped.stable_json().unwrap(), serialized);
        assert_eq!(round_tripped.validate().status, OperationStatus::Passed);
        let audio_asset = round_tripped
            .assets
            .iter()
            .find(|asset| asset.asset_id == "asset-audio-moonlit-path")
            .unwrap();
        assert_eq!(
            audio_asset.metadata.get("titleField").map(String::as_str),
            Some("vorbisComment.TITLE")
        );
    }

    #[test]
    fn fixture_asset_inventory_matches_reviewed_fixture_manifest() {
        let game_dir = hello_fixture_dir();
        let mut manifest = FixtureAdapter
            .asset_inventory(AssetInventoryRequest {
                game_dir: &game_dir,
            })
            .unwrap();
        let mut expected: AssetInventoryManifest =
            serde_json::from_str(&fs::read_to_string(expected_asset_inventory_path()).unwrap())
                .unwrap();

        manifest.normalize();
        expected.normalize();
        assert_eq!(manifest.validate().status, OperationStatus::Passed);
        assert_eq!(expected.validate().status, OperationStatus::Passed);
        assert_eq!(manifest, expected);
    }

    #[test]
    fn fixture_profile_json_is_stable() {
        let game_dir = temp_game("profile");
        let first = FixtureAdapter
            .profile(ProfileRequest {
                game_dir: &game_dir,
            })
            .unwrap()
            .stable_json()
            .unwrap();
        let second = FixtureAdapter
            .profile(ProfileRequest {
                game_dir: &game_dir,
            })
            .unwrap()
            .stable_json()
            .unwrap();
        assert_eq!(first, second);
        assert!(first.contains("\"capability\": \"line_parity_patching\""));
        assert!(first.contains("\"container\": \"identity\""));
        assert!(first.contains("\"crypto\": \"null_key\""));
        assert!(first.contains("\"codec\": \"identity\""));
        let _ = fs::remove_dir_all(game_dir);
    }
}
