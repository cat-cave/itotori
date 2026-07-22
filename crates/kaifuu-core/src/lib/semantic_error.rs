use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum SemanticErrorCode {
    #[serde(rename = "kaifuu.missing_capability.key_profile")]
    MissingKeyProfile,
    #[serde(rename = "kaifuu.missing_key_material")]
    MissingKeyMaterial,
    #[serde(rename = "kaifuu.helper_unavailable")]
    HelperUnavailable,
    #[serde(rename = "kaifuu.helper_required")]
    HelperRequired,
    #[serde(rename = "kaifuu.key_validation_failed")]
    KeyValidationFailed,
    #[serde(rename = "kaifuu.secret_redacted")]
    SecretRedacted,
    #[serde(rename = "kaifuu.malformed_secret_ref")]
    MalformedSecretRef,
    #[serde(rename = "kaifuu.secret_ref_out_of_policy")]
    SecretRefOutOfPolicy,
    #[serde(rename = "kaifuu.external_secret_unavailable")]
    ExternalSecretUnavailable,
    #[serde(rename = "kaifuu.prompt_cancelled")]
    PromptCancelled,
    #[serde(rename = "kaifuu.protected_executable_unsupported")]
    ProtectedExecutableUnsupported,
    #[serde(rename = "kaifuu.unsupported_layered_transform")]
    UnsupportedLayeredTransform,
    #[serde(rename = "kaifuu.missing_capability.container")]
    MissingContainerCapability,
    #[serde(rename = "kaifuu.missing_capability.crypto")]
    MissingCryptoCapability,
    #[serde(rename = "kaifuu.missing_capability.codec")]
    MissingCodecCapability,
    #[serde(rename = "kaifuu.missing_capability.patch_back")]
    MissingPatchBackCapability,
    #[serde(rename = "kaifuu.unsupported_variant.encrypted")]
    UnsupportedVariantEncrypted,
    #[serde(rename = "kaifuu.unsupported_variant.packed")]
    UnsupportedVariantPacked,
    #[serde(rename = "kaifuu.unknown_engine_variant")]
    UnknownEngineVariant,
    #[serde(rename = "kaifuu.ambiguous_engine_variant")]
    AmbiguousEngineVariant,
    #[serde(rename = "kaifuu.unsupported_engine_variant")]
    UnsupportedEngineVariant,
}

impl SemanticErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingKeyProfile => SEMANTIC_MISSING_KEY_PROFILE,
            Self::MissingKeyMaterial => SEMANTIC_MISSING_KEY_MATERIAL,
            Self::HelperUnavailable => SEMANTIC_HELPER_UNAVAILABLE,
            Self::HelperRequired => SEMANTIC_HELPER_REQUIRED,
            Self::KeyValidationFailed => SEMANTIC_KEY_VALIDATION_FAILED,
            Self::SecretRedacted => SEMANTIC_SECRET_REDACTED,
            Self::MalformedSecretRef => SEMANTIC_MALFORMED_SECRET_REF,
            Self::SecretRefOutOfPolicy => SEMANTIC_SECRET_REF_OUT_OF_POLICY,
            Self::ExternalSecretUnavailable => SEMANTIC_EXTERNAL_SECRET_UNAVAILABLE,
            Self::PromptCancelled => SEMANTIC_PROMPT_CANCELLED,
            Self::ProtectedExecutableUnsupported => SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED,
            Self::UnsupportedLayeredTransform => SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM,
            Self::MissingContainerCapability => SEMANTIC_MISSING_CONTAINER_CAPABILITY,
            Self::MissingCryptoCapability => SEMANTIC_MISSING_CRYPTO_CAPABILITY,
            Self::MissingCodecCapability => SEMANTIC_MISSING_CODEC_CAPABILITY,
            Self::MissingPatchBackCapability => SEMANTIC_MISSING_PATCH_BACK_CAPABILITY,
            Self::UnsupportedVariantEncrypted => SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED,
            Self::UnsupportedVariantPacked => SEMANTIC_UNSUPPORTED_VARIANT_PACKED,
            Self::UnknownEngineVariant => SEMANTIC_UNKNOWN_ENGINE_VARIANT,
            Self::AmbiguousEngineVariant => SEMANTIC_AMBIGUOUS_ENGINE_VARIANT,
            Self::UnsupportedEngineVariant => SEMANTIC_UNSUPPORTED_ENGINE_VARIANT,
        }
    }
}

impl fmt::Display for SemanticErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}
