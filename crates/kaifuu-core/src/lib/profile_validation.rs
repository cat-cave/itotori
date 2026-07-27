use super::*;

#[path = "profile_validation/assets_and_layered.rs"]
mod assets_and_layered;
#[path = "profile_validation/entry.rs"]
mod entry;
#[path = "profile_validation/model.rs"]
mod model;
#[path = "profile_validation/source_and_keys.rs"]
mod source_and_keys;
#[path = "profile_validation/surfaces_and_requirements.rs"]
mod surfaces_and_requirements;

pub use entry::validate_profile_value;
pub use model::GameProfile;

use assets_and_layered::{validate_assets, validate_identifier, validate_layered_access_profile};
use source_and_keys::{
    validate_archive_parameters, validate_helper_evidence, validate_key_requirements,
    validate_required_key_requirement_matches, validate_source_fingerprint,
};
use surfaces_and_requirements::{
    required_string_value, validate_capabilities,
    validate_capability_report as validate_capability_report_inner, validate_enum_string,
    validate_locale_field, validate_requirements, validate_text_surfaces,
};

pub(super) fn validate_capability_report(
    failures: &mut Vec<ProfileValidationFailure>,
    report: Option<&Value>,
    field: &str,
) -> Option<String> {
    validate_capability_report_inner(failures, report, field)
}

pub(crate) fn is_bcp47_like_locale(locale: &str) -> bool {
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

pub(crate) fn validate_profile_relative_path(
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
