use super::*;

fn registry() -> Xp3ProductionRegistry {
    synthetic::production_registry()
}

#[test]
fn profiled_variants_extract_and_patch_round_trip() {
    let report = run_xp3_production(&registry(), "xp3-production").expect("production run passes");
    assert!(report.is_ok());
    assert_eq!(report.claimed_count, 2);
    assert_eq!(report.not_claimed_count, 1);

    // Engine-general: ≥2 DISTINCT crypt schemes were claimed + round-tripped
    // purely from data, no per-game branch.
    assert!(
        report
            .claimed_profiles
            .contains(&Xp3CryptoProfile::XorSimpleCryptFixture)
    );
    assert!(
        report
            .claimed_profiles
            .contains(&Xp3CryptoProfile::XorPositionCryptFixture)
    );

    // Every claimed outcome proved identity byte-identical + a real patch.
    let claimed: Vec<&Xp3ProductionVariantReport> = report
        .outcomes
        .iter()
        .filter_map(|outcome| match outcome {
            Xp3ProductionOutcome::Claimed(report) => Some(report),
            Xp3ProductionOutcome::NotClaimed(_) => None,
        })
        .collect();
    assert_eq!(claimed.len(), 2);
    for variant in &claimed {
        assert_eq!(variant.status, OperationStatus::Passed);
        assert!(variant.identity_byte_identical);
        assert_eq!(variant.members_patched, 1);
        assert_ne!(
            variant.source_container_hash.as_str(),
            variant.rebuilt_container_hash.as_str()
        );
        // The changed member records a non-zero length delta.
        let changed = variant
            .members
            .iter()
            .find(|m| m.operation == Xp3ProductionMemberOperation::Replace)
            .expect("one member changed");
        assert_ne!(changed.length_delta, 0);
    }

    // The manual-entry variant consumed helper evidence.
    let position = claimed
        .iter()
        .find(|v| v.crypto_profile == Xp3CryptoProfile::XorPositionCryptFixture)
        .expect("position variant present");
    assert_eq!(position.helper_workflow, Xp3HelperWorkflow::ManualKeyEntry);
    assert!(position.helper_evidence_present);
}

#[test]
fn unclaimed_variant_is_explicit_out_of_scope_not_a_silent_skip() {
    let report = run_xp3_production(&registry(), "xp3-production").expect("production run passes");
    let not_claimed: Vec<&Xp3ProductionNotClaimedReport> = report
        .outcomes
        .iter()
        .filter_map(|outcome| match outcome {
            Xp3ProductionOutcome::NotClaimed(report) => Some(report),
            Xp3ProductionOutcome::Claimed(_) => None,
        })
        .collect();
    assert_eq!(not_claimed.len(), 1);
    assert_eq!(not_claimed[0].variant_id, "kaifuu-k057-xp3-research-only");
    assert!(not_claimed[0].reason.contains("not claimed"));
}

#[test]
fn claimed_variant_missing_key_evidence_fails_loud() {
    // A claimed variant whose required key evidence is absent must be a BUG,
    // not a silent skip.
    let mut registry = registry();
    registry.variants[0].set_resolved_key_evidence(None);
    let err =
        run_xp3_production(&registry, "xp3-production").expect_err("missing key evidence is a bug");
    match err {
        Xp3ProductionError::ClaimedVariantFailed {
            variant_id, stage, ..
        } => {
            assert_eq!(variant_id, "kaifuu-k057-xp3-simple-crypt");
            assert_eq!(stage, "evidence-check");
        }
        other @ Xp3ProductionError::Internal { .. } => {
            panic!("expected ClaimedVariantFailed, got {other}")
        }
    }
}

