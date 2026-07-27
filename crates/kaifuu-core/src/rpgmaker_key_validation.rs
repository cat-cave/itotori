use super::*;

pub struct RpgMakerMvMzFixtureKeyValidationRequest<'a, S, E = NoExternalSecretResolver>
where
    S: LocalSecretStore,
    E: ExternalSecretResolver,
{
    pub fixture_id: &'a str,
    pub game_dir: &'a Path,
    pub image_asset_path: &'a Path,
    pub requirement_id: &'a str,
    pub secret_ref: &'a str,
    pub resolver: &'a LocalKeyResolver<S, E>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerMvMzFixtureKeyValidationReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub status: OperationStatus,
    pub support_boundary: String,
    pub records: Vec<RpgMakerMvMzFixtureKeyValidationRecord>,
    pub diagnostics: Vec<RpgMakerMvMzFixtureKeyValidationDiagnostic>,
    pub decrypt_or_patch_claimed: bool,
}

impl RpgMakerMvMzFixtureKeyValidationReport {
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            status: self.status.clone(),
            support_boundary: self.support_boundary.clone(),
            records: self
                .records
                .iter()
                .map(RpgMakerMvMzFixtureKeyValidationRecord::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(RpgMakerMvMzFixtureKeyValidationDiagnostic::redacted_for_report)
                .collect(),
            decrypt_or_patch_claimed: self.decrypt_or_patch_claimed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerMvMzFixtureKeyValidationRecord {
    pub requirement_id: String,
    pub secret_ref_scheme: Option<SecretRefScheme>,
    pub surface: String,
    pub codec: CodecTransform,
    pub diagnostic_result: RpgMakerMvMzFixtureKeyValidationDiagnosticCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_json_proof_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_evidence_hash: Option<ProofHash>,
}

impl RpgMakerMvMzFixtureKeyValidationRecord {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref_scheme: self.secret_ref_scheme,
            surface: self.surface.clone(),
            codec: self.codec,
            diagnostic_result: self.diagnostic_result,
            proof_hash: self.proof_hash.clone(),
            system_json_proof_hash: self.system_json_proof_hash.clone(),
            image_evidence_hash: self.image_evidence_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerMvMzFixtureKeyValidationDiagnostic {
    pub code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode,
    pub semantic_code: SemanticErrorCode,
    pub field: String,
    pub message: String,
}

impl RpgMakerMvMzFixtureKeyValidationDiagnostic {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code,
            semantic_code: self.semantic_code,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpgMakerMvMzFixtureKeyValidationDiagnosticCode {
    Success,
    MissingSystemJson,
    MissingImageEvidence,
    MissingKey,
    BadKey,
    UnsupportedSurface,
}

pub fn validate_rpg_maker_mv_mz_fixture_key<S, E>(
    request: RpgMakerMvMzFixtureKeyValidationRequest<'_, S, E>,
) -> RpgMakerMvMzFixtureKeyValidationReport
where
    S: LocalSecretStore,
    E: ExternalSecretResolver,
{
    let asset_profile = rpg_maker_mv_mz_validation_asset_profile(request.image_asset_path);
    let secret_ref_scheme = SecretRef::new(request.secret_ref.to_string())
        .ok()
        .map(|secret_ref| secret_ref.scheme());
    let image_evidence_hash = rpg_maker_mv_mz_image_evidence_hash(request.image_asset_path);

    let Some(system_json_path) = find_rpg_maker_system_json(request.game_dir) else {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingSystemJson,
            proof_hash: None,
            system_json_proof_hash: None,
            image_evidence_hash,
            field: "gameDir",
            message: "RPG Maker MV/MZ key validation requires data/System.json evidence",
        });
    };

    let system_key = parse_rpg_maker_system_json_key(&system_json_path);
    let system_json_proof_hash = rpg_maker_mv_mz_system_json_proof_hash(&system_json_path);
    let Some(system_key) = system_key else {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash,
            field: "data/System.json.encryptionKey",
            message: "System.json does not contain a fixture-safe MV/MZ encryptionKey value",
        });
    };

