use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::ffi::CString;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

pub mod secret_holder;

/// Crate-wide result whose error is intentionally the boxed trait object.
/// `kaifuu-core` spans detection, extraction, patch-back, profiling and
/// filesystem staging across every supported engine family; a single call
/// chain routinely mixes `std::io::Error`, `serde_json::Error`, the many
/// per-domain typed errors defined in this crate (e.g. `PatchTransactionError`,
/// `Rgss3ExtractError`, `MvMzAssetVariantError`), and ad-hoc validation
/// messages. Boxing is the correct heterogeneous-boundary choice here: a single
/// closed enum spanning all of those domains would be a churn magnet with no
/// caller that matches on the full set. Domain-specific typed errors are kept
/// where a function's error set is knowable and are boxed into this alias via
/// `?`/`From` at the boundary.
pub type KaifuuResult<T> = Result<T, Box<dyn std::error::Error>>;

/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// Tests read read-only fixtures under `<workspace>/fixtures/...` anchored at
/// this crate's directory. The obvious anchor, `env!("CARGO_MANIFEST_DIR")`, is
/// baked into the binary at COMPILE time — so when cargo reuses a test binary
/// that was compiled in a different (and possibly since-removed) worktree, that
/// baked path no longer exists and EVERY fixture read fails with an opaque
/// `Os { code: 2, NotFound }`, taking down the whole fixture-reading suite while
/// in-memory tests stay green.
/// `cargo test` sets `CARGO_MANIFEST_DIR` in the test binary's RUNTIME
/// environment (and its CWD) to the LIVE crate directory of the current
/// invocation, which stays valid regardless of where the binary was built.
/// Prefer that runtime value; fall back to the compile-time constant only when
/// the binary is run outside cargo (no env var set). This is a lookup only — it
/// never writes, so tracked fixtures remain strictly read-only.
#[cfg(test)]
pub(crate) fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

mod semantics;
pub use semantics::*;

mod hashing;
pub use hashing::*;
// Crate-private hashing helpers used by remaining lib.rs items + tests.
pub(crate) use hashing::{byte_content_hash, is_sha256_ref, sha256_hex};

mod rpgmaker_key_material;
pub(crate) use rpgmaker_key_material::{
    decode_hex_material, normalize_rpg_maker_asset_key_material,
};

mod partial_adapter_report;
pub use partial_adapter_report::*;

pub const XP3_PLAIN_MAGIC: &[u8] = b"XP3\r\n \n\x1a\x8b\x67\x01";

pub mod alpha_encrypted_readiness;
pub mod alpha_readiness_profile;
pub mod asset_ocr;
pub mod bgi_bytecode_fixture;
pub mod bgi_detector_fixture;
pub mod bgi_readiness;
pub mod compat_evidence;
pub mod compat_profile;
pub mod compat_regression;
pub mod contracts;
pub mod dynamic_key_discovery_helper;
pub mod mv_mz_asset_xor;
pub mod mv_mz_encrypted_asset_replacement;
pub mod mv_mz_encrypted_audio;
pub mod mv_mz_encrypted_image;
pub mod mv_mz_readiness;
pub mod mv_mz_readiness_report;
pub mod native_windows_helper;
mod offset_map;
pub mod packed_engine_readiness;
pub mod patch_transaction;
mod xp3_plain;
pub use xp3_plain::{
    PlainXp3Entry, PlainXp3Inventory, PlainXp3InventoryError, read_plain_xp3_inventory,
};
pub(crate) use xp3_plain::{PlainXp3FileChunk, PlainXp3Segment};

mod xp3_real_bytes_roundtrip;
pub use xp3_real_bytes_roundtrip::{
    REAL_BYTES_XP3_SCHEMA_VERSION, REAL_BYTES_XP3_VARIANT, RealBytesXp3AdlerProof,
    RealBytesXp3Archive, RealBytesXp3Entry, RealBytesXp3Segment, XP3_INDEX_ENCODING_RAW,
    XP3_INDEX_ENCODING_ZLIB, read_real_bytes_xp3_archive, real_bytes_xp3_adler_proof,
    repack_real_bytes_xp3_archive,
};

pub mod plain_xp3_smoke;
pub mod registry;
pub mod repro_bundle;
pub mod rgss3_profile;
pub mod rgss3_smoke;
pub mod siglus_profile_proof;
pub mod siglus_static_key;
pub mod wine_proton_helper;
pub mod wolf_adapter;
pub mod wolf_encrypted_smoke;
pub mod wolf_extract_patch_verify_smoke;
pub mod wolf_helper_boundary;
pub mod wolf_profiled_production;
pub mod wolf_protection_detector;
pub mod wolf_readiness;
pub mod xp3_capability_profile;

