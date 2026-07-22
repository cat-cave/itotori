use super::*;
use crate::runtime_artifact_uri;

pub(crate) fn baseline_text_line_evidence() -> EvidenceRef {
    EvidenceRef::TextLine {
        line_id: "trace-line-001".to_string(),
    }
}

pub(crate) fn baseline_pass_result() -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: "utsushi-synthetic".to_string(),
        profile_id: ProfileId::TextTrace,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E1,
        },
        evidence: vec![baseline_text_line_evidence()],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

fn fail_result_with_code(code: &str) -> ConformanceResult {
    ConformanceResult {
        outcome: ResultOutcome::Fail {
            semantic_code: code.to_string(),
            detail: "synthetic failure".to_string(),
        },
        evidence: Vec::new(),
        ..baseline_pass_result()
    }
}

fn skip_result_with_code(code: &str) -> ConformanceResult {
    ConformanceResult {
        profile_id: ProfileId::FrameCapture,
        outcome: ResultOutcome::Skip {
            semantic_code: code.to_string(),
            reason: "suite filter excluded".to_string(),
        },
        evidence: Vec::new(),
        ..baseline_pass_result()
    }
}

fn unsupported_result_with_flag(declared: bool) -> ConformanceResult {
    ConformanceResult {
        profile_id: ProfileId::FrameCapture,
        outcome: ResultOutcome::Unsupported {
            semantic_code: "utsushi.conformance.profile_not_declared".to_string(),
            declared_in_manifest: declared,
        },
        evidence: Vec::new(),
        ..baseline_pass_result()
    }
}

#[test]
fn result_pass_round_trips_through_serde_json() {
    let result = baseline_pass_result();
    let value = result.to_json_value().expect("validates and serializes");
    let restored = ConformanceResult::from_json_value(value).expect("restores");
    assert_eq!(result, restored);
}

#[test]
fn result_fail_round_trips_through_serde_json() {
    let result = fail_result_with_code("utsushi.sink.unsupported_kind");
    let value = result.to_json_value().expect("validates and serializes");
    let restored = ConformanceResult::from_json_value(value).expect("restores");
    assert_eq!(result, restored);
}

#[test]
fn result_skip_round_trips_through_serde_json() {
    let result = skip_result_with_code("utsushi.conformance.profile_not_reported");
    let value = result.to_json_value().expect("validates and serializes");
    let restored = ConformanceResult::from_json_value(value).expect("restores");
    assert_eq!(result, restored);
}

#[test]
fn result_unsupported_round_trips_through_serde_json() {
    let result = unsupported_result_with_flag(false);
    let value = result.to_json_value().expect("validates and serializes");
    let restored = ConformanceResult::from_json_value(value).expect("restores");
    assert_eq!(result, restored);
}

#[test]
fn result_outcome_kind_discriminator_serializes_as_camel_case() {
    let result = baseline_pass_result();
    let value = serde_json::to_value(&result).expect("serializes");
    let outcome = value
        .as_object()
        .and_then(|o| o.get("outcome"))
        .and_then(|v| v.as_object())
        .expect("outcome object");
    assert_eq!(
        outcome.get("kind").and_then(|v| v.as_str()),
        Some("pass"),
        "outcome kind discriminator must be camelCase: {value:?}"
    );
    assert!(
        outcome.contains_key("evidenceTier"),
        "outcome fields must be camelCase: {value:?}"
    );
}

#[test]
fn result_validate_accepts_pass_with_runtime_artifact_evidence() {
    let uri = runtime_artifact_uri("synthetic-run", RuntimeArtifactKind::TraceLog, "trace-001")
        .expect("uri");
    let result = ConformanceResult {
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::TraceLog,
            uri,
            artifact_id: Some("trace-001".to_string()),
        }],
        ..baseline_pass_result()
    };
    result.validate().expect("validates");
}