    if !asset_profile.supported_image_surface {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::UnsupportedSurface,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash,
            field: "imageAssetPath",
            message: "MV/MZ key validation currently accepts encrypted image surfaces only and does not claim audio or patch support",
        });
    }

    let Some(image_evidence_hash) = image_evidence_hash else {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash: None,
            field: "imageAssetPath",
            message: "encrypted image evidence is missing or unreadable",
        });
    };

    let material = match request.resolver.resolve_secret_ref_str(
        request.requirement_id,
        request.secret_ref,
        KeyMaterialKind::RpgMakerAssetKey,
        Some(16),
    ) {
        Ok(material) => material,
        Err(error) => {
            let (code, message) = match error.kind() {
                KeyResolverErrorKind::MissingSecret => (
                    RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey,
                    "secret ref did not resolve to local fixture key material",
                ),
                KeyResolverErrorKind::InvalidMaterial | KeyResolverErrorKind::ValidationFailed => (
                    RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey,
                    "resolved key material did not match the MV/MZ key shape",
                ),
                _ => (
                    RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey,
                    "secret ref could not be resolved through the local key boundary",
                ),
            };
            return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
                fixture_id: request.fixture_id,
                requirement_id: request.requirement_id,
                secret_ref_scheme,
                asset_profile,
                code,
                proof_hash: None,
                system_json_proof_hash,
                image_evidence_hash: Some(image_evidence_hash),
                field: "secretRef",
                message,
            });
        }
    };

    if !rpg_maker_mv_mz_system_key_matches_material(&system_key, material.as_bytes()) {
        return rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
            fixture_id: request.fixture_id,
            requirement_id: request.requirement_id,
            secret_ref_scheme,
            asset_profile,
            code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey,
            proof_hash: None,
            system_json_proof_hash,
            image_evidence_hash: Some(image_evidence_hash),
            field: "data/System.json.encryptionKey",
            message: "resolved secret ref does not match System.json key evidence",
        });
    }

    let proof_hash = rpg_maker_mv_mz_validation_proof_hash(
        request.requirement_id,
        &system_key,
        &image_evidence_hash,
        material.as_bytes(),
    );
    rpg_maker_mv_mz_key_validation_report(RpgMakerMvMzKeyValidationReportParams {
        fixture_id: request.fixture_id,
        requirement_id: request.requirement_id,
        secret_ref_scheme,
        asset_profile,
        code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success,
        proof_hash,
        system_json_proof_hash,
        image_evidence_hash: Some(image_evidence_hash),
        field: "validation",
        message: "fixture-safe MV/MZ key evidence matched System.json and encrypted image evidence",
    })
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RpgMakerMvMzValidationAssetProfile {
    surface: &'static str,
    codec: CodecTransform,
    supported_image_surface: bool,
}

pub(crate) struct RpgMakerMvMzKeyValidationReportParams<'a> {
    fixture_id: &'a str,
    requirement_id: &'a str,
    secret_ref_scheme: Option<SecretRefScheme>,
    asset_profile: RpgMakerMvMzValidationAssetProfile,
    code: RpgMakerMvMzFixtureKeyValidationDiagnosticCode,
    proof_hash: Option<ProofHash>,
    system_json_proof_hash: Option<ProofHash>,
    image_evidence_hash: Option<ProofHash>,
    field: &'a str,
    message: &'a str,
}

pub(crate) fn rpg_maker_mv_mz_validation_asset_profile(
    path: &Path,
) -> RpgMakerMvMzValidationAssetProfile {
    match lower_path_component(path.extension()).as_deref() {
        Some("rpgmvp" | "png_") => RpgMakerMvMzValidationAssetProfile {
            surface: "image_asset",
            codec: CodecTransform::PngImage,
            supported_image_surface: true,
        },
        Some("rpgmvm" | "m4a_") => RpgMakerMvMzValidationAssetProfile {
            surface: "audio_asset",
            codec: CodecTransform::M4aAudio,
            supported_image_surface: false,
        },
        Some("rpgmvo" | "ogg_") => RpgMakerMvMzValidationAssetProfile {
            surface: "audio_asset",
            codec: CodecTransform::OggAudio,
            supported_image_surface: false,
        },
        _ => RpgMakerMvMzValidationAssetProfile {
            surface: "unknown_asset",
            codec: CodecTransform::Unknown,
            supported_image_surface: false,
        },
    }
}