pub use bgi_bytecode_fixture::{
    BGI_BYTECODE_FIXTURE_SCHEMA_VERSION, BGI_BYTECODE_REPORT_SCHEMA_VERSION,
    BGI_BYTECODE_SUPPORT_BOUNDARY, BgiBytecodeCodec, BgiBytecodeContainer, BgiBytecodeCrypto,
    BgiBytecodeDiagnostic, BgiBytecodeEntryReport, BgiBytecodeFixture, BgiBytecodeFixtureEntry,
    BgiBytecodeNegativeCase, BgiBytecodeNegativeCaseReport, BgiBytecodeParseError,
    BgiBytecodeParserSurface, BgiBytecodePatchCase, BgiBytecodePatchError, BgiBytecodePatchReport,
    BgiBytecodeProfile, BgiBytecodeReport, BgiBytecodeStringReference, BgiBytecodeSurface,
    BgiBytecodeTextSurface, BgiBytecodeVariant, detect_bgi_bytecode_variant,
    parse_bgi_bytecode_bytes, parse_bgi_bytecode_entry, patch_bgi_bytecode_bytes,
    patch_bgi_bytecode_entry, read_bgi_bytecode_fixture, run_bgi_bytecode_fixture,
};
pub use bgi_detector_fixture::{
    BGI_DETECTOR_FIXTURE_SCHEMA_VERSION, BGI_DETECTOR_REPORT_SCHEMA_VERSION,
    BGI_DETECTOR_SUPPORT_BOUNDARY, BGI_ENGINE_FAMILY, BgiDetectorCrypto, BgiDetectorDiagnostic,
    BgiDetectorEntryReport, BgiDetectorFixture, BgiDetectorFixtureEntry, BgiDetectorProfile,
    BgiDetectorReport, read_bgi_detector_fixture, run_bgi_detector_fixture,
};
pub use bgi_readiness::{
    BGI_READINESS_BYTECODE_PROVENANCE_NODE, BGI_READINESS_DETECTOR_PROVENANCE_NODE,
    BGI_READINESS_REPORT_SCHEMA_VERSION, BGI_READINESS_SCHEMA_VERSION,
    BGI_READINESS_SUPPORT_BOUNDARY, BgiReadinessArtifactKind, BgiReadinessArtifactProof,
    BgiReadinessCase, BgiReadinessEntryReport, BgiReadinessEvidence, BgiReadinessFinding,
    BgiReadinessFixture, BgiReadinessLevel, BgiReadinessProvenance, BgiReadinessReport,
    canonical_bgi_readiness_artifact_hash, derive_bgi_readiness_level, read_bgi_readiness_fixture,
    run_bgi_readiness,
};
pub use registry::{AdapterCapabilityMatrix, CapabilityLevel, CapabilityLevelStatus};
pub use wolf_encrypted_smoke::{
    WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID, WOLF_ENCRYPTED_SMOKE_CONTAINER,
    WOLF_ENCRYPTED_SMOKE_MARKER, WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
    WOLF_ENCRYPTED_SMOKE_SCHEMA_VERSION, WOLF_ENCRYPTED_SMOKE_SUPPORT_BOUNDARY,
    WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF, WolfEncryptedArchiveSource, WolfEncryptedCryptoProfile,
    WolfEncryptedMemberDigest, WolfEncryptedPatchProof, WolfEncryptedSmokeError,
    WolfEncryptedSmokeFixture, WolfEncryptedSmokeReport, WolfEncryptedSmokeStage,
    WolfEncryptedSmokeStageOutcome, build_synthetic_wolf_encrypted_archive,
    run_wolf_encrypted_smoke_from_fixture, run_wolf_encrypted_smoke_from_path,
};
pub use wolf_helper_boundary::{
    WOLF_HELPER_BOUNDARY_REPORT_SCHEMA_VERSION, WOLF_HELPER_BOUNDARY_SCHEMA_VERSION,
    WOLF_HELPER_BOUNDARY_SUPPORT_BOUNDARY, WolfHelperBoundaryEntryReport,
    WolfHelperBoundaryFinding, WolfHelperBoundaryFixture, WolfHelperBoundaryKind,
    WolfHelperBoundaryOutcome, WolfHelperBoundaryProfile, WolfHelperBoundaryReport,
    WolfHelperKeyRequirement, derive_wolf_helper_boundary_outcome,
    read_wolf_helper_boundary_fixture, resolve_wolf_helper_boundary, run_wolf_helper_boundary,
};
pub use wolf_protection_detector::{
    WOLF_ENGINE_FAMILY, WOLF_PROTECTION_DETECTOR_REPORT_SCHEMA_VERSION,
    WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION, WOLF_PROTECTION_DETECTOR_SUPPORT_BOUNDARY,
    WolfArchiveProtectionSignal, WolfCapabilityTuple, WolfProtectionDetectorEntryReport,
    WolfProtectionDetectorFixture, WolfProtectionDetectorFixtureEntry,
    WolfProtectionDetectorReport, WolfProtectionDiagnostic, WolfProtectionMatrixRow,
    WolfProtectionProfile, WolfSecretRequirement, derive_wolf_capability_tuple,
    derive_wolf_protection_profile, read_wolf_protection_detector_fixture,
    run_wolf_protection_detector, wolf_protection_diagnostic_matrix,
};
pub use wolf_readiness::{
    WOLF_READINESS_REPORT_SCHEMA_VERSION, WOLF_READINESS_SCHEMA_VERSION,
    WOLF_READINESS_SUPPORT_BOUNDARY, WolfReadinessArtifactKind, WolfReadinessArtifactProof,
    WolfReadinessCase, WolfReadinessEntryReport, WolfReadinessEvidence, WolfReadinessFinding,
    WolfReadinessFixture, WolfReadinessLevel, WolfReadinessProvenance, WolfReadinessReport,
    canonical_wolf_readiness_artifact_hash_from_smoke, derive_wolf_readiness_level,
    read_wolf_readiness_fixture, run_wolf_readiness,
};

pub use wolf_extract_patch_verify_smoke::{
    WOLF_EXTRACT_PATCH_VERIFY_SMOKE_CAPABILITY_ID, WOLF_EXTRACT_PATCH_VERIFY_SMOKE_MARKER,
    WOLF_EXTRACT_PATCH_VERIFY_SMOKE_SCHEMA_VERSION,
    WOLF_EXTRACT_PATCH_VERIFY_SMOKE_SUPPORT_BOUNDARY, WolfExtractPatchVerifySmokeError,
    WolfExtractPatchVerifySmokeReport, WolfSmokeArtifactKind, WolfSmokeVariantOutcome,
    canonical_wolf_smoke_proof_hash, run_wolf_extract_patch_verify_smoke,
    run_wolf_extract_patch_verify_smoke_with_registry,
};

pub use mv_mz_encrypted_audio::{
    MV_MZ_ENCRYPTED_AUDIO_CRYPTO_PROFILE_ID, MV_MZ_ENCRYPTED_AUDIO_ENGINE_FAMILY,
    MV_MZ_ENCRYPTED_AUDIO_FIXTURE_ID, MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID,
    MV_MZ_ENCRYPTED_AUDIO_SCHEMA_VERSION, MV_MZ_ENCRYPTED_AUDIO_SUPPORT_BOUNDARY,
    MV_MZ_ENCRYPTED_AUDIO_VARIANT, MvMzAudioRoundTripProof, MvMzAudioSurface,
    MvMzAudioSurfaceDeclaration, MvMzAudioVariantError, MvMzEncryptedAudioDiagnosticDeclaration,
    MvMzEncryptedAudioEntryReport, MvMzEncryptedAudioFinding, MvMzEncryptedAudioFixture,
    MvMzEncryptedAudioFixtureEntry, MvMzEncryptedAudioOutcome, MvMzEncryptedAudioPath,
    MvMzEncryptedAudioPathViolation, MvMzEncryptedAudioReport, MvMzEncryptedAudioRequest,
    MvMzEncryptedAudioScenario, RpgMakerAudioCryptoProfile, SEMANTIC_MV_MZ_AUDIO_MISSING_KEY,
    SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_SURFACE, SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
    SEMANTIC_MV_MZ_AUDIO_WRONG_KEY, encrypt_synthetic_audio, run_mv_mz_encrypted_audio,
};

pub use mv_mz_encrypted_image::{
    MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID, MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY,
    MV_MZ_ENCRYPTED_IMAGE_FIXTURE_ID, MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID,
    MV_MZ_ENCRYPTED_IMAGE_SCHEMA_VERSION, MV_MZ_ENCRYPTED_IMAGE_SUPPORT_BOUNDARY,
    MV_MZ_ENCRYPTED_IMAGE_VARIANT, MvMzEncryptedImageDiagnosticDeclaration,
    MvMzEncryptedImageEntryReport, MvMzEncryptedImageFinding, MvMzEncryptedImageFixture,
    MvMzEncryptedImageFixtureEntry, MvMzEncryptedImageOutcome, MvMzEncryptedImagePath,
    MvMzEncryptedImagePathViolation, MvMzEncryptedImageReport, MvMzEncryptedImageRequest,
    MvMzEncryptedImageScenario, MvMzImageRoundTripProof, MvMzImageSurface,
    MvMzImageSurfaceDeclaration, MvMzImageVariantError, RpgMakerImageCryptoProfile,
    SEMANTIC_MV_MZ_IMAGE_MISSING_KEY, SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_SURFACE,
    SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT, SEMANTIC_MV_MZ_IMAGE_WRONG_KEY,
    encrypt_synthetic_image, run_mv_mz_encrypted_image,
};

pub use mv_mz_asset_xor::{
    MvMzAssetKey, MvMzAssetVariantError, RPGMAKER_ASSET_XOR_PREFIX_LEN, decrypt_rpgmaker_asset,
    encrypt_rpgmaker_asset,
};