#[test]
fn result_validate_accepts_fail_with_utsushi_sink_semantic_code() {
    let result = fail_result_with_code("utsushi.sink.evidence_tier_mismatch");
    result.validate().expect("validates");
}

#[test]
fn result_validate_accepts_fail_with_kaifuu_provider_semantic_code() {
    let result = fail_result_with_code("kaifuu.profile.unknown_key");
    result.validate().expect("validates");
}

#[test]
fn result_validate_accepts_skip_for_undeclared_profile() {
    let result = skip_result_with_code("utsushi.conformance.profile_not_reported");
    result.validate().expect("validates");
}

#[test]
fn result_validate_rejects_pass_without_evidence() {
    let mut result = baseline_pass_result();
    result.evidence.clear();
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::PassWithoutEvidence { .. })
    ));
}

#[test]
fn result_validate_rejects_pass_with_tier_above_profile_ceiling() {
    let mut result = baseline_pass_result();
    result.outcome = ResultOutcome::Pass {
        evidence_tier: EvidenceTier::E3,
    };
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::EvidenceTierAboveProfileCeiling { .. })
    ));
}

#[test]
fn result_validate_rejects_outcome_with_malformed_semantic_code() {
    let result = fail_result_with_code("not-a-code");
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::MalformedSemanticCode { .. })
    ));
}

#[test]
fn result_validate_rejects_outcome_with_unknown_provider_prefix() {
    let result = fail_result_with_code("rgss3.script.unknown_opcode");
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::MalformedSemanticCode { .. })
    ));
}

#[test]
fn result_validate_rejects_unsupported_when_declared_in_manifest_true() {
    let result = unsupported_result_with_flag(true);
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::DeclaredProfileReportedAsUnsupported { .. })
    ));
}

#[test]
fn result_validate_rejects_recorded_at_not_rfc3339() {
    let mut result = baseline_pass_result();
    result.recorded_at = "not-a-time".to_string();
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::RecordedAtMalformed { .. })
    ));
}

#[test]
fn result_validate_rejects_evidence_ref_runtime_artifact_with_file_scheme() {
    let result = ConformanceResult {
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::TraceLog,
            uri: "file:///tmp/leak.json".to_string(),
            artifact_id: None,
        }],
        ..baseline_pass_result()
    };
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "runtime_artifact",
            ..
        })
    ));
}

#[test]
fn result_validate_rejects_evidence_ref_runtime_artifact_outside_managed_root() {
    let result = ConformanceResult {
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::TraceLog,
            uri: "not/the/managed/root/trace.json".to_string(),
            artifact_id: None,
        }],
        ..baseline_pass_result()
    };
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "runtime_artifact",
            ..
        })
    ));
}

#[test]
fn result_validate_rejects_evidence_ref_text_line_with_whitespace_id() {
    let result = ConformanceResult {
        evidence: vec![EvidenceRef::TextLine {
            line_id: "has space".to_string(),
        }],
        ..baseline_pass_result()
    };
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "text_line",
            ..
        })
    ));
}

#[test]
fn result_validate_rejects_evidence_ref_bridge_unit_with_local_path_substring() {
    let result = ConformanceResult {
        evidence: vec![EvidenceRef::BridgeUnit {
            bridge_unit_id: "/home/user/leak".to_string(),
        }],
        ..baseline_pass_result()
    };
    assert!(matches!(
        result.validate(),
        Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "bridge_unit",
            ..
        })
    ));
}

#[test]
fn evidence_ref_state_path_round_trips_through_serde_json() {
    let evidence = EvidenceRef::StatePath {
        path: "port.frame".to_string(),
    };
    let value = serde_json::to_value(&evidence).expect("serializes");
    let restored: EvidenceRef = serde_json::from_value(value).expect("deserializes");
    assert_eq!(restored, evidence);
}