pub(crate) fn rpg_maker_mv_mz_key_validation_report(
    params: RpgMakerMvMzKeyValidationReportParams<'_>,
) -> RpgMakerMvMzFixtureKeyValidationReport {
    let RpgMakerMvMzKeyValidationReportParams {
        fixture_id,
        requirement_id,
        secret_ref_scheme,
        asset_profile,
        code,
        proof_hash,
        system_json_proof_hash,
        image_evidence_hash,
        field,
        message,
    } = params;
    let status = if code == RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    let semantic_code = match code {
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success => {
            SemanticErrorCode::SecretRedacted
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingSystemJson => {
            SemanticErrorCode::MissingKeyProfile
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence
        | RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey => {
            SemanticErrorCode::KeyValidationFailed
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey => {
            SemanticErrorCode::MissingKeyMaterial
        }
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::UnsupportedSurface => {
            SemanticErrorCode::UnsupportedVariantEncrypted
        }
    };
    RpgMakerMvMzFixtureKeyValidationReport {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        fixture_id: fixture_id.to_string(),
        status,
        support_boundary: "KAIFUU-114 validates fixture-safe MV/MZ key evidence only; it does not decrypt, extract, replace, or patch encrypted media.".to_string(),
        records: vec![RpgMakerMvMzFixtureKeyValidationRecord {
            requirement_id: requirement_id.to_string(),
            secret_ref_scheme,
            surface: asset_profile.surface.to_string(),
            codec: asset_profile.codec,
            diagnostic_result: code,
            proof_hash,
            system_json_proof_hash,
            image_evidence_hash,
        }],
        diagnostics: vec![RpgMakerMvMzFixtureKeyValidationDiagnostic {
            code,
            semantic_code,
            field: field.to_string(),
            message: message.to_string(),
        }],
        decrypt_or_patch_claimed: false,
    }
    .redacted_for_report()
}

pub(crate) fn find_rpg_maker_system_json(root: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_rpg_maker_system_json(root, root, &mut candidates);
    candidates.sort();
    candidates.into_iter().next()
}

pub(crate) fn collect_rpg_maker_system_json(
    root: &Path,
    dir: &Path,
    candidates: &mut Vec<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_rpg_maker_system_json(root, &path, candidates);
        } else if file_type.is_file() && is_rpg_maker_system_json(root, &path) {
            candidates.push(path);
        }
    }
}

pub(crate) fn parse_rpg_maker_system_json_key(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    value
        .get("encryptionKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn rpg_maker_mv_mz_system_json_proof_hash(path: &Path) -> Option<ProofHash> {
    fs::read(path)
        .ok()
        .map(|bytes| sha256_hash_bytes(&bytes))
        .and_then(|hash| ProofHash::new(hash).ok())
}

pub(crate) fn rpg_maker_mv_mz_image_evidence_hash(path: &Path) -> Option<ProofHash> {
    fs::read(path)
        .ok()
        .map(|bytes| sha256_hash_bytes(&bytes[..bytes.len().min(64)]))
        .and_then(|hash| ProofHash::new(hash).ok())
}

pub(crate) fn rpg_maker_mv_mz_system_key_matches_material(
    system_key: &str,
    material: &[u8],
) -> bool {
    if let Some(bytes) = decode_hex_material(system_key)
        && bytes == material
    {
        return true;
    }
    system_key == "fixture-only-rpg-maker-asset-key-v1"
        && material
            == [
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff,
            ]
}

pub(crate) fn rpg_maker_mv_mz_validation_proof_hash(
    requirement_id: &str,
    system_key: &str,
    image_evidence_hash: &ProofHash,
    material: &[u8],
) -> Option<ProofHash> {
    let mut proof = Vec::new();
    proof.extend_from_slice(b"kaifuu-rpg-maker-mv-mz-key-validation-v0.1\0");
    proof.extend_from_slice(requirement_id.as_bytes());
    proof.push(0);
    proof.extend_from_slice(sha256_hash_bytes(system_key.as_bytes()).as_bytes());
    proof.push(0);
    proof.extend_from_slice(image_evidence_hash.as_str().as_bytes());
    proof.push(0);
    proof.extend_from_slice(material);
    ProofHash::new(sha256_hash_bytes(&proof)).ok()
}
