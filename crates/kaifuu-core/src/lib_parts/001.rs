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


pub use semantics::*;
pub use hashing::*;
// Crate-private hashing helpers used by remaining lib.rs items + tests.
pub(crate) use hashing::{byte_content_hash, is_sha256_ref, sha256_hex};
pub(crate) use rpgmaker_key_material::{
    decode_hex_material, normalize_rpg_maker_asset_key_material,
};
pub use partial_adapter_report::*;

pub const XP3_PLAIN_MAGIC: &[u8] = b"XP3\r\n \n\x1a\x8b\x67\x01";
pub use xp3_plain::{
    PlainXp3Entry, PlainXp3Inventory, PlainXp3InventoryError, read_plain_xp3_inventory,
};
pub(crate) use xp3_plain::{PlainXp3FileChunk, PlainXp3Segment};
pub use xp3_real_bytes_roundtrip::{
    REAL_BYTES_XP3_SCHEMA_VERSION, REAL_BYTES_XP3_VARIANT, RealBytesXp3AdlerProof,
    RealBytesXp3Archive, RealBytesXp3Entry, RealBytesXp3Segment, XP3_INDEX_ENCODING_RAW,
    XP3_INDEX_ENCODING_ZLIB, read_real_bytes_xp3_archive, real_bytes_xp3_adler_proof,
    repack_real_bytes_xp3_archive,
};

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
pub use adapter_core::*;
pub use adapter_capabilities::*;
pub use layered_access_model::*;
pub use archive_detection_model::*;
#[rustfmt::skip]
pub(crate) use archive_detection_model::{ ArchiveDetectionScan, NON_DETECTED_ARCHIVE_VARIANT, };
#[rustfmt::skip]
pub(crate) use archive_detection_signals::{ Xp3StructuralMarker, detect_kirikiri_xp3, detect_reallive, detect_rpg_maker_mv_mz, detect_siglus, has_orphaned_archive_subtype_marker, has_wolf_rpg_editor_primary_evidence, header_contains_ascii, is_rpg_maker_system_json, lower_path_component, read_header, system_json_has_encryption_fields, xp3_structural_marker, };
#[rustfmt::skip]
pub(crate) use rpgmaker_suffixes::{ RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN, RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES, RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN, RPG_MAKER_MV_MZ_PLAIN_SUFFIXES, RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN, RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES, rpg_maker_mv_mz_surfaces, };
pub use rpgmaker_key_validation::*;
#[rustfmt::skip]
pub(crate) use rpgmaker_key_validation::{ find_rpg_maker_system_json, };
#[rustfmt::skip]
pub(crate) use archive_detection_rows::{ ArchiveRowInput, archive_row, detect_bgi_ethornell, detect_renpy, detect_unknown_archive_variant, detect_wolf_rpg_editor, diagnostic, evidence, file_requirement, secret_requirement, };
pub use engine_profile::*;
pub use helper_profiles::*;
#[rustfmt::skip]
pub(crate) use xp3_profile_model::XP3_HEADER_MAGIC;
pub use xp3_profile_model::*;
pub use xp3_profile_proof::xp3_profile_proof;
#[rustfmt::skip]
pub(crate) use xp3_profile_proof_support::{ classify_xp3_bytes, evaluate_xp3_crypt_profile, validate_xp3_fixture_archive_path, };
pub use encrypted_media_model::*;
pub use encrypted_media_support::*;
#[rustfmt::skip]
pub(crate) use encrypted_media_support::{ classify_encrypted_media_asset, encrypted_media_asset_evidence_hash, encrypted_media_suffix_profile, read_encrypted_media_system_json, validate_encrypted_media_fixture_path, };
pub use key_declarations::*;
pub use secret_stores::*;
pub use key_resolver::*;
pub use secret_redaction_validation::*;
#[rustfmt::skip]
pub(crate) use secret_redaction_validation::{ helper_execution_config_field_is_forbidden, helper_execution_config_field_is_forbidden_at, is_local_absolute_path, is_valid_secret_ref, looks_like_raw_key_material, normalize_secret_field_name, secret_redaction_reason, };
pub use secret_redaction_reporting::*;
#[rustfmt::skip]
pub(crate) use secret_redaction_reporting::{ free_text_requires_redaction, path_starts_with_home_or_local_env_var, redact_asset_ref_for_report, };
pub use profile_requirements::*;
pub use asset_inventory_manifest::*;
pub use asset_inventory_model::*;
#[rustfmt::skip]
pub(crate) use asset_inventory_model::{ required_inventory_failure, validate_asset_inventory_relative_path, validate_asset_inventory_source_location, };
pub use bridge_model::*;