pub use mv_mz_encrypted_asset_replacement::{
    MV_MZ_ASSET_REPLACEMENT_CRYPTO_PROFILE_ID, MV_MZ_ASSET_REPLACEMENT_ENGINE_FAMILY,
    MV_MZ_ASSET_REPLACEMENT_FIXTURE_ID, MV_MZ_ASSET_REPLACEMENT_REQUIREMENT_ID,
    MV_MZ_ASSET_REPLACEMENT_SCHEMA_VERSION, MV_MZ_ASSET_REPLACEMENT_SUPPORT_BOUNDARY,
    MV_MZ_ASSET_REPLACEMENT_VARIANT, MvMzAssetReplacementDiagnosticDeclaration,
    MvMzAssetReplacementEntry, MvMzAssetReplacementEntryReport, MvMzAssetReplacementFinding,
    MvMzAssetReplacementManifest, MvMzAssetReplacementOutcome, MvMzAssetReplacementPath,
    MvMzAssetReplacementPathViolation, MvMzAssetReplacementReport, MvMzAssetReplacementRequest,
    MvMzAssetReplacementScenario, MvMzReplacementProof, ReplacementMediaKind,
    ReplacementMediaKindDeclaration, RpgMakerReplacementCryptoProfile,
    SEMANTIC_REPLACEMENT_MISSING_KEY, SEMANTIC_REPLACEMENT_NOT_MEDIA,
    SEMANTIC_REPLACEMENT_REPLACED, SEMANTIC_REPLACEMENT_TAMPERED,
    SEMANTIC_REPLACEMENT_UNSUPPORTED_SURFACE, SEMANTIC_REPLACEMENT_WRONG_KEY,
    run_mv_mz_asset_replacement,
};

pub use mv_mz_readiness::{
    EncryptedMediaDiagnostic, EncryptedMediaKind, IdentityContainer, MvMzFixtureFile,
    MvMzFixtureManifest, MvMzFixtureProfile, MvMzJsonTextSurface, MvMzNegativeFixture,
    MvMzReadinessRecord, MvMzReadinessViolation, MvMzSurfaceRole, generate_mv_mz_fixture_tree,
    mv_mz_fixture_manifest,
};

pub use mv_mz_readiness_report::{
    HELPER_ASSET_ENCRYPTION_KEY, HELPER_NONE, MV_MZ_READINESS_REPORT_SPEC, MvMzReadinessReport,
    scan_mv_mz_readiness_report,
};

pub use xp3_capability_profile::{
    SEMANTIC_CAPABILITY_ENCRYPTED_PATCH_OVERCLAIM, SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
    XP3_CAPABILITY_PROFILE_SCHEMA_VERSION, XP3_CAPABILITY_PROFILE_SUPPORT_BOUNDARY,
    Xp3CapabilityArchiveProfile, Xp3CapabilityFinding, Xp3CapabilityKeyHelperRequirement,
    Xp3CapabilityProfileEntryReport, Xp3CapabilityProfileExpected, Xp3CapabilityProfileFixture,
    Xp3CapabilityProfileFixtureEntry, Xp3CapabilityProfileReport, Xp3CapabilityProfileRequest,
    Xp3CapabilitySupportTier, Xp3CapabilityTuple, Xp3CapabilityVariant, derive_support_tier,
    generate_xp3_capability_profile,
};

pub use alpha_encrypted_readiness::{
    ALPHA_ENCRYPTED_EVIDENCE_KIND, ALPHA_ENCRYPTED_PATCH_ARTIFACT_GLOB,
    ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION, ALPHA_ENCRYPTED_READINESS_REPORT_SCHEMA_VERSION,
    ALPHA_ENCRYPTED_READINESS_SUMMARY_SCHEMA_VERSION, ALPHA_ENCRYPTED_READINESS_SUPPORT_BOUNDARY,
    AlphaEncryptedFinding, AlphaEncryptedPatchArtifact, AlphaEncryptedPatchResultRef,
    AlphaEncryptedReadinessEntry, AlphaEncryptedReadinessReport, AlphaEncryptedReadinessSummary,
    ConsumedValidationReport, generate_alpha_encrypted_readiness,
};
pub use alpha_readiness_profile::{
    ALPHA_READINESS_PROFILE_GLOB, ALPHA_READINESS_PROFILE_SCHEMA_VERSION,
    ALPHA_READINESS_SOURCE_NODE_ID, ALPHA_READINESS_SUMMARY_SCHEMA_VERSION,
    ALPHA_READINESS_SUPPORT_BOUNDARY, AlphaCapabilityRow, AlphaCapabilitySummary,
    AlphaHelperKeyStatus, AlphaOperationStatuses, AlphaReadinessEntry, AlphaReadinessFinding,
    AlphaReadinessProfile, AlphaReadinessProvenance, AlphaReadinessValidationReport,
    ReadinessFailureClass, alpha_readiness_profile_template, alpha_readiness_seed_bgi,
    alpha_readiness_seed_kirikiri_xp3, alpha_readiness_seed_rgss3, alpha_readiness_seed_siglus,
    alpha_readiness_seed_wolf, alpha_readiness_seeds, render_alpha_capability_summary,
    render_alpha_capability_summary_dir, validate_alpha_readiness_dir,
    validate_alpha_readiness_profile, validate_alpha_readiness_profiles,
};
pub use packed_engine_readiness::{
    EngineProfileSpec, PACKED_ENGINE_PROFILE_GLOB, PACKED_ENGINE_READINESS_SCHEMA_VERSION,
    PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY, PACKED_READINESS_REPORT_SCHEMA_VERSION,
    PackedContentEntry, PackedEngineFamily, PackedEngineReadinessProfile, PackedHelperRequirement,
    PackedKeyRequirement, PackedReadinessEntryReport, PackedReadinessFinding,
    PackedReadinessOutcome, PackedReadinessPosture, PackedReadinessValidationReport,
    PackedTransformStack, derive_packed_readiness_outcome, recompute_content_hash,
    validate_packed_engine_readiness_dir, validate_packed_engine_readiness_profile,
};

pub use siglus_profile_proof::{
    SEMANTIC_SIGLUS_PROFILE_PROOF_CAPABILITY_OVERCLAIM,
    SEMANTIC_SIGLUS_PROFILE_PROOF_DETECTOR_MISMATCH, SEMANTIC_SIGLUS_PROFILE_PROOF_SECRET_LEAK,
    SEMANTIC_SIGLUS_PROFILE_PROOF_SLICE_FAILED, SIGLUS_PROFILE_PROOF_SCHEMA_VERSION,
    SIGLUS_PROFILE_PROOF_SUPPORT_BOUNDARY, SiglusProfileCapabilityLevel,
    SiglusProfileProofComposeInput, SiglusProfileProofDetector, SiglusProfileProofDetectorEvidence,
    SiglusProfileProofFixture, SiglusProfileProofFixtureKeyProfile,
    SiglusProfileProofFixtureParser, SiglusProfileProofKeyProfile, SiglusProfileProofKeyRef,
    SiglusProfileProofParserProfile, SiglusProfileProofRedactionSummary, SiglusProfileProofReport,
    compose_siglus_profile_proof,
};

