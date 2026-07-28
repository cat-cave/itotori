pub mod synthetic {
    use super::*;

    const STATIC_KEY_LABEL: &str = "wolf-profiled-production/static";
    const DYNAMIC_KEY_LABEL: &str = "wolf-profiled-production/dynamic";
    const RESEARCH_KEY_LABEL: &str = "wolf-profiled-production/research";

    fn proof_hash(byte: u8) -> ProofHash {
        ProofHash::new(format!("sha256:{}", format!("{byte:02x}").repeat(32)))
            .expect("synthetic proof hash is valid")
    }

    pub fn satisfied_helper(
        workflow: WolfProfiledHelperWorkflow,
        requirement_id: &str,
        secret_ref: &SecretRef,
    ) -> HelperResult {
        let boundary_kind = match workflow {
            WolfProfiledHelperWorkflow::DirectLocalKey
            | WolfProfiledHelperWorkflow::StaticKeyImport => {
                WolfHelperBoundaryKind::StaticKeyLocalImport
            }
            WolfProfiledHelperWorkflow::DynamicKeyHelper => {
                WolfHelperBoundaryKind::DynamicKeyLocalHelper
            }
        };
        HelperResult {
            schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-wolf-profiled-helper".to_string(),
            helper_result_id: format!("helper-result-kaifuu-wolf-profiled-{}", workflow.as_str()),
            profile_id: "kaifuu-wolf-profiled-helper".to_string(),
            helper: HelperProvenance {
                helper_id: "kaifuu.fixture.wolf-profiled-helper".to_string(),
                helper_version: "0.1.0".to_string(),
                helper_kind: boundary_kind.helper_kind(),
            },
            capability_level: boundary_kind.capability_level(),
            execution: HelperExecutionSummary {
                mode: boundary_kind.execution_mode(),
                platform: "fixture-local".to_string(),
                bounded: true,
                timeout_ms: 1000,
                duration_ms: Some(0),
                network_access: false,
                filesystem_access: HelperExecutionFilesystemAccess::ReadOnlyWorkspace,
            },
            diagnostic: HelperDiagnostic {
                code: HelperDiagnosticCode::Success,
                message: "synthetic Wolf profiled helper resolved the exact SecretRef".to_string(),
            },
            redaction: HelperRedaction {
                status: HelperRedactionStatus::Redacted,
                redacted_log_hash: proof_hash(0x58),
            },
            secret_refs: vec![HelperResultSecretRef {
                requirement_id: requirement_id.to_string(),
                secret_ref: secret_ref.clone(),
                material_kind: KeyMaterialKind::FixedBytes,
                bytes: None,
                validation: None,
            }],
            proof_hashes: vec![KeyValidationProof {
                method: KeyValidationMethod::ArchiveIndexProof,
                proof_hash: proof_hash(0x59),
            }],
        }
    }

    pub fn production_registry() -> WolfProfiledProductionRegistry {
        let static_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-static-key")
            .expect("synthetic secret ref is valid");
        let dynamic_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-dynamic-helper-key")
            .expect("synthetic secret ref is valid");
        let research_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-research-key")
            .expect("synthetic secret ref is valid");

        let static_req = "kaifuu-k058-wolf-static-key".to_string();
        let dynamic_req = "kaifuu-k058-wolf-dynamic-key".to_string();
        let research_req = "kaifuu-k058-wolf-research-key".to_string();

        let static_variant = WolfProfiledProductionVariant {
            variant_id: "kaifuu-k058-wolf-static-profile".to_string(),
            protection_profile: WolfProtectionProfile::Protected,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            helper_workflow: WolfProfiledHelperWorkflow::StaticKeyImport,
            secret_requirement_id: static_req.clone(),
            secret_ref: static_ref.clone(),
            helper_evidence: Some(satisfied_helper(
                WolfProfiledHelperWorkflow::StaticKeyImport,
                &static_req,
                &static_ref,
            )),
            tables: vec![
                WolfTextTable {
                    table_name: "ScenarioDB".to_string(),
                    field_count: 2,
                    records: vec![
                        vec![
                            "speaker-a".to_string(),
                            "synthetic-k058-line-before".to_string(),
                        ],
                        vec![
                            "speaker-b".to_string(),
                            "synthetic-k058-unchanged".to_string(),
                        ],
                    ],
                },
                WolfTextTable {
                    table_name: "MenuDB".to_string(),
                    field_count: 1,
                    records: vec![vec!["synthetic-menu=start".to_string()]],
                },
            ],
            patches: vec![WolfTextPatchRequest {
                table_name: "ScenarioDB".to_string(),
                record_index: 0,
                field_index: 1,
                new_text: "synthetic-k058-line-after-longer".to_string(),
            }],
            claimed: true,
        };

        let dynamic_variant = WolfProfiledProductionVariant {
            variant_id: "kaifuu-k058-wolf-dynamic-helper-profile".to_string(),
            protection_profile: WolfProtectionProfile::HelperRequired,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            helper_workflow: WolfProfiledHelperWorkflow::DynamicKeyHelper,
            secret_requirement_id: dynamic_req.clone(),
            secret_ref: dynamic_ref.clone(),
            helper_evidence: Some(satisfied_helper(
                WolfProfiledHelperWorkflow::DynamicKeyHelper,
                &dynamic_req,
                &dynamic_ref,
            )),
            tables: vec![
                WolfTextTable {
                    table_name: "EventDB".to_string(),
                    field_count: 1,
                    records: vec![
                        vec!["synthetic-k058-event-before".to_string()],
                        vec!["synthetic-k058-event-untouched".to_string()],
                    ],
                },
                WolfTextTable {
                    table_name: "ItemDB".to_string(),
                    field_count: 1,
                    records: vec![vec!["synthetic-item=potion".to_string()]],
                },
            ],
            patches: vec![WolfTextPatchRequest {
                table_name: "EventDB".to_string(),
                record_index: 0,
                field_index: 0,
                new_text: "synthetic-k058-event-after".to_string(),
            }],
            claimed: true,
        };

        let research_variant = WolfProfiledProductionVariant {
            variant_id: "kaifuu-k058-wolf-unclaimed-research-profile".to_string(),
            protection_profile: WolfProtectionProfile::Protected,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            helper_workflow: WolfProfiledHelperWorkflow::DirectLocalKey,
            secret_requirement_id: research_req.clone(),
            secret_ref: research_ref.clone(),
            helper_evidence: None,
            tables: vec![WolfTextTable {
                table_name: "ResearchDB".to_string(),
                field_count: 1,
                records: vec![vec!["synthetic-research-only".to_string()]],
            }],
            patches: Vec::new(),
            claimed: false,
        };

        WolfProfiledProductionRegistry {
            registry_id: deterministic_id("kaifuu-k058-wolf-profiled-production-registry", 1),
            variants: vec![static_variant, dynamic_variant, research_variant],
            archive_keys: resolver_from_fixture_labels(vec![
                (static_ref.as_str().to_string(), STATIC_KEY_LABEL),
                (dynamic_ref.as_str().to_string(), DYNAMIC_KEY_LABEL),
                (research_ref.as_str().to_string(), RESEARCH_KEY_LABEL),
            ]),
            resolved_keys: resolver_from_fixture_labels(vec![
                (static_ref.as_str().to_string(), STATIC_KEY_LABEL),
                (dynamic_ref.as_str().to_string(), DYNAMIC_KEY_LABEL),
            ]),
        }
    }

    /// Test seam: return the registry with its resolved-keys resolver rebuilt
    /// with a WRONG label for the static variant's ref, so the composed extract
    /// stage fails as a loud compatibility bug. Used by the
    /// smoke fail-loud test; the raw bytes still stay inside the module-private
    /// resolver.
    pub fn production_registry_with_wrong_resolved_key(
        mut registry: WolfProfiledProductionRegistry,
    ) -> WolfProfiledProductionRegistry {
        let static_ref = registry.variants[0].secret_ref.as_str().to_string();
        registry.resolved_keys =
            resolver_from_fixture_labels(vec![(static_ref, "wolf-profiled-production/wrong")]);
        registry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> WolfProfiledProductionRegistry {
        synthetic::production_registry()
    }

    #[test]
    fn profiled_wolf_variants_extract_and_patch_round_trip() {
        let report = run_wolf_profiled_production(&registry(), "synthetic-fixture")
            .expect("profiled run passes");
        assert!(report.is_ok());
        assert_eq!(report.claimed_count, 2);
        assert_eq!(report.not_claimed_count, 1);
        assert!(
            report
                .claimed_profiles
                .contains(&WolfProtectionProfile::Protected)
        );
        assert!(
            report
                .claimed_profiles
                .contains(&WolfProtectionProfile::HelperRequired)
        );

        let claimed: Vec<&WolfProfiledVariantReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                WolfProfiledOutcome::Claimed(report) => Some(report),
                WolfProfiledOutcome::NotClaimed(_) => None,
            })
            .collect();
        assert_eq!(claimed.len(), 2);
        for variant in claimed {
            assert!(variant.identity_byte_identical);
            assert_eq!(variant.members_patched, 1);
            assert_eq!(variant.members_byte_preserved, 1);
            assert_ne!(
                variant.source_archive_hash.as_str(),
                variant.rebuilt_archive_hash.as_str()
            );
            assert_eq!(variant.patch_reports.len(), 1);
            assert!(variant.patch_reports[0].patched_text_verified);
            assert!(variant.patch_reports[0].old_text_absent);
        }
    }

    #[test]
    fn claimed_but_broken_profile_fails_loud() {
        let mut registry = registry();
        let secret_ref = registry.variants[0].secret_ref.as_str().to_string();
        registry.resolved_keys =
            resolver_from_fixture_labels(vec![(secret_ref, "wolf-profiled-production/wrong")]);
        let err = run_wolf_profiled_production(&registry, "synthetic-fixture")
            .expect_err("wrong key is a compatibility bug");
        match err {
            WolfProfiledProductionError::ClaimedProfileFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k058-wolf-static-profile");
                assert_eq!(stage, "extract");
            }
            other @ WolfProfiledProductionError::Internal { .. } => {
                panic!("expected claimed profile failure, got {other}")
            }
        }
    }

    #[test]
    fn no_raw_key_leaks_through_debug_or_report() {
        let registry = registry();
        let debug = format!("{registry:?}");
        let report = run_wolf_profiled_production(&registry, "synthetic-fixture")
            .expect("profiled run passes");
        let json = report.stable_json().expect("stable json");

        for plaintext in [
            "synthetic-k058-line-before",
            "synthetic-k058-line-after-longer",
            "synthetic-k058-event-before",
            "synthetic-k058-event-after",
        ] {
            assert!(
                !json.contains(plaintext),
                "plaintext {plaintext} leaked through report"
            );
        }
        assert!(
            !registry.archive_keys.any_key_appears_in(debug.as_bytes()),
            "archive key appeared in registry Debug"
        );
        assert!(
            !registry.resolved_keys.any_key_appears_in(json.as_bytes()),
            "resolved key appeared in report JSON"
        );
    }

    #[test]
    fn helper_evidence_must_bind_exact_secret_ref() {
        let mut registry = registry();
        let requirement = registry.variants[1].secret_requirement_id.clone();
        let wrong_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-wrong-ref")
            .expect("synthetic secret ref is valid");
        registry.variants[1].helper_evidence = Some(synthetic::satisfied_helper(
            WolfProfiledHelperWorkflow::DynamicKeyHelper,
            &requirement,
            &wrong_ref,
        ));
        let err = run_wolf_profiled_production(&registry, "synthetic-fixture")
            .expect_err("wrong-ref helper evidence must not satisfy the gate");
        match err {
            WolfProfiledProductionError::ClaimedProfileFailed {
                variant_id,
                stage,
                cause,
                ..
            } => {
                assert_eq!(variant_id, "kaifuu-k058-wolf-dynamic-helper-profile");
                assert_eq!(stage, "evidence-check");
                assert!(cause.contains("exact SecretRef"));
            }
            other @ WolfProfiledProductionError::Internal { .. } => {
                panic!("expected claimed profile failure, got {other}")
            }
        }
    }

    #[test]
    fn unclaimed_profile_is_explicit_out_of_scope() {
        let report = run_wolf_profiled_production(&registry(), "synthetic-fixture")
            .expect("profiled run passes");
        let not_claimed: Vec<&WolfProfiledNotClaimedReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                WolfProfiledOutcome::NotClaimed(report) => Some(report),
                WolfProfiledOutcome::Claimed(_) => None,
            })
            .collect();
        assert_eq!(not_claimed.len(), 1);
        assert_eq!(
            not_claimed[0].variant_id,
            "kaifuu-k058-wolf-unclaimed-research-profile"
        );
        assert!(not_claimed[0].reason.contains("not claimed"));
    }
}

