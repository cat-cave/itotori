pub const PROFILE_SCHEMA_VERSION: &str = "0.1.0";
pub const HELPER_RESULT_SCHEMA_VERSION: &str = "0.1.0";
pub const HELPER_REGISTRY_SCHEMA_VERSION: &str = "0.1.0";
pub const HELPER_REGISTRY_INPUT_SCHEMA_FIXTURE_REQUEST: &str = "kaifuu.helper.fixture-request.v0.1";
pub const HELPER_REGISTRY_OUTPUT_SCHEMA_HELPER_RESULT: &str = "kaifuu.helper-result.v0.1";
pub const SIGLUS_PARSER_BOUNDARY_SCHEMA_VERSION: &str = "0.1.0";
pub const ASSET_INVENTORY_SCHEMA_VERSION: &str = "0.1.0";
pub const ARCHIVE_DETECTION_SCHEMA_VERSION: &str = "0.1.0";
pub const REDACTED_DETECTION_GAME_DIR: &str = "[redacted-local-game-dir]";

pub const BRIDGE_SCHEMA_VERSION_V02: &str = "0.2.0";

/// Shared cross-language semantic code emitted when a contract field is not a
/// valid RFC3339 date-time instant. The TypeScript contract validator emits the
/// identical code (`RFC3339_INSTANT_MALFORMED_CODE` in
/// `packages/localization-bridge-schema/src/index.ts`). See
/// `docs/contracts/rfc3339-instant-acceptance.md`.
pub const SEMANTIC_RFC3339_INSTANT_MALFORMED: &str = "itotori.contract.rfc3339_instant_malformed";

pub const SEMANTIC_MISSING_KEY_PROFILE: &str = "kaifuu.missing_capability.key_profile";
pub const SEMANTIC_MISSING_KEY_MATERIAL: &str = "kaifuu.missing_key_material";
pub const SEMANTIC_HELPER_UNAVAILABLE: &str = "kaifuu.helper_unavailable";
pub const SEMANTIC_HELPER_AUTHORIZATION_DENIED: &str = "kaifuu.helper_authorization_denied";
pub const SEMANTIC_HELPER_TIMEOUT: &str = "kaifuu.helper_timeout";
pub const SEMANTIC_HELPER_CANCELLED: &str = "kaifuu.helper_cancelled";
pub const SEMANTIC_HELPER_EXIT_FAILURE: &str = "kaifuu.helper_exit_failure";
pub const SEMANTIC_HELPER_IO_FAILURE: &str = "kaifuu.helper_io_failure";
pub const SEMANTIC_HELPER_OUTPUT_OVERFLOW: &str = "kaifuu.helper_output_overflow";
pub const SEMANTIC_KEY_VALIDATION_FAILED: &str = "kaifuu.key_validation_failed";
pub const SEMANTIC_SECRET_REDACTED: &str = "kaifuu.secret_redacted";
pub const SEMANTIC_HELPER_REQUIRED: &str = "kaifuu.helper_required";
pub const SEMANTIC_HELPER_REDACTION_FAILURE: &str = "kaifuu.helper_redaction_failure";
pub const SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY: &str =
    "kaifuu.helper_registry.missing_capability";
pub const SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID: &str =
    "kaifuu.helper_registry.unsupported_schema_id";
pub const SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA: &str =
    "kaifuu.helper_registry.incompatible_output_schema";
pub const SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS: &str =
    "kaifuu.helper_registry.invalid_redaction_class";
pub const SEMANTIC_HELPER_EXECUTION_DISALLOWED: &str = "kaifuu.helper_execution_policy.disallowed";
pub const SEMANTIC_HELPER_REGISTRY_FORBIDDEN_EXECUTION_FIELD: &str =
    "kaifuu.helper_registry.forbidden_execution_field";
pub const SEMANTIC_HELPER_PROFILE_FORBIDDEN_EXECUTION_FIELD: &str =
    "kaifuu.helper_profile.forbidden_execution_field";
