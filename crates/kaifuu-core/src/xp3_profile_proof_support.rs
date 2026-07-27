use super::*;

pub(crate) fn classify_xp3_bytes(bytes: &[u8]) -> Option<Xp3ProfileClassification> {
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

pub(crate) fn evaluate_xp3_crypt_profile(
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

pub(crate) fn validate_xp3_fixture_archive_path(path: &str) -> Result<&str, String> {
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