pub use siglus_static_key::{
    SEMANTIC_SIGLUS_STATIC_KEY_HELPER_MISMATCH, SEMANTIC_SIGLUS_STATIC_KEY_REGION_NOT_FOUND,
    SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER, SIGLUS_STATIC_KEY_HELPER_ID,
    SIGLUS_STATIC_KEY_SCHEMA_VERSION, SIGLUS_STATIC_KEY_SUPPORT_BOUNDARY,
    SiglusStaticKeyCapability, SiglusStaticKeyDeclaredHelper, SiglusStaticKeyEntryReport,
    SiglusStaticKeyFinding, SiglusStaticKeyFixture, SiglusStaticKeyFixtureEntry,
    SiglusStaticKeyOutcome, SiglusStaticKeyRef, SiglusStaticKeyReport, SiglusStaticKeyRequest,
    SiglusStaticKeyStubInputs, SiglusStaticKeyStubScenario, build_siglus_static_key_stub,
    discover_siglus_static_key,
};

pub use wine_proton_helper::{
    HelperRedactionPolicy, PlatformAvailability, ResolvedHelperCommand,
    SEMANTIC_WINE_PROTON_DRY_RUN_HELPER_RESULT_INVALID,
    SEMANTIC_WINE_PROTON_DRY_RUN_LAUNCH_FORBIDDEN, SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK,
    WINE_PROTON_HELPER_SCHEMA_VERSION, WINE_PROTON_HELPER_SUPPORT_BOUNDARY,
    WineProtonDryRunFailure, WineProtonDryRunRequest, WineProtonDryRunResolution,
    WineProtonDryRunValidation, WineProtonPlatformAdapter, resolve_wine_proton_dry_run,
};

pub use native_windows_helper::{
    NATIVE_WINDOWS_HELPER_SCHEMA_VERSION, NATIVE_WINDOWS_HELPER_SUPPORT_BOUNDARY,
    NATIVE_WINDOWS_PLATFORM_ADAPTER_ID, NATIVE_WINDOWS_PLATFORM_ID, NATIVE_WINDOWS_QUOTING_RULES,
    NativeWindowsDryRunFailure, NativeWindowsDryRunRequest, NativeWindowsDryRunResolution,
    NativeWindowsDryRunValidation, NativeWindowsPlatformAdapter, ResolvedWindowsHelperCommand,
    SEMANTIC_NATIVE_WINDOWS_DRY_RUN_HELPER_RESULT_INVALID,
    SEMANTIC_NATIVE_WINDOWS_DRY_RUN_LAUNCH_FORBIDDEN, SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK,
    SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE, WindowsCommandLineQuotingFixture,
    WindowsQuotingCase, resolve_native_windows_dry_run,
    resolve_windows_command_line_quoting_fixture, windows_command_line,
    windows_command_line_to_argv, windows_quote_argument,
};

pub use dynamic_key_discovery_helper::{
    AdapterHelperDependency, AdapterTierEntry, DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION,
    DYNAMIC_KEY_DISCOVERY_HELPER_SUPPORT_BOUNDARY, DYNAMIC_KEY_DISCOVERY_PLATFORM_ID,
    DynamicKeyDiscoveryDiagnostic, DynamicKeyDiscoveryFailure, DynamicKeyDiscoveryOutcome,
    DynamicKeyDiscoveryRefusal, DynamicKeyDiscoveryRequest, DynamicKeyDiscoveryResponse,
    DynamicKeyDiscoveryValidation, DynamicKeyHelperTierReference, HelperInvocationMode,
    PURE_ADAPTER_ENGINE_IDS, SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED,
    SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN,
    SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY,
    SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID, SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK,
    attempt_dynamic_key_discovery, dynamic_key_helper_tier_reference,
};

pub use patch_transaction::{
    DiagnosticSeverity, PatchTransaction, PatchTransactionConfig, PatchTransactionError,
    PatchTransactionOutcome, PreflightCheck, PreflightReport, StagedPatchPayload,
    TransactionDiagnostic, TransactionFailureCategory, TransactionState,
};

pub use plain_xp3_smoke::{
    PLAIN_XP3_SMOKE_SCHEMA_VERSION, PLAIN_XP3_SMOKE_SUPPORT_BOUNDARY,
    PLAIN_XP3_SMOKE_SUPPORTED_SEGMENT_FLAGS, PlainXp3SmokeArchiveRef, PlainXp3SmokeArchiveReport,
    PlainXp3SmokeEquivalence, PlainXp3SmokeExpectation, PlainXp3SmokeExpectedMember,
    PlainXp3SmokeFinding, PlainXp3SmokeFixture, PlainXp3SmokeMemberReport,
    PlainXp3SmokeNegativeFixture, PlainXp3SmokeNegativeKind, PlainXp3SmokeNegativeReport,
    PlainXp3SmokeRebuildReport, PlainXp3SmokeReport, PlainXp3SmokeRequest,
    SEMANTIC_SMOKE_EXPECTATION_MISMATCH, SEMANTIC_SMOKE_MALFORMED_TABLE,
    SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL, SEMANTIC_SMOKE_REBUILD_DRIFT,
    SEMANTIC_SMOKE_UNREADABLE_ARCHIVE, SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS,
    generate_plain_xp3_smoke, run_plain_xp3_smoke_from_path,
};

pub use offset_map::{
    ByteSpan, EncodedStringSlot, EncodedStringSlotDiagnostic, EncodedStringSlotLayout,
    EncodedStringSlotPreflightReport, EncodedStringSlotProtectedSpan, OffsetMap,
    OffsetMapDiagnostic, OffsetMapError, OffsetMapSegment, OffsetMapValidationResult,
    RelocatedString, RelocatedStringReference, SourceEncoding, SourceFileId, SourceRange,
    SourceRevisionId, StringReferenceFormat, StringReferenceRelocationKind,
    StringRelocationDiagnostic, StringRelocationPlanReport, StringRelocationReference,
    StringRelocationSlot, StringRelocationTarget, StringTableRebuildRequest, parse_hex_bytes,
    plan_string_table_rebuild, validate_offset_map_value,
};

// The crate facade preserves the historical flat public API while the implementation lives in domain modules.
mod adapter_core;
pub use adapter_core::*;

mod adapter_capabilities;
pub use adapter_capabilities::*;

mod layered_access_model;
pub use layered_access_model::*;

mod archive_detection_model;
pub use archive_detection_model::*;
#[rustfmt::skip]
pub(crate) use archive_detection_model::{ ArchiveDetectionScan, NON_DETECTED_ARCHIVE_VARIANT, };

mod archive_detection_signals;
#[rustfmt::skip]
pub(crate) use archive_detection_signals::{ Xp3StructuralMarker, detect_kirikiri_xp3, detect_reallive, detect_rpg_maker_mv_mz, detect_siglus, has_orphaned_archive_subtype_marker, has_wolf_rpg_editor_primary_evidence, header_contains_ascii, is_rpg_maker_system_json, lower_path_component, read_header, system_json_has_encryption_fields, xp3_structural_marker, };

mod rpgmaker_suffixes;
#[rustfmt::skip]
pub(crate) use rpgmaker_suffixes::{ RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN, RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES, RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN, RPG_MAKER_MV_MZ_PLAIN_SUFFIXES, RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN, RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES, rpg_maker_mv_mz_surfaces, };