#[test]
fn claimed_variant_missing_helper_evidence_fails_loud() {
    // A helper-gated claimed variant whose helper result is absent is a bug.
    let mut registry = registry();
    registry.variants[1].helper_evidence = None;
    let err = run_xp3_production(&registry, "xp3-production")
        .expect_err("missing helper evidence is a bug");
    match err {
        Xp3ProductionError::ClaimedVariantFailed {
            variant_id, stage, ..
        } => {
            assert_eq!(variant_id, "kaifuu-k057-xp3-position-crypt");
            assert_eq!(stage, "evidence-check");
        }
        other @ Xp3ProductionError::Internal { .. } => {
            panic!("expected ClaimedVariantFailed, got {other}")
        }
    }
}

#[test]
fn claimed_variant_wrong_key_evidence_fails_loud_on_integrity() {
    // A claimed variant whose resolved key does not match the archive key
    // trips the adlr integrity check — a loud bug at the extract stage, never
    // a silent pass.
    let mut registry = registry();
    let secret_ref = registry.variants[0].secret_ref.clone();
    registry.variants[0].set_resolved_key_evidence(Some(private_fixture_secret_holder(
        &secret_ref,
        b"K057-XP3-WRONGKEY0000".to_vec(),
    )));
    let err =
        run_xp3_production(&registry, "xp3-production").expect_err("wrong key evidence is a bug");
    match err {
        Xp3ProductionError::ClaimedVariantFailed {
            variant_id, stage, ..
        } => {
            assert_eq!(variant_id, "kaifuu-k057-xp3-simple-crypt");
            assert_eq!(stage, "extract");
        }
        other @ Xp3ProductionError::Internal { .. } => {
            panic!("expected ClaimedVariantFailed, got {other}")
        }
    }
}

#[test]
fn claimed_variant_unsatisfied_helper_fails_loud() {
    // A helper result that reports missing_key (not a resolved key) does NOT
    // satisfy the required evidence → loud bug.
    let mut registry = registry();
    if let Some(helper) = registry.variants[1].helper_evidence.as_mut() {
        helper.diagnostic.code = HelperDiagnosticCode::MissingKey;
    }
    let err = run_xp3_production(&registry, "xp3-production")
        .expect_err("unsatisfied helper evidence is a bug");
    assert!(matches!(
        err,
        Xp3ProductionError::ClaimedVariantFailed { stage, .. } if stage == "evidence-check"
    ));
}

#[test]
fn report_carries_no_raw_key_and_no_plaintext() {
    let report = run_xp3_production(&registry(), "xp3-production").expect("production run passes");
    let json = report.stable_json().expect("stable json");

    // No resolved/archive raw key material appears (any variant).
    for key in [
        "K057-XP3-SIMPLEKEY01",
        "K057-XP3-POSITIONKEY02",
        "K057-XP3-RESEARCHKEY0",
    ] {
        assert!(!json.contains(key), "raw key {key} leaked into the report");
    }
    // No member plaintext (old or new synthetic text) appears verbatim.
    for needle in [
        "[synthetic-k057-simple-line-0]",
        "[localized-k057-simple-line-0-JA-longer]",
        "[synthetic-k057-position-line-0]",
        "[localized-k057-position-line-0-JA]",
    ] {
        assert!(
            !json.contains(needle),
            "plaintext {needle} leaked into the report"
        );
    }
    // The secret REFS (safe) are disclosed.
    assert!(json.contains("local-secret:kaifuu/k057/xp3-simple-crypt-key"));
    assert!(json.contains("prompt:kaifuu/k057/xp3-position-archive-password"));
}

#[test]
fn run_is_reproducible() {
    let a = run_xp3_production(&registry(), "xp3-production")
        .unwrap()
        .stable_json()
        .unwrap();
    let b = run_xp3_production(&registry(), "xp3-production")
        .unwrap()
        .stable_json()
        .unwrap();
    assert_eq!(a, b, "production report is deterministic");
}

