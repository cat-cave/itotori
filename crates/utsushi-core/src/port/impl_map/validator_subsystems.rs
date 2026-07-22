use super::*;

// Per-subsystem invariants.

pub(super) fn validate_each_subsystem(
    map: &ImplementationMap,
    errors: &mut Vec<ImplMapError>,
    warnings: &mut Vec<ValidationWarning>,
) {
    for subsystem in &map.subsystems {
        validate_subsystem_fixture(subsystem, errors);
        validate_subsystem_capabilities(subsystem, errors);
        validate_subsystem_status(subsystem, errors, warnings);

        if matches!(
            subsystem.fixture_ref.classification,
            FixtureClassification::PrivateLocal
        ) {
            warnings.push(ValidationWarning::OnlyPrivateLocalFixtures {
                subsystem_id: subsystem.id.clone(),
            });
        }
    }
}

fn validate_subsystem_fixture(subsystem: &Subsystem, errors: &mut Vec<ImplMapError>) {
    let fixture = &subsystem.fixture_ref;

    // Id must be present (non-empty after trim).
    if fixture.id.trim().is_empty() {
        errors.push(ImplMapError::MissingFixtureProvenance {
            subsystem_id: subsystem.id.clone(),
            field: ProvenanceField::Id,
        });
    }

    // Hash: 64-char lowercase hex, not sentinel/placeholder.
    let hash = fixture.hash.as_str();
    let trimmed_hash = hash.trim();
    if trimmed_hash.is_empty() || hash_is_sentinel(trimmed_hash) {
        errors.push(ImplMapError::MissingFixtureProvenance {
            subsystem_id: subsystem.id.clone(),
            field: ProvenanceField::Hash,
        });
    } else if !is_lowercase_hex_64(trimmed_hash) {
        errors.push(ImplMapError::FixtureHashMalformed {
            subsystem_id: subsystem.id.clone(),
            raw: hash.to_string(),
        });
    }

    // byte_count > 0 unless synthetic-inline.
    let synthetic = matches!(
        fixture.classification,
        FixtureClassification::SyntheticInline
    ) && matches!(fixture.kind, FixtureKind::SyntheticInline);
    if fixture.byte_count == 0 && !synthetic {
        errors.push(ImplMapError::FixtureByteCountZero {
            subsystem_id: subsystem.id.clone(),
        });
    }

    // SyntheticInline classification and kind must agree.
    let classification_synthetic = matches!(
        fixture.classification,
        FixtureClassification::SyntheticInline
    );
    let kind_synthetic = matches!(fixture.kind, FixtureKind::SyntheticInline);
    if classification_synthetic != kind_synthetic {
        errors.push(ImplMapError::SyntheticInlineMismatch {
            subsystem_id: subsystem.id.clone(),
        });
    }

    // kind == Other requires non-empty kind_notes.
    if matches!(fixture.kind, FixtureKind::Other) {
        let notes_empty = fixture
            .kind_notes
            .as_ref()
            .is_none_or(|notes| notes.trim().is_empty());
        if notes_empty {
            errors.push(ImplMapError::FixtureKindOtherWithoutNotes {
                subsystem_id: subsystem.id.clone(),
            });
        }
    }
}

fn hash_is_sentinel(hash: &str) -> bool {
    if hash.chars().all(|c| c == '0') && !hash.is_empty() {
        return true;
    }
    let upper = hash.to_ascii_uppercase();
    upper.contains("TODO") || upper.contains("TBD") || upper.contains("PLACEHOLDER")
}

