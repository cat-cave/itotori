//! Integration tests for the Slice A runtime VFS.
//!
//! Exercises the diagnostic enum via a `FixturePolicyPackage` test type that
//! reads `package.toml` and produces the right `VfsError` variants on
//! `open`. Plaintext bytes are read straight off disk; encrypted and
//! helper-gated paths are modelled at the diagnostic level only.

use utsushi_core::redaction::reject_unredacted_local_paths;
use utsushi_core::vfs::case_rule_matches;
use utsushi_core::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, HelperId,
    IoSummary, PackageDescriptor, PackageKind, PackageSource, RequiredCapability,
    RuntimeAdapterDiagnostic, TraversalKind, UtsushiResult, VfsError, VfsResult,
};

#[path = "vfs_synthetic_package/support.rs"]
mod support;

use support::{FixturePolicyPackage, fixture_package};

// The route-by-package-id `MountedVfs` is removed; the
// synthetic fixture exercises the `AssetPackage` boundary directly. The
// composite path is exercised by `composite_asset_package.rs` and the
// real-bytes integration suite. See
// `docs/dev/orchestration-operating-model.md` "Legacy-path preservation"
// (2026-06-24) for the no-shim rule.

#[test]
fn synthetic_package_open_returns_plaintext_bytes_for_intro_txt() {
    let package = fixture_package();
    let id = package.resolve("hello/intro.txt").unwrap();
    let bytes = package.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"hello world!");
    assert_eq!(bytes.len(), 12);
}

#[test]
fn synthetic_package_list_root_returns_three_subdirectories() {
    let package = fixture_package();
    let root = AssetId::from_parts("synthetic", "").unwrap();
    let children = package.list(&root).unwrap();
    let names: Vec<&str> = children.iter().map(utsushi_core::AssetId::path).collect();
    assert_eq!(names, vec!["encrypted/", "hello/", "helper-gated/"]);
}

#[test]
fn synthetic_package_stat_directory_reports_directory_kind() {
    let package = fixture_package();
    let id = AssetId::from_parts("synthetic", "hello/").unwrap();
    let metadata = package.stat(&id).unwrap();
    assert_eq!(metadata.kind, AssetKind::Directory);
    assert_eq!(metadata.size, AssetSize::Unknown);
}

#[test]
fn synthetic_package_stat_file_reports_file_kind_and_byte_size() {
    let package = fixture_package();
    let id = package.resolve("hello/intro.txt").unwrap();
    let metadata = package.stat(&id).unwrap();
    assert_eq!(metadata.kind, AssetKind::File);
    assert_eq!(metadata.size, AssetSize::Bytes(12));
}

#[test]
fn synthetic_package_open_missing_path_returns_asset_missing() {
    let package = fixture_package();
    let id = AssetId::from_parts("synthetic", "hello/absent.txt").unwrap();
    let error = package.open(&id).unwrap_err();
    match error {
        VfsError::AssetMissing { id: missing } => {
            assert_eq!(missing.path(), "hello/absent.txt");
        }
        other => panic!("expected AssetMissing, got {other:?}"),
    }
}

#[test]
fn synthetic_package_open_encrypted_asset_returns_asset_encrypted_with_crypto_capability() {
    let package = fixture_package();
    let id = AssetId::from_parts("synthetic", "encrypted/locked.bin").unwrap();
    let error = package.open(&id).unwrap_err();
    match error {
        VfsError::AssetEncrypted {
            required_capability,
            ..
        } => {
            assert_eq!(required_capability, RequiredCapability::Crypto);
        }
        other => panic!("expected AssetEncrypted, got {other:?}"),
    }
}

#[test]
fn synthetic_package_open_helper_gated_asset_returns_asset_helper_gated_with_named_helper() {
    let package = fixture_package();
    let id = AssetId::from_parts("synthetic", "helper-gated/remote.bin").unwrap();
    let error = package.open(&id).unwrap_err();
    match error {
        VfsError::AssetHelperGated { helper_id, .. } => {
            assert_eq!(
                helper_id,
                HelperId::Named("synthetic-fixture-helper".to_string())
            );
        }
        other => panic!("expected AssetHelperGated, got {other:?}"),
    }
}

#[test]
fn synthetic_package_resolve_outside_root_returns_asset_path_unsafe_parent_escape() {
    let package = fixture_package();
    let error = package.resolve("../escape.txt").unwrap_err();
    match error {
        VfsError::AssetPathUnsafe { kind, .. } => {
            assert_eq!(kind, TraversalKind::ParentEscape);
        }
        other => panic!("expected AssetPathUnsafe, got {other:?}"),
    }
}

#[test]
fn synthetic_package_resolve_drive_letter_returns_asset_path_unsafe_absolute_root() {
    let package = fixture_package();
    let error = package.resolve("C:/Windows/system32").unwrap_err();
    match error {
        VfsError::AssetPathUnsafe { kind, .. } => {
            assert_eq!(kind, TraversalKind::AbsoluteRoot);
        }
        other => panic!("expected AssetPathUnsafe, got {other:?}"),
    }
}

#[test]
fn synthetic_package_open_via_asset_id_returns_expected_bytes() {
    let package = fixture_package();
    let id = AssetId::from_parts("synthetic", "hello/intro.txt").unwrap();
    let bytes = package.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"hello world!");
}

