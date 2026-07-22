use super::*;

fn baseline_manifest() -> PortManifest {
    PortManifest {
        id: "utsushi-synthetic",
        name: "Synthetic Reference Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    }
}

#[test]
fn validate_accepts_well_formed_manifest() {
    let manifest = baseline_manifest();
    manifest.validate().expect("baseline manifest validates");
}

#[test]
fn validate_rejects_id_with_uppercase() {
    let manifest = PortManifest {
        id: "Utsushi-synthetic",
        ..baseline_manifest()
    };
    let error = manifest.validate().expect_err("must reject uppercase id");
    assert!(matches!(
        error,
        EnginePortError::ManifestInvalid {
            source: ManifestError::IdMalformed { .. }
        }
    ));
}

#[test]
fn validate_rejects_required_methods_missing_launch() {
    let manifest = PortManifest {
        required_methods: &[
            LifecycleStage::Observe,
            LifecycleStage::Capture,
            LifecycleStage::Shutdown,
        ],
        ..baseline_manifest()
    };
    let error = manifest.validate().expect_err("must reject missing launch");
    assert!(matches!(
        error,
        EnginePortError::ManifestInvalid {
            source: ManifestError::RequiredMethodsMismatch
        }
    ));
}

#[test]
fn validate_rejects_required_methods_missing_observe() {
    let manifest = PortManifest {
        required_methods: &[
            LifecycleStage::Launch,
            LifecycleStage::Capture,
            LifecycleStage::Shutdown,
        ],
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::ManifestInvalid {
            source: ManifestError::RequiredMethodsMismatch
        })
    ));
}

#[test]
fn validate_rejects_required_methods_missing_capture() {
    let manifest = PortManifest {
        required_methods: &[
            LifecycleStage::Launch,
            LifecycleStage::Observe,
            LifecycleStage::Shutdown,
        ],
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::ManifestInvalid {
            source: ManifestError::RequiredMethodsMismatch
        })
    ));
}

#[test]
fn validate_rejects_required_methods_missing_shutdown() {
    let manifest = PortManifest {
        required_methods: &[
            LifecycleStage::Launch,
            LifecycleStage::Observe,
            LifecycleStage::Capture,
        ],
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::ManifestInvalid {
            source: ManifestError::RequiredMethodsMismatch
        })
    ));
}

#[test]
fn validate_rejects_optional_method_outside_known_set() {
    // Required stage cannot also appear as an optional; the rule rejects
    // it as overlap. This guards against optional_methods containing
    // anything not in OPTIONAL_LIFECYCLE_STAGES via the same code path.
    let manifest = PortManifest {
        optional_methods: &[LifecycleStage::Capture],
        ..baseline_manifest()
    };
    let error = manifest.validate().expect_err("must reject overlap");
    assert!(matches!(
        error,
        EnginePortError::ManifestInvalid {
            source: ManifestError::OptionalMethodOutsideKnownSet { .. }
        }
    ));
}

#[test]
fn validate_rejects_capability_without_matching_lifecycle_method() {
    let manifest = PortManifest {
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
            PortCapability::Jump,
        ],
        ..baseline_manifest()
    };
    let error = manifest
        .validate()
        .expect_err("must reject undeclared lifecycle capability");
    assert!(matches!(
        error,
        EnginePortError::ManifestCapabilityDrift {
            capability: PortCapability::Jump,
            kind: DriftKind::UnclaimedImplementation,
        }
    ));
}

#[test]
fn validate_rejects_evidence_tier_above_fidelity_ceiling() {
    let manifest = PortManifest {
        fidelity_tier_max: FidelityTier::TraceOnly,
        evidence_tier_max: EvidenceTier::E3,
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::ManifestInvalid {
            source: ManifestError::EvidenceTierAboveFidelityCeiling { .. }
        })
    ));
}

