use super::*;

impl TraceConformanceCheck {
    /// Build a check. Validates adapter id, non-empty golden trace
    /// monotonic order indices, non-empty bridge unit ids on the golden
    /// side, and event id well-formedness on the golden side.
    pub fn new(
        adapter_id: impl Into<String>,
        golden_trace: Vec<GoldenTextEvent>,
        observed_trace: Vec<ObservedTextEvent>,
        options: TraceCheckOptions,
    ) -> Result<Self, ConformanceError> {
        let adapter_id = adapter_id.into();
        if !is_valid_adapter_id(&adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed { id: adapter_id });
        }
        if golden_trace.is_empty() {
            return Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "text_line",
                reason: "golden_trace is empty".to_string(),
            });
        }
        for (index, event) in golden_trace.iter().enumerate() {
            let expected_order =
                u32::try_from(index).map_err(|_| ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "text_line",
                    reason: "golden_trace length exceeds u32".to_string(),
                })?;
            if event.order_index != expected_order {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "text_line",
                    reason: format!(
                        "golden_trace[{index}].order_index = {} does not match vector index",
                        event.order_index
                    ),
                });
            }
            validate_id_field("text_line", "event_id", &event.event_id)?;
            validate_id_field("bridge_unit", "bridge_unit_id", &event.bridge_unit_id)?;
            if event.text.is_empty() {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "text_line",
                    reason: format!("golden_trace[{index}].text is empty"),
                });
            }
        }
        Ok(Self {
            profile_id: ProfileId::TextTrace,
            adapter_id,
            golden_trace,
            observed_trace,
            options,
        })
    }

    /// Profile id this check is bound to. Always
    /// [`ProfileId::TextTrace`].
    pub fn profile_id(&self) -> ProfileId {
        self.profile_id
    }

    /// Adapter id from construction time.
    pub fn adapter_id(&self) -> &str {
        &self.adapter_id
    }

    /// Execute the check. Pass / Fail enumerate all mismatches; the
    /// pairing pass never short-circuits inside a single event.
    pub fn run(&self) -> TraceCheckResult {
        let golden_len = self.golden_trace.len();
        let observed_len = self.observed_trace.len();
        let mut mismatches: Vec<TraceMismatch> = Vec::new();

        for index in 0..golden_len.max(observed_len) {
            if index >= observed_len {
                let golden = &self.golden_trace[index];
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::Missing,
                    &golden.event_id,
                    None,
                    format!("observed trace ended at index {index}"),
                ));
                continue;
            }
            if index >= golden_len {
                let observed = &self.observed_trace[index];
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::Unexpected,
                    BEYOND_GOLDEN_SENTINEL,
                    Some(&observed.event_id),
                    format!("observed extra event at index {index}"),
                ));
                continue;
            }
            let golden = &self.golden_trace[index];
            let observed = &self.observed_trace[index];

            // (1) BridgeUnitUnlinked.
            if observed.bridge_unit_id.is_none() {
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::BridgeUnitUnlinked,
                    &golden.event_id,
                    Some(&observed.event_id),
                    "observed event has no bridge_unit_id".to_string(),
                ));
            } else if let Some(observed_id) = observed.bridge_unit_id.as_deref() {
                // (2) BridgeUnitDivergent.
                if observed_id != golden.bridge_unit_id {
                    mismatches.push(TraceMismatch::new(
                        TraceMismatchKind::BridgeUnitDivergent,
                        &golden.event_id,
                        Some(&observed.event_id),
                        format!(
                            "expected bridge_unit_id {} observed {}",
                            golden.bridge_unit_id, observed_id
                        ),
                    ));
                }
            }

            // (3) OrderShift.
            if observed.order_index != golden.order_index {
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::OrderShift,
                    &golden.event_id,
                    Some(&observed.event_id),
                    format!(
                        "expected order_index {} observed {}",
                        golden.order_index, observed.order_index
                    ),
                ));
            }

            // (4) TextDifference.
            if !texts_match(
                &golden.text,
                &observed.text,
                self.options.text_normalisation,
            ) {
                mismatches.push(TraceMismatch::new(
                    TraceMismatchKind::TextDifference,
                    &golden.event_id,
                    Some(&observed.event_id),
                    format!(
                        "expected text {:?} observed {:?}",
                        golden.text, observed.text
                    ),
                ));
            }

            // (5) SpeakerMismatch.
            if let Some(expected) = golden.speaker.as_deref() {
                let matches = observed
                    .speaker
                    .as_deref()
                    .is_some_and(|observed_speaker| observed_speaker == expected);
                if !matches {
                    let observed_speaker_token = match observed.speaker.as_deref() {
                        Some(value) => value.to_string(),
                        None => "<none>".to_string(),
                    };
                    mismatches.push(TraceMismatch::new(
                        TraceMismatchKind::SpeakerMismatch,
                        &golden.event_id,
                        Some(&observed.event_id),
                        format!(
                            "expected speaker {expected:?} observed {observed_speaker_token:?}"
                        ),
                    ));
                }
            }
        }

        let evidence_refs = build_trace_evidence(&self.observed_trace);
        if mismatches.is_empty() {
            TraceCheckResult::Pass { evidence_refs }
        } else {
            TraceCheckResult::Fail {
                mismatches,
                evidence_refs,
            }
        }
    }
}

