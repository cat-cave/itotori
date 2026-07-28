pub mod secret_holder;
mod semantics;

mod hashing;

mod rpgmaker_key_material;

mod partial_adapter_report;

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

mod xp3_real_bytes_roundtrip;

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

// The crate facade preserves the historical flat public API while the implementation lives in domain modules.
mod adapter_core;

mod adapter_capabilities;

mod layered_access_model;

mod archive_detection_model;

mod archive_detection_signals;

mod rpgmaker_suffixes;

mod rpgmaker_key_validation;

mod archive_detection_rows;

mod engine_profile;

mod helper_profiles;

mod xp3_profile_model;

mod xp3_profile_proof;

mod xp3_profile_proof_support;

mod encrypted_media_model;

mod encrypted_media_support;

mod key_declarations;

mod secret_stores;

mod key_resolver;

mod secret_redaction_validation;

mod secret_redaction_reporting;

mod profile_requirements;

mod asset_inventory_manifest;

mod asset_inventory_model;

mod bridge_model;

mod bridge_v02_model;

mod bridge_v02_context;

mod bridge_v02_validation;

mod patch_report_model;

mod asset_patch_capability;

mod operation_result_model;

mod layered_access_preflight;

mod layered_access_transforms;

mod adapter_failures;

mod report_redaction;

mod redacted_content_summary;

mod plain_xp3_writer_model;

mod plain_xp3_reader;

mod plain_xp3_directory;

mod json_io;

mod golden_harness_run;

mod golden_harness_report;

mod golden_harness_output;

mod golden_harness_v02;

mod golden_harness_translation;

#[path = "lib/helper_contracts.rs"]
mod helper_contracts;
#[path = "lib/profile_validation.rs"]
mod profile_validation;

#[path = "lib/semantic_error.rs"]
mod semantic_error;

#[path = "lib/fs_safety.rs"]
mod fs_safety;

#[cfg(test)]
mod tests;
include!("lib_parts/001.rs");
include!("lib_parts/002.rs");
include!("lib_parts/003.rs");