/// The raw fixture key bytes carried by the synthetic registry. Used to prove
/// none of them can ever be formatted through `Debug`, and that they are
/// confined to the zeroize-on-drop holders (never a `pub`/`Debug` field).
const RAW_KEYS: [&str; 3] = [
    "K057-XP3-SIMPLEKEY01",
    "K057-XP3-POSITIONKEY02",
    "K057-XP3-RESEARCHKEY0",
];

#[test]
fn variant_debug_never_emits_raw_key_bytes() {
    // P1(a): the variant holds the archive key + resolved key evidence ONLY
    // inside the module-private, Debug-redacting Xp3CryptKey holder. Its
    // manual Debug must never render any raw key material — not even for a
    // variant whose resolved evidence is present. `{:#?}` (pretty) too.
    let registry = registry();
    for variant in &registry.variants {
        for rendered in [format!("{variant:?}"), format!("{variant:#?}")] {
            for key in RAW_KEYS {
                assert!(
                    !rendered.contains(key),
                    "variant Debug leaked raw key {key}"
                );
            }
            assert!(
                rendered.contains("REDACTED"),
                "variant Debug should mark redaction"
            );
            // The non-secret ids ARE shown (proves Debug is still useful).
            assert!(rendered.contains("variant_id"));
        }
    }
}

#[test]
fn registry_debug_never_emits_raw_key_bytes() {
    // The whole registry (which owns every variant's key holders) must not
    // emit any raw key material through Debug either.
    let registry = registry();
    for rendered in [format!("{registry:?}"), format!("{registry:#?}")] {
        for key in RAW_KEYS {
            assert!(
                !rendered.contains(key),
                "registry Debug leaked raw key {key}"
            );
        }
    }
}

#[test]
fn resolver_debug_never_emits_raw_key_bytes() {
    // P1(b): the FixtureSecretResolver stores each key in the zeroize-on-drop
    // Xp3CryptKey holder and has a manual redacting Debug. Building a resolver
    // over the synthetic keys and formatting it must never emit key bytes,
    let a_ref = SecretRef::new("local-secret:kaifuu/k057/xp3-simple-crypt-key").unwrap();
    let b_ref = SecretRef::new("prompt:kaifuu/k057/xp3-position-archive-password").unwrap();
    let a_key = private_fixture_secret_holder(&a_ref, b"K057-XP3-SIMPLEKEY01".to_vec());
    let b_key = private_fixture_secret_holder(&b_ref, b"K057-XP3-POSITIONKEY02".to_vec());
    let resolver = FixtureSecretResolver::from_key_refs(vec![
        (a_ref.as_str().to_string(), &a_key),
        (b_ref.as_str().to_string(), &b_key),
    ]);
    for rendered in [format!("{resolver:?}"), format!("{resolver:#?}")] {
        for key in ["K057-XP3-SIMPLEKEY01", "K057-XP3-POSITIONKEY02"] {
            assert!(
                !rendered.contains(key),
                "resolver Debug leaked raw key {key}"
            );
        }
        assert!(
            rendered.contains("REDACTED"),
            "resolver Debug should mark redaction"
        );
        // The reportable secret refs are safe to show.
        assert!(rendered.contains("local-secret:kaifuu/k057/xp3-simple-crypt-key"));
    }
}

#[test]
fn registry_held_key_bytes_are_confined_to_the_zeroizing_holder() {
    // The registry/holder-held raw bytes must never appear in the serialized
    // report, and the runtime no-leak guard scans the resolver-held holders
    // (not just the report). A passing run means the guard saw the resolved
    // key material and confirmed it is absent from the JSON.
    let report = run_xp3_production(&registry(), "xp3-production").expect("production run passes");
    let json = report.stable_json().expect("stable json");
    for key in RAW_KEYS {
        assert!(
            !json.contains(key),
            "registry-held raw key {key} reached the serialized report"
        );
    }
}

