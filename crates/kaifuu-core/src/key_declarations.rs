use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterKeyRequirementDeclaration {
    pub requirement_id: String,
    pub engine_family: String,
    pub material_kind: KeyMaterialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archive_parameters: Vec<ArchiveParameterDeclaration>,
    pub validation: AdapterKeyValidationDeclaration,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub semantic_errors: Vec<SemanticErrorCode>,
}

impl AdapterKeyRequirementDeclaration {
    pub fn sort_key(&self) -> (String, String, String) {
        (
            self.engine_family.clone(),
            self.requirement_id.clone(),
            serde_json::to_string(&self.material_kind).unwrap_or_default(),
        )
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            material_kind: self.material_kind,
            bytes: self.bytes,
            archive_parameters: self
                .archive_parameters
                .iter()
                .map(ArchiveParameterDeclaration::redacted_for_report)
                .collect(),
            validation: self.validation.clone(),
            semantic_errors: self.semantic_errors.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveParameterDeclaration {
    pub parameter_id: String,
    pub name: String,
    pub kind: ArchiveParameterKind,
    pub required: bool,
}

impl ArchiveParameterDeclaration {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            parameter_id: redact_for_log_or_report(&self.parameter_id),
            name: redact_for_log_or_report(&self.name),
            kind: self.kind,
            required: self.required,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterKeyValidationDeclaration {
    pub method: KeyValidationMethod,
    pub proof_required: bool,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if is_valid_secret_ref(&value) {
            Ok(Self(value))
        } else {
            Err("secretRef must use a local secret-ref scheme and must not contain raw key material, local paths, whitespace, parent traversal, or null bytes".to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn scheme(&self) -> SecretRefScheme {
        let (scheme, _) = self
            .0
            .split_once(':')
            .expect("SecretRef is validated before construction");
        match scheme {
            "local-secret" => SecretRefScheme::LocalSecret,
            "os-keychain" => SecretRefScheme::OsKeychain,
            "secret-manager" => SecretRefScheme::SecretManager,
            "prompt" => SecretRefScheme::Prompt,
            _ => unreachable!("SecretRef scheme is validated before construction"),
        }
    }

    pub fn name(&self) -> &str {
        let (_, name) = self
            .0
            .split_once(':')
            .expect("SecretRef is validated before construction");
        name
    }
}

impl fmt::Debug for SecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SecretRef")
            .field(&"<secret-ref>")
            .finish()
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyResolverErrorKind {
    MalformedRef,
    MissingSecret,
    HelperRequired,
    ExternalStoreUnavailable,
    PromptCancelled,
    OutOfPolicy,
    InvalidMaterial,
    ValidationFailed,
    StoreUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyResolverDiagnostic {
    pub code: SemanticErrorCode,
    pub kind: KeyResolverErrorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref_scheme: Option<SecretRefScheme>,
    pub message: String,
}

impl KeyResolverDiagnostic {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            code: self.code,
            kind: self.kind,
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref_scheme: self.secret_ref_scheme,
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct KeyResolverError {
    diagnostic: KeyResolverDiagnostic,
}

impl KeyResolverError {
    pub(crate) fn new(
        kind: KeyResolverErrorKind,
        code: SemanticErrorCode,
        requirement_id: Option<&str>,
        secret_ref_scheme: Option<SecretRefScheme>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            diagnostic: KeyResolverDiagnostic {
                code,
                kind,
                requirement_id: requirement_id.map(ToOwned::to_owned),
                secret_ref_scheme,
                message: message.into(),
            },
        }
    }

    pub fn malformed_ref(message: impl Into<String>) -> Self {
        Self::new(
            KeyResolverErrorKind::MalformedRef,
            SemanticErrorCode::MalformedSecretRef,
            None,
            None,
            message,
        )
    }

    pub fn missing_secret(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::MissingSecret,
            SemanticErrorCode::MissingKeyMaterial,
            Some(requirement_id),
            Some(scheme),
            "referenced local secret material was not found",
        )
    }

    pub fn helper_required(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::HelperRequired,
            SemanticErrorCode::HelperUnavailable,
            Some(requirement_id),
            Some(scheme),
            "secret ref scheme requires an external helper, keychain, secret manager, or prompt resolver",
        )
    }

    pub fn external_store_unavailable(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::ExternalStoreUnavailable,
            SemanticErrorCode::ExternalSecretUnavailable,
            Some(requirement_id),
            Some(scheme),
            "external secret resolver interface is unavailable for this ref scheme",
        )
    }

    pub fn prompt_cancelled(requirement_id: &str) -> Self {
        Self::new(
            KeyResolverErrorKind::PromptCancelled,
            SemanticErrorCode::PromptCancelled,
            Some(requirement_id),
            Some(SecretRefScheme::Prompt),
            "prompt secret resolver was cancelled before material was supplied",
        )
    }

    pub fn out_of_policy(
        requirement_id: Option<&str>,
        scheme: Option<SecretRefScheme>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(
            KeyResolverErrorKind::OutOfPolicy,
            SemanticErrorCode::SecretRefOutOfPolicy,
            requirement_id,
            scheme,
            message,
        )
    }

    pub fn invalid_material(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::InvalidMaterial,
            SemanticErrorCode::KeyValidationFailed,
            Some(requirement_id),
            Some(scheme),
            "resolved secret material did not match the key requirement shape",
        )
    }

    pub fn validation_failed(requirement_id: &str, scheme: SecretRefScheme) -> Self {
        Self::new(
            KeyResolverErrorKind::ValidationFailed,
            SemanticErrorCode::KeyValidationFailed,
            Some(requirement_id),
            Some(scheme),
            "resolved secret material failed key validation",
        )
    }

    pub fn store_unavailable(message: impl Into<String>) -> Self {
        Self::new(
            KeyResolverErrorKind::StoreUnavailable,
            SemanticErrorCode::MissingKeyMaterial,
            None,
            Some(SecretRefScheme::LocalSecret),
            message,
        )
    }

    pub fn kind(&self) -> KeyResolverErrorKind {
        self.diagnostic.kind
    }

    pub fn semantic_code(&self) -> SemanticErrorCode {
        self.diagnostic.code
    }

    pub fn diagnostic(&self) -> KeyResolverDiagnostic {
        self.redacted_diagnostic()
    }

    pub fn redacted_diagnostic(&self) -> KeyResolverDiagnostic {
        self.diagnostic.redacted_for_report()
    }
}

impl fmt::Debug for KeyResolverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyResolverError")
            .field("diagnostic", &self.redacted_diagnostic())
            .finish()
    }
}

impl fmt::Display for KeyResolverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let diagnostic = self.redacted_diagnostic();
        match (&diagnostic.requirement_id, diagnostic.secret_ref_scheme) {
            (Some(requirement_id), Some(scheme)) => write!(
                formatter,
                "{} for requirement {} using {}",
                diagnostic.code, requirement_id, scheme
            ),
            (Some(requirement_id), None) => {
                write!(
                    formatter,
                    "{} for requirement {}",
                    diagnostic.code, requirement_id
                )
            }
            (None, Some(scheme)) => write!(formatter, "{} using {}", diagnostic.code, scheme),
            (None, None) => formatter.write_str(diagnostic.code.as_str()),
        }
    }
}

impl std::error::Error for KeyResolverError {}