#[test]
fn evidence_ref_state_path_serializes_as_artifact_kind_camel_case_state_path() {
    let evidence = EvidenceRef::StatePath {
        path: "port.frame".to_string(),
    };
    let value = serde_json::to_value(&evidence).expect("serializes");
    let object = value.as_object().expect("object");
    assert_eq!(
        object.get("artifactKind").and_then(|v| v.as_str()),
        Some("statePath"),
        "wire tag must be camelCase statePath: {value:?}"
    );
    assert_eq!(
        object.get("path").and_then(|v| v.as_str()),
        Some("port.frame"),
        "path field preserved verbatim: {value:?}"
    );
}

#[test]
fn evidence_ref_state_path_validate_accepts_canonical_path() {
    EvidenceRef::StatePath {
        path: "port.frame".to_string(),
    }
    .validate()
    .expect("validates");
}

#[test]
fn evidence_ref_state_path_validate_rejects_empty_path() {
    let err = EvidenceRef::StatePath {
        path: String::new(),
    }
    .validate()
    .expect_err("empty");
    assert!(matches!(
        err,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            ..
        }
    ));
}

#[test]
fn evidence_ref_state_path_validate_rejects_path_with_whitespace() {
    let err = EvidenceRef::StatePath {
        path: "port frame".to_string(),
    }
    .validate()
    .expect_err("whitespace");
    assert!(matches!(
        err,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            ..
        }
    ));
}

#[test]
fn evidence_ref_state_path_validate_rejects_path_that_looks_like_local_path() {
    let err = EvidenceRef::StatePath {
        path: "/home/user/leak".to_string(),
    }
    .validate()
    .expect_err("local path");
    assert!(matches!(
        err,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            ..
        }
    ));
}

#[test]
fn evidence_ref_state_path_validate_rejects_path_with_unknown_namespace() {
    let err = EvidenceRef::StatePath {
        path: "unknown.frame".to_string(),
    }
    .validate()
    .expect_err("unknown namespace");
    assert!(matches!(
        err,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            ..
        }
    ));
}

#[test]
fn evidence_ref_state_path_validate_rejects_path_with_uppercase_segment() {
    let err = EvidenceRef::StatePath {
        path: "Port.frame".to_string(),
    }
    .validate()
    .expect_err("uppercase");
    assert!(matches!(
        err,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "state_path",
            ..
        }
    ));
}

#[test]
fn every_existing_evidence_ref_variant_still_round_trips_through_serde() {
    // Belt-and-suspenders: the additive variant must not perturb
    // the existing variants' wire shape.
    let uri = crate::runtime_artifact_uri(
        "synthetic-run",
        crate::RuntimeArtifactKind::TraceLog,
        "trace-001",
    )
    .expect("uri");
    let variants = vec![
        EvidenceRef::RuntimeArtifact {
            kind: crate::RuntimeArtifactKind::TraceLog,
            uri,
            artifact_id: Some("trace-001".to_string()),
        },
        EvidenceRef::TextLine {
            line_id: "trace-line-001".to_string(),
        },
        EvidenceRef::FrameArtifactRef {
            frame_id: "frame-0001".to_string(),
        },
        EvidenceRef::ReplayLogRef {
            run_id: "run-001".to_string(),
        },
        EvidenceRef::ImplMapFixture {
            fixture_id: "fixture-a".to_string(),
        },
        EvidenceRef::BridgeUnit {
            bridge_unit_id: "bridge-unit-001".to_string(),
        },
    ];
    for variant in variants {
        let value = serde_json::to_value(&variant).expect("serializes");
        let restored: EvidenceRef = serde_json::from_value(value).expect("deserializes");
        assert_eq!(restored, variant);
        variant.validate().expect("validates");
    }
}

#[test]
fn result_pass_with_state_path_evidence_validates() {
    let result = ConformanceResult {
        profile_id: ProfileId::SnapshotRestore,
        evidence: vec![EvidenceRef::StatePath {
            path: "port.frame".to_string(),
        }],
        ..baseline_pass_result()
    };
    result.validate().expect("validates");
}
