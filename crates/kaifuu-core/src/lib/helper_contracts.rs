use super::*;

#[path = "helper_contracts/binary_launch.rs"]
mod binary_launch;
#[path = "helper_contracts/binary_staging.rs"]
mod binary_staging;
#[path = "helper_contracts/binary_types.rs"]
mod binary_types;
#[path = "helper_contracts/fixture_adapter.rs"]
mod fixture_adapter;
#[path = "helper_contracts/registry_fields.rs"]
mod registry_fields;
#[path = "helper_contracts/registry_request.rs"]
mod registry_request;
#[path = "helper_contracts/registry_validation.rs"]
mod registry_validation;
#[path = "helper_contracts/result_contract.rs"]
mod result_contract;
#[path = "helper_contracts/result_fields.rs"]
mod result_fields;
#[path = "helper_contracts/result_redaction.rs"]
mod result_redaction;
#[path = "helper_contracts/result_semantics.rs"]
mod result_semantics;

pub use binary_launch::HelperRegistry;
pub use binary_types::{
    HelperBinaryAllowlist, HelperBinaryAllowlistEntry, HelperBinaryLaunchDiagnostic,
    HelperBinaryLaunchOutcome, HelperBinaryLaunchValidationRequest,
    HelperBinaryLaunchValidationResult, HelperBinarySignatureMetadata, HelperBinaryStagingError,
    HelperRegistryDiagnostic, HelperRegistryInvocationRequest, HelperRegistryValidationResult,
    StagedHelperBinary, stage_and_verify_helper_binary,
};
pub use fixture_adapter::{
    AdapterHelperRequirementDeclaration, FIXTURE_HELPER_ALLOWLIST_REF_ID,
    FIXTURE_HELPER_REGISTRY_ID, fixture_helper_registry,
};
pub use registry_fields::parse_helper_capability;
pub use registry_request::{
    HelperCapability, HelperExecutionMode, HelperExecutionPolicy, HelperFilesystemAccess,
    HelperRedactionClass, HelperRegistryEntry, validate_helper_key_ref_request,
};
pub use registry_validation::validate_helper_registry_entry_value;
pub use result_contract::{
    HelperResultValidationFailure, HelperResultValidationResult, normalize_helper_result_value,
    validate_helper_result_value,
};

pub(crate) use binary_launch::HelperExecutableAdapter;
pub(crate) use binary_staging::stage_helper_binary_no_follow;
pub(crate) use binary_types::staged_helper_binary_name;
#[cfg(test)]
pub(crate) use fixture_adapter::FixtureHelperStubAdapter;

use binary_launch::stage_and_validate_helper_binary_launch;
use binary_types::redact_helper_hash;
use registry_fields::{
    helper_capability_name, helper_registry_failure, helper_registry_validation_result,
    required_helper_registry_string, validate_helper_registry_allowed_object_keys,
    validate_helper_registry_binary_capabilities, validate_helper_registry_binary_signature,
    validate_helper_registry_enum_string, validate_helper_registry_forbidden_execution_fields,
    validate_helper_registry_identifier, validate_helper_registry_invocation,
    validate_helper_registry_output,
};
use registry_request::validate_helper_registry_request_binding;
use result_contract::validate_helper_result_allowed_object_keys;
use result_fields::{
    helper_result_failure, required_helper_result_string, validate_helper_result_bounded_u32,
    validate_helper_result_enum_string, validate_helper_result_identifier,
    validate_helper_result_key_validation_proof, validate_helper_result_optional_positive_u32,
    validate_helper_result_proof_hash_string, validate_helper_result_safe_text,
    validate_public_fixture_label,
};
use result_redaction::{
    validate_helper_result_diagnostic, validate_helper_result_execution_forbidden_fields,
    validate_helper_result_proof_hashes, validate_helper_result_redaction,
    validate_helper_result_secret_refs,
};
use result_semantics::{
    HelperResultSemanticContext, add_helper_result_redaction_failures,
    helper_result_validation_result, validate_helper_result_capability_level,
    validate_helper_result_execution, validate_helper_result_provenance,
    validate_helper_result_schema_version, validate_helper_result_semantic_matrix,
};
