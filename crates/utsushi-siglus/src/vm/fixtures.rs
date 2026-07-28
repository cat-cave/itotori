use super::*;

/// The **no-key** fixture: plaintext synthetic program, no key referenced.
pub fn fixture_no_key_trace() -> SiglusVmFixture {
    SiglusVmFixture {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-vm-trace-no-key".to_string(),
        key_posture: VmKeyPosture::NoKey,
    }
}

/// The **local-key** fixture: program scrambled with a local key resolvable
/// in-process; the key is referenced by a secret-ref only.
pub fn fixture_local_key_trace() -> SiglusVmFixture {
    SiglusVmFixture {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-vm-trace-local-key".to_string(),
        key_posture: VmKeyPosture::LocalKeyResolved {
            secret_ref: fixture_secret_ref("siglus.vm.local-key.v1"),
        },
    }
}

/// The **required-unresolved** fixture: a key is required but not resolvable
/// in-process; the VM never runs. Rejected before any evidence.
pub fn fixture_required_unresolved_trace() -> SiglusVmFixture {
    SiglusVmFixture {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-vm-trace-required-key".to_string(),
        key_posture: VmKeyPosture::RequiredUnresolved {
            secret_ref: fixture_secret_ref("siglus.vm.required-key.v1"),
        },
    }
}

/// The raw synthetic local key, exposed to tests **only** so the no-raw-key
/// assertion can prove the key bytes are absent from serialized evidence. This is
/// an authored, clearly-fake constant, not a retail key.
#[doc(hidden)]
pub fn synthetic_local_key_for_test_assertions() -> [u8; 16] {
    SYNTHETIC_LOCAL_KEY
}