mod rpgmaker_key_validation;
pub use rpgmaker_key_validation::*;
#[rustfmt::skip]
pub(crate) use rpgmaker_key_validation::{ find_rpg_maker_system_json, };

mod archive_detection_rows;
#[rustfmt::skip]
pub(crate) use archive_detection_rows::{ ArchiveRowInput, archive_row, detect_bgi_ethornell, detect_renpy, detect_unknown_archive_variant, detect_wolf_rpg_editor, diagnostic, evidence, file_requirement, secret_requirement, };

mod engine_profile;
pub use engine_profile::*;

mod helper_profiles;
pub use helper_profiles::*;

mod xp3_profile_model;
#[rustfmt::skip]
pub(crate) use xp3_profile_model::XP3_HEADER_MAGIC;
pub use xp3_profile_model::*;

mod xp3_profile_proof;
pub use xp3_profile_proof::xp3_profile_proof;

mod xp3_profile_proof_support;
#[rustfmt::skip]
pub(crate) use xp3_profile_proof_support::{ classify_xp3_bytes, evaluate_xp3_crypt_profile, validate_xp3_fixture_archive_path, };

mod encrypted_media_model;
pub use encrypted_media_model::*;

mod encrypted_media_support;
pub use encrypted_media_support::*;
#[rustfmt::skip]
pub(crate) use encrypted_media_support::{ classify_encrypted_media_asset, encrypted_media_asset_evidence_hash, encrypted_media_suffix_profile, read_encrypted_media_system_json, validate_encrypted_media_fixture_path, };

mod key_declarations;
pub use key_declarations::*;

mod secret_stores;
pub use secret_stores::*;

mod key_resolver;
pub use key_resolver::*;

mod secret_redaction_validation;
pub use secret_redaction_validation::*;
#[rustfmt::skip]
pub(crate) use secret_redaction_validation::{ helper_execution_config_field_is_forbidden, helper_execution_config_field_is_forbidden_at, is_local_absolute_path, is_valid_secret_ref, looks_like_raw_key_material, normalize_secret_field_name, secret_redaction_reason, };

mod secret_redaction_reporting;
pub use secret_redaction_reporting::*;
#[rustfmt::skip]
pub(crate) use secret_redaction_reporting::{ free_text_requires_redaction, path_starts_with_home_or_local_env_var, redact_asset_ref_for_report, };

mod profile_requirements;
pub use profile_requirements::*;

mod asset_inventory_manifest;
pub use asset_inventory_manifest::*;

mod asset_inventory_model;
pub use asset_inventory_model::*;
#[rustfmt::skip]
pub(crate) use asset_inventory_model::{ required_inventory_failure, validate_asset_inventory_relative_path, validate_asset_inventory_source_location, };

mod bridge_model;
pub use bridge_model::*;

mod bridge_v02_model;
pub use bridge_v02_model::*;

mod bridge_v02_context;
pub use bridge_v02_context::*;

mod bridge_v02_validation;
pub use bridge_v02_validation::*;
#[rustfmt::skip]
pub(crate) use bridge_v02_validation::{ assert_localization_policy_v02, assert_source_location_v02, assert_surface_context_v02, };

mod patch_report_model;
pub use patch_report_model::*;

mod asset_patch_capability;
pub use asset_patch_capability::*;

mod operation_result_model;
pub use operation_result_model::*;

mod layered_access_preflight;
pub use layered_access_preflight::*;

mod layered_access_transforms;
#[rustfmt::skip]
pub(crate) use layered_access_transforms::remediation_for_layered_stage;

mod adapter_failures;
pub use adapter_failures::*;

mod report_redaction;
#[rustfmt::skip]
pub(crate) use report_redaction::{ as_record, assert_byte_range_v02, assert_equals, assert_hash_string_v02, assert_known_asset_id, assert_non_empty, assert_non_negative_integer_value, assert_one_of, assert_optional_value_string, assert_optional_value_uuid7, assert_pixel_region_v02, assert_required_boolean, assert_required_pixel_region_v02, assert_required_string, assert_required_uuid7, assert_required_value_string, assert_required_value_uuid7, assert_revision_hash_matches_v02, assert_schema_version_v02, assert_surface_kind, assert_uuid7, assert_value_byte_range, assert_value_one_of, assert_value_string, assert_value_string_array, };

mod redacted_content_summary;
pub use redacted_content_summary::*;

mod plain_xp3_writer_model;
pub use plain_xp3_writer_model::*;

mod plain_xp3_reader;
pub use plain_xp3_reader::*;

mod plain_xp3_directory;
pub use plain_xp3_directory::*;
#[rustfmt::skip]
pub(crate) use plain_xp3_directory::{ checked_end, has_legacy_xp3_encrypted_marker, hash_xp3_segments, parse_xp3_file_chunk, read_chunk_name, read_le_u64, };

mod json_io;
pub use json_io::*;

mod golden_harness_run;
pub use golden_harness_run::*;
#[rustfmt::skip]
pub(crate) use golden_harness_run::{ GoldenPatchPhaseArgs, golden_diagnostic_summary, golden_error_summary, record_golden_failure, report_passed_phase, run_golden_patch_phase, };

mod golden_harness_report;
#[rustfmt::skip]
pub(crate) use golden_harness_report::{ record_adapter_failures, report_byte_equivalence, };

mod golden_harness_output;
#[rustfmt::skip]
pub(crate) use golden_harness_output::{ asset_preservation_signature, report_output_equivalence, report_translated_patch, report_verify_phase, };

mod golden_harness_v02;
#[rustfmt::skip]
pub(crate) use golden_harness_v02::{ patch_export_for_adapter, report_v02_source_compatibility, };
#[cfg(test)]
#[rustfmt::skip]
pub(crate) use golden_harness_v02::{ v02_bridge_units_by_key, v02_patch_entry_span_mappings_compatible, };

mod golden_harness_translation;
pub use golden_harness_translation::*;
#[rustfmt::skip]
pub(crate) use golden_harness_translation::{ finalize_golden_report, report_translated_target_equivalence, source_unit_key_from_asset_ref, };

#[path = "lib/profile_validation.rs"]
mod profile_validation;

#[cfg(test)]
use profile_validation::validate_capability_report;
#[rustfmt::skip]
pub(crate) use profile_validation::{ is_bcp47_like_locale, validate_profile_relative_path, };
pub use profile_validation::{GameProfile, validate_profile_value};