fn is_lowercase_hex_64(value: &str) -> bool {
    if value.len() != 64 {
        return false;
    }
    value
        .as_bytes()
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn validate_subsystem_capabilities(subsystem: &Subsystem, errors: &mut Vec<ImplMapError>) {
    if subsystem.capabilities.is_empty()
        || subsystem
            .capabilities
            .iter()
            .all(|tag| tag.trim().is_empty())
    {
        errors.push(ImplMapError::EmptyCapabilityList {
            subsystem_id: subsystem.id.clone(),
        });
    }
}

fn validate_subsystem_status(
    subsystem: &Subsystem,
    errors: &mut Vec<ImplMapError>,
    warnings: &mut Vec<ValidationWarning>,
) {
    match &subsystem.status {
        SubsystemStatus::Supported => {}
        SubsystemStatus::Partial { limitations } => {
            let any_useful = limitations.iter().any(|item| !item.trim().is_empty());
            if limitations.is_empty() || !any_useful {
                errors.push(ImplMapError::PartialWithoutLimitations {
                    subsystem_id: subsystem.id.clone(),
                });
            }
        }
        SubsystemStatus::Unsupported { reason } => {
            let (ok, raw) = match reason {
                UnsupportedReason::SemanticCode(code) => (is_semantic_code(code), code.clone()),
                UnsupportedReason::DeferredTo(node_id) => {
                    (is_forward_sentinel(node_id), node_id.clone())
                }
            };
            if !ok {
                errors.push(ImplMapError::UnsupportedReasonNotSemantic {
                    subsystem_id: subsystem.id.clone(),
                    raw,
                });
            }
        }
        SubsystemStatus::Research { evidence_refs } => {
            if evidence_refs.is_empty() {
                errors.push(ImplMapError::ResearchEvidenceMissing {
                    subsystem_id: subsystem.id.clone(),
                });
            }
            for (index, evidence) in evidence_refs.iter().enumerate() {
                if evidence.caption.trim().is_empty() {
                    errors.push(ImplMapError::ResearchEvidenceCaptionEmpty {
                        subsystem_id: subsystem.id.clone(),
                        index,
                    });
                }
                if !is_evidence_locator_valid(evidence.kind, &evidence.locator) {
                    errors.push(ImplMapError::ResearchEvidenceLocatorMalformed {
                        subsystem_id: subsystem.id.clone(),
                        index,
                        kind: evidence.kind,
                        locator: evidence.locator.clone(),
                    });
                }
            }
            warnings.push(ValidationWarning::ResearchSubsystemPresent {
                subsystem_id: subsystem.id.clone(),
            });
        }
    }
}

pub(super) fn is_semantic_code(code: &str) -> bool {
    let parts: Vec<&str> = code.split('.').collect();
    if parts.len() < 3 {
        return false;
    }
    if parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    parts.iter().all(|part| {
        part.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    })
}

fn is_forward_sentinel(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("deferred-to-") else {
        return false;
    };
    is_node_id(rest)
}

fn is_node_id(value: &str) -> bool {
    let Some((project, digits)) = value.split_once('-') else {
        return false;
    };
    let projects = ["UTSUSHI", "KAIFUU", "ITOTORI", "ALPHA", "SHARED"];
    if !projects.contains(&project) {
        return false;
    }
    if digits.len() != 3 {
        return false;
    }
    digits.chars().all(|c| c.is_ascii_digit())
}

fn is_evidence_locator_valid(kind: EvidenceKind, locator: &str) -> bool {
    let trimmed = locator.trim();
    if trimmed.is_empty() {
        return false;
    }
    match kind {
        // Fail-closed: a Fixture ref MUST live under the `fixtures/` root and a
        // Doc ref under the `docs/` root, so audit-channel triage of research
        // evidence is mechanical. Anything outside its known root is rejected.
        EvidenceKind::Fixture => is_rooted_repo_path(trimmed, "fixtures/"),
        EvidenceKind::Doc => is_rooted_repo_path(trimmed, "docs/"),
        EvidenceKind::RoadmapNode => is_node_id(trimmed),
        // A reference-impl anchor MUST be a colon-anchored URI (`scheme:path`)
        // e.g. `https://github.com/...` or `rlvm:src/machine/rlmachine.cc`.
        EvidenceKind::ReferenceImplAnchor => is_colon_anchored_uri(trimmed),
    }
}

/// A repo-relative path anchored at a known `root` prefix (e.g. `fixtures/`).
/// Rejects absolute host paths and any `..` traversal segment.
fn is_rooted_repo_path(value: &str, root: &str) -> bool {
    value.starts_with(root)
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && !value.split('/').any(|seg| seg == "..")
}

/// A colon-anchored URI shape: a non-empty `scheme` (letter-led, made of
/// ASCII alphanumerics plus `+`, `-`, `.`) followed by `:` and a non-empty
/// path/authority remainder. Accepts `https://github.com/...` and generic
/// `scheme:path` anchor tokens; rejects bare (colon-less) tokens and strings
/// whose colon sits at the very start or end.
fn is_colon_anchored_uri(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    if scheme.is_empty() || rest.is_empty() {
        return false;
    }
    let mut chars = scheme.chars();
    let first_is_alpha = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    first_is_alpha
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
}
