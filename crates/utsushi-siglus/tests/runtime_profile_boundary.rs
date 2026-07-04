//! UTSUSHI-035 — runtime-profile boundary conformance.
//!
//! Proves, on synthetic `Scene.pck` / `Gameexe.dat` runtime-profile fixtures:
//!
//! 1. Each of the five boundary classes (no-key / zero-key / required-key /
//!    helper-required / out-of-profile) is distinguished on its own fixture.
//! 2. The three rejected classes yield a typed
//!    [`RuntimeBoundaryDiagnostic`] and emit **no** runtime-evidence claim
//!    (reject-before-claim).
//! 3. Admission claims + rejection diagnostics reference key material only
//!    through local secret-refs + one-way proof hashes — the serialized report
//!    carries no raw key bytes.
//! 4. The out-of-profile container is rejected at the parser boundary, before
//!    any key handling.

use utsushi_core::EvidenceTier;
use utsushi_siglus::runtime_profile::{
    ProofHash, RuntimeBoundaryClass, RuntimeBoundaryDiagnostic, RuntimeCompression,
    RuntimeEvidenceClaim, admit_runtime_profile, canonical_boundary_fixtures,
    classify_runtime_profile, fixture_no_key, fixture_out_of_profile, fixture_zero_key,
};

#[test]
fn each_of_five_boundary_classes_is_distinguished_on_its_fixture() {
    let mut seen = std::collections::BTreeSet::new();
    for (expected, fixture) in canonical_boundary_fixtures() {
        match classify_runtime_profile(&fixture) {
            Ok(admission) => {
                assert!(
                    expected.is_admitted(),
                    "class {} was admitted but the fixture expected a rejection",
                    expected.as_str()
                );
                assert_eq!(
                    admission.class(),
                    expected,
                    "admitted fixture {} classified to the wrong class",
                    fixture.profile_id
                );
            }
            Err(diagnostic) => {
                assert!(
                    !expected.is_admitted(),
                    "class {} was rejected but the fixture expected admission",
                    expected.as_str()
                );
                assert_eq!(
                    diagnostic.boundary_class(),
                    Some(expected),
                    "rejected fixture {} classified to the wrong class",
                    fixture.profile_id
                );
            }
        }
        seen.insert(expected.as_str());
    }
    assert_eq!(
        seen,
        [
            "helper-required",
            "no-key",
            "out-of-profile",
            "required-key",
            "zero-key"
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>(),
        "all five distinct boundary classes must be exercised"
    );
}

#[test]
fn rejected_classes_emit_typed_diagnostic_and_no_claim() {
    for (expected, fixture) in canonical_boundary_fixtures() {
        if expected.is_admitted() {
            continue;
        }
        // The reject-before-claim entry point returns Err with no claim.
        let outcome = admit_runtime_profile(&fixture);
        let diagnostic = outcome.expect_err("rejected class must not produce a claim");
        assert_eq!(diagnostic.boundary_class(), Some(expected));

        // The typed diagnostic serializes with a stable code and passes the
        // redaction sweep (secret-refs only).
        let json = diagnostic
            .stable_json()
            .expect("diagnostic serializes + redacts");
        assert!(
            json.contains("\"code\""),
            "diagnostic must carry a stable code: {json}"
        );
    }
}

#[test]
fn admitted_classes_build_a_claim_capped_at_e1() {
    for name in ["no-key", "zero-key"] {
        let fixture = match name {
            "no-key" => fixture_no_key(),
            _ => fixture_zero_key(),
        };
        let claim = admit_runtime_profile(&fixture).expect("admitted class builds a claim");
        assert_eq!(claim.source_node_id, RuntimeEvidenceClaim::SOURCE_NODE_ID);
        assert_eq!(claim.evidence_tier, EvidenceTier::E1);
        assert_eq!(claim.encoding as u8, 0); // Utf16Le is the only variant
        assert_eq!(claim.compression, RuntimeCompression::Uncompressed);
        assert!(
            claim.scene.record_count >= 1,
            "scene digest carries a record count"
        );
        assert!(
            claim.gameexe.record_count >= 1,
            "gameexe digest carries a record count"
        );
    }
}

#[test]
fn no_key_claim_carries_no_key_reference() {
    let claim = admit_runtime_profile(&fixture_no_key()).expect("no-key admitted");
    assert_eq!(claim.boundary_class, RuntimeBoundaryClass::NoKey);
    assert!(
        claim.key_reference.is_none(),
        "the no-key class references no key material at all"
    );
    let json = claim.stable_json().expect("serializes");
    assert!(
        !json.contains("keyReference"),
        "no-key claim JSON must not carry a key reference: {json}"
    );
}

#[test]
fn zero_key_claim_carries_secret_ref_only_no_raw_key() {
    let claim = admit_runtime_profile(&fixture_zero_key()).expect("zero-key admitted");
    assert_eq!(claim.boundary_class, RuntimeBoundaryClass::ZeroKey);

    let key_reference = claim
        .key_reference
        .as_ref()
        .expect("zero-key admission carries a key reference");
    assert!(
        key_reference
            .secret_ref
            .as_str()
            .starts_with("local-secret:"),
        "key is referenced through a local secret-ref"
    );
    assert_eq!(
        key_reference.key_byte_len, 16,
        "the zero identity key is 16 bytes"
    );

    // The one-way commitment is the sha256 of 16 zero bytes — a fixed, non-zero
    // hash. It is a commitment, not the key.
    let expected_commitment = ProofHash::commit(&[0u8; 16]);
    assert_eq!(
        key_reference.key_commitment.as_str(),
        expected_commitment.as_str(),
        "key commitment is the one-way hash of the resolved key, never the key"
    );

    // Serialized report: secret-ref + commitment present, raw key bytes absent.
    let json = claim.stable_json().expect("serializes + redacts");
    assert!(
        json.contains("local-secret:"),
        "secret-ref must be present: {json}"
    );
    assert!(
        json.contains(expected_commitment.as_str()),
        "commitment must be present"
    );
    // No field ever carries raw key bytes (checked as JSON field names, not
    // prose substrings — the support-boundary text legitimately says "material").
    for forbidden in [
        "\"keyBytes\":",
        "\"rawKey\":",
        "\"material\":",
        "\"bytes\":",
        "\"key\":",
    ] {
        assert!(
            !json.contains(forbidden),
            "serialized claim must not carry raw key material field `{forbidden}`: {json}"
        );
    }
    // And the raw 16-zero-byte key must not appear serialized as a byte array.
    assert!(
        !json.contains("[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]"),
        "serialized claim must not carry the raw key bytes: {json}"
    );
}

#[test]
fn out_of_profile_is_rejected_at_parser_boundary_before_key() {
    // The out-of-profile fixture declares a would-be-admissible NoKeyRequired
    // posture; the container parse-boundary must reject it first, proving the
    // parser boundary fires before key handling.
    let fixture = fixture_out_of_profile();
    let diagnostic = admit_runtime_profile(&fixture).expect_err("must reject");
    match diagnostic {
        RuntimeBoundaryDiagnostic::OutOfProfile {
            container, detail, ..
        } => {
            assert_eq!(container, "Scene.pck");
            assert!(
                detail.contains("lzss"),
                "detail names the out-of-profile compression: {detail}"
            );
        }
        other => panic!("expected OutOfProfile diagnostic, got {other:?}"),
    }
}

#[test]
fn required_and_helper_diagnostics_name_the_secret_ref_not_the_key() {
    for (expected, fixture) in canonical_boundary_fixtures() {
        if !matches!(
            expected,
            RuntimeBoundaryClass::RequiredKey | RuntimeBoundaryClass::HelperRequired
        ) {
            continue;
        }
        let diagnostic = classify_runtime_profile(&fixture).expect_err("must reject");
        let json = diagnostic.stable_json().expect("serializes + redacts");
        assert!(
            json.contains("local-secret:"),
            "diagnostic must name the unresolved secret-ref: {json}"
        );
        // Display form is used as the human message; it must not leak bytes.
        let display = diagnostic.to_string();
        assert!(
            display.contains("no runtime-evidence claim emitted"),
            "diagnostic message asserts reject-before-claim: {display}"
        );
    }
}

#[test]
fn helper_required_diagnostic_names_the_helper() {
    let fixture = canonical_boundary_fixtures()
        .into_iter()
        .find(|(class, _)| *class == RuntimeBoundaryClass::HelperRequired)
        .map(|(_, fixture)| fixture)
        .expect("helper-required fixture present");
    let diagnostic = classify_runtime_profile(&fixture).expect_err("must reject");
    match diagnostic {
        RuntimeBoundaryDiagnostic::HelperRequired { helper_id, .. } => {
            assert_eq!(helper_id, "siglus-keyring-helper");
        }
        other => panic!("expected HelperRequired, got {other:?}"),
    }
}