/// Run the encrypted-media readiness proof.
/// Routing rules (acceptance criteria):
/// - Encrypted image / audio / video media variants are detected with
///   exact asset-kind capability levels — per-asset `kind` and
///   `classification` are set from the bytes, not the fixture.
/// - Missing or wrong keys return semantic diagnostics before decrypted
///   bytes are persisted (the proof never decrypts; `decryptedBytesPersisted`
///   is always `false`).
/// - Readiness output never claims dialogue extraction or script patch
///   support based only on media-key detection (`scriptCapabilityClaimed`
///   is always `false`; `patchCapabilityLevel` is never `patch_back` or
///   `extract` — for encrypted assets it is forced to `Unsupported`, for
///   plaintext it is `NotClaimed`).
/// - Public fixtures use synthetic media and public test keys only —
///   absolute / traversal / home paths are rejected up front and never
///   appear in the report.
pub fn encrypted_media_proof(
    request: EncryptedMediaProofRequest<'_>,
) -> KaifuuResult<EncryptedMediaProofReport> {
    let fixture = request.fixture;
    let mut diagnostics: Vec<EncryptedMediaProofDiagnostic> = Vec::new();

    let game_dir_validated = match validate_encrypted_media_fixture_path(&fixture.game_dir) {
        Ok(_) => true,
        Err(message) => {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.game_dir.leaked".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "gameDir".to_string(),
                message,
                semantic_code: Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string()),
                remediation: Some(
                    "gameDir must be relative to the fixture file and must not contain absolute roots, drive letters, parent traversal, or home prefixes"
                        .to_string(),
                ),
            });
            false
        }
    };

    let game_dir_full = if game_dir_validated {
        Some(request.fixture_dir.join(&fixture.game_dir))
    } else {
        None
    };

    // Read System.json once so per-asset routing can branch on the
    // shared key profile evidence.
    let system_json = game_dir_full
        .as_deref()
        .and_then(read_encrypted_media_system_json);
    let system_json_present = system_json.is_some();
    let system_json_key_present = system_json
        .as_ref()
        .is_some_and(|sj| sj.encryption_key_present);
    let system_json_key_well_formed = system_json
        .as_ref()
        .is_some_and(|sj| sj.encryption_key_well_formed);
    let system_json_proof_hash = system_json.as_ref().and_then(|sj| sj.proof_hash.clone());
    let system_json_key_hash = system_json
        .as_ref()
        .and_then(|sj| sj.encryption_key_hash.clone());
    let expected_system_json_key_hash = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.expected_system_json_key_hash.clone());
    let system_json_key_matches_expected = match (
        expected_system_json_key_hash.as_ref(),
        system_json_key_hash.as_ref(),
    ) {
        (Some(expected), Some(actual)) => expected == actual,
        _ => true,
    };
    let has_encrypted_images_flag = system_json.as_ref().and_then(|sj| sj.has_encrypted_images);
    let has_encrypted_audio_flag = system_json.as_ref().and_then(|sj| sj.has_encrypted_audio);

    let any_encrypted_declared = fixture.assets.iter().any(|asset| {
        matches!(
            asset.expected_classification,
            EncryptedMediaClassification::Encrypted
        )
    });

    // Per-asset routing.
    let mut assets: Vec<EncryptedMediaProofAsset> = Vec::with_capacity(fixture.assets.len());
    for fixture_asset in &fixture.assets {
        let path_validation = validate_encrypted_media_fixture_path(&fixture_asset.path);
        let path_rejected = path_validation.is_err();
        if let Err(message) = path_validation {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.asset_path.leaked".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: format!("assets[{}].path", fixture_asset.asset_id),
                message,
                semantic_code: Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string()),
                remediation: Some(
                    "asset paths must be relative to the game directory and must not contain absolute roots, drive letters, parent traversal, or home prefixes"
                        .to_string(),
                ),
            });
        }

        let declared_path_for_report = if path_rejected {
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
        } else {
            fixture_asset.path.clone()
        };

        let suffix = Path::new(&fixture_asset.path)
            .extension()
            .and_then(|os| os.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let suffix_profile = encrypted_media_suffix_profile(&suffix);

        let asset_full = match (path_rejected, game_dir_full.as_deref()) {
            (false, Some(game_dir)) => Some(game_dir.join(&fixture_asset.path)),
            _ => None,
        };
        let asset_bytes = asset_full.as_deref().and_then(|path| fs::read(path).ok());

        let bytes_for_classify = asset_bytes.as_deref();
        let classification = classify_encrypted_media_asset(suffix_profile, bytes_for_classify);

        // Bytes-classification override is final — the fixture declared
        // classification is only allowed to *match* the byte-level routing.
        // Surface a P1 mismatch diagnostic when the two disagree so
        // fixture authors notice (acceptance criterion: "Encrypted image,
        // audio, and video media variants are detected with exact
        // asset-kind capability levels").
        if !path_rejected
            && classification != fixture_asset.expected_classification
            // MissingAsset / UnknownSuffix are intrinsic byte-routing
            // outcomes; the fixture is never *expected* to declare them
            // in a way that conflicts with their physical state.
            && !matches!(
                classification,
                EncryptedMediaClassification::MissingAsset
                    | EncryptedMediaClassification::UnknownSuffix
            )
        {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.classification.mismatch".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: format!("assets[{}].expectedClassification", fixture_asset.asset_id),
                message: format!(
                    "fixture declared {} but asset bytes classify as {}",
                    fixture_asset.expected_classification.as_str(),
                    classification.as_str(),
                ),
                semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
                remediation: Some(
                    "regenerate the fixture so the declared classification matches the asset bytes"
                        .to_string(),
                ),
            });
        }

        // For missing-asset / malformed-header cases that the fixture
        // *declared* (e.g. negative fixtures), record the declared
        // classification but keep the byte-level outcome as the routing.
        // No upward re-classification.
        if matches!(classification, EncryptedMediaClassification::MissingAsset) {
            if !path_rejected {
                diagnostics.push(EncryptedMediaProofDiagnostic {
                    code: "rpgmaker.encrypted_media.asset.missing".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: format!("assets[{}].path", fixture_asset.asset_id),
                    message: format!("asset {} could not be read", fixture_asset.asset_id),
                    semantic_code: Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED.to_string()),
                    remediation: Some(
                        "ensure the asset file exists under the game directory before running the proof".to_string(),
                    ),
                });
            }
        } else if matches!(classification, EncryptedMediaClassification::UnknownSuffix) {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.suffix.unknown".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: format!("assets[{}].path", fixture_asset.asset_id),
                message: format!(
                    "asset suffix .{suffix} has no profiled MV/MZ media mapping"
                ),
                semantic_code: Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT.to_string()),
                remediation: Some(
                    "add a suffix profile before declaring readiness; recognition does not imply a decryption capability claim".to_string(),
                ),
            });
        } else if matches!(
            classification,
            EncryptedMediaClassification::MalformedHeader
        ) {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.header.malformed".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: format!("assets[{}]", fixture_asset.asset_id),
                message: format!(
                    "asset {} is declared encrypted but does not carry the RPGMV header magic",
                    fixture_asset.asset_id
                ),
                semantic_code: Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED.to_string()),
                remediation: Some(
                    "regenerate the encrypted asset so the leading 16 bytes match the RPGMV header magic".to_string(),
                ),
            });
        }

        // Effective asset kind: bytes-routed suffix profile wins. For
        // unknown / missing cases we still surface the *declared* kind so
        // the report carries the fixture author's intent.
        let kind = suffix_profile
            .and_then(|p| p.kind)
            .unwrap_or(fixture_asset.expected_kind);

        // Decryptability / patch-capability / readiness routing for this
        // asset. Encrypted assets force `patch_capability_level =
        // Unsupported` and never claim `key_profile_satisfied` unless the
        // key profile evidence section is fully wired — even then, the
        // status only indicates the *profile* is wired, not that the
        // proof has any decryption capability.
        let (decryptability, key_ref_status, patch_capability_level, readiness) =
            match classification {
                EncryptedMediaClassification::Plaintext => (
                    EncryptedMediaDecryptability::NotApplicable,
                    EncryptedMediaKeyRefStatus::NotRequired,
                    EncryptedMediaPatchCapability::NotClaimed,
                    EncryptedMediaReadiness::PlaintextEvidence,
                ),
                EncryptedMediaClassification::Encrypted => {
                    let key_ref_status = match &fixture.key_profile {
                        Some(profile) => match profile.key_ref_requirement {
                            Some(_) => EncryptedMediaKeyRefStatus::Present,
                            None => EncryptedMediaKeyRefStatus::Missing,
                        },
                        None => EncryptedMediaKeyRefStatus::Missing,
                    };
                    let decryptability = if !system_json_present || !system_json_key_present {
                        EncryptedMediaDecryptability::KeyMissing
                    } else if !system_json_key_well_formed {
                        EncryptedMediaDecryptability::KeyMalformed
                    } else if !system_json_key_matches_expected {
                        EncryptedMediaDecryptability::KeyMismatch
                    } else if matches!(key_ref_status, EncryptedMediaKeyRefStatus::Missing) {
                        EncryptedMediaDecryptability::KeyMissing
                    } else {
                        EncryptedMediaDecryptability::KeyProfileSatisfied
                    };
                    let readiness = if matches!(
                        decryptability,
                        EncryptedMediaDecryptability::KeyProfileSatisfied
                    ) {
                        EncryptedMediaReadiness::Ready
                    } else {
                        EncryptedMediaReadiness::Unsupported
                    };
                    (
                        decryptability,
                        key_ref_status,
                        EncryptedMediaPatchCapability::Unsupported,
                        readiness,
                    )
                }
                EncryptedMediaClassification::MalformedHeader
                | EncryptedMediaClassification::MissingAsset
                | EncryptedMediaClassification::UnknownSuffix => (
                    EncryptedMediaDecryptability::OutOfScope,
                    if matches!(classification, EncryptedMediaClassification::UnknownSuffix) {
                        EncryptedMediaKeyRefStatus::NotRequired
                    } else {
                        match &fixture.key_profile {
                            Some(profile) => match profile.key_ref_requirement {
                                Some(_) => EncryptedMediaKeyRefStatus::Present,
                                None => EncryptedMediaKeyRefStatus::Missing,
                            },
                            None => EncryptedMediaKeyRefStatus::Missing,
                        }
                    },
                    EncryptedMediaPatchCapability::Unsupported,
                    EncryptedMediaReadiness::Unsupported,
                ),
            };

        // Hash the asset's leading bytes for provenance. Missing /
        // unreadable assets get the empty-bytes hash (still a valid
        // ProofHash; the routing diagnostic above makes the asset's
        // failure mode unambiguous).
        let asset_evidence_hash =
            encrypted_media_asset_evidence_hash(asset_bytes.as_deref().unwrap_or(&[]));

        assets.push(EncryptedMediaProofAsset {
            asset_id: fixture_asset.asset_id.clone(),
            declared_path: declared_path_for_report,
            kind,
            classification,
            readiness,
            patch_capability_level,
            key_ref_status,
            decryptability,
            asset_evidence_hash,
            suffix: suffix.clone(),
        });
    }

    // Per-asset key-profile mismatch surfacing: System.json says
    // `hasEncryptedImages: false` but the fixture declared encrypted
    // images (or vice versa). Surfaced as P1 readiness diagnostics so a
    // fixture-authoring drift is noticed before patch claims spread.
    let declared_image_encrypted = fixture.assets.iter().any(|asset| {
        asset.expected_kind == EncryptedMediaAssetKind::Image
            && asset.expected_classification == EncryptedMediaClassification::Encrypted
    });
    let declared_audio_encrypted = fixture.assets.iter().any(|asset| {
        asset.expected_kind == EncryptedMediaAssetKind::Audio
            && asset.expected_classification == EncryptedMediaClassification::Encrypted
    });
    if let (Some(false), true) = (has_encrypted_images_flag, declared_image_encrypted) {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.images_flag_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "data/System.json.hasEncryptedImages".to_string(),
            message:
                "fixture declared encrypted images but data/System.json hasEncryptedImages is false"
                    .to_string(),
            semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
            remediation: Some(
                "align data/System.json hasEncryptedImages with the declared media surface"
                    .to_string(),
            ),
        });
    }
    if let (Some(false), true) = (has_encrypted_audio_flag, declared_audio_encrypted) {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.audio_flag_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "data/System.json.hasEncryptedAudio".to_string(),
            message:
                "fixture declared encrypted audio but data/System.json hasEncryptedAudio is false"
                    .to_string(),
            semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
            remediation: Some(
                "align data/System.json hasEncryptedAudio with the declared media surface"
                    .to_string(),
            ),
        });
    }

    // Key-profile section + cross-cutting routing diagnostics.
    let key_profile_status = match (&fixture.key_profile, any_encrypted_declared) {
        (Some(profile), _) => {
            let recognized =
                RPG_MAKER_MV_MZ_RECOGNIZED_KEY_PROFILE_IDS.contains(&profile.profile_id.as_str());
            if !recognized {
                diagnostics.push(EncryptedMediaProofDiagnostic {
                    code: "rpgmaker.encrypted_media.key_profile.unknown".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "keyProfile.profileId".to_string(),
                    message: format!(
                        "key profile id {} is not in the recognised RPG Maker MV/MZ vocabulary",
                        profile.profile_id
                    ),
                    semantic_code: Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT.to_string()),
                    remediation: Some(
                        "use a recognised KAIFUU key-profile id; recognition does not imply a decryption capability claim".to_string(),
                    ),
                });
            }
            if profile.key_ref_requirement.is_none() {
                diagnostics.push(EncryptedMediaProofDiagnostic {
                    code: "rpgmaker.encrypted_media.key_profile.missing_key_ref".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "keyProfile.keyRefRequirement".to_string(),
                    message: "encrypted-media fixtures must declare a keyRef requirement"
                        .to_string(),
                    semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
                    remediation: Some(
                        "add a keyRefRequirement entry with requirementId and secretRef"
                            .to_string(),
                    ),
                });
            }
            EncryptedMediaKeyRefStatus::Present
        }
        (None, true) => {
            diagnostics.push(EncryptedMediaProofDiagnostic {
                code: "rpgmaker.encrypted_media.key_profile.missing".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "keyProfile".to_string(),
                message: "fixture declares encrypted media but supplies no keyProfile".to_string(),
                semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
                remediation: Some(
                    "add a keyProfile entry with profileId and keyRefRequirement".to_string(),
                ),
            });
            EncryptedMediaKeyRefStatus::Missing
        }
        (None, false) => EncryptedMediaKeyRefStatus::NotRequired,
    };

    if any_encrypted_declared && !system_json_present {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.missing".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "gameDir".to_string(),
            message: "encrypted-media readiness requires data/System.json evidence under the game directory".to_string(),
            semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
            remediation: Some(
                "stage a data/System.json file with encryptionKey + hasEncryptedImages / hasEncryptedAudio flags under the game directory".to_string(),
            ),
        });
    } else if any_encrypted_declared && system_json_present && !system_json_key_present {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.key_missing".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "data/System.json.encryptionKey".to_string(),
            message: "data/System.json has no encryptionKey value".to_string(),
            semantic_code: Some(SEMANTIC_MISSING_KEY_MATERIAL.to_string()),
            remediation: Some(
                "populate data/System.json.encryptionKey with a fixture-safe 32-char lowercase hex value".to_string(),
            ),
        });
    } else if any_encrypted_declared
        && system_json_present
        && system_json_key_present
        && !system_json_key_well_formed
    {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.key_malformed".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "data/System.json.encryptionKey".to_string(),
            message: "data/System.json.encryptionKey is not a 32-char lowercase hex value"
                .to_string(),
            semantic_code: Some(SEMANTIC_KEY_VALIDATION_FAILED.to_string()),
            remediation: Some(
                "regenerate data/System.json.encryptionKey as a 32-char lowercase hex string"
                    .to_string(),
            ),
        });
    } else if any_encrypted_declared
        && system_json_present
        && system_json_key_present
        && system_json_key_well_formed
        && !system_json_key_matches_expected
    {
        diagnostics.push(EncryptedMediaProofDiagnostic {
            code: "rpgmaker.encrypted_media.system_json.key_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "data/System.json.encryptionKey".to_string(),
            message:
                "data/System.json.encryptionKey hash does not match the fixture key-profile evidence"
                    .to_string(),
            semantic_code: Some(SEMANTIC_KEY_VALIDATION_FAILED.to_string()),
            remediation: Some(
                "align the fixture-safe System.json key with expectedSystemJsonKeyHash; raw keys must not be serialized"
                    .to_string(),
            ),
        });
    }

    // Aggregate readiness: `Ready` requires *all* encrypted assets to
    // be `Ready` and no blocking diagnostics. Plaintext-only fixtures
    // resolve to `PlaintextEvidence`. Anything else routes to
    // `Unsupported`.
    let has_blocking_diagnostic = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking());
    let aggregate_readiness = if has_blocking_diagnostic || assets.is_empty() {
        EncryptedMediaReadiness::Unsupported
    } else if assets
        .iter()
        .all(|asset| matches!(asset.readiness, EncryptedMediaReadiness::PlaintextEvidence))
    {
        EncryptedMediaReadiness::PlaintextEvidence
    } else if assets.iter().all(|asset| {
        matches!(
            asset.readiness,
            EncryptedMediaReadiness::Ready | EncryptedMediaReadiness::PlaintextEvidence
        )
    }) && assets
        .iter()
        .any(|asset| matches!(asset.readiness, EncryptedMediaReadiness::Ready))
    {
        EncryptedMediaReadiness::Ready
    } else {
        EncryptedMediaReadiness::Unsupported
    };

    let key_profile_id = fixture
        .key_profile
        .as_ref()
        .map(|profile| profile.profile_id.clone());
    let requirement_id = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.key_ref_requirement.as_ref())
        .map(|requirement| requirement.requirement_id.clone());
    let secret_ref = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.key_ref_requirement.as_ref())
        .map(|requirement| requirement.secret_ref.clone());

    let semantic_remediation = if matches!(aggregate_readiness, EncryptedMediaReadiness::Ready) {
        Some(
            "encrypted-media readiness reports profile wiring only; KAIFUU-039 makes no decryption, extraction, script-patch, or dialogue-extraction capability claim".to_string(),
        )
    } else if matches!(
        aggregate_readiness,
        EncryptedMediaReadiness::PlaintextEvidence
    ) {
        Some(
            "plaintext media surfaced as evidence only; no patch capability is claimed".to_string(),
        )
    } else {
        Some(
            "encrypted-media routing diagnostics fired; KAIFUU-039 makes no decryption, extraction, script-patch, or dialogue-extraction capability claim".to_string(),
        )
    };

    let status = if has_blocking_diagnostic {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Ok(EncryptedMediaProofReport {
        schema_version: ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        profile_id: fixture.profile_id.clone(),
        status,
        support_boundary: ENCRYPTED_MEDIA_PROOF_SUPPORT_BOUNDARY.to_string(),
        readiness: aggregate_readiness,
        patch_capability_level: if matches!(
            aggregate_readiness,
            EncryptedMediaReadiness::PlaintextEvidence
        ) {
            EncryptedMediaPatchCapability::NotClaimed
        } else {
            EncryptedMediaPatchCapability::Unsupported
        },
        // Acceptance criterion: "Readiness output never claims dialogue
        // extraction or script patch support based only on media-key
        // detection." Hardcoded false; this is the load-bearing
        // separation between media routing and script capability.
        script_capability_claimed: false,
        // Acceptance criterion: "Missing or wrong keys return semantic
        // diagnostics before decrypted bytes are persisted." The proof
        // never decrypts; this flag is hardcoded false so downstream
        // auditors can confirm the proof did not persist decrypted
        // bytes.
        decrypted_bytes_persisted: false,
        assets,
        key_profile: EncryptedMediaProofKeyProfile {
            status: key_profile_status,
            key_profile_id,
            requirement_id,
            secret_ref,
            system_json_proof_hash,
            system_json_present,
            system_json_key_present,
            system_json_key_well_formed,
            expected_system_json_key_hash,
            system_json_key_hash,
            has_encrypted_images_flag,
            has_encrypted_audio_flag,
        },
        diagnostics,
        semantic_remediation,
    })
}

