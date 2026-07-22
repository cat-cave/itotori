use super::*;

#[test]
fn secret_ref_rejects_raw_paths_and_bad_schemes() {
    assert!(SecretRef::new("local-secret:siglus.key.v1").is_ok());
    assert!(SecretRef::new("plain-text-key").is_err());
    assert!(SecretRef::new("local-secret:/home/user/key").is_err());
    assert!(SecretRef::new("local-secret:../escape").is_err());
    assert!(SecretRef::new("bogus-scheme:name").is_err());
}

#[test]
fn key_material_debug_is_redacted_and_zeroizes() {
    let key = RuntimeKeyMaterial::from_resolved_bytes(vec![1, 2, 3, 4]);
    let debug = format!("{key:?}");
    assert!(
        debug.contains("REDACTED"),
        "key Debug must be redacted: {debug}"
    );
    assert!(
        !debug.contains(", 2, 3"),
        "key Debug must not print bytes: {debug}"
    );
}

#[test]
fn out_of_profile_rejects_before_key_resolution() {
    // The out-of-profile fixture declares a NoKeyRequired posture that would
    // otherwise admit; the container boundary must reject it first.
    let fixture = fixture_out_of_profile();
    let error = classify_runtime_profile(&fixture).expect_err("must reject");
    assert_eq!(
        error.boundary_class(),
        Some(RuntimeBoundaryClass::OutOfProfile)
    );
}