pub const SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE: &str = "kaifuu.key_import.wrong_engine_profile";
pub const SEMANTIC_KEY_IMPORT_WRONG_KEY_PURPOSE: &str = "kaifuu.key_import.wrong_key_purpose";
pub const SEMANTIC_KEY_IMPORT_HASH_MISMATCH: &str = "kaifuu.key_import.hash_mismatch";
pub const SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION: &str = "kaifuu.forbidden_public_serialization";
pub const SEMANTIC_HELPER_REQUEST_WRONG_HELPER: &str = "kaifuu.helper_request.wrong_helper";
pub const SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION: &str =
    "kaifuu.helper_request.missing_redacted_output_expectation";
pub const SEMANTIC_HELPER_REQUEST_REDACTED_OUTPUT_MISMATCH: &str =
    "kaifuu.helper_request.redacted_output_mismatch";
pub const SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY: &str = "kaifuu.helper_allowlist.missing_entry";
pub const SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY: &str = "kaifuu.helper_allowlist.missing_binary";
pub const SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH: &str = "kaifuu.helper_allowlist.hash_mismatch";
pub const SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM: &str = "kaifuu.helper_allowlist.wrong_platform";
pub const SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION: &str = "kaifuu.helper_allowlist.stale_version";
pub const SEMANTIC_HELPER_ALLOWLIST_EXECUTABLE_NAME_MISMATCH: &str =
    "kaifuu.helper_allowlist.executable_name_mismatch";
pub const SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY: &str =
    "kaifuu.helper_allowlist.undeclared_capability";
/// The trusted-staging copy could not be materialized (source symlink, staging
/// symlink squat, unreadable source, or an unsupported non-Unix platform), so
/// the validated bytes could not be bound to execution. Fail closed rather than
/// hashing-then-launching the mutable source path (hash-to-exec
/// TOCTOU).
pub const SEMANTIC_HELPER_ALLOWLIST_STAGING_FAILED: &str = "kaifuu.helper_allowlist.staging_failed";
pub const SEMANTIC_MALFORMED_SECRET_REF: &str = "kaifuu.malformed_secret_ref";
pub const SEMANTIC_SECRET_REF_OUT_OF_POLICY: &str = "kaifuu.secret_ref_out_of_policy";
pub const SEMANTIC_EXTERNAL_SECRET_UNAVAILABLE: &str = "kaifuu.external_secret_unavailable";
pub const SEMANTIC_PROMPT_CANCELLED: &str = "kaifuu.prompt_cancelled";
pub const SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED: &str =
    "kaifuu.protected_executable_unsupported";
pub const SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM: &str = "kaifuu.unsupported_layered_transform";
pub const SEMANTIC_MISSING_CONTAINER_CAPABILITY: &str = "kaifuu.missing_capability.container";
pub const SEMANTIC_MISSING_CRYPTO_CAPABILITY: &str = "kaifuu.missing_capability.crypto";
pub const SEMANTIC_MISSING_CODEC_CAPABILITY: &str = "kaifuu.missing_capability.codec";
pub const SEMANTIC_MISSING_PATCH_BACK_CAPABILITY: &str = "kaifuu.missing_capability.patch_back";
pub const SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED: &str = "kaifuu.unsupported_variant.encrypted";
pub const SEMANTIC_UNSUPPORTED_VARIANT_PACKED: &str = "kaifuu.unsupported_variant.packed";
pub const SEMANTIC_UNKNOWN_ENGINE_VARIANT: &str = "kaifuu.unknown_engine_variant";
pub const SEMANTIC_AMBIGUOUS_ENGINE_VARIANT: &str = "kaifuu.ambiguous_engine_variant";
pub const SEMANTIC_UNSUPPORTED_ENGINE_VARIANT: &str = "kaifuu.unsupported_engine_variant";
pub const SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE: &str = "kaifuu.siglus.unsupported_opcode";
pub const SEMANTIC_PATCH_RESULT_MISSING_FAILURE_CATEGORY: &str =
    "kaifuu.patch_result.missing_failure_category";
pub const SEMANTIC_PATCH_RESULT_UNKNOWN_FAILURE_CATEGORY: &str =
    "kaifuu.patch_result.unknown_failure_category";
pub const SEMANTIC_PATCH_RESULT_MISMATCHED_EXPORT_ID: &str =
    "kaifuu.patch_result.mismatched_export_id";
pub const SEMANTIC_PATCH_RESULT_OUTPUT_HASH_DRIFT: &str = "kaifuu.patch_result.output_hash_drift";
pub const SEMANTIC_PATCH_RESULT_SOURCE_INCOMPATIBLE: &str =
    "kaifuu.patch_result.source_incompatible";