/// Rebuild `synthetic::production_registry` but plant, on the UNCLAIMED
/// variant, an `archive_key` whose raw bytes are exactly the (non-secret-
/// shaped) `variant_id`. An unclaimed variant's `variant_id` is emitted
/// verbatim in its NotClaimed report row, and the archive key of an
/// unclaimed variant NEVER enters a resolver — so this forces a registry-
/// held raw key byte into the serialized report that the resolver-held scan
/// alone cannot see. Only a guard that also scans EVERY registry-held holder
/// (claimed + unclaimed) can catch it.
fn registry_with_unclaimed_archive_key_planted_in_report(
    planted_id: &str,
) -> Xp3ProductionRegistry {
    let mut registry = registry();
    let unclaimed = registry
        .variants
        .iter()
        .position(|variant| !variant.claimed)
        .expect("the synthetic registry has an unclaimed variant");
    let original = &registry.variants[unclaimed];
    // The planted id must pass the report redaction (else it is scrubbed and
    // never reaches the JSON, defeating the probe). Hyphenated lowercase ids
    // in the style of the existing variant ids are emitted verbatim.
    assert_eq!(
        redact_for_log_or_report(planted_id),
        planted_id,
        "planted id must survive report redaction verbatim to exercise the guard"
    );
    let planted = Xp3ProductionVariant::new(
        planted_id.to_string(),
        original.crypto_profile,
        original.surface,
        original.secret_requirement_id.clone(),
        original.secret_ref.clone(),
        original.helper_workflow,
        None,
        original.members.clone(),
        original.replacements.clone(),
        false,
        // archive_key bytes == the (verbatim-emitted) variant_id → a
        // registry-held raw key that lands in the report, unseen by any
        // resolver (this variant is unclaimed, so it is never resolved).
        private_fixture_secret_holder(&original.secret_ref, planted_id.as_bytes().to_vec()),
        None,
    );
    registry.variants[unclaimed] = planted;
    registry
}

#[test]
fn runtime_guard_scans_unclaimed_registry_held_archive_key() {
    // PROVES the runtime no-leak guard covers registry-held key holders,
    // including an UNCLAIMED variant's archive key — not merely the resolver-
    // held copies. If the guard is narrowed back to resolver-only, the
    // planted registry-held key byte reaches the report unguarded and this
    // test fails (the run would succeed instead of refusing).
    let planted_id = "kaifuu.k057.unclaimed.leak.probe";
    let registry = registry_with_unclaimed_archive_key_planted_in_report(planted_id);

    // Sanity: the per-variant registry scan primitive sees the planted key.
    let unclaimed = registry
        .variants
        .iter()
        .find(|variant| !variant.claimed)
        .expect("unclaimed variant present");
    assert!(
        unclaimed.any_key_appears_in(planted_id.as_bytes()),
        "the variant registry-held scan must see its own archive key bytes"
    );

    // And the resolver-held scan alone CANNOT see it (no resolver ever holds
    // an unclaimed variant's archive key), so only the registry scan catches
    // the leak below.
    let resolver = FixtureSecretResolver::from_key_refs(vec![]);
    assert!(
        !resolver.any_key_appears_in(planted_id.as_bytes()),
        "a resolver-only scan must NOT see the unclaimed registry-held key"
    );

    // The runtime guard must refuse loud because the registry-held key byte
    // now appears in the serialized report.
    let err = run_xp3_production(&registry, "xp3-production")
        .expect_err("the guard must refuse a report that carries a registry-held key byte");
    match err {
        Xp3ProductionError::Internal { message } => {
            assert!(
                message.contains("leaks raw key material"),
                "expected the no-leak refusal, got: {message}"
            );
        }
        other @ Xp3ProductionError::ClaimedVariantFailed { .. } => {
            panic!("expected the Internal no-leak refusal, got {other}")
        }
    }

    // Corroborate the premise: the planted registry-held key byte really is
    // in the report the guard scanned (proving the guard, not redaction,
    // is what stopped it).
    let leaky_report = {
        let mut registry = registry_with_unclaimed_archive_key_planted_in_report(planted_id);
        // Drop ALL variants except the planted unclaimed one, then assemble
        // the same redacted report the guard sees and confirm the byte lands.
        registry
            .variants
            .retain(|variant| variant.variant_id == planted_id);
        let outcomes = vec![Xp3ProductionOutcome::NotClaimed(
            Xp3ProductionNotClaimedReport {
                variant_id: planted_id.to_string(),
                crypto_profile: registry.variants[0].crypto_profile,
                helper_workflow: registry.variants[0].helper_workflow,
                reason: "out of scope".to_string(),
            },
        )];
        Xp3ProductionReport {
            schema_version: XP3_PRODUCTION_SCHEMA_VERSION.to_string(),
            capability_id: XP3_PRODUCTION_CAPABILITY_ID.to_string(),
            source_node_id: "xp3-production".to_string(),
            support_boundary: XP3_PRODUCTION_SUPPORT_BOUNDARY.to_string(),
            registry_id: registry.registry_id.clone(),
            engine_family: XP3_PRODUCTION_ENGINE_FAMILY.to_string(),
            container: XP3_PRODUCTION_CONTAINER.to_string(),
            redaction_status: HelperRedactionStatus::Redacted,
            claimed_profiles: vec![],
            claimed_count: 0,
            not_claimed_count: 1,
            outcomes,
            status: OperationStatus::Passed,
        }
    };
    let json = leaky_report.stable_json().expect("stable json");
    assert!(
        json.contains(planted_id),
        "the planted registry-held key byte must actually reach the report JSON"
    );
}