impl TraceCheckResult {
    /// Lower this check result into a [`ConformanceResult`] for the
    /// `text-trace` profile. Rejects evidence-tier overclaiming and
    /// frame / screenshot / recording evidence refs.
    pub fn into_conformance_result(
        self,
        adapter_id: &str,
        evidence_tier: EvidenceTier,
        recorded_at: &str,
    ) -> Result<ConformanceResult, ConformanceError> {
        if !is_valid_adapter_id(adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed {
                id: adapter_id.to_string(),
            });
        }
        let ceiling = ProfileId::TextTrace.evidence_tier_ceiling();
        if evidence_tier > ceiling {
            return Err(ConformanceError::EvidenceTierAboveProfileCeiling {
                profile: ProfileId::TextTrace,
                claimed: evidence_tier,
                ceiling,
            });
        }
        let (outcome, evidence) = match self {
            Self::Pass { evidence_refs } => {
                for evidence in &evidence_refs {
                    if !accepts_text_trace_evidence(evidence) {
                        return Err(ConformanceError::MalformedSemanticCode {
                            code: codes::TRACE_EVIDENCE_TIER_OVERCLAIM.to_string(),
                        });
                    }
                }
                (ResultOutcome::Pass { evidence_tier }, evidence_refs)
            }
            Self::Fail {
                mismatches,
                evidence_refs,
            } => {
                for evidence in &evidence_refs {
                    if !accepts_text_trace_evidence(evidence) {
                        return Err(ConformanceError::MalformedSemanticCode {
                            code: codes::TRACE_EVIDENCE_TIER_OVERCLAIM.to_string(),
                        });
                    }
                }
                let (code, detail) = summarise_trace_failure(&mismatches);
                (
                    ResultOutcome::Fail {
                        semantic_code: code,
                        detail,
                    },
                    evidence_refs,
                )
            }
        };

        let result = ConformanceResult {
            schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
            adapter_id: adapter_id.to_string(),
            profile_id: ProfileId::TextTrace,
            outcome,
            evidence,
            recorded_at: recorded_at.to_string(),
        };
        result.validate()?;
        Ok(result)
    }
}

fn summarise_trace_failure(mismatches: &[TraceMismatch]) -> (String, String) {
    let total = mismatches.len();
    let mut text_difference = 0usize;
    let mut order_shift = 0usize;
    let mut bridge_unlinked = 0usize;
    let mut bridge_divergent = 0usize;
    let mut speaker = 0usize;
    let mut missing = 0usize;
    let mut unexpected = 0usize;
    for mismatch in mismatches {
        match mismatch.kind {
            TraceMismatchKind::TextDifference => text_difference += 1,
            TraceMismatchKind::OrderShift => order_shift += 1,
            TraceMismatchKind::BridgeUnitUnlinked => bridge_unlinked += 1,
            TraceMismatchKind::BridgeUnitDivergent => bridge_divergent += 1,
            TraceMismatchKind::SpeakerMismatch => speaker += 1,
            TraceMismatchKind::Missing => missing += 1,
            TraceMismatchKind::Unexpected => unexpected += 1,
        }
    }
    let dominant_code = mismatches
        .first()
        .map_or(codes::TRACE_TEXT_MISMATCH, |first| {
            trace_mismatch_code(first.kind)
        })
        .to_string();
    let mut detail = format!(
        "{total} trace mismatches: text_diff={text_difference} order_shift={order_shift} \
         bridge_unlinked={bridge_unlinked} bridge_divergent={bridge_divergent} \
         speaker={speaker} missing={missing} unexpected={unexpected}"
    );
    truncate_detail(&mut detail);
    (dominant_code, detail)
}

fn build_trace_evidence(observed: &[ObservedTextEvent]) -> Vec<EvidenceRef> {
    let mut refs: Vec<EvidenceRef> = Vec::with_capacity(observed.len());
    let mut seen_bridge: Vec<String> = Vec::new();
    for event in observed {
        refs.push(EvidenceRef::TextLine {
            line_id: event.event_id.clone(),
        });
    }
    for event in observed {
        if let Some(bridge_id) = event.bridge_unit_id.as_deref()
            && !seen_bridge.iter().any(|seen| seen == bridge_id)
        {
            seen_bridge.push(bridge_id.to_string());
        }
    }
    for bridge_id in seen_bridge {
        refs.push(EvidenceRef::BridgeUnit {
            bridge_unit_id: bridge_id,
        });
    }
    refs
}
