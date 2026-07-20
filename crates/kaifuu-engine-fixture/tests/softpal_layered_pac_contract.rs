//! Public capability-contract regression for the supported Softpal layered
//! PAC script/text path. The raw corpus proof lives in the CLI integration
//! test; this test keeps the disclosure stable without requiring game bytes.

use kaifuu_core::{CapabilityStatus, ContainerTransform, CryptoTransform, EngineAdapter};
use kaifuu_engine_fixture::SoftpalProfileDetectorAdapter;

#[test]
fn extract_contract_discloses_supported_layered_pac_text_transform() {
    let capabilities = SoftpalProfileDetectorAdapter.capabilities();
    let extract = &capabilities
        .access_contract
        .expect("Softpal adapter declares a layered access contract")
        .extract;

    assert_eq!(extract.status, CapabilityStatus::Supported);
    assert!(
        extract
            .supported_containers
            .contains(&ContainerTransform::Archive)
    );
    assert!(extract.supported_crypto.contains(&CryptoTransform::NullKey));
    assert!(extract.supported_crypto.contains(&CryptoTransform::Xor));
    let boundary = extract
        .support_boundary
        .as_deref()
        .expect("extract contract states its transform boundary");
    assert!(boundary.contains("PAC archive entry"));
    assert!(boundary.contains("ROL+XOR"));
    assert!(boundary.contains("PAC entry compression/encryption"));
}