pub const SEMANTIC_PATCH_RESULT_SILENT_PARTIAL_WRITE: &str =
    "kaifuu.patch_result.silent_partial_write";
pub const SEMANTIC_PATCH_RESULT_PASSED_REQUIRES_OUTPUT_HASH: &str =
    "kaifuu.patch_result.passed_requires_output_hash";
pub const SEMANTIC_PATCH_RESULT_PASSED_REQUIRES_TOUCHED_ASSETS: &str =
    "kaifuu.patch_result.passed_requires_touched_assets";
pub const SEMANTIC_PATCH_RESULT_PASSED_MUST_HAVE_NO_FAILURES: &str =
    "kaifuu.patch_result.passed_must_have_no_failures";
pub const SEMANTIC_PATCH_RESULT_PASSED_MUST_OMIT_FAILURE_CATEGORIES: &str =
    "kaifuu.patch_result.passed_must_omit_failure_categories";
pub const SEMANTIC_PATCH_RESULT_PASSED_MUST_OMIT_PARTIAL_WRITE: &str =
    "kaifuu.patch_result.passed_must_omit_partial_write";
pub const SEMANTIC_PATCH_RESULT_NON_PASSED_REQUIRES_FAILURES: &str =
    "kaifuu.patch_result.non_passed_requires_failures";
pub const SEMANTIC_PATCH_RESULT_INCOMPATIBLE_SOURCE_CATEGORY_REQUIRED: &str =
    "kaifuu.patch_result.incompatible_source_category_required";
pub const SEMANTIC_PATCH_RESULT_ROLLBACK_DIAGNOSTIC_REQUIRED: &str =
    "kaifuu.patch_result.rollback_diagnostic_required";
pub const SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED: &str =
    "kaifuu.patch_transaction.byte_budget_exceeded";
pub const SEMANTIC_PATCH_TRANSACTION_SOURCE_MISSING: &str =
    "kaifuu.patch_transaction.source_missing";
pub const SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED: &str =
    "kaifuu.patch_transaction.relocation_unsupported";
pub const SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED: &str =
    "kaifuu.patch_transaction.expected_output_hash_malformed";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED: &str =
    "kaifuu.patch_transaction.staged_write_failed";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION: &str =
    "kaifuu.patch_transaction.staged_collision";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_READ_FAILED: &str =
    "kaifuu.patch_transaction.staged_read_failed";
pub const SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED: &str =
    "kaifuu.patch_transaction.promote_failed";
pub const SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK: &str =
    "kaifuu.patch_transaction.staged_verify_rolled_back";
pub const SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK: &str =
    "kaifuu.patch_transaction.promote_rolled_back";
pub const SEMANTIC_PATCH_TRANSACTION_CANCELLED: &str = "kaifuu.patch_transaction.cancelled";
pub const STRING_SLOT_OVERFLOW: &str = "kaifuu.string_slot.overflow";
pub const STRING_SLOT_INVALID_ENCODING: &str = "kaifuu.string_slot.invalid_encoding";
pub const STRING_SLOT_TERMINATOR_LOSS: &str = "kaifuu.string_slot.terminator_loss";
pub const STRING_SLOT_PROTECTED_SPAN_MUTATION: &str = "kaifuu.string_slot.protected_span_mutation";
pub const STRING_RELOCATION_UNRESOLVED_REFERENCE: &str =
    "kaifuu.string_relocation.unresolved_reference";
pub const STRING_RELOCATION_OVERLAPPING_WRITES: &str =
    "kaifuu.string_relocation.overlapping_writes";
pub const STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT: &str =
    "kaifuu.string_relocation.unsupported_pointer_format";
pub const STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH: &str =
    "kaifuu.string_relocation.pointer_provenance_mismatch";
/// The fixture `sourceBytesHex` could not be parsed as hexadecimal. Kept
/// distinct from a *genuinely empty* source (which is parsed successfully
/// to a zero-length byte vector and still bounds-checked) so a parse
/// failure never collapses to `source_len = 0` and silently disables slot
/// bounds validation.
pub const STRING_RELOCATION_INVALID_SOURCE_BYTES: &str =
    "kaifuu.string_relocation.invalid_source_bytes";
