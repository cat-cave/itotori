//! Generic Siglus engine-profile posture used by orchestration registries.
//!
//! This module describes a format family, rather than a particular title. It
//! records the cipher route and the reference through which a resolver may make
//! key material available, but it never accepts, stores, or serializes key
//! bytes. Vault-claim and secret resolution remain caller-owned.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::SecretRef;

/// Stable id used by registries to select the Siglus production profile.
pub const SIGLUS_ENGINE_PROFILE_ADAPTER_ID: &str = "kaifuu.siglus.engine-profile";
/// The format-family name shared by detection, extraction, and patchback.
pub const SIGLUS_ENGINE_FAMILY: &str = "siglus";
/// Stable generic profile id. It deliberately contains no title identity.
pub const SIGLUS_ENGINE_PROFILE_ID: &str = "siglus-scene-pck-gameexe-v1";
/// Generic reference name for material recovered from the engine executable.
pub const SIGLUS_EXE_ANGOU_KEY_REQUIREMENT_ID: &str = "siglus-exe-angou-key";

/// A cipher route the Siglus profile can drive end to end.
///
/// `Scene.pck` scene payloads and `Gameexe.dat` bodies are unwrapped through
/// the static exe-angou second layer, their respective constant XOR tables,
/// and Siglus LZSS. The key is recovered locally from `SiglusEngine.exe`; its
/// secret reference is metadata, never the material itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiglusCipherMethod {
    ExeAngouXorLzss,
}

impl SiglusCipherMethod {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExeAngouXorLzss => "exe_angou_xor_lzss",
        }
    }
}

/// Cipher metadata that can safely travel in an engine profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusCipherPosture {
    /// Every method the profile may invoke. Unknown methods fail closed.
    pub supported_methods: Vec<SiglusCipherMethod>,
    /// The requirement id reported to the orchestrator.
    pub key_requirement_id: String,
    /// A structured secret reference only; it must never contain raw bytes.
    pub secret_ref: SecretRef,
}

/// Registration-ready Siglus format-family profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusEngineProfile {
    pub profile_id: String,
    pub adapter_id: String,
    pub engine_family: String,
    pub cipher_posture: SiglusCipherPosture,
}

impl SiglusEngineProfile {
    /// The generic profile used for any independently detected Siglus title.
    /// The local-secret name is a resolver address, not key material.
    #[must_use]
    pub fn standard() -> Self {
        Self {
            profile_id: SIGLUS_ENGINE_PROFILE_ID.to_string(),
            adapter_id: SIGLUS_ENGINE_PROFILE_ADAPTER_ID.to_string(),
            engine_family: SIGLUS_ENGINE_FAMILY.to_string(),
            cipher_posture: SiglusCipherPosture {
                supported_methods: vec![SiglusCipherMethod::ExeAngouXorLzss],
                key_requirement_id: SIGLUS_EXE_ANGOU_KEY_REQUIREMENT_ID.to_string(),
                secret_ref: SecretRef::new("local-secret:siglus/exe-angou")
                    .expect("the built-in local secret reference is valid"),
            },
        }
    }

    /// Reject a method the profile did not explicitly declare.
    pub fn validate_cipher_method(
        &self,
        method: &str,
    ) -> Result<SiglusCipherMethod, SiglusEngineProfileError> {
        let parsed = match method {
            "exe_angou_xor_lzss" => SiglusCipherMethod::ExeAngouXorLzss,
            _ => {
                return Err(SiglusEngineProfileError::OutOfProfileCipherMethod {
                    method: method.to_string(),
                });
            }
        };
        if self.cipher_posture.supported_methods.contains(&parsed) {
            Ok(parsed)
        } else {
            Err(SiglusEngineProfileError::OutOfProfileCipherMethod {
                method: method.to_string(),
            })
        }
    }

    /// Report-safe primitive metadata for registry and orchestration output.
    /// This intentionally has no key bytes, source bytes, or title identity.
    #[must_use]
    pub fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("adapterId".to_string(), self.adapter_id.clone());
        metadata.insert("engineFamily".to_string(), self.engine_family.clone());
        metadata.insert("profileId".to_string(), self.profile_id.clone());
        metadata.insert(
            "supportedCipherMethods".to_string(),
            self.cipher_posture
                .supported_methods
                .iter()
                .map(|method| method.as_str())
                .collect::<Vec<_>>()
                .join(","),
        );
        metadata.insert(
            "keyRequirementId".to_string(),
            self.cipher_posture.key_requirement_id.clone(),
        );
        metadata.insert(
            "secretRef".to_string(),
            self.cipher_posture.secret_ref.as_str().to_string(),
        );
        metadata
    }
}

/// Semantic refusal emitted before an undeclared cipher is read or patched.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusEngineProfileError {
    #[error(
        "kaifuu.siglus.engine_profile.out_of_profile_cipher_method: cipher method {method:?} is not declared by {SIGLUS_ENGINE_PROFILE_ID}; supported: exe_angou_xor_lzss"
    )]
    OutOfProfileCipherMethod { method: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_profile_declares_only_the_supported_cipher_route() {
        let profile = SiglusEngineProfile::standard();
        assert_eq!(
            profile.validate_cipher_method("exe_angou_xor_lzss"),
            Ok(SiglusCipherMethod::ExeAngouXorLzss)
        );
        let error = profile
            .validate_cipher_method("unknown-cipher")
            .expect_err("unknown cipher must fail closed");
        assert!(
            error
                .to_string()
                .starts_with("kaifuu.siglus.engine_profile.out_of_profile_cipher_method")
        );
    }

    #[test]
    fn serializable_profile_contains_only_a_secret_reference() {
        let json = serde_json::to_value(SiglusEngineProfile::standard()).unwrap();
        assert_eq!(
            json["cipherPosture"]["secretRef"],
            "local-secret:siglus/exe-angou"
        );
        assert!(json.get("rawKey").is_none());
        assert!(json.get("keyBytes").is_none());
        assert!(json.get("rawBytes").is_none());
    }
}
