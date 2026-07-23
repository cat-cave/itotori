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

pub trait EngineAdapter {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> AdapterCapabilities;
    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult>;
    /// Whether this adapter wants an otherwise-undetected result routed back
    /// to it solely to produce a structured diagnostic. The default is false:
    /// a variant alone never promotes an adapter into diagnostic selection.
    fn is_diagnostic_candidate(&self, _detection: &DetectionResult) -> bool {
        false
    }
    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile>;
    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList>;
    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest>;
    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult>;
    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        Ok(PatchResult::preflight_pass(request.patch_export))
    }
    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult>;
    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult>;
}

#[derive(Default)]
pub struct AdapterRegistry {
    adapters: Vec<Box<dyn EngineAdapter>>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<A>(&mut self, adapter: A)
    where
        A: EngineAdapter + 'static,
    {
        self.adapters.push(Box::new(adapter));
        self.adapters.sort_by_key(|adapter| adapter.id());
    }

    pub fn adapters(&self) -> &[Box<dyn EngineAdapter>] {
        &self.adapters
    }

    pub fn get(&self, adapter_id: &str) -> Option<&dyn EngineAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == adapter_id)
            .map(Box::as_ref)
    }

    pub fn detect_all(&self, game_dir: &Path) -> KaifuuResult<Vec<DetectionResult>> {
        let mut results = Vec::new();
        for adapter in &self.adapters {
            let mut result = adapter.detect(DetectRequest { game_dir })?;
            result.normalize();
            results.push(result);
        }
        Ok(results)
    }

    pub fn detect(&self, game_dir: &Path) -> KaifuuResult<Option<DetectionResult>> {
        let mut best = None;
        for result in self.detect_all(game_dir)? {
            if result.detected {
                best = Some(result);
                break;
            }
        }
        Ok(best)
    }

    /// Selects the strongest diagnostic-only result from a registry detection
    /// pass. A diagnostic candidate is explicitly *not* a detected adapter:
    /// it is an adapter that **opts in** via
    /// [`EngineAdapter::is_diagnostic_candidate`] for an input it recognizes
    /// well enough to explain why profiling or inventory cannot proceed.
    /// Eligibility is adapter-owned opt-in (default false). The presence of
    /// `detected_variant` alone is never sufficient — variant strings are
    /// descriptive detection data, not a capability or consent marker.
    /// This selection never changes `DetectionResult::detected` or adapter
    /// capability declarations. Callers may use the selected adapter only to
    /// obtain its structured diagnostic; they must not treat it as supported
    /// for profile, extract, inventory, or patch operations.
    pub fn diagnostic_candidate_from_results(
        &self,
        detections: &[DetectionResult],
    ) -> Option<DetectionResult> {
        let mut best: Option<(usize, usize, DetectionResult)> = None;
        for detection in detections {
            if detection.detected
                || !self
                    .get(&detection.adapter_id)
                    .is_some_and(|adapter| adapter.is_diagnostic_candidate(detection))
            {
                continue;
            }

            let matched_evidence = detection
                .evidence
                .iter()
                .filter(|evidence| evidence.status == EvidenceStatus::Matched)
                .count();
            let diagnostic_evidence = detection
                .evidence
                .iter()
                .filter(|evidence| evidence.status != EvidenceStatus::Informational)
                .count();
            let score = (matched_evidence, diagnostic_evidence);

            // Registry detections are ordered by adapter id. Keeping the
            // first equal-scoring result makes the tie break deterministic.
            if best
                .as_ref()
                .is_none_or(|(best_matched, best_diagnostic, _)| {
                    score > (*best_matched, *best_diagnostic)
                })
            {
                best = Some((matched_evidence, diagnostic_evidence, detection.clone()));
            }
        }
        best.map(|(_, _, detection)| detection)
    }

    /// Runs detection and returns the best diagnostic-only candidate, if an
    /// adapter explicitly recognized an otherwise unsupported input.
    pub fn diagnostic_candidate(&self, game_dir: &Path) -> KaifuuResult<Option<DetectionResult>> {
        Ok(self.diagnostic_candidate_from_results(&self.detect_all(game_dir)?))
    }
}

#[derive(Clone, Copy)]
pub struct DetectRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct ProfileRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct AssetListRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct AssetInventoryRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct ExtractRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct PatchRequest<'a> {
    pub game_dir: &'a Path,
    pub patch_export: &'a PatchExport,
    pub output_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct PatchPreflightRequest<'a> {
    pub game_dir: &'a Path,
    pub patch_export: &'a PatchExport,
}

#[derive(Clone, Copy)]
pub struct VerifyRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Detection,
    Extraction,
    Patching,
    Verification,
    AssetListing,
    AssetInventory,
    NonTextSurfaceExtraction,
    ProfileGeneration,
    LineParityPatching,
    AssetTextPatching,
    DeltaPatching,
    EncryptedInput,
    KeyProfile,
    ContainerAccess,
    CryptoAccess,
    CodecAccess,
    PatchBack,
    RuntimeVm,
}

impl Capability {
    /// the container/crypto/codec/patch "transform axes" whose
    /// `Supported` reports are prone to being over-read as broad transform
    /// support. The identity/null-key-only annotation
    /// ([`CapabilityReport::identity_or_null_key_only`]) is meaningful ONLY for
    /// these capabilities — for anything else there is no broad-transform claim
    /// to over-read.
    pub fn is_transform_bearing(&self) -> bool {
        matches!(
            self,
            Capability::ContainerAccess
                | Capability::CryptoAccess
                | Capability::CodecAccess
                | Capability::PatchBack
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Supported,
    Limited,
    Unsupported,
    RequiresUserInput,
}

/// canonical limitation note attached to an identity/null-key-only
/// capability report ([`CapabilityReport::identity_or_null_key_only`]). A
/// consumer reading only the free-text `limitation` still sees the boundary;
/// the machine-checkable [`CapabilityReport::identity_or_null_key_only`] marker
/// is the authoritative signal.
pub const IDENTITY_OR_NULL_KEY_ONLY_LIMITATION: &str = "identity/null-key-only: this capability is Supported only at the identity \
     rung of the layered access contract (null-key crypto, no archive repack, \
     no binary codec, no bytecode patch-back); no broader container/crypto/\
     codec/patch transform is claimed";

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub capability: Capability,
    pub status: CapabilityStatus,
    pub limitation: Option<String>,
    /// guards against OVER-READING a `Supported`
    /// container/crypto/codec/patch report as broad transform support. When
    /// `true`, the adapter implements only the identity / null-key rung of the
    /// layered access contract for this capability — no real
    /// archive repack, non-null crypto, binary codec, or bytecode patch-back.
    /// Skipped in JSON when `false`, so existing payloads round-trip unchanged
    /// and an ABSENT marker means "no identity/null-key-only claim" — the
    /// report is either a genuine broader transform or a non-transform
    /// capability. Only meaningful for [`Capability::is_transform_bearing`]
    /// capabilities.
    #[serde(default, skip_serializing_if = "is_false")]
    pub identity_or_null_key_only: bool,
}

impl CapabilityReport {
    pub fn supported(capability: Capability) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Supported,
            limitation: None,
            identity_or_null_key_only: false,
        }
    }

    pub fn limited(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Limited,
            limitation: Some(limitation.into()),
            identity_or_null_key_only: false,
        }
    }

    pub fn unsupported(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Unsupported,
            limitation: Some(limitation.into()),
            identity_or_null_key_only: false,
        }
    }

    pub fn requires_user_input(capability: Capability, limitation: impl Into<String>) -> Self {
        Self {
            capability,
            status: CapabilityStatus::RequiresUserInput,
            limitation: Some(limitation.into()),
            identity_or_null_key_only: false,
        }
    }

    /// a container/crypto/codec/patch capability that WORKS
    /// (`Supported`) but only at the identity / null-key rung of the layered
    /// access contract. The report is explicitly annotated
    /// ([`identity_or_null_key_only`](Self::identity_or_null_key_only) = `true`)
    /// AND carries the canonical [`IDENTITY_OR_NULL_KEY_ONLY_LIMITATION`] note,
    /// so a consumer cannot over-read it as broad transform support.
    pub fn identity_or_null_key_only(capability: Capability) -> Self {
        Self {
            capability,
            status: CapabilityStatus::Supported,
            limitation: Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION.to_string()),
            identity_or_null_key_only: true,
        }
    }

    /// annotate an existing report as identity/null-key-only
    /// stating the canonical limitation when none is present. Use when an
    /// adapter has built a `Supported` transform report but its real behaviour
    /// is only the identity/null-key rung.
    pub fn into_identity_or_null_key_only(mut self) -> Self {
        self.identity_or_null_key_only = true;
        if self.limitation.is_none() {
            self.limitation = Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION.to_string());
        }
        self
    }

    /// `true` iff this report explicitly declares identity/null-key
    /// -only behaviour. Consumers use this to DISTINGUISH a genuine broad
    /// transform report (marker absent) from an identity/null-key-only one.
    pub fn is_identity_or_null_key_only(&self) -> bool {
        self.identity_or_null_key_only
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            capability: self.capability.clone(),
            status: self.status.clone(),
            limitation: self.limitation.as_deref().map(redact_for_log_or_report),
            identity_or_null_key_only: self.identity_or_null_key_only,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub adapter_id: String,
    pub reports: Vec<CapabilityReport>,
    /// capability ladder. Every adapter MUST declare its 4-rung
    /// matrix at construction via [`AdapterCapabilities::new`]; there is no
    /// silent fallback that derives it from `reports`. This keeps identify-only
    /// engines from bubbling up to Extract/Patch on granular report drift.
    /// `normalize` uses [`AdapterCapabilityMatrix::derive_from_reports`] only as
    /// a drift-check that the declared matrix never overclaims against `reports`.
    pub level_matrix: AdapterCapabilityMatrix,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_contract: Option<LayeredAccessCapabilityContract>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirements: Vec<AdapterKeyRequirementDeclaration>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub helper_requirements: Vec<AdapterHelperRequirementDeclaration>,
}

impl AdapterCapabilities {
    /// Construct an adapter capability declaration.
    /// acceptance: every adapter MUST declare its 4-rung
    /// [`AdapterCapabilityMatrix`] at construction. There is no silent
    /// fallback from per-`Capability` reports to a derived matrix — that
    /// fallback was the audit-flagged risk (-F002) of recognised
    /// engines accidentally bubbling up to `Extract`/`Patch` because a
    /// granular report drifted. `derive_from_reports` is now a private
    /// drift-check helper used in `normalize` only.
    /// The declared matrix must not claim more than the granular `reports`
    /// support; that constraint is enforced in `normalize` via
    /// `debug_assert!` against `first_overclaim_against`.
    pub fn new(
        adapter_id: impl Into<String>,
        reports: Vec<CapabilityReport>,
        level_matrix: AdapterCapabilityMatrix,
    ) -> Self {
        let mut capabilities = Self {
            adapter_id: adapter_id.into(),
            reports,
            level_matrix,
            access_contract: None,
            key_requirements: vec![],
            helper_requirements: vec![],
        };
        capabilities.normalize();
        capabilities
    }

    pub fn with_access_contract(
        mut self,
        access_contract: LayeredAccessCapabilityContract,
    ) -> Self {
        self.access_contract = Some(access_contract);
        self.normalize();
        self
    }

    pub fn with_key_requirements(
        mut self,
        key_requirements: Vec<AdapterKeyRequirementDeclaration>,
    ) -> Self {
        self.key_requirements = key_requirements;
        self.normalize();
        self
    }

    pub fn with_helper_requirements(
        mut self,
        helper_requirements: Vec<AdapterHelperRequirementDeclaration>,
    ) -> Self {
        self.helper_requirements = helper_requirements;
        self.normalize();
        self
    }

    /// `true` iff this adapter declares a layered access contract
    /// that goes BEYOND the identity/null-key rung (a real container/crypto/
    /// codec/patch transform). When `false` — no contract, or a contract that
    /// is itself identity/null-key-only — any `Supported`
    /// container/crypto/codec/patch report is, at most, identity/null-key
    /// support and MUST be annotated as such to avoid over-read.
    pub fn declares_broader_transform_support(&self) -> bool {
        self.access_contract
            .as_ref()
            .is_some_and(|contract| !contract.is_identity_or_null_key_only())
    }

    /// over-read detector. Returns the transform-bearing
    /// capabilities whose reports are `Supported` but neither annotated
    /// identity/null-key-only NOR backed by a broader transform contract — i.e.
    /// reports a consumer could over-read as broad support. Empty when every
    /// such report is honestly annotated or genuinely backed by broader
    /// support, letting a consumer DISTINGUISH the two.
    pub fn identity_or_null_key_overreads(&self) -> Vec<Capability> {
        if self.declares_broader_transform_support() {
            return Vec::new();
        }
        self.reports
            .iter()
            .filter(|report| {
                report.capability.is_transform_bearing()
                    && report.status == CapabilityStatus::Supported
                    && !report.is_identity_or_null_key_only()
            })
            .map(|report| report.capability.clone())
            .collect()
    }

    pub fn normalize(&mut self) {
        self.reports.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.key_requirements
            .sort_by_key(AdapterKeyRequirementDeclaration::sort_key);
        self.helper_requirements
            .sort_by_key(AdapterHelperRequirementDeclaration::sort_key);
        if let Some(access_contract) = &mut self.access_contract {
            access_contract.normalize();
        }
        // risk: detector report drift. The declared level matrix
        // must never claim more than the per-capability reports support.
        // `derive_from_reports` is conservative; `first_overclaim_against`
        // returns the first rung where the declared matrix is strictly more
        // optimistic than the derived one.
        let derived = AdapterCapabilityMatrix::derive_from_reports(&self.adapter_id, &self.reports);
        debug_assert!(
            self.level_matrix
                .first_overclaim_against(&derived)
                .is_none(),
            "adapter {:?} declared level_matrix overclaims against per-Capability reports at {:?}",
            self.adapter_id,
            self.level_matrix.first_overclaim_against(&derived)
        );
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut capabilities = self.clone();
        capabilities.adapter_id = redact_for_log_or_report(&capabilities.adapter_id);
        capabilities.reports = capabilities
            .reports
            .iter()
            .map(CapabilityReport::redacted_for_report)
            .collect();
        capabilities.key_requirements = capabilities
            .key_requirements
            .iter()
            .map(AdapterKeyRequirementDeclaration::redacted_for_report)
            .collect();
        capabilities.helper_requirements = capabilities
            .helper_requirements
            .iter()
            .map(AdapterHelperRequirementDeclaration::redacted_for_report)
            .collect();
        capabilities.access_contract = capabilities
            .access_contract
            .as_ref()
            .map(LayeredAccessCapabilityContract::redacted_for_report);
        // Redact adapter_id inside the level matrix to match the outer
        // capabilities surface.
        capabilities.level_matrix.adapter_id = capabilities.adapter_id.clone();
        capabilities.normalize();
        capabilities
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerTransform {
    Identity,
    Directory,
    LooseFile,
    ProjectAsset,
    Archive,
    Xp3,
    SiglusPck,
    Rgssad,
    WolfArchive,
    AssetBundle,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CryptoTransform {
    NullKey,
    Xor,
    FixedKey,
    KeyProfile,
    RpgMakerAssetXor,
    RpgMakerAssetKey,
    HelperGated,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodecTransform {
    Identity,
    PngImage,
    M4aAudio,
    OggAudio,
    Utf8Text,
    Utf16Text,
    ShiftJisText,
    JsonText,
    RpgMakerMvMzJson,
    /// TyranoScript KAG-style square-bracket scenario markup (`.ks`): the
    /// `kaifuu-tyrano` plaintext codec (dialogue + choice/link + speaker text).
    TyranoScriptMarkup,
    RubyMarshal,
    BytecodeDecompile,
    BinaryTable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceTransform {
    Identity,
    JsonPointer,
    ArchiveEntry,
    BinaryOffset,
    TableRecord,
    RuntimeTrace,
    OcrRegion,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchBackTransform {
    Identity,
    ReplaceFile,
    RewriteJson,
    RepackArchive,
    RecompileBytecode,
    ReplaceAsset,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessKeyMaterialStatus {
    NotRequired,
    Resolved,
    Missing,
    HelperGated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessHelperStatus {
    NotRequired,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredTextSurfaceAccess {
    pub surface_id: String,
    pub asset_id: String,
    pub path: String,
    pub text_surface: TextSurface,
    pub surface_transform: SurfaceTransform,
    pub surface_selector: String,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub patch_back: PatchBackTransform,
    pub key_material_status: LayeredAccessKeyMaterialStatus,
    pub helper_status: LayeredAccessHelperStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirement_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl LayeredTextSurfaceAccess {
    pub fn plaintext_identity(
        asset_id: impl Into<String>,
        path: impl Into<String>,
        text_surface: TextSurface,
        surface_selector: impl Into<String>,
    ) -> Self {
        let asset_id = asset_id.into();
        let path = path.into();
        let surface_name = serde_json::to_string(&text_surface)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        Self {
            surface_id: format!("{asset_id}#{surface_name}"),
            asset_id,
            path,
            text_surface,
            surface_transform: SurfaceTransform::Identity,
            surface_selector: surface_selector.into(),
            container: ContainerTransform::Identity,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::Identity,
            patch_back: PatchBackTransform::RewriteJson,
            key_material_status: LayeredAccessKeyMaterialStatus::NotRequired,
            helper_status: LayeredAccessHelperStatus::NotRequired,
            key_requirement_refs: vec![],
            notes: vec!["plaintext identity access path; no container unpack, key material, or codec conversion required".to_string()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessProfile {
    pub schema_version: String,
    pub surfaces: Vec<LayeredTextSurfaceAccess>,
}

impl LayeredAccessProfile {
    pub fn plaintext_identity_for_asset(
        asset_id: impl Into<String>,
        path: impl Into<String>,
        text_surfaces: &[TextSurface],
        surface_selector: impl Into<String>,
    ) -> Self {
        let asset_id = asset_id.into();
        let path = path.into();
        let surface_selector = surface_selector.into();
        let mut profile = Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            surfaces: text_surfaces
                .iter()
                .cloned()
                .map(|surface| {
                    LayeredTextSurfaceAccess::plaintext_identity(
                        asset_id.clone(),
                        path.clone(),
                        surface,
                        surface_selector.clone(),
                    )
                })
                .collect(),
        };
        profile.normalize();
        profile
    }

    pub fn normalize(&mut self) {
        for surface in &mut self.surfaces {
            surface.key_requirement_refs.sort();
            surface.key_requirement_refs.dedup();
            surface.notes.sort();
            surface.notes.dedup();
        }
        self.surfaces
            .sort_by_key(|surface| (surface.asset_id.clone(), surface.surface_id.clone()));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessCapabilityContract {
    pub identify: LayeredAccessOperationContract,
    pub inventory: LayeredAccessOperationContract,
    pub extract: LayeredAccessOperationContract,
    pub patch: LayeredAccessOperationContract,
}

impl LayeredAccessCapabilityContract {
    pub fn plaintext_identity() -> Self {
        let identify = LayeredAccessOperationContract::supported_identity(vec![
            Capability::Detection,
            Capability::ProfileGeneration,
        ]);
        let inventory = LayeredAccessOperationContract::supported_identity(vec![
            Capability::AssetListing,
            Capability::AssetInventory,
        ]);
        let extract =
            LayeredAccessOperationContract::supported_identity(vec![Capability::Extraction]);
        let patch = LayeredAccessOperationContract::supported_identity(vec![
            Capability::Patching,
            Capability::LineParityPatching,
        ]);
        Self {
            identify,
            inventory,
            extract,
            patch,
        }
    }

    pub fn normalize(&mut self) {
        self.identify.normalize();
        self.inventory.normalize();
        self.extract.normalize();
        self.patch.normalize();
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            identify: self.identify.redacted_for_report(),
            inventory: self.inventory.redacted_for_report(),
            extract: self.extract.redacted_for_report(),
            patch: self.patch.redacted_for_report(),
        }
    }

    /// `true` iff EVERY operation in this contract stays within the
    /// identity / null-key rung. When true, the contract itself declares no
    /// broader transform support, so any `Supported` container/crypto/codec/
    /// patch report backed only by this contract is identity/null-key-only.
    pub fn is_identity_or_null_key_only(&self) -> bool {
        self.identify.is_identity_or_null_key_only()
            && self.inventory.is_identity_or_null_key_only()
            && self.extract.is_identity_or_null_key_only()
            && self.patch.is_identity_or_null_key_only()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessOperationContract {
    pub status: CapabilityStatus,
    pub required_capabilities: Vec<Capability>,
    pub supported_surfaces: Vec<SurfaceTransform>,
    pub supported_containers: Vec<ContainerTransform>,
    pub supported_crypto: Vec<CryptoTransform>,
    pub supported_codecs: Vec<CodecTransform>,
    pub supported_patch_back: Vec<PatchBackTransform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
}

impl LayeredAccessOperationContract {
    pub fn supported_identity(required_capabilities: Vec<Capability>) -> Self {
        let mut contract = Self {
            status: CapabilityStatus::Supported,
            required_capabilities,
            supported_surfaces: vec![SurfaceTransform::Identity, SurfaceTransform::JsonPointer],
            supported_containers: vec![ContainerTransform::Identity, ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::Identity, CodecTransform::JsonText],
            supported_patch_back: vec![PatchBackTransform::Identity, PatchBackTransform::RewriteJson],
            support_boundary: Some(
                "plaintext identity pipeline only; no archive rebuild, encrypted input, helper, or decompile support claimed"
                    .to_string(),
            ),
        };
        contract.normalize();
        contract
    }

    pub fn normalize(&mut self) {
        self.required_capabilities
            .sort_by_key(|capability| serde_json::to_string(capability).unwrap_or_default());
        self.required_capabilities.dedup();
        self.supported_surfaces.sort();
        self.supported_surfaces.dedup();
        self.supported_containers.sort();
        self.supported_containers.dedup();
        self.supported_crypto.sort();
        self.supported_crypto.dedup();
        self.supported_codecs.sort();
        self.supported_codecs.dedup();
        self.supported_patch_back.sort();
        self.supported_patch_back.dedup();
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut contract = self.clone();
        contract.support_boundary = contract
            .support_boundary
            .as_deref()
            .map(redact_for_log_or_report);
        contract
    }

    /// `true` iff every declared transform stays within the
    /// identity / null-key rung — only identity/loose-file/directory
    /// containers, null-key crypto, plaintext-text codecs, identity/JSON-pointer
    /// surfaces, and identity/JSON-rewrite patch-back. This is exactly the
    /// surface produced by [`Self::supported_identity`]; anything beyond (an
    /// archive container, a non-null crypto, a binary codec, an archive/bytecode
    /// patch-back) makes it `false`, i.e. a genuine broader-transform claim a
    /// consumer can distinguish from identity/null-key-only.
    pub fn is_identity_or_null_key_only(&self) -> bool {
        self.supported_containers.iter().all(|container| {
            matches!(
                container,
                ContainerTransform::Identity
                    | ContainerTransform::LooseFile
                    | ContainerTransform::Directory
            )
        }) && self
            .supported_crypto
            .iter()
            .all(|crypto| matches!(crypto, CryptoTransform::NullKey))
            && self.supported_surfaces.iter().all(|surface| {
                matches!(
                    surface,
                    SurfaceTransform::Identity | SurfaceTransform::JsonPointer
                )
            })
            && self.supported_codecs.iter().all(|codec| {
                matches!(
                    codec,
                    CodecTransform::Identity
                        | CodecTransform::JsonText
                        | CodecTransform::Utf8Text
                        | CodecTransform::Utf16Text
                        | CodecTransform::ShiftJisText
                        | CodecTransform::RpgMakerMvMzJson
                        | CodecTransform::TyranoScriptMarkup
                )
            })
            && self.supported_patch_back.iter().all(|patch_back| {
                matches!(
                    patch_back,
                    PatchBackTransform::Identity | PatchBackTransform::RewriteJson
                )
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub adapter_id: String,
    pub detected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_variant: Option<String>,
    pub evidence: Vec<DetectionEvidence>,
    pub requirements: Vec<ProfileRequirement>,
    pub capabilities: Vec<CapabilityReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionEvidence {
    pub path: String,
    pub kind: String,
    pub status: EvidenceStatus,
    pub detail: String,
}

impl DetectionEvidence {
    fn redacted_for_report(&self) -> Self {
        Self {
            path: redact_asset_ref_for_report(&self.path),
            kind: redact_for_log_or_report(&self.kind),
            status: self.status.clone(),
            detail: redact_for_log_or_report(&self.detail),
        }
    }
}

impl DetectionResult {
    pub fn normalize(&mut self) {
        self.evidence
            .sort_by_key(|evidence| (evidence.path.clone(), evidence.kind.clone()));
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.adapter_id = redact_for_log_or_report(&result.adapter_id);
        result.engine_family = result
            .engine_family
            .as_deref()
            .map(redact_for_log_or_report);
        result.engine_version = result
            .engine_version
            .as_deref()
            .map(redact_for_log_or_report);
        result.detected_variant = result
            .detected_variant
            .as_deref()
            .map(redact_for_log_or_report);
        result.evidence = result
            .evidence
            .iter()
            .map(DetectionEvidence::redacted_for_report)
            .collect();
        result.requirements = result
            .requirements
            .iter()
            .map(ProfileRequirement::redacted_for_report)
            .collect();
        result.capabilities = result
            .capabilities
            .iter()
            .map(CapabilityReport::redacted_for_report)
            .collect();
        result.normalize();
        result
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Matched,
    Missing,
    Invalid,
    Informational,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionReport {
    pub schema_version: String,
    pub game_dir: String,
    pub status: DetectionReportStatus,
    pub detections: Vec<DetectionResult>,
    #[serde(default)]
    pub archive_detection: ArchiveDetectionReport,
    pub warnings: Vec<String>,
}

impl DetectionReport {
    pub fn from_results(game_dir: &Path, detections: Vec<DetectionResult>) -> Self {
        let detections = detections
            .into_iter()
            .map(|detection| detection.redacted_for_report())
            .collect::<Vec<_>>();
        let archive_detection = ArchiveDetectionReport::scan(game_dir);
        let adapter_matched = detections.iter().any(|detection| detection.detected);
        let archive_matched = archive_detection.status == ArchiveDetectionStatus::Matched;
        let status = if adapter_matched {
            DetectionReportStatus::Matched
        } else {
            DetectionReportStatus::Unknown
        };
        let warnings = if !adapter_matched && archive_matched {
            vec![
                "no registered extraction adapter matched this directory; archive detection reported unsupported input diagnostics".to_string(),
            ]
        } else if status == DetectionReportStatus::Unknown {
            vec!["no registered adapter matched this directory".to_string()]
        } else {
            vec![]
        };
        Self {
            schema_version: "0.1.0".to_string(),
            game_dir: REDACTED_DETECTION_GAME_DIR.to_string(),
            status,
            detections,
            archive_detection,
            warnings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionReportStatus {
    Matched,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionReport {
    pub schema_version: String,
    pub status: ArchiveDetectionStatus,
    pub evidence_policy: String,
    pub rows: Vec<ArchiveDetectionRow>,
}

impl Default for ArchiveDetectionReport {
    fn default() -> Self {
        Self::empty()
    }
}

impl ArchiveDetectionReport {
    pub fn empty() -> Self {
        Self {
            schema_version: ARCHIVE_DETECTION_SCHEMA_VERSION.to_string(),
            status: ArchiveDetectionStatus::Unknown,
            evidence_policy: ARCHIVE_DETECTION_EVIDENCE_POLICY.to_string(),
            rows: vec![],
        }
    }

    pub fn scan(game_dir: &Path) -> Self {
        let scan = ArchiveDetectionScan::collect(game_dir);
        let mut rows = vec![
            detect_kirikiri_xp3(&scan),
            detect_siglus(&scan),
            detect_reallive(&scan),
            detect_rpg_maker_mv_mz(&scan),
            detect_wolf_rpg_editor(&scan),
            detect_bgi_ethornell(&scan),
            detect_renpy(&scan),
            detect_unknown_archive_variant(&scan),
        ];
        for row in &mut rows {
            row.normalize();
        }
        let status = if rows.iter().any(|row| row.detected) {
            ArchiveDetectionStatus::Matched
        } else {
            ArchiveDetectionStatus::Unknown
        };
        Self {
            schema_version: ARCHIVE_DETECTION_SCHEMA_VERSION.to_string(),
            status,
            evidence_policy: ARCHIVE_DETECTION_EVIDENCE_POLICY.to_string(),
            rows,
        }
    }
}

const ARCHIVE_DETECTION_EVIDENCE_POLICY: &str = "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized";
const NON_DETECTED_ARCHIVE_VARIANT: &str = "unknown-variant";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveDetectionStatus {
    Matched,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionRow {
    pub row_id: String,
    pub engine_family: ArchiveEngineFamily,
    pub detected: bool,
    pub detected_variant: String,
    pub signals: Vec<ArchiveDetectionSignal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surfaces: Vec<ArchiveDetectionSurface>,
    pub evidence: Vec<ArchiveDetectionEvidence>,
    pub requirements: Vec<ProfileRequirement>,
    pub diagnostics: Vec<DetectionDiagnostic>,
    pub capabilities: Vec<CapabilityReport>,
    pub support_boundary: String,
}

impl ArchiveDetectionRow {
    pub fn normalize(&mut self) {
        if !self.detected {
            self.detected_variant = NON_DETECTED_ARCHIVE_VARIANT.to_string();
        }
        self.signals
            .sort_by_key(|signal| serde_json::to_string(signal).unwrap_or_default());
        self.signals.dedup();
        for surface in &mut self.surfaces {
            surface.key_requirement_refs.sort();
            surface.key_requirement_refs.dedup();
            surface.diagnostics.sort_by_key(|diagnostic| {
                (
                    diagnostic.code.to_string(),
                    serde_json::to_string(&diagnostic.signal).unwrap_or_default(),
                    diagnostic.support_boundary.clone(),
                )
            });
        }
        self.surfaces
            .sort_by_key(|surface| surface.fixture_id.clone());
        self.evidence.sort_by_key(|evidence| {
            (
                serde_json::to_string(&evidence.evidence_type).unwrap_or_default(),
                evidence.pattern.clone(),
                serde_json::to_string(&evidence.status).unwrap_or_default(),
            )
        });
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
        self.diagnostics.sort_by_key(|diagnostic| {
            (
                diagnostic.code.to_string(),
                serde_json::to_string(&diagnostic.signal).unwrap_or_default(),
                diagnostic.support_boundary.clone(),
            )
        });
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionSurface {
    pub fixture_id: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: String,
    pub count: u64,
    pub key_requirement_refs: Vec<String>,
    pub diagnostics: Vec<DetectionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveEngineFamily {
    KiriKiriXp3,
    Siglus,
    #[serde(rename = "reallive")]
    RealLive,
    RpgMakerMvMz,
    WolfRpgEditor,
    BgiEthornell,
    #[serde(rename = "renpy")]
    Renpy,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveDetectionSignal {
    Compressed,
    Encrypted,
    /// Encrypted input was recognized but no reusable crypto capability is
    /// claimed; distinct from `Encrypted` so the detector can emit the
    /// `missing_capability.crypto` diagnostic alongside the encrypted-variant
    /// one (encrypted markers prove detection, not a decryptor).
    CryptoUnsupported,
    Packed,
    /// A layered container/decompression/surface transform (e.g. BGI
    /// CompressedBG) was recognized; handling it needs stacked container +
    /// codec + surface work that lives outside the detection matrix.
    LayeredTransform,
    Protected,
    MissingKey,
    HelperRequired,
    UnknownVariant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDetectionEvidence {
    pub evidence_type: ArchiveEvidenceType,
    pub pattern: String,
    pub status: EvidenceStatus,
    pub count: u64,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveEvidenceType {
    FileExtension,
    FileName,
    FileMagic,
    MetadataField,
    AggregateCount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionDiagnostic {
    pub code: SemanticErrorCode,
    pub signal: ArchiveDetectionSignal,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_capability: Option<Capability>,
    pub support_boundary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

#[derive(Debug, Default)]
struct ArchiveDetectionScan {
    extensions: BTreeMap<String, u64>,
    file_names: BTreeMap<String, u64>,
    headers: Vec<Vec<u8>>,
    orphaned_subtype_marker_count: u64,
    rpg_maker_system_json_encryption_fields: u64,
}

impl ArchiveDetectionScan {
    fn collect(game_dir: &Path) -> Self {
        let mut scan = Self::default();
        scan.visit_dir(game_dir, game_dir);
        scan
    }

    fn visit_dir(&mut self, root: &Path, dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                self.visit_dir(root, &path);
            } else if file_type.is_file() {
                self.record_file(root, &path);
            }
        }
    }

    fn record_file(&mut self, root: &Path, path: &Path) {
        let extension = lower_path_component(path.extension());
        let file_name = lower_path_component(path.file_name());
        if let Some(extension) = extension.as_deref() {
            *self.extensions.entry(extension.to_string()).or_default() += 1;
        }
        if let Some(file_name) = file_name.as_deref() {
            *self.file_names.entry(file_name.to_string()).or_default() += 1;
        }
        let header = read_header(path, 64);
        if has_orphaned_archive_subtype_marker(extension.as_deref(), &header) {
            self.orphaned_subtype_marker_count += 1;
        }
        self.headers.push(header);
        if is_rpg_maker_system_json(root, path) && system_json_has_encryption_fields(path) {
            self.rpg_maker_system_json_encryption_fields += 1;
        }
    }

    fn extension_count(&self, extension: &str) -> u64 {
        self.extensions.get(extension).copied().unwrap_or_default()
    }

    fn extension_counts(&self, extensions: &[&str]) -> u64 {
        extensions
            .iter()
            .map(|extension| self.extension_count(extension))
            .sum()
    }

    fn file_name_count(&self, file_name: &str) -> u64 {
        self.file_names
            .get(&file_name.to_ascii_lowercase())
            .copied()
            .unwrap_or_default()
    }

    fn header_count(&self, needle: &str) -> u64 {
        self.headers
            .iter()
            .filter(|header| header_contains_ascii(header, needle))
            .count() as u64
    }

    fn wolf_rpg_editor_header_count(&self) -> u64 {
        self.headers
            .iter()
            .filter(|header| has_wolf_rpg_editor_primary_evidence(None, header))
            .count() as u64
    }

    fn xp3_header_count(&self) -> u64 {
        self.headers
            .iter()
            .filter(|header| header.starts_with(b"XP3"))
            .count() as u64
    }

    /// Count container headers that carry the given XP3 subtype marker at its
    /// STRUCTURAL position (see [`xp3_structural_marker`]). A genuine plain
    /// XP3 whose member payload happens to contain marker-like text is never
    /// counted — the scan anchors on the container's marker line, not on an
    /// incidental substring anywhere in the early payload bytes.
    fn xp3_structural_marker_count(&self, marker: Xp3StructuralMarker) -> u64 {
        self.headers
            .iter()
            .filter(|header| xp3_structural_marker(header) == Some(marker))
            .count() as u64
    }
}

/// The synthetic XP3 subtype a container header structurally encodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Xp3StructuralMarker {
    Encrypted,
    Compressed,
    Unknown,
}

/// Classify the XP3 subtype a container header signals, recognizing the
/// marker ONLY at its structural position.
/// Synthetic XP3 subtype fixtures share the 5-byte `XP3\r\n` container prefix
/// with a plain archive, then write the subtype token on the single marker
/// line that immediately follows the prefix (for example
/// `XP3\r\nXP3-CRYPT\n…` or `XP3\r\nKAIFUU-XP3-ENCRYPTED`). This function only
/// inspects that structural marker line, so a marker-like string that appears
/// deeper in a member payload cannot be mistaken for a subtype signal.
/// A genuine plain XP3 begins with the full [`XP3_PLAIN_MAGIC`] (byte 5 is a
/// space, never the `X` of a subtype token) and therefore has no marker line:
/// it is always classified plain (`None`), regardless of any marker-like text
/// carried inside its members.
fn xp3_structural_marker(header: &[u8]) -> Option<Xp3StructuralMarker> {
    // A full-magic plain container is authoritatively plain: never scan its
    // payload for a subtype marker.
    if header.starts_with(XP3_PLAIN_MAGIC) {
        return None;
    }
    // The subtype token lives on the marker line right after the container
    // prefix; bound the scan to that single line so trailing payload bytes
    // cannot contribute an incidental match.
    let region = header.strip_prefix(b"XP3\r\n")?;
    let marker_line = match region.iter().position(|&byte| byte == b'\n') {
        Some(newline) => &region[..newline],
        None => region,
    };
    if header_contains_ascii(marker_line, "kaifuu-xp3-unknown")
        || header_contains_ascii(marker_line, "xp3-unknown-variant")
    {
        Some(Xp3StructuralMarker::Unknown)
    } else if header_contains_ascii(marker_line, "kaifuu-xp3-encrypted")
        || header_contains_ascii(marker_line, "xp3-encrypted")
        || header_contains_ascii(marker_line, "xp3-crypt")
    {
        Some(Xp3StructuralMarker::Encrypted)
    } else if header_contains_ascii(marker_line, "kaifuu-xp3-compressed")
        || header_contains_ascii(marker_line, "xp3-compressed")
    {
        Some(Xp3StructuralMarker::Compressed)
    } else {
        None
    }
}

fn lower_path_component(component: Option<&std::ffi::OsStr>) -> Option<String> {
    component.map(|component| component.to_string_lossy().to_ascii_lowercase())
}

fn read_header(path: &Path, limit: usize) -> Vec<u8> {
    let Ok(mut file) = File::open(path) else {
        return vec![];
    };
    let mut buffer = vec![0; limit];
    let Ok(read) = file.read(&mut buffer) else {
        return vec![];
    };
    buffer.truncate(read);
    buffer
}

fn header_contains_ascii(header: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(header)
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn has_wolf_rpg_editor_primary_evidence(extension: Option<&str>, header: &[u8]) -> bool {
    extension == Some("wolf") || header_contains_ascii(header, "WOLF RPG Editor")
}

fn has_orphaned_archive_subtype_marker(extension: Option<&str>, header: &[u8]) -> bool {
    let xp3_marker = header_contains_ascii(header, "kaifuu-xp3-encrypted")
        || header_contains_ascii(header, "xp3-encrypted")
        || header_contains_ascii(header, "xp3-crypt");
    let xp3_primary = extension == Some("xp3") || header.starts_with(b"XP3");

    let bgi_marker = header_contains_ascii(header, "bgi-encrypted")
        || header_contains_ascii(header, "ethornell-encrypted")
        || header_contains_ascii(header, "dsc-compressed")
        || header_contains_ascii(header, "bgi-compressed")
        || header_contains_ascii(header, "compressedbg")
        || header_contains_ascii(header, "compressed-bg");
    let bgi_primary = header_contains_ascii(header, "BURIKO ARC20");

    let wolf_marker = header_contains_ascii(header, "wolf-protected")
        || header_contains_ascii(header, "protection-key");
    let wolf_primary = has_wolf_rpg_editor_primary_evidence(extension, header);

    (xp3_marker && !xp3_primary) || (bgi_marker && !bgi_primary) || (wolf_marker && !wolf_primary)
}

fn is_rpg_maker_system_json(root: &Path, path: &Path) -> bool {
    let Ok(relative_path) = path.strip_prefix(root) else {
        return false;
    };
    let parts = relative_path
        .components()
        .filter_map(|component| component.as_os_str().to_str().map(str::to_ascii_lowercase))
        .collect::<Vec<_>>();
    parts.ends_with(&["data".to_string(), "system.json".to_string()])
        || parts.ends_with(&[
            "www".to_string(),
            "data".to_string(),
            "system.json".to_string(),
        ])
}

fn system_json_has_encryption_fields(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get("hasEncryptedImages")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .get("hasEncryptedAudio")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || value
            .get("encryptionKey")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
}

fn detect_kirikiri_xp3(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let xp3_extension_count = scan.extension_count("xp3");
    let xp3_header_count = scan.xp3_header_count();
    let orphaned_subtype_marker_count = scan.header_count("kaifuu-xp3-encrypted")
        + scan.header_count("xp3-encrypted")
        + scan.header_count("xp3-crypt");
    // Subtype markers are recognized only at their structural position on the
    // container marker line, so a plain XP3 whose member payload contains
    // marker-like text (e.g. an in-scenario "xp3-crypt" string) is never
    // misclassified as encrypted/compressed/unknown.
    let encrypted_marker_count = scan.xp3_structural_marker_count(Xp3StructuralMarker::Encrypted);
    let compressed_marker_count = scan.xp3_structural_marker_count(Xp3StructuralMarker::Compressed);
    let unknown_marker_count = scan.xp3_structural_marker_count(Xp3StructuralMarker::Unknown);
    let detected = xp3_extension_count > 0 || xp3_header_count > 0;
    let mut signals = if detected {
        vec![ArchiveDetectionSignal::Packed]
    } else {
        vec![]
    };
    if encrypted_marker_count > 0 {
        signals.extend([
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
            ArchiveDetectionSignal::HelperRequired,
        ]);
    }
    if compressed_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Compressed);
    }
    if unknown_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::UnknownVariant);
    }
    archive_row(ArchiveRowInput {
        row_id: "kirikiri-xp3",
        engine_family: ArchiveEngineFamily::KiriKiriXp3,
        detected,
        detected_variant: if unknown_marker_count > 0 {
            "xp3-unknown-container"
        } else if encrypted_marker_count > 0 {
            "xp3-encrypted-archive"
        } else if compressed_marker_count > 0 {
            "xp3-compressed-archive"
        } else {
            "xp3-archive"
        },
        marker_only_unknown_variant: !detected && orphaned_subtype_marker_count > 0,
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.xp3",
                xp3_extension_count,
                "XP3 archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "XP3 header",
                xp3_header_count,
                "XP3 archive header count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 encryption marker",
                encrypted_marker_count,
                "Synthetic encrypted XP3 fixture marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 compression marker",
                compressed_marker_count,
                "Synthetic compressed XP3 fixture marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "synthetic XP3 unknown-variant marker",
                unknown_marker_count,
                "Synthetic unknown XP3 container marker count",
            ),
        ],
        requirements: if encrypted_marker_count > 0 {
            vec![secret_requirement(
                "kirikiri-xp3-key-profile",
                "encrypted XP3 variants require local key/profile evidence before pure adapters can proceed",
                "KAIFUU_KIRIKIRI_XP3_KEY_PROFILE",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects XP3 archives and encrypted XP3 markers but does not claim XP3 extraction, decryption, or archive rebuild support in this matrix.",
    })
}

fn detect_siglus(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let scene_pck_count = scan.file_name_count("scene.pck");
    let gameexe_dat_count = scan.file_name_count("gameexe.dat");
    let detected = scene_pck_count > 0 || gameexe_dat_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "siglus-scene-pck",
        engine_family: ArchiveEngineFamily::Siglus,
        detected,
        detected_variant: if scene_pck_count > 0 && gameexe_dat_count > 0 {
            "scene-pck-gameexe-dat"
        } else if scene_pck_count > 0 {
            "scene-pck-without-gameexe-dat"
        } else {
            "gameexe-dat-without-scene-pck"
        },
        marker_only_unknown_variant: false,
        signals: if detected {
            vec![
                ArchiveDetectionSignal::Packed,
                ArchiveDetectionSignal::Encrypted,
                ArchiveDetectionSignal::MissingKey,
                ArchiveDetectionSignal::HelperRequired,
            ]
        } else {
            Vec::new()
        },
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileName,
                "Scene.pck",
                scene_pck_count,
                "Siglus scenario package marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "Gameexe.dat",
                gameexe_dat_count,
                "Siglus executable metadata marker count",
            ),
        ],
        requirements: if detected {
            vec![
                file_requirement(
                    "Scene.pck",
                    scene_pck_count > 0,
                    "Siglus detection expects aggregate evidence for Scene.pck",
                ),
                file_requirement(
                    "Gameexe.dat",
                    gameexe_dat_count > 0,
                    "Siglus secondary-key workflows usually require Gameexe.dat evidence",
                ),
                secret_requirement(
                    "siglus-secondary-key",
                    "Siglus encrypted packages require a local secondary key reference",
                    "KAIFUU_SIGLUS_SECONDARY_KEY",
                ),
            ]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects Siglus package/key-requirement signals only; extraction, secondary-key discovery, and protected executable handling remain helper-gated.",
    })
}

// RealLive archive-detection matrix row.
// Clean-room provenance: all signal names are derived from publicly archived
// RealLive format documentation (Haeleth's RLDEV site) and from publicly
// observable file shape; no rlvm source expression is used. rlvm is a
// research anchor only and is not linked, vendored, or copied.
fn detect_reallive(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let seen_txt_count = scan.file_name_count("seen.txt");
    let seen_gan_count = scan.file_name_count("seen.gan");
    let gameexe_ini_count = scan.file_name_count("gameexe.ini");
    let g00_count = scan.extension_count("g00");
    let voice_archive_count = scan.extension_counts(&["ovk", "koe", "nwk"]);
    let pdt_count = scan.extension_count("pdt");
    let scene_pck_count = scan.file_name_count("scene.pck");
    let gameexe_dat_count = scan.file_name_count("gameexe.dat");
    let reallive_signal_total =
        seen_txt_count + seen_gan_count + gameexe_ini_count + g00_count + voice_archive_count;
    let siglus_marker_present = scene_pck_count > 0 || gameexe_dat_count > 0;
    let avg32_marker_present = pdt_count > 0;
    let positive = reallive_signal_total > 0;
    let ambiguous = positive && siglus_marker_present;
    let unsupported_avg32 = positive
        && !siglus_marker_present
        && avg32_marker_present
        && seen_txt_count > 0
        && gameexe_ini_count == 0;
    let detected = positive && !ambiguous && !unsupported_avg32;
    let detected_variant = if ambiguous {
        if scene_pck_count > 0 {
            "ambiguous-reallive-siglus-scene-pck"
        } else {
            "ambiguous-reallive-siglus-gameexe-dat"
        }
    } else if unsupported_avg32 {
        "avg32-lineage-seen-txt"
    } else if detected {
        "reallive-seen-txt-archive"
    } else {
        "not-reallive"
    };
    let signals = if detected {
        vec![ArchiveDetectionSignal::Packed]
    } else if ambiguous || unsupported_avg32 {
        vec![ArchiveDetectionSignal::UnknownVariant]
    } else {
        Vec::new()
    };
    let support_boundary = "Kaifuu detects RealLive SEEN.TXT/Gameexe.ini/Scene container signals only; extraction, Scene/SEEN decompilation, voice-archive handling, and patch-back remain outside this matrix row.";
    let mut row = archive_row(ArchiveRowInput {
        row_id: "reallive-seen-txt",
        engine_family: ArchiveEngineFamily::RealLive,
        detected,
        detected_variant,
        marker_only_unknown_variant: false,
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileName,
                "SEEN.TXT",
                seen_txt_count,
                "RealLive SEEN.TXT scene archive marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "SEEN.GAN",
                seen_gan_count,
                "RealLive SEEN.GAN animation archive marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileName,
                "Gameexe.ini",
                gameexe_ini_count,
                "RealLive Gameexe.ini configuration manifest marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.g00",
                g00_count,
                "RealLive .g00 image asset count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.ovk|*.koe|*.nwk",
                voice_archive_count,
                "RealLive voice archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.pdt",
                pdt_count,
                "AVG32 .PDT image asset count (corroborates AVG32 lineage when present alongside SEEN.TXT)",
            ),
        ],
        requirements: vec![],
        support_boundary,
    });
    if ambiguous {
        row.diagnostics.push(diagnostic(
            SemanticErrorCode::AmbiguousEngineVariant,
            ArchiveDetectionSignal::UnknownVariant,
            Some(Capability::Detection),
            "RealLive detector requires unambiguous RealLive evidence; co-presence of Siglus markers (Scene.pck/Gameexe.dat) blocks identification.",
            "audit the input directory; remove or relocate cross-engine markers, or report the layout as a new engine variant",
        ));
    }
    if unsupported_avg32 {
        row.diagnostics.push(diagnostic(
            SemanticErrorCode::UnsupportedEngineVariant,
            ArchiveDetectionSignal::UnknownVariant,
            Some(Capability::Detection),
            "RealLive detector does not claim AVG32 lineage support; AVG32-shaped SEEN.TXT inputs are out of scope.",
            "add an AVG32-specific detector (separate node) before localizing this title",
        ));
    }
    row.normalize();
    row
}

fn detect_rpg_maker_mv_mz(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let encrypted_asset_count = scan.extension_counts(RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES);
    let plain_asset_count = scan.extension_counts(RPG_MAKER_MV_MZ_PLAIN_SUFFIXES);
    let unknown_suffix_count = scan.extension_counts(RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES);
    let system_json_count = scan.rpg_maker_system_json_encryption_fields;
    let known_key_requirement = encrypted_asset_count > 0 || system_json_count > 0;
    let detected = known_key_requirement || unknown_suffix_count > 0;
    let mut signals = Vec::new();
    if known_key_requirement {
        signals.extend([
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
        ]);
    }
    if unknown_suffix_count > 0 {
        signals.push(ArchiveDetectionSignal::UnknownVariant);
    }
    archive_row(ArchiveRowInput {
        row_id: "rpg-maker-mv-mz-encrypted-assets",
        engine_family: ArchiveEngineFamily::RpgMakerMvMz,
        detected,
        detected_variant: if known_key_requirement && unknown_suffix_count > 0 {
            "mv_or_mz_with_unknown_suffix"
        } else if unknown_suffix_count > 0 {
            "unknown_suffix"
        } else {
            "mv_or_mz"
        },
        marker_only_unknown_variant: false,
        signals,
        surfaces: rpg_maker_mv_mz_surfaces(scan),
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN,
                encrypted_asset_count,
                "RPG Maker MV/MZ encrypted asset extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN,
                plain_asset_count,
                "RPG Maker MV/MZ plain image/audio asset extension count; does not imply encrypted asset handling",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN,
                unknown_suffix_count,
                "RPG Maker-like encrypted asset suffixes without a known codec/key mapping",
            ),
            evidence(
                ArchiveEvidenceType::MetadataField,
                "data/System.json encryption fields",
                system_json_count,
                "System.json encryption flags or key-field presence count; key values are never serialized",
            ),
        ],
        requirements: if known_key_requirement {
            vec![secret_requirement(
                "rpg-maker-mv-mz-asset-key",
                "encrypted RPG Maker MV/MZ assets require a local asset key reference",
                "KAIFUU_RPG_MAKER_ASSET_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects RPG Maker MV/MZ encrypted asset signals; JSON text patching and encrypted media restoration are separate adapter claims.",
    })
}

const RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES: &[&str] = &[
    "rpgmvp", "rpgmvm", "rpgmvo", "rpgmvu", "png_", "m4a_", "ogg_",
];
const RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN: &str =
    "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.rpgmvu|*.png_|*.m4a_|*.ogg_";
const RPG_MAKER_MV_MZ_PLAIN_SUFFIXES: &[&str] = &["png", "m4a", "ogg"];
const RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN: &str = "*.png|*.m4a|*.ogg";
const RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES: &[&str] = &["webp_"];
const RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN: &str = "*.webp_";

struct RpgMakerSuffixProfile {
    suffix: &'static str,
    fixture_id: &'static str,
    variant: &'static str,
    surface: &'static str,
    crypto: CryptoTransform,
    codec: CodecTransform,
    key_required: bool,
    unknown_crypto: bool,
}

const RPG_MAKER_MV_MZ_SUFFIX_PROFILES: &[RpgMakerSuffixProfile] = &[
    RpgMakerSuffixProfile {
        suffix: "rpgmvp",
        fixture_id: "kaifuu-rpgmaker-mv-image-rpgmvp",
        variant: "mv_or_mz",
        surface: "image_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::PngImage,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "rpgmvm",
        fixture_id: "kaifuu-rpgmaker-mv-audio-rpgmvm",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::M4aAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "rpgmvo",
        fixture_id: "kaifuu-rpgmaker-mv-audio-rpgmvo",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::OggAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "png_",
        fixture_id: "kaifuu-rpgmaker-mz-image-png_",
        variant: "mv_or_mz",
        surface: "image_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::PngImage,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "m4a_",
        fixture_id: "kaifuu-rpgmaker-mz-audio-m4a_",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::M4aAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "ogg_",
        fixture_id: "kaifuu-rpgmaker-mz-audio-ogg_",
        variant: "mv_or_mz",
        surface: "audio_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::OggAudio,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "png",
        fixture_id: "kaifuu-rpgmaker-plain-image-png",
        variant: "plain_asset",
        surface: "image_asset",
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::PngImage,
        key_required: false,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "m4a",
        fixture_id: "kaifuu-rpgmaker-plain-audio-m4a",
        variant: "plain_asset",
        surface: "audio_asset",
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::M4aAudio,
        key_required: false,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "ogg",
        fixture_id: "kaifuu-rpgmaker-plain-audio-ogg",
        variant: "plain_asset",
        surface: "audio_asset",
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::OggAudio,
        key_required: false,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "rpgmvu",
        fixture_id: "kaifuu-rpgmaker-mv-video-rpgmvu",
        variant: "mv_or_mz",
        surface: "video_asset",
        crypto: CryptoTransform::RpgMakerAssetXor,
        codec: CodecTransform::Unknown,
        key_required: true,
        unknown_crypto: false,
    },
    RpgMakerSuffixProfile {
        suffix: "webp_",
        fixture_id: "kaifuu-rpgmaker-unknown-webp_",
        variant: "unknown_suffix",
        surface: "unknown_asset",
        crypto: CryptoTransform::Unknown,
        codec: CodecTransform::Unknown,
        key_required: false,
        unknown_crypto: true,
    },
];

fn rpg_maker_mv_mz_surfaces(scan: &ArchiveDetectionScan) -> Vec<ArchiveDetectionSurface> {
    RPG_MAKER_MV_MZ_SUFFIX_PROFILES
        .iter()
        .filter_map(|profile| {
            let count = scan.extension_count(profile.suffix);
            if count == 0 {
                return None;
            }
            let key_requirement_refs = if profile.key_required {
                vec!["rpg-maker-mv-mz-asset-key".to_string()]
            } else {
                vec![]
            };
            Some(ArchiveDetectionSurface {
                fixture_id: profile.fixture_id.to_string(),
                engine_family: "rpg_maker_mv_mz".to_string(),
                variant: profile.variant.to_string(),
                container: ContainerTransform::ProjectAsset,
                crypto: profile.crypto,
                codec: profile.codec,
                surface: profile.surface.to_string(),
                count,
                key_requirement_refs,
                diagnostics: rpg_maker_surface_diagnostics(profile),
            })
        })
        .collect()
}

fn rpg_maker_surface_diagnostics(profile: &RpgMakerSuffixProfile) -> Vec<DetectionDiagnostic> {
    if profile.unknown_crypto {
        vec![
            diagnostic(
                SemanticErrorCode::UnknownEngineVariant,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::Detection),
                "RPG Maker-like asset suffix has no profiled MV/MZ codec or key mapping.",
                "add a public fixture profile before assigning key requirements",
            ),
            diagnostic(
                SemanticErrorCode::MissingCryptoCapability,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::CryptoAccess),
                "RPG Maker-like asset suffix has no profiled MV/MZ codec or key mapping.",
                "do not request key material until the suffix crypto profile is known",
            ),
        ]
    } else if profile.key_required {
        vec![
            diagnostic(
                SemanticErrorCode::UnsupportedVariantEncrypted,
                ArchiveDetectionSignal::Encrypted,
                Some(Capability::EncryptedInput),
                "RPG Maker MV/MZ encrypted asset suffix detection is not decryption support.",
                "provide a supported key profile only after an adapter explicitly supports encrypted media extraction",
            ),
            diagnostic(
                SemanticErrorCode::MissingKeyMaterial,
                ArchiveDetectionSignal::MissingKey,
                Some(Capability::KeyProfile),
                "RPG Maker MV/MZ encrypted asset suffix maps to the asset-key requirement.",
                "resolve local key material through a secret ref; do not persist raw keys",
            ),
        ]
    } else {
        vec![]
    }
}

pub struct RpgMakerMvMzFixtureKeyValidationRequest<'a, S, E = NoExternalSecretResolver>
where
    S: LocalSecretStore,
    E: ExternalSecretResolver,
{
    pub fixture_id: &'a str,
    pub game_dir: &'a Path,
    pub image_asset_path: &'a Path,
    pub requirement_id: &'a str,
    pub secret_ref: &'a str,
    pub resolver: &'a LocalKeyResolver<S, E>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerMvMzFixtureKeyValidationReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub status: OperationStatus,
    pub support_boundary: String,
    pub records: Vec<RpgMakerMvMzFixtureKeyValidationRecord>,
    pub diagnostics: Vec<RpgMakerMvMzFixtureKeyValidationDiagnostic>,
    pub decrypt_or_patch_claimed: bool,
}

impl RpgMakerMvMzFixtureKeyValidationReport {
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            status: self.status.clone(),
            support_boundary: self.support_boundary.clone(),
            records: self
                .records
                .iter()
                .map(RpgMakerMvMzFixtureKeyValidationRecord::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(RpgMakerMvMzFixtureKeyValidationDiagnostic::redacted_for_report)
                .collect(),
            decrypt_or_patch_claimed: self.decrypt_or_patch_claimed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerMvMzFixtureKeyValidationRecord {
    pub requirement_id: String,
    pub secret_ref_scheme: Option<SecretRefScheme>,
    pub surface: String,
    pub codec: CodecTransform,
    pub diagnostic_result: RpgMakerMvMzFixtureKeyValidationDiagnosticCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_json_proof_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_evidence_hash: Option<ProofHash>,
}

impl RpgMakerMvMzFixtureKeyValidationRecord {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref_scheme: self.secret_ref_scheme,
            surface: self.surface.clone(),
            codec: self.codec,
            diagnostic_result: self.diagnostic_result,
            proof_hash: self.proof_hash.clone(),
            system_json_proof_hash: self.system_json_proof_hash.clone(),
            image_evidence_hash: self.image_evidence_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerMvMzFixtureKeyValidationDiagnostic {
    pub code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode,
    pub semantic_code: SemanticErrorCode,
    pub field: String,
    pub message: String,
}

impl RpgMakerMvMzFixtureKeyValidationDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code,
            semantic_code: self.semantic_code,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpgMakerMvMzFixtureKeyValidationDiagnosticCode {
    Success,
    MissingSystemJson,
    MissingImageEvidence,
    MissingKey,
    BadKey,
    UnsupportedSurface,
}

pub fn validate_rpg_maker_mv_mz_fixture_key<S, E>(
    request: RpgMakerMvMzFixtureKeyValidationRequest<'_, S, E>,
) -> RpgMakerMvMzFixtureKeyValidationReport
where
    S: LocalSecretStore,
    E: ExternalSecretResolver,
{
    let asset_profile = rpg_maker_mv_mz_validation_asset_profile(request.image_asset_path);
    let secret_ref_scheme = SecretRef::new(request.secret_ref.to_string())
        .ok()
        .map(|secret_ref| secret_ref.scheme());
    let image_evidence_hash = rpg_maker_mv_mz_image_evidence_hash(request.image_asset_path);

    let Some(system_json_path) = find_rpg_maker_system_json(request.game_dir) else {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingSystemJson,
            proof_hash: None,
            system_json_proof_hash: None,
            image_evidence_hash,
            field: "gameDir",
            message: "RPG Maker MV/MZ key validation requires data/System.json evidence",
        });
    };

    let system_key = parse_rpg_maker_system_json_key(&system_json_path);
    let system_json_proof_hash = rpg_maker_mv_mz_system_json_proof_hash(&system_json_path);
    let Some(system_key) = system_key else {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash,
            field: "data/System.json.encryptionKey",
            message: "System.json does not contain a fixture-safe MV/MZ encryptionKey value",
        });
    };

    if !asset_profile.supported_image_surface {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::UnsupportedSurface,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash,
            field: "imageAssetPath",
            message: "MV/MZ key validation currently accepts encrypted image surfaces only and does not claim audio or patch support",
        });
    }

    let Some(image_evidence_hash) = image_evidence_hash else {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash: None,
            field: "imageAssetPath",
            message: "encrypted image evidence is missing or unreadable",
        });
    };

    let material = match request.resolver.resolve_secret_ref_str(
        request.requirement_id,
        request.secret_ref,
        KeyMaterialKind::RpgMakerAssetKey,
        Some(16),
    ) {
        Ok(material) => material,
        Err(error) => {
            let (code, message) = match error.kind() {
                KeyResolverErrorKind::MissingSecret => (
                    RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey,
                    "secret ref did not resolve to local fixture key material",
                ),
                KeyResolverErrorKind::InvalidMaterial | KeyResolverErrorKind::ValidationFailed => (
                    RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey,
                    "resolved key material did not match the MV/MZ key shape",
                ),
                _ => (
                    RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey,
                    "secret ref could not be resolved through the local key boundary",
                ),
            };
            return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
                fixture_id: request.fixture_id,
                requirement_id: request.requirement_id,
                secret_ref_scheme,
                asset_profile,
                code,
                proof_hash: None,
                system_json_proof_hash,
                image_evidence_hash: Some(image_evidence_hash),
                field: "secretRef",
                message,
            });
        }
    };

    if !rpg_maker_mv_mz_system_key_matches_material(&system_key, material.as_bytes()) {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash: Some(image_evidence_hash),
            field: "data/System.json.encryptionKey",
            message: "resolved secret ref does not match System.json key evidence",
        });
    }

    let proof_hash = rpg_maker_mv_mz_validation_proof_hash(
        request.requirement_id,
        &system_key,
        &image_evidence_hash,
        material.as_bytes(),
    );
    rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
        fixture_id: request.fixture_id,
        requirement_id: request.requirement_id,
        secret_ref_scheme,
        asset_profile,
        code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success,
        proof_hash,
        system_json_proof_hash,
        image_evidence_hash: Some(image_evidence_hash),
        field: "validation",
        message: "fixture-safe MV/MZ key evidence matched System.json and encrypted image evidence",
    })
}

#[derive(Debug, Clone, Copy)]
struct RpgMakerMvMzValidationAssetProfile {
    surface: &'static str,
    codec: CodecTransform,
    supported_image_surface: bool,
}

struct RpgMakerMvMzKeyValidationReportParams<'a> {
    fixture_id: &'a str,
    requirement_id: &'a str,
    secret_ref_scheme: Option<SecretRefScheme>,
    asset_profile: RpgMakerMvMzValidationAssetProfile,
    code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode,
    proof_hash: Option<ProofHash>,
    system_json_proof_hash: Option<ProofHash>,
    image_evidence_hash: Option<ProofHash>,
    field: &'a str,
    message: &'a str,
}

fn rpg_maker_mv_mz_validation_asset_profile(path: &Path) -> RpgMakerMvMzValidationAssetProfile {
    match lower_path_component(path.extension()).as_deref() {
        Some("rpgmvp" | "png_") => RpgMakerMvMzValidationAssetProfile {
            surface: "image_asset",
            codec: CodecTransform::PngImage,
            supported_image_surface: true,
        },
        Some("rpgmvm" | "m4a_") => RpgMakerMvMzValidationAssetProfile {
            surface: "audio_asset",
            codec: CodecTransform::M4aAudio,
            supported_image_surface: false,
        },
        Some("rpgmvo" | "ogg_") => RpgMakerMvMzValidationAssetProfile {
            surface: "audio_asset",
            codec: CodecTransform::OggAudio,
            supported_image_surface: false,
        },
        _ => RpgMakerMvMzValidationAssetProfile {
            surface: "unknown_asset",
            codec: CodecTransform::Unknown,
            supported_image_surface: false,
        },
    }
}

fn rpg_maker_mv_mz_key_validation_report(
    params: RpgMakerMvMzKeyValidationReportParams<'_>,
) -> RpgMakerMvMzFixtureKeyValidationReport {
    let RpgMakerMvMzKeyValidationReportParams {
        fixture_id,
        requirement_id,
        secret_ref_scheme,
        asset_profile,
        code,
        proof_hash,
        system_json_proof_hash,
        image_evidence_hash,
        field,
        message,
    } = params;
    let status = if code == RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    let semantic_code = match code {
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success => {
            SemanticErrorCode::SecretRedacted
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingSystemJson => {
            SemanticErrorCode::MissingKeyProfile
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence
        | RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey => {
            SemanticErrorCode::KeyValidationFailed
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey => {
            SemanticErrorCode::MissingKeyMaterial
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::UnsupportedSurface => {
            SemanticErrorCode::UnsupportedVariantEncrypted
        }
    };
    RpgMakerMvMzFixtureKeyValidationReport {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        fixture_id: fixture_id.to_string(),
        status,
        support_boundary: "KAIFUU-114 validates fixture-safe MV/MZ key evidence only; it does not decrypt, extract, replace, or patch encrypted media.".to_string(),
        records: vec![RpgMakerMvMzFixtureKeyValidationRecord {
            requirement_id: requirement_id.to_string(),
            secret_ref_scheme,
            surface: asset_profile.surface.to_string(),
            codec: asset_profile.codec,
            diagnostic_result: code,
            proof_hash,
            system_json_proof_hash,
            image_evidence_hash,
        }],
        diagnostics: vec![RpgMakerMvMzFixtureKeyValidationDiagnostic {
            code,
            semantic_code,
            field: field.to_string(),
            message: message.to_string(),
        }],
        decrypt_or_patch_claimed: false,
    }
    .redacted_for_report()
}

fn find_rpg_maker_system_json(root: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_rpg_maker_system_json(root, root, &mut candidates);
    candidates.sort();
    candidates.into_iter().next()
}

fn collect_rpg_maker_system_json(root: &Path, dir: &Path, candidates: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_rpg_maker_system_json(root, &path, candidates);
        } else if file_type.is_file() && is_rpg_maker_system_json(root, &path) {
            candidates.push(path);
        }
    }
}

fn parse_rpg_maker_system_json_key(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    value
        .get("encryptionKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
}

fn rpg_maker_mv_mz_system_json_proof_hash(path: &Path) -> Option<ProofHash> {
    fs::read(path)
        .ok()
        .map(|bytes| sha256_hash_bytes(&bytes))
        .and_then(|hash| ProofHash::new(hash).ok())
}

fn rpg_maker_mv_mz_image_evidence_hash(path: &Path) -> Option<ProofHash> {
    fs::read(path)
        .ok()
        .map(|bytes| sha256_hash_bytes(&bytes[..bytes.len().min(64)]))
        .and_then(|hash| ProofHash::new(hash).ok())
}

fn rpg_maker_mv_mz_system_key_matches_material(system_key: &str, material: &[u8]) -> bool {
    if let Some(bytes) = decode_hex_material(system_key)
        && bytes == material
    {
        return true;
    }
    system_key == "fixture-only-rpg-maker-asset-key-v1"
        && material
            == [
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff,
            ]
}

fn rpg_maker_mv_mz_validation_proof_hash(
    requirement_id: &str,
    system_key: &str,
    image_evidence_hash: &ProofHash,
    material: &[u8],
) -> Option<ProofHash> {
    let mut proof = Vec::new();
    proof.extend_from_slice(b"kaifuu-rpg-maker-mv-mz-key-validation-v0.1\0");
    proof.extend_from_slice(requirement_id.as_bytes());
    proof.push(0);
    proof.extend_from_slice(sha256_hash_bytes(system_key.as_bytes()).as_bytes());
    proof.push(0);
    proof.extend_from_slice(image_evidence_hash.as_str().as_bytes());
    proof.push(0);
    proof.extend_from_slice(material);
    ProofHash::new(sha256_hash_bytes(&proof)).ok()
}

fn detect_wolf_rpg_editor(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let wolf_archive_count = scan.extension_count("wolf");
    let wolf_magic_count = scan.wolf_rpg_editor_header_count();
    let protected_marker_count =
        scan.header_count("wolf-protected") + scan.header_count("protection-key");
    let detected = wolf_archive_count > 0 || wolf_magic_count > 0;
    let mut signals = if detected {
        vec![
            ArchiveDetectionSignal::Packed,
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
            ArchiveDetectionSignal::HelperRequired,
        ]
    } else {
        vec![]
    };
    if protected_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Protected);
    }
    archive_row(ArchiveRowInput {
        row_id: "wolf-rpg-editor-archives",
        engine_family: ArchiveEngineFamily::WolfRpgEditor,
        detected,
        detected_variant: if protected_marker_count > 0 {
            "wolf-protected-archive"
        } else {
            "wolf-archive"
        },
        marker_only_unknown_variant: !detected && protected_marker_count > 0,
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.wolf",
                wolf_archive_count,
                "Wolf RPG Editor archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "WOLF header",
                wolf_magic_count,
                "Wolf archive/header marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "Wolf protection marker",
                protected_marker_count,
                "Synthetic Wolf protection-key marker count",
            ),
        ],
        requirements: if detected {
            vec![secret_requirement(
                "wolf-rpg-editor-archive-key",
                "Wolf RPG Editor protected archives require local key/helper evidence",
                "KAIFUU_WOLF_ARCHIVE_KEY",
            )]
        } else {
            vec![]
        },
        support_boundary: "Kaifuu detects Wolf RPG Editor archive and protection signals; archive decryption, binary database parsing, and rebuilds remain unsupported here.",
    })
}

fn detect_bgi_ethornell(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let arc_extension_count = scan.extension_count("arc");
    let buriko_header_count = scan.header_count("BURIKO ARC20");
    let encrypted_marker_count =
        scan.header_count("bgi-encrypted") + scan.header_count("ethornell-encrypted");
    let compressed_marker_count = scan.header_count("dsc-compressed")
        + scan.header_count("bgi-compressed")
        + scan.header_count("compressedbg")
        + scan.header_count("compressed-bg");
    let layered_marker_count =
        scan.header_count("compressedbg") + scan.header_count("compressed-bg");
    let detected = buriko_header_count > 0;
    let mut signals = if detected {
        vec![
            ArchiveDetectionSignal::Packed,
            ArchiveDetectionSignal::UnknownVariant,
        ]
    } else {
        vec![]
    };
    if encrypted_marker_count > 0 {
        // Encrypted BGI/Ethornell (BSE) markers prove the container is
        // encrypted, but Kaifuu claims no decryptor. Emit BOTH the
        // encrypted-variant signal AND the missing-crypto-capability signal so
        // the live detector agrees with the detector fixtures
        // (BSE profile => unsupported_variant.encrypted + missing_capability.crypto).
        signals.push(ArchiveDetectionSignal::Encrypted);
        signals.push(ArchiveDetectionSignal::CryptoUnsupported);
    }
    if compressed_marker_count > 0 {
        signals.push(ArchiveDetectionSignal::Compressed);
    }
    if layered_marker_count > 0 {
        // CompressedBG is a layered container/codec/surface transform; Kaifuu
        // recognizes it but does not unwrap it. Emit the layered-transform
        // signal so the live detector agrees with the fixtures
        // (CompressedBG profile => unsupported_layered_transform).
        signals.push(ArchiveDetectionSignal::LayeredTransform);
    }
    let detected_variant = if layered_marker_count > 0 {
        "buriko-arc20-compressed-bg-layered-transform"
    } else if compressed_marker_count > 0 {
        "buriko-arc20-dsc-compressed-container"
    } else if encrypted_marker_count > 0 {
        "buriko-arc20-encrypted-container"
    } else {
        "buriko-arc20-container"
    };
    archive_row(ArchiveRowInput {
        row_id: "bgi-ethornell-containers",
        engine_family: ArchiveEngineFamily::BgiEthornell,
        detected,
        detected_variant,
        marker_only_unknown_variant: !detected
            && (encrypted_marker_count > 0
                || compressed_marker_count > 0
                || layered_marker_count > 0),
        signals,
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.arc",
                arc_extension_count,
                "Generic .arc extension count; BGI classification requires BURIKO header evidence",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BURIKO ARC20 header",
                buriko_header_count,
                "BGI/Ethornell archive header count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI encrypted container marker",
                encrypted_marker_count,
                "Synthetic BGI/Ethornell encrypted-container marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI compressed container marker",
                compressed_marker_count,
                "Synthetic BGI/Ethornell compressed-container marker count",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "BGI layered transform marker",
                layered_marker_count,
                "Synthetic BGI/Ethornell layered-transform marker count",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu detects BGI/Ethornell container headers; script decoding, encrypted/compressed/layered container handling, and repacking are not claimed by this matrix.",
    })
}

fn detect_renpy(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let rpa_count = scan.extension_count("rpa");
    let rpyc_count = scan.extension_count("rpyc");
    let detected = rpa_count > 0 || rpyc_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "renpy-packed-inputs",
        engine_family: ArchiveEngineFamily::Renpy,
        detected,
        detected_variant: if rpa_count > 0 && rpyc_count > 0 {
            "rpa-archive-and-rpyc-compiled-script"
        } else if rpa_count > 0 {
            "rpa-archive"
        } else {
            "rpyc-compiled-script"
        },
        marker_only_unknown_variant: false,
        signals: if detected {
            vec![ArchiveDetectionSignal::Packed]
        } else {
            Vec::new()
        },
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.rpa",
                rpa_count,
                "Ren'Py archive extension count",
            ),
            evidence(
                ArchiveEvidenceType::FileExtension,
                "*.rpyc",
                rpyc_count,
                "Ren'Py compiled script extension count",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu detects Ren'Py packed or compiled inputs; plaintext .rpy handling, archive unpacking, and decompilation are separate support claims.",
    })
}

fn detect_unknown_archive_variant(scan: &ArchiveDetectionScan) -> ArchiveDetectionRow {
    let unknown_count = scan
        .extension_counts(&["pak", "bundle", "bin"])
        .saturating_add(
            scan.extension_count("dat")
                .saturating_sub(scan.file_name_count("gameexe.dat")),
        )
        .saturating_add(
            scan.extension_count("pck")
                .saturating_sub(scan.file_name_count("scene.pck")),
        )
        .saturating_add(
            scan.extension_count("arc")
                .saturating_sub(scan.header_count("BURIKO ARC20")),
        )
        .saturating_add(scan.orphaned_subtype_marker_count);
    let detected = unknown_count > 0;
    archive_row(ArchiveRowInput {
        row_id: "unknown-archive-variant",
        engine_family: ArchiveEngineFamily::Unknown,
        detected,
        detected_variant: "unprofiled-archive-like-input",
        marker_only_unknown_variant: false,
        signals: if detected {
            vec![ArchiveDetectionSignal::UnknownVariant]
        } else {
            Vec::new()
        },
        surfaces: vec![],
        evidence: vec![
            evidence(
                ArchiveEvidenceType::AggregateCount,
                "*.pak|*.bundle|*.bin|unprofiled *.dat|*.pck|*.arc",
                unknown_count.saturating_sub(scan.orphaned_subtype_marker_count),
                "Archive-like files not covered by a profiled detector row",
            ),
            evidence(
                ArchiveEvidenceType::FileMagic,
                "orphaned encrypted/protected subtype marker",
                scan.orphaned_subtype_marker_count,
                "Subtype marker evidence without a matching profiled archive/container primary signal",
            ),
        ],
        requirements: vec![],
        support_boundary: "Kaifuu records unknown archive-like inputs as aggregate evidence only; no engine, extraction, or patching support is inferred.",
    })
}

struct ArchiveRowInput {
    row_id: &'static str,
    engine_family: ArchiveEngineFamily,
    detected: bool,
    detected_variant: &'static str,
    marker_only_unknown_variant: bool,
    signals: Vec<ArchiveDetectionSignal>,
    surfaces: Vec<ArchiveDetectionSurface>,
    evidence: Vec<ArchiveDetectionEvidence>,
    requirements: Vec<ProfileRequirement>,
    support_boundary: &'static str,
}

fn archive_row(input: ArchiveRowInput) -> ArchiveDetectionRow {
    let signals = if input.detected {
        input.signals
    } else if input.marker_only_unknown_variant {
        vec![ArchiveDetectionSignal::UnknownVariant]
    } else {
        vec![]
    };
    let requirements = if input.detected {
        input.requirements
    } else {
        vec![]
    };
    let surfaces = if input.detected {
        input.surfaces
    } else {
        vec![]
    };
    let diagnostics = diagnostics_for_signals(&signals, input.support_boundary);
    let capabilities = capabilities_for_archive_row(input.detected, &signals);
    ArchiveDetectionRow {
        row_id: input.row_id.to_string(),
        engine_family: input.engine_family,
        detected: input.detected,
        detected_variant: if input.detected {
            input.detected_variant.to_string()
        } else {
            NON_DETECTED_ARCHIVE_VARIANT.to_string()
        },
        signals,
        surfaces,
        evidence: input.evidence,
        requirements,
        diagnostics,
        capabilities,
        support_boundary: input.support_boundary.to_string(),
    }
}

fn evidence(
    evidence_type: ArchiveEvidenceType,
    pattern: impl Into<String>,
    count: u64,
    detail: impl Into<String>,
) -> ArchiveDetectionEvidence {
    ArchiveDetectionEvidence {
        evidence_type,
        pattern: pattern.into(),
        status: if count > 0 {
            EvidenceStatus::Matched
        } else {
            EvidenceStatus::Missing
        },
        count,
        detail: detail.into(),
    }
}

fn secret_requirement(
    key: impl Into<String>,
    description: impl Into<String>,
    placeholder: impl Into<String>,
) -> ProfileRequirement {
    ProfileRequirement {
        category: RequirementCategory::SecretKey,
        key: key.into(),
        status: RequirementStatus::Missing,
        description: description.into(),
        placeholder: Some(placeholder.into()),
        secret: true,
    }
}

fn file_requirement(
    key: impl Into<String>,
    satisfied: bool,
    description: impl Into<String>,
) -> ProfileRequirement {
    ProfileRequirement {
        category: RequirementCategory::File,
        key: key.into(),
        status: if satisfied {
            RequirementStatus::Satisfied
        } else {
            RequirementStatus::Missing
        },
        description: description.into(),
        placeholder: None,
        secret: false,
    }
}

fn capabilities_for_archive_row(
    detected: bool,
    signals: &[ArchiveDetectionSignal],
) -> Vec<CapabilityReport> {
    let mut capabilities = vec![CapabilityReport::supported(Capability::Detection)];
    if detected {
        capabilities.extend([
            CapabilityReport::unsupported(
                Capability::Extraction,
                "archive/encryption matrix detection is not an extraction support claim",
            ),
            CapabilityReport::unsupported(
                Capability::Patching,
                "archive/encryption matrix detection does not rebuild, decrypt, or patch containers",
            ),
        ]);
    }
    if signals.contains(&ArchiveDetectionSignal::Encrypted) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::EncryptedInput,
            "encrypted input was detected, but decryption support is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::CryptoUnsupported) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::CryptoAccess,
            "encrypted input was recognized, but no reusable crypto capability is claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::Compressed) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::CodecAccess,
            "compressed archive payloads were detected, but decompression support is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::LayeredTransform) {
        capabilities.push(CapabilityReport::unsupported(
            Capability::ContainerAccess,
            "a layered container/codec/surface transform was detected, but unwrapping it is not claimed by the matrix",
        ));
    }
    if signals.contains(&ArchiveDetectionSignal::MissingKey)
        || signals.contains(&ArchiveDetectionSignal::HelperRequired)
    {
        capabilities.push(CapabilityReport::requires_user_input(
            Capability::KeyProfile,
            "recognized protected inputs require local secret refs or helper evidence before future pure adapter work can proceed",
        ));
    }
    capabilities
}

fn diagnostics_for_signals(
    signals: &[ArchiveDetectionSignal],
    support_boundary: &str,
) -> Vec<DetectionDiagnostic> {
    let mut diagnostics = Vec::new();
    for signal in signals {
        match signal {
            ArchiveDetectionSignal::Compressed => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingCodecCapability,
                ArchiveDetectionSignal::Compressed,
                Some(Capability::CodecAccess),
                support_boundary,
                "use an already extracted plaintext source or add a profiled decompression adapter before claiming support",
            )),
            ArchiveDetectionSignal::Encrypted => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedVariantEncrypted,
                ArchiveDetectionSignal::Encrypted,
                Some(Capability::EncryptedInput),
                support_boundary,
                "provide a supported key profile only after an adapter explicitly supports this encrypted variant",
            )),
            ArchiveDetectionSignal::CryptoUnsupported => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingCryptoCapability,
                ArchiveDetectionSignal::CryptoUnsupported,
                Some(Capability::CryptoAccess),
                support_boundary,
                "do not request key material until a decrypting adapter claims this crypto profile; the marker proves detection only",
            )),
            ArchiveDetectionSignal::LayeredTransform => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedLayeredTransform,
                ArchiveDetectionSignal::LayeredTransform,
                Some(Capability::ContainerAccess),
                support_boundary,
                "use already-unwrapped plaintext sources or wait for an adapter that claims this layered container/codec/surface transform",
            )),
            ArchiveDetectionSignal::Packed => diagnostics.push(diagnostic(
                SemanticErrorCode::UnsupportedVariantPacked,
                ArchiveDetectionSignal::Packed,
                Some(Capability::Extraction),
                support_boundary,
                "use already extracted/plaintext sources or wait for an adapter that claims this container",
            )),
            ArchiveDetectionSignal::Protected => diagnostics.push(diagnostic(
                SemanticErrorCode::ProtectedExecutableUnsupported,
                ArchiveDetectionSignal::Protected,
                Some(Capability::KeyProfile),
                support_boundary,
                "use a local helper workflow that reports redacted protection evidence",
            )),
            ArchiveDetectionSignal::MissingKey => diagnostics.push(diagnostic(
                SemanticErrorCode::MissingKeyMaterial,
                ArchiveDetectionSignal::MissingKey,
                Some(Capability::KeyProfile),
                support_boundary,
                "resolve local key material through a secret ref; do not persist raw keys",
            )),
            ArchiveDetectionSignal::HelperRequired => diagnostics.push(diagnostic(
                SemanticErrorCode::HelperUnavailable,
                ArchiveDetectionSignal::HelperRequired,
                Some(Capability::KeyProfile),
                support_boundary,
                "run an explicitly enabled local helper or provide validated local key evidence",
            )),
            ArchiveDetectionSignal::UnknownVariant => diagnostics.push(diagnostic(
                SemanticErrorCode::UnknownEngineVariant,
                ArchiveDetectionSignal::UnknownVariant,
                Some(Capability::Detection),
                support_boundary,
                "add a synthetic public detector fixture or private-local aggregate evidence before claiming support",
            )),
        }
    }
    diagnostics
}

fn diagnostic(
    code: SemanticErrorCode,
    signal: ArchiveDetectionSignal,
    required_capability: Option<Capability>,
    support_boundary: impl Into<String>,
    remediation: impl Into<String>,
) -> DetectionDiagnostic {
    DetectionDiagnostic {
        code,
        signal,
        required_capability,
        support_boundary: support_boundary.into(),
        remediation: Some(remediation.into()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProfile {
    pub schema_version: String,
    pub profile_id: String,
    pub game_id: String,
    pub title: String,
    pub source_locale: String,
    pub engine: EngineProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<SourceFingerprint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_requirements: Vec<KeyRequirement>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archive_parameters: Vec<ArchiveParameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_evidence: Option<HelperEvidence>,
    pub assets: Vec<AssetProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_access: Option<LayeredAccessProfile>,
    pub capabilities: Vec<CapabilityReport>,
    pub requirements: Vec<ProfileRequirement>,
    pub metadata: BTreeMap<String, String>,
}

impl GameProfile {
    pub fn normalize(&mut self) {
        for asset in &mut self.assets {
            asset
                .text_surfaces
                .sort_by_key(|surface| serde_json::to_string(surface).unwrap_or_default());
            asset.text_surfaces.dedup();
        }
        self.assets.sort_by_key(|asset| asset.asset_id.clone());
        if let Some(layered_access) = &mut self.layered_access {
            layered_access.normalize();
        }
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.requirements.sort_by_key(ProfileRequirement::sort_key);
        self.key_requirements.sort_by_key(KeyRequirement::sort_key);
        self.archive_parameters
            .sort_by_key(ArchiveParameter::sort_key);
        if let Some(helper_evidence) = &mut self.helper_evidence {
            helper_evidence.normalize();
        }
    }

    /// Serialize into report-safe, canonical JSON.
    /// Public serialization always routes through the centralized report
    /// redaction policy (`redact_report_value`) so library callers cannot
    /// accidentally leak absolute paths, key material, helper dumps, or
    /// private text into a report/log/fixture. There is no raw public
    /// serialization path for `GameProfile`; the redaction cannot be bypassed
    /// through this API.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        let value = redact_report_value(&serde_json::to_value(&normalized)?);
        Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
    }

    pub fn validate(&self) -> ProfileValidationResult {
        let Ok(value) = serde_json::to_value(self) else {
            return ProfileValidationResult {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                profile_id: Some(self.profile_id.clone()),
                status: OperationStatus::Failed,
                failures: vec![ProfileValidationFailure {
                    code: "profile_serialization_failed".to_string(),
                    field: "$".to_string(),
                    message: "profile could not be serialized for validation".to_string(),
                }],
                requirements: self.requirements.clone(),
            };
        };
        let mut validation = validate_profile_value(&value);
        if validation.requirements.is_empty() {
            validation.requirements.clone_from(&self.requirements);
        }
        validation
    }
}

pub fn validate_profile_value(value: &Value) -> ProfileValidationResult {
    let mut failures = Vec::new();
    if !value.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_profile_shape".to_string(),
            field: "$".to_string(),
            message: "profile must be a JSON object".to_string(),
        });
        return profile_validation_result(None, failures, vec![]);
    }
    add_redaction_failures(&mut failures, value);
    add_profile_helper_execution_field_failures(&mut failures, value);

    let profile_id = required_string_value(&mut failures, value, "profileId");
    validate_schema_version(&mut failures, value);
    required_string_value(&mut failures, value, "gameId");
    required_string_value(&mut failures, value, "title");
    validate_locale_field(&mut failures, value, "sourceLocale");
    validate_engine(&mut failures, value.get("engine"));
    validate_source_fingerprint(&mut failures, value.get("sourceFingerprint"));
    let key_requirements = validate_key_requirements(&mut failures, value.get("keyRequirements"));
    validate_archive_parameters(&mut failures, value.get("archiveParameters"));
    validate_helper_evidence(&mut failures, value.get("helperEvidence"));
    let validated_assets = validate_assets(&mut failures, value.get("assets"));
    validate_layered_access_profile(
        &mut failures,
        value.get("layeredAccess"),
        &validated_assets.asset_ids,
        &key_requirements,
    );
    let profile_capabilities =
        validate_capabilities(&mut failures, value.get("capabilities"), "capabilities");
    for (field, capability) in validated_assets.patching_capabilities {
        if !profile_capabilities.contains(&capability) {
            failures.push(ProfileValidationFailure {
                code: "inconsistent_capability".to_string(),
                field,
                message: format!(
                    "asset patching capability {capability} must also appear in profile capabilities"
                ),
            });
        }
    }
    let requirements = validate_requirements(&mut failures, value.get("requirements"));
    validate_required_key_requirement_matches(&mut failures, &requirements, &key_requirements);

    profile_validation_result(profile_id, failures, requirements)
}

fn profile_validation_result(
    profile_id: Option<String>,
    failures: Vec<ProfileValidationFailure>,
    requirements: Vec<ProfileRequirement>,
) -> ProfileValidationResult {
    ProfileValidationResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id,
        status: if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        failures,
        requirements,
    }
}

fn validate_schema_version(failures: &mut Vec<ProfileValidationFailure>, value: &Value) {
    match value.get("schemaVersion").and_then(Value::as_str) {
        Some(PROFILE_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "schemaVersion".to_string(),
            message: "schemaVersion must not be empty".to_string(),
        }),
        Some(version) => failures.push(ProfileValidationFailure {
            code: "unsupported_schema_version".to_string(),
            field: "schemaVersion".to_string(),
            message: format!("schemaVersion must be {PROFILE_SCHEMA_VERSION}, got {version}"),
        }),
        None => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "schemaVersion".to_string(),
            message: "schemaVersion must not be empty".to_string(),
        }),
    }
}

fn validate_engine(failures: &mut Vec<ProfileValidationFailure>, engine: Option<&Value>) {
    let Some(engine) = engine else {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "engine".to_string(),
            message: "engine must be a JSON object".to_string(),
        });
        return;
    };
    if !engine.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "engine".to_string(),
            message: "engine must be a JSON object".to_string(),
        });
        return;
    }
    let _ = required_string_value(failures, engine, "engine.adapterId");
    let _ = required_string_value(failures, engine, "engine.engineFamily");
    let _ = required_string_value(failures, engine, "engine.detectedVariant");
    if let Some(engine_version) = engine.get("engineVersion")
        && !engine_version.is_null()
        && engine_version
            .as_str()
            .is_none_or(|version| version.trim().is_empty())
    {
        failures.push(ProfileValidationFailure {
            code: "invalid_engine_version".to_string(),
            field: "engine.engineVersion".to_string(),
            message: "engine.engineVersion must be null or a non-empty string".to_string(),
        });
    }
}

fn add_redaction_failures(failures: &mut Vec<ProfileValidationFailure>, value: &Value) {
    for finding in validate_secret_redaction_boundary(value) {
        failures.push(ProfileValidationFailure {
            code: finding.code,
            field: finding.field,
            message: finding.reason,
        });
    }
}

fn add_profile_helper_execution_field_failures(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
) {
    add_profile_helper_execution_field_failures_at(failures, value, "$");
}

fn add_profile_helper_execution_field_failures_at(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, child) in object {
        let child_field = if field == "$" {
            key.clone()
        } else {
            format!("{field}.{key}")
        };
        if helper_execution_config_field_is_forbidden_at(key, &child_field) {
            failures.push(ProfileValidationFailure {
                code: SEMANTIC_HELPER_PROFILE_FORBIDDEN_EXECUTION_FIELD.to_string(),
                field: child_field.clone(),
                message: "profile data must not serialize arbitrary helper commands, args, env, shell, or executable paths".to_string(),
            });
        }
        if child.is_object() {
            add_profile_helper_execution_field_failures_at(failures, child, &child_field);
        } else if let Some(array) = child.as_array() {
            for (index, item) in array.iter().enumerate() {
                add_profile_helper_execution_field_failures_at(
                    failures,
                    item,
                    &format!("{child_field}.{index}"),
                );
            }
        }
    }
}

fn validate_source_fingerprint(
    failures: &mut Vec<ProfileValidationFailure>,
    source_fingerprint: Option<&Value>,
) {
    let Some(source_fingerprint) = source_fingerprint else {
        return;
    };
    let Some(source_fingerprint) = source_fingerprint.as_object() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "sourceFingerprint".to_string(),
            message: "sourceFingerprint must be a JSON object".to_string(),
        });
        return;
    };

    if let Some(game_root_hash) = source_fingerprint.get("gameRootHash")
        && !game_root_hash.is_null()
    {
        validate_sha256_ref_value(failures, game_root_hash, "sourceFingerprint.gameRootHash");
    }

    let Some(engine_evidence) = source_fingerprint.get("engineEvidence") else {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must list local-safe evidence names"
                .to_string(),
        });
        return;
    };
    let Some(engine_evidence) = engine_evidence.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must be an array".to_string(),
        });
        return;
    };
    if engine_evidence.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must not be empty".to_string(),
        });
    }
    for (index, evidence) in engine_evidence.iter().enumerate() {
        let field = format!("sourceFingerprint.engineEvidence.{index}");
        let Some(evidence) = evidence.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "engine evidence must be a string".to_string(),
            });
            continue;
        };
        if evidence.trim().is_empty() {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field,
                message: "engine evidence must not be empty".to_string(),
            });
            continue;
        }
        validate_profile_relative_path(failures, &field, evidence);
    }
}

fn validate_key_requirements(
    failures: &mut Vec<ProfileValidationFailure>,
    key_requirements: Option<&Value>,
) -> Vec<KeyRequirement> {
    let Some(key_requirements) = key_requirements else {
        return vec![];
    };
    let Some(key_requirements) = key_requirements.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "keyRequirements".to_string(),
            message: "keyRequirements must be an array".to_string(),
        });
        return vec![];
    };

    let mut parsed = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, requirement_value) in key_requirements.iter().enumerate() {
        let field = format!("keyRequirements.{index}");
        let Some(requirement_object) = requirement_value.as_object() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "key requirement must be a JSON object".to_string(),
            });
            continue;
        };

        let requirement_id = required_string_value(
            failures,
            requirement_value,
            &format!("{field}.requirementId"),
        );
        let secret_ref =
            required_string_value(failures, requirement_value, &format!("{field}.secretRef"))
                .and_then(|secret_ref| validate_secret_ref(failures, &field, secret_ref));
        let kind = validate_enum_string(
            failures,
            requirement_value,
            &format!("{field}.kind"),
            &[
                "fixedBytes",
                "hexBytes",
                "utf8String",
                "archivePassword",
                "rpgMakerAssetKey",
            ],
        )
        .and_then(|kind| {
            serde_json::from_value::<KeyMaterialKind>(Value::String(kind.clone()))
                .map_err(|_| kind)
                .ok()
        });
        let bytes = validate_optional_positive_u32(
            failures,
            requirement_object.get("bytes"),
            &format!("{field}.bytes"),
        );
        let validation = requirement_object.get("validation").and_then(|validation| {
            validate_key_validation_proof(failures, validation, &format!("{field}.validation"))
        });

        if let Some(requirement_id) = requirement_id.as_deref() {
            if !seen.insert(requirement_id.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_key_requirement".to_string(),
                    field: "keyRequirements".to_string(),
                    message: format!("key requirement {requirement_id} appears more than once"),
                });
            }
            validate_identifier(failures, &format!("{field}.requirementId"), requirement_id);
        }

        if matches!(
            kind,
            Some(KeyMaterialKind::FixedBytes | KeyMaterialKind::HexBytes)
        ) && bytes.is_none()
        {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field: format!("{field}.bytes"),
                message: "fixed and hex key requirements must declare byte length".to_string(),
            });
        }

        if let (Some(requirement_id), Some(secret_ref), Some(kind)) =
            (requirement_id, secret_ref, kind)
        {
            parsed.push(KeyRequirement {
                requirement_id,
                secret_ref,
                kind,
                bytes,
                validation,
            });
        }
    }
    parsed
}

fn validate_required_key_requirement_matches(
    failures: &mut Vec<ProfileValidationFailure>,
    requirements: &[ProfileRequirement],
    key_requirements: &[KeyRequirement],
) {
    let key_requirement_ids = key_requirements
        .iter()
        .map(|requirement| requirement.requirement_id.as_str())
        .collect::<BTreeSet<_>>();
    for requirement in requirements.iter().filter(|requirement| {
        requirement.category == RequirementCategory::SecretKey
            && requirement.status != RequirementStatus::NotRequired
    }) {
        if key_requirement_ids.contains(requirement.key.as_str()) {
            continue;
        }
        failures.push(ProfileValidationFailure {
            code: SemanticErrorCode::MissingKeyProfile.to_string(),
            field: "keyRequirements".to_string(),
            message: format!(
                "required secret key {} must have a matching keyRequirements.requirementId with a valid secretRef",
                requirement.key
            ),
        });
    }
}

fn validate_archive_parameters(
    failures: &mut Vec<ProfileValidationFailure>,
    archive_parameters: Option<&Value>,
) -> Vec<ArchiveParameter> {
    let Some(archive_parameters) = archive_parameters else {
        return vec![];
    };
    let Some(archive_parameters) = archive_parameters.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "archiveParameters".to_string(),
            message: "archiveParameters must be an array".to_string(),
        });
        return vec![];
    };

    let mut parsed = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, parameter) in archive_parameters.iter().enumerate() {
        let field = format!("archiveParameters.{index}");
        let Some(parameter_object) = parameter.as_object() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "archive parameter must be a JSON object".to_string(),
            });
            continue;
        };
        let parameter_id =
            required_string_value(failures, parameter, &format!("{field}.parameterId"));
        let name = required_string_value(failures, parameter, &format!("{field}.name"));
        let kind = validate_enum_string(
            failures,
            parameter,
            &format!("{field}.kind"),
            &[
                "archiveFormat",
                "compression",
                "cipherScheme",
                "encoding",
                "variant",
                "other",
            ],
        )
        .and_then(|kind| {
            serde_json::from_value::<ArchiveParameterKind>(Value::String(kind.clone()))
                .map_err(|_| kind)
                .ok()
        });
        let value = required_string_value(failures, parameter, &format!("{field}.value"));
        let source = parameter_object
            .get("source")
            .and_then(|_| {
                validate_enum_string(
                    failures,
                    parameter,
                    &format!("{field}.source"),
                    &["adapterDefault", "detected", "manual", "helperEvidence"],
                )
            })
            .and_then(|source| {
                serde_json::from_value::<ArchiveParameterSource>(Value::String(source.clone()))
                    .map_err(|_| source)
                    .ok()
            });

        if let Some(parameter_id) = parameter_id.as_deref() {
            if !seen.insert(parameter_id.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_archive_parameter".to_string(),
                    field: "archiveParameters".to_string(),
                    message: format!("archive parameter {parameter_id} appears more than once"),
                });
            }
            validate_identifier(failures, &format!("{field}.parameterId"), parameter_id);
        }

        if let (Some(parameter_id), Some(name), Some(kind), Some(value)) =
            (parameter_id, name, kind, value)
        {
            parsed.push(ArchiveParameter {
                parameter_id,
                name,
                kind,
                value,
                source,
            });
        }
    }
    parsed
}

fn validate_helper_evidence(
    failures: &mut Vec<ProfileValidationFailure>,
    helper_evidence: Option<&Value>,
) -> Option<HelperEvidence> {
    let helper_evidence = helper_evidence?;
    let Some(helper_object) = helper_evidence.as_object() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "helperEvidence".to_string(),
            message: "helperEvidence must be a JSON object".to_string(),
        });
        return None;
    };
    let helper_kind = validate_enum_string(
        failures,
        helper_evidence,
        "helperEvidence.helperKind",
        &[
            "staticParser",
            "knownKeyDatabaseImport",
            "wineLocalWindowsHelper",
            "remoteWindowsHelper",
            "manualKeyEntry",
        ],
    )
    .and_then(|helper_kind| {
        serde_json::from_value::<HelperKind>(Value::String(helper_kind.clone()))
            .map_err(|_| helper_kind)
            .ok()
    });
    let tool_version =
        required_string_value(failures, helper_evidence, "helperEvidence.toolVersion");
    let redacted_log_hash =
        required_string_value(failures, helper_evidence, "helperEvidence.redactedLogHash")
            .and_then(|hash| {
                validate_sha256_ref_string(failures, "helperEvidence.redactedLogHash", hash)
            });
    let proof_hashes = validate_optional_proof_hashes(
        failures,
        helper_object.get("proofHashes"),
        "helperEvidence.proofHashes",
    );

    if let (Some(helper_kind), Some(tool_version), Some(redacted_log_hash)) =
        (helper_kind, tool_version, redacted_log_hash)
    {
        return Some(HelperEvidence {
            helper_kind,
            tool_version,
            redacted_log_hash,
            proof_hashes,
        });
    }
    None
}

fn validate_optional_proof_hashes(
    failures: &mut Vec<ProfileValidationFailure>,
    proof_hashes: Option<&Value>,
    field: &str,
) -> Vec<KeyValidationProof> {
    let Some(proof_hashes) = proof_hashes else {
        return vec![];
    };
    let Some(proof_hashes) = proof_hashes.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "proofHashes must be an array".to_string(),
        });
        return vec![];
    };
    proof_hashes
        .iter()
        .enumerate()
        .filter_map(|(index, proof)| {
            validate_key_validation_proof(failures, proof, &format!("{field}.{index}"))
        })
        .collect()
}

fn validate_key_validation_proof(
    failures: &mut Vec<ProfileValidationFailure>,
    validation: &Value,
    field: &str,
) -> Option<KeyValidationProof> {
    if !validation.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "key validation proof must be a JSON object".to_string(),
        });
        return None;
    }
    let method = validate_enum_string(
        failures,
        validation,
        &format!("{field}.method"),
        &[
            "decryptHeaderProof",
            "archiveIndexProof",
            "knownPlaintextProof",
            "fixtureRoundTripProof",
        ],
    )
    .and_then(|method| {
        serde_json::from_value::<KeyValidationMethod>(Value::String(method.clone()))
            .map_err(|_| method)
            .ok()
    });
    let proof_hash = required_string_value(failures, validation, &format!("{field}.proofHash"))
        .and_then(|hash| validate_sha256_ref_string(failures, &format!("{field}.proofHash"), hash));
    if let (Some(method), Some(proof_hash)) = (method, proof_hash) {
        return Some(KeyValidationProof { method, proof_hash });
    }
    None
}

fn validate_secret_ref(
    failures: &mut Vec<ProfileValidationFailure>,
    parent_field: &str,
    secret_ref: String,
) -> Option<SecretRef> {
    match SecretRef::new(secret_ref) {
        Ok(secret_ref) => Some(secret_ref),
        Err(message) => {
            failures.push(ProfileValidationFailure {
                code: "invalid_secret_ref".to_string(),
                field: format!("{parent_field}.secretRef"),
                message,
            });
            None
        }
    }
}

fn validate_sha256_ref_value(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
) -> Option<ProofHash> {
    let Some(hash) = value.as_str() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_proof_hash".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a sha256:<64 lowercase hex> string"),
        });
        return None;
    };
    validate_sha256_ref_string(failures, field, hash.to_string())
}

fn validate_sha256_ref_string(
    failures: &mut Vec<ProfileValidationFailure>,
    field: &str,
    hash: String,
) -> Option<ProofHash> {
    match ProofHash::new(hash) {
        Ok(hash) => Some(hash),
        Err(message) => {
            failures.push(ProfileValidationFailure {
                code: "invalid_proof_hash".to_string(),
                field: field.to_string(),
                message,
            });
            None
        }
    }
}

fn validate_optional_positive_u32(
    failures: &mut Vec<ProfileValidationFailure>,
    value: Option<&Value>,
    field: &str,
) -> Option<u32> {
    let value = value?;
    let Some(value) = value.as_u64() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a positive integer"),
        });
        return None;
    };
    if value == 0 || value > u32::MAX as u64 {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a positive 32-bit integer"),
        });
        return None;
    }
    Some(value as u32)
}

struct ValidatedAssets {
    patching_capabilities: Vec<(String, String)>,
    asset_ids: std::collections::BTreeSet<String>,
}

fn validate_identifier(failures: &mut Vec<ProfileValidationFailure>, field: &str, value: &str) {
    if value.chars().any(char::is_whitespace) || value.contains('\0') {
        failures.push(ProfileValidationFailure {
            code: "invalid_identifier".to_string(),
            field: field.to_string(),
            message: format!("{field} must not contain whitespace or null bytes"),
        });
    }
}

fn validate_assets(
    failures: &mut Vec<ProfileValidationFailure>,
    assets: Option<&Value>,
) -> ValidatedAssets {
    let mut patching_capabilities = Vec::new();
    let mut asset_ids = std::collections::BTreeSet::new();
    let Some(assets) = assets else {
        failures.push(ProfileValidationFailure {
            code: "missing_assets".to_string(),
            field: "assets".to_string(),
            message: "profile must identify at least one asset or manifest surface".to_string(),
        });
        return ValidatedAssets {
            patching_capabilities,
            asset_ids,
        };
    };
    let Some(assets) = assets.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "assets".to_string(),
            message: "assets must be an array".to_string(),
        });
        return ValidatedAssets {
            patching_capabilities,
            asset_ids,
        };
    };
    if assets.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_assets".to_string(),
            field: "assets".to_string(),
            message: "profile must identify at least one asset or manifest surface".to_string(),
        });
    }
    for (index, asset) in assets.iter().enumerate() {
        let field = format!("assets.{index}");
        if !asset.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "asset must be a JSON object".to_string(),
            });
            continue;
        }
        let asset_id = required_string_value(failures, asset, &format!("assets.{index}.assetId"));
        if asset_id
            .as_deref()
            .is_some_and(|id| id.chars().any(char::is_whitespace) || id.contains('\0'))
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_asset_id".to_string(),
                field: format!("assets.{index}.assetId"),
                message: "assetId must not contain whitespace or null bytes".to_string(),
            });
        }
        if let Some(asset_id) = asset_id
            && !asset_ids.insert(asset_id.clone())
        {
            failures.push(ProfileValidationFailure {
                code: "duplicate_asset_id".to_string(),
                field: format!("assets.{index}.assetId"),
                message: format!("assetId {asset_id} is duplicated"),
            });
        }
        if let Some(path) = required_string_value(failures, asset, &format!("assets.{index}.path"))
        {
            validate_profile_relative_path(failures, &format!("assets.{index}.path"), &path);
        }
        validate_enum_string(
            failures,
            asset,
            &format!("assets.{index}.assetKind"),
            &[
                "script", "database", "metadata", "image", "audio", "archive", "unknown",
            ],
        );
        validate_text_surfaces(failures, asset.get("textSurfaces"), index);
        if let Some(capability) = validate_capability_report(
            failures,
            asset.get("patching"),
            &format!("assets.{index}.patching"),
        ) {
            patching_capabilities.push((format!("assets.{index}.patching.capability"), capability));
        }
        if let Some(source_hash) = asset.get("sourceHash")
            && !source_hash.is_null()
            && source_hash
                .as_str()
                .is_none_or(|hash| hash.trim().is_empty())
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_source_hash".to_string(),
                field: format!("assets.{index}.sourceHash"),
                message: "sourceHash must be null or a non-empty string".to_string(),
            });
        }
    }
    ValidatedAssets {
        patching_capabilities,
        asset_ids,
    }
}

fn validate_layered_access_profile(
    failures: &mut Vec<ProfileValidationFailure>,
    layered_access: Option<&Value>,
    asset_ids: &std::collections::BTreeSet<String>,
    key_requirements: &[KeyRequirement],
) {
    let Some(layered_access) = layered_access else {
        return;
    };
    if !layered_access.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "layeredAccess".to_string(),
            message: "layeredAccess must be a JSON object".to_string(),
        });
        return;
    }
    match layered_access.get("schemaVersion").and_then(Value::as_str) {
        Some(PROFILE_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "layeredAccess.schemaVersion".to_string(),
            message: "layeredAccess.schemaVersion must not be empty".to_string(),
        }),
        Some(version) => failures.push(ProfileValidationFailure {
            code: "unsupported_schema_version".to_string(),
            field: "layeredAccess.schemaVersion".to_string(),
            message: format!(
                "layeredAccess.schemaVersion must be {PROFILE_SCHEMA_VERSION}, got {version}"
            ),
        }),
        None => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "layeredAccess.schemaVersion".to_string(),
            message: "layeredAccess.schemaVersion must not be empty".to_string(),
        }),
    }
    let Some(surfaces) = layered_access.get("surfaces").and_then(Value::as_array) else {
        failures.push(ProfileValidationFailure {
            code: "missing_layered_access_surfaces".to_string(),
            field: "layeredAccess.surfaces".to_string(),
            message: "layeredAccess.surfaces must list per-surface access paths".to_string(),
        });
        return;
    };
    if surfaces.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_layered_access_surfaces".to_string(),
            field: "layeredAccess.surfaces".to_string(),
            message: "layeredAccess.surfaces must list per-surface access paths".to_string(),
        });
    }
    let key_requirement_ids = key_requirements
        .iter()
        .map(|requirement| requirement.requirement_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut seen_surface_ids = std::collections::BTreeSet::new();
    for (index, surface) in surfaces.iter().enumerate() {
        let field = format!("layeredAccess.surfaces.{index}");
        if !surface.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "layered access surface must be a JSON object".to_string(),
            });
            continue;
        }
        if let Some(surface_id) =
            required_string_value(failures, surface, &format!("{field}.surfaceId"))
            && !seen_surface_ids.insert(surface_id.clone())
        {
            failures.push(ProfileValidationFailure {
                code: "duplicate_layered_access_surface".to_string(),
                field: format!("{field}.surfaceId"),
                message: format!("layered access surfaceId {surface_id} is duplicated"),
            });
        }
        if let Some(asset_id) =
            required_string_value(failures, surface, &format!("{field}.assetId"))
            && !asset_ids.contains(&asset_id)
        {
            failures.push(ProfileValidationFailure {
                code: "unknown_layered_access_asset".to_string(),
                field: format!("{field}.assetId"),
                message: format!(
                    "layered access assetId {asset_id} does not reference profile assets"
                ),
            });
        }
        if let Some(path) = required_string_value(failures, surface, &format!("{field}.path")) {
            validate_profile_relative_path(failures, &format!("{field}.path"), &path);
        }
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.textSurface"),
            &[
                "dialogue",
                "narration",
                "speaker_name",
                "choice_label",
                "ui_label",
                "tutorial_text",
                "database_entry",
                "song_title",
                "image_text",
                "metadata_text",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.surfaceTransform"),
            &[
                "identity",
                "json_pointer",
                "archive_entry",
                "binary_offset",
                "table_record",
                "runtime_trace",
                "ocr_region",
                "unknown",
            ],
        );
        required_string_value(failures, surface, &format!("{field}.surfaceSelector"));
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.container"),
            &[
                "identity",
                "directory",
                "loose_file",
                "archive",
                "xp3",
                "siglus_pck",
                "rgssad",
                "wolf_archive",
                "asset_bundle",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.crypto"),
            &[
                "null_key",
                "xor",
                "fixed_key",
                "key_profile",
                "rpg_maker_asset_key",
                "helper_gated",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.codec"),
            &[
                "identity",
                "utf8_text",
                "utf16_text",
                "shift_jis_text",
                "json_text",
                "rpg_maker_mv_mz_json",
                "ruby_marshal",
                "bytecode_decompile",
                "binary_table",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.patchBack"),
            &[
                "identity",
                "replace_file",
                "rewrite_json",
                "repack_archive",
                "recompile_bytecode",
                "replace_asset",
                "unsupported",
                "unknown",
            ],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.keyMaterialStatus"),
            &["not_required", "resolved", "missing", "helper_gated"],
        );
        validate_enum_string(
            failures,
            surface,
            &format!("{field}.helperStatus"),
            &["not_required", "available", "unavailable"],
        );
        validate_layered_access_key_refs(failures, surface, &field, &key_requirement_ids);
    }
}

fn validate_layered_access_key_refs(
    failures: &mut Vec<ProfileValidationFailure>,
    surface: &Value,
    field: &str,
    key_requirement_ids: &std::collections::BTreeSet<&str>,
) {
    let Some(refs) = surface.get("keyRequirementRefs") else {
        return;
    };
    let Some(refs) = refs.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: format!("{field}.keyRequirementRefs"),
            message: "keyRequirementRefs must be an array".to_string(),
        });
        return;
    };
    let mut seen = std::collections::BTreeSet::new();
    for (index, requirement_ref) in refs.iter().enumerate() {
        let requirement_field = format!("{field}.keyRequirementRefs.{index}");
        let Some(requirement_ref) = requirement_ref.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_key_requirement_ref".to_string(),
                field: requirement_field.clone(),
                message: "keyRequirementRefs entries must be strings".to_string(),
            });
            continue;
        };
        if requirement_ref.trim().is_empty() {
            failures.push(ProfileValidationFailure {
                code: "invalid_key_requirement_ref".to_string(),
                field: requirement_field.clone(),
                message: "keyRequirementRefs entries must not be empty".to_string(),
            });
        }
        if !key_requirement_ids.contains(requirement_ref) {
            failures.push(ProfileValidationFailure {
                code: "unknown_key_requirement_ref".to_string(),
                field: requirement_field.clone(),
                message: format!("key requirement ref {requirement_ref} does not reference profile keyRequirements"),
            });
        }
        if !seen.insert(requirement_ref.to_string()) {
            failures.push(ProfileValidationFailure {
                code: "duplicate_key_requirement_ref".to_string(),
                field: requirement_field,
                message: format!("key requirement ref {requirement_ref} is duplicated"),
            });
        }
    }
}

fn validate_text_surfaces(
    failures: &mut Vec<ProfileValidationFailure>,
    text_surfaces: Option<&Value>,
    asset_index: usize,
) {
    let field = format!("assets.{asset_index}.textSurfaces");
    let Some(text_surfaces) = text_surfaces else {
        failures.push(ProfileValidationFailure {
            code: "missing_text_surfaces".to_string(),
            field,
            message: "textSurfaces must list at least one known text surface".to_string(),
        });
        return;
    };
    let Some(text_surfaces) = text_surfaces.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field,
            message: "textSurfaces must be an array".to_string(),
        });
        return;
    };
    if text_surfaces.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_text_surfaces".to_string(),
            field: format!("assets.{asset_index}.textSurfaces"),
            message: "textSurfaces must list at least one known text surface".to_string(),
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for (surface_index, surface) in text_surfaces.iter().enumerate() {
        let field = format!("assets.{asset_index}.textSurfaces.{surface_index}");
        let Some(surface) = surface.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_text_surface".to_string(),
                field,
                message: "text surface must be a known string enum value".to_string(),
            });
            continue;
        };
        if ![
            "dialogue",
            "narration",
            "speaker_name",
            "choice_label",
            "ui_label",
            "tutorial_text",
            "database_entry",
            "song_title",
            "image_text",
            "metadata_text",
        ]
        .contains(&surface)
        {
            failures.push(ProfileValidationFailure {
                code: "invalid_text_surface".to_string(),
                field,
                message: format!("unknown text surface {surface}"),
            });
        }
        if !seen.insert(surface.to_string()) {
            failures.push(ProfileValidationFailure {
                code: "duplicate_text_surface".to_string(),
                field: format!("assets.{asset_index}.textSurfaces"),
                message: format!("text surface {surface} is duplicated"),
            });
        }
    }
}

fn validate_capabilities(
    failures: &mut Vec<ProfileValidationFailure>,
    capabilities: Option<&Value>,
    field: &str,
) -> std::collections::BTreeSet<String> {
    let mut seen = std::collections::BTreeSet::new();
    let Some(capabilities) = capabilities else {
        failures.push(ProfileValidationFailure {
            code: "missing_capabilities".to_string(),
            field: field.to_string(),
            message: "capabilities must list at least one capability report".to_string(),
        });
        return seen;
    };
    let Some(capabilities) = capabilities.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "capabilities must be an array".to_string(),
        });
        return seen;
    };
    if capabilities.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_capabilities".to_string(),
            field: field.to_string(),
            message: "capabilities must list at least one capability report".to_string(),
        });
    }
    for (index, capability) in capabilities.iter().enumerate() {
        let report_field = format!("{field}.{index}");
        let capability_name = validate_capability_report(failures, Some(capability), &report_field);
        if let Some(capability_name) = capability_name
            && !seen.insert(capability_name.clone())
        {
            failures.push(ProfileValidationFailure {
                code: "duplicate_capability".to_string(),
                field: field.to_string(),
                message: format!("capability {capability_name} appears more than once"),
            });
        }
    }
    seen
}

fn validate_capability_report(
    failures: &mut Vec<ProfileValidationFailure>,
    report: Option<&Value>,
    field: &str,
) -> Option<String> {
    let Some(report) = report else {
        failures.push(ProfileValidationFailure {
            code: "missing_capability_report".to_string(),
            field: field.to_string(),
            message: "capability report must be present".to_string(),
        });
        return None;
    };
    if !report.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "capability report must be a JSON object".to_string(),
        });
        return None;
    }
    let capability = validate_enum_string(
        failures,
        report,
        &format!("{field}.capability"),
        &[
            "detection",
            "extraction",
            "patching",
            "verification",
            "asset_listing",
            "asset_inventory",
            "non_text_surface_extraction",
            "profile_generation",
            "line_parity_patching",
            "asset_text_patching",
            "delta_patching",
            "encrypted_input",
            "key_profile",
            "container_access",
            "crypto_access",
            "codec_access",
            "patch_back",
            "runtime_vm",
        ],
    );
    let status = validate_enum_string(
        failures,
        report,
        &format!("{field}.status"),
        &["supported", "limited", "unsupported", "requires_user_input"],
    );
    let limitation = report.get("limitation").and_then(Value::as_str);
    // the machine-checkable identity/null-key-only marker (see
    // `CapabilityReport::identity_or_null_key_only`). Absent → `false`.
    let identity_or_null_key_only = report
        .get("identityOrNullKeyOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if report
        .get("identityOrNullKeyOnly")
        .is_some_and(|value| !value.is_boolean())
    {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: format!("{field}.identityOrNullKeyOnly"),
            message: "identityOrNullKeyOnly must be a boolean".to_string(),
        });
    }
    if matches!(
        status.as_deref(),
        Some("limited" | "unsupported" | "requires_user_input")
    ) && limitation.map_or("", str::trim).is_empty()
    {
        failures.push(ProfileValidationFailure {
            code: "missing_capability_limitation".to_string(),
            field: format!("{field}.limitation"),
            message: "limited, unsupported, and user-input capabilities require a limitation"
                .to_string(),
        });
    }
    // a `supported` report normally must not carry a limitation
    // EXCEPT the explicit identity/null-key-only annotation, which STATES the
    // layered-access boundary so the report cannot be over-read as broad
    // container/crypto/codec/patch transform support.
    if status.as_deref() == Some("supported")
        && limitation.is_some_and(|text| !text.trim().is_empty())
        && !identity_or_null_key_only
    {
        failures.push(ProfileValidationFailure {
            code: "unexpected_capability_limitation".to_string(),
            field: format!("{field}.limitation"),
            message:
                "supported capabilities must not carry a limitation unless annotated identityOrNullKeyOnly"
                    .to_string(),
        });
    }
    // the identity/null-key-only marker is valid only on a
    // `supported` report and MUST state its boundary via a limitation, so the
    // annotation is never silently empty.
    if identity_or_null_key_only {
        if status.as_deref() != Some("supported") {
            failures.push(ProfileValidationFailure {
                code: "invalid_identity_or_null_key_marker".to_string(),
                field: format!("{field}.identityOrNullKeyOnly"),
                message: "identityOrNullKeyOnly is only valid on a supported capability"
                    .to_string(),
            });
        }
        if limitation.map_or("", str::trim).is_empty() {
            failures.push(ProfileValidationFailure {
                code: "missing_identity_or_null_key_limitation".to_string(),
                field: format!("{field}.limitation"),
                message:
                    "identity/null-key-only capabilities must state the boundary in a limitation"
                        .to_string(),
            });
        }
    }
    capability
}

fn validate_requirements(
    failures: &mut Vec<ProfileValidationFailure>,
    requirements: Option<&Value>,
) -> Vec<ProfileRequirement> {
    let Some(requirements) = requirements else {
        failures.push(ProfileValidationFailure {
            code: "missing_requirements".to_string(),
            field: "requirements".to_string(),
            message: "requirements must be an array".to_string(),
        });
        return vec![];
    };
    let Some(requirements) = requirements.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "requirements".to_string(),
            message: "requirements must be an array".to_string(),
        });
        return vec![];
    };
    let mut parsed = Vec::new();
    let mut seen_keys = std::collections::BTreeSet::new();
    for (index, requirement) in requirements.iter().enumerate() {
        let field = format!("requirements.{index}");
        if !requirement.is_object() {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "requirement must be a JSON object".to_string(),
            });
            continue;
        }
        let category = validate_enum_string(
            failures,
            requirement,
            &format!("requirements.{index}.category"),
            &["file", "platform", "secret_key"],
        );
        let key =
            required_string_value(failures, requirement, &format!("requirements.{index}.key"));
        let status = validate_enum_string(
            failures,
            requirement,
            &format!("requirements.{index}.status"),
            &["satisfied", "missing", "not_required", "unsupported"],
        );
        let description = required_string_value(
            failures,
            requirement,
            &format!("requirements.{index}.description"),
        );
        let secret = requirement
            .get("secret")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                failures.push(ProfileValidationFailure {
                    code: "invalid_field_type".to_string(),
                    field: format!("requirements.{index}.secret"),
                    message: "requirement secret must be a boolean".to_string(),
                });
                false
            });
        let placeholder = requirement
            .get("placeholder")
            .and_then(Value::as_str)
            .map(str::to_string);

        if let Some(key) = key.as_deref() {
            if !seen_keys.insert(key.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_requirement_key".to_string(),
                    field: "requirements".to_string(),
                    message: format!("requirement key {key} appears more than once"),
                });
            }
            if key.chars().any(char::is_whitespace) || key.contains('\0') {
                failures.push(ProfileValidationFailure {
                    code: "invalid_requirement_key".to_string(),
                    field: format!("requirements.{index}.key"),
                    message: "requirement key must not contain whitespace or null bytes"
                        .to_string(),
                });
            }
        }
        if secret && status.as_deref() == Some("missing") && placeholder.is_none() {
            failures.push(ProfileValidationFailure {
                code: "missing_secret_placeholder".to_string(),
                field: format!("requirements.{index}.placeholder"),
                message: "missing secret requirements must name a placeholder and never store the secret value".to_string(),
            });
        }
        if secret
            && category.as_deref() == Some("secret_key")
            && status.as_deref() == Some("missing")
        {
            failures.push(ProfileValidationFailure {
                code: SemanticErrorCode::MissingKeyMaterial.to_string(),
                field: key.as_deref().map_or_else(
                    || format!("requirements.{index}"),
                    |key| format!("requirements.{key}"),
                ),
                message: description.clone().unwrap_or_else(|| {
                    "required local key material could not be resolved".to_string()
                }),
            });
        }
        if !secret && placeholder.is_some() {
            failures.push(ProfileValidationFailure {
                code: "unexpected_non_secret_placeholder".to_string(),
                field: format!("requirements.{index}.placeholder"),
                message: "only secret requirements may name placeholders".to_string(),
            });
        }
        if matches!(status.as_deref(), Some("missing" | "unsupported")) {
            failures.push(ProfileValidationFailure {
                code: if status.as_deref() == Some("missing") {
                    "missing_requirement".to_string()
                } else {
                    "unsupported_requirement".to_string()
                },
                field: key.as_deref().map_or_else(
                    || format!("requirements.{index}"),
                    |key| format!("requirements.{key}"),
                ),
                message: description
                    .clone()
                    .unwrap_or_else(|| "profile requirement is not satisfied".to_string()),
            });
        }
        if let (Some(category), Some(key), Some(status), Some(description)) =
            (category, key, status, description)
            && let (Ok(category), Ok(status)) = (
                serde_json::from_value::<RequirementCategory>(Value::String(category)),
                serde_json::from_value::<RequirementStatus>(Value::String(status)),
            )
        {
            parsed.push(ProfileRequirement {
                category,
                key,
                status,
                description,
                placeholder,
                secret,
            });
        }
    }
    parsed
}

fn required_string_value(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    match value.get(key).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => Some(text.to_string()),
        Some(_) | None => {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field: field.to_string(),
                message: format!("{field} must not be empty"),
            });
            None
        }
    }
}

fn validate_enum_string(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
    allowed: &[&str],
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    let Some(text) = value.get(key).and_then(Value::as_str) else {
        failures.push(ProfileValidationFailure {
            code: "invalid_enum_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be one of {}", allowed.join(", ")),
        });
        return None;
    };
    if !allowed.contains(&text) {
        failures.push(ProfileValidationFailure {
            code: "invalid_enum_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be one of {}", allowed.join(", ")),
        });
        return None;
    }
    Some(text.to_string())
}

fn validate_locale_field(failures: &mut Vec<ProfileValidationFailure>, value: &Value, field: &str) {
    let Some(locale) = required_string_value(failures, value, field) else {
        return;
    };
    if !is_bcp47_like_locale(&locale) {
        failures.push(ProfileValidationFailure {
            code: "invalid_locale".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a BCP 47-style locale tag"),
        });
    }
}

fn is_bcp47_like_locale(locale: &str) -> bool {
    let parts = locale.split('-').collect::<Vec<_>>();
    let Some(language) = parts.first() else {
        return false;
    };
    if !(2..=8).contains(&language.len()) || !language.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    parts.iter().skip(1).all(|part| {
        !part.is_empty() && part.len() <= 8 && part.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

fn validate_profile_relative_path(
    failures: &mut Vec<ProfileValidationFailure>,
    field: &str,
    path: &str,
) {
    if validate_safe_relative_path(path).is_err() {
        failures.push(ProfileValidationFailure {
            code: "invalid_asset_path".to_string(),
            field: field.to_string(),
            message:
                "asset path must be relative and must not contain dot components, parent traversal, or drive prefixes"
                    .to_string(),
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfile {
    pub adapter_id: String,
    pub engine_family: String,
    pub engine_version: Option<String>,
    pub detected_variant: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFingerprint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_root_hash: Option<ProofHash>,
    pub engine_evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<KeyValidationProof>,
}

impl KeyRequirement {
    pub fn sort_key(&self) -> (String, String) {
        (
            self.requirement_id.clone(),
            self.secret_ref.as_str().to_string(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyMaterialKind {
    FixedBytes,
    HexBytes,
    Utf8String,
    ArchivePassword,
    RpgMakerAssetKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValidationProof {
    pub method: KeyValidationMethod,
    pub proof_hash: ProofHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyValidationMethod {
    DecryptHeaderProof,
    ArchiveIndexProof,
    KnownPlaintextProof,
    FixtureRoundTripProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretRefScheme {
    LocalSecret,
    OsKeychain,
    SecretManager,
    Prompt,
}

impl SecretRefScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalSecret => "local-secret",
            Self::OsKeychain => "os-keychain",
            Self::SecretManager => "secret-manager",
            Self::Prompt => "prompt",
        }
    }
}

impl fmt::Display for SecretRefScheme {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyResolutionStatus {
    Resolved,
    Missing,
    HelperRequired,
    ExternalStoreUnavailable,
    PromptCancelled,
    OutOfPolicy,
    Malformed,
    ValidationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedKeyProofRecord {
    pub requirement_id: String,
    pub secret_ref_scheme: SecretRefScheme,
    pub material_kind: KeyMaterialKind,
    pub byte_length: usize,
    pub readiness_status: KeyResolutionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_method: Option<KeyValidationMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_tool_version: Option<String>,
}

impl ResolvedKeyProofRecord {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref_scheme: self.secret_ref_scheme,
            material_kind: self.material_kind,
            byte_length: self.byte_length,
            readiness_status: self.readiness_status,
            validation_method: self.validation_method,
            proof_hash: self.proof_hash.clone(),
            helper_tool_version: self
                .helper_tool_version
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }
}

pub struct ResolvedKeyMaterial {
    bytes: Zeroizing<Vec<u8>>,
}

impl ResolvedKeyMaterial {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes: Zeroizing::new(bytes),
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

impl fmt::Debug for ResolvedKeyMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedKeyMaterial")
            .field(
                "bytes",
                &format_args!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            )
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

#[derive(Default)]
pub struct ResolvedKeySet {
    materials: BTreeMap<String, ResolvedKeyMaterial>,
    proof_records: Vec<ResolvedKeyProofRecord>,
}

impl ResolvedKeySet {
    pub fn get(&self, requirement_id: &str) -> Option<&ResolvedKeyMaterial> {
        self.materials.get(requirement_id)
    }

    pub fn get_bytes(&self, requirement_id: &str) -> Option<&[u8]> {
        self.get(requirement_id).map(ResolvedKeyMaterial::as_bytes)
    }

    pub fn proof_records(&self) -> &[ResolvedKeyProofRecord] {
        &self.proof_records
    }

    pub fn redacted_proof_records(&self) -> Vec<ResolvedKeyProofRecord> {
        self.proof_records
            .iter()
            .map(ResolvedKeyProofRecord::redacted_for_report)
            .collect()
    }
}

impl fmt::Debug for ResolvedKeySet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedKeySet")
            .field(
                "requirement_ids",
                &self.materials.keys().collect::<Vec<_>>(),
            )
            .field("proof_records", &self.redacted_proof_records())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParameter {
    pub parameter_id: String,
    pub name: String,
    pub kind: ArchiveParameterKind,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ArchiveParameterSource>,
}

impl ArchiveParameter {
    pub fn sort_key(&self) -> (String, String) {
        (self.parameter_id.clone(), self.name.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveParameterKind {
    ArchiveFormat,
    Compression,
    CipherScheme,
    Encoding,
    Variant,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveParameterSource {
    AdapterDefault,
    Detected,
    Manual,
    HelperEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperEvidence {
    pub helper_kind: HelperKind,
    pub tool_version: String,
    pub redacted_log_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proof_hashes: Vec<KeyValidationProof>,
}

impl HelperEvidence {
    pub fn normalize(&mut self) {
        self.proof_hashes.sort_by_key(|proof| {
            (
                serde_json::to_string(&proof.method).unwrap_or_default(),
                proof.proof_hash.as_str().to_string(),
            )
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperKind {
    StaticParser,
    KnownKeyDatabaseImport,
    WineLocalWindowsHelper,
    RemoteWindowsHelper,
    ManualKeyEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperResult {
    pub schema_version: String,
    pub fixture_id: String,
    pub helper_result_id: String,
    pub profile_id: String,
    pub helper: HelperProvenance,
    pub capability_level: HelperCapabilityLevel,
    pub execution: HelperExecutionSummary,
    pub diagnostic: HelperDiagnostic,
    pub redaction: HelperRedaction,
    #[serde(default)]
    pub secret_refs: Vec<HelperResultSecretRef>,
    #[serde(default)]
    pub proof_hashes: Vec<KeyValidationProof>,
}

impl HelperResult {
    pub fn normalize(&mut self) {
        self.secret_refs.sort_by_key(|secret| {
            (
                secret.requirement_id.clone(),
                secret.secret_ref.as_str().to_string(),
            )
        });
        self.proof_hashes.sort_by_key(|proof| {
            (
                serde_json::to_string(&proof.method).unwrap_or_default(),
                proof.proof_hash.as_str().to_string(),
            )
        });
    }

    pub fn validate(&self) -> HelperResultValidationResult {
        match serde_json::to_value(self) {
            Ok(value) => validate_helper_result_value(&value),
            Err(_) => HelperResultValidationResult {
                schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
                fixture_id: Some(redact_for_log_or_report(&self.fixture_id)),
                status: OperationStatus::Failed,
                failures: vec![HelperResultValidationFailure {
                    fixture_id: Some(redact_for_log_or_report(&self.fixture_id)),
                    code: "helper_result_serialization_failed".to_string(),
                    field: "$".to_string(),
                    message: "helper result could not be serialized for validation".to_string(),
                }],
            },
        }
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.fixture_id = redact_for_log_or_report(&result.fixture_id);
        result.helper_result_id = redact_for_log_or_report(&result.helper_result_id);
        result.profile_id = redact_for_log_or_report(&result.profile_id);
        result.helper = result.helper.redacted_for_report();
        result.execution = result.execution.redacted_for_report();
        result.diagnostic = result.diagnostic.redacted_for_report();
        result.redaction = result.redaction.redacted_for_report();
        result.secret_refs = result
            .secret_refs
            .iter()
            .map(HelperResultSecretRef::redacted_for_report)
            .collect();
        result
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut result = self.redacted_for_report();
        result.normalize();
        stable_json(&result)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperProvenance {
    pub helper_id: String,
    pub helper_version: String,
    pub helper_kind: HelperKind,
}

impl HelperProvenance {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            helper_id: redact_for_log_or_report(&self.helper_id),
            helper_version: redact_for_log_or_report(&self.helper_version),
            helper_kind: self.helper_kind,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperCapabilityLevel {
    StaticAnalysis,
    LocalKeyImport,
    ManualEntry,
    WineLocal,
    WindowsLocal,
    RemoteWindows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperResultExecutionMode {
    NotExecuted,
    InProcess,
    PlatformHelper,
    RemoteHelper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperExecutionFilesystemAccess {
    None,
    TempOnly,
    ReadOnlyWorkspace,
    LocalGameReadOnly,
    HostInherited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperExecutionSummary {
    pub mode: HelperResultExecutionMode,
    pub platform: String,
    pub bounded: bool,
    pub timeout_ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    pub network_access: bool,
    pub filesystem_access: HelperExecutionFilesystemAccess,
}

impl HelperExecutionSummary {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            mode: self.mode,
            platform: redact_for_log_or_report(&self.platform),
            bounded: self.bounded,
            timeout_ms: self.timeout_ms,
            duration_ms: self.duration_ms,
            network_access: self.network_access,
            filesystem_access: self.filesystem_access,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperDiagnostic {
    pub code: HelperDiagnosticCode,
    pub message: String,
}

impl HelperDiagnostic {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperDiagnosticCode {
    Success,
    MissingKey,
    WrongKey,
    HelperRequired,
    HelperUnavailable,
    HelperAuthorizationDenied,
    HelperTimeout,
    ValidationFailed,
    UnsupportedProtectedExecutable,
    RedactionFailure,
}

impl HelperDiagnosticCode {
    pub fn semantic_code(self) -> &'static str {
        match self {
            Self::Success => "kaifuu.helper_result.success",
            Self::MissingKey => SEMANTIC_MISSING_KEY_MATERIAL,
            Self::WrongKey | Self::ValidationFailed => SEMANTIC_KEY_VALIDATION_FAILED,
            Self::HelperRequired => SEMANTIC_HELPER_REQUIRED,
            Self::HelperUnavailable => SEMANTIC_HELPER_UNAVAILABLE,
            Self::HelperAuthorizationDenied => SEMANTIC_HELPER_AUTHORIZATION_DENIED,
            Self::HelperTimeout => SEMANTIC_HELPER_TIMEOUT,
            Self::UnsupportedProtectedExecutable => SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            Self::RedactionFailure => SEMANTIC_HELPER_REDACTION_FAILURE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperRedaction {
    pub status: HelperRedactionStatus,
    pub redacted_log_hash: ProofHash,
}

impl HelperRedaction {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status,
            redacted_log_hash: self.redacted_log_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperRedactionStatus {
    NotRequired,
    Redacted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperResultSecretRef {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub material_kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<KeyValidationProof>,
}

impl HelperResultSecretRef {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            material_kind: self.material_kind,
            bytes: self.bytes,
            validation: self.validation.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalKeyImportSource {
    ManualKeyEntry,
    KnownKeyDatabaseImport,
}

#[derive(Clone, PartialEq, Eq)]
pub struct LocalKeyImportRequest {
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    pub source_hash: ProofHash,
    pub redaction_status: HelperRedactionStatus,
    pub source: LocalKeyImportSource,
    pub material: Vec<u8>,
}

impl fmt::Debug for LocalKeyImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalKeyImportRequest")
            .field("secret_ref", &self.secret_ref)
            .field("key_purpose", &self.key_purpose)
            .field("engine_profile_id", &self.engine_profile_id)
            .field("source_hash", &self.source_hash)
            .field("redaction_status", &self.redaction_status)
            .field("source", &self.source)
            .field(
                "material",
                &format_args!(
                    "[REDACTED:{}; byte_len={}]",
                    SEMANTIC_SECRET_REDACTED,
                    self.material.len()
                ),
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKeyImportResult {
    pub schema_version: String,
    pub import_id: String,
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    pub source_hash: ProofHash,
    pub material_hash: ProofHash,
    pub material_bytes: usize,
    pub redaction_status: HelperRedactionStatus,
    pub source: LocalKeyImportSource,
    pub stored_local_ref: bool,
    pub diagnostics: Vec<LocalKeyImportDiagnostic>,
}

impl LocalKeyImportResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            import_id: redact_for_log_or_report(&self.import_id),
            secret_ref: self.secret_ref.clone(),
            key_purpose: redact_for_log_or_report(&self.key_purpose),
            engine_profile_id: redact_for_log_or_report(&self.engine_profile_id),
            source_hash: self.source_hash.clone(),
            material_hash: self.material_hash.clone(),
            material_bytes: self.material_bytes,
            redaction_status: self.redaction_status,
            source: self.source,
            stored_local_ref: self.stored_local_ref,
            diagnostics: self
                .diagnostics
                .iter()
                .map(LocalKeyImportDiagnostic::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKeyImportDiagnostic {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl LocalKeyImportDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusParserBoundarySmokeVariant {
    ParserBoundarySuccess,
    HelperRequired,
    MissingKey,
    UnsupportedOpcode,
    OutOfProfile,
}

#[derive(Debug, Clone, Copy)]
pub struct SiglusParserBoundarySmokeRequest<'a> {
    pub scene_path: &'a Path,
    pub gameexe_path: &'a Path,
    pub key_request: Option<&'a Value>,
    pub variant: SiglusParserBoundarySmokeVariant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiglusParserBoundaryOutcome {
    ParserBoundarySuccess,
    HelperRequired,
    MissingKey,
    UnsupportedOpcode,
    OutOfProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub outcome: SiglusParserBoundaryOutcome,
    pub support_boundary: String,
    pub patch_write_attempted: bool,
    pub sources: Vec<SiglusParserBoundarySource>,
    pub key_refs: Vec<SiglusParserBoundaryKeyRef>,
    pub text_slots: Vec<SiglusParserBoundaryTextSlot>,
    pub diagnostics: Vec<SiglusParserBoundaryDiagnostic>,
}

impl SiglusParserBoundaryReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            outcome: self.outcome,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            patch_write_attempted: self.patch_write_attempted,
            sources: self
                .sources
                .iter()
                .map(SiglusParserBoundarySource::redacted_for_report)
                .collect(),
            key_refs: self
                .key_refs
                .iter()
                .map(SiglusParserBoundaryKeyRef::redacted_for_report)
                .collect(),
            text_slots: self
                .text_slots
                .iter()
                .map(SiglusParserBoundaryTextSlot::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(SiglusParserBoundaryDiagnostic::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundarySource {
    pub asset_id: String,
    pub path: String,
    pub source_hash: ProofHash,
}

impl SiglusParserBoundarySource {
    fn redacted_for_report(&self) -> Self {
        Self {
            asset_id: redact_for_log_or_report(&self.asset_id),
            path: redact_for_log_or_report(&self.path),
            source_hash: self.source_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryKeyRef {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    pub source_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    pub redaction_status: HelperRedactionStatus,
}

impl SiglusParserBoundaryKeyRef {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_purpose: redact_for_log_or_report(&self.key_purpose),
            engine_profile_id: redact_for_log_or_report(&self.engine_profile_id),
            source_hash: self.source_hash.clone(),
            material_hash: self.material_hash.clone(),
            bytes: self.bytes,
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryTextSlot {
    pub text_slot_id: String,
    pub asset_id: String,
    pub source_hash: ProofHash,
    pub byte_span: SiglusParserBoundaryByteSpan,
    pub text_surface: String,
    pub parser_opcode: String,
}

impl SiglusParserBoundaryTextSlot {
    fn redacted_for_report(&self) -> Self {
        Self {
            text_slot_id: redact_for_log_or_report(&self.text_slot_id),
            asset_id: redact_for_log_or_report(&self.asset_id),
            source_hash: self.source_hash.clone(),
            byte_span: self.byte_span.clone(),
            text_surface: redact_for_log_or_report(&self.text_surface),
            parser_opcode: redact_for_log_or_report(&self.parser_opcode),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryByteSpan {
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryDiagnostic {
    pub code: String,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_opcode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_span: Option<SiglusParserBoundaryByteSpan>,
}

impl SiglusParserBoundaryDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            unsupported_opcode: self.unsupported_opcode.clone(),
            byte_span: self.byte_span.clone(),
        }
    }
}

pub fn run_siglus_known_key_parser_boundary_smoke(
    request: SiglusParserBoundarySmokeRequest<'_>,
) -> KaifuuResult<SiglusParserBoundaryReport> {
    const PROFILE_ID: &str = "019ed000-0000-7000-8000-000000091001";
    const SUPPORT_BOUNDARY: &str = "Synthetic KAIFUU-093 parser-boundary smoke only; this report validates key-ref plumbing and parser diagnostics for fixture inputs and does not claim production Siglus extraction, decryption, patch-back, or runtime compatibility.";

    let scene_hash = ProofHash::new(sha256_file_ref(request.scene_path)?)?;
    let gameexe_hash = ProofHash::new(sha256_file_ref(request.gameexe_path)?)?;
    let sources = vec![
        SiglusParserBoundarySource {
            asset_id: "siglus-scene-pck".to_string(),
            path: "Scene.pck".to_string(),
            source_hash: scene_hash.clone(),
        },
        SiglusParserBoundarySource {
            asset_id: "siglus-gameexe-dat".to_string(),
            path: "Gameexe.dat".to_string(),
            source_hash: gameexe_hash,
        },
    ];

    if request.variant == SiglusParserBoundarySmokeVariant::HelperRequired {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            vec![],
            vec![],
            SiglusParserBoundaryOutcome::HelperRequired,
            vec![SiglusParserBoundaryDiagnostic {
                code: "helper_required".to_string(),
                field: "keyRequest".to_string(),
                message: "parser-boundary smoke requires a KAIFUU-087 key-ref helper request"
                    .to_string(),
                semantic_code: Some(SEMANTIC_HELPER_REQUIRED.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    }

    let Some(key_request) = request.key_request else {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            vec![],
            vec![],
            SiglusParserBoundaryOutcome::HelperRequired,
            vec![SiglusParserBoundaryDiagnostic {
                code: "helper_required".to_string(),
                field: "keyRequest".to_string(),
                message: "parser-boundary smoke requires a KAIFUU-087 key-ref helper request"
                    .to_string(),
                semantic_code: Some(SEMANTIC_HELPER_REQUIRED.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    };

    let mut effective_key_request = key_request.clone();
    if request.variant == SiglusParserBoundarySmokeVariant::MissingKey {
        effective_key_request["keyRefs"] = Value::Array(vec![]);
    }

    let key_refs = siglus_parser_boundary_key_refs(&effective_key_request)?;
    if request.variant == SiglusParserBoundarySmokeVariant::OutOfProfile
        || effective_key_request
            .get("engineProfileId")
            .and_then(Value::as_str)
            .is_some_and(|profile_id| profile_id != PROFILE_ID)
        || effective_key_request
            .get("sourceHash")
            .and_then(Value::as_str)
            .is_some_and(|source_hash| source_hash != scene_hash.as_str())
    {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            key_refs,
            vec![],
            SiglusParserBoundaryOutcome::OutOfProfile,
            vec![SiglusParserBoundaryDiagnostic {
                code: "out_of_profile".to_string(),
                field: "keyRequest".to_string(),
                message: "key-ref request must match the synthetic Siglus parser-boundary profile id and Scene.pck source hash".to_string(),
                semantic_code: Some(SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    }

    let registry = fixture_helper_registry()?;
    let helper_output = registry.invoke(HelperRegistryInvocationRequest {
        helper_id: effective_key_request
            .get("helperId")
            .and_then(Value::as_str)
            .unwrap_or(FIXTURE_HELPER_REGISTRY_ID),
        helper_version: effective_key_request
            .get("helperVersion")
            .and_then(Value::as_str)
            .unwrap_or("0.1.0"),
        allowlist_entry_id: effective_key_request
            .get("allowlistEntryId")
            .and_then(Value::as_str)
            .unwrap_or(FIXTURE_HELPER_ALLOWLIST_REF_ID),
        capability: HelperCapability::KeyValidation,
        input: &effective_key_request,
    })?;
    let helper_code = helper_output
        .pointer("/diagnostic/code")
        .and_then(Value::as_str)
        .unwrap_or("validation_failed");
    if helper_code != "success" {
        let (outcome, semantic_code) = match helper_code {
            "missing_key" => (
                SiglusParserBoundaryOutcome::MissingKey,
                SEMANTIC_MISSING_KEY_MATERIAL,
            ),
            "helper_required" => (
                SiglusParserBoundaryOutcome::HelperRequired,
                SEMANTIC_HELPER_REQUIRED,
            ),
            _ => (
                SiglusParserBoundaryOutcome::OutOfProfile,
                SEMANTIC_KEY_VALIDATION_FAILED,
            ),
        };
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            key_refs,
            vec![],
            outcome,
            vec![SiglusParserBoundaryDiagnostic {
                code: helper_code.to_string(),
                field: "keyRequest".to_string(),
                message: helper_output
                    .pointer("/diagnostic/message")
                    .and_then(Value::as_str)
                    .unwrap_or(semantic_code)
                    .to_string(),
                semantic_code: Some(semantic_code.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    }

    if request.variant == SiglusParserBoundarySmokeVariant::UnsupportedOpcode {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            key_refs,
            vec![],
            SiglusParserBoundaryOutcome::UnsupportedOpcode,
            vec![SiglusParserBoundaryDiagnostic {
                code: "unsupported_opcode".to_string(),
                field: "Scene.pck@0x30".to_string(),
                message: "synthetic parser-boundary fixture contains an unsupported Siglus opcode before any patch write is allowed".to_string(),
                semantic_code: Some(SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE.to_string()),
                unsupported_opcode: Some("SIGLUS_SYNTH_UNSUPPORTED_7f".to_string()),
                byte_span: Some(SiglusParserBoundaryByteSpan {
                    start_byte: 48,
                    end_byte: 49,
                }),
            }],
        ));
    }

    Ok(siglus_parser_boundary_report(
        PROFILE_ID,
        SUPPORT_BOUNDARY,
        sources,
        key_refs,
        vec![
            SiglusParserBoundaryTextSlot {
                text_slot_id: "siglus.synthetic.scene.text.001".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                source_hash: scene_hash.clone(),
                byte_span: SiglusParserBoundaryByteSpan {
                    start_byte: 17,
                    end_byte: 52,
                },
                text_surface: "dialogue".to_string(),
                parser_opcode: "SIGLUS_SYNTH_TEXT_SLOT".to_string(),
            },
            SiglusParserBoundaryTextSlot {
                text_slot_id: "siglus.synthetic.scene.choice.001".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                source_hash: scene_hash,
                byte_span: SiglusParserBoundaryByteSpan {
                    start_byte: 53,
                    end_byte: 54,
                },
                text_surface: "choice_label".to_string(),
                parser_opcode: "SIGLUS_SYNTH_CHOICE_SLOT".to_string(),
            },
        ],
        SiglusParserBoundaryOutcome::ParserBoundarySuccess,
        vec![],
    ))
}

fn siglus_parser_boundary_report(
    profile_id: &str,
    support_boundary: &str,
    sources: Vec<SiglusParserBoundarySource>,
    key_refs: Vec<SiglusParserBoundaryKeyRef>,
    text_slots: Vec<SiglusParserBoundaryTextSlot>,
    outcome: SiglusParserBoundaryOutcome,
    diagnostics: Vec<SiglusParserBoundaryDiagnostic>,
) -> SiglusParserBoundaryReport {
    SiglusParserBoundaryReport {
        schema_version: SIGLUS_PARSER_BOUNDARY_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-siglus-known-key-parser-boundary-smoke".to_string(),
        profile_id: profile_id.to_string(),
        status: if outcome == SiglusParserBoundaryOutcome::ParserBoundarySuccess {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        outcome,
        support_boundary: support_boundary.to_string(),
        patch_write_attempted: false,
        sources,
        key_refs,
        text_slots,
        diagnostics,
    }
    .redacted_for_report()
}

fn siglus_parser_boundary_key_refs(
    request: &Value,
) -> KaifuuResult<Vec<SiglusParserBoundaryKeyRef>> {
    request
        .get("keyRefs")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|key_ref| {
            let requirement_id = key_ref.get("requirementId")?.as_str()?;
            let secret_ref = key_ref.get("secretRef")?.as_str()?;
            let key_purpose = key_ref.get("keyPurpose")?.as_str()?;
            let engine_profile_id = key_ref.get("engineProfileId")?.as_str()?;
            let source_hash = key_ref.get("sourceHash")?.as_str()?;
            Some((
                key_ref,
                requirement_id,
                secret_ref,
                key_purpose,
                engine_profile_id,
                source_hash,
            ))
        })
        .map(
            |(key_ref, requirement_id, secret_ref, key_purpose, engine_profile_id, source_hash)| {
                Ok(SiglusParserBoundaryKeyRef {
                    requirement_id: requirement_id.to_string(),
                    secret_ref: SecretRef::new(secret_ref.to_string())?,
                    key_purpose: key_purpose.to_string(),
                    engine_profile_id: engine_profile_id.to_string(),
                    source_hash: ProofHash::new(source_hash.to_string())?,
                    material_hash: key_ref
                        .get("materialHash")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .map(ProofHash::new)
                        .transpose()?,
                    bytes: key_ref
                        .get("bytes")
                        .and_then(Value::as_u64)
                        .and_then(|bytes| u32::try_from(bytes).ok()),
                    redaction_status: HelperRedactionStatus::Redacted,
                })
            },
        )
        .collect()
}

// KiriKiri XP3 profile proof
// `kaifuu xp3 profile-proof --fixture <path> --output <path>` consumes a
// fixture JSON file describing a single XP3 archive case (plain, encrypted,
// helper-required, or unsupported-protected-executable), classifies the
// archive bytes via the shared header / inventory machinery
// and emits a redacted proof report. The command never decrypts, extracts,
// or patches encrypted bytes — plain XP3 is the only variant for which we
// claim detect / extract / patch_back capability; every other classification
// fails closed before any extract or patch claim is made (acceptance
// criterion: "Unsupported cases fail before extract or patch claims are
// made").
// The redaction surface follows the SiglusParserBoundaryReport pattern:
// fixture id, profile id, archive id, support boundary text, diagnostic
// fields/messages, and any free-form remediation text run through
// `redact_for_log_or_report`. Archive paths are never written verbatim;
// the proof carries only an archive hash plus the relative path the
// fixture declares (and rejects absolute / traversal paths up front).

pub const XP3_PROFILE_PROOF_SCHEMA_VERSION: &str = "0.1.0";
pub const XP3_PROFILE_PROOF_SUPPORT_BOUNDARY: &str = "KiriKiri XP3 profile proof scoped to plain XP3 as the claimed-support concern (detect, extract, patch_back); encrypted, compressed, helper-required, and unsupported-protected-executable cases are routing diagnostics only and never claim extract or patch_back.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3ProfileClassification {
    Plain,
    Encrypted,
    Compressed,
    HelperRequired,
    UnsupportedProtectedExecutable,
}

impl Xp3ProfileClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Encrypted => "encrypted",
            Self::Compressed => "compressed",
            Self::HelperRequired => "helper_required",
            Self::UnsupportedProtectedExecutable => "unsupported_protected_executable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3PatchCapabilityLevel {
    /// Classification only; no extract / patch capability claimed.
    Detect,
    /// Inventory is exposable; payloads are not modified.
    Extract,
    /// Plain XP3 patch-back is claimed (only valid for the `plain` variant).
    PatchBack,
    /// Variant is routed for diagnostics only; no extract or patch-back claim.
    Unsupported,
}

impl Xp3PatchCapabilityLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::Extract => "extract",
            Self::PatchBack => "patch_back",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3CryptProfileStatus {
    /// No crypt profile is required (plain archives, unsupported protected
    /// executables that have no decryption claim at all).
    NotRequired,
    /// The fixture declares a crypt profile id and key-ref requirement
    /// that satisfy the encrypted-or-helper-required routing diagnostics.
    /// This status does not imply decryption capability; it only confirms
    /// the routing surface is wired.
    Satisfied,
    /// The fixture declares an encrypted or helper-required classification
    /// but supplies no crypt profile id at all.
    Missing,
    /// The fixture declares a crypt profile id that is not present in the
    /// recognized encryption-plugin set (e.g. an unknown KiriKiri plugin).
    UnknownPlugin,
}

impl Xp3CryptProfileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Satisfied => "satisfied",
            Self::Missing => "missing",
            Self::UnknownPlugin => "unknown_plugin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3HelperRequirement {
    NotRequired,
    Required,
}

impl Xp3HelperRequirement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Required => "required",
        }
    }
}

/// Set of crypt profile ids the routing diagnostics recognize. This is
/// **not** a decryption-capability claim — recognition here only means the
/// fixture's declared encryption plugin id matches a known KiriKiri
/// crypt-profile vocabulary entry, so the proof can route the case to
/// `Encrypted` / `HelperRequired` without claiming `UnknownPlugin`. Adding
/// an entry to this set adds zero decryption capability; it only widens
/// the routing taxonomy.
pub const XP3_RECOGNIZED_CRYPT_PROFILE_IDS: &[&str] = &[
    "kirikiri-xp3-null-key",
    "kirikiri-xp3-fixture-key-profile",
    "kirikiri-xp3-helper-required-key-profile",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub archive: Xp3ProfileProofFixtureArchive,
    pub expected_classification: Xp3ProfileClassification,
    pub patch_capability_level: Xp3PatchCapabilityLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypt_profile: Option<Xp3ProfileProofFixtureCryptProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixtureArchive {
    pub archive_id: String,
    /// Archive path **relative to the fixture file's directory**. Absolute
    /// paths, drive-letter paths, parent traversal (`..`), and home
    /// prefixes are rejected by `xp3_profile_proof` — they cannot appear
    /// in the report (acceptance criterion: "Private archive paths, raw
    /// keys, and decrypted text cannot appear in the report.").
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixtureCryptProfile {
    pub crypt_profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref_requirement: Option<Xp3ProfileProofFixtureKeyRefRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofFixtureKeyRefRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub classification: Xp3ProfileClassification,
    pub support_boundary: String,
    pub patch_capability_level: Xp3PatchCapabilityLevel,
    pub helper_requirement: Xp3HelperRequirement,
    pub patch_write_attempted: bool,
    pub archive: Xp3ProfileProofArchive,
    pub crypt_profile: Xp3ProfileProofCryptProfile,
    pub diagnostics: Vec<Xp3ProfileProofDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_remediation: Option<String>,
}

impl Xp3ProfileProofReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            classification: self.classification,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            patch_capability_level: self.patch_capability_level,
            helper_requirement: self.helper_requirement,
            patch_write_attempted: self.patch_write_attempted,
            archive: self.archive.redacted_for_report(),
            crypt_profile: self.crypt_profile.redacted_for_report(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(Xp3ProfileProofDiagnostic::redacted_for_report)
                .collect(),
            semantic_remediation: self
                .semantic_remediation
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofArchive {
    pub archive_id: String,
    pub archive_hash: ProofHash,
    pub declared_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<u64>,
}

impl Xp3ProfileProofArchive {
    fn redacted_for_report(&self) -> Self {
        Self {
            archive_id: redact_for_log_or_report(&self.archive_id),
            archive_hash: self.archive_hash.clone(),
            // declared_path is the fixture-relative path (already
            // guard-railed away from absolute / traversal / home prefixes)
            // — but we still funnel it through redact_for_log_or_report
            // so any redaction-bearing substring is scrubbed.
            declared_path: redact_for_log_or_report(&self.declared_path),
            entry_count: self.entry_count,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofCryptProfile {
    pub status: Xp3CryptProfileStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypt_profile_id: Option<String>,
    pub key_ref_requirement_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<SecretRef>,
}

impl Xp3ProfileProofCryptProfile {
    fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status,
            crypt_profile_id: self
                .crypt_profile_id
                .as_deref()
                .map(redact_for_log_or_report),
            key_ref_requirement_present: self.key_ref_requirement_present,
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref: self.secret_ref.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProfileProofDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl Xp3ProfileProofDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Xp3ProfileProofRequest<'a> {
    pub fixture: &'a Xp3ProfileProofFixture,
    /// Directory the fixture file lives in. Archive paths declared in the
    /// fixture are resolved relative to this directory.
    pub fixture_dir: &'a Path,
}

/// XP3 magic the encrypted-or-compressed routing path keys off. Plain
/// XP3 archives match the full [`XP3_PLAIN_MAGIC`] prefix; encrypted
/// archives carry the leading `XP3\r\n` magic followed by a non-plain
/// header signature that `read_plain_xp3_inventory` rejects with
/// `UnsupportedEncrypted`.
const XP3_HEADER_MAGIC: &[u8] = b"XP3\r\n";

/// Run the XP3 profile proof against `request.fixture`.
/// Routing rules (acceptance criterion: "Plain XP3, encrypted XP3,
/// helper-required XP3, and protected executable cases produce distinct
/// capability outcomes."):
/// - `plain`: archive bytes start with [`XP3_PLAIN_MAGIC`] **and** the
///   declared classification is `plain` **and** the fixture's
///   `patch_capability_level` is `patch_back`. The report carries the
///   entry count from `read_plain_xp3_inventory`. This is the only
///   variant for which `patch_back` is a valid claim.
/// - `encrypted` / `compressed` / `helper_required`: archive bytes start with the
///   `XP3\r\n` magic but [`read_plain_xp3_inventory`] reports
///   `UnsupportedEncrypted` (the legacy detector marker, used
///   for synthetic fixtures) or the declared classification routes the
///   case there. The proof claims **no** `extract` / `patch_back`
///   capability — `patch_capability_level` is forced to `Unsupported` in
///   the report, and a typed diagnostic with the encrypted / packed /
///   helper-required semantic code fires before any extract is attempted.
/// - `unsupported_protected_executable`: archive bytes do not start with
///   the XP3 magic at all (e.g. a protected-executable container). The
///   proof refuses with `SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED`
///   before any extract claim.
///   Negative cases (acceptance criterion: "Negative fixtures for missing
///   crypt profile, unknown encryption plugin, and leaked archive paths"):
/// - Missing crypt profile: `encrypted` / `helper_required` with no
///   `crypt_profile` field → diagnostic `xp3.crypt_profile.missing`.
/// - Unknown encryption plugin: `crypt_profile.crypt_profile_id` is not
///   in [`XP3_RECOGNIZED_CRYPT_PROFILE_IDS`] → diagnostic
///   `xp3.crypt_profile.unknown_plugin`.
/// - Leaked archive paths: absolute / traversal / home-prefixed
///   `archive.path` → rejected up front before the archive is read.
pub fn xp3_profile_proof(
    request: Xp3ProfileProofRequest<'_>,
) -> KaifuuResult<Xp3ProfileProofReport> {
    let fixture = request.fixture;

    let mut diagnostics: Vec<Xp3ProfileProofDiagnostic> = Vec::new();
    let mut path_was_rejected = false;
    let mut classification = fixture.expected_classification;
    let mut patch_capability_level = fixture.patch_capability_level;

    // Acceptance criterion: "Private archive paths, raw keys, and
    // decrypted text cannot appear in the report." The declared path is
    // the only path-shaped field that survives into the report and we
    // refuse to echo absolute / traversal paths under any circumstance
    // — they're replaced by a redaction sentinel before being placed in
    // `Xp3ProfileProofArchive::declared_path`.
    let declared_path_for_report = match validate_xp3_fixture_archive_path(&fixture.archive.path) {
        Ok(path) => path.to_string(),
        Err(message) => {
            path_was_rejected = true;
            diagnostics.push(Xp3ProfileProofDiagnostic {
                code: "xp3.archive_path.leaked".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "archive.path".to_string(),
                message,
                semantic_code: Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string()),
                remediation: Some(
                    "archive paths must be relative to the fixture file and must not contain absolute roots, drive letters, parent traversal, or home prefixes"
                        .to_string(),
                ),
            });
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
        }
    };

    // Resolve the archive bytes only if the declared path passed
    // validation. If it didn't, we still hash the empty byte stream as a
    // placeholder so the report has a well-formed archive hash — the P0
    // diagnostic + `Failed` status make it clear the proof did not
    // actually inspect a real archive.
    let archive_bytes = if path_was_rejected {
        Vec::new()
    } else {
        let archive_full = request.fixture_dir.join(&fixture.archive.path);
        match fs::read(&archive_full) {
            Ok(bytes) => bytes,
            Err(error) => {
                diagnostics.push(Xp3ProfileProofDiagnostic {
                    code: "xp3.archive.read_failed".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "archive.path".to_string(),
                    message: format!(
                        "archive could not be read: {}",
                        redact_for_log_or_report(&error.to_string())
                    ),
                    semantic_code: None,
                    remediation: Some(
                        "ensure the fixture archive is present alongside the fixture file"
                            .to_string(),
                    ),
                });
                Vec::new()
            }
        }
    };

    let archive_hash = ProofHash::new(sha256_hash_bytes(&archive_bytes))?;

    // Classify the archive bytes. The byte-level routing is the source of
    // truth — a fixture that *declares* `plain` but supplies non-plain
    // bytes gets routed by the bytes, and we emit a diagnostic noting the
    // mismatch. The proof never re-classifies upward (e.g. byte-plain
    // bytes are never reported as encrypted just because the fixture said
    // so) — that would let a malicious fixture under-claim and bypass the
    // pre-extract / patch refusal.
    let bytes_classification = classify_xp3_bytes(&archive_bytes);

    if !path_was_rejected && !archive_bytes.is_empty() {
        match (bytes_classification, classification) {
            (Some(byte_class), declared) if byte_class != declared => {
                diagnostics.push(Xp3ProfileProofDiagnostic {
                    code: "xp3.classification.mismatch".to_string(),
                    severity: PartialDiagnosticSeverity::P1,
                    field: "expectedClassification".to_string(),
                    message: format!(
                        "fixture declared {} but archive bytes classify as {}",
                        declared.as_str(),
                        byte_class.as_str()
                    ),
                    semantic_code: Some(SEMANTIC_AMBIGUOUS_ENGINE_VARIANT.to_string()),
                    remediation: Some(
                        "regenerate the fixture so the declared classification matches the archive bytes"
                            .to_string(),
                    ),
                });
                classification = byte_class;
            }
            _ => {}
        }
    }

    // Plain inventory probe. We probe the inventory only when the bytes
    // classify as plain — the function refuses to decrypt and we never
    // call it on encrypted bytes.
    // If the plain-magic-prefixed archive fails to parse its index
    // (e.g. encrypted index entries, common in real-bytes KiriKiri
    // games that wear the plain magic but carry an encrypted directory),
    // we re-route the classification to `Encrypted` and demote the
    // patch capability to `Unsupported` — claiming `patch_back` on an
    // archive we cannot even inventory would violate the
    // pre-extract-claim contract.
    let mut entry_count: Option<u64> = None;
    if matches!(bytes_classification, Some(Xp3ProfileClassification::Plain)) {
        match read_plain_xp3_inventory(&archive_bytes) {
            Ok(inventory) => entry_count = Some(inventory.entries.len() as u64),
            Err(error) => {
                let is_unsupported_encrypted_index =
                    matches!(error, PlainXp3InventoryError::UnsupportedEncrypted);
                diagnostics.push(Xp3ProfileProofDiagnostic {
                    code: "xp3.inventory.read_failed".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "archive".to_string(),
                    message: format!(
                        "plain-magic XP3 inventory could not be parsed: {}",
                        redact_for_log_or_report(&error.to_string())
                    ),
                    semantic_code: if is_unsupported_encrypted_index {
                        Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED.to_string())
                    } else {
                        None
                    },
                    remediation: Some(
                        "archives that carry the plain magic but cannot be inventoried route to encrypted; KAIFUU-038 makes no decryption or patch-back claim".to_string(),
                    ),
                });
                // Route per inventory failure mode: the
                // `UnsupportedEncrypted` arm explicitly indicates the
                // directory entries are encrypted, and any other parse
                // failure on a plain-magic-prefixed archive can't be
                // claimed as a plain-patch case either.
                classification = Xp3ProfileClassification::Encrypted;
                patch_capability_level = Xp3PatchCapabilityLevel::Unsupported;
            }
        }
    }

    // Helper requirement is derived from the (post-byte-classification,
    // post-inventory-probe) routing so a bytes-driven re-route to
    // HelperRequired surfaces correctly. This is computed once here —
    // earlier mutations to `classification` are now sealed.
    let helper_requirement = match classification {
        Xp3ProfileClassification::HelperRequired => Xp3HelperRequirement::Required,
        _ => Xp3HelperRequirement::NotRequired,
    };

    // Encrypted / compressed / helper-required / unsupported-protected-executable
    // routing. Each variant emits a typed diagnostic naming the semantic
    // code and forces `patch_capability_level` to `Unsupported` — the
    // proof never claims extract or patch_back for these cases
    // (acceptance criterion: "Unsupported cases fail before extract or
    // patch claims are made.").
    let mut routing_remediation: Option<String> = None;
    match classification {
        Xp3ProfileClassification::Plain => {}
        Xp3ProfileClassification::Encrypted => {
            patch_capability_level = Xp3PatchCapabilityLevel::Unsupported;
            routing_remediation = Some(
                "encrypted XP3 is routed for diagnostics only; KAIFUU-038 makes no decryption, extraction, or patch-back claim".to_string(),
            );
            diagnostics.push(Xp3ProfileProofDiagnostic {
                code: "xp3.encrypted.unsupported".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "classification".to_string(),
                message:
                    "encrypted XP3 archive routed to diagnostics; no decryption capability claimed"
                        .to_string(),
                semantic_code: Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED.to_string()),
                remediation: routing_remediation.clone(),
            });
        }
        Xp3ProfileClassification::Compressed => {
            patch_capability_level = Xp3PatchCapabilityLevel::Unsupported;
            routing_remediation = Some(
                "compressed XP3 is routed for diagnostics only; KAIFUU-098 makes no decompression, extraction, or patch-back claim".to_string(),
            );
            diagnostics.push(Xp3ProfileProofDiagnostic {
                code: "xp3.compressed.unsupported".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "classification".to_string(),
                message:
                    "compressed XP3 archive routed to diagnostics; no decompression capability claimed"
                        .to_string(),
                semantic_code: Some(SEMANTIC_UNSUPPORTED_VARIANT_PACKED.to_string()),
                remediation: routing_remediation.clone(),
            });
        }
        Xp3ProfileClassification::HelperRequired => {
            patch_capability_level = Xp3PatchCapabilityLevel::Unsupported;
            routing_remediation = Some(
                "helper-required XP3 archives require a KAIFUU-085 helper result; KAIFUU-038 makes no extraction or patch-back claim until the helper is recorded".to_string(),
            );
            diagnostics.push(Xp3ProfileProofDiagnostic {
                code: "xp3.helper_required".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "classification".to_string(),
                message: "helper-required XP3 archive routed to diagnostics; no extraction capability claimed".to_string(),
                semantic_code: Some(SEMANTIC_HELPER_REQUIRED.to_string()),
                remediation: routing_remediation.clone(),
            });
        }
        Xp3ProfileClassification::UnsupportedProtectedExecutable => {
            patch_capability_level = Xp3PatchCapabilityLevel::Unsupported;
            routing_remediation = Some(
                "protected-executable containers are not XP3 archives; no extract or patch-back capability is claimed".to_string(),
            );
            diagnostics.push(Xp3ProfileProofDiagnostic {
                code: "xp3.unsupported_protected_executable".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "classification".to_string(),
                message: "protected-executable container routed to diagnostics; no extraction capability claimed".to_string(),
                semantic_code: Some(SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED.to_string()),
                remediation: routing_remediation.clone(),
            });
        }
    }

    // Non-plain XP3 variants are diagnostics-only routes. If the
    // fixture claims any extract or patch-back level there, emit
    // `xp3.patch_capability.overclaim`; the routed report has already
    // been forced down to `Unsupported`.
    if !matches!(classification, Xp3ProfileClassification::Plain)
        && !matches!(
            fixture.patch_capability_level,
            Xp3PatchCapabilityLevel::Unsupported
        )
    {
        diagnostics.push(Xp3ProfileProofDiagnostic {
            code: "xp3.patch_capability.overclaim".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "patchCapabilityLevel".to_string(),
            message: format!(
                "fixture declared {}; XP3 profile proof permits extract and patch_back capability claims only for plain XP3, while encrypted, compressed, helper_required, and unsupported_protected_executable fixtures must set patchCapabilityLevel to unsupported",
                fixture.patch_capability_level.as_str()
            ),
            semantic_code: Some(SEMANTIC_MISSING_PATCH_BACK_CAPABILITY.to_string()),
            remediation: Some(
                "set patchCapabilityLevel to \"unsupported\" for encrypted, compressed, helper_required, and unsupported_protected_executable XP3 fixtures"
                    .to_string(),
            ),
        });
    }

    // Crypt profile evaluation.
    let crypt_profile = evaluate_xp3_crypt_profile(
        fixture.crypt_profile.as_ref(),
        classification,
        &mut diagnostics,
    );

    // Plain archives must not declare a crypt profile (it would imply a
    // decryption capability the proof never has). We surface this as a
    // P1 diagnostic — plain bytes plus declared crypt profile is a clear
    // fixture-authoring error, but the bytes are still safe to inventory.
    if matches!(classification, Xp3ProfileClassification::Plain) && fixture.crypt_profile.is_some()
    {
        diagnostics.push(Xp3ProfileProofDiagnostic {
            code: "xp3.crypt_profile.plain_overclaim".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "cryptProfile".to_string(),
            message: "plain XP3 fixtures must not declare a crypt profile".to_string(),
            semantic_code: Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION.to_string()),
            remediation: Some("remove the cryptProfile entry for plain XP3 fixtures".to_string()),
        });
    }

    let status = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Ok(Xp3ProfileProofReport {
        schema_version: XP3_PROFILE_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        profile_id: fixture.profile_id.clone(),
        status,
        classification,
        support_boundary: XP3_PROFILE_PROOF_SUPPORT_BOUNDARY.to_string(),
        patch_capability_level,
        helper_requirement,
        // never attempts an encrypted patch-back; this flag is
        // always false. We surface it explicitly so downstream auditors
        // can confirm the proof did not write any patched bytes.
        patch_write_attempted: false,
        archive: Xp3ProfileProofArchive {
            archive_id: fixture.archive.archive_id.clone(),
            archive_hash,
            declared_path: declared_path_for_report,
            entry_count,
        },
        crypt_profile,
        diagnostics,
        semantic_remediation: routing_remediation,
    })
}

fn classify_xp3_bytes(bytes: &[u8]) -> Option<Xp3ProfileClassification> {
    if bytes.is_empty() {
        return None;
    }
    if bytes.starts_with(XP3_PLAIN_MAGIC) {
        return Some(Xp3ProfileClassification::Plain);
    }
    if bytes.starts_with(XP3_HEADER_MAGIC) {
        // synthetic fixtures encode the helper-required vs
        // encrypted distinction in a literal marker inside the header
        // tail. Real-bytes encrypted XP3 (no marker) falls back to
        // `Encrypted` — we never claim the helper-required path for
        // real bytes without an explicit fixture annotation.
        let marker_window =
            String::from_utf8_lossy(&bytes[..bytes.len().min(128)]).to_ascii_lowercase();
        if marker_window.contains("xp3-compressed") {
            return Some(Xp3ProfileClassification::Compressed);
        }
        if marker_window.contains("xp3-helper-required") {
            return Some(Xp3ProfileClassification::HelperRequired);
        }
        return Some(Xp3ProfileClassification::Encrypted);
    }
    Some(Xp3ProfileClassification::UnsupportedProtectedExecutable)
}

fn evaluate_xp3_crypt_profile(
    crypt_profile: Option<&Xp3ProfileProofFixtureCryptProfile>,
    classification: Xp3ProfileClassification,
    diagnostics: &mut Vec<Xp3ProfileProofDiagnostic>,
) -> Xp3ProfileProofCryptProfile {
    match (classification, crypt_profile) {
        (
            Xp3ProfileClassification::Plain
            | Xp3ProfileClassification::Compressed
            | Xp3ProfileClassification::UnsupportedProtectedExecutable,
            _,
        ) => Xp3ProfileProofCryptProfile {
            status: Xp3CryptProfileStatus::NotRequired,
            crypt_profile_id: crypt_profile.map(|profile| profile.crypt_profile_id.clone()),
            key_ref_requirement_present: crypt_profile
                .and_then(|profile| profile.key_ref_requirement.as_ref())
                .is_some(),
            requirement_id: crypt_profile
                .and_then(|profile| profile.key_ref_requirement.as_ref())
                .map(|requirement| requirement.requirement_id.clone()),
            secret_ref: crypt_profile
                .and_then(|profile| profile.key_ref_requirement.as_ref())
                .map(|requirement| requirement.secret_ref.clone()),
        },
        (Xp3ProfileClassification::Encrypted | Xp3ProfileClassification::HelperRequired, None) => {
            diagnostics.push(Xp3ProfileProofDiagnostic {
                code: "xp3.crypt_profile.missing".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "cryptProfile".to_string(),
                message: format!(
                    "{} XP3 fixtures must declare cryptProfile with cryptProfileId and keyRefRequirement; the crypt profile records routing metadata only and does not claim decryption, extraction, or patch_back support",
                    classification.as_str()
                ),
                semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
                remediation: Some(
                    "add cryptProfile with cryptProfileId and keyRefRequirement for encrypted or helper_required XP3 fixtures"
                        .to_string(),
                ),
            });
            Xp3ProfileProofCryptProfile {
                status: Xp3CryptProfileStatus::Missing,
                crypt_profile_id: None,
                key_ref_requirement_present: false,
                requirement_id: None,
                secret_ref: None,
            }
        }
        (
            Xp3ProfileClassification::Encrypted | Xp3ProfileClassification::HelperRequired,
            Some(profile),
        ) => {
            let recognized =
                XP3_RECOGNIZED_CRYPT_PROFILE_IDS.contains(&profile.crypt_profile_id.as_str());
            let key_ref = profile.key_ref_requirement.as_ref();
            if !recognized {
                diagnostics.push(Xp3ProfileProofDiagnostic {
                    code: "xp3.crypt_profile.unknown_plugin".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "cryptProfile.cryptProfileId".to_string(),
                    message: format!(
                        "crypt profile id {} is not in the recognized KiriKiri plugin set",
                        profile.crypt_profile_id
                    ),
                    semantic_code: Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT.to_string()),
                    remediation: Some(
                        "use a recognized KAIFUU crypt-profile id; recognition does not imply decryption capability".to_string(),
                    ),
                });
            }
            if key_ref.is_none() {
                diagnostics.push(Xp3ProfileProofDiagnostic {
                    code: "xp3.crypt_profile.missing_key_ref".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "cryptProfile.keyRefRequirement".to_string(),
                    message: format!(
                        "{} XP3 fixtures must declare a keyRef requirement",
                        classification.as_str()
                    ),
                    semantic_code: Some(SEMANTIC_MISSING_KEY_PROFILE.to_string()),
                    remediation: Some(
                        "add a keyRefRequirement entry with requirementId and secretRef"
                            .to_string(),
                    ),
                });
            }
            Xp3ProfileProofCryptProfile {
                status: if recognized {
                    Xp3CryptProfileStatus::Satisfied
                } else {
                    Xp3CryptProfileStatus::UnknownPlugin
                },
                crypt_profile_id: Some(profile.crypt_profile_id.clone()),
                key_ref_requirement_present: key_ref.is_some(),
                requirement_id: key_ref.map(|requirement| requirement.requirement_id.clone()),
                secret_ref: key_ref.map(|requirement| requirement.secret_ref.clone()),
            }
        }
    }
}

fn validate_xp3_fixture_archive_path(path: &str) -> Result<&str, String> {
    if path.is_empty() {
        return Err("archive path must not be empty".to_string());
    }
    let trimmed = path.trim_start();
    if trimmed != path {
        return Err("archive path must not contain leading whitespace".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("archive path must be relative to the fixture file".to_string());
    }
    if path.starts_with("~/") || path.starts_with("~\\") {
        return Err("archive path must not contain home prefixes".to_string());
    }
    if path.starts_with("$HOME")
        || path.starts_with("${HOME}")
        || path.starts_with("%USERPROFILE%")
        || path.starts_with("%HOME%")
        || path.starts_with("$USERPROFILE")
    {
        return Err("archive path must not contain environment-variable home prefixes".to_string());
    }
    for component in path.split(['/', '\\']) {
        if component == ".." {
            return Err("archive path must not contain parent traversal".to_string());
        }
    }
    // Drive letter check (Windows-style absolute path).
    if path.len() >= 2 {
        let mut chars = path.chars();
        let first = chars.next().unwrap_or(' ');
        let second = chars.next().unwrap_or(' ');
        if first.is_ascii_alphabetic() && second == ':' {
            return Err("archive path must not contain a drive letter".to_string());
        }
    }
    Ok(path)
}

// RPG Maker MV/MZ encrypted-media-proof
// `encrypted_media_proof` runs a fixture matrix of RPG Maker MV/MZ media
// assets (encrypted images / audio / movies, plus plaintext), validates the
// asset-key profile against `data/System.json`, and emits a readiness report.
// Posture (load-bearing): RPG Maker MV/MZ is a commercial product.
// is a **research-only** profile — the proof never decrypts an
// encrypted asset, never persists decrypted bytes, never extracts plaintext
// from an encrypted asset, and never claims a "media-key detection implies
// dialogue extraction or script patch support" capability. The proof
// classifies the leading 16-byte RPGMV signature, validates the
// `data/System.json.encryptionKey` shape, and routes per-asset readiness
// diagnostics. Key bytes never appear in the report — only the
// `data/System.json` proof hash and a routing diagnostic.

pub const ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION: &str = "0.1.0";
pub const ENCRYPTED_MEDIA_PROOF_SUPPORT_BOUNDARY: &str = "RPG Maker MV/MZ encrypted-media proof; research-only profile scope: detect encrypted asset suffix + signature; validate System.json key profile; readiness only. No decryption capability is claimed; no media bytes are persisted decrypted; dialogue extraction and script patch support are explicitly out of scope.";

/// 16-byte RPGMV header magic that fronts every encrypted.rpgmvp /
/// .rpgmvo /.rpgmvm /.rpgmvu /.png_ /.ogg_ /.m4a_ asset. Bytes 0..5 are
/// `RPGMV`, bytes 5..8 are zero, byte 8 is the header version (0x00),
/// bytes 9..10 carry the format version (0x03 0x01), bytes 10..16 are
/// reserved. We treat the full 16 bytes as the routing signature so a
/// fixture cannot pass the proof with a malformed or partially-zeroed
/// header.
pub const RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER: &[u8; 16] = &[
    b'R', b'P', b'G', b'M', b'V', 0, 0, 0, 0, 0x03, 0x01, 0, 0, 0, 0, 0,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaAssetKind {
    Image,
    Audio,
    Video,
}

impl EncryptedMediaAssetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaClassification {
    /// Bytes carry the RPGMV header magic and the fixture declared an
    /// encrypted asset suffix (.rpgmvp /.rpgmvo /.rpgmvm /.rpgmvu /
    /// .png_ /.ogg_ /.m4a_).
    Encrypted,
    /// Asset is declared and present plaintext (e.g..png,.ogg,.webm) —
    /// no encryption signature, no key requirement.
    Plaintext,
    /// Asset is declared encrypted but the header magic is missing, the
    /// file is shorter than 16 bytes, or the bytes carry an unknown
    /// header. Routed to readiness=`unsupported`; no decryption attempt.
    MalformedHeader,
    /// Asset is declared encrypted but cannot be read off disk.
    MissingAsset,
    /// Asset suffix is recognised as an RPG Maker-family extension but the
    /// suffix has no profiled crypto / codec mapping (e.g. `.rpgmvu`,
    /// `.webp_`). Routed to `unsupported`; no key requirement.
    UnknownSuffix,
}

impl EncryptedMediaClassification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Encrypted => "encrypted",
            Self::Plaintext => "plaintext",
            Self::MalformedHeader => "malformed_header",
            Self::MissingAsset => "missing_asset",
            Self::UnknownSuffix => "unknown_suffix",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaDecryptability {
    /// Asset is plaintext; nothing to decrypt.
    NotApplicable,
    /// Encrypted asset has a present, key-shape-valid `System.json`
    /// encryption key. The proof still does **not** decrypt — this status
    /// only indicates the key profile is wired.
    KeyProfileSatisfied,
    /// Encrypted asset is missing a `data/System.json` encryption key.
    KeyMissing,
    /// `data/System.json` encryption key value is malformed (wrong length,
    /// not lowercase hex). The proof does not attempt to decrypt with the
    /// candidate key.
    KeyMalformed,
    /// `data/System.json` carries a well-formed 32-hex key, but its hash
    /// does not match the fixture's expected public proof hash.
    KeyMismatch,
    /// Asset declares a media kind whose key profile recognition is out of
    /// scope for the research-only readiness command.
    OutOfScope,
}

impl EncryptedMediaDecryptability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::KeyProfileSatisfied => "key_profile_satisfied",
            Self::KeyMissing => "key_missing",
            Self::KeyMalformed => "key_malformed",
            Self::KeyMismatch => "key_mismatch",
            Self::OutOfScope => "out_of_scope",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaPatchCapability {
    /// Plaintext asset; no patch capability is claimed in this proof. This
    /// command is research-only — even plaintext media is not surfaced as
    /// a patchable artifact here.
    NotClaimed,
    /// Asset is routed for diagnostics only; no patch capability is or
    /// will be claimed by for any encrypted media asset.
    Unsupported,
}

impl EncryptedMediaPatchCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotClaimed => "not_claimed",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaKeyRefStatus {
    /// Fixture is plaintext or out-of-scope; no keyRef is required.
    NotRequired,
    /// Fixture declared an encrypted asset and supplied a key-profile id +
    /// secret ref; recognition is routing-only (does **not** imply a
    /// decryption capability claim).
    Present,
    /// Fixture declared an encrypted asset but supplied no keyRef.
    Missing,
}

impl EncryptedMediaKeyRefStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Present => "present",
            Self::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedMediaReadiness {
    /// Encrypted asset is detected, key profile is wired, no script
    /// capability is claimed — research-ready.
    Ready,
    /// Plaintext asset is plumbed as evidence; readiness is informational
    /// only (no patch claim, no script capability).
    PlaintextEvidence,
    /// Asset is routed for diagnostics only (malformed, missing, unknown
    /// suffix, missing key, malformed key, key/asset mismatch); the proof
    /// claims **no** decryption or patch capability.
    Unsupported,
}

impl EncryptedMediaReadiness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::PlaintextEvidence => "plaintext_evidence",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Set of asset-key profile ids the routing diagnostics recognize. This
/// is **not** a decryption-capability claim — recognition here only means
/// the fixture's declared profile id matches a known KAIFUU MV/MZ
/// asset-key vocabulary entry, so the proof can route the case without
/// emitting an `unknown_plugin`-shaped diagnostic. Adding an entry adds
/// zero decryption capability; it only widens the routing taxonomy.
pub const RPG_MAKER_MV_MZ_RECOGNIZED_KEY_PROFILE_IDS: &[&str] = &[
    "rpg-maker-mv-mz-asset-key",
    "rpg-maker-mv-mz-fixture-asset-key",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub game_dir: String,
    pub assets: Vec<EncryptedMediaProofFixtureAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_profile: Option<EncryptedMediaProofFixtureKeyProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixtureAsset {
    pub asset_id: String,
    /// Path **relative to `game_dir`**. Absolute / drive-letter / parent
    /// traversal / home-prefixed paths are rejected up front and never
    /// echoed into the report.
    pub path: String,
    pub expected_kind: EncryptedMediaAssetKind,
    pub expected_classification: EncryptedMediaClassification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixtureKeyProfile {
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_system_json_key_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref_requirement: Option<EncryptedMediaProofFixtureKeyRefRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofFixtureKeyRefRequirement {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub support_boundary: String,
    pub readiness: EncryptedMediaReadiness,
    pub patch_capability_level: EncryptedMediaPatchCapability,
    pub script_capability_claimed: bool,
    pub decrypted_bytes_persisted: bool,
    pub assets: Vec<EncryptedMediaProofAsset>,
    pub key_profile: EncryptedMediaProofKeyProfile,
    pub diagnostics: Vec<EncryptedMediaProofDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_remediation: Option<String>,
}

impl EncryptedMediaProofReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            readiness: self.readiness,
            patch_capability_level: self.patch_capability_level,
            script_capability_claimed: self.script_capability_claimed,
            decrypted_bytes_persisted: self.decrypted_bytes_persisted,
            assets: self
                .assets
                .iter()
                .map(EncryptedMediaProofAsset::redacted_for_report)
                .collect(),
            key_profile: self.key_profile.redacted_for_report(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(EncryptedMediaProofDiagnostic::redacted_for_report)
                .collect(),
            semantic_remediation: self
                .semantic_remediation
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofAsset {
    pub asset_id: String,
    pub declared_path: String,
    pub kind: EncryptedMediaAssetKind,
    pub classification: EncryptedMediaClassification,
    pub readiness: EncryptedMediaReadiness,
    pub patch_capability_level: EncryptedMediaPatchCapability,
    pub key_ref_status: EncryptedMediaKeyRefStatus,
    pub decryptability: EncryptedMediaDecryptability,
    pub asset_evidence_hash: ProofHash,
    pub suffix: String,
}

impl EncryptedMediaProofAsset {
    fn redacted_for_report(&self) -> Self {
        Self {
            asset_id: redact_for_log_or_report(&self.asset_id),
            declared_path: redact_for_log_or_report(&self.declared_path),
            kind: self.kind,
            classification: self.classification,
            readiness: self.readiness,
            patch_capability_level: self.patch_capability_level,
            key_ref_status: self.key_ref_status,
            decryptability: self.decryptability,
            asset_evidence_hash: self.asset_evidence_hash.clone(),
            suffix: self.suffix.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofKeyProfile {
    pub status: EncryptedMediaKeyRefStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<SecretRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_json_proof_hash: Option<ProofHash>,
    pub system_json_present: bool,
    pub system_json_key_present: bool,
    pub system_json_key_well_formed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_system_json_key_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_json_key_hash: Option<ProofHash>,
    pub has_encrypted_images_flag: Option<bool>,
    pub has_encrypted_audio_flag: Option<bool>,
}

impl EncryptedMediaProofKeyProfile {
    fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status,
            key_profile_id: self.key_profile_id.as_deref().map(redact_for_log_or_report),
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref: self.secret_ref.clone(),
            system_json_proof_hash: self.system_json_proof_hash.clone(),
            system_json_present: self.system_json_present,
            system_json_key_present: self.system_json_key_present,
            system_json_key_well_formed: self.system_json_key_well_formed,
            expected_system_json_key_hash: self.expected_system_json_key_hash.clone(),
            system_json_key_hash: self.system_json_key_hash.clone(),
            has_encrypted_images_flag: self.has_encrypted_images_flag,
            has_encrypted_audio_flag: self.has_encrypted_audio_flag,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMediaProofDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl EncryptedMediaProofDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EncryptedMediaProofRequest<'a> {
    pub fixture: &'a EncryptedMediaProofFixture,
    /// Directory the fixture file lives in. The `game_dir` declared in
    /// the fixture is resolved relative to this directory.
    pub fixture_dir: &'a Path,
}

/// Per-suffix profile for readiness routing. This is a
/// research-only table — every encrypted-suffix entry carries
/// `patch_capability_level = Unsupported` and `decryptability = OutOfScope`
/// until a key profile resolves it upward to `KeyProfileSatisfied`.
struct EncryptedMediaSuffixProfile {
    suffix: &'static str,
    kind: Option<EncryptedMediaAssetKind>,
    encrypted: bool,
    /// Suffix is in the recognised RPG Maker family but has no profiled
    /// crypto / codec mapping (e.g. `.webp_`).
    unknown_in_family: bool,
}

const ENCRYPTED_MEDIA_SUFFIX_PROFILES: &[EncryptedMediaSuffixProfile] = &[
    // MV-era encrypted suffixes.
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvp",
        kind: Some(EncryptedMediaAssetKind::Image),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvm",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvo",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvu",
        kind: Some(EncryptedMediaAssetKind::Video),
        encrypted: true,
        unknown_in_family: false,
    },
    // MZ-era encrypted suffixes.
    EncryptedMediaSuffixProfile {
        suffix: "png_",
        kind: Some(EncryptedMediaAssetKind::Image),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "m4a_",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "ogg_",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: true,
        unknown_in_family: false,
    },
    // Plaintext (unencrypted) media — present as evidence only.
    EncryptedMediaSuffixProfile {
        suffix: "png",
        kind: Some(EncryptedMediaAssetKind::Image),
        encrypted: false,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "m4a",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: false,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "ogg",
        kind: Some(EncryptedMediaAssetKind::Audio),
        encrypted: false,
        unknown_in_family: false,
    },
    EncryptedMediaSuffixProfile {
        suffix: "webm",
        kind: Some(EncryptedMediaAssetKind::Video),
        encrypted: false,
        unknown_in_family: false,
    },
    // Recognised but unmapped suffixes (route to unknown_suffix).
    EncryptedMediaSuffixProfile {
        suffix: "rpgmvu",
        kind: None,
        encrypted: true,
        unknown_in_family: true,
    },
    EncryptedMediaSuffixProfile {
        suffix: "webp_",
        kind: None,
        encrypted: true,
        unknown_in_family: true,
    },
];

fn encrypted_media_suffix_profile(suffix: &str) -> Option<&'static EncryptedMediaSuffixProfile> {
    let lower = suffix.to_ascii_lowercase();
    ENCRYPTED_MEDIA_SUFFIX_PROFILES
        .iter()
        .find(|profile| profile.suffix == lower)
}

/// Asset-relative-path validator. Mirrors the XP3 profile-proof
/// validator: rejects absolute / drive-letter / parent-traversal / home
/// prefixes so private paths cannot survive into the report.
fn validate_encrypted_media_fixture_path(path: &str) -> Result<&str, String> {
    if path.is_empty() {
        return Err("asset path must not be empty".to_string());
    }
    let trimmed = path.trim_start();
    if trimmed != path {
        return Err("asset path must not contain leading whitespace".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("asset path must be relative to the game directory".to_string());
    }
    if path.starts_with("~/") || path.starts_with("~\\") {
        return Err("asset path must not contain home prefixes".to_string());
    }
    if path.starts_with("$HOME")
        || path.starts_with("${HOME}")
        || path.starts_with("%USERPROFILE%")
        || path.starts_with("%HOME%")
        || path.starts_with("$USERPROFILE")
    {
        return Err("asset path must not contain environment-variable home prefixes".to_string());
    }
    for component in path.split(['/', '\\']) {
        if component == ".." {
            return Err("asset path must not contain parent traversal".to_string());
        }
    }
    if path.len() >= 2 {
        let mut chars = path.chars();
        let first = chars.next().unwrap_or(' ');
        let second = chars.next().unwrap_or(' ');
        if first.is_ascii_alphabetic() && second == ':' {
            return Err("asset path must not contain a drive letter".to_string());
        }
    }
    Ok(path)
}

/// `data/System.json` evidence parsed for readiness routing. Stored
/// alongside the proof hash so the key profile section can surface
/// `has_encrypted_images_flag` / `has_encrypted_audio_flag` without
/// re-reading the file.
struct EncryptedMediaSystemJson {
    proof_hash: Option<ProofHash>,
    has_encrypted_images: Option<bool>,
    has_encrypted_audio: Option<bool>,
    encryption_key_present: bool,
    encryption_key_well_formed: bool,
    encryption_key_hash: Option<ProofHash>,
}

fn read_encrypted_media_system_json(game_dir: &Path) -> Option<EncryptedMediaSystemJson> {
    let path = find_rpg_maker_system_json(game_dir)?;
    let bytes = fs::read(&path).ok()?;
    let proof_hash = ProofHash::new(sha256_hash_bytes(&bytes)).ok();
    let value = serde_json::from_slice::<Value>(&bytes).ok();
    let (
        has_encrypted_images,
        has_encrypted_audio,
        encryption_key_present,
        encryption_key_well_formed,
        encryption_key_hash,
    ) = match value {
        Some(value) => {
            let has_encrypted_images = value.get("hasEncryptedImages").and_then(Value::as_bool);
            let has_encrypted_audio = value.get("hasEncryptedAudio").and_then(Value::as_bool);
            let key = value
                .get("encryptionKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty());
            let well_formed = key.is_some_and(|key| {
                // MV/MZ asset XOR key is 16 bytes encoded as 32
                // lowercase hex chars.
                key.len() == 32
                    && key.chars().all(|c| {
                        c.is_ascii_hexdigit()
                            && (!c.is_ascii_alphabetic() || c.is_ascii_lowercase())
                    })
            });
            let key_hash = if well_formed {
                key.and_then(|key| ProofHash::new(sha256_hash_bytes(key.as_bytes())).ok())
            } else {
                None
            };
            (
                has_encrypted_images,
                has_encrypted_audio,
                key.is_some(),
                well_formed,
                key_hash,
            )
        }
        None => (None, None, false, false, None),
    };
    Some(EncryptedMediaSystemJson {
        proof_hash,
        has_encrypted_images,
        has_encrypted_audio,
        encryption_key_present,
        encryption_key_well_formed,
        encryption_key_hash,
    })
}

/// Hash 64 bytes of asset evidence (or all bytes if shorter). Mirrors
/// [`rpg_maker_mv_mz_image_evidence_hash`] — the proof never persists
/// full asset bytes, only a stable hash of the leading window for
/// downstream provenance review.
fn encrypted_media_asset_evidence_hash(bytes: &[u8]) -> ProofHash {
    ProofHash::new(sha256_hash_bytes(&bytes[..bytes.len().min(64)]))
        .expect("sha256 hash output is always shaped as a valid kaifuu ProofHash")
}

/// Classify a single asset by its on-disk bytes + declared suffix +
/// declared kind. Byte-level classification is the source of truth: a
/// fixture that *declares* `encrypted` but supplies plaintext-shaped
/// bytes is re-classified to `MalformedHeader`, never silently upgraded
/// to `Encrypted`.
fn classify_encrypted_media_asset(
    profile: Option<&EncryptedMediaSuffixProfile>,
    bytes: Option<&[u8]>,
) -> EncryptedMediaClassification {
    let Some(profile) = profile else {
        return EncryptedMediaClassification::UnknownSuffix;
    };
    if profile.unknown_in_family {
        return EncryptedMediaClassification::UnknownSuffix;
    }
    let Some(bytes) = bytes else {
        return EncryptedMediaClassification::MissingAsset;
    };
    if profile.encrypted {
        if bytes.len() < RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len() {
            return EncryptedMediaClassification::MalformedHeader;
        }
        if &bytes[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()] == RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        {
            EncryptedMediaClassification::Encrypted
        } else {
            EncryptedMediaClassification::MalformedHeader
        }
    } else {
        EncryptedMediaClassification::Plaintext
    }
}

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterKeyRequirementDeclaration {
    pub requirement_id: String,
    pub engine_family: String,
    pub material_kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archive_parameters: Vec<ArchiveParameterDeclaration>,
    pub validation: AdapterKeyValidationDeclaration,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub semantic_errors: Vec<SemanticErrorCode>,
}

impl AdapterKeyRequirementDeclaration {
    pub fn sort_key(&self) -> (String, String, String) {
        (
            self.engine_family.clone(),
            self.requirement_id.clone(),
            serde_json::to_string(&self.material_kind).unwrap_or_default(),
        )
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            material_kind: self.material_kind,
            bytes: self.bytes,
            archive_parameters: self
                .archive_parameters
                .iter()
                .map(ArchiveParameterDeclaration::redacted_for_report)
                .collect(),
            validation: self.validation.clone(),
            semantic_errors: self.semantic_errors.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParameterDeclaration {
    pub parameter_id: String,
    pub name: String,
    pub kind: ArchiveParameterKind,
    pub required: bool,
}

impl ArchiveParameterDeclaration {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            parameter_id: redact_for_log_or_report(&self.parameter_id),
            name: redact_for_log_or_report(&self.name),
            kind: self.kind,
            required: self.required,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterKeyValidationDeclaration {
    pub method: KeyValidationMethod,
    pub proof_required: bool,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_valid_secret_ref(&value) {
            Ok(Self(value))
        } else {
            Err("secretRef must use a local secret-ref scheme and must not contain raw key material, local paths, whitespace, parent traversal, or null bytes".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn scheme(&self) -> SecretRefScheme {
        let (scheme, _) = self
            .0
            .split_once(':')
            .expect("SecretRef is validated before construction");
        match scheme {
            "local-secret" => SecretRefScheme::LocalSecret,
            "os-keychain" => SecretRefScheme::OsKeychain,
            "secret-manager" => SecretRefScheme::SecretManager,
            "prompt" => SecretRefScheme::Prompt,
            _ => unreachable!("SecretRef scheme is validated before construction"),
        }
    }

    pub fn name(&self) -> &str {
        let (_, name) = self
            .0
            .split_once(':')
            .expect("SecretRef is validated before construction");
        name
    }
}

impl fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SecretRef")
            .field(&"<secret-ref>")
            .finish()
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyResolverErrorKind {
    MalformedRef,
    MissingSecret,
    HelperRequired,
    ExternalStoreUnavailable,
    PromptCancelled,
    OutOfPolicy,
    InvalidMaterial,
    ValidationFailed,
    StoreUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyResolverDiagnostic {
    pub code: SemanticErrorCode,
    pub kind: KeyResolverErrorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref_scheme: Option<SecretRefScheme>,
    pub message: String,
}

impl KeyResolverDiagnostic {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code,
            kind: self.kind,
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref_scheme: self.secret_ref_scheme,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct KeyResolverError {
    diagnostic: KeyResolverDiagnostic,
}

impl KeyResolverError {
    fn new(
        kind: KeyResolverErrorKind,
        code: SemanticErrorCode,
        requirement_id: Option<&str>,
        secret_ref_scheme: Option<SecretRefScheme>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            diagnostic: KeyResolverDiagnostic {
                code,
                kind,
                requirement_id: requirement_id.map(ToOwned::to_owned),
                secret_ref_scheme,
                message: message.into(),
            },
        }
    }

    pub fn malformed_ref(message: impl Into<String>) -> Self {
        Self::new(
            KeyResolverErrorKind::MalformedRef,
            SemanticErrorCode::MalformedSecretRef,
            None,
            None,
            message,
        )
    }

    pub fn missing_secret(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::MissingSecret,
            SemanticErrorCode::MissingKeyMaterial,
            Some(requirement_id),
            Some(scheme),
            "referenced local secret material was not found",
        )
    }

    pub fn helper_required(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::HelperRequired,
            SemanticErrorCode::HelperUnavailable,
            Some(requirement_id),
            Some(scheme),
            "secret ref scheme requires an external helper, keychain, secret manager, or prompt resolver",
        )
    }

    pub fn external_store_unavailable(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::ExternalStoreUnavailable,
            SemanticErrorCode::ExternalSecretUnavailable,
            Some(requirement_id),
            Some(scheme),
            "external secret resolver interface is unavailable for this ref scheme",
        )
    }

    pub fn prompt_cancelled(requirement_id: &str) -> Self {
        Self::new(
            KeyResolverErrorKind::PromptCancelled,
            SemanticErrorCode::PromptCancelled,
            Some(requirement_id),
            Some(SecretRefScheme::Prompt),
            "prompt secret resolver was cancelled before material was supplied",
        )
    }

    pub fn out_of_policy(
        requirement_id: Option<&str>,
        scheme: Option<SecretRefScheme>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(
            KeyResolverErrorKind::OutOfPolicy,
            SemanticErrorCode::SecretRefOutOfPolicy,
            requirement_id,
            scheme,
            message,
        )
    }

    pub fn invalid_material(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::InvalidMaterial,
            SemanticErrorCode::KeyValidationFailed,
            Some(requirement_id),
            Some(scheme),
            "resolved secret material did not match the key requirement shape",
        )
    }

    pub fn validation_failed(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::ValidationFailed,
            SemanticErrorCode::KeyValidationFailed,
            Some(requirement_id),
            Some(scheme),
            "resolved secret material failed key validation",
        )
    }

    pub fn store_unavailable(message: impl Into<String>) -> Self {
        Self::new(
            KeyResolverErrorKind::StoreUnavailable,
            SemanticErrorCode::MissingKeyMaterial,
            None,
            Some(SecretRefScheme::LocalSecret),
            message,
        )
    }

    pub fn kind(&self) -> KeyResolverErrorKind {
        self.diagnostic.kind
    }

    pub fn semantic_code(&self) -> SemanticErrorCode {
        self.diagnostic.code
    }

    pub fn diagnostic(&self) -> KeyResolverDiagnostic {
        self.redacted_diagnostic()
    }

    pub fn redacted_diagnostic(&self) -> KeyResolverDiagnostic {
        self.diagnostic.redacted_for_report()
    }
}

impl fmt::Debug for KeyResolverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyResolverError")
            .field("diagnostic", &self.redacted_diagnostic())
            .finish()
    }
}

impl fmt::Display for KeyResolverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let diagnostic = self.redacted_diagnostic();
        match (&diagnostic.requirement_id, diagnostic.secret_ref_scheme) {
            (Some(requirement_id), Some(scheme)) => write!(
                formatter,
                "{} for requirement {} using {}",
                diagnostic.code, requirement_id, scheme
            ),
            (Some(requirement_id), None) => {
                write!(
                    formatter,
                    "{} for requirement {}",
                    diagnostic.code, requirement_id
                )
            }
            (None, Some(scheme)) => write!(formatter, "{} using {}", diagnostic.code, scheme),
            (None, None) => formatter.write_str(diagnostic.code.as_str()),
        }
    }
}

impl std::error::Error for KeyResolverError {}

pub trait LocalSecretStore {
    fn read_secret(&self, local_secret_id: &str) -> Result<Option<Vec<u8>>, KeyResolverError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExternalSecretRequest<'a> {
    pub requirement_id: &'a str,
    pub scheme: SecretRefScheme,
    pub secret_ref_name: &'a str,
    pub material_kind: KeyMaterialKind,
    pub bytes: Option<u32>,
}

#[derive(Clone, PartialEq, Eq)]
pub enum ExternalSecretResolution {
    Material(Vec<u8>),
    Unavailable,
    PromptCancelled,
}

impl fmt::Debug for ExternalSecretResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Material(material) => formatter
                .debug_tuple("Material")
                .field(&format_args!(
                    "[REDACTED:{}; byte_len={}]",
                    SEMANTIC_SECRET_REDACTED,
                    material.len()
                ))
                .finish(),
            Self::Unavailable => formatter.write_str("Unavailable"),
            Self::PromptCancelled => formatter.write_str("PromptCancelled"),
        }
    }
}

pub trait ExternalSecretResolver {
    fn resolve_external_secret(
        &self,
        request: ExternalSecretRequest<'_>,
    ) -> Result<ExternalSecretResolution, KeyResolverError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoExternalSecretResolver;

impl ExternalSecretResolver for NoExternalSecretResolver {
    fn resolve_external_secret(
        &self,
        _request: ExternalSecretRequest<'_>,
    ) -> Result<ExternalSecretResolution, KeyResolverError> {
        Ok(ExternalSecretResolution::Unavailable)
    }
}

#[derive(Clone, Default)]
pub struct InMemoryLocalSecretStore {
    secrets: BTreeMap<String, Vec<u8>>,
}

impl InMemoryLocalSecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_secret(mut self, local_secret_id: impl Into<String>, material: Vec<u8>) -> Self {
        self.secrets.insert(local_secret_id.into(), material);
        self
    }

    pub fn fixture_ci() -> Self {
        Self::new()
            .with_secret(
                "fixture/siglus/secondary-key",
                (0_u8..16).collect::<Vec<_>>(),
            )
            .with_secret(
                "fixture/rpg-maker/asset-key",
                b"00112233445566778899aabbccddeeff".to_vec(),
            )
    }
}

impl LocalSecretStore for InMemoryLocalSecretStore {
    fn read_secret(&self, local_secret_id: &str) -> Result<Option<Vec<u8>>, KeyResolverError> {
        Ok(self.secrets.get(local_secret_id).cloned())
    }
}

impl fmt::Debug for InMemoryLocalSecretStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InMemoryLocalSecretStore")
            .field("secret_count", &self.secrets.len())
            .finish()
    }
}

#[derive(Clone)]
pub struct LocalSecretDirectoryStore {
    root: PathBuf,
    max_secret_bytes: usize,
}

impl LocalSecretDirectoryStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_secret_bytes: 4096,
        }
    }

    pub fn with_max_secret_bytes(mut self, max_secret_bytes: usize) -> Self {
        self.max_secret_bytes = max_secret_bytes;
        self
    }

    pub fn support_boundary(&self) -> &'static str {
        local_secret_directory_support_boundary()
    }

    pub fn import_key_reference(
        &self,
        request: LocalKeyImportRequest,
    ) -> Result<LocalKeyImportResult, KeyResolverError> {
        if request.secret_ref.scheme() != SecretRefScheme::LocalSecret {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(request.secret_ref.scheme()),
                "manual key imports may only write local-secret refs",
            ));
        }
        if request.material.is_empty() || request.material.len() > self.max_secret_bytes {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret import material must be non-empty and within the configured byte limit",
            ));
        }
        if request.key_purpose.trim().is_empty() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "key purpose metadata must not be empty",
            ));
        }
        if request.engine_profile_id.trim().is_empty() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "engine profile id metadata must not be empty",
            ));
        }
        if request.redaction_status != HelperRedactionStatus::Redacted {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "manual and known-key imports must persist only redacted metadata",
            ));
        }

        let secret_path = self.checked_new_secret_path(request.secret_ref.name())?;
        let metadata_path = self.metadata_path_for_secret(request.secret_ref.name())?;
        write_secret_material_no_clobber(&secret_path, &request.material)?;

        let result = LocalKeyImportResult {
            schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
            import_id: deterministic_id("key-import", 87),
            secret_ref: request.secret_ref.clone(),
            key_purpose: request.key_purpose,
            engine_profile_id: request.engine_profile_id,
            source_hash: request.source_hash,
            material_hash: ProofHash::new(sha256_hash_bytes(&request.material))
                .expect("sha256_hash_bytes returns a canonical proof hash"),
            material_bytes: request.material.len(),
            redaction_status: request.redaction_status,
            source: request.source,
            stored_local_ref: true,
            diagnostics: vec![],
        }
        .redacted_for_report();

        let metadata = result.stable_json().map_err(|_| {
            KeyResolverError::store_unavailable("local key import metadata could not be serialized")
        })?;
        if let Err(error) = atomic_write_text(&metadata_path, &metadata) {
            let _ = fs::remove_file(&secret_path);
            return Err(KeyResolverError::store_unavailable(format!(
                "local key import metadata could not be written: {}",
                redact_for_log_or_report(&error.to_string())
            )));
        }
        Ok(result)
    }

    fn checked_new_secret_path(&self, local_secret_id: &str) -> Result<PathBuf, KeyResolverError> {
        let parts = safe_relative_path_parts(local_secret_id).map_err(|_| {
            KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret ids must map to safe relative store paths",
            )
        })?;
        ensure_real_directory(&self.root)?;
        let root = fs::canonicalize(&self.root).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store root could not be canonicalized",
            )
        })?;
        let mut parent = self.root.clone();
        for part in &parts[..parts.len().saturating_sub(1)] {
            parent.push(part);
            ensure_real_directory(&parent)?;
        }
        let canonical_parent = fs::canonicalize(&parent).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store parent could not be canonicalized",
            )
        })?;
        if !canonical_parent.starts_with(&root) {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material must remain under the configured store root",
            ));
        }
        let mut candidate = parent;
        candidate.push(
            parts
                .last()
                .expect("validated refs contain at least one part"),
        );
        if fs::symlink_metadata(&candidate).is_ok() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret import refuses to overwrite existing material",
            ));
        }
        Ok(candidate)
    }

    fn metadata_path_for_secret(&self, local_secret_id: &str) -> Result<PathBuf, KeyResolverError> {
        let mut path = safe_join_relative(&self.root, local_secret_id).map_err(|_| {
            KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret ids must map to safe relative store paths",
            )
        })?;
        let file_name = path
            .file_name()
            .ok_or_else(|| {
                KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret ids must include a final path component",
                )
            })?
            .to_string_lossy()
            .to_string();
        path.set_file_name(format!("{file_name}.kaifuu-key.json"));
        Ok(path)
    }

    fn checked_secret_path(
        &self,
        local_secret_id: &str,
    ) -> Result<Option<(PathBuf, fs::Metadata)>, KeyResolverError> {
        let parts = safe_relative_path_parts(local_secret_id).map_err(|_| {
            KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret ids must map to safe relative store paths",
            )
        })?;
        let root_metadata = fs::symlink_metadata(&self.root).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store root metadata could not be read",
            )
        })?;
        if root_metadata.file_type().is_symlink() || !root_metadata.file_type().is_dir() {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local secret store root must be a real directory",
            ));
        }
        let root = fs::canonicalize(&self.root).map_err(|_| {
            KeyResolverError::store_unavailable(
                "local secret store root could not be canonicalized",
            )
        })?;
        let mut candidate = self.root.clone();
        for (index, part) in parts.iter().enumerate() {
            candidate.push(part);
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(_) => {
                    return Err(KeyResolverError::store_unavailable(
                        "local secret store could not read secret metadata",
                    ));
                }
            };
            if metadata.file_type().is_symlink() {
                return Err(KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret paths must not contain symlink components",
                ));
            }
            let is_final = index + 1 == parts.len();
            if is_final {
                if !metadata.file_type().is_file() {
                    return Err(KeyResolverError::out_of_policy(
                        None,
                        Some(SecretRefScheme::LocalSecret),
                        "local-secret material must be stored in regular files",
                    ));
                }
                if metadata.len() > self.max_secret_bytes as u64 {
                    return Err(KeyResolverError::out_of_policy(
                        None,
                        Some(SecretRefScheme::LocalSecret),
                        "local-secret material exceeds the configured byte limit",
                    ));
                }
            } else if !metadata.file_type().is_dir() {
                return Err(KeyResolverError::out_of_policy(
                    None,
                    Some(SecretRefScheme::LocalSecret),
                    "local-secret parent components must be real directories",
                ));
            }
        }
        let canonical_candidate = fs::canonicalize(&candidate).map_err(|_| {
            KeyResolverError::store_unavailable("local secret material could not be canonicalized")
        })?;
        if !canonical_candidate.starts_with(&root) {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material must remain under the configured store root",
            ));
        }
        let metadata = fs::metadata(&canonical_candidate).map_err(|_| {
            KeyResolverError::store_unavailable("local secret material metadata could not be read")
        })?;
        Ok(Some((canonical_candidate, metadata)))
    }
}

impl LocalSecretStore for LocalSecretDirectoryStore {
    fn read_secret(&self, local_secret_id: &str) -> Result<Option<Vec<u8>>, KeyResolverError> {
        let Some((path, preopen_metadata)) = self.checked_secret_path(local_secret_id)? else {
            return Ok(None);
        };
        let mut file = File::open(&path).map_err(|_| {
            KeyResolverError::store_unavailable("local secret store could not open secret material")
        })?;
        let open_metadata = file.metadata().map_err(|_| {
            KeyResolverError::store_unavailable("local secret store could not inspect open secret")
        })?;
        verify_opened_secret_matches_preopen_metadata(&preopen_metadata, &open_metadata)?;
        if open_metadata.len() > self.max_secret_bytes as u64 {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material exceeds the configured byte limit",
            ));
        }
        let mut material = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(self.max_secret_bytes as u64 + 1)
            .read_to_end(&mut material)
            .map_err(|_| {
                KeyResolverError::store_unavailable(
                    "local secret store could not read secret material",
                )
            })?;
        if material.len() > self.max_secret_bytes {
            return Err(KeyResolverError::out_of_policy(
                None,
                Some(SecretRefScheme::LocalSecret),
                "local-secret material exceeds the configured byte limit",
            ));
        }
        Ok(Some(material))
    }
}

impl fmt::Debug for LocalSecretDirectoryStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalSecretDirectoryStore")
            .field(
                "root",
                &format_args!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            )
            .field("max_secret_bytes", &self.max_secret_bytes)
            .finish()
    }
}

#[cfg(unix)]
fn verify_opened_secret_matches_preopen_metadata(
    preopen_metadata: &fs::Metadata,
    open_metadata: &fs::Metadata,
) -> Result<(), KeyResolverError> {
    use std::os::unix::fs::MetadataExt;

    if preopen_metadata.dev() == open_metadata.dev()
        && preopen_metadata.ino() == open_metadata.ino()
    {
        Ok(())
    } else {
        Err(KeyResolverError::out_of_policy(
            None,
            Some(SecretRefScheme::LocalSecret),
            "local-secret file changed while being opened",
        ))
    }
}

#[cfg(not(unix))]
fn verify_opened_secret_matches_preopen_metadata(
    _preopen_metadata: &fs::Metadata,
    open_metadata: &fs::Metadata,
) -> Result<(), KeyResolverError> {
    if open_metadata.file_type().is_file() {
        Ok(())
    } else {
        Err(KeyResolverError::out_of_policy(
            None,
            Some(SecretRefScheme::LocalSecret),
            "local-secret opened material is not a regular file",
        ))
    }
}

#[cfg(unix)]
fn local_secret_directory_support_boundary() -> &'static str {
    "component symlink rejection, canonical root containment, regular-file checks, and Unix device/inode recheck after open; no real keychain or prompt backend"
}

#[cfg(not(unix))]
fn local_secret_directory_support_boundary() -> &'static str {
    "component symlink rejection, canonical root containment, and regular-file checks; final device/inode recheck is unavailable on this platform in std"
}

#[derive(Clone, PartialEq, Eq)]
pub struct KeyResolverPolicy {
    pub allowed_local_secret_prefixes: Vec<String>,
}

impl KeyResolverPolicy {
    pub fn allow_all_local() -> Self {
        Self {
            allowed_local_secret_prefixes: vec![],
        }
    }

    pub fn allow_prefixes(prefixes: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            allowed_local_secret_prefixes: prefixes.into_iter().map(Into::into).collect(),
        }
    }

    fn permits_local_secret_id(&self, local_secret_id: &str) -> bool {
        self.allowed_local_secret_prefixes.is_empty()
            || self
                .allowed_local_secret_prefixes
                .iter()
                .any(|prefix| allow_prefix_authorizes_local_secret_id(prefix, local_secret_id))
    }
}

/// Segment-aware local-secret allow-prefix match.
/// An allow-prefix authorizes an id iff the id EQUALS the prefix (exact) or the
/// id continues past the prefix on a `/`-delimited path SEGMENT boundary
/// (`prefix + "/"`). A trailing `/` on the configured prefix is normalized away
/// so `foo/` and `foo` behave identically.
/// This deliberately rejects raw string-prefix over-matches: an allow-prefix
/// `private/customer/account` authorizes `private/customer/account` and
/// `private/customer/account/key`, but NOT the sibling
/// `private/customer/accounting/key` (segment `accounting`!= `account`).
fn allow_prefix_authorizes_local_secret_id(prefix: &str, local_secret_id: &str) -> bool {
    let boundary = prefix.trim_end_matches('/');
    local_secret_id == boundary
        || local_secret_id
            .strip_prefix(boundary)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl Default for KeyResolverPolicy {
    fn default() -> Self {
        Self::allow_all_local()
    }
}

impl fmt::Debug for KeyResolverPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyResolverPolicy")
            .field(
                "allowed_local_secret_prefixes",
                &format_args!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            )
            .field(
                "allowed_local_secret_prefix_count",
                &self.allowed_local_secret_prefixes.len(),
            )
            .finish()
    }
}

pub struct LocalKeyResolver<S, E = NoExternalSecretResolver> {
    store: S,
    external_resolver: E,
    policy: KeyResolverPolicy,
}

impl<S, E> fmt::Debug for LocalKeyResolver<S, E>
where
    S: fmt::Debug,
    E: fmt::Debug,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalKeyResolver")
            .field("store", &self.store)
            .field("external_resolver", &self.external_resolver)
            .field("policy", &self.policy)
            .finish()
    }
}

impl<S> LocalKeyResolver<S, NoExternalSecretResolver>
where
    S: LocalSecretStore,
{
    pub fn new(store: S) -> Self {
        Self {
            store,
            external_resolver: NoExternalSecretResolver,
            policy: KeyResolverPolicy::default(),
        }
    }
}

impl<S, E> LocalKeyResolver<S, E>
where
    S: LocalSecretStore,
    E: ExternalSecretResolver,
{
    pub fn with_external_resolver<NextExternalResolver>(
        self,
        external_resolver: NextExternalResolver,
    ) -> LocalKeyResolver<S, NextExternalResolver>
    where
        NextExternalResolver: ExternalSecretResolver,
    {
        LocalKeyResolver {
            store: self.store,
            external_resolver,
            policy: self.policy,
        }
    }

    pub fn with_policy(mut self, policy: KeyResolverPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn resolve_profile(
        &self,
        profile: &GameProfile,
    ) -> Result<ResolvedKeySet, KeyResolverError> {
        let validation = profile.validate();
        if validation.status != OperationStatus::Passed {
            return Err(KeyResolverError::out_of_policy(
                None,
                None,
                "profile must pass key-profile validation before resolving secret refs",
            ));
        }
        self.resolve_requirements(
            &profile.key_requirements,
            profile
                .helper_evidence
                .as_ref()
                .map(|evidence| evidence.tool_version.as_str()),
        )
    }

    pub fn resolve_requirements(
        &self,
        requirements: &[KeyRequirement],
        helper_tool_version: Option<&str>,
    ) -> Result<ResolvedKeySet, KeyResolverError> {
        let mut resolved = ResolvedKeySet::default();
        for requirement in requirements {
            let scheme = requirement.secret_ref.scheme();
            let raw_material = match scheme {
                SecretRefScheme::LocalSecret => {
                    let local_secret_id = requirement.secret_ref.name();
                    if !self.policy.permits_local_secret_id(local_secret_id) {
                        return Err(KeyResolverError::out_of_policy(
                            Some(&requirement.requirement_id),
                            Some(scheme),
                            "local-secret id is outside the resolver policy",
                        ));
                    }
                    self.store.read_secret(local_secret_id)?.ok_or_else(|| {
                        KeyResolverError::missing_secret(&requirement.requirement_id, scheme)
                    })?
                }
                SecretRefScheme::OsKeychain
                | SecretRefScheme::SecretManager
                | SecretRefScheme::Prompt => {
                    match self
                        .external_resolver
                        .resolve_external_secret(ExternalSecretRequest {
                            requirement_id: &requirement.requirement_id,
                            scheme,
                            secret_ref_name: requirement.secret_ref.name(),
                            material_kind: requirement.kind,
                            bytes: requirement.bytes,
                        })? {
                        ExternalSecretResolution::Material(material) => material,
                        ExternalSecretResolution::Unavailable => {
                            return Err(KeyResolverError::external_store_unavailable(
                                &requirement.requirement_id,
                                scheme,
                            ));
                        }
                        ExternalSecretResolution::PromptCancelled => {
                            return Err(KeyResolverError::prompt_cancelled(
                                &requirement.requirement_id,
                            ));
                        }
                    }
                }
            };
            let material = normalize_key_material(requirement, scheme, raw_material)?;
            let byte_length = material.byte_len();
            resolved.proof_records.push(ResolvedKeyProofRecord {
                requirement_id: requirement.requirement_id.clone(),
                secret_ref_scheme: scheme,
                material_kind: requirement.kind,
                byte_length,
                readiness_status: KeyResolutionStatus::Resolved,
                validation_method: requirement.validation.as_ref().map(|proof| proof.method),
                proof_hash: requirement
                    .validation
                    .as_ref()
                    .map(|proof| proof.proof_hash.clone()),
                helper_tool_version: helper_tool_version.map(ToOwned::to_owned),
            });
            resolved
                .materials
                .insert(requirement.requirement_id.clone(), material);
        }
        resolved.proof_records.sort_by_key(|proof| {
            (
                proof.requirement_id.clone(),
                serde_json::to_string(&proof.material_kind).unwrap_or_default(),
            )
        });
        Ok(resolved)
    }

    pub fn resolve_secret_ref_str(
        &self,
        requirement_id: &str,
        secret_ref: &str,
        kind: KeyMaterialKind,
        bytes: Option<u32>,
    ) -> Result<ResolvedKeyMaterial, KeyResolverError> {
        let secret_ref =
            SecretRef::new(secret_ref.to_string()).map_err(KeyResolverError::malformed_ref)?;
        let requirement = KeyRequirement {
            requirement_id: requirement_id.to_string(),
            secret_ref,
            kind,
            bytes,
            validation: None,
        };
        let mut resolved = self.resolve_requirements(&[requirement], None)?;
        resolved.materials.remove(requirement_id).ok_or_else(|| {
            KeyResolverError::missing_secret(requirement_id, SecretRefScheme::LocalSecret)
        })
    }
}

fn normalize_key_material(
    requirement: &KeyRequirement,
    scheme: SecretRefScheme,
    raw_material: Vec<u8>,
) -> Result<ResolvedKeyMaterial, KeyResolverError> {
    let bytes = match requirement.kind {
        KeyMaterialKind::FixedBytes => raw_material,
        KeyMaterialKind::HexBytes => {
            let text = std::str::from_utf8(&raw_material).map_err(|_| {
                KeyResolverError::invalid_material(&requirement.requirement_id, scheme)
            })?;
            decode_hex_material(text).ok_or_else(|| {
                KeyResolverError::invalid_material(&requirement.requirement_id, scheme)
            })?
        }
        KeyMaterialKind::RpgMakerAssetKey => normalize_rpg_maker_asset_key_material(raw_material),
        KeyMaterialKind::Utf8String | KeyMaterialKind::ArchivePassword => {
            std::str::from_utf8(&raw_material).map_err(|_| {
                KeyResolverError::invalid_material(&requirement.requirement_id, scheme)
            })?;
            raw_material
        }
    };
    if let Some(expected_len) = requirement.bytes
        && bytes.len() != expected_len as usize
    {
        return Err(KeyResolverError::invalid_material(
            &requirement.requirement_id,
            scheme,
        ));
    }
    if bytes.is_empty() {
        return Err(KeyResolverError::invalid_material(
            &requirement.requirement_id,
            scheme,
        ));
    }
    Ok(ResolvedKeyMaterial::new(bytes))
}

#[path = "lib/semantic_error.rs"]
mod semantic_error;
pub use semantic_error::SemanticErrorCode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRedactionResult {
    pub value: Value,
    pub findings: Vec<SecretRedactionFinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRedactionFinding {
    pub code: String,
    pub field: String,
    pub reason: String,
}

pub fn validate_secret_redaction_boundary(value: &Value) -> Vec<SecretRedactionFinding> {
    redact_secret_bearing_value(value).findings
}

pub fn redact_secret_bearing_value(value: &Value) -> SecretRedactionResult {
    let mut findings = Vec::new();
    let value = redact_secret_bearing_value_at(value, "$", &mut findings);
    SecretRedactionResult { value, findings }
}

fn redact_secret_bearing_value_at(
    value: &Value,
    field: &str,
    findings: &mut Vec<SecretRedactionFinding>,
) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                if let Some(reason) = secret_redaction_reason(key, &child_field, child) {
                    findings.push(SecretRedactionFinding {
                        code: SemanticErrorCode::SecretRedacted.to_string(),
                        field: child_field,
                        reason: reason.to_string(),
                    });
                    redacted.insert(
                        key.clone(),
                        Value::String(format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")),
                    );
                } else {
                    redacted.insert(
                        key.clone(),
                        redact_secret_bearing_value_at(child, &child_field, findings),
                    );
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    redact_secret_bearing_value_at(item, &format!("{field}.{index}"), findings)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn secret_redaction_reason<'a>(key: &str, field: &str, value: &'a Value) -> Option<&'a str> {
    let normalized = normalize_secret_field_name(key);
    if normalized == "secretref"
        && value
            .as_str()
            .is_some_and(|secret_ref| SecretRef::new(secret_ref.to_string()).is_ok())
    {
        return None;
    }
    if normalized == "secret" && value.is_boolean() {
        return None;
    }
    if is_forbidden_secret_field(&normalized) {
        return Some(
            "secret-bearing fields must be redacted before profiles or reports are persisted",
        );
    }
    let text = value.as_str()?;
    if is_free_text_secret_scan_field(&normalized) && free_text_requires_redaction(text) {
        return Some(
            "free-text profile/report fields must not persist secrets, helper dumps, decrypted text, local paths, or private source filenames",
        );
    }
    if is_path_like_field(&normalized) && is_local_absolute_path(text) {
        return Some("local paths must be redacted from profiles and reports");
    }
    if is_key_like_context(&normalized, field) && looks_like_raw_key_material(text) {
        return Some("raw key-like material must be referenced through secretRef, not persisted");
    }
    if is_archive_parameter_value_field(field) && looks_like_raw_key_material(text) {
        return Some(
            "raw key-like archive parameter values must be referenced through secretRef, not persisted",
        );
    }
    None
}

fn normalize_secret_field_name(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

fn helper_execution_config_field_is_forbidden(key: &str) -> bool {
    matches!(
        normalize_secret_field_name(key).as_str(),
        "command"
            | "args"
            | "argv"
            | "shell"
            | "env"
            | "environment"
            | "executable"
            | "executablepath"
    )
}

fn helper_execution_config_field_is_forbidden_at(key: &str, field: &str) -> bool {
    if helper_execution_config_field_is_forbidden(key) {
        return true;
    }
    let normalized = normalize_secret_field_name(key);
    let normalized_field = normalize_secret_field_name(field);
    let helper_context = normalized_field.contains("helper");
    let helper_config_key = normalized == "path"
        || normalized == "filepath"
        || normalized == "binarypath"
        || normalized == "helperpath"
        || normalized == "helperbinary"
        || normalized == "helperbinarypath"
        || normalized == "location"
        || normalized == "uri"
        || normalized == "config"
        || normalized == "configuration"
        || normalized == "helperconfig"
        || normalized == "launchconfig"
        || normalized == "settings"
        || normalized == "options";
    helper_context && helper_config_key
}

fn is_forbidden_secret_field(normalized: &str) -> bool {
    matches!(
        normalized,
        "rawkey"
            | "keymaterial"
            | "keybytes"
            | "keyhex"
            | "keyvalue"
            | "rawsecret"
            | "secretmaterial"
            | "secretvalue"
            | "helperdump"
            | "helperlog"
            | "rawlog"
            | "memorydump"
            | "decryptedtext"
            | "decryptedplaintext"
            | "privatetext"
            | "localpath"
    )
}

fn is_path_like_field(normalized: &str) -> bool {
    normalized.contains("path") || normalized == "gamedir"
}

fn is_free_text_secret_scan_field(normalized: &str) -> bool {
    matches!(normalized, "description" | "placeholder" | "limitation")
}

fn is_key_like_context(normalized: &str, field: &str) -> bool {
    normalized.contains("key")
        || normalized.contains("secret")
        || field.starts_with("keyRequirements.")
        || field.contains(".keyRequirements.")
}

pub(crate) fn looks_like_raw_key_material(text: &str) -> bool {
    let text = text.trim();
    if text.starts_with("sha256:") || is_valid_secret_ref(text) {
        return false;
    }
    looks_like_raw_key_material_without_secret_ref(text)
}

fn is_archive_parameter_value_field(field: &str) -> bool {
    let segments = field.split('.').collect::<Vec<_>>();
    segments.len() >= 3
        && segments.last() == Some(&"value")
        && segments
            .get(segments.len().saturating_sub(3))
            .is_some_and(|segment| *segment == "archiveParameters")
        && segments
            .get(segments.len().saturating_sub(2))
            .is_some_and(|segment| segment.parse::<usize>().is_ok())
}

pub(crate) fn is_local_absolute_path(text: &str) -> bool {
    text.starts_with('/')
        || text.starts_with('\\')
        || path_has_windows_drive_prefix_component(text)
        || path_starts_with_home_or_local_env_var(text)
}

fn is_valid_secret_ref(value: &str) -> bool {
    let Some((scheme, name)) = value.split_once(':') else {
        return false;
    };
    if !matches!(
        scheme,
        "local-secret" | "os-keychain" | "secret-manager" | "prompt"
    ) {
        return false;
    }
    if name.is_empty()
        || name.trim() != name
        || name.contains('\0')
        || name.contains('\\')
        || name
            .split('/')
            .any(|component| component.is_empty() || component == "..")
        || is_local_absolute_path(name)
        || secret_ref_name_contains_raw_key_material(name)
    {
        return false;
    }
    name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
    })
}

fn secret_ref_name_contains_raw_key_material(name: &str) -> bool {
    looks_like_raw_key_material_without_secret_ref(name)
        || name
            .split('/')
            .any(looks_like_raw_key_material_without_secret_ref)
}

fn looks_like_raw_key_material_without_secret_ref(text: &str) -> bool {
    let hex_compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r' | ':' | '-'))
        .collect::<String>();
    if hex_compact.len() >= 32
        && hex_compact.len() % 2 == 0
        && hex_compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return true;
    }

    let encoded_compact = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '\n' | '\r'))
        .collect::<String>();
    looks_like_base64_key_material(&encoded_compact)
        || looks_like_base64url_key_material(&encoded_compact)
}

fn looks_like_base64_key_material(text: &str) -> bool {
    text.len() >= 22
        && text.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
        && text
            .chars()
            .any(|character| matches!(character, '+' | '/' | '='))
        && base64_padding_is_valid(text)
        && encoded_material_entropy(text) >= 4.0
}

fn looks_like_base64url_key_material(text: &str) -> bool {
    let unpadded = text.trim_end_matches('=');
    if !(22..=256).contains(&unpadded.len()) {
        return false;
    }
    if !base64_padding_is_valid(text)
        || !unpadded
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || unpadded.contains('=')
    {
        return false;
    }

    let has_lowercase = unpadded
        .chars()
        .any(|character| character.is_ascii_lowercase());
    let has_uppercase = unpadded
        .chars()
        .any(|character| character.is_ascii_uppercase());
    let has_digit = unpadded.chars().any(|character| character.is_ascii_digit());
    let has_url_symbol = unpadded
        .chars()
        .any(|character| matches!(character, '-' | '_'));
    let signal_classes =
        usize::from(has_lowercase) + usize::from(has_uppercase) + usize::from(has_digit);
    let entropy = encoded_material_entropy(unpadded);
    (signal_classes >= 3 && entropy >= 4.0)
        || (has_url_symbol && signal_classes >= 2 && entropy >= 3.8)
        || (has_lowercase && has_uppercase && unpadded.len() >= 24 && entropy >= 4.0)
}

fn base64_padding_is_valid(text: &str) -> bool {
    if text.len() % 4 == 1 {
        return false;
    }
    let first_padding = text.find('=').unwrap_or(text.len());
    text[first_padding..]
        .chars()
        .all(|character| character == '=')
}

fn encoded_material_entropy(text: &str) -> f64 {
    let sample = text.trim_end_matches('=');
    if sample.is_empty() {
        return 0.0;
    }
    let mut frequencies = BTreeMap::<char, usize>::new();
    for character in sample.chars() {
        *frequencies.entry(character).or_default() += 1;
    }
    let length = sample.chars().count() as f64;
    frequencies
        .values()
        .map(|count| {
            let probability = *count as f64 / length;
            -probability * probability.log2()
        })
        .sum()
}

pub fn redact_for_log_or_report(text: &str) -> String {
    if text_requires_redaction(text) {
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    } else {
        text.to_string()
    }
}

pub fn redact_report_value(value: &Value) -> Value {
    redact_report_value_at(value, "$")
}

/// Whether a string leaf named as a typed diagnostic identifier ALSO carries a
/// value matching its known-safe shape, so it can be printed verbatim.
/// The field NAME alone is NOT proof the value is safe: a secret-shaped value
/// that happened to land in a `diagnosticCode`/`failureId`/etc. field must NOT
/// ride through just because of the field name. So the exemption is gated on
/// the VALUE actually matching a vocabulary-token / enum / UUID shape:
/// * stable error codes and v0.2 failure categories
///   (`kaifuu.reallive.patchback_*`, `patch_write_failed`) match a conservative
///   identifier grammar `^[A-Za-z][A-Za-z0-9_.:-]*$` — an ASCII-identifier-ish
///   token with no whitespace, no `+`/`/`/`=` (so no base64), and a leading
///   letter (so no hex/number-leading key material);
/// * `failureId` must be a UUID.
///   If the value does NOT match its safe shape (raw-key-shaped, high-entropy,
///   path-like, base64, …), this returns `false` and the caller falls back to the
///   normal content redactor, so a secret still redacts.
///   The field-NAME secret gate (`secret_redaction_reason`) still runs ahead of
///   this, so a genuinely secret-named field is unaffected either way.
fn is_safe_typed_diagnostic_identifier(key: &str, value: &str) -> bool {
    match normalize_secret_field_name(key).as_str() {
        "code" | "diagnosticcode" | "category" | "rollbackdiagnosticcode" => {
            is_safe_vocabulary_token(value)
        }
        "failureid" => is_uuid_like(value),
        _ => false,
    }
}

/// A conservative enum/vocabulary-token grammar: a leading ASCII letter
/// followed by ASCII letters/digits and the code separators `_`, `.`, `:`, `-`.
/// Deliberately excludes whitespace and every base64/base64 symbol
/// (`+`, `/`, `=`), and requires a leading LETTER so a hex- or number-leading
/// raw-key string cannot pass. Matches `^[A-Za-z][A-Za-z0-9_.:-]*$`.
/// The grammar alone still admits `-`/`_`, so a base64url raw key that happens
/// to lead with a letter could match it. So a value that passes the grammar is
/// additionally run through the raw-key heuristic and rejected if it
/// looks like raw key material — a diagnostic code / category never trips that
/// heuristic, but a high-entropy secret does, and must NOT ride through.
fn is_safe_vocabulary_token(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let grammar_ok = chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
    });
    grammar_ok && !looks_like_raw_key_material(value)
}

/// Free-text diagnostic fields whose typed code prefix + human-readable reason
/// must stay visible for triage, while any secret-shaped token embedded in the
/// prose is scrubbed in place (rather than blanking the whole message).
fn is_diagnostic_free_text_field(key: &str) -> bool {
    matches!(
        normalize_secret_field_name(key).as_str(),
        "cause" | "message" | "reason"
    )
}

/// Scrub only the secret-shaped whitespace tokens out of a free-text diagnostic
/// message, preserving every other token. This keeps the typed diagnostic code
/// and the human-readable reason visible for triage while still masking any
/// raw key material, local path, private payload, or sensitive filename that a
/// message happens to carry.
/// The per-token predicate is the same one the whole-string redactor uses
/// (`text_requires_redaction`), so raw-key redaction is NOT weakened: a token
/// that would have redacted the whole message still redacts — just that token.
fn redact_secret_tokens_in_text(text: &str) -> String {
    // A forbidden private-payload marker (`helper dump`, `decrypted text`,
    // `raw key`, …) is a multi-word phrase that per-token scanning cannot
    // detect, and its presence means the whole message is carrying a private
    // dump rather than a typed diagnostic reason — so redact the whole string.
    // A genuine typed patchback reason never contains these phrases, so triage
    // visibility is unaffected.
    if text_contains_forbidden_private_payload(text) {
        return format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]");
    }
    // Preserve the exact original whitespace runs (single/multi space, tabs,
    // newlines) so the reason reads identically apart from masked tokens.
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        if text_requires_redaction(token) {
            out.push_str("[REDACTED:");
            out.push_str(SEMANTIC_SECRET_REDACTED);
            out.push(']');
        } else {
            out.push_str(token);
        }
        token.clear();
    };
    for character in text.chars() {
        if character.is_whitespace() {
            flush(&mut token, &mut out);
            out.push(character);
        } else {
            token.push(character);
        }
    }
    flush(&mut token, &mut out);
    out
}

fn redact_report_value_at(value: &Value, field: &str) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                if secret_redaction_reason(key, &child_field, child).is_some() {
                    redacted.insert(
                        key.clone(),
                        Value::String(format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")),
                    );
                } else if let Some(text) = child.as_str() {
                    // A string leaf named as a typed diagnostic identifier
                    // (diagnosticCode / category / code / failureId /
                    // rollbackDiagnosticCode) is exempt from the free-text content
                    // heuristic ONLY when its value ALSO matches the known-safe
                    // vocabulary-token / enum / UUID shape — so an operator can
                    // triage a patch failure by its typed code (the common case)
                    // even when that code happens to look hex- or base64url-shaped,
                    // code-named field still falls through to the content redactor
                    // and redacts. Free-text diagnostic fields (cause / message /
                    // reason) keep their typed code + human reason visible while
                    // any embedded secret-shaped token is scrubbed in place.
                    let value = if is_safe_typed_diagnostic_identifier(key, text) {
                        text.to_string()
                    } else if is_diagnostic_free_text_field(key) {
                        redact_secret_tokens_in_text(text)
                    } else {
                        redact_for_log_or_report(text)
                    };
                    redacted.insert(key.clone(), Value::String(value));
                } else {
                    redacted.insert(key.clone(), redact_report_value_at(child, &child_field));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| redact_report_value_at(item, &format!("{field}.{index}")))
                .collect(),
        ),
        Value::String(text) => Value::String(redact_for_log_or_report(text)),
        _ => value.clone(),
    }
}

fn redact_asset_ref_for_report(asset_ref: &str) -> String {
    if asset_ref_requires_redaction(asset_ref) {
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    } else {
        asset_ref.to_string()
    }
}

fn text_requires_redaction(text: &str) -> bool {
    let text = text.trim();
    text_contains_local_absolute_path(text)
        || text_contains_raw_key_material(text)
        || text_contains_forbidden_private_payload(text)
        || text_contains_sensitive_filename(text)
}

fn free_text_requires_redaction(text: &str) -> bool {
    let text = text.trim();
    text_contains_local_absolute_path(text)
        || text_contains_raw_key_material_token(text)
        || text_contains_forbidden_private_payload(text)
        || text_contains_sensitive_filename(text)
}

fn asset_ref_requires_redaction(asset_ref: &str) -> bool {
    if text_requires_redaction(asset_ref) {
        return true;
    }
    let path_part = asset_ref.split('#').next().unwrap_or(asset_ref);
    path_part.contains(['/', '\\']) && safe_relative_path_parts(path_part).is_err()
}

fn text_contains_local_absolute_path(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_punctuation)
        .any(token_contains_local_absolute_path)
}

fn token_contains_local_absolute_path(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if is_local_absolute_path(token) || path_has_windows_drive_prefix_component(token) {
        return true;
    }
    token.char_indices().any(|(index, character)| {
        if !matches!(character, '=' | ':') {
            return false;
        }
        if character == ':'
            && token
                .get(index.saturating_sub(5)..index + 3)
                .is_some_and(|window| window.eq_ignore_ascii_case("https://"))
        {
            return false;
        }
        if character == ':'
            && token
                .get(index.saturating_sub(4)..index + 3)
                .is_some_and(|window| window.eq_ignore_ascii_case("http://"))
        {
            return false;
        }
        let candidate = trim_token_punctuation(&token[index + character.len_utf8()..]);
        !candidate.is_empty()
            && (is_local_absolute_path(candidate)
                || path_has_windows_drive_prefix_component(candidate))
    })
}

fn path_starts_with_home_or_local_env_var(path: &str) -> bool {
    let path = path.trim_start();
    if path.starts_with("~/") || path.starts_with("~\\") {
        return true;
    }

    let local_env_prefixes = [
        "$HOME",
        "${HOME}",
        "$USERPROFILE",
        "${USERPROFILE}",
        "$HOMEPATH",
        "${HOMEPATH}",
        "$APPDATA",
        "${APPDATA}",
        "$LOCALAPPDATA",
        "${LOCALAPPDATA}",
        "%HOME%",
        "%USERPROFILE%",
        "%HOMEPATH%",
        "%APPDATA%",
        "%LOCALAPPDATA%",
        "%TEMP%",
        "%TMP%",
    ];
    local_env_prefixes.iter().any(|prefix| {
        path.get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
            && path[prefix.len()..].starts_with(['/', '\\'])
    })
}

fn text_contains_raw_key_material(text: &str) -> bool {
    if is_sha256_ref(text) || is_uuid_like(text) {
        return false;
    }
    if looks_like_raw_key_material(text) {
        return true;
    }
    text_contains_raw_key_material_token(text)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn text_contains_raw_key_material_token(text: &str) -> bool {
    text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=' | '-' | '_'))
    })
    .any(looks_like_raw_key_material)
}

fn text_contains_forbidden_private_payload(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    [
        "helper dump",
        "memory dump",
        "register dump",
        "raw helper log",
        "decrypted script",
        "decrypted text",
        "private script",
        "private translated",
        "raw key",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn text_contains_sensitive_filename(text: &str) -> bool {
    text.split_whitespace()
        .map(trim_token_punctuation)
        .any(|token| {
            let lower = token.to_ascii_lowercase();
            let looks_like_file = lower.contains('.')
                && lower
                    .rsplit_once('.')
                    .is_some_and(|(_, extension)| extension.len() <= 8);
            looks_like_file
                && ["private", "spoiler", "route", "ending", "true-end"]
                    .iter()
                    .any(|needle| lower.contains(needle))
        })
}

fn trim_token_punctuation(token: &str) -> &str {
    token.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequirement {
    pub category: RequirementCategory,
    pub key: String,
    pub status: RequirementStatus,
    pub description: String,
    pub placeholder: Option<String>,
    pub secret: bool,
}

impl ProfileRequirement {
    pub fn sort_key(&self) -> (String, String, String) {
        (
            serde_json::to_string(&self.category).unwrap_or_default(),
            self.key.clone(),
            serde_json::to_string(&self.status).unwrap_or_default(),
        )
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            category: self.category.clone(),
            key: redact_for_log_or_report(&self.key),
            status: self.status.clone(),
            description: redact_for_log_or_report(&self.description),
            placeholder: self.placeholder.as_deref().map(redact_for_log_or_report),
            secret: self.secret,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementCategory {
    File,
    Platform,
    SecretKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Satisfied,
    Missing,
    NotRequired,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationResult {
    pub schema_version: String,
    pub profile_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<ProfileValidationFailure>,
    pub requirements: Vec<ProfileRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl ProfileValidationResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            profile_id: self.profile_id.as_deref().map(redact_for_log_or_report),
            status: self.status.clone(),
            failures: self
                .failures
                .iter()
                .map(ProfileValidationFailure::redacted_for_report)
                .collect(),
            requirements: self
                .requirements
                .iter()
                .map(ProfileRequirement::redacted_for_report)
                .collect(),
        }
    }
}

impl ProfileValidationFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProfile {
    pub asset_id: String,
    pub path: String,
    pub asset_kind: AssetKind,
    pub text_surfaces: Vec<TextSurface>,
    pub source_hash: Option<String>,
    pub patching: CapabilityReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Script,
    Database,
    Metadata,
    Image,
    Audio,
    Archive,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSurface {
    Dialogue,
    Narration,
    SpeakerName,
    ChoiceLabel,
    UiLabel,
    TutorialText,
    DatabaseEntry,
    SongTitle,
    ImageText,
    MetadataText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetList {
    pub adapter_id: String,
    pub assets: Vec<AssetProfile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryManifest {
    pub schema_version: String,
    pub manifest_id: String,
    pub adapter_id: String,
    pub source_locale: String,
    pub assets: Vec<AssetInventoryAsset>,
    pub surfaces: Vec<AssetInventorySurface>,
    pub capabilities: Vec<CapabilityReport>,
    pub warnings: Vec<AdapterWarning>,
    pub metadata: BTreeMap<String, String>,
}

impl AssetInventoryManifest {
    pub fn normalize(&mut self) {
        self.assets.sort_by_key(|asset| asset.asset_id.clone());
        self.surfaces
            .sort_by_key(|surface| surface.surface_id.clone());
        for surface in &mut self.surfaces {
            surface.notes.sort();
            surface.notes.dedup();
        }
        self.capabilities.sort_by_key(|report| {
            (
                serde_json::to_string(&report.capability).unwrap_or_default(),
                serde_json::to_string(&report.status).unwrap_or_default(),
                report.limitation.clone(),
            )
        });
        self.warnings
            .sort_by_key(|warning| (warning.code.clone(), warning.message.clone()));
    }

    /// Serialize into report-safe, canonical JSON.
    /// Public serialization always routes through the centralized report
    /// redaction policy (`redact_report_value`) so library callers cannot
    /// accidentally leak absolute paths, key material, helper dumps, or
    /// private text into a report/log/fixture. There is no raw public
    /// serialization path for `AssetInventoryManifest`; the redaction cannot
    /// be bypassed through this API.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        let mut normalized = self.clone();
        normalized.normalize();
        let value = redact_report_value(&serde_json::to_value(&normalized)?);
        Ok(format!("{}\n", serde_json::to_string_pretty(&value)?))
    }

    pub fn validate(&self) -> AssetInventoryValidationResult {
        let mut failures = Vec::new();
        if self.schema_version != ASSET_INVENTORY_SCHEMA_VERSION {
            failures.push(AssetInventoryValidationFailure {
                code: "unsupported_schema_version".to_string(),
                field: "schemaVersion".to_string(),
                message: format!(
                    "schemaVersion must be {ASSET_INVENTORY_SCHEMA_VERSION}, got {}",
                    self.schema_version
                ),
            });
        }
        if self.manifest_id.trim().is_empty() {
            failures.push(required_inventory_failure(
                "manifestId",
                "manifestId must not be empty",
            ));
        }
        if self.adapter_id.trim().is_empty() {
            failures.push(required_inventory_failure(
                "adapterId",
                "adapterId must not be empty",
            ));
        }
        if !is_bcp47_like_locale(&self.source_locale) {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_locale".to_string(),
                field: "sourceLocale".to_string(),
                message: "sourceLocale must be a BCP 47-style locale tag".to_string(),
            });
        }
        if self.assets.is_empty() {
            failures.push(AssetInventoryValidationFailure {
                code: "missing_assets".to_string(),
                field: "assets".to_string(),
                message: "asset inventory must include at least one asset".to_string(),
            });
        }

        let mut asset_ids = HashSet::new();
        let mut asset_keys_by_id = BTreeMap::new();
        for (index, asset) in self.assets.iter().enumerate() {
            let field = format!("assets.{index}");
            if asset.asset_id.trim().is_empty()
                || asset.asset_id.chars().any(char::is_whitespace)
                || asset.asset_id.contains('\0')
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_asset_id".to_string(),
                    field: format!("{field}.assetId"),
                    message:
                        "assetId must not be empty and must not contain whitespace or null bytes"
                            .to_string(),
                });
            }
            if !asset_ids.insert(asset.asset_id.clone()) {
                failures.push(AssetInventoryValidationFailure {
                    code: "duplicate_asset_id".to_string(),
                    field: "assets".to_string(),
                    message: format!("assetId {} appears more than once", asset.asset_id),
                });
            }
            if asset.asset_key.trim().is_empty() {
                failures.push(required_inventory_failure(
                    &format!("{field}.assetKey"),
                    "assetKey must not be empty",
                ));
            }
            if let Some(path) = &asset.path {
                validate_asset_inventory_relative_path(
                    &mut failures,
                    &format!("{field}.path"),
                    path,
                );
            }
            if let Some(source_hash) = &asset.source_hash
                && source_hash.trim().is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "sourceHash must be omitted or non-empty".to_string(),
                });
            }
            asset_keys_by_id.insert(asset.asset_id.clone(), asset.asset_key.clone());
        }

        let mut surface_ids = HashSet::new();
        for (index, surface) in self.surfaces.iter().enumerate() {
            let field = format!("surfaces.{index}");
            if surface.surface_id.trim().is_empty()
                || surface.surface_id.chars().any(char::is_whitespace)
                || surface.surface_id.contains('\0')
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_surface_id".to_string(),
                    field: format!("{field}.surfaceId"),
                    message:
                        "surfaceId must not be empty and must not contain whitespace or null bytes"
                            .to_string(),
                });
            }
            if !surface_ids.insert(surface.surface_id.clone()) {
                failures.push(AssetInventoryValidationFailure {
                    code: "duplicate_surface_id".to_string(),
                    field: "surfaces".to_string(),
                    message: format!("surfaceId {} appears more than once", surface.surface_id),
                });
            }
            if !asset_ids.contains(&surface.source_asset_ref.asset_id) {
                failures.push(AssetInventoryValidationFailure {
                    code: "unknown_asset_ref".to_string(),
                    field: format!("{field}.sourceAssetRef.assetId"),
                    message: format!(
                        "surface references unknown assetId {}",
                        surface.source_asset_ref.asset_id
                    ),
                });
            }
            if let Some(expected_key) = asset_keys_by_id.get(&surface.source_asset_ref.asset_id)
                && let Some(asset_key) = &surface.source_asset_ref.asset_key
                && asset_key != expected_key
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "asset_key_mismatch".to_string(),
                    field: format!("{field}.sourceAssetRef.assetKey"),
                    message: format!(
                        "assetKey {asset_key} does not match referenced asset key {expected_key}"
                    ),
                });
            }
            if let Some(source_location) = &surface.source_location {
                validate_asset_inventory_source_location(
                    &mut failures,
                    &format!("{field}.sourceLocation"),
                    source_location,
                );
            }
            if matches!(
                &surface.text_source_kind,
                AssetInventoryTextSourceKind::NotApplicable
            ) && surface.source_text.is_some()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "unexpected_source_text".to_string(),
                    field: format!("{field}.sourceText"),
                    message: "sourceText must be omitted when textSourceKind is not_applicable"
                        .to_string(),
                });
            }
            if !matches!(
                &surface.text_source_kind,
                AssetInventoryTextSourceKind::NotApplicable
            ) && surface
                .source_text
                .as_deref()
                .map_or("", str::trim)
                .is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "missing_source_text".to_string(),
                    field: format!("{field}.sourceText"),
                    message: "sourceText is required unless textSourceKind is not_applicable"
                        .to_string(),
                });
            }
            if let Some(source_hash) = &surface.source_hash
                && source_hash.trim().is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_hash".to_string(),
                    field: format!("{field}.sourceHash"),
                    message: "sourceHash must be omitted or non-empty".to_string(),
                });
            }
            if matches!(
                &surface.patching.status,
                CapabilityStatus::Limited
                    | CapabilityStatus::Unsupported
                    | CapabilityStatus::RequiresUserInput
            ) && surface
                .patching
                .limitation
                .as_deref()
                .map_or("", str::trim)
                .is_empty()
            {
                failures.push(AssetInventoryValidationFailure {
                    code: "missing_patching_limitation".to_string(),
                    field: format!("{field}.patching.limitation"),
                    message:
                        "limited, unsupported, and user-input patching reports require a limitation"
                            .to_string(),
                });
            }
        }

        AssetInventoryValidationResult {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: Some(self.manifest_id.clone()),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
    }

    /// stamp every surface with its stable metadata hash, making the
    /// manifest's asset identity + patch capability tamper-evident. Adapters call
    /// this before publishing a manifest; the validator later recomputes and
    /// rejects any drift.
    pub fn stamp_asset_metadata_hashes(&mut self) {
        let surfaces = self.surfaces.clone();
        for (index, surface) in surfaces.iter().enumerate() {
            let hash = asset_inventory_surface_metadata_hash(self, surface);
            self.surfaces[index].metadata_hash = Some(hash);
        }
    }

    /// run the patch-capability consistency validator, returning the
    /// typed diagnostics that REJECT the manifest (empty = consistent). See
    /// [`validate_asset_inventory_patch_capability`].
    pub fn validate_patch_capability(&self) -> Result<(), Vec<AssetCapabilityDiagnostic>> {
        let diagnostics = validate_asset_inventory_patch_capability(self);
        if diagnostics.is_empty() {
            Ok(())
        } else {
            Err(diagnostics)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryValidationResult {
    pub schema_version: String,
    pub manifest_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<AssetInventoryValidationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryValidationFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

fn required_inventory_failure(field: &str, message: &str) -> AssetInventoryValidationFailure {
    AssetInventoryValidationFailure {
        code: "missing_required_field".to_string(),
        field: field.to_string(),
        message: message.to_string(),
    }
}

fn validate_asset_inventory_relative_path(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    path: &str,
) {
    let mut profile_failures = Vec::new();
    validate_profile_relative_path(&mut profile_failures, field, path);
    if !profile_failures.is_empty() {
        failures.extend(profile_failures.into_iter().map(|failure| {
            AssetInventoryValidationFailure {
                code: failure.code,
                field: failure.field,
                message: failure.message,
            }
        }));
    }
}

fn validate_asset_inventory_source_location(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    value: &Value,
) {
    let Some(location) = value.as_object() else {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: field.to_string(),
            message: "sourceLocation must be a JSON object".to_string(),
        });
        return;
    };

    for key in location.keys() {
        if !["containerKey", "entryPath", "range", "region"].contains(&key.as_str()) {
            failures.push(AssetInventoryValidationFailure {
                code: "engine_specific_source_location".to_string(),
                field: format!("{field}.{key}"),
                message:
                    "sourceLocation must use neutral fields: containerKey, entryPath, range, region"
                        .to_string(),
            });
        }
    }
    if let Some(container_key) = location.get("containerKey")
        && container_key.as_str().map_or("", str::trim).is_empty()
    {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: format!("{field}.containerKey"),
            message: "containerKey must be a non-empty string".to_string(),
        });
    }
    if let Some(entry_path) = location.get("entryPath") {
        let Some(entry_path) = entry_path.as_array() else {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.entryPath"),
                message: "entryPath must be an array of non-empty strings".to_string(),
            });
            return;
        };
        for (index, entry) in entry_path.iter().enumerate() {
            if entry.as_str().map_or("", str::trim).is_empty() {
                failures.push(AssetInventoryValidationFailure {
                    code: "invalid_source_location".to_string(),
                    field: format!("{field}.entryPath.{index}"),
                    message: "entryPath entries must be non-empty strings".to_string(),
                });
            }
        }
    }
    if let Some(range) = location.get("range") {
        validate_asset_inventory_u64_object_fields(
            failures,
            &format!("{field}.range"),
            range,
            &["startByte", "endByte"],
        );
    }
    if let Some(region) = location.get("region") {
        validate_asset_inventory_u64_object_fields(
            failures,
            &format!("{field}.region"),
            region,
            &["x", "y", "width", "height"],
        );
    }
}

fn validate_asset_inventory_u64_object_fields(
    failures: &mut Vec<AssetInventoryValidationFailure>,
    field: &str,
    value: &Value,
    expected_fields: &[&str],
) {
    let Some(object) = value.as_object() else {
        failures.push(AssetInventoryValidationFailure {
            code: "invalid_source_location".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a JSON object"),
        });
        return;
    };
    for key in object.keys() {
        if !expected_fields.contains(&key.as_str()) {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.{key}"),
                message: format!(
                    "{field} must only contain fields: {}",
                    expected_fields.join(", ")
                ),
            });
        }
    }
    for expected in expected_fields {
        if object.get(*expected).and_then(Value::as_u64).is_none() {
            failures.push(AssetInventoryValidationFailure {
                code: "invalid_source_location".to_string(),
                field: format!("{field}.{expected}"),
                message: format!("{field}.{expected} must be an unsigned integer"),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryAsset {
    pub asset_id: String,
    pub asset_key: String,
    pub asset_kind: AssetInventoryAssetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryAssetKind {
    Script,
    Image,
    Audio,
    Video,
    UiTexture,
    Font,
    Database,
    Metadata,
    Text,
    Archive,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventorySurface {
    pub surface_id: String,
    pub asset_surface_kind: AssetInventorySurfaceKind,
    pub source_asset_ref: AssetInventoryAssetRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    pub text_source_kind: AssetInventoryTextSourceKind,
    pub patch_mode: AssetInventoryPatchMode,
    pub patching: CapabilityReport,
    /// the patch payload (a translation/edit) this surface advertises
    /// if any. A surface that carries a payload is claiming to edit its backing
    /// asset; the patch-capability validator rejects a payload whose `patching`
    /// capability is unsupported (a manifest cannot patch an asset it declares it
    /// cannot edit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_payload: Option<AssetInventoryPatchPayload>,
    /// stable, tamper-evident hash over this surface's inventory
    /// IDENTITY + PATCH-DECISION fields (see [`asset_inventory_surface_metadata_hash`]).
    /// When present, the patch-capability validator recomputes the hash and emits
    /// a `metadata_hash_mismatch` diagnostic if the declared hash has drifted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_hash: Option<String>,
    pub notes: Vec<String>,
}

/// a patch payload advertised for an asset surface — the concrete
/// translation/edit the manifest claims it will apply to the surface's backing
/// asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryPatchPayload {
    /// BCP 47-style locale the payload targets (e.g. `en-US`).
    pub target_locale: String,
    /// The translated/edited text the manifest advertises for this surface.
    pub translated_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInventoryAssetRef {
    pub asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventorySurfaceKind {
    ImageText,
    UiArt,
    SongTitle,
    Font,
    Credits,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryTextSourceKind {
    Metadata,
    ManualTranscription,
    OcrHint,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetInventoryPatchMode {
    MetadataOnly,
    NoPatchRequired,
    RegionRedrawRequired,
    AssetReplacementRequired,
    FontSubstitutionRequired,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    pub adapter_id: String,
    pub profile: GameProfile,
    pub bridge: BridgeBundle,
    pub warnings: Vec<AdapterWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBundle {
    pub schema_version: String,
    pub bridge_id: String,
    pub source_bundle_hash: String,
    pub source_locale: String,
    pub extractor_name: String,
    pub extractor_version: String,
    pub units: Vec<BridgeUnit>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeUnit {
    pub bridge_unit_id: String,
    pub source_unit_key: String,
    pub occurrence_id: String,
    pub source_hash: String,
    pub source_locale: String,
    pub source_text: String,
    pub speaker: String,
    pub text_surface: String,
    pub protected_spans: Vec<ProtectedSpan>,
    pub patch_ref: PatchRef,
}

impl fmt::Debug for BridgeUnit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeUnit")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("source_unit_key", &self.source_unit_key)
            .field("occurrence_id", &self.occurrence_id)
            .field("source_hash", &self.source_hash)
            .field("source_locale", &self.source_locale)
            .field(
                "source_text",
                &RedactedContentSummary::from_text(&self.source_text),
            )
            .field("speaker", &RedactedContentSummary::from_text(&self.speaker))
            .field("text_surface", &self.text_surface)
            .field("protected_spans", &self.protected_spans)
            .field("patch_ref", &self.patch_ref)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpan {
    #[serde(skip)]
    pub span_id: Option<String>,
    pub kind: String,
    pub raw: String,
    pub start: u64,
    pub end: u64,
    pub preserve_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variable_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_end_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_end_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_mode: Option<String>,
}

impl fmt::Debug for ProtectedSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let arguments = self
            .arguments
            .as_ref()
            .map(|arguments| RedactedContentSummary::from_text(&arguments.join("\u{1f}")));
        let example_values = self
            .example_values
            .as_ref()
            .map(|values| RedactedContentSummary::from_text(&values.join("\u{1f}")));
        formatter
            .debug_struct("ProtectedSpan")
            .field("span_id", &self.span_id)
            .field("kind", &self.kind)
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("start", &self.start)
            .field("end", &self.end)
            .field("preserve_mode", &self.preserve_mode)
            .field("parsed_name", &self.parsed_name)
            .field("arguments", &arguments)
            .field(
                "variable_name",
                &self
                    .variable_name
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "format_hint",
                &self
                    .format_hint
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("example_values", &example_values)
            .field("base_start_byte", &self.base_start_byte)
            .field("base_end_byte", &self.base_end_byte)
            .field("annotation_start_byte", &self.annotation_start_byte)
            .field("annotation_end_byte", &self.annotation_end_byte)
            .field(
                "annotation_text",
                &self
                    .annotation_text
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "annotation_locale",
                &self
                    .annotation_locale
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "display_mode",
                &self
                    .display_mode
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .finish()
    }
}

impl ProtectedSpan {
    pub fn new(
        kind: impl Into<String>,
        raw: impl Into<String>,
        start: u64,
        end: u64,
        preserve_mode: impl Into<String>,
    ) -> Self {
        Self {
            span_id: None,
            kind: kind.into(),
            raw: raw.into(),
            start,
            end,
            preserve_mode: preserve_mode.into(),
            parsed_name: None,
            arguments: None,
            variable_name: None,
            format_hint: None,
            example_values: None,
            base_start_byte: None,
            base_end_byte: None,
            annotation_start_byte: None,
            annotation_end_byte: None,
            annotation_text: None,
            annotation_locale: None,
            display_mode: None,
        }
    }

    pub fn variable_placeholder(
        raw: impl Into<String>,
        start: u64,
        end: u64,
        variable_name: impl Into<String>,
    ) -> Self {
        let variable_name = variable_name.into();
        let mut span = Self::new("variable_placeholder", raw, start, end, "map");
        span.variable_name = Some(variable_name);
        span
    }

    pub fn control_markup(
        raw: impl Into<String>,
        start: u64,
        end: u64,
        parsed_name: impl Into<String>,
        arguments: Vec<String>,
    ) -> Self {
        let mut span = Self::new("control_markup", raw, start, end, "exact");
        span.parsed_name = Some(parsed_name.into());
        if !arguments.is_empty() {
            span.arguments = Some(arguments);
        }
        span
    }

    pub fn with_span_id(mut self, span_id: impl Into<String>) -> Self {
        self.span_id = Some(span_id.into());
        self
    }

    fn normalized(mut self, source_text: &str) -> KaifuuResult<Self> {
        let original_kind = self.kind.clone();
        self.kind = normalize_protected_span_kind(&self.kind)
            .ok_or_else(|| format!("unsupported protected span kind {}", self.kind))?
            .to_string();
        if self.preserve_mode.trim().is_empty()
            || original_kind == "placeholder"
            || (self.kind == "variable_placeholder" && self.preserve_mode == "exact")
        {
            self.preserve_mode = default_preserve_mode_for_span_kind(&self.kind).to_string();
        }
        if !["exact", "map", "transform", "locale_policy"].contains(&self.preserve_mode.as_str()) {
            return Err(format!(
                "unsupported protected span preserveMode {}",
                self.preserve_mode
            )
            .into());
        }
        self.raw = source_slice_for_span(source_text, self.start, self.end, &self.raw)?.to_string();
        if self.kind == "variable_placeholder" && self.variable_name.is_none() {
            self.variable_name = variable_name_from_raw_placeholder(&self.raw);
        }
        self.arguments = normalize_non_empty_string_vec(self.arguments);
        self.example_values = normalize_non_empty_string_vec(self.example_values);
        Ok(self)
    }

    fn merge_missing_metadata_from(&mut self, other: &Self) {
        if self.parsed_name.is_none() {
            self.parsed_name.clone_from(&other.parsed_name);
        }
        if self.arguments.is_none() {
            self.arguments.clone_from(&other.arguments);
        }
        if self.variable_name.is_none() {
            self.variable_name.clone_from(&other.variable_name);
        }
        if self.format_hint.is_none() {
            self.format_hint.clone_from(&other.format_hint);
        }
        if self.example_values.is_none() {
            self.example_values.clone_from(&other.example_values);
        }
        if self.base_start_byte.is_none() {
            self.base_start_byte = other.base_start_byte;
        }
        if self.base_end_byte.is_none() {
            self.base_end_byte = other.base_end_byte;
        }
        if self.annotation_start_byte.is_none() {
            self.annotation_start_byte = other.annotation_start_byte;
        }
        if self.annotation_end_byte.is_none() {
            self.annotation_end_byte = other.annotation_end_byte;
        }
        if self.annotation_text.is_none() {
            self.annotation_text.clone_from(&other.annotation_text);
        }
        if self.annotation_locale.is_none() {
            self.annotation_locale.clone_from(&other.annotation_locale);
        }
        if self.display_mode.is_none() {
            self.display_mode.clone_from(&other.display_mode);
        }
    }
}

pub fn normalize_protected_spans(
    source_text: &str,
    spans: Vec<ProtectedSpan>,
) -> KaifuuResult<Vec<ProtectedSpan>> {
    let mut normalized = spans
        .into_iter()
        .map(|span| span.normalized(source_text))
        .collect::<KaifuuResult<Vec<_>>>()?;
    normalized.sort_by_key(|span| {
        (
            span.start,
            span.end,
            span.kind.clone(),
            span.raw.clone(),
            span.parsed_name.clone(),
        )
    });

    let mut merged: Vec<ProtectedSpan> = Vec::new();
    for span in normalized {
        if let Some(existing) = merged.last_mut()
            && existing.start == span.start
            && existing.end == span.end
            && existing.kind == span.kind
            && existing.raw == span.raw
        {
            existing.merge_missing_metadata_from(&span);
            continue;
        }
        if let Some(previous) = merged.last()
            && previous.end > span.start
        {
            return Err(format!(
                "protected spans must not overlap: {}..{} overlaps {}..{}",
                previous.start, previous.end, span.start, span.end
            )
            .into());
        }
        merged.push(span);
    }

    Ok(merged)
}

fn normalize_protected_span_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "control_markup" => Some("control_markup"),
        "variable_placeholder" | "placeholder" => Some("variable_placeholder"),
        "ruby_annotation" => Some("ruby_annotation"),
        _ => None,
    }
}

fn default_preserve_mode_for_span_kind(kind: &str) -> &'static str {
    match kind {
        "variable_placeholder" => "map",
        "ruby_annotation" => "locale_policy",
        _ => "exact",
    }
}

fn normalize_non_empty_string_vec(values: Option<Vec<String>>) -> Option<Vec<String>> {
    let values = values?
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn source_slice_for_span<'a>(
    source_text: &'a str,
    start: u64,
    end: u64,
    expected_raw: &str,
) -> KaifuuResult<&'a str> {
    if end <= start {
        return Err("protected span end must be greater than start".into());
    }
    let start = usize::try_from(start).map_err(|_| "protected span start is too large")?;
    let end = usize::try_from(end).map_err(|_| "protected span end is too large")?;
    if end > source_text.len() {
        return Err("protected span end must be within sourceText bytes".into());
    }
    if !source_text.is_char_boundary(start) || !source_text.is_char_boundary(end) {
        return Err("protected span boundaries must align to UTF-8 character boundaries".into());
    }
    let actual = &source_text[start..end];
    if actual != expected_raw {
        let expected = RedactedContentSummary::from_text(expected_raw);
        let observed = RedactedContentSummary::from_text(actual);
        return Err(format!(
            "protected span raw {expected} must match sourceText byte range {start}..{end} ({observed})"
        )
        .into());
    }
    Ok(actual)
}

fn variable_name_from_raw_placeholder(raw: &str) -> Option<String> {
    raw.strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRef {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct BridgeContractValidationError {
    message: String,
    code: Option<&'static str>,
}

impl fmt::Debug for BridgeContractValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeContractValidationError")
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .field("code", &self.code)
            .finish()
    }
}

impl BridgeContractValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    /// Construct a rejection that carries a stable, cross-language semantic
    /// code so callers can branch on the failure category rather than parsing
    /// the human-readable message.
    fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }

    /// The stable semantic code for this rejection, when one has been assigned
    /// (for example [`SEMANTIC_RFC3339_INSTANT_MALFORMED`]).
    #[must_use]
    pub fn code(&self) -> Option<&'static str> {
        self.code
    }

    /// The human-readable rejection message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for BridgeContractValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BridgeContractValidationError {}

pub type BridgeContractResult<T> = Result<T, BridgeContractValidationError>;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBundleV02 {
    pub schema_version: String,
    pub bridge_id: String,
    pub source_game: SourceGameRevisionV02,
    pub source_bundle_hash: String,
    pub source_bundle_revision: SourceRevisionV02,
    pub source_locale: String,
    pub hash_strategy: HashStrategyV02,
    pub extractor: BridgeExtractorV02,
    pub assets: Vec<BridgeAssetV02>,
    pub units: Vec<LocalizationUnitV02>,
    pub policy_records: Vec<PolicyRecordV02>,
}

impl BridgeBundleV02 {
    pub fn validate_json(value: &Value) -> BridgeContractResult<Self> {
        let bundle: Self = serde_json::from_value(value.clone()).map_err(|_| {
            let serialized = value.to_string();
            let summary = RedactedContentSummary::from_text(&serialized);
            BridgeContractValidationError::new(format!(
                "BridgeBundleV02 must match the Rust serde contract (serialized input {summary})"
            ))
        })?;
        bundle.validate()?;
        Ok(bundle)
    }

    pub fn validate(&self) -> BridgeContractResult<()> {
        assert_schema_version_v02(&self.schema_version, "BridgeBundleV02.schemaVersion")?;
        assert_uuid7(&self.bridge_id, "BridgeBundleV02.bridgeId")?;
        self.source_game.validate("BridgeBundleV02.sourceGame")?;
        assert_hash_string_v02(&self.source_bundle_hash, "BridgeBundleV02.sourceBundleHash")?;
        self.source_bundle_revision
            .validate("BridgeBundleV02.sourceBundleRevision")?;
        assert_revision_hash_matches_v02(
            &self.source_bundle_revision,
            &self.source_bundle_hash,
            "BridgeBundleV02.sourceBundleRevision",
        )?;
        assert_non_empty(&self.source_locale, "BridgeBundleV02.sourceLocale")?;
        self.hash_strategy
            .validate("BridgeBundleV02.hashStrategy")?;
        self.extractor.validate("BridgeBundleV02.extractor")?;

        let mut asset_ids = HashSet::new();
        for (index, asset) in self.assets.iter().enumerate() {
            let label = format!("BridgeBundleV02.assets[{index}]");
            asset.validate(&label)?;
            if !asset_ids.insert(asset.asset_id.clone()) {
                return Err(BridgeContractValidationError::new(format!(
                    "{label}.assetId must be unique within BridgeBundleV02.assets"
                )));
            }
        }

        for (index, unit) in self.units.iter().enumerate() {
            let label = format!("BridgeBundleV02.units[{index}]");
            unit.validate(&label, &asset_ids)?;
        }

        for (index, record) in self.policy_records.iter().enumerate() {
            record.validate(&format!("BridgeBundleV02.policyRecords[{index}]"))?;
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceGameRevisionV02 {
    pub game_id: String,
    pub game_version: String,
    pub source_profile_id: String,
    pub source_profile_revision: SourceRevisionV02,
}

impl SourceGameRevisionV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_non_empty(&self.game_id, &format!("{label}.gameId"))?;
        assert_non_empty(&self.game_version, &format!("{label}.gameVersion"))?;
        assert_non_empty(&self.source_profile_id, &format!("{label}.sourceProfileId"))?;
        self.source_profile_revision
            .validate(&format!("{label}.sourceProfileRevision"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevisionV02 {
    pub revision_id: String,
    pub revision_kind: String,
    pub value: String,
    pub created_at: Option<String>,
}

impl SourceRevisionV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.revision_id, &format!("{label}.revisionId"))?;
        assert_one_of(
            &self.revision_kind,
            &["content_hash", "source_control", "build", "manual_snapshot"],
            &format!("{label}.revisionKind"),
        )?;
        assert_non_empty(&self.value, &format!("{label}.value"))?;
        if self.revision_kind == "content_hash" {
            assert_hash_string_v02(&self.value, &format!("{label}.value"))?;
        }
        if let Some(created_at) = &self.created_at {
            assert_non_empty(created_at, &format!("{label}.createdAt"))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashStrategyV02 {
    pub source_profile: HashRuleV02,
    pub source_bundle: HashRuleV02,
    pub source_asset: HashRuleV02,
    pub source_unit: HashRuleV02,
    pub patch_export: HashRuleV02,
    pub delta_package: HashRuleV02,
}

impl HashStrategyV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        self.source_profile.validate(
            &format!("{label}.sourceProfile"),
            "source_profile",
            "utf8-lf-json-stable-v1",
            false,
        )?;
        self.source_bundle.validate(
            &format!("{label}.sourceBundle"),
            "source_bundle",
            "utf8-lf-json-stable-v1",
            false,
        )?;
        self.source_asset.validate(
            &format!("{label}.sourceAsset"),
            "source_asset",
            "bytes",
            false,
        )?;
        self.source_unit.validate(
            &format!("{label}.sourceUnit"),
            "source_unit",
            "utf8-lf-json-stable-v1",
            true,
        )?;
        self.patch_export.validate(
            &format!("{label}.patchExport"),
            "patch_export",
            "utf8-lf-json-stable-v1",
            false,
        )?;
        self.delta_package.validate(
            &format!("{label}.deltaPackage"),
            "delta_package",
            "utf8-lf-json-stable-v1",
            false,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashRuleV02 {
    pub scope: String,
    pub algorithm: String,
    pub normalization: String,
    pub fields: Option<Vec<String>>,
}

impl HashRuleV02 {
    fn validate(
        &self,
        label: &str,
        expected_scope: &str,
        expected_normalization: &str,
        require_fields: bool,
    ) -> BridgeContractResult<()> {
        assert_equals(&self.scope, expected_scope, &format!("{label}.scope"))?;
        assert_equals(&self.algorithm, "sha256", &format!("{label}.algorithm"))?;
        assert_equals(
            &self.normalization,
            expected_normalization,
            &format!("{label}.normalization"),
        )?;
        if let Some(fields) = &self.fields {
            for (index, field) in fields.iter().enumerate() {
                assert_non_empty(field, &format!("{label}.fields[{index}]"))?;
            }
        }
        if require_fields && self.fields.as_ref().is_none_or(Vec::is_empty) {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.fields must not be empty"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeExtractorV02 {
    pub name: String,
    pub version: String,
}

impl BridgeExtractorV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_non_empty(&self.name, &format!("{label}.name"))?;
        assert_non_empty(&self.version, &format!("{label}.version"))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAssetV02 {
    pub asset_id: String,
    pub asset_key: String,
    pub asset_kind: String,
    pub source_hash: String,
    pub source_revision: SourceRevisionV02,
    pub path: Option<String>,
}

impl BridgeAssetV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        assert_non_empty(&self.asset_key, &format!("{label}.assetKey"))?;
        assert_one_of(
            &self.asset_kind,
            &[
                "script",
                "image",
                "audio",
                "video",
                "ui_texture",
                "font",
                "database",
                "metadata",
                "text",
            ],
            &format!("{label}.assetKind"),
        )?;
        assert_hash_string_v02(&self.source_hash, &format!("{label}.sourceHash"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        assert_revision_hash_matches_v02(
            &self.source_revision,
            &self.source_hash,
            &format!("{label}.sourceRevision"),
        )?;
        if let Some(path) = &self.path {
            assert_non_empty(path, &format!("{label}.path"))?;
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizationUnitV02 {
    pub bridge_unit_id: String,
    pub surface_id: String,
    pub surface_kind: String,
    pub source_unit_key: String,
    pub occurrence_id: String,
    pub source_locale: String,
    pub source_text: String,
    pub source_hash: String,
    pub source_revision: SourceRevisionV02,
    pub source_asset_ref: AssetRefV02,
    pub source_location: Value,
    pub speaker: Option<SpeakerContextV02>,
    pub context: Value,
    pub policy: Option<Value>,
    pub spans: Vec<BridgeSpanV02>,
    pub patch_ref: PatchRefV02,
    pub runtime_expectation: RuntimeExpectationV02,
}

impl fmt::Debug for LocalizationUnitV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let source_location = RedactedContentSummary::from_text(&self.source_location.to_string());
        let context = RedactedContentSummary::from_text(&self.context.to_string());
        let policy = self
            .policy
            .as_ref()
            .map(|value| RedactedContentSummary::from_text(&value.to_string()));
        formatter
            .debug_struct("LocalizationUnitV02")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("surface_id", &self.surface_id)
            .field("surface_kind", &self.surface_kind)
            .field("source_unit_key", &self.source_unit_key)
            .field("occurrence_id", &self.occurrence_id)
            .field("source_locale", &self.source_locale)
            .field(
                "source_text",
                &RedactedContentSummary::from_text(&self.source_text),
            )
            .field("source_hash", &self.source_hash)
            .field("source_location", &source_location)
            .field("speaker", &self.speaker)
            .field("context", &context)
            .field("policy", &policy)
            .field("spans", &self.spans)
            .finish()
    }
}

impl LocalizationUnitV02 {
    fn validate(&self, label: &str, asset_ids: &HashSet<String>) -> BridgeContractResult<()> {
        assert_uuid7(&self.bridge_unit_id, &format!("{label}.bridgeUnitId"))?;
        assert_uuid7(&self.surface_id, &format!("{label}.surfaceId"))?;
        assert_surface_kind(&self.surface_kind, &format!("{label}.surfaceKind"))?;
        assert_non_empty(&self.source_unit_key, &format!("{label}.sourceUnitKey"))?;
        assert_non_empty(&self.occurrence_id, &format!("{label}.occurrenceId"))?;
        assert_non_empty(&self.source_locale, &format!("{label}.sourceLocale"))?;
        assert_non_empty(&self.source_text, &format!("{label}.sourceText"))?;
        assert_hash_string_v02(&self.source_hash, &format!("{label}.sourceHash"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        self.source_asset_ref
            .validate(&format!("{label}.sourceAssetRef"))?;
        assert_known_asset_id(
            &self.source_asset_ref.asset_id,
            &format!("{label}.sourceAssetRef.assetId"),
            asset_ids,
        )?;
        assert_source_location_v02(&self.source_location, &format!("{label}.sourceLocation"))?;
        if let Some(speaker) = &self.speaker {
            speaker.validate(&format!("{label}.speaker"))?;
        }
        assert_surface_context_v02(
            &self.context,
            &format!("{label}.context"),
            &self.surface_kind,
            asset_ids,
        )?;
        if let Some(policy) = &self.policy {
            assert_localization_policy_v02(policy, &format!("{label}.policy"))?;
        }
        for (index, span) in self.spans.iter().enumerate() {
            span.validate(&format!("{label}.spans[{index}]"), &self.source_text)?;
        }
        self.patch_ref.validate(&format!("{label}.patchRef"))?;
        assert_known_asset_id(
            &self.patch_ref.asset_id,
            &format!("{label}.patchRef.assetId"),
            asset_ids,
        )?;
        assert_equals(
            &self.patch_ref.source_unit_key,
            &self.source_unit_key,
            &format!("{label}.patchRef.sourceUnitKey"),
        )?;
        if self.patch_ref.source_revision.revision_id != self.source_revision.revision_id {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.patchRef.sourceRevision.revisionId must match unit sourceRevision"
            )));
        }
        if self.patch_ref.source_revision.value != self.source_revision.value {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.patchRef.sourceRevision.value must match unit sourceRevision"
            )));
        }
        self.runtime_expectation
            .validate(&format!("{label}.runtimeExpectation"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRefV02 {
    pub asset_id: String,
    pub asset_key: Option<String>,
}

impl AssetRefV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        if let Some(asset_key) = &self.asset_key {
            assert_non_empty(asset_key, &format!("{label}.assetKey"))?;
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerContextV02 {
    pub knowledge_state: String,
    pub speaker_id: Option<String>,
    pub display_name: Option<String>,
    pub canonical_name_ref: Option<String>,
    pub raw_speaker_text: Option<String>,
    pub evidence: Option<String>,
    pub reader_label: Option<String>,
    /// Additive: reader-reveal state (`revealed` / `concealed`) derived from
    /// the matched `#NAMAE` row. Typed so it survives a round-trip through
    /// this contract rather than being dropped as an unknown field.
    pub reveal_state: Option<String>,
    /// Additive: resolved dialogue-text RGB triple. Typed + range-validated
    /// (`0..=255` per channel) so a fabricated colour cannot slip through.
    pub text_color: Option<Value>,
}

impl fmt::Debug for SpeakerContextV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeakerContextV02")
            .field("knowledge_state", &self.knowledge_state)
            .field("speaker_id", &self.speaker_id)
            .field(
                "display_name",
                &self
                    .display_name
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("canonical_name_ref", &self.canonical_name_ref)
            .field(
                "raw_speaker_text",
                &self
                    .raw_speaker_text
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "evidence",
                &self
                    .evidence
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "reader_label",
                &self
                    .reader_label
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("reveal_state", &self.reveal_state)
            .field("text_color", &self.text_color)
            .finish()
    }
}

impl SpeakerContextV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_one_of(
            &self.knowledge_state,
            &[
                "known",
                "parser_unknown",
                "reader_unknown",
                "not_applicable",
            ],
            &format!("{label}.knowledgeState"),
        )?;
        match self.knowledge_state.as_str() {
            "known" => {
                assert_required_uuid7(self.speaker_id.as_deref(), &format!("{label}.speakerId"))?;
                assert_required_string(
                    self.display_name.as_deref(),
                    &format!("{label}.displayName"),
                )?;
            }
            "reader_unknown" => {
                assert_required_uuid7(self.speaker_id.as_deref(), &format!("{label}.speakerId"))?;
                assert_required_string(
                    self.display_name.as_deref(),
                    &format!("{label}.displayName"),
                )?;
                assert_required_string(
                    self.reader_label.as_deref(),
                    &format!("{label}.readerLabel"),
                )?;
            }
            "parser_unknown" => {
                if let Some(raw) = &self.raw_speaker_text {
                    assert_non_empty(raw, &format!("{label}.rawSpeakerText"))?;
                }
                if let Some(evidence) = &self.evidence {
                    assert_non_empty(evidence, &format!("{label}.evidence"))?;
                }
            }
            "not_applicable" => {}
            _ => unreachable!(),
        }
        if let Some(canonical_name_ref) = &self.canonical_name_ref {
            assert_non_empty(canonical_name_ref, &format!("{label}.canonicalNameRef"))?;
        }
        if let Some(reveal_state) = &self.reveal_state {
            assert_one_of(
                reveal_state,
                &["revealed", "concealed"],
                &format!("{label}.revealState"),
            )?;
        }
        if let Some(text_color) = &self.text_color {
            validate_speaker_text_color(text_color, &format!("{label}.textColor"))?;
        }
        Ok(())
    }
}

/// Validate the additive speaker `textColor`: exactly three 8-bit RGB
/// channels (`0..=255`). Typed + range-checked so a fabricated / out-of-range
/// colour cannot survive this contract as an ignored unknown field.
fn validate_speaker_text_color(value: &Value, label: &str) -> BridgeContractResult<()> {
    let channels = value.as_array().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be an [r, g, b] array"))
    })?;
    if channels.len() != 3 {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must have exactly 3 channels, got {}",
            channels.len()
        )));
    }
    for (index, channel) in channels.iter().enumerate() {
        let component = channel.as_u64().ok_or_else(|| {
            BridgeContractValidationError::new(format!(
                "{label}[{index}] must be a non-negative integer"
            ))
        })?;
        if component > 255 {
            return Err(BridgeContractValidationError::new(format!(
                "{label}[{index}] must be in 0..=255, got {component}"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSpanV02 {
    pub span_id: String,
    pub span_kind: String,
    pub raw: String,
    pub start_byte: u64,
    pub end_byte: u64,
    pub preserve_mode: String,
    pub parsed_name: Option<Value>,
    pub arguments: Option<Value>,
    pub variable_name: Option<Value>,
    pub format_hint: Option<Value>,
    pub example_values: Option<Value>,
    pub base_start_byte: Option<Value>,
    pub base_end_byte: Option<Value>,
    pub annotation_start_byte: Option<Value>,
    pub annotation_end_byte: Option<Value>,
    pub annotation_text: Option<Value>,
    pub annotation_locale: Option<Value>,
    pub display_mode: Option<Value>,
    pub policy: Option<Value>,
}

impl fmt::Debug for BridgeSpanV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let metadata = [
            ("parsed_name", self.parsed_name.as_ref()),
            ("arguments", self.arguments.as_ref()),
            ("variable_name", self.variable_name.as_ref()),
            ("format_hint", self.format_hint.as_ref()),
            ("example_values", self.example_values.as_ref()),
            ("base_start_byte", self.base_start_byte.as_ref()),
            ("base_end_byte", self.base_end_byte.as_ref()),
            ("annotation_start_byte", self.annotation_start_byte.as_ref()),
            ("annotation_end_byte", self.annotation_end_byte.as_ref()),
            ("annotation_text", self.annotation_text.as_ref()),
            ("annotation_locale", self.annotation_locale.as_ref()),
            ("display_mode", self.display_mode.as_ref()),
            ("policy", self.policy.as_ref()),
        ]
        .into_iter()
        .map(|(name, value)| {
            (
                name,
                value.map(|value| RedactedContentSummary::from_text(&value.to_string())),
            )
        })
        .collect::<BTreeMap<_, _>>();
        formatter
            .debug_struct("BridgeSpanV02")
            .field("span_id", &self.span_id)
            .field("span_kind", &self.span_kind)
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("start_byte", &self.start_byte)
            .field("end_byte", &self.end_byte)
            .field("preserve_mode", &self.preserve_mode)
            .field("metadata", &metadata)
            .finish()
    }
}

impl BridgeSpanV02 {
    fn validate(&self, label: &str, source_text: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.span_id, &format!("{label}.spanId"))?;
        assert_one_of(
            &self.span_kind,
            &["control_markup", "variable_placeholder", "ruby_annotation"],
            &format!("{label}.spanKind"),
        )?;
        assert_non_empty(&self.raw, &format!("{label}.raw"))?;
        assert_one_of(
            &self.preserve_mode,
            &["exact", "map", "transform", "locale_policy"],
            &format!("{label}.preserveMode"),
        )?;
        assert_optional_value_string(self.parsed_name.as_ref(), &format!("{label}.parsedName"))?;
        if let Some(arguments) = &self.arguments {
            assert_value_string_array(arguments, &format!("{label}.arguments"))?;
        }
        assert_optional_value_string(
            self.variable_name.as_ref(),
            &format!("{label}.variableName"),
        )?;
        assert_optional_value_string(self.format_hint.as_ref(), &format!("{label}.formatHint"))?;
        if let Some(example_values) = &self.example_values {
            assert_value_string_array(example_values, &format!("{label}.exampleValues"))?;
        }
        if self.end_byte <= self.start_byte {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.endByte must be greater than {label}.startByte"
            )));
        }
        let start = self.start_byte as usize;
        let end = self.end_byte as usize;
        let source_bytes = source_text.as_bytes();
        if end > source_bytes.len() {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.endByte must be within sourceText UTF-8 bytes"
            )));
        }
        if &source_bytes[start..end] != self.raw.as_bytes() {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.raw must match sourceText byte range"
            )));
        }
        if let Some(policy) = &self.policy {
            assert_localization_policy_v02(policy, &format!("{label}.policy"))?;
        }
        if self.span_kind == "ruby_annotation" {
            assert_value_byte_range(
                self.base_start_byte.as_ref(),
                self.base_end_byte.as_ref(),
                &format!("{label}.base"),
            )?;
            assert_value_byte_range(
                self.annotation_start_byte.as_ref(),
                self.annotation_end_byte.as_ref(),
                &format!("{label}.annotation"),
            )?;
            assert_required_value_string(
                self.annotation_text.as_ref(),
                &format!("{label}.annotationText"),
            )?;
            assert_optional_value_string(
                self.annotation_locale.as_ref(),
                &format!("{label}.annotationLocale"),
            )?;
            assert_optional_value_string(
                self.display_mode.as_ref(),
                &format!("{label}.displayMode"),
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRefV02 {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
    pub source_revision: SourceRevisionV02,
    pub constraints: Option<Vec<String>>,
}

impl PatchRefV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        assert_one_of(
            &self.write_mode,
            &[
                "replace",
                "insert",
                "update_region",
                "replace_asset",
                "metadata",
            ],
            &format!("{label}.writeMode"),
        )?;
        assert_non_empty(&self.source_unit_key, &format!("{label}.sourceUnitKey"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        if let Some(constraints) = &self.constraints {
            for (index, constraint) in constraints.iter().enumerate() {
                assert_non_empty(constraint, &format!("{label}.constraints[{index}]"))?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExpectationV02 {
    pub expectation_kind: String,
    pub region: Option<Value>,
    pub trace_key: Option<Value>,
}

impl RuntimeExpectationV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_one_of(
            &self.expectation_kind,
            &[
                "trace_text",
                "layout_probe",
                "screenshot_region",
                "metadata_only",
            ],
            &format!("{label}.expectationKind"),
        )?;
        if let Some(region) = &self.region {
            assert_pixel_region_v02(region, &format!("{label}.region"))?;
        }
        if let Some(trace_key) = &self.trace_key {
            assert_value_string(trace_key, &format!("{label}.traceKey"))?;
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRecordV02 {
    pub policy_record_id: String,
    pub policy_record_kind: String,
    pub policy_action: String,
    pub term_key: String,
    pub source_text: String,
    pub target_locale: Option<String>,
    pub locale_branch_id: Option<String>,
    pub romanization_system: Option<String>,
    pub preserve_form: Option<String>,
    pub scope: Option<String>,
    pub policy_reason: String,
    pub review_required: Option<bool>,
}

impl fmt::Debug for PolicyRecordV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PolicyRecordV02")
            .field("policy_record_id", &self.policy_record_id)
            .field("policy_record_kind", &self.policy_record_kind)
            .field("policy_action", &self.policy_action)
            .field(
                "term_key",
                &RedactedContentSummary::from_text(&self.term_key),
            )
            .field(
                "source_text",
                &RedactedContentSummary::from_text(&self.source_text),
            )
            .field(
                "target_locale",
                &self
                    .target_locale
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("locale_branch_id", &self.locale_branch_id)
            .field(
                "romanization_system",
                &self
                    .romanization_system
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "preserve_form",
                &self
                    .preserve_form
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "scope",
                &self.scope.as_deref().map(RedactedContentSummary::from_text),
            )
            .field(
                "policy_reason",
                &RedactedContentSummary::from_text(&self.policy_reason),
            )
            .field("review_required", &self.review_required)
            .finish()
    }
}

impl PolicyRecordV02 {
    fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.policy_record_id, &format!("{label}.policyRecordId"))?;
        assert_one_of(
            &self.policy_record_kind,
            &["romanized_term", "non_translated_term"],
            &format!("{label}.policyRecordKind"),
        )?;
        assert_one_of(
            &self.policy_action,
            &["localize", "romanize", "do_not_translate"],
            &format!("{label}.policyAction"),
        )?;
        assert_non_empty(&self.term_key, &format!("{label}.termKey"))?;
        assert_non_empty(&self.source_text, &format!("{label}.sourceText"))?;
        if let Some(target_locale) = &self.target_locale {
            assert_non_empty(target_locale, &format!("{label}.targetLocale"))?;
        }
        if let Some(locale_branch_id) = &self.locale_branch_id {
            assert_uuid7(locale_branch_id, &format!("{label}.localeBranchId"))?;
        }
        if self.target_locale.is_none() && self.locale_branch_id.is_none() {
            return Err(BridgeContractValidationError::new(format!(
                "{label} must include targetLocale or localeBranchId"
            )));
        }
        if let Some(scope) = &self.scope {
            assert_surface_kind(scope, &format!("{label}.scope"))?;
        }
        if let Some(romanization_system) = &self.romanization_system {
            assert_non_empty(romanization_system, &format!("{label}.romanizationSystem"))?;
        }
        if let Some(preserve_form) = &self.preserve_form {
            assert_non_empty(preserve_form, &format!("{label}.preserveForm"))?;
        }
        assert_non_empty(&self.policy_reason, &format!("{label}.policyReason"))?;
        Ok(())
    }
}

fn assert_source_location_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let location = as_record(value, label)?;
    assert_optional_value_string(
        location.get("containerKey"),
        &format!("{label}.containerKey"),
    )?;
    if let Some(entry_path) = location.get("entryPath") {
        assert_value_string_array(entry_path, &format!("{label}.entryPath"))?;
    }
    if let Some(range) = location.get("range") {
        assert_byte_range_v02(range, &format!("{label}.range"))?;
    }
    if let Some(region) = location.get("region") {
        assert_pixel_region_v02(region, &format!("{label}.region"))?;
    }
    Ok(())
}

fn assert_surface_context_v02(
    value: &Value,
    label: &str,
    surface_kind: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let context = as_record(value, label)?;
    if let Some(route) = context.get("route") {
        assert_route_context_v02(route, &format!("{label}.route"))?;
    }
    if let Some(choice) = context.get("choice") {
        assert_choice_context_v02(choice, &format!("{label}.choice"))?;
    }
    if let Some(ui) = context.get("ui") {
        assert_ui_context_v02(ui, &format!("{label}.ui"))?;
    }
    if let Some(tutorial) = context.get("tutorial") {
        assert_tutorial_context_v02(tutorial, &format!("{label}.tutorial"))?;
    }
    if let Some(database) = context.get("database") {
        assert_database_context_v02(database, &format!("{label}.database"))?;
    }
    if let Some(song) = context.get("song") {
        assert_song_context_v02(song, &format!("{label}.song"), asset_ids)?;
    }
    if let Some(image_text) = context.get("imageText") {
        assert_image_text_context_v02(image_text, &format!("{label}.imageText"))?;
    }
    if let Some(metadata) = context.get("metadata") {
        assert_metadata_context_v02(metadata, &format!("{label}.metadata"))?;
    }
    if let Some(speaker_name) = context.get("speakerName") {
        assert_speaker_name_context_v02(speaker_name, &format!("{label}.speakerName"))?;
    }

    if let Some(required_context) = required_context_for_surface_kind(surface_kind)
        && !context.contains_key(required_context)
    {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.{required_context} is required for {surface_kind}"
        )));
    }
    Ok(())
}

fn required_context_for_surface_kind(surface_kind: &str) -> Option<&'static str> {
    match surface_kind {
        "choice_label" => Some("choice"),
        "ui_label" => Some("ui"),
        "tutorial_text" => Some("tutorial"),
        "database_entry" => Some("database"),
        "song_title" => Some("song"),
        "image_text" => Some("imageText"),
        "metadata_text" => Some("metadata"),
        "speaker_name" => Some("speakerName"),
        _ => None,
    }
}

fn assert_route_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let route = as_record(value, label)?;
    assert_optional_value_uuid7(route.get("routeId"), &format!("{label}.routeId"))?;
    assert_optional_value_string(route.get("routeKey"), &format!("{label}.routeKey"))?;
    assert_optional_value_uuid7(route.get("sceneId"), &format!("{label}.sceneId"))?;
    assert_optional_value_string(route.get("sceneKey"), &format!("{label}.sceneKey"))?;
    assert_optional_value_uuid7(route.get("branchId"), &format!("{label}.branchId"))?;
    assert_optional_value_string(route.get("branchKey"), &format!("{label}.branchKey"))?;
    assert_optional_value_string(route.get("position"), &format!("{label}.position"))
}

fn assert_choice_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let choice = as_record(value, label)?;
    assert_required_value_uuid7(
        choice.get("choiceGroupId"),
        &format!("{label}.choiceGroupId"),
    )?;
    assert_required_value_uuid7(choice.get("choiceId"), &format!("{label}.choiceId"))?;
    assert_non_negative_integer_value(choice.get("optionIndex"), &format!("{label}.optionIndex"))?;
    assert_optional_value_string(
        choice.get("routeTargetRef"),
        &format!("{label}.routeTargetRef"),
    )
}

fn assert_ui_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let ui = as_record(value, label)?;
    assert_value_one_of(
        ui.get("uiArea"),
        &[
            "dialogue_window",
            "menu",
            "hud",
            "settings",
            "save_load",
            "battle",
            "status",
            "system",
        ],
        &format!("{label}.uiArea"),
    )?;
    assert_optional_value_string(ui.get("controlRef"), &format!("{label}.controlRef"))?;
    assert_optional_value_string(
        ui.get("layoutConstraint"),
        &format!("{label}.layoutConstraint"),
    )
}

fn assert_tutorial_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let tutorial = as_record(value, label)?;
    assert_required_value_string(
        tutorial.get("tutorialStepRef"),
        &format!("{label}.tutorialStepRef"),
    )?;
    if let Some(input_action_refs) = tutorial.get("inputActionRefs") {
        assert_value_string_array(input_action_refs, &format!("{label}.inputActionRefs"))?;
    }
    assert_optional_value_string(
        tutorial.get("platformCondition"),
        &format!("{label}.platformCondition"),
    )
}

fn assert_database_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let database = as_record(value, label)?;
    assert_value_one_of(
        database.get("databaseKind"),
        &[
            "item",
            "skill",
            "quest",
            "location",
            "achievement",
            "character_bio",
            "bestiary",
            "codex",
            "encyclopedia",
        ],
        &format!("{label}.databaseKind"),
    )?;
    assert_required_value_string(database.get("entryId"), &format!("{label}.entryId"))?;
    assert_required_value_string(database.get("fieldKey"), &format!("{label}.fieldKey"))?;
    assert_optional_value_string(database.get("sortKey"), &format!("{label}.sortKey"))
}

fn assert_song_context_v02(
    value: &Value,
    label: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let song = as_record(value, label)?;
    if let Some(audio_asset_ref) = song.get("audioAssetRef") {
        let asset_id =
            assert_asset_ref_value_v02(audio_asset_ref, &format!("{label}.audioAssetRef"))?;
        assert_known_asset_id(
            asset_id,
            &format!("{label}.audioAssetRef.assetId"),
            asset_ids,
        )?;
    }
    assert_optional_value_string(song.get("trackId"), &format!("{label}.trackId"))?;
    assert_required_value_string(song.get("titleField"), &format!("{label}.titleField"))?;
    if let Some(credit_refs) = song.get("creditRefs") {
        assert_value_string_array(credit_refs, &format!("{label}.creditRefs"))?;
    }
    Ok(())
}

fn assert_image_text_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let image_text = as_record(value, label)?;
    assert_required_pixel_region_v02(image_text.get("region"), &format!("{label}.region"))?;
    assert_optional_value_string(image_text.get("ocrText"), &format!("{label}.ocrText"))?;
    assert_required_boolean(image_text.get("editable"), &format!("{label}.editable"))?;
    assert_value_one_of(
        image_text.get("replacementMode"),
        &[
            "redraw_region",
            "overlay_text",
            "replace_asset",
            "metadata_only",
        ],
        &format!("{label}.replacementMode"),
    )
}

fn assert_metadata_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let metadata = as_record(value, label)?;
    assert_value_one_of(
        metadata.get("metadataScope"),
        &[
            "package",
            "platform",
            "save_data",
            "credits",
            "config",
            "achievement",
        ],
        &format!("{label}.metadataScope"),
    )?;
    assert_required_value_string(metadata.get("fieldKey"), &format!("{label}.fieldKey"))?;
    assert_value_one_of(
        metadata.get("visibility"),
        &["runtime", "package", "platform", "internal"],
        &format!("{label}.visibility"),
    )
}

fn assert_speaker_name_context_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let speaker_name = as_record(value, label)?;
    assert_value_one_of(
        speaker_name.get("displayContext"),
        &["name_plate", "backlog", "chat", "battle_callout"],
        &format!("{label}.displayContext"),
    )?;
    assert_optional_value_string(
        speaker_name.get("canonicalNameRef"),
        &format!("{label}.canonicalNameRef"),
    )
}

fn assert_localization_policy_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let policy = as_record(value, label)?;
    assert_value_one_of(
        policy.get("policyAction"),
        &["localize", "romanize", "do_not_translate"],
        &format!("{label}.policyAction"),
    )?;
    assert_optional_value_string(policy.get("targetLocale"), &format!("{label}.targetLocale"))?;
    assert_optional_value_uuid7(
        policy.get("localeBranchId"),
        &format!("{label}.localeBranchId"),
    )?;
    assert_optional_value_string(policy.get("targetText"), &format!("{label}.targetText"))?;
    assert_optional_value_string(
        policy.get("romanizationSystem"),
        &format!("{label}.romanizationSystem"),
    )?;
    assert_optional_value_string(policy.get("policyReason"), &format!("{label}.policyReason"))?;
    if policy.get("targetLocale").is_none() && policy.get("localeBranchId").is_none() {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must include targetLocale or localeBranchId"
        )));
    }
    Ok(())
}

fn assert_asset_ref_value_v02<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    let asset_ref = as_record(value, label)?;
    let asset_id =
        assert_required_value_uuid7(asset_ref.get("assetId"), &format!("{label}.assetId"))?;
    assert_optional_value_string(asset_ref.get("assetKey"), &format!("{label}.assetKey"))?;
    Ok(asset_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExport {
    pub patch_export_id: String,
    pub source_locale: String,
    pub target_locale: String,
    pub entries: Vec<PatchExportEntry>,
}

impl PatchExport {
    pub fn from_value(value: &Value) -> KaifuuResult<Self> {
        Ok(serde_json::from_value(value.clone())?)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExportEntry {
    pub bridge_unit_id: String,
    pub source_unit_key: String,
    pub source_hash: String,
    pub target_text: String,
    pub protected_span_mappings: Vec<ProtectedSpanMapping>,
}

impl fmt::Debug for PatchExportEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PatchExportEntry")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("source_unit_key", &self.source_unit_key)
            .field("source_hash", &self.source_hash)
            .field(
                "target_text",
                &RedactedContentSummary::from_text(&self.target_text),
            )
            .field("protected_span_mappings", &self.protected_span_mappings)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpanMapping {
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_end_byte: Option<u64>,
    pub target_start: u64,
    pub target_end: u64,
}

impl fmt::Debug for ProtectedSpanMapping {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedSpanMapping")
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("source_span_id", &self.source_span_id)
            .field("source_start_byte", &self.source_start_byte)
            .field("source_end_byte", &self.source_end_byte)
            .field("target_start", &self.target_start)
            .field("target_end", &self.target_end)
            .finish()
    }
}

impl ProtectedSpanMapping {
    pub fn new(raw: impl Into<String>, target_start: u64, target_end: u64) -> Self {
        Self {
            raw: raw.into(),
            source_span_id: None,
            source_start_byte: None,
            source_end_byte: None,
            target_start,
            target_end,
        }
    }

    pub fn with_source_identity(
        mut self,
        source_span_id: Option<impl Into<String>>,
        source_start_byte: u64,
        source_end_byte: u64,
    ) -> Self {
        self.source_span_id = source_span_id.map(Into::into);
        self.source_start_byte = Some(source_start_byte);
        self.source_end_byte = Some(source_end_byte);
        self
    }

    pub fn first_in_target(raw: &str, target_text: &str) -> Option<Self> {
        let start = target_text.find(raw)?;
        let end = start + raw.len();
        Some(Self::new(raw, start as u64, end as u64))
    }

    pub fn matches_target_text(&self, target_text: &str) -> bool {
        let Ok(start) = usize::try_from(self.target_start) else {
            return false;
        };
        let Ok(end) = usize::try_from(self.target_end) else {
            return false;
        };
        if end <= start
            || end > target_text.len()
            || !target_text.is_char_boundary(start)
            || !target_text.is_char_boundary(end)
        {
            return false;
        }
        target_text[start..end] == self.raw
    }

    pub fn matches_source_span(
        &self,
        raw: &str,
        source_start_byte: Option<u64>,
        source_end_byte: Option<u64>,
        source_span_id: Option<&str>,
    ) -> bool {
        if self.raw != raw {
            return false;
        }
        if let Some(expected_span_id) = self.source_span_id.as_deref()
            && Some(expected_span_id) != source_span_id
        {
            return false;
        }
        if let Some(expected_start) = self.source_start_byte
            && Some(expected_start) != source_start_byte
        {
            return false;
        }
        if let Some(expected_end) = self.source_end_byte
            && Some(expected_end) != source_end_byte
        {
            return false;
        }
        true
    }

    pub fn has_source_identity(&self) -> bool {
        self.source_span_id.is_some()
            || self.source_start_byte.is_some()
            || self.source_end_byte.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchResult {
    pub schema_version: String,
    pub patch_result_id: String,
    pub patch_export_id: String,
    pub status: OperationStatus,
    pub output_hash: String,
    pub failures: Vec<AdapterFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub schema_version: String,
    pub patch_result_id: String,
    pub status: OperationStatus,
    pub output_hash: String,
    pub failures: Vec<AdapterFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoldenAssertionStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenPhaseReport {
    pub phase: String,
    pub status: GoldenAssertionStatus,
    pub details: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    /// the capability an adapter-neutral asset assertion is keyed.
    /// Set for capability-aware asset diagnostics so an unsupported asset carries
    /// a TYPED capability code (not just prose), letting the harness assert on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_capability: Option<Capability>,
}

impl fmt::Debug for GoldenPhaseReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoldenPhaseReport")
            .field("phase", &self.phase)
            .field("status", &self.status)
            .field("details", &RedactedContentSummary::from_text(&self.details))
            .field("asset_ref", &self.asset_ref)
            .field("source_unit_key", &self.source_unit_key)
            .field(
                "support_boundary",
                &self
                    .support_boundary
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "expected",
                &self
                    .expected
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "actual",
                &self
                    .actual
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("required_capability", &self.required_capability)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenFailure {
    pub code: String,
    pub phase: String,
    pub adapter_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_unit_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    /// capability an adapter-neutral asset-preservation failure is
    /// keyed on (e.g. the unsupported-surface capability whose asset mutated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_capability: Option<Capability>,
}

impl fmt::Debug for GoldenFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoldenFailure")
            .field("code", &self.code)
            .field("phase", &self.phase)
            .field("adapter_id", &self.adapter_id)
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .field("asset_ref", &self.asset_ref)
            .field("source_unit_key", &self.source_unit_key)
            .field(
                "support_boundary",
                &self
                    .support_boundary
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "expected",
                &self
                    .expected
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "actual",
                &self
                    .actual
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("required_capability", &self.required_capability)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenRoundTripReport {
    pub schema_version: String,
    pub report_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub status: OperationStatus,
    pub phases: Vec<GoldenPhaseReport>,
    pub failures: Vec<GoldenFailure>,
}

impl GoldenRoundTripReport {
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

pub enum GoldenByteEquivalenceMode {
    /// Fixture-shaped case: assert the single `source.json` file is byte-identical
    /// after an unchanged patch. Retained as ONE covered case; it assumes the
    /// fixture `source.json` layout and is NOT adapter-neutral.
    AssertSourceJson,
    /// adapter-neutral case: assert asset preservation (and emit
    /// capability-aware unsupported-asset diagnostics) purely from the adapter's
    /// own asset INVENTORY + CAPABILITY reports. Makes no assumption about a
    /// `source.json` file or any on-disk layout, so it works for any adapter.
    AssertInventory,
    Unsupported {
        support_boundary: String,
    },
}

pub struct GoldenHarnessRequest<'a> {
    pub game_dir: &'a Path,
    pub work_dir: &'a Path,
    pub adapter_id: Option<&'a str>,
    pub byte_equivalence: GoldenByteEquivalenceMode,
    pub translated_patch_export: Option<&'a Value>,
    pub translated_source_bridge: Option<&'a Value>,
}

/// an adapter-neutral asset-preservation claim derived from an
/// adapter's [`AssetInventoryManifest`] (inventory + capability reports) — NOT
/// from a fixture `source.json` layout.
/// A claim is raised for every asset backing a surface the adapter reports it
/// cannot edit (the surface's `patching` capability is `Unsupported`, or its
/// `patch_mode` is `Unsupported`). Because the adapter declares it cannot patch
/// that asset, an identity round-trip MUST leave the asset unchanged, and the
/// harness records a TYPED capability-aware diagnostic for the surface. The
/// claim carries only inventory/capability-sourced fields (`asset_id`,
/// `asset_ref` from `asset_key`, the `required_capability`, and the boundary),
/// so it is meaningful for any adapter regardless of on-disk layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetPreservationClaim {
    pub asset_id: String,
    /// Adapter-neutral reference to the asset (its `asset_key`, falling back to
    /// `asset_id`); never a hard-coded `source.json` path.
    pub asset_ref: String,
    pub surface_id: String,
    pub required_capability: Capability,
    pub support_boundary: String,
}

/// derive adapter-neutral asset-preservation claims from an asset
/// inventory manifest.
/// This is a pure function over the manifest's `surfaces` + their `patching`
/// capability reports. It raises one [`AssetPreservationClaim`] per surface the
/// adapter reports as capability-unsupported. It reads nothing from disk and
/// assumes nothing about a `source.json` file, so the golden harness can drive
/// asset assertions off it for any adapter.
pub fn derive_asset_preservation_claims(
    manifest: &AssetInventoryManifest,
) -> Vec<AssetPreservationClaim> {
    let asset_key_by_id: BTreeMap<&str, &str> = manifest
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset.asset_key.as_str()))
        .collect();

    let mut claims = Vec::new();
    for surface in &manifest.surfaces {
        let capability_unsupported = surface.patching.status == CapabilityStatus::Unsupported;
        let patch_mode_unsupported = surface.patch_mode == AssetInventoryPatchMode::Unsupported;
        if !capability_unsupported && !patch_mode_unsupported {
            continue;
        }
        let asset_id = surface.source_asset_ref.asset_id.clone();
        let asset_ref = surface
            .source_asset_ref
            .asset_key
            .clone()
            .or_else(|| {
                asset_key_by_id
                    .get(asset_id.as_str())
                    .map(|key| (*key).to_string())
            })
            .unwrap_or_else(|| asset_id.clone());
        let support_boundary = surface.patching.limitation.clone().unwrap_or_else(|| {
            format!(
                "adapter reports surface {} as capability-unsupported; the underlying asset must be preserved unchanged",
                surface.surface_id
            )
        });
        claims.push(AssetPreservationClaim {
            asset_id,
            asset_ref,
            surface_id: surface.surface_id.clone(),
            required_capability: surface.patching.capability.clone(),
            support_boundary,
        });
    }
    claims.sort_by(|a, b| {
        (a.surface_id.as_str(), a.asset_id.as_str())
            .cmp(&(b.surface_id.as_str(), b.asset_id.as_str()))
    });
    claims
}

/// the canonical, order-fixed projection of the inventory IDENTITY +
/// PATCH-DECISION fields that a surface's metadata hash commits to. Serialized
/// under the repo-wide `utf8-lf-json-stable` rule ([`stable_json`]) and hashed
/// with [`sha256_hash_bytes`], so the hash is deterministic and tamper-evident:
/// any drift of the asset id/key/path/source-hash, the surface kind, the
/// patch mode, or the declared patch capability changes the hash.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetMetadataHashInput<'a> {
    asset_id: &'a str,
    asset_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_hash: Option<&'a str>,
    surface_id: &'a str,
    surface_kind: &'a AssetInventorySurfaceKind,
    patch_mode: &'a AssetInventoryPatchMode,
    capability: &'a Capability,
    capability_status: &'a CapabilityStatus,
}

/// compute the stable metadata hash for one asset surface.
/// The hash binds the surface's PATCH-DECISION fields (`patch_mode`, the
/// `patching` capability + status, the surface kind) to the IDENTITY of the
/// asset it patches (`asset_id`, `asset_key`, `path`, `source_hash`, resolved
/// from the manifest's `assets` list, falling back to the surface's own
/// `source_asset_ref`). It is a pure function of those fields, so two manifests
/// that declare the same identity + patch capability for a surface always
/// produce the same hash, and any tamper with either changes it.
pub fn asset_inventory_surface_metadata_hash(
    manifest: &AssetInventoryManifest,
    surface: &AssetInventorySurface,
) -> String {
    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.asset_id == surface.source_asset_ref.asset_id);
    let asset_key = asset
        .map(|asset| asset.asset_key.as_str())
        .or(surface.source_asset_ref.asset_key.as_deref())
        .unwrap_or(surface.source_asset_ref.asset_id.as_str());
    let input = AssetMetadataHashInput {
        asset_id: surface.source_asset_ref.asset_id.as_str(),
        asset_key,
        path: asset.and_then(|asset| asset.path.as_deref()),
        source_hash: asset
            .and_then(|asset| asset.source_hash.as_deref())
            .or(surface.source_hash.as_deref()),
        surface_id: surface.surface_id.as_str(),
        surface_kind: &surface.asset_surface_kind,
        patch_mode: &surface.patch_mode,
        capability: &surface.patching.capability,
        capability_status: &surface.patching.status,
    };
    let canonical =
        stable_json(&input).expect("asset metadata hash input serializes deterministically");
    sha256_hash_bytes(canonical.as_bytes())
}

/// a typed diagnostic for a patch-capability inconsistency in an
/// asset inventory manifest. Emitted (never a silent pass or panic) when a
/// manifest would imply an unsupported asset edit or its identity/patch
/// metadata hash has drifted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum AssetCapabilityDiagnostic {
    /// A surface advertises a patch payload (a translation/edit) for an asset
    /// whose patch capability is UNSUPPORTED. The manifest cannot claim to patch
    /// an asset it declares it cannot edit.
    #[serde(rename = "unsupported_asset_patched")]
    UnsupportedAssetPatched {
        surface_id: String,
        asset_id: String,
        asset_ref: String,
        required_capability: Capability,
        support_boundary: String,
    },
    /// A surface's declared metadata hash does not match the hash recomputed from
    /// its identity + patch-decision fields — the identity/patch capability has
    /// been tampered with or has drifted from what was committed.
    #[serde(rename = "metadata_hash_mismatch")]
    MetadataHashMismatch {
        surface_id: String,
        asset_id: String,
        declared_hash: String,
        computed_hash: String,
    },
}

impl AssetCapabilityDiagnostic {
    /// The stable diagnostic code (matches the serde tag).
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedAssetPatched { .. } => "unsupported_asset_patched",
            Self::MetadataHashMismatch { .. } => "metadata_hash_mismatch",
        }
    }

    /// The surface the diagnostic is keyed on.
    pub fn surface_id(&self) -> &str {
        match self {
            Self::UnsupportedAssetPatched { surface_id, .. }
            | Self::MetadataHashMismatch { surface_id, .. } => surface_id,
        }
    }
}

/// whether a surface's declared patch capability forbids editing its
/// backing asset. A surface is unsupported when its `patching` capability status
/// is `Unsupported` OR its `patch_mode` is `Unsupported`.
fn asset_surface_patch_unsupported(surface: &AssetInventorySurface) -> bool {
    surface.patching.status == CapabilityStatus::Unsupported
        || surface.patch_mode == AssetInventoryPatchMode::Unsupported
}

/// the patch-capability consistency validator.
/// Returns one typed [`AssetCapabilityDiagnostic`] per inconsistency:
/// * `unsupported_asset_patched` — a surface advertises a [`AssetInventoryPatchPayload`]
///   for an asset whose patch capability is unsupported (a manifest cannot patch
///   an asset it declares it cannot edit).
/// * `metadata_hash_mismatch` — a surface declares a `metadata_hash` that does
///   not match the hash recomputed from its identity + patch-decision fields.
///   A manifest with a non-empty result is REJECTED (see
///   [`AssetInventoryManifest::validate_patch_capability`]). This is a pure
///   function of the manifest; diagnostics are returned in a deterministic order.
pub fn validate_asset_inventory_patch_capability(
    manifest: &AssetInventoryManifest,
) -> Vec<AssetCapabilityDiagnostic> {
    let asset_key_by_id: BTreeMap<&str, &str> = manifest
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset.asset_key.as_str()))
        .collect();

    let mut diagnostics = Vec::new();
    for surface in &manifest.surfaces {
        let asset_id = surface.source_asset_ref.asset_id.clone();

        if let Some(declared) = &surface.metadata_hash {
            let computed = asset_inventory_surface_metadata_hash(manifest, surface);
            if declared != &computed {
                diagnostics.push(AssetCapabilityDiagnostic::MetadataHashMismatch {
                    surface_id: surface.surface_id.clone(),
                    asset_id: asset_id.clone(),
                    declared_hash: declared.clone(),
                    computed_hash: computed,
                });
            }
        }

        if surface.patch_payload.is_some() && asset_surface_patch_unsupported(surface) {
            let asset_ref = surface
                .source_asset_ref
                .asset_key
                .clone()
                .or_else(|| {
                    asset_key_by_id
                        .get(asset_id.as_str())
                        .map(|key| (*key).to_string())
                })
                .unwrap_or_else(|| asset_id.clone());
            let support_boundary = surface.patching.limitation.clone().unwrap_or_else(|| {
                format!(
                    "adapter reports surface {} as patch-capability-unsupported; it must not advertise a patch payload",
                    surface.surface_id
                )
            });
            diagnostics.push(AssetCapabilityDiagnostic::UnsupportedAssetPatched {
                surface_id: surface.surface_id.clone(),
                asset_id,
                asset_ref,
                required_capability: surface.patching.capability.clone(),
                support_boundary,
            });
        }
    }

    diagnostics.sort_by(|a, b| (a.code(), a.surface_id()).cmp(&(b.code(), b.surface_id())));
    diagnostics
}

/// the two synthetic assets the patch-capability fixtures share
/// a patchable audio asset (a metadata song title) and an unpatchable binary
/// art asset.
fn asset_inventory_patch_capability_fixture_assets() -> Vec<AssetInventoryAsset> {
    vec![
        AssetInventoryAsset {
            asset_id: "asset-song".to_string(),
            asset_key: "audio/theme".to_string(),
            asset_kind: AssetInventoryAssetKind::Audio,
            path: Some("audio/theme.ogg".to_string()),
            source_hash: Some(content_hash("audio/theme")),
            metadata: BTreeMap::new(),
        },
        AssetInventoryAsset {
            asset_id: "asset-logo".to_string(),
            asset_key: "art/logo".to_string(),
            asset_kind: AssetInventoryAssetKind::Image,
            path: Some("art/logo.png".to_string()),
            source_hash: Some(content_hash("art/logo")),
            metadata: BTreeMap::new(),
        },
    ]
}

/// A supported (patchable) song-title surface that advertises a patch payload.
fn asset_inventory_patch_capability_fixture_supported_surface(
    patch_payload: Option<AssetInventoryPatchPayload>,
) -> AssetInventorySurface {
    AssetInventorySurface {
        surface_id: "surface-song-title".to_string(),
        asset_surface_kind: AssetInventorySurfaceKind::SongTitle,
        source_asset_ref: AssetInventoryAssetRef {
            asset_id: "asset-song".to_string(),
            asset_key: Some("audio/theme".to_string()),
        },
        source_location: None,
        source_text: Some("テーマ曲".to_string()),
        source_hash: Some(content_hash("テーマ曲")),
        text_source_kind: AssetInventoryTextSourceKind::Metadata,
        patch_mode: AssetInventoryPatchMode::MetadataOnly,
        patching: CapabilityReport::supported(Capability::AssetTextPatching),
        patch_payload,
        metadata_hash: None,
        notes: vec![],
    }
}

/// An unsupported (unpatchable) binary-art surface. `patch_payload` is populated
/// only by the negative fixture that advertises an edit it cannot honour.
fn asset_inventory_patch_capability_fixture_unsupported_surface(
    patch_payload: Option<AssetInventoryPatchPayload>,
) -> AssetInventorySurface {
    AssetInventorySurface {
        surface_id: "surface-logo-art".to_string(),
        asset_surface_kind: AssetInventorySurfaceKind::UiArt,
        source_asset_ref: AssetInventoryAssetRef {
            asset_id: "asset-logo".to_string(),
            asset_key: Some("art/logo".to_string()),
        },
        source_location: None,
        source_text: None,
        source_hash: Some(content_hash("art/logo")),
        text_source_kind: AssetInventoryTextSourceKind::NotApplicable,
        patch_mode: AssetInventoryPatchMode::AssetReplacementRequired,
        patching: CapabilityReport::unsupported(
            Capability::NonTextSurfaceExtraction,
            "fixture adapter cannot redraw or replace binary art assets",
        ),
        patch_payload,
        metadata_hash: None,
        notes: vec![],
    }
}

fn asset_inventory_patch_capability_fixture_manifest(
    manifest_id: &str,
    surfaces: Vec<AssetInventorySurface>,
) -> AssetInventoryManifest {
    let mut manifest = AssetInventoryManifest {
        schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
        manifest_id: manifest_id.to_string(),
        adapter_id: "kaifuu.fixture.asset-capability".to_string(),
        source_locale: "ja-JP".to_string(),
        assets: asset_inventory_patch_capability_fixture_assets(),
        surfaces,
        capabilities: vec![CapabilityReport::supported(Capability::AssetInventory)],
        warnings: vec![],
        metadata: BTreeMap::new(),
    };
    manifest.normalize();
    manifest.stamp_asset_metadata_hashes();
    manifest
}

/// POSITIVE fixture: a consistent manifest. The supported song-title
/// surface advertises a patch payload (allowed — its capability is supported);
/// the unsupported art surface advertises no payload. Every surface carries a
/// correct, stamped metadata hash. Passes both base validation and the
/// patch-capability validator (zero diagnostics).
pub fn asset_inventory_patch_capability_positive_fixture() -> AssetInventoryManifest {
    asset_inventory_patch_capability_fixture_manifest(
        "asset-capability-positive",
        vec![
            asset_inventory_patch_capability_fixture_supported_surface(Some(
                AssetInventoryPatchPayload {
                    target_locale: "en-US".to_string(),
                    translated_text: "Theme Song".to_string(),
                },
            )),
            asset_inventory_patch_capability_fixture_unsupported_surface(None),
        ],
    )
}

/// NEGATIVE fixture (unsupported-asset-patched): the unsupported art
/// surface advertises a patch payload for an asset it declares it cannot edit.
/// Base validation passes; the patch-capability validator REJECTS it with a
/// typed `unsupported_asset_patched` diagnostic.
pub fn asset_inventory_patch_capability_unsupported_patched_fixture() -> AssetInventoryManifest {
    asset_inventory_patch_capability_fixture_manifest(
        "asset-capability-unsupported-patched",
        vec![
            asset_inventory_patch_capability_fixture_supported_surface(None),
            asset_inventory_patch_capability_fixture_unsupported_surface(Some(
                AssetInventoryPatchPayload {
                    target_locale: "en-US".to_string(),
                    translated_text: "Logo (EN)".to_string(),
                },
            )),
        ],
    )
}

/// NEGATIVE fixture (metadata-hash mismatch): a structurally valid
/// manifest whose supported surface declares a metadata hash that does not match
/// its identity + patch-decision fields (tampered/drifted). Base validation
/// passes; the patch-capability validator REJECTS it with a typed
/// `metadata_hash_mismatch` diagnostic.
pub fn asset_inventory_metadata_hash_mismatch_fixture() -> AssetInventoryManifest {
    let mut manifest = asset_inventory_patch_capability_fixture_manifest(
        "asset-capability-hash-mismatch",
        vec![
            asset_inventory_patch_capability_fixture_supported_surface(None),
            asset_inventory_patch_capability_fixture_unsupported_surface(None),
        ],
    );
    for surface in &mut manifest.surfaces {
        if surface.surface_id == "surface-song-title" {
            surface.metadata_hash = Some(format!("sha256:{}", "0".repeat(64)));
        }
    }
    manifest
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterFailure {
    pub error_code: String,
    pub adapter: String,
    pub engine: Option<String>,
    pub detected_variant: Option<String>,
    pub asset_ref: Option<String>,
    pub required_capability: Option<Capability>,
    pub support_boundary: String,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessStage {
    Container,
    Crypto,
    Codec,
    PatchBack,
}

impl LayeredAccessStage {
    pub fn required_capability(self) -> Capability {
        match self {
            Self::Container => Capability::ContainerAccess,
            Self::Crypto => Capability::CryptoAccess,
            Self::Codec => Capability::CodecAccess,
            Self::PatchBack => Capability::PatchBack,
        }
    }

    pub fn missing_capability_error(self) -> SemanticErrorCode {
        match self {
            Self::Container => SemanticErrorCode::MissingContainerCapability,
            Self::Crypto => SemanticErrorCode::MissingCryptoCapability,
            Self::Codec => SemanticErrorCode::MissingCodecCapability,
            Self::PatchBack => SemanticErrorCode::MissingPatchBackCapability,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayeredAccessPreflightFailureKind {
    MissingCapability,
    UnsupportedTransform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayeredAccessPreflightRequirement {
    pub stage: LayeredAccessStage,
    pub failure_kind: LayeredAccessPreflightFailureKind,
    pub asset_ref: Option<String>,
    pub transform_id: Option<String>,
    pub support_boundary: String,
    pub remediation: Option<String>,
}

impl LayeredAccessPreflightRequirement {
    pub fn missing_capability(
        stage: LayeredAccessStage,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            failure_kind: LayeredAccessPreflightFailureKind::MissingCapability,
            asset_ref: Some(asset_ref.into()),
            transform_id: None,
            support_boundary: support_boundary.into(),
            remediation: Some(remediation_for_layered_stage(stage).to_string()),
        }
    }

    pub fn unsupported_transform(
        stage: LayeredAccessStage,
        transform_id: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            failure_kind: LayeredAccessPreflightFailureKind::UnsupportedTransform,
            asset_ref: Some(asset_ref.into()),
            transform_id: Some(transform_id.into()),
            support_boundary: support_boundary.into(),
            remediation: Some(
                "choose a supported layered transform or add a readiness profile before patching"
                    .to_string(),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessPreflightReport {
    pub schema_version: String,
    pub adapter_id: String,
    pub engine: String,
    pub detected_variant: String,
    pub status: OperationStatus,
    pub failures: Vec<AdapterFailure>,
}

impl LayeredAccessPreflightReport {
    pub fn from_requirements(
        adapter_id: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirements: Vec<LayeredAccessPreflightRequirement>,
    ) -> Self {
        let adapter_id = adapter_id.into();
        let engine = engine.into();
        let detected_variant = detected_variant.into();
        let failures = requirements
            .into_iter()
            .map(|requirement| {
                requirement.to_adapter_failure(&adapter_id, &engine, &detected_variant)
            })
            .collect::<Vec<_>>();
        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            adapter_id,
            engine,
            detected_variant,
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
        .redacted_for_report()
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.engine = redact_for_log_or_report(&report.engine);
        report.detected_variant = redact_for_log_or_report(&report.detected_variant);
        report.failures = report
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        report
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    pub fn from_access_profile(
        adapter_id: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        capabilities: &AdapterCapabilities,
        access_profile: &LayeredAccessProfile,
    ) -> Self {
        let adapter_id = adapter_id.into();
        let engine = engine.into();
        let detected_variant = detected_variant.into();
        let supported_capabilities = capabilities
            .reports
            .iter()
            .filter(|report| {
                matches!(
                    report.status,
                    CapabilityStatus::Supported | CapabilityStatus::Limited
                )
            })
            .map(|report| report.capability.clone())
            .collect::<Vec<_>>();
        let patch_contract = capabilities
            .access_contract
            .as_ref()
            .map(|contract| &contract.patch);
        let mut failures = Vec::new();

        for surface in &access_profile.surfaces {
            for stage in [
                LayeredAccessStage::Container,
                LayeredAccessStage::Crypto,
                LayeredAccessStage::Codec,
                LayeredAccessStage::PatchBack,
            ] {
                if !supported_capabilities.contains(&stage.required_capability()) {
                    failures.push(
                        LayeredAccessPreflightRequirement::missing_capability(
                            stage,
                            &surface.surface_id,
                            format!(
                                "adapter capability report does not support {:?} for layered surface {}",
                                stage, surface.surface_id
                            ),
                        )
                        .to_adapter_failure(&adapter_id, &engine, &detected_variant),
                    );
                }
            }

            match patch_contract {
                Some(contract) => {
                    if !matches!(
                        contract.status,
                        CapabilityStatus::Supported | CapabilityStatus::Limited
                    ) {
                        failures.push(surface.patch_contract_status_failure(
                            contract,
                            &adapter_id,
                            &engine,
                            &detected_variant,
                        ));
                    }
                    surface.add_unsupported_transform_failures(
                        contract,
                        &adapter_id,
                        &engine,
                        &detected_variant,
                        &mut failures,
                    );
                }
                None if surface.requires_patch_access_contract() => {
                    surface.add_missing_patch_contract_failures(
                        &adapter_id,
                        &engine,
                        &detected_variant,
                        &mut failures,
                    );
                }
                None => {}
            }

            if surface.key_material_status == LayeredAccessKeyMaterialStatus::Missing {
                failures.push(AdapterFailure::missing_key_material(
                    &adapter_id,
                    &engine,
                    &detected_variant,
                    surface
                        .key_requirement_refs
                        .first()
                        .map_or(surface.surface_id.as_str(), String::as_str),
                    format!(
                        "layered surface {} requires crypto key material before patching",
                        surface.surface_id
                    ),
                ));
            }
            if surface.key_material_status == LayeredAccessKeyMaterialStatus::HelperGated
                || surface.helper_status == LayeredAccessHelperStatus::Unavailable
            {
                failures.push(AdapterFailure::helper_unavailable(
                    &adapter_id,
                    &engine,
                    &detected_variant,
                    format!(
                        "layered surface {} is helper-gated before patching",
                        surface.surface_id
                    ),
                ));
            }
        }

        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            adapter_id,
            engine,
            detected_variant,
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
        .redacted_for_report()
    }
}

impl LayeredTextSurfaceAccess {
    fn requires_patch_access_contract(&self) -> bool {
        !matches!(
            self.surface_transform,
            SurfaceTransform::Identity | SurfaceTransform::JsonPointer
        ) || !matches!(
            self.container,
            ContainerTransform::Identity | ContainerTransform::LooseFile
        ) || !matches!(self.crypto, CryptoTransform::NullKey)
            || !matches!(
                self.codec,
                CodecTransform::Identity | CodecTransform::JsonText
            )
            || !matches!(
                self.patch_back,
                PatchBackTransform::Identity | PatchBackTransform::RewriteJson
            )
            || !matches!(
                self.key_material_status,
                LayeredAccessKeyMaterialStatus::NotRequired
                    | LayeredAccessKeyMaterialStatus::Resolved
            )
            || !matches!(
                self.helper_status,
                LayeredAccessHelperStatus::NotRequired | LayeredAccessHelperStatus::Available
            )
    }

    fn add_missing_patch_contract_failures(
        &self,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
        failures: &mut Vec<AdapterFailure>,
    ) {
        let support_boundary =
            "patch access contract is required before patching non-identity layered transforms";
        if !matches!(
            self.surface_transform,
            SurfaceTransform::Identity | SurfaceTransform::JsonPointer
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.surface_transform),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(
            self.container,
            ContainerTransform::Identity | ContainerTransform::LooseFile
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.container),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(self.crypto, CryptoTransform::NullKey) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Crypto,
                format!("{:?}", self.crypto),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(
            self.codec,
            CodecTransform::Identity | CodecTransform::JsonText
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Codec,
                format!("{:?}", self.codec),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(
            self.patch_back,
            PatchBackTransform::Identity | PatchBackTransform::RewriteJson
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::PatchBack,
                format!("{:?}", self.patch_back),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
    }

    fn patch_contract_status_failure(
        &self,
        contract: &LayeredAccessOperationContract,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        let support_boundary = contract
            .support_boundary
            .as_deref()
            .unwrap_or("patch access contract status does not permit preparing patched output");
        LayeredAccessPreflightRequirement::missing_capability(
            LayeredAccessStage::PatchBack,
            &self.surface_id,
            format!(
                "{support_boundary}; patch access contract status: {:?}",
                contract.status
            ),
        )
        .to_adapter_failure(adapter_id, engine, detected_variant)
    }

    fn add_unsupported_transform_failures(
        &self,
        contract: &LayeredAccessOperationContract,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
        failures: &mut Vec<AdapterFailure>,
    ) {
        if !contract
            .supported_surfaces
            .contains(&self.surface_transform)
        {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.surface_transform),
                "surface transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_containers.contains(&self.container) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.container),
                "container transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_crypto.contains(&self.crypto) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Crypto,
                format!("{:?}", self.crypto),
                "crypto transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_codecs.contains(&self.codec) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Codec,
                format!("{:?}", self.codec),
                "codec transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_patch_back.contains(&self.patch_back) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::PatchBack,
                format!("{:?}", self.patch_back),
                "patch-back transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
    }

    fn unsupported_transform_failure(
        &self,
        stage: LayeredAccessStage,
        transform_id: String,
        support_boundary: impl Into<String>,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        LayeredAccessPreflightRequirement::unsupported_transform(
            stage,
            transform_id,
            &self.surface_id,
            support_boundary,
        )
        .to_adapter_failure(adapter_id, engine, detected_variant)
    }
}

impl LayeredAccessPreflightRequirement {
    fn to_adapter_failure(
        &self,
        adapter: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        let mut params = AdapterFailureSemanticParams::new(
            match self.failure_kind {
                LayeredAccessPreflightFailureKind::MissingCapability => {
                    self.stage.missing_capability_error()
                }
                LayeredAccessPreflightFailureKind::UnsupportedTransform => {
                    SemanticErrorCode::UnsupportedLayeredTransform
                }
            },
            adapter,
            &self.support_boundary,
        )
        .engine(engine)
        .detected_variant(detected_variant)
        .required_capability(self.stage.required_capability());
        if let Some(asset_ref) = &self.asset_ref {
            params = params.asset_ref(asset_ref);
        }
        if let Some(remediation) = &self.remediation {
            params = params.remediation(remediation);
        }
        if let Some(transform_id) = &self.transform_id {
            params = params.remediation(format!(
                "{}; unsupported transform: {}",
                self.remediation
                    .as_deref()
                    .unwrap_or("add layered access support"),
                redact_for_log_or_report(transform_id)
            ));
        }
        AdapterFailure::semantic(params)
    }
}

fn remediation_for_layered_stage(stage: LayeredAccessStage) -> &'static str {
    match stage {
        LayeredAccessStage::Container => {
            "provide a supported container/archive transform before extraction or patching"
        }
        LayeredAccessStage::Crypto => {
            "provide supported crypto parameters and resolved key material before extraction or patching"
        }
        LayeredAccessStage::Codec => {
            "provide a supported codec/decompile transform before normalizing text"
        }
        LayeredAccessStage::PatchBack => {
            "provide a supported patch-back transform before writing patched output"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterFailureSemanticParams {
    error_code: SemanticErrorCode,
    adapter: String,
    engine: Option<String>,
    detected_variant: Option<String>,
    asset_ref: Option<String>,
    required_capability: Option<Capability>,
    support_boundary: String,
    remediation: Option<String>,
}

impl AdapterFailureSemanticParams {
    pub fn new(
        error_code: SemanticErrorCode,
        adapter: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            error_code,
            adapter: adapter.into(),
            engine: None,
            detected_variant: None,
            asset_ref: None,
            required_capability: None,
            support_boundary: support_boundary.into(),
            remediation: None,
        }
    }

    pub fn engine(mut self, engine: impl Into<String>) -> Self {
        self.engine = Some(engine.into());
        self
    }

    pub fn detected_variant(mut self, detected_variant: impl Into<String>) -> Self {
        self.detected_variant = Some(detected_variant.into());
        self
    }

    pub fn asset_ref(mut self, asset_ref: impl Into<String>) -> Self {
        self.asset_ref = Some(asset_ref.into());
        self
    }

    pub fn required_capability(mut self, required_capability: Capability) -> Self {
        self.required_capability = Some(required_capability);
        self
    }

    pub fn remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }
}

impl AdapterFailure {
    pub fn semantic(params: AdapterFailureSemanticParams) -> Self {
        Self {
            error_code: params.error_code.to_string(),
            adapter: params.adapter,
            engine: params.engine,
            detected_variant: params.detected_variant,
            asset_ref: params.asset_ref,
            required_capability: params.required_capability,
            support_boundary: params.support_boundary,
            remediation: params.remediation,
        }
        .redacted_for_report()
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            error_code: redact_for_log_or_report(&self.error_code),
            adapter: redact_for_log_or_report(&self.adapter),
            engine: self.engine.as_deref().map(redact_for_log_or_report),
            detected_variant: self
                .detected_variant
                .as_deref()
                .map(redact_for_log_or_report),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            required_capability: self.required_capability.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }

    pub fn is_preflight_blocking(&self) -> bool {
        matches!(
            self.error_code.as_str(),
            SEMANTIC_MISSING_KEY_PROFILE
                | SEMANTIC_MISSING_KEY_MATERIAL
                | SEMANTIC_HELPER_UNAVAILABLE
                | SEMANTIC_HELPER_REQUIRED
                | SEMANTIC_KEY_VALIDATION_FAILED
                | SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
                | SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
                | SEMANTIC_MISSING_CONTAINER_CAPABILITY
                | SEMANTIC_MISSING_CRYPTO_CAPABILITY
                | SEMANTIC_MISSING_CODEC_CAPABILITY
                | SEMANTIC_MISSING_PATCH_BACK_CAPABILITY
                | STRING_SLOT_OVERFLOW
                | STRING_SLOT_INVALID_ENCODING
                | STRING_SLOT_TERMINATOR_LOSS
                | STRING_SLOT_PROTECTED_SPAN_MUTATION
                | STRING_RELOCATION_UNRESOLVED_REFERENCE
                | STRING_RELOCATION_OVERLAPPING_WRITES
                | STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT
                | STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH
        )
    }

    pub fn missing_key_profile(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingKeyProfile,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation("provide a key profile that references local secret refs"),
        )
    }

    pub fn missing_key_material(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirement_id: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingKeyMaterial,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(requirement_id)
            .required_capability(Capability::KeyProfile)
            .remediation(
                "resolve the referenced local secret material before extraction or patching",
            ),
        )
    }

    pub fn helper_unavailable(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::HelperUnavailable,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation(
                "run an available local helper or provide validated key material manually",
            ),
        )
    }

    pub fn key_validation_failed(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirement_id: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::KeyValidationFailed,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(requirement_id)
            .required_capability(Capability::KeyProfile)
            .remediation("replace or revalidate the local key material"),
        )
    }

    pub fn protected_executable_unsupported(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::ProtectedExecutableUnsupported,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation("use a helper that supports this protected executable boundary"),
        )
    }

    pub fn secret_redacted(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::SecretRedacted,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(asset_ref)
            .remediation("inspect the redacted local-only evidence on the runner"),
        )
    }

    pub fn encoded_string_slot_preflight(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        diagnostic: EncodedStringSlotDiagnostic,
    ) -> Self {
        Self {
            error_code: diagnostic.code,
            adapter: adapter.into(),
            engine: Some(engine.into()),
            detected_variant: Some(detected_variant.into()),
            asset_ref: Some(asset_ref.into()),
            required_capability: Some(Capability::PatchBack),
            support_boundary: format!(
                "encoded string slot {} byte range {}..{} failed preflight: {}",
                diagnostic.slot_id,
                diagnostic.byte_range.start(),
                diagnostic.byte_range.end(),
                diagnostic.message
            ),
            remediation: Some(format!(
                "{}: {}",
                diagnostic.remediation_code, diagnostic.remediation
            )),
        }
        .redacted_for_report()
    }

    pub fn string_relocation_preflight(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        diagnostic: StringRelocationDiagnostic,
    ) -> Self {
        Self {
            error_code: diagnostic.code,
            adapter: adapter.into(),
            engine: Some(engine.into()),
            detected_variant: Some(detected_variant.into()),
            asset_ref: Some(asset_ref.into()),
            required_capability: Some(Capability::PatchBack),
            support_boundary: format!(
                "string relocation reference {} for slot {} failed preflight: {}",
                diagnostic.reference_id.as_deref().unwrap_or("unresolved"),
                diagnostic.slot_id.as_deref().unwrap_or("unresolved"),
                diagnostic.message
            ),
            remediation: Some(format!(
                "{}: {}",
                diagnostic.remediation_code, diagnostic.remediation
            )),
        }
        .redacted_for_report()
    }
}

impl PatchResult {
    pub fn preflight_pass(patch_export: &PatchExport) -> Self {
        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("patch-preflight", 0),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patch preflight passed without output"),
            failures: vec![],
        }
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.patch_result_id = redact_for_log_or_report(&result.patch_result_id);
        result.patch_export_id = redact_for_log_or_report(&result.patch_export_id);
        result.output_hash = redact_for_log_or_report(&result.output_hash);
        result.failures = result
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        result
    }

    pub fn has_preflight_blocking_failure(&self) -> bool {
        self.failures
            .iter()
            .any(AdapterFailure::is_preflight_blocking)
    }

    pub fn failure_codes(&self) -> Vec<String> {
        self.failures
            .iter()
            .map(|failure| failure.error_code.clone())
            .collect()
    }
}

impl VerificationResult {
    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.patch_result_id = redact_for_log_or_report(&result.patch_result_id);
        result.output_hash = redact_for_log_or_report(&result.output_hash);
        result.failures = result
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        result
    }
}

impl GoldenRoundTripReport {
    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.report_id = redact_for_log_or_report(&report.report_id);
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.adapter_name = redact_for_log_or_report(&report.adapter_name);
        report.phases = report
            .phases
            .iter()
            .map(GoldenPhaseReport::redacted_for_report)
            .collect();
        report.failures = report
            .failures
            .iter()
            .map(GoldenFailure::redacted_for_report)
            .collect();
        report
    }
}

impl GoldenPhaseReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            phase: redact_for_log_or_report(&self.phase),
            status: self.status.clone(),
            details: redact_for_log_or_report(&self.details),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            source_unit_key: self
                .source_unit_key
                .as_deref()
                .map(redact_for_log_or_report),
            support_boundary: self
                .support_boundary
                .as_deref()
                .map(redact_for_log_or_report),
            expected: self.expected.as_deref().map(redact_for_log_or_report),
            actual: self.actual.as_deref().map(redact_for_log_or_report),
            required_capability: self.required_capability.clone(),
        }
    }
}

impl GoldenFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            phase: redact_for_log_or_report(&self.phase),
            adapter_id: redact_for_log_or_report(&self.adapter_id),
            message: redact_for_log_or_report(&self.message),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            source_unit_key: self
                .source_unit_key
                .as_deref()
                .map(redact_for_log_or_report),
            support_boundary: self
                .support_boundary
                .as_deref()
                .map(redact_for_log_or_report),
            expected: self.expected.as_deref().map(redact_for_log_or_report),
            actual: self.actual.as_deref().map(redact_for_log_or_report),
            required_capability: self.required_capability.clone(),
        }
    }
}

fn assert_schema_version_v02(value: &str, label: &str) -> BridgeContractResult<()> {
    if value == BRIDGE_SCHEMA_VERSION_V02 {
        return Ok(());
    }
    if value == "0.1.0" {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must be {BRIDGE_SCHEMA_VERSION_V02}; 0.1.0 is the legacy fixture contract"
        )));
    }
    Err(BridgeContractValidationError::new(format!(
        "{label} must be {BRIDGE_SCHEMA_VERSION_V02}"
    )))
}

fn assert_required_string(value: Option<&str>, label: &str) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_non_empty(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_required_uuid7(value: Option<&str>, label: &str) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_uuid7(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a UUID7 string"
        ))),
    }
}

fn assert_non_empty(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.is_empty() {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        )))
    } else {
        Ok(())
    }
}

fn assert_equals(value: &str, expected: &str, label: &str) -> BridgeContractResult<()> {
    if value == expected {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be {expected}"
        )))
    }
}

fn assert_one_of(value: &str, allowed: &[&str], label: &str) -> BridgeContractResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be one of: {}",
            allowed.join(", ")
        )))
    }
}

fn assert_surface_kind(value: &str, label: &str) -> BridgeContractResult<()> {
    assert_one_of(
        value,
        &[
            "dialogue",
            "narration",
            "speaker_name",
            "choice_label",
            "ui_label",
            "tutorial_text",
            "database_entry",
            "song_title",
            "image_text",
            "metadata_text",
        ],
        label,
    )
}

fn assert_known_asset_id(
    asset_id: &str,
    label: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if asset_ids.contains(asset_id) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must reference an asset in BridgeBundleV02.assets"
        )))
    }
}

fn as_record<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an object")))
}

fn assert_required_value_string<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> BridgeContractResult<&'a str> {
    match value {
        Some(value) => assert_value_string(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_optional_value_string(value: Option<&Value>, label: &str) -> BridgeContractResult<()> {
    if let Some(value) = value {
        assert_value_string(value, label)?;
    }
    Ok(())
}

fn assert_value_string<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    match value.as_str() {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

fn assert_value_string_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let array = value
        .as_array()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an array")))?;
    for (index, item) in array.iter().enumerate() {
        assert_value_string(item, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn assert_required_value_uuid7<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_value_string(value, label)?;
    assert_uuid7(value, label)?;
    Ok(value)
}

fn assert_optional_value_uuid7(value: Option<&Value>, label: &str) -> BridgeContractResult<()> {
    if let Some(value) = value {
        let value = assert_value_string(value, label)?;
        assert_uuid7(value, label)?;
    }
    Ok(())
}

fn assert_value_one_of(
    value: Option<&Value>,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let value = assert_required_value_string(value, label)?;
    assert_one_of(value, allowed, label)
}

fn assert_non_negative_integer_value(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) => Ok(value),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-negative integer"
        ))),
    }
}

fn assert_positive_integer_value(value: Option<&Value>, label: &str) -> BridgeContractResult<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) if value > 0 => Ok(value),
        _ => Err(BridgeContractValidationError::new(format!(
            "{label} must be a positive integer"
        ))),
    }
}

fn assert_required_boolean(value: Option<&Value>, label: &str) -> BridgeContractResult<()> {
    if value.and_then(Value::as_bool).is_some() {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a boolean"
        )))
    }
}

fn assert_byte_range_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let range = as_record(value, label)?;
    let start_byte =
        assert_non_negative_integer_value(range.get("startByte"), &format!("{label}.startByte"))?;
    let end_byte =
        assert_non_negative_integer_value(range.get("endByte"), &format!("{label}.endByte"))?;
    if end_byte <= start_byte {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.endByte must be greater than {label}.startByte"
        )));
    }
    Ok(())
}

fn assert_value_byte_range(
    start_byte: Option<&Value>,
    end_byte: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    let start_byte = assert_non_negative_integer_value(start_byte, &format!("{label}.startByte"))?;
    let end_byte = assert_non_negative_integer_value(end_byte, &format!("{label}.endByte"))?;
    if end_byte <= start_byte {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.endByte must be greater than {label}.startByte"
        )));
    }
    Ok(())
}

fn assert_required_pixel_region_v02(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_pixel_region_v02(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be an object"
        ))),
    }
}

fn assert_pixel_region_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let region = as_record(value, label)?;
    assert_non_negative_integer_value(region.get("x"), &format!("{label}.x"))?;
    assert_non_negative_integer_value(region.get("y"), &format!("{label}.y"))?;
    assert_positive_integer_value(region.get("width"), &format!("{label}.width"))?;
    assert_positive_integer_value(region.get("height"), &format!("{label}.height"))?;
    Ok(())
}

fn assert_revision_hash_matches_v02(
    revision: &SourceRevisionV02,
    hash: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if revision.revision_kind == "content_hash" && revision.value != hash {
        Err(BridgeContractValidationError::new(format!(
            "{label}.value must equal the matching content hash"
        )))
    } else {
        Ok(())
    }
}

fn assert_hash_string_v02(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must be a canonical sha256 hash string"
        )));
    }
    if value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a canonical sha256 hash string"
        )))
    }
}

fn assert_uuid7(value: &str, label: &str) -> BridgeContractResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a UUID7 string"
        )))
    }
}

/// Content metadata safe to include in diagnostics without revealing bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedContentSummary {
    byte_len: usize,
    sha256: String,
}

impl RedactedContentSummary {
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            byte_len: bytes.len(),
            sha256: sha256_hex(bytes),
        }
    }

    #[must_use]
    pub fn from_text(text: &str) -> Self {
        Self::from_bytes(text.as_bytes())
    }

    #[must_use]
    pub fn byte_len(&self) -> usize {
        self.byte_len
    }

    #[must_use]
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

impl fmt::Display for RedactedContentSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} bytes (sha256 {})",
            self.byte_len, self.sha256
        )
    }
}

impl fmt::Debug for RedactedContentSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RedactedContentSummary")
            .field("byte_len", &self.byte_len)
            .field("sha256", &self.sha256)
            .finish()
    }
}

// Plain XP3 deterministic writer
// The writer covers the WRITE side of the plain-XP3 patch-back
// claim. established the read-side classification (plain /
// encrypted / compressed / helper-required / unsupported-protected-executable) and
// scoped patch_back to plain XP3 only. adds the
// `archive_rebuild_plain` write surface: take a source-fidelity manifest
// of a plain XP3 archive (entry order, per-segment metadata, stored
// adler32, raw segment payloads) and emit a deterministic XP3 byte
// stream. Rebuilding from an unchanged manifest produces the same bytes
// as the source archive — round-trip is byte-identical.
// The writer never decrypts, never re-encrypts, and never recompresses.
// Compressed segments are passed through verbatim; the writer does not
// claim a decompression or compression capability. Encrypted,
// helper-required, and protected-executable inputs are rejected at
// [`unpack_plain_xp3_to_directory`] before any write surface is exposed.

/// Patch-back mode declared by a writer capability tuple.
/// introduces [`PatchBackMode::ArchiveRebuildPlain`] as the
/// first concrete writer surface: deterministic rebuild of a plain XP3
/// archive from a source-fidelity manifest. No other variant is claimed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchBackMode {
    /// Plain XP3 rebuild: the writer takes a manifest produced by
    /// [`unpack_plain_xp3_to_directory`] (or constructed by hand) and
    /// emits a byte-identical archive when the manifest is unchanged.
    ArchiveRebuildPlain,
}

impl PatchBackMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArchiveRebuildPlain => "archive_rebuild_plain",
        }
    }
}

/// Writer capability tuple recorded by the plain XP3 writer.
/// Per the spec acceptance criterion: "Writer capability tuple records
/// patch_back_mode=archive_rebuild_plain". This is a tuple (not a
/// freeform capability map) so the orchestrator can pattern-match on the
/// declared mode without re-parsing capability reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3WriterCapability {
    pub adapter_id: &'static str,
    pub variant: &'static str,
    pub patch_back_mode: PatchBackMode,
}

/// Adapter id under which the writer registers its capability
/// tuple. Distinct from the detector adapter id so callers can
/// fan capability claims across read and write surfaces independently.
pub const PLAIN_XP3_WRITER_ADAPTER_ID: &str = "kaifuu.kirikiri-xp3.plain-writer";

/// Plain-XP3 variant string the writer claims patch-back for.
pub const PLAIN_XP3_WRITER_VARIANT: &str = "plain";

/// Return the writer capability tuple for the plain XP3
/// writer. Always declares
/// `patch_back_mode = PatchBackMode::ArchiveRebuildPlain`; no other
/// variant is claimed.
pub const fn plain_xp3_writer_capability() -> PlainXp3WriterCapability {
    PlainXp3WriterCapability {
        adapter_id: PLAIN_XP3_WRITER_ADAPTER_ID,
        variant: PLAIN_XP3_WRITER_VARIANT,
        patch_back_mode: PatchBackMode::ArchiveRebuildPlain,
    }
}

/// Source-fidelity archive structure used by the deterministic writer.
/// Unlike [`PlainXp3Inventory`] (which sorts entries by path and hashes
/// payloads for reporting), [`PlainXp3Archive`] preserves the **source
/// order** of entries and the raw bytes of each segment so the writer
/// can produce a byte-identical rebuild. The struct is the canonical
/// in-memory representation passed between [`read_plain_xp3_archive`]
/// and [`encode_xp3`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3Archive {
    pub schema_version: String,
    pub variant: String,
    pub entries: Vec<PlainXp3ArchiveEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3ArchiveEntry {
    pub path: String,
    pub original_size: u64,
    pub archive_size: u64,
    /// `Some(value)` when the source File chunk carried an `adlr` chunk;
    /// `None` otherwise. The writer preserves this faithfully — absent
    /// adlr chunks are not synthesized.
    pub stored_adler32: Option<u32>,
    pub segments: Vec<PlainXp3ArchiveSegment>,
    /// Concatenated raw segment payloads in source order. The
    /// [`encode_xp3`] writer slices this back into segments by
    /// [`PlainXp3ArchiveSegment::archive_size`].
    #[serde(with = "plain_xp3_payload_serde")]
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3ArchiveSegment {
    pub flags: u32,
    pub original_size: u64,
    pub archive_size: u64,
}

impl PlainXp3ArchiveSegment {
    /// Returns whether the segment is marked compressed (low bit of flags).
    /// The writer does not decompress; this is exposed so callers can
    /// detect compressed-unknown variants before requesting a payload
    /// replacement.
    pub fn is_compressed(&self) -> bool {
        self.flags & 1 != 0
    }
}

mod plain_xp3_payload_serde {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex_encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let hex = String::deserialize(deserializer)?;
        hex_decode(&hex).map_err(serde::de::Error::custom)
    }

    fn hex_encode(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(output, "{byte:02x}");
        }
        output
    }

    fn hex_decode(input: &str) -> Result<Vec<u8>, String> {
        if !input.len().is_multiple_of(2) {
            return Err("hex payload length must be even".to_string());
        }
        let mut output = Vec::with_capacity(input.len() / 2);
        for index in (0..input.len()).step_by(2) {
            let pair = &input[index..index + 2];
            output.push(
                u8::from_str_radix(pair, 16)
                    .map_err(|_| format!("invalid hex byte at offset {index}"))?,
            );
        }
        Ok(output)
    }
}

/// Errors emitted by the plain XP3 writer.
/// Each variant carries enough context for the CLI to surface a
/// semantic diagnostic without leaking secrets or fixture paths. The
/// `Unsupported*` variants are routed before any write side effect —
/// the writer never opens an output file when one of those is raised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlainXp3WriterError {
    /// The source bytes carry encrypted XP3 markers. The writer refuses
    /// to surface an unpack/repack path and forwards the
    /// `kaifuu.unsupported_variant.encrypted` semantic code.
    UnsupportedEncrypted,
    /// The source bytes carry compressed/packed XP3 markers. The writer
    /// refuses to surface an unpack/repack path and forwards the
    /// `kaifuu.unsupported_variant.packed` semantic code.
    UnsupportedCompressed,
    /// The source bytes carry helper-required markers. The writer
    /// refuses to surface an unpack/repack path and forwards the
    /// `kaifuu.helper_required` semantic code.
    UnsupportedHelperRequired,
    /// The source bytes do not start with [`XP3_PLAIN_MAGIC`] and don't
    /// match any other recognized routing marker — the writer treats
    /// this as an unsupported / unknown container and refuses to claim
    /// patch-back.
    UnsupportedProtectedExecutable,
    /// The manifest declares a non-plain `variant` (anything other than
    /// `"plain"`). Forwards the
    /// `kaifuu.unsupported_engine_variant` semantic code.
    UnsupportedVariant(String),
    /// The manifest carries a compressed segment for an entry whose
    /// payload has been replaced (segment archive_size no longer
    /// matches the payload slice length). does not claim
    /// any recompression capability, so this is rejected with the
    /// `kaifuu.unsupported_variant.packed` semantic code.
    UnsupportedCompressedReplacement(String),
    /// Inventory read error encountered while unpacking source bytes.
    InventoryError(PlainXp3InventoryError),
    /// Sizes recorded in the manifest do not match payload byte counts.
    InconsistentManifest(String),
    /// I/O error while reading or writing the directory layout.
    Io(String),
    /// The manifest carries a path that fails Kaifuu's safe-relative-path
    /// rule (see [`validate_safe_relative_path`]).
    UnsafeRelativePath(String),
    /// A path component under the unpack/output root resolved through a
    /// symlink while materializing a payload/manifest file. The read/write was
    /// refused (fd-relative `O_NOFOLLOW` descent) so it could never escape the
    /// intended root. The string is the manifest-declared relative path that
    /// was being materialized. Distinct from [`UnsafeRelativePath`], which is a
    /// pure string-level check: this variant is the real materialization guard
    /// and fires even when the string looked safe but a symlink was planted in
    /// the directory tree (TOCTOU / symlink-traversal hardening).
    SymlinkTraversalRefused(String),
    /// Manifest JSON could not be parsed.
    ManifestParse(String),
}

impl fmt::Display for PlainXp3WriterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedEncrypted => formatter.write_str(
                "encrypted XP3 archives are not writable by the plain-XP3 writer (semantic: kaifuu.unsupported_variant.encrypted)",
            ),
            Self::UnsupportedCompressed => formatter.write_str(
                "compressed XP3 archives are not writable by the plain-XP3 writer (semantic: kaifuu.unsupported_variant.packed)",
            ),
            Self::UnsupportedHelperRequired => formatter.write_str(
                "helper-required XP3 archives are not writable by the plain-XP3 writer (semantic: kaifuu.helper_required)",
            ),
            Self::UnsupportedProtectedExecutable => formatter.write_str(
                "protected-executable / unknown XP3 containers are not writable (semantic: kaifuu.protected_executable_unsupported)",
            ),
            Self::UnsupportedVariant(variant) => write!(
                formatter,
                "manifest variant {variant:?} is not supported by the plain-XP3 writer (semantic: kaifuu.unsupported_engine_variant)"
            ),
            Self::UnsupportedCompressedReplacement(path) => write!(
                formatter,
                "compressed XP3 entry {path:?} cannot have its payload replaced — the writer does not claim recompression (semantic: kaifuu.unsupported_variant.packed)"
            ),
            Self::InventoryError(error) => write!(formatter, "plain XP3 inventory error: {error}"),
            Self::InconsistentManifest(message) => {
                write!(formatter, "inconsistent plain XP3 manifest: {message}")
            }
            Self::Io(message) => write!(formatter, "plain XP3 writer I/O error: {message}"),
            Self::UnsafeRelativePath(path) => {
                write!(formatter, "unsafe relative manifest path {path:?}")
            }
            Self::SymlinkTraversalRefused(path) => write!(
                formatter,
                "refused symlink traversal materializing manifest path {path:?}: a component under the unpack root is a symlink (semantic: kaifuu.plain_xp3_writer.symlink_traversal_refused)"
            ),
            Self::ManifestParse(message) => {
                write!(formatter, "plain XP3 manifest parse error: {message}")
            }
        }
    }
}

impl std::error::Error for PlainXp3WriterError {}

impl PlainXp3WriterError {
    /// Semantic code (one of the existing `SEMANTIC_*` constants) that
    /// a CLI / orchestrator diagnostic should surface for the error.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedEncrypted => SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED,
            Self::UnsupportedCompressed | Self::UnsupportedCompressedReplacement(_) => {
                SEMANTIC_UNSUPPORTED_VARIANT_PACKED
            }
            Self::UnsupportedHelperRequired => SEMANTIC_HELPER_REQUIRED,
            Self::UnsupportedProtectedExecutable => SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            Self::UnsupportedVariant(_) => SEMANTIC_UNSUPPORTED_ENGINE_VARIANT,
            Self::SymlinkTraversalRefused(_) => "kaifuu.plain_xp3_writer.symlink_traversal_refused",
            Self::InventoryError(_)
            | Self::InconsistentManifest(_)
            | Self::Io(_)
            | Self::UnsafeRelativePath(_)
            | Self::ManifestParse(_) => "kaifuu.plain_xp3_writer.error",
        }
    }
}

/// Plain-XP3 manifest variant identifier written to disk.
pub const PLAIN_XP3_MANIFEST_VARIANT: &str = "plain";

/// Plain-XP3 manifest schema version.
pub const PLAIN_XP3_MANIFEST_SCHEMA_VERSION: &str = "0.1.0";

/// Read a plain XP3 archive into a source-fidelity [`PlainXp3Archive`]
/// suitable for byte-identical rebuild.
/// Refuses encrypted / compressed / helper-required / protected-executable inputs
/// before exposing any write surface — callers can rely on the
/// `Unsupported*` errors to gate downstream patch-back claims.
pub fn read_plain_xp3_archive(bytes: &[u8]) -> Result<PlainXp3Archive, PlainXp3WriterError> {
    if !bytes.starts_with(XP3_PLAIN_MAGIC) {
        if has_legacy_xp3_encrypted_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedEncrypted);
        }
        if has_legacy_xp3_compressed_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedCompressed);
        }
        if has_legacy_xp3_helper_required_marker(bytes) {
            return Err(PlainXp3WriterError::UnsupportedHelperRequired);
        }
        return Err(PlainXp3WriterError::UnsupportedProtectedExecutable);
    }

    let index_offset = read_le_u64(bytes, XP3_PLAIN_MAGIC.len(), "index offset")
        .map_err(PlainXp3WriterError::InventoryError)?;
    let index_offset = usize::try_from(index_offset).map_err(|_| {
        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset("index"))
    })?;
    if index_offset >= bytes.len() {
        return Err(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::InvalidOffset("index"),
        ));
    }

    let index_encoding = *bytes
        .get(index_offset)
        .ok_or(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::Truncated("index encoding"),
        ))?;
    if index_encoding != 0 {
        return Err(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::UnsupportedIndexEncoding(index_encoding),
        ));
    }
    let index_size = read_le_u64(bytes, index_offset + 1, "index size")
        .map_err(PlainXp3WriterError::InventoryError)?;
    let index_start = index_offset
        .checked_add(9)
        .ok_or(PlainXp3WriterError::InventoryError(
            PlainXp3InventoryError::InvalidOffset("index start"),
        ))?;
    let index_size = usize::try_from(index_size).map_err(|_| {
        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset("index size"))
    })?;
    let index_end = checked_end(index_start, index_size, bytes.len(), "index")
        .map_err(PlainXp3WriterError::InventoryError)?;

    let mut cursor = index_start;
    let mut entries: Vec<PlainXp3ArchiveEntry> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    while cursor < index_end {
        let chunk_name = read_chunk_name(bytes, cursor, "index chunk name")
            .map_err(PlainXp3WriterError::InventoryError)?;
        let chunk_size = read_le_u64(bytes, cursor + 4, "index chunk size")
            .map_err(PlainXp3WriterError::InventoryError)?;
        let content_start = cursor + 12;
        let content_size = usize::try_from(chunk_size).map_err(|_| {
            PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset(
                "index chunk size",
            ))
        })?;
        let content_end = checked_end(content_start, content_size, index_end, "index chunk")
            .map_err(PlainXp3WriterError::InventoryError)?;
        if chunk_name == *b"File" {
            let chunk = parse_xp3_file_chunk(bytes, content_start, content_end)
                .map_err(PlainXp3WriterError::InventoryError)?;
            let path = chunk.path.ok_or_else(|| {
                PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                    "File chunk missing info path".to_string(),
                ))
            })?;
            if !seen_paths.insert(path.clone()) {
                return Err(PlainXp3WriterError::InventoryError(
                    PlainXp3InventoryError::DuplicateEntry(path),
                ));
            }
            let original_size = chunk.original_size.ok_or_else(|| {
                PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                    "File chunk missing info original size".to_string(),
                ))
            })?;
            let archive_size = chunk.archive_size.ok_or_else(|| {
                PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                    "File chunk missing info archive size".to_string(),
                ))
            })?;

            let mut payload: Vec<u8> = Vec::new();
            let mut writer_segments: Vec<PlainXp3ArchiveSegment> = Vec::new();
            for segment in &chunk.segments {
                let offset = usize::try_from(segment.offset).map_err(|_| {
                    PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset(
                        "segment",
                    ))
                })?;
                let size = usize::try_from(segment.archive_size).map_err(|_| {
                    PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidOffset(
                        "segment size",
                    ))
                })?;
                let end = checked_end(offset, size, bytes.len(), "segment payload")
                    .map_err(PlainXp3WriterError::InventoryError)?;
                payload.extend_from_slice(&bytes[offset..end]);
                writer_segments.push(PlainXp3ArchiveSegment {
                    flags: segment.flags,
                    original_size: segment.original_size,
                    archive_size: segment.archive_size,
                });
            }

            let stored_adler32 = match chunk.stored_adler32.as_deref() {
                Some(formatted) => {
                    let hex = formatted.strip_prefix("adler32:").ok_or_else(|| {
                        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                            format!("adlr chunk had unexpected format {formatted:?}"),
                        ))
                    })?;
                    let value = u32::from_str_radix(hex, 16).map_err(|_| {
                        PlainXp3WriterError::InventoryError(PlainXp3InventoryError::InvalidChunk(
                            format!("adlr chunk had non-hex value {hex:?}"),
                        ))
                    })?;
                    Some(value)
                }
                None => None,
            };

            entries.push(PlainXp3ArchiveEntry {
                path,
                original_size,
                archive_size,
                stored_adler32,
                segments: writer_segments,
                payload,
            });
        }
        cursor = content_end;
    }

    Ok(PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries,
    })
}

/// Detect the helper-required marker the classifier emits.
fn has_legacy_xp3_helper_required_marker(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"XP3\r\n") {
        return false;
    }
    let marker_region = &bytes[..bytes.len().min(128)];
    header_contains_ascii(marker_region, "XP3-HELPER-REQUIRED")
        || header_contains_ascii(marker_region, "kaifuu-xp3-helper-required")
}

/// Detect the compressed/packed marker the classifier emits.
fn has_legacy_xp3_compressed_marker(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"XP3\r\n") {
        return false;
    }
    let marker_region = &bytes[..bytes.len().min(128)];
    header_contains_ascii(marker_region, "XP3-COMPRESSED")
        || header_contains_ascii(marker_region, "kaifuu-xp3-compressed")
}

/// Encode a [`PlainXp3Archive`] to a deterministic XP3 byte stream.
/// Layout (matches the existing fixture-only synthetic builder):
/// 1. [`XP3_PLAIN_MAGIC`] (11 bytes)
/// 2. Placeholder u64 for the index offset (filled in at the end).
/// 3. Each entry's concatenated segment payloads, in entry order, in
///    segment order. The offset of each segment is recorded into the
///    segm chunk so a re-parse round-trips.
/// 4. Index encoding byte (`0`).
/// 5. Index size u64 (the byte length of the File chunks that follow).
/// 6. One `File` chunk per entry, each containing `info`, `segm`, and
///    (when the source had one) `adlr` chunks in that order.
///    Rebuilding from a manifest produced by [`read_plain_xp3_archive`]
///    returns the same bytes as the source archive: this is the
///    determinism guarantee makes.
pub fn encode_xp3(archive: &PlainXp3Archive) -> Result<Vec<u8>, PlainXp3WriterError> {
    if archive.variant != PLAIN_XP3_MANIFEST_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(
            archive.variant.clone(),
        ));
    }

    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    // Placeholder for index_offset.
    bytes.extend_from_slice(&0_u64.to_le_bytes());

    // Track segment offsets per entry as we emit payloads.
    let mut entry_segment_offsets: Vec<Vec<u64>> = Vec::with_capacity(archive.entries.len());
    for entry in &archive.entries {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;

        let total_archive_size: u64 = entry
            .segments
            .iter()
            .map(|segment| segment.archive_size)
            .sum();
        if total_archive_size != entry.archive_size {
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} segment archive_size sum {} does not match recorded archive_size {}",
                entry.path, total_archive_size, entry.archive_size
            )));
        }
        if (entry.payload.len() as u64) != total_archive_size {
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} payload length {} does not match segment archive_size sum {}",
                entry.path,
                entry.payload.len(),
                total_archive_size
            )));
        }

        let mut offsets = Vec::with_capacity(entry.segments.len());
        let mut payload_cursor = 0_usize;
        for segment in &entry.segments {
            offsets.push(bytes.len() as u64);
            let segment_len = usize::try_from(segment.archive_size).map_err(|_| {
                PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment archive_size {} does not fit in usize",
                    entry.path, segment.archive_size
                ))
            })?;
            let segment_end = payload_cursor.checked_add(segment_len).ok_or_else(|| {
                PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment slice overflows payload",
                    entry.path
                ))
            })?;
            if segment_end > entry.payload.len() {
                return Err(PlainXp3WriterError::InconsistentManifest(format!(
                    "entry {:?} segment slice {}..{} exceeds payload length {}",
                    entry.path,
                    payload_cursor,
                    segment_end,
                    entry.payload.len()
                )));
            }
            bytes.extend_from_slice(&entry.payload[payload_cursor..segment_end]);
            payload_cursor = segment_end;
        }
        entry_segment_offsets.push(offsets);
    }

    let index_offset = bytes.len() as u64;
    let mut index = Vec::new();
    for (entry, offsets) in archive.entries.iter().zip(&entry_segment_offsets) {
        let mut file = Vec::new();

        let path_units: Vec<u16> = entry.path.encode_utf16().collect();
        let mut info = Vec::with_capacity(4 + 8 + 8 + 2 + path_units.len() * 2);
        // writes the four reserved info-chunk bytes as zero
        // matching every fixture-only plain XP3 archive in the repo. The
        // reader ignores these bytes; preserving the value keeps the
        // round-trip byte-identical for every fixture we have.
        info.extend_from_slice(&0_u32.to_le_bytes());
        info.extend_from_slice(&entry.original_size.to_le_bytes());
        info.extend_from_slice(&entry.archive_size.to_le_bytes());
        let path_unit_count = u16::try_from(path_units.len()).map_err(|_| {
            PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} path length {} UTF-16 units does not fit in u16",
                entry.path,
                path_units.len()
            ))
        })?;
        info.extend_from_slice(&path_unit_count.to_le_bytes());
        for unit in path_units {
            info.extend_from_slice(&unit.to_le_bytes());
        }
        append_plain_xp3_chunk(&mut file, *b"info", &info);

        let mut segm = Vec::with_capacity(entry.segments.len() * 28);
        for (segment, segment_offset) in entry.segments.iter().zip(offsets) {
            segm.extend_from_slice(&segment.flags.to_le_bytes());
            segm.extend_from_slice(&segment_offset.to_le_bytes());
            segm.extend_from_slice(&segment.original_size.to_le_bytes());
            segm.extend_from_slice(&segment.archive_size.to_le_bytes());
        }
        append_plain_xp3_chunk(&mut file, *b"segm", &segm);

        if let Some(adler) = entry.stored_adler32 {
            append_plain_xp3_chunk(&mut file, *b"adlr", &adler.to_le_bytes());
        }

        append_plain_xp3_chunk(&mut index, *b"File", &file);
    }

    // Index encoding (plain) + size + content.
    bytes.push(0);
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index);

    // Backfill the index offset.
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());

    Ok(bytes)
}

fn append_plain_xp3_chunk(output: &mut Vec<u8>, name: [u8; 4], content: &[u8]) {
    output.extend_from_slice(&name);
    output.extend_from_slice(&(content.len() as u64).to_le_bytes());
    output.extend_from_slice(content);
}

/// Manifest written to disk by [`unpack_plain_xp3_to_directory`].
/// The on-disk layout mirrors [`PlainXp3Archive`] but stores each entry's
/// raw payload as a separate file under `payload/` so callers can edit
/// individual entries without going through hex round-tripping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3DirectoryManifest {
    pub schema_version: String,
    pub variant: String,
    pub entries: Vec<PlainXp3DirectoryManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3DirectoryManifestEntry {
    pub path: String,
    pub payload_relative_path: String,
    pub original_size: u64,
    pub archive_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_adler32_hex: Option<String>,
    pub segments: Vec<PlainXp3ArchiveSegment>,
}

/// Symlink-safe (`O_NOFOLLOW`, fd-relative) materialization of the unpacked
/// plain XP3 directory layout.
/// [`validate_safe_relative_path`] is a string-level first-line check only: it
/// cannot see the filesystem, so a symlink planted inside the unpack/output
/// directory (or a directory component that is a symlink pointing outside the
/// root) would let a `dir.join(relative)` + `fs::write`/`fs::read` escape the
/// intended root even though the string looked "safe" (TOCTOU / symlink
/// traversal). These helpers are the real security boundary: they open the
/// caller-named root, then descend every relative component RELATIVE to a held
/// directory descriptor with `O_NOFOLLOW`. A symlink squatting on any component
/// (or the leaf) fails the `openat` with `ELOOP` and is reported as
/// [`PlainXp3WriterError::SymlinkTraversalRefused`] — the read/write is refused
/// in place and can never follow the link out of the root, even under a
/// concurrent swap. Mirrors the runtime-artifact hardening.
/// Threat model: the root `dir` is the caller's trust anchor (they explicitly
/// name it), so the root path itself is resolved normally; every component
/// BELOW the root — which is influenced by the manifest and/or a prior unpack
/// of untrusted archive bytes — is descended no-follow.
#[cfg(unix)]
mod plain_xp3_no_follow {
    use super::PlainXp3WriterError;
    use std::ffi::OsStr;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
    use std::path::Path;

    use rustix::fs::{AtFlags, FileType, Mode, OFlags};
    use rustix::io::Errno;

    fn io_err(error: impl Into<io::Error>) -> PlainXp3WriterError {
        PlainXp3WriterError::Io(error.into().to_string())
    }

    fn symlink_refused(relative: &str) -> PlainXp3WriterError {
        PlainXp3WriterError::SymlinkTraversalRefused(relative.to_string())
    }

    /// Open the caller-named trusted root directory. The root's own path is
    /// resolved normally (the caller chose it); every component descended below
    /// it carries `O_NOFOLLOW`.
    fn open_root(dir: &Path) -> Result<OwnedFd, PlainXp3WriterError> {
        rustix::fs::open(
            dir,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io_err)
    }

    /// Re-open `dir` via `.` for an owned descriptor to the same inode without
    /// following any symlink.
    fn reopen(dir: BorrowedFd<'_>) -> Result<OwnedFd, PlainXp3WriterError> {
        rustix::fs::openat(
            dir,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io_err)
    }

    fn is_symlink(dir: BorrowedFd<'_>, name: &OsStr) -> bool {
        rustix::fs::statat(dir, name, AtFlags::SYMLINK_NOFOLLOW)
            .is_ok_and(|stat| FileType::from_raw_mode(stat.st_mode).is_symlink())
    }

    /// Split a `validate_safe_relative_path`-validated relative path
    /// (`/`-separated, no empty / `.` / `..` components) into its directory
    /// components and final filename.
    fn split_relative(relative: &str) -> Result<(Vec<&OsStr>, &OsStr), PlainXp3WriterError> {
        let mut parts: Vec<&OsStr> = relative.split('/').map(OsStr::new).collect();
        let filename = parts.pop().filter(|name| !name.is_empty()).ok_or_else(|| {
            PlainXp3WriterError::InconsistentManifest(format!(
                "relative materialization path {relative:?} has no filename component"
            ))
        })?;
        Ok((parts, filename))
    }

    /// Descend `parents` from the trusted root with `O_NOFOLLOW` on every hop.
    /// A symlink on any component fails the `openat` (`ELOOP`) and is reported
    /// as a refused traversal, never followed. Missing components are created
    /// (`mkdirat`, 0700) when `create` is set.
    fn descend(
        root: BorrowedFd<'_>,
        parents: &[&OsStr],
        relative: &str,
        create: bool,
    ) -> Result<OwnedFd, PlainXp3WriterError> {
        let mut current = reopen(root)?;
        for name in parents {
            if create {
                match rustix::fs::mkdirat(current.as_fd(), *name, Mode::RWXU) {
                    Ok(()) => {}
                    Err(error) if error == Errno::EXIST => {}
                    Err(error) => return Err(io_err(error)),
                }
            }
            let opened = rustix::fs::openat(
                current.as_fd(),
                *name,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            );
            current = match opened {
                Ok(fd) => fd,
                Err(error) if error == Errno::LOOP => return Err(symlink_refused(relative)),
                Err(error) => {
                    if is_symlink(current.as_fd(), name) {
                        return Err(symlink_refused(relative));
                    }
                    return Err(io_err(error));
                }
            };
        }
        Ok(current)
    }

    /// Write `contents` to `relative` under `dir`, refusing any symlink
    /// component (including a symlink squatting on the leaf). `create_dirs`
    /// creates missing parent directories no-follow.
    pub fn write_no_follow(
        dir: &Path,
        relative: &str,
        contents: &[u8],
        create_dirs: bool,
    ) -> Result<(), PlainXp3WriterError> {
        let (parents, filename) = split_relative(relative)?;
        let root = open_root(dir)?;
        let dir_fd = descend(root.as_fd(), &parents, relative, create_dirs)?;
        // A symlink already occupying the leaf is refused with a clear error;
        // the `O_NOFOLLOW` open below is the actual guard (`ELOOP`) and holds
        // even under a concurrent swap between this check and the open.
        if is_symlink(dir_fd.as_fd(), filename) {
            return Err(symlink_refused(relative));
        }
        let opened = rustix::fs::openat(
            dir_fd.as_fd(),
            filename,
            OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::ROTH,
        );
        let fd = match opened {
            Ok(fd) => fd,
            Err(error) if error == Errno::LOOP => return Err(symlink_refused(relative)),
            Err(error) => return Err(io_err(error)),
        };
        let mut file = std::fs::File::from(fd);
        file.write_all(contents).map_err(io_err)?;
        file.sync_all().map_err(io_err)?;
        Ok(())
    }

    /// Read `relative` under `dir`, refusing any symlink component (including a
    /// symlink squatting on the leaf).
    pub fn read_no_follow(dir: &Path, relative: &str) -> Result<Vec<u8>, PlainXp3WriterError> {
        let (parents, filename) = split_relative(relative)?;
        let root = open_root(dir)?;
        let dir_fd = descend(root.as_fd(), &parents, relative, false)?;
        let opened = rustix::fs::openat(
            dir_fd.as_fd(),
            filename,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        );
        let fd = match opened {
            Ok(fd) => fd,
            Err(error) if error == Errno::LOOP => return Err(symlink_refused(relative)),
            Err(error) => return Err(io_err(error)),
        };
        let mut file = std::fs::File::from(fd);
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).map_err(io_err)?;
        Ok(buffer)
    }
}

/// Non-Unix fallback: the fd-relative `O_NOFOLLOW` primitives the symlink-safe
/// materialization depends on are Unix-only, so the plain XP3 directory writer
/// is unsupported there rather than silently falling back to an unsafe
/// `fs::write`/`fs::read`.
#[cfg(not(unix))]
mod plain_xp3_no_follow {
    use super::PlainXp3WriterError;
    use std::path::Path;

    const UNSUPPORTED: &str =
        "symlink-safe plain XP3 directory materialization requires a Unix platform";

    pub fn write_no_follow(
        _dir: &Path,
        _relative: &str,
        _contents: &[u8],
        _create_dirs: bool,
    ) -> Result<(), PlainXp3WriterError> {
        Err(PlainXp3WriterError::Io(UNSUPPORTED.to_string()))
    }

    pub fn read_no_follow(_dir: &Path, _relative: &str) -> Result<Vec<u8>, PlainXp3WriterError> {
        Err(PlainXp3WriterError::Io(UNSUPPORTED.to_string()))
    }
}

/// Unpack a plain XP3 archive into a directory layout suitable for the
/// deterministic writer.
/// Layout produced under `dir`:
/// - `manifest.json`: ordered list of entries with per-segment metadata.
/// - `payload/<index>-<flat-path>.bin`: raw segment payload for each
///   entry, where `<index>` is the entry's zero-padded source-order
///   index and `<flat-path>` replaces slashes with `__`.
///   Refuses non-plain XP3 bytes (encrypted, compressed, helper-required, or unknown
///   containers) **before** writing any file under `dir`. The directory
///   is created if missing.
pub fn unpack_plain_xp3_to_directory(
    bytes: &[u8],
    dir: &Path,
) -> Result<PlainXp3DirectoryManifest, PlainXp3WriterError> {
    let archive = read_plain_xp3_archive(bytes)?;

    fs::create_dir_all(dir).map_err(|error| PlainXp3WriterError::Io(error.to_string()))?;

    let mut manifest_entries = Vec::with_capacity(archive.entries.len());
    let width = format!("{}", archive.entries.len().saturating_sub(1))
        .len()
        .max(2);
    for (index, entry) in archive.entries.iter().enumerate() {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
        let flat = entry.path.replace('/', "__");
        let payload_relative = format!("payload/{index:0width$}-{flat}.bin");
        // Symlink-safe materialization: descends `payload/` no-follow and
        // refuses a symlink squatting anywhere under the root (create_dirs=true
        // makes the `payload/` subdir with `mkdirat`).
        plain_xp3_no_follow::write_no_follow(dir, &payload_relative, &entry.payload, true)?;
        manifest_entries.push(PlainXp3DirectoryManifestEntry {
            path: entry.path.clone(),
            payload_relative_path: payload_relative,
            original_size: entry.original_size,
            archive_size: entry.archive_size,
            stored_adler32_hex: entry.stored_adler32.map(|value| format!("{value:08x}")),
            segments: entry.segments.clone(),
        });
    }

    let manifest = PlainXp3DirectoryManifest {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: manifest_entries,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;
    plain_xp3_no_follow::write_no_follow(dir, "manifest.json", manifest_json.as_bytes(), true)?;
    Ok(manifest)
}

/// Rebuild a plain XP3 archive from a directory previously produced by
/// [`unpack_plain_xp3_to_directory`].
/// The directory's `manifest.json` is parsed; each entry's payload is
/// loaded from the manifest-declared relative path. The writer refuses
/// non-`plain` variants (encrypted / compressed / helper-required / unknown) with the
/// matching semantic diagnostic. Compressed entries are passed through
/// when their payload length still matches the recorded `archive_size`;
/// a length mismatch on a compressed entry triggers
/// [`PlainXp3WriterError::UnsupportedCompressedReplacement`] because the
/// writer cannot recompress.
pub fn pack_plain_xp3_from_directory(dir: &Path) -> Result<Vec<u8>, PlainXp3WriterError> {
    let manifest_bytes = plain_xp3_no_follow::read_no_follow(dir, "manifest.json")?;
    let manifest: PlainXp3DirectoryManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;

    if manifest.variant != PLAIN_XP3_MANIFEST_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(manifest.variant));
    }

    let mut archive_entries = Vec::with_capacity(manifest.entries.len());
    for entry in manifest.entries {
        validate_safe_relative_path(&entry.path)
            .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
        validate_safe_relative_path(&entry.payload_relative_path).map_err(|_| {
            PlainXp3WriterError::UnsafeRelativePath(entry.payload_relative_path.clone())
        })?;
        // Symlink-safe read: refuses a symlink component so a tampered manifest
        // plus a planted symlink cannot exfiltrate a file outside the root.
        let payload = plain_xp3_no_follow::read_no_follow(dir, &entry.payload_relative_path)?;

        let total_archive_size: u64 = entry.segments.iter().map(|s| s.archive_size).sum();
        if (payload.len() as u64) != total_archive_size {
            let any_compressed = entry
                .segments
                .iter()
                .any(PlainXp3ArchiveSegment::is_compressed);
            if any_compressed {
                return Err(PlainXp3WriterError::UnsupportedCompressedReplacement(
                    entry.path,
                ));
            }
            return Err(PlainXp3WriterError::InconsistentManifest(format!(
                "entry {:?} payload length {} no longer matches segment archive_size sum {}",
                entry.path,
                payload.len(),
                total_archive_size
            )));
        }
        let stored_adler32 = match entry.stored_adler32_hex.as_deref() {
            Some(hex) => Some(u32::from_str_radix(hex, 16).map_err(|_| {
                PlainXp3WriterError::ManifestParse(format!(
                    "stored_adler32_hex {hex:?} is not a valid hex u32"
                ))
            })?),
            None => None,
        };
        archive_entries.push(PlainXp3ArchiveEntry {
            path: entry.path,
            original_size: entry.original_size,
            archive_size: entry.archive_size,
            stored_adler32,
            segments: entry.segments,
            payload,
        });
    }

    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: archive_entries,
    };
    encode_xp3(&archive)
}

/// Replace a single entry's payload inside an unpacked plain XP3
/// directory layout. Updates `manifest.json` (archive_size,
/// original_size, segment archive_size/original_size) so the next
/// [`pack_plain_xp3_from_directory`] call emits the rewritten entry.
/// Acceptance criterion: "Replacing an allowed plain fixture file
/// updates table metadata and verification output."
/// The replacement is only allowed when the entry's segments are all
/// uncompressed (no decompression / recompression is in scope for
/// ). Refuses with
/// [`PlainXp3WriterError::UnsupportedCompressedReplacement`] otherwise.
/// Multi-segment uncompressed entries are also out of scope — the
/// writer would have no canonical rule for how to split the new payload
/// across the original segment boundaries, so we refuse with
/// `InconsistentManifest` to keep the rebuild deterministic.
pub fn replace_plain_xp3_entry_payload(
    dir: &Path,
    entry_path: &str,
    new_payload: &[u8],
) -> Result<PlainXp3DirectoryManifest, PlainXp3WriterError> {
    let manifest_bytes = plain_xp3_no_follow::read_no_follow(dir, "manifest.json")?;
    let mut manifest: PlainXp3DirectoryManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;
    if manifest.variant != PLAIN_XP3_MANIFEST_VARIANT {
        return Err(PlainXp3WriterError::UnsupportedVariant(manifest.variant));
    }

    let entry = manifest
        .entries
        .iter_mut()
        .find(|entry| entry.path == entry_path)
        .ok_or_else(|| {
            PlainXp3WriterError::InconsistentManifest(format!(
                "entry {entry_path:?} not present in manifest"
            ))
        })?;
    validate_safe_relative_path(&entry.path)
        .map_err(|_| PlainXp3WriterError::UnsafeRelativePath(entry.path.clone()))?;
    validate_safe_relative_path(&entry.payload_relative_path).map_err(|_| {
        PlainXp3WriterError::UnsafeRelativePath(entry.payload_relative_path.clone())
    })?;
    if entry
        .segments
        .iter()
        .any(PlainXp3ArchiveSegment::is_compressed)
    {
        return Err(PlainXp3WriterError::UnsupportedCompressedReplacement(
            entry.path.clone(),
        ));
    }
    if entry.segments.len() != 1 {
        return Err(PlainXp3WriterError::InconsistentManifest(format!(
            "entry {entry_path:?} has {} segments; KAIFUU-098 only replaces single-segment uncompressed entries",
            entry.segments.len()
        )));
    }

    let new_size = new_payload.len() as u64;
    entry.original_size = new_size;
    entry.archive_size = new_size;
    entry.segments[0].original_size = new_size;
    entry.segments[0].archive_size = new_size;
    entry.stored_adler32_hex = Some(format!("{:08x}", compute_adler32(new_payload)));

    // Symlink-safe write: the payload is materialized first, so if a symlink is
    // refused here the manifest.json on disk is left untouched (metadata is not
    // persisted through a partial escape).
    plain_xp3_no_follow::write_no_follow(dir, &entry.payload_relative_path, new_payload, false)?;

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|error| PlainXp3WriterError::ManifestParse(error.to_string()))?;
    plain_xp3_no_follow::write_no_follow(dir, "manifest.json", manifest_json.as_bytes(), false)?;
    Ok(manifest)
}

pub(crate) fn has_legacy_xp3_encrypted_marker(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"XP3\r\n") {
        return false;
    }
    let marker_region = &bytes[..bytes.len().min(128)];
    header_contains_ascii(marker_region, "XP3-CRYPT")
        || header_contains_ascii(marker_region, "kaifuu-xp3-encrypted")
}

pub(crate) fn parse_xp3_file_chunk(
    bytes: &[u8],
    start: usize,
    end: usize,
) -> Result<PlainXp3FileChunk, PlainXp3InventoryError> {
    let mut cursor = start;
    let mut file = PlainXp3FileChunk {
        path: None,
        original_size: None,
        archive_size: None,
        segments: vec![],
        stored_adler32: None,
    };
    while cursor < end {
        let chunk_name = read_chunk_name(bytes, cursor, "file chunk name")?;
        let chunk_size = read_le_u64(bytes, cursor + 4, "file chunk size")?;
        let content_start = cursor + 12;
        let content_size = usize::try_from(chunk_size)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("file chunk size"))?;
        let content_end = checked_end(content_start, content_size, end, "file chunk")?;
        match &chunk_name {
            b"info" => parse_xp3_info_chunk(bytes, content_start, content_end, &mut file)?,
            b"segm" => parse_xp3_segment_chunk(bytes, content_start, content_end, &mut file)?,
            b"adlr" => {
                if content_size != 4 {
                    return Err(PlainXp3InventoryError::InvalidChunk(
                        "adlr chunk must be four bytes".to_string(),
                    ));
                }
                file.stored_adler32 = Some(format!(
                    "adler32:{:08x}",
                    read_le_u32(bytes, content_start, "adlr")?
                ));
            }
            _ => {}
        }
        cursor = content_end;
    }
    if file.segments.is_empty() {
        return Err(PlainXp3InventoryError::InvalidChunk(
            "File chunk missing segment table".to_string(),
        ));
    }
    Ok(file)
}

fn parse_xp3_info_chunk(
    bytes: &[u8],
    start: usize,
    end: usize,
    file: &mut PlainXp3FileChunk,
) -> Result<(), PlainXp3InventoryError> {
    let minimum_size = 4 + 8 + 8 + 2;
    if end.saturating_sub(start) < minimum_size {
        return Err(PlainXp3InventoryError::Truncated("info chunk"));
    }
    file.original_size = Some(read_le_u64(bytes, start + 4, "info original size")?);
    file.archive_size = Some(read_le_u64(bytes, start + 12, "info archive size")?);
    let path_units = usize::from(read_le_u16(bytes, start + 20, "info path length")?);
    let path_start = start + 22;
    let path_bytes = path_units
        .checked_mul(2)
        .ok_or(PlainXp3InventoryError::InvalidOffset("info path length"))?;
    let path_end = checked_end(path_start, path_bytes, end, "info path")?;
    let mut units = Vec::with_capacity(path_units);
    let mut cursor = path_start;
    while cursor < path_end {
        units.push(read_le_u16(bytes, cursor, "info path unit")?);
        cursor += 2;
    }
    file.path =
        Some(String::from_utf16(&units).map_err(|_| PlainXp3InventoryError::InvalidUtf16Path)?);
    Ok(())
}

fn parse_xp3_segment_chunk(
    bytes: &[u8],
    start: usize,
    end: usize,
    file: &mut PlainXp3FileChunk,
) -> Result<(), PlainXp3InventoryError> {
    let segment_size = 4 + 8 + 8 + 8;
    if !(end - start).is_multiple_of(segment_size) {
        return Err(PlainXp3InventoryError::InvalidChunk(
            "segment table size is not a multiple of 28".to_string(),
        ));
    }
    let mut cursor = start;
    while cursor < end {
        file.segments.push(PlainXp3Segment {
            flags: read_le_u32(bytes, cursor, "segment flags")?,
            offset: read_le_u64(bytes, cursor + 4, "segment offset")?,
            original_size: read_le_u64(bytes, cursor + 12, "segment original size")?,
            archive_size: read_le_u64(bytes, cursor + 20, "segment archive size")?,
        });
        cursor += segment_size;
    }
    Ok(())
}

pub(crate) fn hash_xp3_segments(
    bytes: &[u8],
    segments: &[PlainXp3Segment],
) -> Result<Option<String>, PlainXp3InventoryError> {
    let mut payload = Vec::new();
    for segment in segments {
        let offset = usize::try_from(segment.offset)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("segment"))?;
        let size = usize::try_from(segment.archive_size)
            .map_err(|_| PlainXp3InventoryError::InvalidOffset("segment size"))?;
        let end = checked_end(offset, size, bytes.len(), "segment payload")?;
        payload.extend_from_slice(&bytes[offset..end]);
    }
    Ok(Some(sha256_hash_bytes(&payload)))
}

pub(crate) fn read_chunk_name(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<[u8; 4], PlainXp3InventoryError> {
    let end = checked_end(offset, 4, bytes.len(), field)?;
    let mut name = [0; 4];
    name.copy_from_slice(&bytes[offset..end]);
    Ok(name)
}

fn read_le_u16(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<u16, PlainXp3InventoryError> {
    let end = checked_end(offset, 2, bytes.len(), field)?;
    let mut raw = [0; 2];
    raw.copy_from_slice(&bytes[offset..end]);
    Ok(u16::from_le_bytes(raw))
}

fn read_le_u32(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<u32, PlainXp3InventoryError> {
    let end = checked_end(offset, 4, bytes.len(), field)?;
    let mut raw = [0; 4];
    raw.copy_from_slice(&bytes[offset..end]);
    Ok(u32::from_le_bytes(raw))
}

pub(crate) fn read_le_u64(
    bytes: &[u8],
    offset: usize,
    field: &'static str,
) -> Result<u64, PlainXp3InventoryError> {
    let end = checked_end(offset, 8, bytes.len(), field)?;
    let mut raw = [0; 8];
    raw.copy_from_slice(&bytes[offset..end]);
    Ok(u64::from_le_bytes(raw))
}

pub(crate) fn checked_end(
    start: usize,
    size: usize,
    upper_bound: usize,
    field: &'static str,
) -> Result<usize, PlainXp3InventoryError> {
    let end = start
        .checked_add(size)
        .ok_or(PlainXp3InventoryError::InvalidOffset(field))?;
    if end > upper_bound {
        return Err(PlainXp3InventoryError::Truncated(field));
    }
    Ok(end)
}

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

pub fn write_json<T>(path: &Path, value: &T) -> KaifuuResult<()>
where
    T: Serialize,
{
    atomic_write_text(path, &stable_json(value)?)
}

pub fn stable_json<T>(value: &T) -> KaifuuResult<String>
where
    T: Serialize,
{
    let pretty = serde_json::to_string_pretty(value)?;
    Ok(format!("{}\n", compact_primitive_json_arrays(&pretty)))
}

fn compact_primitive_json_arrays(pretty: &str) -> String {
    let lines = pretty.lines().collect::<Vec<_>>();
    let mut formatted = Vec::with_capacity(lines.len());
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        if let Some(compacted) = compact_primitive_json_array(&lines, index) {
            formatted.push(compacted.line);
            index = compacted.next_index;
        } else {
            formatted.push(line.to_string());
            index += 1;
        }
    }

    formatted.join("\n")
}

struct CompactedJsonArray {
    line: String,
    next_index: usize,
}

fn compact_primitive_json_array(lines: &[&str], start_index: usize) -> Option<CompactedJsonArray> {
    let line = lines[start_index];
    let trimmed = line.trim_end();
    if trimmed == "[" || !trimmed.ends_with('[') {
        return None;
    }
    let open_index = line.rfind('[')?;
    let prefix = &line[..open_index];
    let mut items = Vec::new();
    let mut index = start_index + 1;

    while let Some(candidate) = lines.get(index) {
        let trimmed_candidate = candidate.trim();
        if trimmed_candidate == "]" || trimmed_candidate == "]," {
            if items.is_empty() {
                return None;
            }
            let trailing_comma = if trimmed_candidate.ends_with(',') {
                ","
            } else {
                ""
            };
            return Some(CompactedJsonArray {
                line: format!("{prefix}[{}]{trailing_comma}", items.join(", ")),
                next_index: index + 1,
            });
        }

        let item = trimmed_candidate
            .strip_suffix(',')
            .unwrap_or(trimmed_candidate);
        let parsed: Value = match serde_json::from_str(item) {
            Ok(value) => value,
            Err(_) => return None,
        };
        if !is_primitive_json_value(&parsed) {
            return None;
        }
        items.push(item.to_string());
        index += 1;
    }

    None
}

fn is_primitive_json_value(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

pub fn read_json<T>(path: &Path) -> KaifuuResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

pub fn run_round_trip_golden(
    registry: &AdapterRegistry,
    request: GoldenHarnessRequest<'_>,
) -> KaifuuResult<GoldenRoundTripReport> {
    let adapter = golden_adapter(registry, request.game_dir, request.adapter_id)?;
    let mut report = GoldenRoundTripReport {
        schema_version: "0.1.0".to_string(),
        report_id: deterministic_id("golden-round-trip", 1),
        adapter_id: adapter.id().to_string(),
        adapter_name: adapter.name().to_string(),
        status: OperationStatus::Passed,
        phases: vec![],
        failures: vec![],
    };

    let detection = adapter.detect(DetectRequest {
        game_dir: request.game_dir,
    });
    match detection {
        Ok(detection) if detection.detected => report_passed_phase(
            &mut report,
            "detect",
            "adapter detected the fixture input",
            None,
        ),
        Ok(detection) => {
            let failure = GoldenFailure {
                code: "adapter_not_detected".to_string(),
                phase: "detect".to_string(),
                adapter_id: adapter.id().to_string(),
                message: "selected adapter did not detect the fixture input".to_string(),
                asset_ref: detection
                    .evidence
                    .first()
                    .map(|evidence| evidence.path.clone()),
                source_unit_key: None,
                support_boundary: None,
                expected: Some("detected=true".to_string()),
                actual: Some("detected=false".to_string()),
                required_capability: None,
            };
            record_golden_failure(&mut report, failure);
            return Ok(finalize_golden_report(report));
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "detect_error".to_string(),
                    phase: "detect".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful detection".to_string()),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(finalize_golden_report(report));
        }
    }

    let extraction = match adapter.extract(ExtractRequest {
        game_dir: request.game_dir,
    }) {
        Ok(extraction) => {
            report_passed_phase(
                &mut report,
                "extract",
                format!("extracted {} bridge unit(s)", extraction.bridge.units.len()),
                None,
            );
            extraction
        }
        Err(error) => {
            record_golden_failure(
                &mut report,
                GoldenFailure {
                    code: "extract_error".to_string(),
                    phase: "extract".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some("successful extraction".to_string()),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(finalize_golden_report(report));
        }
    };

    let unchanged_patch = match unchanged_patch_export(&extraction.bridge) {
        Ok(patch) => patch,
        Err(failure) => {
            record_golden_failure(&mut report, (*failure).with_adapter_id(adapter.id()));
            return Ok(finalize_golden_report(report));
        }
    };

    let Some(unchanged_output_dir) = run_golden_patch_phase(GoldenPatchPhaseArgs {
        adapter,
        report: &mut report,
        phase: "unchanged_patch",
        game_dir: request.game_dir,
        work_dir: request.work_dir,
        work_child: "unchanged-patch",
        patch_export: &unchanged_patch,
        success_details: "unchanged patch applied successfully",
        patch_error_code: "unchanged_patch_error",
        patch_expected: "successful unchanged patch",
    })?
    else {
        return Ok(finalize_golden_report(report));
    };

    report_byte_equivalence(
        adapter,
        &mut report,
        request.game_dir,
        &unchanged_output_dir,
        &request.byte_equivalence,
    );
    report_verify_phase(
        adapter,
        &mut report,
        "unchanged_verify",
        &unchanged_output_dir,
    );
    report_output_equivalence(
        adapter,
        &mut report,
        &extraction,
        &unchanged_output_dir,
        "unchanged_output_equivalence",
    );

    if let Some(translated_patch_export) = request.translated_patch_export {
        report_translated_patch(
            adapter,
            &mut report,
            &extraction,
            request.game_dir,
            request.work_dir,
            translated_patch_export,
            request.translated_source_bridge,
        )?;
    }

    Ok(finalize_golden_report(report))
}

/// Arguments for [`run_golden_patch_phase`], grouping the distinct pipeline-stage
/// inputs into a single struct so the driver keeps a one-argument signature.
struct GoldenPatchPhaseArgs<'a> {
    adapter: &'a dyn EngineAdapter,
    report: &'a mut GoldenRoundTripReport,
    phase: &'a str,
    game_dir: &'a Path,
    work_dir: &'a Path,
    work_child: &'a str,
    patch_export: &'a PatchExport,
    success_details: &'a str,
    patch_error_code: &'a str,
    patch_expected: &'a str,
}

fn run_golden_patch_phase(args: GoldenPatchPhaseArgs<'_>) -> KaifuuResult<Option<PathBuf>> {
    let GoldenPatchPhaseArgs {
        adapter,
        report,
        phase,
        game_dir,
        work_dir,
        work_child,
        patch_export,
        success_details,
        patch_error_code,
        patch_expected,
    } = args;
    match adapter.patch_preflight(PatchPreflightRequest {
        game_dir,
        patch_export,
    }) {
        Ok(preflight)
            if preflight.status == OperationStatus::Failed
                && preflight.has_preflight_blocking_failure() =>
        {
            let preflight = preflight.redacted_for_report();
            record_adapter_failures(report, adapter.id(), phase, &preflight);
            return Ok(None);
        }
        Ok(_) => {}
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: format!("{phase}_preflight_error"),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some(format!("{patch_expected} preflight")),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(None);
        }
    }

    let output_dir = prepare_golden_work_dir(work_dir, work_child)?;
    match adapter.patch(PatchRequest {
        game_dir,
        patch_export,
        output_dir: &output_dir,
    }) {
        Ok(patch_result) if patch_result.status == OperationStatus::Passed => {
            report_passed_phase(report, phase, success_details, Some("source.json"));
        }
        Ok(patch_result) => {
            let patch_result = patch_result.redacted_for_report();
            record_adapter_failures(report, adapter.id(), phase, &patch_result);
            return Ok(None);
        }
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: patch_error_code.to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: None,
                    expected: Some(patch_expected.to_string()),
                    actual: Some("adapter error".to_string()),
                    required_capability: None,
                },
            );
            return Ok(None);
        }
    }

    Ok(Some(output_dir))
}

fn golden_adapter<'a>(
    registry: &'a AdapterRegistry,
    game_dir: &Path,
    adapter_id: Option<&str>,
) -> KaifuuResult<&'a dyn EngineAdapter> {
    if let Some(adapter_id) = adapter_id {
        return registry
            .get(adapter_id)
            .ok_or_else(|| format!("adapter {adapter_id} is not registered").into());
    }

    let detection = registry
        .detect(game_dir)?
        .ok_or_else(|| format!("no registered adapter detected {}", game_dir.display()))?;
    registry.get(&detection.adapter_id).ok_or_else(|| {
        format!(
            "detected adapter {} is not registered",
            detection.adapter_id
        )
        .into()
    })
}

fn prepare_golden_work_dir(root: &Path, child: &str) -> KaifuuResult<PathBuf> {
    let path = safe_join_relative(root, child)?;
    match fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn unchanged_patch_export(bridge: &BridgeBundle) -> Result<PatchExport, Box<GoldenFailure>> {
    let mut entries = Vec::with_capacity(bridge.units.len());
    for unit in &bridge.units {
        let mut protected_span_mappings = Vec::new();
        let mut search_start = 0;
        for span in &unit.protected_spans {
            if span.raw.is_empty() {
                continue;
            }
            let Some(relative_start) = unit.source_text[search_start..].find(&span.raw) else {
                let span_summary = RedactedContentSummary::from_text(&span.raw);
                let source_summary = RedactedContentSummary::from_text(&unit.source_text);
                return Err(Box::new(GoldenFailure {
                    code: "unchanged_patch_protected_span_missing".to_string(),
                    phase: "unchanged_patch_build".to_string(),
                    adapter_id: String::new(),
                    message: format!(
                        "protected span raw text {span_summary} was not present while building unchanged patch"
                    ),
                    asset_ref: Some(unit.patch_ref.asset_id.clone()),
                    source_unit_key: Some(unit.source_unit_key.clone()),
                    support_boundary: Some(
                        "unchanged patch generation requires protected span raw text to exist in sourceText"
                            .to_string(),
                    ),
                    expected: Some(span_summary.to_string()),
                    actual: Some(source_summary.to_string()),
                                    required_capability: None,
}));
            };
            let target_start = search_start + relative_start;
            let target_end = target_start + span.raw.len();
            search_start = target_end;
            protected_span_mappings.push(
                ProtectedSpanMapping::new(&span.raw, target_start as u64, target_end as u64)
                    .with_source_identity(span.span_id.clone(), span.start, span.end),
            );
        }
        entries.push(PatchExportEntry {
            bridge_unit_id: unit.bridge_unit_id.clone(),
            source_unit_key: unit.source_unit_key.clone(),
            source_hash: unit.source_hash.clone(),
            target_text: unit.source_text.clone(),
            protected_span_mappings,
        });
    }

    Ok(PatchExport {
        patch_export_id: deterministic_id("round-trip-patch", 1),
        source_locale: bridge.source_locale.clone(),
        target_locale: bridge.source_locale.clone(),
        entries,
    })
}

impl GoldenFailure {
    fn with_adapter_id(mut self, adapter_id: &str) -> Self {
        self.adapter_id = adapter_id.to_string();
        self
    }
}

fn report_passed_phase(
    report: &mut GoldenRoundTripReport,
    phase: &str,
    details: impl Into<String>,
    asset_ref: Option<&str>,
) {
    report.phases.push(GoldenPhaseReport {
        phase: phase.to_string(),
        status: GoldenAssertionStatus::Passed,
        details: details.into(),
        asset_ref: asset_ref.map(str::to_string),
        source_unit_key: None,
        support_boundary: None,
        expected: None,
        actual: None,
        required_capability: None,
    });
}

fn record_golden_failure(report: &mut GoldenRoundTripReport, failure: GoldenFailure) {
    report.phases.push(GoldenPhaseReport {
        phase: failure.phase.clone(),
        status: GoldenAssertionStatus::Failed,
        details: failure.message.clone(),
        asset_ref: failure.asset_ref.clone(),
        source_unit_key: failure.source_unit_key.clone(),
        support_boundary: failure.support_boundary.clone(),
        expected: failure.expected.clone(),
        actual: failure.actual.clone(),
        required_capability: None,
    });
    report.failures.push(failure);
}

fn golden_error_summary(error: impl fmt::Display) -> String {
    let rendered = error.to_string();
    format!("error {}", RedactedContentSummary::from_text(&rendered))
}

fn golden_diagnostic_summary(diagnostic: &str) -> String {
    format!(
        "diagnostic {}",
        RedactedContentSummary::from_text(diagnostic)
    )
}

fn record_adapter_failures(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    phase: &str,
    patch_result: &PatchResult,
) {
    if patch_result.failures.is_empty() {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "patch_failed_without_detail".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter_id.to_string(),
                message: "adapter returned failed patch status without detailed failures"
                    .to_string(),
                asset_ref: None,
                source_unit_key: None,
                support_boundary: None,
                expected: Some("patch status passed".to_string()),
                actual: Some("patch status failed".to_string()),
                required_capability: None,
            },
        );
        return;
    }

    for failure in patch_result
        .failures
        .iter()
        .map(AdapterFailure::redacted_for_report)
    {
        let asset_ref = failure.asset_ref.clone();
        record_golden_failure(
            report,
            GoldenFailure {
                code: failure.error_code.clone(),
                phase: phase.to_string(),
                adapter_id: adapter_id.to_string(),
                message: golden_diagnostic_summary(
                    failure
                        .remediation
                        .as_deref()
                        .unwrap_or(&failure.support_boundary),
                ),
                source_unit_key: source_unit_key_from_asset_ref(asset_ref.as_deref()),
                asset_ref,
                support_boundary: Some(golden_diagnostic_summary(&failure.support_boundary)),
                expected: Some("patch status passed".to_string()),
                actual: Some("patch status failed".to_string()),
                required_capability: None,
            },
        );
    }
}

fn report_byte_equivalence(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    game_dir: &Path,
    output_dir: &Path,
    mode: &GoldenByteEquivalenceMode,
) {
    match mode {
        GoldenByteEquivalenceMode::AssertInventory => {
            report_inventory_asset_preservation(adapter, report, game_dir, output_dir);
        }
        GoldenByteEquivalenceMode::Unsupported { support_boundary } => {
            report.phases.push(GoldenPhaseReport {
                phase: "byte_equivalence".to_string(),
                status: GoldenAssertionStatus::Skipped,
                details: "byte-identical round-trip is not claimed for this adapter".to_string(),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: Some(support_boundary.clone()),
                expected: None,
                actual: None,
                required_capability: None,
            });
        }
        GoldenByteEquivalenceMode::AssertSourceJson => {
            let original_path = game_dir.join("source.json");
            let patched_path = output_dir.join("source.json");
            match (fs::read(&original_path), fs::read(&patched_path)) {
                (Ok(original), Ok(patched)) if original == patched => report_passed_phase(
                    report,
                    "byte_equivalence",
                    "source.json bytes are identical after unchanged patch",
                    Some("source.json"),
                ),
                (Ok(original), Ok(patched)) => record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "byte_equivalence_mismatch".to_string(),
                        phase: "byte_equivalence".to_string(),
                        adapter_id: report.adapter_id.clone(),
                        message: "source.json bytes changed after unchanged patch".to_string(),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: Some(
                            "byte-identical mode requires unchanged patch output to match the input bytes"
                                .to_string(),
                        ),
                        expected: Some(byte_content_hash(&original)),
                        actual: Some(byte_content_hash(&patched)),
                                            required_capability: None,
},
                ),
                (original, patched) => record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "byte_equivalence_io_error".to_string(),
                        phase: "byte_equivalence".to_string(),
                        adapter_id: report.adapter_id.clone(),
                        message: format!(
                            "could not read source.json for byte comparison: original={}, patched={}",
                            original
                                .err()
                                .map(golden_error_summary)
                                .unwrap_or_default(),
                            patched
                                .err()
                                .map(golden_error_summary)
                                .unwrap_or_default()
                        ),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: Some(
                            "byte-identical mode requires source.json to exist before and after patching"
                                .to_string(),
                        ),
                        expected: Some("readable source.json input and output".to_string()),
                        actual: Some("missing or unreadable source.json".to_string()),
                                            required_capability: None,
},
                ),
            }
        }
    }
}

/// adapter-neutral asset-preservation phase.
/// Instead of reading a hard-coded `source.json`, this re-runs the adapter's
/// own `asset_inventory` on both the input and the unchanged-patch output and
/// drives assertions off the adapter's INVENTORY + CAPABILITY reports:
/// * For every surface the adapter reports as capability-unsupported
///   ([`derive_asset_preservation_claims`]), it records a TYPED capability-aware
///   diagnostic (`asset_capability_diagnostic`, carrying the required
///   `Capability`) — proving an unsupported asset surfaces a structured
///   diagnostic rather than a silent skip.
/// * Because the adapter declares it cannot edit those assets, an identity
///   round-trip MUST preserve them: the harness compares each backing asset's
///   preservation signature (on-disk bytes when the asset path resolves to a
///   file, otherwise the adapter-reported `source_hash`) between input and
///   output and fails on any mutation, missing, or unexpected asset.
///   This makes no assumption about a `source.json` file or on-disk layout, so it
///   works for an adapter whose inventory names assets under any scheme.
fn report_inventory_asset_preservation(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    game_dir: &Path,
    output_dir: &Path,
) {
    let original = match adapter.asset_inventory(AssetInventoryRequest { game_dir }) {
        Ok(manifest) => manifest,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_preservation_input_error".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "adapter-neutral asset preservation requires the adapter to report an asset inventory for the input"
                            .to_string(),
                    ),
                    expected: Some("asset inventory for input".to_string()),
                    actual: Some("adapter inventory error".to_string()),
                    required_capability: Some(Capability::AssetInventory),
                },
            );
            return;
        }
    };
    let patched = match adapter.asset_inventory(AssetInventoryRequest {
        game_dir: output_dir,
    }) {
        Ok(manifest) => manifest,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_preservation_output_error".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "adapter-neutral asset preservation requires the unchanged-patch output to remain inventoriable"
                            .to_string(),
                    ),
                    expected: Some("asset inventory for patched output".to_string()),
                    actual: Some("adapter inventory error".to_string()),
                    required_capability: Some(Capability::AssetInventory),
                },
            );
            return;
        }
    };

    let original_assets: BTreeMap<&str, &AssetInventoryAsset> = original
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset))
        .collect();
    let patched_assets: BTreeMap<&str, &AssetInventoryAsset> = patched
        .assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset))
        .collect();

    let claims = derive_asset_preservation_claims(&original);
    let mut preserved = 0usize;
    let mut had_failure = false;

    for claim in &claims {
        // Record the capability-aware unsupported-asset diagnostic (typed).
        report.phases.push(GoldenPhaseReport {
            phase: "asset_capability_diagnostic".to_string(),
            status: GoldenAssertionStatus::Skipped,
            details: format!(
                "adapter reports asset surface {} as capability-unsupported ({:?}); underlying asset must be preserved unchanged",
                claim.surface_id, claim.required_capability
            ),
            asset_ref: Some(claim.asset_ref.clone()),
            source_unit_key: None,
            support_boundary: Some(claim.support_boundary.clone()),
            expected: None,
            actual: None,
            required_capability: Some(claim.required_capability.clone()),
        });

        let Some(original_asset) = original_assets.get(claim.asset_id.as_str()) else {
            had_failure = true;
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_missing_in_input".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: format!(
                        "surface {} references asset {} that the input inventory does not list",
                        claim.surface_id, claim.asset_ref
                    ),
                    asset_ref: Some(claim.asset_ref.clone()),
                    source_unit_key: None,
                    support_boundary: Some(claim.support_boundary.clone()),
                    expected: Some("asset present in input inventory".to_string()),
                    actual: Some("asset absent".to_string()),
                    required_capability: Some(claim.required_capability.clone()),
                },
            );
            continue;
        };
        let Some(patched_asset) = patched_assets.get(claim.asset_id.as_str()) else {
            had_failure = true;
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_asset_missing_after_patch".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: format!(
                        "capability-unsupported asset {} disappeared from the inventory after an unchanged patch",
                        claim.asset_ref
                    ),
                    asset_ref: Some(claim.asset_ref.clone()),
                    source_unit_key: None,
                    support_boundary: Some(claim.support_boundary.clone()),
                    expected: Some("asset preserved in patched inventory".to_string()),
                    actual: Some("asset absent after patch".to_string()),
                    required_capability: Some(claim.required_capability.clone()),
                },
            );
            continue;
        };

        let expected_signature = asset_preservation_signature(game_dir, original_asset);
        let actual_signature = asset_preservation_signature(output_dir, patched_asset);
        if expected_signature == actual_signature {
            preserved += 1;
        } else {
            had_failure = true;
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "inventory_unsupported_asset_mutated".to_string(),
                    phase: "inventory_asset_preservation".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: format!(
                        "capability-unsupported asset {} changed after an unchanged patch even though the adapter cannot edit it",
                        claim.asset_ref
                    ),
                    asset_ref: Some(claim.asset_ref.clone()),
                    source_unit_key: None,
                    support_boundary: Some(claim.support_boundary.clone()),
                    expected: Some(expected_signature),
                    actual: Some(actual_signature),
                    required_capability: Some(claim.required_capability.clone()),
                },
            );
        }
    }

    if had_failure {
        return;
    }

    let details = if claims.is_empty() {
        "adapter inventory reports no capability-unsupported assets to preserve".to_string()
    } else {
        format!(
            "{preserved} capability-unsupported asset(s) preserved across the unchanged patch, driven by adapter inventory + capability reports",
        )
    };
    report.phases.push(GoldenPhaseReport {
        phase: "inventory_asset_preservation".to_string(),
        status: GoldenAssertionStatus::Passed,
        details,
        asset_ref: None,
        source_unit_key: None,
        support_boundary: None,
        expected: None,
        actual: None,
        required_capability: None,
    });
}

/// Adapter-neutral preservation signature for a single inventory asset: prefer
/// the on-disk bytes when the asset's declared `path` resolves to a readable
/// file, otherwise fall back to the adapter-reported `source_hash`. Either way
/// the value is sourced from what the adapter itself reports, never from a
/// hard-coded `source.json` assumption.
fn asset_preservation_signature(base_dir: &Path, asset: &AssetInventoryAsset) -> String {
    if let Some(path) = &asset.path
        && let Ok(resolved) = safe_join_relative(base_dir, path)
        && let Ok(bytes) = fs::read(&resolved)
    {
        return format!("bytes:{}", byte_content_hash(&bytes));
    }
    match &asset.source_hash {
        Some(hash) => format!("reportedHash:{hash}"),
        None => format!("noSignature:{}", asset.asset_id),
    }
}

fn report_verify_phase(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    phase: &str,
    game_dir: &Path,
) {
    match adapter.verify(VerifyRequest { game_dir }) {
        Ok(verify) if verify.status == OperationStatus::Passed => report_passed_phase(
            report,
            phase,
            "adapter verification passed",
            Some("source.json"),
        ),
        Ok(verify) => {
            if verify.failures.is_empty() {
                record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "verify_failed_without_detail".to_string(),
                        phase: phase.to_string(),
                        adapter_id: adapter.id().to_string(),
                        message: "adapter verification failed without detailed failures"
                            .to_string(),
                        asset_ref: Some("source.json".to_string()),
                        source_unit_key: None,
                        support_boundary: None,
                        expected: Some("verify status passed".to_string()),
                        actual: Some("verify status failed".to_string()),
                        required_capability: None,
                    },
                );
            } else {
                for failure in verify
                    .failures
                    .iter()
                    .map(AdapterFailure::redacted_for_report)
                {
                    let asset_ref = failure.asset_ref.clone();
                    record_golden_failure(
                        report,
                        GoldenFailure {
                            code: failure.error_code,
                            phase: phase.to_string(),
                            adapter_id: adapter.id().to_string(),
                            message: golden_diagnostic_summary(
                                failure
                                    .remediation
                                    .as_deref()
                                    .unwrap_or(&failure.support_boundary),
                            ),
                            source_unit_key: source_unit_key_from_asset_ref(asset_ref.as_deref()),
                            asset_ref,
                            support_boundary: Some(golden_diagnostic_summary(
                                &failure.support_boundary,
                            )),
                            expected: Some("verify status passed".to_string()),
                            actual: Some("verify status failed".to_string()),
                            required_capability: None,
                        },
                    );
                }
            }
        }
        Err(error) => record_golden_failure(
            report,
            GoldenFailure {
                code: "verify_error".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter.id().to_string(),
                message: golden_error_summary(&error),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: None,
                expected: Some("successful verification".to_string()),
                actual: Some("adapter error".to_string()),
                required_capability: None,
            },
        ),
    }
}

fn report_output_equivalence(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    original_extraction: &ExtractionResult,
    output_dir: &Path,
    phase: &str,
) {
    let patched_extraction = match adapter.extract(ExtractRequest {
        game_dir: output_dir,
    }) {
        Ok(extraction) => extraction,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_equivalence_extract_error".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "output equivalence requires patched output to remain extractable"
                            .to_string(),
                    ),
                    expected: Some("extractable patched output".to_string()),
                    actual: Some("adapter extract error".to_string()),
                    required_capability: None,
                },
            );
            return;
        }
    };

    let expected = unit_signatures(&original_extraction.bridge);
    let actual = unit_signatures(&patched_extraction.bridge);
    if expected == actual {
        report_passed_phase(
            report,
            phase,
            "patched output extracts to the same source unit text and hashes",
            Some("source.json"),
        );
        return;
    }

    for (key, expected_signature) in &expected {
        match actual.get(key) {
            Some(actual_signature) if actual_signature == expected_signature => {}
            Some(_) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_unit_mismatch".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: "patched output changed an extracted source unit".to_string(),
                    asset_ref: Some(format!("source.json#{key}")),
                    source_unit_key: Some(key.clone()),
                    support_boundary: Some(
                        "unchanged patch output equivalence requires source units to extract identically"
                            .to_string(),
                    ),
                    expected: original_extraction
                        .bridge
                        .units
                        .iter()
                        .rev()
                        .find(|unit| unit.source_unit_key == *key)
                        .map(unit_signature_summary),
                    actual: patched_extraction
                        .bridge
                        .units
                        .iter()
                        .rev()
                        .find(|unit| unit.source_unit_key == *key)
                        .map(unit_signature_summary),
                                    required_capability: None,
},
            ),
            None => record_golden_failure(
                report,
                GoldenFailure {
                    code: "output_unit_missing".to_string(),
                    phase: phase.to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: "patched output is missing an extracted source unit".to_string(),
                    asset_ref: Some(format!("source.json#{key}")),
                    source_unit_key: Some(key.clone()),
                    support_boundary: Some(
                        "unchanged patch output equivalence requires all source units to remain present"
                            .to_string(),
                    ),
                    expected: original_extraction
                        .bridge
                        .units
                        .iter()
                        .rev()
                        .find(|unit| unit.source_unit_key == *key)
                        .map(unit_signature_summary),
                    actual: None,
                                    required_capability: None,
},
            ),
        }
    }

    for key in actual.keys().filter(|key| !expected.contains_key(*key)) {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "output_unit_unexpected".to_string(),
                phase: phase.to_string(),
                adapter_id: adapter.id().to_string(),
                message: "patched output contains an unexpected extracted source unit".to_string(),
                asset_ref: Some(format!("source.json#{key}")),
                source_unit_key: Some(key.clone()),
                support_boundary: Some(
                    "unchanged patch output equivalence requires no extra source units".to_string(),
                ),
                expected: None,
                actual: patched_extraction
                    .bridge
                    .units
                    .iter()
                    .rev()
                    .find(|unit| unit.source_unit_key == *key)
                    .map(unit_signature_summary),
                required_capability: None,
            },
        );
    }
}

fn unit_signatures(bridge: &BridgeBundle) -> BTreeMap<String, String> {
    bridge
        .units
        .iter()
        .map(|unit| {
            (
                unit.source_unit_key.clone(),
                format!("{}:{}", unit.source_hash, unit.source_text),
            )
        })
        .collect()
}

fn unit_signature_summary(unit: &BridgeUnit) -> String {
    format!(
        "sourceHash={}; sourceText={}",
        unit.source_hash,
        RedactedContentSummary::from_text(&unit.source_text)
    )
}

fn report_translated_patch(
    adapter: &dyn EngineAdapter,
    report: &mut GoldenRoundTripReport,
    extraction: &ExtractionResult,
    game_dir: &Path,
    work_dir: &Path,
    patch_export_value: &Value,
    translated_source_bridge: Option<&Value>,
) -> KaifuuResult<()> {
    if patch_export_value["schemaVersion"].as_str() == Some(BRIDGE_SCHEMA_VERSION_V02) {
        match contracts::validate_patch_export_v02(patch_export_value) {
            Ok(()) => report_passed_phase(
                report,
                "translated_patch_contract",
                "translated v0.2 patch export passed contract validation",
                None,
            ),
            Err(error) => {
                record_golden_failure(
                    report,
                    GoldenFailure {
                        code: "translated_patch_contract_invalid".to_string(),
                        phase: "translated_patch_contract".to_string(),
                        adapter_id: adapter.id().to_string(),
                        message: golden_error_summary(&error),
                        asset_ref: None,
                        source_unit_key: None,
                        support_boundary: Some(
                            "translated public fixture patches must satisfy PatchExportV02"
                                .to_string(),
                        ),
                        expected: Some("valid PatchExportV02".to_string()),
                        actual: Some("invalid patch export".to_string()),
                        required_capability: None,
                    },
                );
                return Ok(());
            }
        }
        report_v02_source_compatibility(
            report,
            adapter.id(),
            &extraction.bridge,
            patch_export_value,
            translated_source_bridge,
        );
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_source_compatibility")
    {
        return Ok(());
    }

    let patch_export = match patch_export_for_adapter(patch_export_value, &extraction.bridge) {
        Ok(patch_export) => patch_export,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_patch_conversion_failed".to_string(),
                    phase: "translated_patch_conversion".to_string(),
                    adapter_id: adapter.id().to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated patch conversion requires every sourceUnitKey to exist in the current extraction"
                            .to_string(),
                    ),
                    expected: Some("convertible patch export".to_string()),
                    actual: Some("conversion error".to_string()),
                                    required_capability: None,
},
            );
            return Ok(());
        }
    };

    report_passed_phase(
        report,
        "translated_patch_conversion",
        "translated patch export converted to the adapter patch contract",
        None,
    );

    let Some(output_dir) = run_golden_patch_phase(GoldenPatchPhaseArgs {
        adapter,
        report,
        phase: "translated_patch",
        game_dir,
        work_dir,
        work_child: "translated-patch",
        patch_export: &patch_export,
        success_details: "translated patch applied successfully",
        patch_error_code: "translated_patch_error",
        patch_expected: "successful translated patch",
    })?
    else {
        return Ok(());
    };

    report_translated_target_equivalence(report, adapter.id(), &patch_export, &output_dir);
    report_verify_phase(adapter, report, "translated_verify", &output_dir);
    Ok(())
}

fn report_v02_source_compatibility(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    native_bridge: &BridgeBundle,
    patch_export: &Value,
    source_bridge: Option<&Value>,
) {
    let (bridge_units, source_description) = match source_bridge {
        Some(source_bridge) => (v02_bridge_units_by_key(source_bridge), "source bridge"),
        None => (
            Ok(v02_native_units_by_key(native_bridge)),
            "native adapter extraction",
        ),
    };
    let bridge_units = match bridge_units {
        Ok(units) => units,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_bridge_invalid".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: None,
                    source_unit_key: None,
                    support_boundary: Some(
                        "v0.2 source compatibility requires source units keyed by sourceUnitKey"
                            .to_string(),
                    ),
                    expected: Some("valid source units".to_string()),
                    actual: Some(format!("invalid {source_description}")),
                    required_capability: None,
                },
            );
            return;
        }
    };

    let Some(entries) = patch_export["entries"].as_array() else {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "translated_patch_entries_missing".to_string(),
                phase: "translated_source_compatibility".to_string(),
                adapter_id: adapter_id.to_string(),
                message: "translated patch export is missing entries".to_string(),
                asset_ref: None,
                source_unit_key: None,
                support_boundary: None,
                expected: Some("entries array".to_string()),
                actual: None,
                required_capability: None,
            },
        );
        return;
    };

    let mut compatible = 0_usize;
    for entry in entries {
        let source_unit_key = entry["sourceUnitKey"].as_str().unwrap_or("");
        let bridge_unit_id = entry["bridgeUnitId"].as_str().unwrap_or("");
        let source_hash = entry["sourceHash"].as_str().unwrap_or("");
        let Some(unit) = bridge_units.get(source_unit_key) else {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_unit_missing".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message:
                        "translated patch references a source unit absent from the source bridge"
                            .to_string(),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch sourceUnitKey values must exist in the checked source units"
                            .to_string(),
                    ),
                    expected: Some("source unit".to_string()),
                    actual: None,
                    required_capability: None,
                },
            );
            continue;
        };

        if unit
            .bridge_unit_id
            .as_deref()
            .is_some_and(|expected_bridge_unit_id| expected_bridge_unit_id != bridge_unit_id)
        {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_bridge_unit_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch bridgeUnitId does not match the source bridge"
                        .to_string(),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch entries must reference the source bridge unit they were exported from"
                            .to_string(),
                    ),
                    expected: unit.bridge_unit_id.clone(),
                    actual: Some(bridge_unit_id.to_string()),
                                    required_capability: None,
},
            );
            continue;
        }

        if unit.source_hash != source_hash {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_source_hash_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: format!(
                        "translated patch sourceHash does not match the {source_description}"
                    ),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch sourceHash must match the checked source before adapter-specific hash translation"
                            .to_string(),
                    ),
                    expected: Some(unit.source_hash.clone()),
                    actual: Some(source_hash.to_string()),
                                    required_capability: None,
},
            );
            continue;
        }

        if !v02_patch_entry_span_mappings_compatible(entry, unit) {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_protected_span_mapping_mismatch".to_string(),
                    phase: "translated_source_compatibility".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message:
                        "translated patch protectedSpanMappings do not match source bridge spans"
                            .to_string(),
                    asset_ref: Some(unit.asset_ref.clone()),
                    source_unit_key: Some(source_unit_key.to_string()),
                    support_boundary: Some(
                        "translated patch mappings must preserve protected spans with valid source identity"
                            .to_string(),
                    ),
                    expected: Some(
                        "protectedSpanMappings compatible with source bridge".to_string(),
                    ),
                    actual: Some("protected span mapping mismatch".to_string()),
                                    required_capability: None,
},
            );
            continue;
        }

        compatible += 1;
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_source_compatibility")
    {
        return;
    }

    report_passed_phase(
        report,
        "translated_source_compatibility",
        format!(
            "validated {compatible} translated patch source unit(s) against the {source_description}"
        ),
        None,
    );
}

#[derive(Debug, Clone)]
struct V02BridgeUnitSummary {
    bridge_unit_id: Option<String>,
    source_hash: String,
    asset_ref: String,
    spans: Vec<V02SourceSpanSummary>,
}

#[derive(Debug, Clone)]
struct V02SourceSpanSummary {
    span_id: Option<String>,
    raw: String,
    start_byte: u64,
    end_byte: u64,
}

fn v02_bridge_units_by_key(
    source_bridge: &Value,
) -> KaifuuResult<BTreeMap<String, V02BridgeUnitSummary>> {
    let bridge = BridgeBundleV02::validate_json(source_bridge)?;
    let mut units_by_key = BTreeMap::new();
    for unit in bridge.units {
        let key = unit.source_unit_key.clone();
        let asset_ref = unit
            .source_asset_ref
            .asset_key
            .clone()
            .unwrap_or_else(|| unit.source_asset_ref.asset_id.clone());
        units_by_key.insert(
            key.clone(),
            V02BridgeUnitSummary {
                bridge_unit_id: Some(unit.bridge_unit_id),
                source_hash: unit.source_hash,
                asset_ref: format!("{asset_ref}#{key}"),
                spans: unit
                    .spans
                    .into_iter()
                    .map(|span| V02SourceSpanSummary {
                        span_id: Some(span.span_id),
                        raw: span.raw,
                        start_byte: span.start_byte,
                        end_byte: span.end_byte,
                    })
                    .collect(),
            },
        );
    }
    Ok(units_by_key)
}

/// Recompute the canonical v0.2 source hash from the text emitted by a native
/// adapter. This is the same `sha256:` UTF-8 source-text representation native
/// v0.2 bridge producers place in `LocalizationUnitV02.sourceHash`.
fn canonical_v02_native_source_hash(source_text: &str) -> String {
    sha256_hash_bytes(source_text.as_bytes())
}

fn v02_native_units_by_key(bridge: &BridgeBundle) -> BTreeMap<String, V02BridgeUnitSummary> {
    let mut units_by_key = BTreeMap::new();
    for unit in &bridge.units {
        let key = unit.source_unit_key.clone();
        units_by_key.insert(
            key.clone(),
            V02BridgeUnitSummary {
                // A native v0.1 adapter may use a local bridge-unit id scheme.
                // The sourceUnitKey + canonical source hash are the stable v0.2
                // compatibility identity; patch conversion later remaps to the
                // fresh native bridge-unit id used by that adapter.
                bridge_unit_id: None,
                source_hash: canonical_v02_native_source_hash(&unit.source_text),
                asset_ref: format!("{}#{key}", unit.patch_ref.asset_id),
                spans: unit
                    .protected_spans
                    .iter()
                    .map(|span| V02SourceSpanSummary {
                        span_id: span.span_id.clone(),
                        raw: span.raw.clone(),
                        start_byte: span.start,
                        end_byte: span.end,
                    })
                    .collect(),
            },
        );
    }
    units_by_key
}

fn v02_patch_entry_span_mappings_compatible(entry: &Value, unit: &V02BridgeUnitSummary) -> bool {
    let Some(target_text) = entry["targetText"].as_str() else {
        return false;
    };
    let Ok(mappings) =
        serde_json::from_value::<Vec<ProtectedSpanMapping>>(entry["protectedSpanMappings"].clone())
    else {
        return false;
    };

    let mut required_spans = BTreeMap::<&str, Vec<&V02SourceSpanSummary>>::new();
    for span in &unit.spans {
        required_spans
            .entry(span.raw.as_str())
            .or_default()
            .push(span);
    }

    let mut target_ranges_by_raw = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
    let mut matched_source_identities = BTreeSet::<String>::new();
    for mapping in &mappings {
        if !mapping.matches_target_text(target_text) {
            return false;
        }

        // Fail closed: a mapping whose `raw` has no corresponding source
        // span is bogus. The final coverage loop only checks that required
        // source spans are covered, so accepting an extra mapping here would
        // let a patch carrying spans that reference non-existent source spans
        // pass the compatibility gate.
        let Some(source_spans) = required_spans.get(mapping.raw.as_str()) else {
            return false;
        };

        let duplicate_raw = source_spans.len() > 1;
        if duplicate_raw && !mapping.has_source_identity() {
            return false;
        }

        if mapping.has_source_identity() {
            let Some(source_span) = source_spans.iter().find(|source_span| {
                mapping.matches_source_span(
                    &source_span.raw,
                    Some(source_span.start_byte),
                    Some(source_span.end_byte),
                    source_span.span_id.as_deref(),
                )
            }) else {
                return false;
            };
            let Some(span_id) = source_span.span_id.as_deref() else {
                return false;
            };
            let source_identity_key = format!(
                "{}:{}:{}",
                span_id, source_span.start_byte, source_span.end_byte
            );
            if !matched_source_identities.insert(source_identity_key) {
                return false;
            }
        }

        target_ranges_by_raw
            .entry(mapping.raw.as_str())
            .or_default()
            .insert((mapping.target_start, mapping.target_end));
    }

    for (raw, source_spans) in required_spans {
        if target_ranges_by_raw.get(raw).map_or(0, BTreeSet::len) < source_spans.len() {
            return false;
        }
    }

    true
}

fn patch_export_for_adapter(value: &Value, bridge: &BridgeBundle) -> KaifuuResult<PatchExport> {
    if value["schemaVersion"].as_str() != Some(BRIDGE_SCHEMA_VERSION_V02) {
        return PatchExport::from_value(value);
    }

    let units_by_key = bridge
        .units
        .iter()
        .map(|unit| (unit.source_unit_key.as_str(), unit))
        .collect::<BTreeMap<_, _>>();
    let entries = value["entries"]
        .as_array()
        .ok_or("translated patch export missing entries")?
        .iter()
        .map(|entry| {
            let source_unit_key = require_str(entry, "sourceUnitKey")?;
            let source_unit = units_by_key.get(source_unit_key).ok_or_else(|| {
                format!(
                    "translated patch entry {source_unit_key} is missing from current extraction"
                )
            })?;
            Ok(PatchExportEntry {
                bridge_unit_id: source_unit.bridge_unit_id.clone(),
                source_unit_key: source_unit_key.to_string(),
                source_hash: source_unit.source_hash.clone(),
                target_text: require_str(entry, "targetText")?.to_string(),
                protected_span_mappings: serde_json::from_value(
                    entry["protectedSpanMappings"].clone(),
                )?,
            })
        })
        .collect::<KaifuuResult<Vec<_>>>()?;

    Ok(PatchExport {
        patch_export_id: require_str(value, "patchExportId")?.to_string(),
        source_locale: require_str(value, "sourceLocale")?.to_string(),
        target_locale: require_str(value, "targetLocale")?.to_string(),
        entries,
    })
}

fn report_translated_target_equivalence(
    report: &mut GoldenRoundTripReport,
    adapter_id: &str,
    patch_export: &PatchExport,
    output_dir: &Path,
) {
    let output_path = output_dir.join("source.json");
    let source: Value = match read_json(&output_path) {
        Ok(source) => source,
        Err(error) => {
            record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_read_error".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: golden_error_summary(&error),
                    asset_ref: Some("source.json".to_string()),
                    source_unit_key: None,
                    support_boundary: Some(
                        "translated target equivalence requires fixture JSON output with targetText fields"
                            .to_string(),
                    ),
                    expected: Some("readable patched source.json".to_string()),
                    actual: Some("read error".to_string()),
                                    required_capability: None,
},
            );
            return;
        }
    };

    let Some(units) = source["units"].as_array() else {
        record_golden_failure(
            report,
            GoldenFailure {
                code: "translated_target_units_missing".to_string(),
                phase: "translated_target_equivalence".to_string(),
                adapter_id: adapter_id.to_string(),
                message: "translated patch output is missing a units array".to_string(),
                asset_ref: Some("source.json".to_string()),
                source_unit_key: None,
                support_boundary: Some(
                    "translated target equivalence requires fixture JSON output with units"
                        .to_string(),
                ),
                expected: Some("units array".to_string()),
                actual: None,
                required_capability: None,
            },
        );
        return;
    };

    let targets_by_key = units
        .iter()
        .filter_map(|unit| {
            Some((
                unit["sourceUnitKey"].as_str()?.to_string(),
                unit["targetText"].as_str().map(str::to_string),
            ))
        })
        .collect::<BTreeMap<_, _>>();

    let mut matched = 0_usize;
    for entry in &patch_export.entries {
        match targets_by_key.get(&entry.source_unit_key) {
            Some(Some(actual)) if actual == &entry.target_text => {
                matched += 1;
            }
            Some(Some(actual)) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_text_mismatch".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output targetText does not match the patch export"
                        .to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires each targetText to be written exactly"
                            .to_string(),
                    ),
                    expected: Some(
                        RedactedContentSummary::from_text(&entry.target_text).to_string(),
                    ),
                    actual: Some(RedactedContentSummary::from_text(actual).to_string()),
                                    required_capability: None,
},
            ),
            Some(None) => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_text_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output unit is missing targetText".to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires each patched unit to contain targetText"
                            .to_string(),
                    ),
                    expected: Some(
                        RedactedContentSummary::from_text(&entry.target_text).to_string(),
                    ),
                    actual: None,
                                    required_capability: None,
},
            ),
            None => record_golden_failure(
                report,
                GoldenFailure {
                    code: "translated_target_unit_missing".to_string(),
                    phase: "translated_target_equivalence".to_string(),
                    adapter_id: adapter_id.to_string(),
                    message: "translated patch output is missing a patched source unit".to_string(),
                    asset_ref: Some(format!("source.json#{}", entry.source_unit_key)),
                    source_unit_key: Some(entry.source_unit_key.clone()),
                    support_boundary: Some(
                        "translated patch target equivalence requires every patch entry sourceUnitKey to be present"
                            .to_string(),
                    ),
                    expected: Some(
                        RedactedContentSummary::from_text(&entry.target_text).to_string(),
                    ),
                    actual: None,
                                    required_capability: None,
},
            ),
        }
    }

    if report
        .failures
        .iter()
        .any(|failure| failure.phase == "translated_target_equivalence")
    {
        return;
    }

    report_passed_phase(
        report,
        "translated_target_equivalence",
        format!("verified {matched} translated targetText value(s) in source.json"),
        Some("source.json"),
    );
}

fn source_unit_key_from_asset_ref(asset_ref: Option<&str>) -> Option<String> {
    let (_, source_unit_key) = asset_ref?.split_once('#')?;
    (!source_unit_key.is_empty()).then(|| source_unit_key.to_string())
}

fn finalize_golden_report(mut report: GoldenRoundTripReport) -> GoldenRoundTripReport {
    report.status = if report.failures.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    report
}

pub fn require_str<'a>(value: &'a Value, key: &str) -> KaifuuResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing string field {key}").into())
}

pub fn require_u64(value: &Value, key: &str) -> KaifuuResult<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("missing u64 field {key}").into())
}

#[cfg(test)]
mod tests;
