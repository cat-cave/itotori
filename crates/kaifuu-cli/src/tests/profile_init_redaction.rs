use super::*;

/// Sensitive free-text planted by the profile-init redaction fixture.
/// These values must pass profile validation (they live in non-secret-scan
/// free-text fields / metadata) and must be scrubbed by the init write gate's
/// `redact_report_value` pass — the same gate used by generated profile report
/// writes.
const PROFILE_INIT_REDACTION_PROBES: &[(&str, &str)] = &[
    ("absoluteUnixRoot", "/home/dev/game/private/key.bin"),
    ("homeEnvFragment", "$HOME/games/private/key.bin"),
    (
        "userProfileFragment",
        "%USERPROFILE%\\Games\\SecretRoute\\key.bin",
    ),
    ("tildeHomeFragment", "~/games/private/source.ks"),
    ("hexMaterialProbe", "00112233445566778899aabbccddeeff"),
    ("helperDumpMarker", "helper dump registers and memory"),
    ("privateTextMarker", "contains decrypted text marker"),
    ("sensitiveFilename", "private-route-ending.ks"),
];

/// Committed golden for the redacted `profile init` output of
/// [`ProfileInitRedactionAdapter`]. Regen by setting
/// `KAIFUU_PROFILE_INIT_REDACTION_REGEN=1`.
const PROFILE_INIT_REDACTION_GOLDEN: &str = r#"{
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0001501",
      "assetKind": "script",
      "patching": {
        "capability": "patching",
        "limitation": null,
        "status": "supported"
      },
      "path": "source.ks",
      "sourceHash": "a1f5262c8bf3e457",
      "textSurfaces": ["dialogue"]
    }
  ],
  "capabilities": [
    {
      "capability": "detection",
      "limitation": null,
      "status": "supported"
    },
    {
      "capability": "patching",
      "limitation": null,
      "status": "supported"
    },
    {
      "capability": "profile_generation",
      "limitation": null,
      "status": "supported"
    }
  ],
  "engine": {
    "adapterId": "kaifuu.test.profile-init-redaction",
    "detectedVariant": "profile-init-redaction",
    "engineFamily": "profile-init-redaction-test",
    "engineVersion": null
  },
  "gameId": "profile-init-redaction-game",
  "metadata": {
    "absoluteUnixRoot": "[REDACTED:kaifuu.secret_redacted]",
    "helperDumpMarker": "[REDACTED:kaifuu.secret_redacted]",
    "hexMaterialProbe": "[REDACTED:kaifuu.secret_redacted]",
    "homeEnvFragment": "[REDACTED:kaifuu.secret_redacted]",
    "privateTextMarker": "[REDACTED:kaifuu.secret_redacted]",
    "sensitiveFilename": "[REDACTED:kaifuu.secret_redacted]",
    "tildeHomeFragment": "[REDACTED:kaifuu.secret_redacted]",
    "userProfileFragment": "[REDACTED:kaifuu.secret_redacted]"
  },
  "profileId": "019ed000-0000-7000-8000-profile01501",
  "requirements": [],
  "schemaVersion": "0.1.0",
  "sourceLocale": "ja-JP",
  "title": "[REDACTED:kaifuu.secret_redacted]"
}
"#;

struct ProfileInitRedactionAdapter;

impl EngineAdapter for ProfileInitRedactionAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.profile-init-redaction"
    }

    fn name(&self) -> &'static str {
        "Kaifuu profile-init redaction fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::Patching),
            ],
            AdapterCapabilityMatrix::new(
                self.id(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::unsupported(
                    "profile-init redaction fixture does not list assets",
                ),
                CapabilityLevelStatus::unsupported(
                    "profile-init redaction fixture does not extract",
                ),
                CapabilityLevelStatus::supported(),
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("profile-init-redaction-test".to_string()),
            engine_version: None,
            detected_variant: Some("profile-init-redaction".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        let mut metadata = BTreeMap::new();
        for (key, value) in PROFILE_INIT_REDACTION_PROBES {
            metadata.insert((*key).to_string(), (*value).to_string());
        }
        Ok(GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 1501),
            game_id: "profile-init-redaction-game".to_string(),
            // Title carries raw key material; free-text title is not rejected by
            // the secret-scan gate, but the write gate must redact it.
            title: "Profile Init Redaction Fixture 00112233445566778899aabbccddeeff".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: self.id().to_string(),
                engine_family: "profile-init-redaction-test".to_string(),
                engine_version: None,
                detected_variant: "profile-init-redaction".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 1501),
                path: "source.ks".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("profile-init redaction source")),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            layered_access: None,
            capabilities: self.capabilities().reports,
            requirements: vec![],
            metadata,
        })
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the profile-init redaction fixture".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the profile-init redaction fixture".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the profile-init redaction fixture".into())
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch is not used by the profile-init redaction fixture".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the profile-init redaction fixture".into())
    }
}

