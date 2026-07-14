//! Pure-data validator for the implementation map.
//!
//! The validator NEVER executes shell commands and NEVER touches the
//! filesystem. It enforces structural invariants only. Command execution is
//! 030's responsibility; fixture-hash verification lives in the
//! separate [`super::verify_fixture_hashes`] helper.

use std::collections::HashSet;

use super::diagnostics::{ImplMapError, ImplMapManifestMismatch, ProvenanceField, ReferenceField};
use super::schema::{
    CaptureMethod, EngineFamily, EvidenceKind, ExpectedOutcome, FixtureClassification, FixtureKind,
    IMPL_MAP_SCHEMA_VERSION, ImplementationMap, Status, Subsystem, SubsystemId, SubsystemStatus,
    UnsupportedReason, ValidationCommandId,
};

/// Audit-load-bearing disclaimer string emitted on the validation report
/// (and stamped into the map's `statusDisclaimer` field on
/// promotion). Consumers MUST surface this whenever they surface
/// [`Status::Validated`].
pub const STATUS_VALIDATED_DISCLAIMER: &str = "impl_map.status=Validated proves the coverage scaffolding is structurally valid. It is NOT alpha-readiness evidence, NOT a port readiness signal, and NOT a substitute for the engine-port slice. Acceptance of the engine port requires a separately-landed slice (UTSUSHI-031..039, UTSUSHI-146) whose verification commands produce the evidence this map points to.";

/// Successful validation report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationReport {
    /// Fixed disclaimer string (see [`STATUS_VALIDATED_DISCLAIMER`]).
    pub status_disclaimer: &'static str,
    /// Non-blocking advisories. Do not downgrade `Status::Validated`.
    pub warnings: Vec<ValidationWarning>,
    /// The schema version this build supports.
    pub schema_version: &'static str,
}

/// Non-blocking advisory the validator surfaces alongside a successful run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidationWarning {
    /// `reference_behavior.capture_method == NoReferenceComparison`.
    NoReferenceComparison,
    /// A subsystem cites only `PrivateLocal` fixtures with no
    /// public-CI-visible coverage.
    OnlyPrivateLocalFixtures { subsystem_id: SubsystemId },
    /// A subsystem is in `Research` status; flagged so dashboards can
    /// surface that the map carries unverified scope.
    ResearchSubsystemPresent { subsystem_id: SubsystemId },
}

/// Validate a standalone implementation map against the schema invariants.
///
/// Returns `Vec<ImplMapError>` (NOT a single error) so a draft map gets
/// every diagnostic in one pass.
pub fn validate(map: &ImplementationMap) -> Result<ValidationReport, Vec<ImplMapError>> {
    let mut errors: Vec<ImplMapError> = Vec::new();
    let mut warnings: Vec<ValidationWarning> = Vec::new();

    validate_schema_version(map, &mut errors);
    validate_port_id(map, &mut errors);
    validate_engine_family(map, &mut errors);
    validate_subsystems_nonempty(map, &mut errors);
    validate_commands_nonempty(map, &mut errors);
    validate_subsystem_uniqueness(map, &mut errors);
    validate_command_uniqueness(map, &mut errors);
    validate_cross_references(map, &mut errors);
    validate_each_subsystem(map, &mut errors, &mut warnings);
    validate_each_command(map, &mut errors);
    validate_reference_behavior(map, &mut errors, &mut warnings);
    validate_generated_at(map, &mut errors);

    if errors.is_empty() {
        Ok(ValidationReport {
            status_disclaimer: STATUS_VALIDATED_DISCLAIMER,
            warnings,
            schema_version: IMPL_MAP_SCHEMA_VERSION,
        })
    } else {
        Err(errors)
    }
}

// Top-level invariants.

fn validate_schema_version(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    let declared = map.schema_version.as_str();
    if !is_compatible_schema_version(declared) {
        errors.push(ImplMapError::UnsupportedSchemaVersion {
            declared: declared.to_string(),
            supported: IMPL_MAP_SCHEMA_VERSION,
        });
    }
}

