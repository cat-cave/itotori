use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusParserBoundarySmokeVariant {
    ParserBoundarySuccess,
    HelperRequired,
    MissingKey,
    UnsupportedOpcode,
    OutOfProfile,
}

#[derive(Debug, Clone, Copy)]
pub struct SiglusParserBoundarySmokeRequest<'a> {
    pub scene_path: &'a Path,
    pub gameexe_path: &'a Path,
    pub key_request: Option<&'a Value>,
    pub variant: SiglusParserBoundarySmokeVariant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiglusParserBoundaryOutcome {
    ParserBoundarySuccess,
    HelperRequired,
    MissingKey,
    UnsupportedOpcode,
    OutOfProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub outcome: SiglusParserBoundaryOutcome,
    pub support_boundary: String,
    pub patch_write_attempted: bool,
    pub sources: Vec<SiglusParserBoundarySource>,
    pub key_refs: Vec<SiglusParserBoundaryKeyRef>,
    pub text_slots: Vec<SiglusParserBoundaryTextSlot>,
    pub diagnostics: Vec<SiglusParserBoundaryDiagnostic>,
}

impl SiglusParserBoundaryReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            outcome: self.outcome,
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            patch_write_attempted: self.patch_write_attempted,
            sources: self
                .sources
                .iter()
                .map(SiglusParserBoundarySource::redacted_for_report)
                .collect(),
            key_refs: self
                .key_refs
                .iter()
                .map(SiglusParserBoundaryKeyRef::redacted_for_report)
                .collect(),
            text_slots: self
                .text_slots
                .iter()
                .map(SiglusParserBoundaryTextSlot::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(SiglusParserBoundaryDiagnostic::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundarySource {
    pub asset_id: String,
    pub path: String,
    pub source_hash: ProofHash,
}

impl SiglusParserBoundarySource {
    fn redacted_for_report(&self) -> Self {
        Self {
            asset_id: redact_for_log_or_report(&self.asset_id),
            path: redact_for_log_or_report(&self.path),
            source_hash: self.source_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryKeyRef {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub key_purpose: String,
    pub engine_profile_id: String,
    pub source_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    pub redaction_status: HelperRedactionStatus,
}

impl SiglusParserBoundaryKeyRef {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_purpose: redact_for_log_or_report(&self.key_purpose),
            engine_profile_id: redact_for_log_or_report(&self.engine_profile_id),
            source_hash: self.source_hash.clone(),
            material_hash: self.material_hash.clone(),
            bytes: self.bytes,
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryTextSlot {
    pub text_slot_id: String,
    pub asset_id: String,
    pub source_hash: ProofHash,
    pub byte_span: SiglusParserBoundaryByteSpan,
    pub text_surface: String,
    pub parser_opcode: String,
}

impl SiglusParserBoundaryTextSlot {
    fn redacted_for_report(&self) -> Self {
        Self {
            text_slot_id: redact_for_log_or_report(&self.text_slot_id),
            asset_id: redact_for_log_or_report(&self.asset_id),
            source_hash: self.source_hash.clone(),
            byte_span: self.byte_span.clone(),
            text_surface: redact_for_log_or_report(&self.text_surface),
            parser_opcode: redact_for_log_or_report(&self.parser_opcode),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryByteSpan {
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusParserBoundaryDiagnostic {
    pub code: String,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_opcode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_span: Option<SiglusParserBoundaryByteSpan>,
}

impl SiglusParserBoundaryDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            unsupported_opcode: self.unsupported_opcode.clone(),
            byte_span: self.byte_span.clone(),
        }
    }
}

pub fn run_siglus_known_key_parser_boundary_smoke(
    request: SiglusParserBoundarySmokeRequest<'_>,
) -> KaifuuResult<SiglusParserBoundaryReport> {
    const PROFILE_ID: &str = "019ed000-0000-7000-8000-000000091001";
    const SUPPORT_BOUNDARY: &str = "Synthetic parser-boundary smoke only; this report validates key-ref plumbing and parser diagnostics for fixture inputs and does not claim production Siglus extraction, decryption, patch-back, or runtime compatibility.";

    let scene_hash = ProofHash::new(sha256_file_ref(request.scene_path)?)?;
    let gameexe_hash = ProofHash::new(sha256_file_ref(request.gameexe_path)?)?;
    let sources = vec![
        SiglusParserBoundarySource {
            asset_id: "siglus-scene-pck".to_string(),
            path: "Scene.pck".to_string(),
            source_hash: scene_hash.clone(),
        },
        SiglusParserBoundarySource {
            asset_id: "siglus-gameexe-dat".to_string(),
            path: "Gameexe.dat".to_string(),
            source_hash: gameexe_hash,
        },
    ];

    if request.variant == SiglusParserBoundarySmokeVariant::HelperRequired {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            vec![],
            vec![],
            SiglusParserBoundaryOutcome::HelperRequired,
            vec![SiglusParserBoundaryDiagnostic {
                code: "helper_required".to_string(),
                field: "keyRequest".to_string(),
                message: "parser-boundary smoke requires a key-ref helper request".to_string(),
                semantic_code: Some(SEMANTIC_HELPER_REQUIRED.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    }

    let Some(key_request) = request.key_request else {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            vec![],
            vec![],
            SiglusParserBoundaryOutcome::HelperRequired,
            vec![SiglusParserBoundaryDiagnostic {
                code: "helper_required".to_string(),
                field: "keyRequest".to_string(),
                message: "parser-boundary smoke requires a key-ref helper request".to_string(),
                semantic_code: Some(SEMANTIC_HELPER_REQUIRED.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    };

    let mut effective_key_request = key_request.clone();
    if request.variant == SiglusParserBoundarySmokeVariant::MissingKey {
        effective_key_request["keyRefs"] = Value::Array(vec![]);
    }

    let key_refs = siglus_parser_boundary_key_refs(&effective_key_request)?;
    if request.variant == SiglusParserBoundarySmokeVariant::OutOfProfile
        || effective_key_request
            .get("engineProfileId")
            .and_then(Value::as_str)
            .is_some_and(|profile_id| profile_id != PROFILE_ID)
        || effective_key_request
            .get("sourceHash")
            .and_then(Value::as_str)
            .is_some_and(|source_hash| source_hash != scene_hash.as_str())
    {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            key_refs,
            vec![],
            SiglusParserBoundaryOutcome::OutOfProfile,
            vec![SiglusParserBoundaryDiagnostic {
                code: "out_of_profile".to_string(),
                field: "keyRequest".to_string(),
                message: "key-ref request must match the synthetic Siglus parser-boundary profile id and Scene.pck source hash".to_string(),
                semantic_code: Some(SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    }

    let registry = fixture_helper_registry()?;
    let helper_output = registry.invoke(HelperRegistryInvocationRequest {
        helper_id: effective_key_request
            .get("helperId")
            .and_then(Value::as_str)
            .unwrap_or(FIXTURE_HELPER_REGISTRY_ID),
        helper_version: effective_key_request
            .get("helperVersion")
            .and_then(Value::as_str)
            .unwrap_or("0.1.0"),
        allowlist_entry_id: effective_key_request
            .get("allowlistEntryId")
            .and_then(Value::as_str)
            .unwrap_or(FIXTURE_HELPER_ALLOWLIST_REF_ID),
        capability: HelperCapability::KeyValidation,
        input: &effective_key_request,
    })?;
    let helper_code = helper_output
        .pointer("/diagnostic/code")
        .and_then(Value::as_str)
        .unwrap_or("validation_failed");
    if helper_code != "success" {
        let (outcome, semantic_code) = match helper_code {
            "missing_key" => (
                SiglusParserBoundaryOutcome::MissingKey,
                SEMANTIC_MISSING_KEY_MATERIAL,
            ),
            "helper_required" => (
                SiglusParserBoundaryOutcome::HelperRequired,
                SEMANTIC_HELPER_REQUIRED,
            ),
            _ => (
                SiglusParserBoundaryOutcome::OutOfProfile,
                SEMANTIC_KEY_VALIDATION_FAILED,
            ),
        };
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            key_refs,
            vec![],
            outcome,
            vec![SiglusParserBoundaryDiagnostic {
                code: helper_code.to_string(),
                field: "keyRequest".to_string(),
                message: helper_output
                    .pointer("/diagnostic/message")
                    .and_then(Value::as_str)
                    .unwrap_or(semantic_code)
                    .to_string(),
                semantic_code: Some(semantic_code.to_string()),
                unsupported_opcode: None,
                byte_span: None,
            }],
        ));
    }

    if request.variant == SiglusParserBoundarySmokeVariant::UnsupportedOpcode {
        return Ok(siglus_parser_boundary_report(
            PROFILE_ID,
            SUPPORT_BOUNDARY,
            sources,
            key_refs,
            vec![],
            SiglusParserBoundaryOutcome::UnsupportedOpcode,
            vec![SiglusParserBoundaryDiagnostic {
                code: "unsupported_opcode".to_string(),
                field: "Scene.pck@0x30".to_string(),
                message: "synthetic parser-boundary fixture contains an unsupported Siglus opcode before any patch write is allowed".to_string(),
                semantic_code: Some(SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE.to_string()),
                unsupported_opcode: Some("SIGLUS_SYNTH_UNSUPPORTED_7f".to_string()),
                byte_span: Some(SiglusParserBoundaryByteSpan {
                    start_byte: 48,
                    end_byte: 49,
                }),
            }],
        ));
    }

    Ok(siglus_parser_boundary_report(
        PROFILE_ID,
        SUPPORT_BOUNDARY,
        sources,
        key_refs,
        vec![
            SiglusParserBoundaryTextSlot {
                text_slot_id: "siglus.synthetic.scene.text.001".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                source_hash: scene_hash.clone(),
                byte_span: SiglusParserBoundaryByteSpan {
                    start_byte: 17,
                    end_byte: 52,
                },
                text_surface: "dialogue".to_string(),
                parser_opcode: "SIGLUS_SYNTH_TEXT_SLOT".to_string(),
            },
            SiglusParserBoundaryTextSlot {
                text_slot_id: "siglus.synthetic.scene.choice.001".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                source_hash: scene_hash,
                byte_span: SiglusParserBoundaryByteSpan {
                    start_byte: 53,
                    end_byte: 54,
                },
                text_surface: "choice_label".to_string(),
                parser_opcode: "SIGLUS_SYNTH_CHOICE_SLOT".to_string(),
            },
        ],
        SiglusParserBoundaryOutcome::ParserBoundarySuccess,
        vec![],
    ))
}

fn siglus_parser_boundary_report(
    profile_id: &str,
    support_boundary: &str,
    sources: Vec<SiglusParserBoundarySource>,
    key_refs: Vec<SiglusParserBoundaryKeyRef>,
    text_slots: Vec<SiglusParserBoundaryTextSlot>,
    outcome: SiglusParserBoundaryOutcome,
    diagnostics: Vec<SiglusParserBoundaryDiagnostic>,
) -> SiglusParserBoundaryReport {
    SiglusParserBoundaryReport {
        schema_version: SIGLUS_PARSER_BOUNDARY_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-siglus-known-key-parser-boundary-smoke".to_string(),
        profile_id: profile_id.to_string(),
        status: if outcome == SiglusParserBoundaryOutcome::ParserBoundarySuccess {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        outcome,
        support_boundary: support_boundary.to_string(),
        patch_write_attempted: false,
        sources,
        key_refs,
        text_slots,
        diagnostics,
    }
    .redacted_for_report()
}

fn siglus_parser_boundary_key_refs(
    request: &Value,
) -> KaifuuResult<Vec<SiglusParserBoundaryKeyRef>> {
    request
        .get("keyRefs")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|key_ref| {
            let requirement_id = key_ref.get("requirementId")?.as_str()?;
            let secret_ref = key_ref.get("secretRef")?.as_str()?;
            let key_purpose = key_ref.get("keyPurpose")?.as_str()?;
            let engine_profile_id = key_ref.get("engineProfileId")?.as_str()?;
            let source_hash = key_ref.get("sourceHash")?.as_str()?;
            Some((
                key_ref,
                requirement_id,
                secret_ref,
                key_purpose,
                engine_profile_id,
                source_hash,
            ))
        })
        .map(
            |(key_ref, requirement_id, secret_ref, key_purpose, engine_profile_id, source_hash)| {
                Ok(SiglusParserBoundaryKeyRef {
                    requirement_id: requirement_id.to_string(),
                    secret_ref: SecretRef::new(secret_ref.to_string())?,
                    key_purpose: key_purpose.to_string(),
                    engine_profile_id: engine_profile_id.to_string(),
                    source_hash: ProofHash::new(source_hash.to_string())?,
                    material_hash: key_ref
                        .get("materialHash")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .map(ProofHash::new)
                        .transpose()?,
                    bytes: key_ref
                        .get("bytes")
                        .and_then(Value::as_u64)
                        .and_then(|bytes| u32::try_from(bytes).ok()),
                    redaction_status: HelperRedactionStatus::Redacted,
                })
            },
        )
        .collect()
}