#[test]
fn synthetic_package_open_with_mismatched_package_id_returns_asset_outside_package() {
    // An id whose package portion does not match the synthetic
    // fixture's own id is rejected at the `AssetPackage` boundary. The
    // outer routing layer (composite or runtime VFS) is gone, so the
    // package itself owns this check.
    let package = fixture_package();
    let id = AssetId::from_parts("other-pkg", "x.txt").unwrap();
    let error = package.open(&id).unwrap_err();
    match error {
        VfsError::AssetOutsidePackage {
            package: rejected, ..
        } => assert_eq!(rejected, "synthetic"),
        other => panic!("expected AssetOutsidePackage, got {other:?}"),
    }
}

#[test]
fn synthetic_package_descriptor_reports_redacted_public_source() {
    let package = fixture_package();
    let descriptor = package.descriptor();
    assert_eq!(descriptor.id, "synthetic");
    assert_eq!(
        descriptor.source,
        PackageSource::PublicName("public-fixture:synthetic-package".to_string())
    );
    // Sanity: the redacted source is not a host path.
    assert!(!descriptor.source.as_str().starts_with('/'));
}

#[test]
fn case_rule_sensitive_helper_matches_only_exact_case() {
    let package = fixture_package();
    assert!(case_rule_matches(
        package.case_rule(),
        "intro.txt",
        "intro.txt"
    ));
    assert!(!case_rule_matches(
        package.case_rule(),
        "intro.txt",
        "INTRO.TXT"
    ));
}

/// Build a deterministic JSON envelope around an error message and feed
/// it through the substrate's public redaction filter
/// (`utsushi_core::redaction::reject_unredacted_local_paths`). The
/// envelope shape mirrors the previous test, which used the deleted
/// (now-deleted) typed hook envelope as a transport for the same assertion;
/// after we exercise the redaction filter directly.
fn assert_message_passes_redaction(message: &str) -> UtsushiResult<()> {
    let value = serde_json::json!({
        "diagnostic": {
            "errorType": "vfs_diagnostic",
            "message": message,
        }
    });
    reject_unredacted_local_paths("", &value)
}

#[test]
fn vfs_error_serialized_into_runtime_diagnostic_passes_observation_redaction() {
    // Wrap a VfsError into a RuntimeAdapterDiagnostic, embed its
    // `Display` text into the diagnostic message field, and assert the
    // `reject_unredacted_local_paths` filter accepts it.
    let package = fixture_package();
    let id = AssetId::from_parts("synthetic", "hello/absent.txt").unwrap();
    let error = package.open(&id).unwrap_err();
    let asset_ref = error.asset_ref();
    let diagnostic =
        RuntimeAdapterDiagnostic::new("asset_loader", "blocked", "warning", error.to_string())
            .with_detail("semanticCode", error.semantic_code())
            .with_detail_value(
                "assetRef",
                serde_json::to_value(&asset_ref).expect("AssetRef serializes"),
            );

    assert_message_passes_redaction(&diagnostic.message)
        .expect("VFS diagnostic display message passes redaction filter");
}

#[test]
fn every_vfs_error_display_passes_observation_redaction() {
    // Exhaustively check the Display text for every variant — feed each
    // through the redaction filter and assert pass.
    let id = AssetId::from_parts("synthetic", "hello/intro.txt").unwrap();
    let helper_id = HelperId::Named("synthetic-helper".to_string());
    let cases: Vec<VfsError> = vec![
        VfsError::InvalidAssetId {
            raw: "vfs://Hello/x".to_string(),
            reason: utsushi_core::AssetIdErrorReason::BadPackageChar,
        },
        VfsError::AssetMissing { id: id.clone() },
        VfsError::AssetOutsidePackage {
            id: id.clone(),
            package: "synthetic".to_string(),
        },
        VfsError::AssetPathUnsafe {
            package: "synthetic".to_string(),
            logical: "../etc/passwd".to_string(),
            kind: TraversalKind::ParentEscape,
        },
        VfsError::AssetEncrypted {
            id: id.clone(),
            required_capability: RequiredCapability::Crypto,
        },
        VfsError::AssetHelperGated {
            id: id.clone(),
            helper_id,
        },
        VfsError::AssetTransformUnsupported {
            id: id.clone(),
            transform: utsushi_core::TransformKind::Codec,
        },
        VfsError::AssetNotDirectory { id: id.clone() },
        VfsError::AssetNotFile { id: id.clone() },
        VfsError::PackageIo {
            id: id.clone(),
            summary: IoSummary::Other,
        },
        VfsError::ResourceBound {
            id: id.clone(),
            bound: utsushi_core::ResourceBoundKind::FileSizeCap,
        },
    ];
    for error in &cases {
        assert_message_passes_redaction(&error.to_string())
            .unwrap_or_else(|err| panic!("variant {error:?} failed redaction: {err}"));
    }
}

#[test]
fn vfs_error_for_real_host_path_input_does_not_leak_path_into_display() {
    // Build a temporary copy of the fixture so the host path is a real
    // tmp/... directory — Display output must still not contain that
    // substring.
    let temp = tempfile::tempdir().unwrap();
    let host_root = temp.path().join("synthetic");
    std::fs::create_dir_all(host_root.join("hello")).unwrap();
    std::fs::write(host_root.join("hello").join("intro.txt"), "hello world!").unwrap();
    let manifest = "id = \"synthetic\"\npublic_source = \"public-fixture:synthetic-package\"\ncase_rule = \"sensitive\"\n";
    std::fs::write(host_root.join("package.toml"), manifest).unwrap();
    let package = FixturePolicyPackage::load(&host_root);
    let id = AssetId::from_parts("synthetic", "hello/missing.bin").unwrap();
    let error = package.open(&id).unwrap_err();
    let rendered = error.to_string();
    let host_display = host_root.display().to_string();
    assert!(!rendered.contains(&host_display));
    if host_display.starts_with("/tmp/") {
        assert!(!rendered.contains("/tmp/"));
    }
}