#[path = "lib/helper_contracts.rs"]
mod helper_contracts;

pub use helper_contracts::{
    AdapterHelperRequirementDeclaration, FIXTURE_HELPER_ALLOWLIST_REF_ID,
    FIXTURE_HELPER_REGISTRY_ID, HelperBinaryAllowlist, HelperBinaryAllowlistEntry,
    HelperBinaryLaunchDiagnostic, HelperBinaryLaunchOutcome, HelperBinaryLaunchValidationRequest,
    HelperBinaryLaunchValidationResult, HelperBinarySignatureMetadata, HelperBinaryStagingError,
    HelperCapability, HelperExecutionMode, HelperExecutionPolicy, HelperFilesystemAccess,
    HelperRedactionClass, HelperRegistry, HelperRegistryDiagnostic, HelperRegistryEntry,
    HelperRegistryInvocationRequest, HelperRegistryValidationResult, HelperResultValidationFailure,
    HelperResultValidationResult, StagedHelperBinary, fixture_helper_registry,
    normalize_helper_result_value, parse_helper_capability, stage_and_verify_helper_binary,
    validate_helper_key_ref_request, validate_helper_registry_entry_value,
    validate_helper_result_value,
};
#[cfg(test)]
pub(crate) use helper_contracts::{
    FixtureHelperStubAdapter, HelperExecutableAdapter, stage_helper_binary_no_follow,
    staged_helper_binary_name,
};

#[path = "lib/semantic_error.rs"]
mod semantic_error;
pub use semantic_error::SemanticErrorCode;

#[path = "lib/fs_safety.rs"]
mod fs_safety;
pub use fs_safety::{
    atomic_write_bytes, atomic_write_text, promote_staged_directory_no_clobber, safe_join_relative,
    validate_safe_relative_path,
};
use fs_safety::{
    ensure_real_directory, path_has_windows_drive_prefix_component, safe_relative_path_parts,
    write_secret_material_no_clobber,
};

#[cfg(test)]
mod tests;
