use super::*;

// --- Canonical fixture builders (the five committed boundary classes) --------

/// A local secret-ref used by the keyed fixtures. `unwrap` is safe: the literal
/// is a valid dotted local-secret name.
fn fixture_secret_ref(name: &str) -> SecretRef {
    SecretRef::new(format!("local-secret:{name}")).expect("fixture secret-ref literal is valid")
}

/// The **no-key** fixture: plaintext in-profile, no key referenced. Admitted.
pub fn fixture_no_key() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-no-key".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::NoKeyRequired,
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **zero-key** fixture: key referenced, resolves in-process to the zero
/// identity key. Admitted, carries a secret-ref.
pub fn fixture_zero_key() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-zero-key".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::ZeroKeyResolved {
            secret_ref: fixture_secret_ref("siglus.runtime.zero-key.v1"),
        },
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **required-key** fixture: key required, not resolvable in-process, no
/// helper. Rejected before any claim.
pub fn fixture_required_key() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-required-key".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::RequiredUnresolved {
            secret_ref: fixture_secret_ref("siglus.runtime.required-key.v1"),
        },
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **helper-required** fixture: key required, only an external helper could
/// resolve it. Rejected before any claim (the runtime never shells out).
pub fn fixture_helper_required() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-helper-required".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        key_posture: RuntimeKeyPosture::HelperRequired {
            secret_ref: fixture_secret_ref("siglus.runtime.helper-required.v1"),
            helper_id: "siglus-keyring-helper".to_string(),
        },
        scene_source: RuntimeContainerSource::SyntheticInProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// The **out-of-profile** fixture: the Scene.pck container is flagged with the
/// proprietary-LZSS compression, outside the supported runtime profile.
/// Rejected at the parser boundary, before any key handling or claim.
pub fn fixture_out_of_profile() -> RuntimeProfileFixture {
    RuntimeProfileFixture {
        schema_version: RUNTIME_PROFILE_BOUNDARY_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-runtime-profile-out-of-profile".to_string(),
        encoding: RuntimeEncoding::Utf16Le,
        compression: RuntimeCompression::Uncompressed,
        // The key posture is irrelevant: the container parse-boundary rejects
        // first. Declaring a would-be-admissible no-key posture makes the
        // reject-before-key ordering observable.
        key_posture: RuntimeKeyPosture::NoKeyRequired,
        scene_source: RuntimeContainerSource::SyntheticOutOfProfile,
        gameexe_source: RuntimeContainerSource::SyntheticInProfile,
    }
}

/// All five canonical fixtures paired with the boundary class each must
/// classify to. Used by the boundary conformance test.
pub fn canonical_boundary_fixtures() -> Vec<(RuntimeBoundaryClass, RuntimeProfileFixture)> {
    vec![
        (RuntimeBoundaryClass::NoKey, fixture_no_key()),
        (RuntimeBoundaryClass::ZeroKey, fixture_zero_key()),
        (RuntimeBoundaryClass::RequiredKey, fixture_required_key()),
        (
            RuntimeBoundaryClass::HelperRequired,
            fixture_helper_required(),
        ),
        (RuntimeBoundaryClass::OutOfProfile, fixture_out_of_profile()),
    ]
}