fn is_compatible_schema_version(declared: &str) -> bool {
    let parts: Vec<&str> = declared.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    if parts
        .iter()
        .any(|part| !part.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let supported_parts: Vec<&str> = IMPL_MAP_SCHEMA_VERSION.split('.').collect();
    // Compatible if major matches.
    parts[0] == supported_parts[0]
}

fn validate_port_id(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    let id = map.port_id.as_str();
    if !is_valid_port_id_shape(id) {
        errors.push(ImplMapError::PortIdMalformed { id: id.to_string() });
    }
}

fn is_valid_port_id_shape(id: &str) -> bool {
    if id.len() < 8 || id.len() > 64 {
        return false;
    }
    let bytes = id.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn validate_engine_family(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    if matches!(map.engine_family, EngineFamily::Other) {
        let notes_empty = map
            .engine_family_notes
            .as_ref()
            .is_none_or(|notes| notes.trim().is_empty());
        if notes_empty {
            errors.push(ImplMapError::EngineFamilyOtherWithoutNotes);
        }
    }
}

fn validate_subsystems_nonempty(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    if map.subsystems.is_empty() {
        errors.push(ImplMapError::NoSubsystemsDeclared);
    }
}

fn validate_commands_nonempty(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    if map.validation_commands.is_empty() {
        errors.push(ImplMapError::NoValidationCommandsDeclared);
    }
}

fn validate_subsystem_uniqueness(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut reported: HashSet<&str> = HashSet::new();
    for subsystem in &map.subsystems {
        let id = subsystem.id.as_str();
        if !seen.insert(id) && reported.insert(id) {
            errors.push(ImplMapError::DuplicateSubsystemId {
                id: subsystem.id.clone(),
            });
        }
    }
}

fn validate_command_uniqueness(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut reported: HashSet<&str> = HashSet::new();
    for command in &map.validation_commands {
        let id = command.id.as_str();
        if !seen.insert(id) && reported.insert(id) {
            errors.push(ImplMapError::DuplicateValidationCommandId {
                id: command.id.clone(),
            });
        }
    }
}

fn validate_cross_references(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    let known_command_ids: HashSet<&str> = map
        .validation_commands
        .iter()
        .map(|command| command.id.as_str())
        .collect();
    let referenced_command_ids: HashSet<&str> = map
        .subsystems
        .iter()
        .map(|subsystem| subsystem.validation_command_id.as_str())
        .collect();

    for subsystem in &map.subsystems {
        if !known_command_ids.contains(subsystem.validation_command_id.as_str()) {
            errors.push(ImplMapError::OrphanValidationCommandRef {
                subsystem_id: subsystem.id.clone(),
                validation_command_id: subsystem.validation_command_id.clone(),
            });
        }
    }

    for command in &map.validation_commands {
        if !referenced_command_ids.contains(command.id.as_str()) {
            errors.push(ImplMapError::OrphanValidationCommand {
                id: command.id.clone(),
            });
        }
    }
}

// Per-subsystem invariants.

fn validate_each_subsystem(
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

fn is_semantic_code(code: &str) -> bool {
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

// Per-command invariants.

const RESERVED_COMMAND_PREFIXES: &[&str] = &["cargo ", "just ", "node ", "pnpm "];

fn validate_each_command(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    for command in &map.validation_commands {
        let raw = command.command.as_str();
        if raw.trim().is_empty() {
            errors.push(ImplMapError::ValidationCommandEmpty {
                id: command.id.clone(),
            });
        } else {
            if let Some(token) = first_unsafe_token(raw) {
                errors.push(ImplMapError::ValidationCommandUnsafeShape {
                    id: command.id.clone(),
                    offending_token: token.clone(),
                });
            }
            if !RESERVED_COMMAND_PREFIXES
                .iter()
                .any(|prefix| raw.starts_with(prefix))
            {
                let prefix = raw.split_whitespace().next().unwrap_or("").to_string();
                errors.push(ImplMapError::ValidationCommandPrefixUnknown {
                    id: command.id.clone(),
                    prefix,
                });
            }
        }

        if command.caption.trim().is_empty() {
            errors.push(ImplMapError::ValidationCommandCaptionEmpty {
                id: command.id.clone(),
            });
        }

        validate_expected_outcome(&command.id, &command.expected_outcome, errors);
    }
}

fn first_unsafe_token(command: &str) -> Option<String> {
    let forbidden: &[char] = &['|', '>', '<', ';', '&', '$', '`', '(', ')', '\\', '"', '\''];
    if let Some(ch) = command.chars().find(|c| forbidden.contains(c)) {
        return Some(ch.to_string());
    }
    // Allowed chars: alnum, dot, underscore, slash, equals, colon, at
    // plus, dash, space.
    for ch in command.chars() {
        let ok = ch.is_ascii_alphanumeric()
            || matches!(ch, '.' | '_' | '/' | '=' | ':' | '@' | '+' | '-' | ' ');
        if !ok {
            return Some(ch.to_string());
        }
    }
    None
}

fn validate_expected_outcome(
    id: &ValidationCommandId,
    outcome: &ExpectedOutcome,
    errors: &mut Vec<ImplMapError>,
) {
    match outcome {
        ExpectedOutcome::Pass => {}
        ExpectedOutcome::Skip { reason } => {
            if !is_semantic_code(reason) {
                errors.push(ImplMapError::SkipReasonNotSemantic {
                    id: id.clone(),
                    raw: reason.clone(),
                });
            }
        }
        ExpectedOutcome::Fail { semantic_code } => {
            if !is_semantic_code(semantic_code) {
                errors.push(ImplMapError::FailSemanticCodeMalformed {
                    id: id.clone(),
                    raw: semantic_code.clone(),
                });
            }
        }
    }
}

// Reference behavior.

fn validate_reference_behavior(
    map: &ImplementationMap,
    errors: &mut Vec<ImplMapError>,
    warnings: &mut Vec<ValidationWarning>,
) {
    if map.reference_behavior.engine_runtime.trim().is_empty() {
        errors.push(ImplMapError::ReferenceBehaviorMissing {
            field: ReferenceField::EngineRuntime,
        });
    }
    if map.reference_behavior.observable_signal.trim().is_empty() {
        errors.push(ImplMapError::ReferenceBehaviorMissing {
            field: ReferenceField::ObservableSignal,
        });
    }
    if matches!(
        map.reference_behavior.capture_method,
        CaptureMethod::NoReferenceComparison
    ) {
        warnings.push(ValidationWarning::NoReferenceComparison);
    }
}

// generated_at.

fn validate_generated_at(map: &ImplementationMap, errors: &mut Vec<ImplMapError>) {
    if !is_rfc3339_instant(map.generated_at.as_str()) {
        errors.push(ImplMapError::GeneratedAtNotRfc3339 {
            raw: map.generated_at.clone(),
        });
    }
}

fn is_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let year = &date[0..4];
    let month = &date[5..7];
    let day = &date[8..10];
    if !year.chars().all(|c| c.is_ascii_digit())
        || !month.chars().all(|c| c.is_ascii_digit())
        || !day.chars().all(|c| c.is_ascii_digit())
    {
        return false;
    }

    let (time, offset) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, "Z")
    } else if let Some(idx) = time_and_offset.rfind(['+', '-']) {
        (&time_and_offset[..idx], &time_and_offset[idx..])
    } else {
        return false;
    };

    let time_main = time.split('.').next().unwrap_or("");
    if time_main.len() != 8
        || time_main.as_bytes().get(2) != Some(&b':')
        || time_main.as_bytes().get(5) != Some(&b':')
    {
        return false;
    }
    if !time_main[0..2].chars().all(|c| c.is_ascii_digit())
        || !time_main[3..5].chars().all(|c| c.is_ascii_digit())
        || !time_main[6..8].chars().all(|c| c.is_ascii_digit())
    {
        return false;
    }

    if offset == "Z" {
        return true;
    }
    if offset.len() != 6 {
        return false;
    }
    let bytes = offset.as_bytes();
    if !(bytes[0] == b'+' || bytes[0] == b'-') {
        return false;
    }
    if bytes[3] != b':' {
        return false;
    }
    offset[1..3].chars().all(|c| c.is_ascii_digit())
        && offset[4..6].chars().all(|c| c.is_ascii_digit())
}

// Cross-validation against PortManifest.

/// Cross-validate the map against a `PortManifest`. OFFERED but NOT REQUIRED
/// — the map remains standalone-validatable.
pub fn validate_against_manifest(
    map: &ImplementationMap,
    manifest: &crate::port::PortManifest,
) -> Result<(), Vec<ImplMapManifestMismatch>> {
    let mut errors = Vec::new();

    if map.port_id.as_str() != manifest.id {
        errors.push(ImplMapManifestMismatch::PortIdMismatch {
            map_port_id: map.port_id.as_str().to_string(),
            manifest_id: manifest.id.to_string(),
        });
    }

    let manifest_capability_tags: HashSet<&'static str> = manifest
        .capabilities
        .iter()
        .map(|capability| capability.as_str())
        .collect();
    let known_port_capability_tags: HashSet<&'static str> = [
        "launch",
        "observe",
        "capture",
        "shutdown",
        "jump",
        "snapshot",
        "deterministic_replay",
    ]
    .into_iter()
    .collect();

    for subsystem in &map.subsystems {
        for tag in &subsystem.capabilities {
            if known_port_capability_tags.contains(tag.as_str())
                && !manifest_capability_tags.contains(tag.as_str())
            {
                errors.push(ImplMapManifestMismatch::CapabilityAbsentFromManifest {
                    subsystem_id: subsystem.id.clone(),
                    capability: tag.clone(),
                });
            }
        }
    }

    if let Some(expected_prefix) = map.engine_family.manifest_prefix()
        && !manifest.id.starts_with(expected_prefix)
    {
        errors.push(ImplMapManifestMismatch::EngineFamilyManifestIdMismatch {
            engine_family: map.engine_family.as_wire_name().to_string(),
            manifest_id: manifest.id.to_string(),
        });
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

// Status promotion helper. Applied by the public surface in mod.rs to keep
// the validator pure-data here.

/// Promote a Draft map to Validated when validation succeeds. Used by
/// [`super::validate_and_promote`]. Idempotent on already-Validated maps;
/// preserves Outdated as-is per §4.2 invariant 16.
pub(crate) fn promote_status(map: &mut ImplementationMap, _report: &ValidationReport) {
    match map.status {
        Status::Draft | Status::Validated => {
            map.status = Status::Validated;
            map.status_disclaimer = Some(STATUS_VALIDATED_DISCLAIMER.to_string());
        }
        Status::Outdated => {}
    }
}