fn profile_init_redaction_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(ProfileInitRedactionAdapter);
    registry
}

fn assert_profile_init_probes_redacted(surface: &str) {
    assert!(
        surface.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
        "profile init output must carry the redaction sentinel: {surface}"
    );
    for (label, probe) in PROFILE_INIT_REDACTION_PROBES {
        assert!(
            !surface.contains(probe),
            "profile init leaked {label} probe `{probe}`: {surface}"
        );
    }
    // Title-level key material (also planted outside metadata).
    assert!(
        !surface.contains("00112233445566778899aabbccddeeff"),
        "profile init leaked raw key material from title: {surface}"
    );
    assert_no_sensitive_profile_material(surface);
}

#[test]
fn profile_init_redacts_sensitive_adapter_payloads() {
    // Command-specific regression for `kaifuu profile init`: the init path
    // must apply the same `redact_report_value` write gate as generated
    // profile report writes. Unlike the write-gate rejection test (invalid
    // free-text in description/placeholder), this fixture is VALID and must
    // still scrub absolute paths, home/env fragments, key material, helper
    // dumps, and private text markers from the persisted init output.
    let root = temp_dir("profile-init-redaction");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let output = root.join("profile.json");
    let registry = profile_init_redaction_registry();

    // Sanity: the adapter payload itself is valid before redaction.
    let raw_profile = ProfileInitRedactionAdapter
        .profile(ProfileRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    assert_eq!(
        raw_profile.validate().status,
        OperationStatus::Passed,
        "profile-init redaction fixture must be validation-valid so the init path reaches the write gate"
    );
    for (_, probe) in PROFILE_INIT_REDACTION_PROBES {
        assert!(
            raw_profile.metadata.values().any(|value| value == *probe)
                || raw_profile.title.contains(probe),
            "fixture must plant probe before redaction: {probe}"
        );
    }

    run_cli_with_registry(
        &[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &registry,
    );

    let serialized = fs::read_to_string(&output).unwrap();
    assert_profile_init_probes_redacted(&serialized);

    // Every planted metadata probe field must be present and fully redacted.
    let written: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    for (key, _) in PROFILE_INIT_REDACTION_PROBES {
        assert_eq!(
            written["metadata"][*key],
            format!("[REDACTED:{}]", kaifuu_core::SEMANTIC_SECRET_REDACTED),
            "metadata.{key} must be fully redacted in profile init output"
        );
    }
    assert_eq!(
        written["title"],
        format!("[REDACTED:{}]", kaifuu_core::SEMANTIC_SECRET_REDACTED),
        "title carrying key material must be fully redacted"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_init_redacted_output_matches_golden() {
    let root = temp_dir("profile-init-redaction-golden");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let output = root.join("profile.json");
    let registry = profile_init_redaction_registry();

    run_cli_with_registry(
        &[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &registry,
    );

    let produced = fs::read_to_string(&output).unwrap();
    if std::env::var_os("KAIFUU_PROFILE_INIT_REDACTION_REGEN").is_some() {
        eprintln!(
            "KAIFUU_PROFILE_INIT_REDACTION_REGEN is set; paste this into PROFILE_INIT_REDACTION_GOLDEN:\n{produced}"
        );
    }
    assert_eq!(
        produced, PROFILE_INIT_REDACTION_GOLDEN,
        "profile init redacted output drifted from the committed golden; set KAIFUU_PROFILE_INIT_REDACTION_REGEN=1 and update PROFILE_INIT_REDACTION_GOLDEN"
    );
    assert_profile_init_probes_redacted(&produced);

    let _ = fs::remove_dir_all(root);
}
