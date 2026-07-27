use super::*;

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