#[test]
fn helper_evidence_bound_to_wrong_secret_ref_is_rejected() {
    // P2: a helper result for the RIGHT requirement id but a DIFFERENT secret
    // ref must NOT satisfy the helper-gated path. The variant's key is
    // resolved independently through variant.secret_ref, so a helper result
    // that vouches for a different ref is evidence for the wrong secret.
    let mut registry = registry();
    let variant = &mut registry.variants[1];
    assert_eq!(variant.helper_workflow, Xp3HelperWorkflow::ManualKeyEntry);

    // A well-formed, satisfied helper — but for a DIFFERENT (valid) ref than
    // the variant's declared secret_ref, under the same requirement id.
    let wrong_ref = SecretRef::new("prompt:kaifuu/k057/xp3-position-other-password")
        .expect("synthetic secret ref is valid");
    assert_ne!(wrong_ref, variant.secret_ref);
    variant.helper_evidence = Some(synthetic::satisfied_manual_entry_helper(
        &variant.secret_requirement_id,
        &wrong_ref,
    ));

    let err = run_xp3_production(&registry, "xp3-production")
        .expect_err("a helper result bound to the wrong secret ref must be rejected");
    match err {
        Xp3ProductionError::ClaimedVariantFailed {
            variant_id, stage, ..
        } => {
            assert_eq!(variant_id, "kaifuu-k057-xp3-position-crypt");
            assert_eq!(stage, "evidence-check");
        }
        other @ Xp3ProductionError::Internal { .. } => {
            panic!("expected ClaimedVariantFailed, got {other}")
        }
    }
}

#[test]
fn helper_evidence_bound_to_the_exact_secret_ref_is_accepted() {
    // The positive control for P2: the default registry's helper result IS
    // bound to the variant's exact secret ref, so the helper-gated variant
    // passes. (Guards against the wrong-ref test passing for the wrong
    // reason, e.g. helper evidence being ignored entirely.)
    let report = run_xp3_production(&registry(), "xp3-production").expect("production run passes");
    let position = report
        .outcomes
        .iter()
        .find_map(|outcome| match outcome {
            Xp3ProductionOutcome::Claimed(report)
                if report.crypto_profile == Xp3CryptoProfile::XorPositionCryptFixture =>
            {
                Some(report)
            }
            _ => None,
        })
        .expect("helper-gated position variant round-tripped");
    assert!(position.helper_evidence_present);
}