#[test]
fn validate_detects_duplicate_env_key_beyond_thirty_two_entries() {
    // Regression: the old dedup used a fixed [Option<&str>; 32] buffer and
    // only recorded keys while seen_count < 32, so a duplicate between two
    // entries both *beyond* the 32nd slot was never detected. Build a
    // schema with 32 distinct keys followed by a duplicate pair at indices
    // 32 and 33 — both past the old cap — and require the duplicate to be
    // rejected.
    const fn ek(key: &'static str) -> EnvFieldSchema {
        EnvFieldSchema {
            key,
            shape: EnvFieldShape::Flag,
            required: false,
            purpose: "dup-scan filler",
        }
    }
    const SCHEMA: &[EnvFieldSchema] = &[
        ek("K00"),
        ek("K01"),
        ek("K02"),
        ek("K03"),
        ek("K04"),
        ek("K05"),
        ek("K06"),
        ek("K07"),
        ek("K08"),
        ek("K09"),
        ek("K10"),
        ek("K11"),
        ek("K12"),
        ek("K13"),
        ek("K14"),
        ek("K15"),
        ek("K16"),
        ek("K17"),
        ek("K18"),
        ek("K19"),
        ek("K20"),
        ek("K21"),
        ek("K22"),
        ek("K23"),
        ek("K24"),
        ek("K25"),
        ek("K26"),
        ek("K27"),
        ek("K28"),
        ek("K29"),
        ek("K30"),
        ek("K31"),
        // Indices 32 and 33: identical keys, both beyond the old 32-cap.
        ek("KDUP"),
        ek("KDUP"),
    ];
    let manifest = PortManifest {
        env_schema: SCHEMA,
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::ManifestInvalid {
            source: ManifestError::EnvFieldDuplicate { key: "KDUP" }
        })
    ));
}

#[test]
fn validate_rejects_env_schema_with_path_shape() {
    const SCHEMA: &[EnvFieldSchema] = &[EnvFieldSchema {
        key: "UTSUSHI_PORT_DIR",
        shape: EnvFieldShape::Path,
        required: false,
        purpose: "test forbidden path",
    }];
    let manifest = PortManifest {
        env_schema: SCHEMA,
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::EnvSchemaForbidsPath {
            shape: EnvFieldShape::Path,
            ..
        })
    ));
}

#[test]
fn validate_rejects_env_schema_with_local_path_shape() {
    const SCHEMA: &[EnvFieldSchema] = &[EnvFieldSchema {
        key: "UTSUSHI_LOCAL",
        shape: EnvFieldShape::LocalPath,
        required: false,
        purpose: "test forbidden local path",
    }];
    let manifest = PortManifest {
        env_schema: SCHEMA,
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::EnvSchemaForbidsPath {
            shape: EnvFieldShape::LocalPath,
            ..
        })
    ));
}

#[test]
fn validate_rejects_env_schema_with_secret_shape() {
    const SCHEMA: &[EnvFieldSchema] = &[EnvFieldSchema {
        key: "UTSUSHI_SECRET",
        shape: EnvFieldShape::Secret,
        required: false,
        purpose: "test forbidden secret",
    }];
    let manifest = PortManifest {
        env_schema: SCHEMA,
        ..baseline_manifest()
    };
    assert!(matches!(
        manifest.validate(),
        Err(EnginePortError::EnvSchemaForbidsPath {
            shape: EnvFieldShape::Secret,
            ..
        })
    ));
}

#[test]
fn validate_rejects_abi_version_outside_runner_support_is_runner_level() {
    // Manifest::validate intentionally does NOT check the runner's ABI
    // version list; that is the Runner's job. Confirm a manifest with
    // abi_version = 99 still passes structural validation.
    let manifest = PortManifest {
        abi_version: 99,
        ..baseline_manifest()
    };
    manifest
        .validate()
        .expect("structural validation ignores abi version");
}

#[test]
fn env_field_schema_rejects_uppercase_violation() {
    let schema = EnvFieldSchema {
        key: "lower_case",
        shape: EnvFieldShape::Flag,
        required: false,
        purpose: "x",
    };
    assert!(matches!(
        schema.validate(),
        Err(EnginePortError::ManifestInvalid {
            source: ManifestError::EnvFieldKeyMalformed { .. }
        })
    ));
}

#[test]
fn env_field_schema_validate_value_rejects_local_path() {
    let schema = EnvFieldSchema {
        key: "UTSUSHI_FLAG",
        shape: EnvFieldShape::Flag,
        required: false,
        purpose: "x",
    };
    assert!(matches!(
        schema.validate_value("/home/user/leak"),
        Err(EnginePortError::EnvUnredacted { .. })
    ));
}

#[test]
fn env_field_schema_validate_value_accepts_flag() {
    let schema = EnvFieldSchema {
        key: "UTSUSHI_FLAG",
        shape: EnvFieldShape::Flag,
        required: false,
        purpose: "x",
    };
    schema.validate_value("true").expect("flag accepts true");
}
