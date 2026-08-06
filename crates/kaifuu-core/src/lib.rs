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

#[path = "lib/facade.rs"]
mod facade;
pub use facade::*;

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

mod whole_channel_guard;
pub use whole_channel_guard::*;

mod operator_diagnostic_redaction;
pub use operator_diagnostic_redaction::*;

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

mod bridge_v02_produce;
pub use bridge_v02_produce::*;
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

#[path = "lib/encrypted_media_proof.rs"]
mod encrypted_media_proof;
pub use encrypted_media_proof::encrypted_media_proof;

#[path = "lib/encrypted_media_finalize.rs"]
mod encrypted_media_finalize;
use encrypted_media_finalize::{
    EncryptedMediaReportFinalizeInput, finalize_encrypted_media_report,
};

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
