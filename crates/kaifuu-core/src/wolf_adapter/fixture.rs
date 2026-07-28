//! Synthetic Wolf adapter fixture model.

use super::*;

// Fixture (input) schema

/// One synthetic Wolf text-table adapter fixture — pure data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfTextTableAdapterFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    /// The container's protection posture (detector evidence).
    pub detector: WolfProtectionDetectorFixtureEntry,
    /// The keyRef-bound container-key binding (helper-boundary
    /// evidence). Present for every keyRef-bound protected variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_boundary: Option<WolfHelperBoundaryProfile>,
    /// The local-scheme ref the container key is resolved by (never key bytes).
    pub secret_ref: SecretRef,
    /// The synthetic Wolf text tables (plaintext view; packed encrypted).
    pub tables: Vec<WolfTextTable>,
    /// The configured text-cell patch requests to apply before repack.
    pub patches: Vec<WolfTextPatchRequest>,
}

impl WolfTextTableAdapterFixture {
    /// The bounded synthetic fixture: a `protected` container with a locally
    /// resolvable static key, two Shift-JIS text tables, and two patch requests.
    pub fn synthetic() -> Self {
        use crate::wolf_protection_detector::WolfArchiveProtectionSignal;
        use crate::wolf_protection_detector::WolfSecretRequirement;

        let secret_ref = SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF)
            .expect("static synthetic secret ref is valid");
        let detector = WolfProtectionDetectorFixtureEntry {
            fixture_id: "wolf.adapter.protected".to_string(),
            variant: "synthetic-protected-textdb".to_string(),
            container: ContainerTransform::WolfArchive,
            protection_signal: WolfArchiveProtectionSignal::StaticKeyProtected,
            crypto: CryptoTransform::FixedKey,
            codec: CodecTransform::ShiftJisText,
            surface: SurfaceTransform::TableRecord,
            secret_requirements: vec![WolfSecretRequirement {
                requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
                key_ref: Some(secret_ref.clone()),
            }],
            expected_profile: WolfProtectionProfile::Protected,
            expected_semantic_codes: vec![
                SemanticErrorCode::UnsupportedLayeredTransform
                    .as_str()
                    .to_string(),
            ],
        };
        let helper_boundary = Some(synthetic_helper_profile(&secret_ref, true));
        let tables = vec![
            WolfTextTable {
                table_name: "CharacterDB".to_string(),
                field_count: 2,
                records: vec![
                    vec!["hero-name".to_string(), "テスト説明A".to_string()],
                    vec!["mage-name".to_string(), "テスト説明B".to_string()],
                ],
            },
            WolfTextTable {
                table_name: "SystemStrings".to_string(),
                field_count: 1,
                records: vec![
                    vec!["synthetic-menu=start".to_string()],
                    vec!["synthetic-menu=load".to_string()],
                ],
            },
            // An UNCHANGED table: no patch targets it, so the round-trip must
            // leave it byte-identical (exercised by the byte-identical test).
            WolfTextTable {
                table_name: "MenuStrings".to_string(),
                field_count: 1,
                records: vec![
                    vec!["synthetic-title=start".to_string()],
                    vec!["synthetic-title=config".to_string()],
                ],
            },
        ];
        let patches = vec![
            WolfTextPatchRequest {
                table_name: "CharacterDB".to_string(),
                record_index: 0,
                field_index: 1,
                new_text: "テスト説明A-改".to_string(),
            },
            WolfTextPatchRequest {
                table_name: "SystemStrings".to_string(),
                record_index: 0,
                field_index: 0,
                new_text: "synthetic-menu=begin".to_string(),
            },
        ];
        Self {
            schema_version: WOLF_ADAPTER_SCHEMA_VERSION.to_string(),
            fixture_id: "wolf-text-table-adapter-synthetic".to_string(),
            source_node_id: "synthetic-fixture".to_string(),
            engine_family: WOLF_ENGINE_FAMILY.to_string(),
            detector,
            helper_boundary,
            secret_ref,
            tables,
            patches,
        }
    }
}

/// Build a synthetic helper-boundary profile bound to `secret_ref`.
/// `locally_available` toggles the `key_resolved` vs `key_missing` outcome.
pub(super) fn synthetic_helper_profile(
    secret_ref: &SecretRef,
    locally_available: bool,
) -> WolfHelperBoundaryProfile {
    use crate::wolf_helper_boundary::{
        WolfHelperBoundaryKind, WolfHelperBoundaryOutcome, WolfHelperKeyRequirement,
    };
    WolfHelperBoundaryProfile {
        fixture_id: "wolf.adapter.static-key".to_string(),
        profile_id: "wolf.adapter.static-key".to_string(),
        boundary_kind: WolfHelperBoundaryKind::StaticKeyLocalImport,
        key_requirement: WolfHelperKeyRequirement {
            requirement_id: WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID.to_string(),
            key_ref: secret_ref.clone(),
            material_kind: KeyMaterialKind::FixedBytes,
        },
        locally_available,
        expected_outcome: if locally_available {
            WolfHelperBoundaryOutcome::KeyResolved
        } else {
            WolfHelperBoundaryOutcome::KeyMissing
        },
    }
}
