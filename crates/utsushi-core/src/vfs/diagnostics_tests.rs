use super::*;

fn asset_id(raw: &str) -> AssetId {
    AssetId::parse(raw).expect("test asset id parses")
}

#[test]
fn asset_missing_carries_asset_id_and_stable_code() {
    let error = VfsError::AssetMissing {
        id: asset_id("vfs://hello/intro.txt"),
    };
    assert_eq!(error.semantic_code(), "utsushi.vfs.asset_missing");
    let asset_ref = error.asset_ref();
    assert_eq!(asset_ref.asset_id.as_deref(), Some("vfs://hello/intro.txt"));
    assert_eq!(asset_ref.package.as_deref(), Some("hello"));
    assert!(error.kaifuu_code().is_none());
}

#[test]
fn asset_outside_package_carries_package_id() {
    let error = VfsError::AssetOutsidePackage {
        id: asset_id("vfs://unknown/intro.txt"),
        package: "unknown".to_string(),
    };
    assert_eq!(error.semantic_code(), "utsushi.vfs.asset_outside_package");
    let asset_ref = error.asset_ref();
    assert_eq!(asset_ref.package.as_deref(), Some("unknown"));
}

#[test]
fn asset_encrypted_carries_required_capability() {
    let error = VfsError::AssetEncrypted {
        id: asset_id("vfs://hello/encrypted/locked.bin"),
        required_capability: RequiredCapability::Crypto,
    };
    assert_eq!(error.semantic_code(), "utsushi.vfs.asset_encrypted");
    assert_eq!(
        error.kaifuu_code(),
        Some("kaifuu.missing_capability.crypto")
    );
}

#[test]
fn asset_encrypted_key_material_maps_to_kaifuu_missing_key_material() {
    let error = VfsError::AssetEncrypted {
        id: asset_id("vfs://hello/encrypted/locked.bin"),
        required_capability: RequiredCapability::KeyMaterial,
    };
    assert_eq!(error.kaifuu_code(), Some("kaifuu.missing_key_material"));
}

#[test]
fn asset_helper_gated_carries_helper_id() {
    let error = VfsError::AssetHelperGated {
        id: asset_id("vfs://hello/remote.bin"),
        helper_id: HelperId::Named("wine-windows-helper".to_string()),
    };
    assert_eq!(error.semantic_code(), "utsushi.vfs.asset_helper_gated");
    assert_eq!(error.kaifuu_code(), Some("kaifuu.helper_unavailable"));
    let rendered = error.to_string();
    assert!(
        rendered.contains("wine-windows-helper"),
        "rendered display should contain helper id: {rendered}"
    );
}

#[test]
fn asset_transform_unsupported_maps_to_kaifuu_code() {
    let crypto = VfsError::AssetTransformUnsupported {
        id: asset_id("vfs://hello/data.bin"),
        transform: TransformKind::Crypto,
    };
    assert_eq!(
        crypto.kaifuu_code(),
        Some("kaifuu.unsupported_layered_transform")
    );

    let codec = VfsError::AssetTransformUnsupported {
        id: asset_id("vfs://hello/data.bin"),
        transform: TransformKind::Codec,
    };
    assert_eq!(codec.kaifuu_code(), Some("kaifuu.missing_capability.codec"));

    let container = VfsError::AssetTransformUnsupported {
        id: asset_id("vfs://hello/data.bin"),
        transform: TransformKind::Container,
    };
    assert_eq!(
        container.kaifuu_code(),
        Some("kaifuu.missing_capability.container")
    );
}

#[test]
fn package_io_summary_drops_raw_os_message() {
    let raw_os_message = "No such file or directory (os error 2) at /tmp/abc";
    let io_error = std::io::Error::new(std::io::ErrorKind::NotFound, raw_os_message.to_string());
    let summary = IoSummary::from_io_error_kind(io_error.kind());
    let error = VfsError::PackageIo {
        id: asset_id("vfs://hello/missing.txt"),
        summary,
    };
    let rendered = error.to_string();
    assert!(!rendered.contains(raw_os_message));
    assert!(!rendered.contains("/tmp/abc"));
    assert!(rendered.contains("not_found"));
}

#[test]
fn display_output_contains_no_host_path_substrings() {
    let cases = [
        VfsError::AssetMissing {
            id: asset_id("vfs://hello/intro.txt"),
        },
        VfsError::AssetOutsidePackage {
            id: asset_id("vfs://nope/intro.txt"),
            package: "nope".to_string(),
        },
        VfsError::AssetPathUnsafe {
            package: "hello".to_string(),
            logical: "/etc/passwd".to_string(),
            kind: TraversalKind::AbsoluteRoot,
        },
        VfsError::AssetEncrypted {
            id: asset_id("vfs://hello/locked.bin"),
            required_capability: RequiredCapability::KeyProfile,
        },
        VfsError::AssetHelperGated {
            id: asset_id("vfs://hello/remote.bin"),
            helper_id: HelperId::Named("public-helper".to_string()),
        },
        VfsError::AssetTransformUnsupported {
            id: asset_id("vfs://hello/data.bin"),
            transform: TransformKind::Crypto,
        },
        VfsError::AssetNotDirectory {
            id: asset_id("vfs://hello/intro.txt"),
        },
        VfsError::AssetNotFile {
            id: asset_id("vfs://hello/dir/"),
        },
        VfsError::PackageIo {
            id: asset_id("vfs://hello/intro.txt"),
            summary: IoSummary::PermissionDenied,
        },
        VfsError::ResourceBound {
            id: asset_id("vfs://hello/big.bin"),
            bound: ResourceBoundKind::FileSizeCap,
        },
        VfsError::InvalidAssetId {
            raw: "vfs://Hello/x".to_string(),
            reason: AssetIdErrorReason::BadPackageChar,
        },
    ];
    for error in &cases {
        let rendered = error.to_string();
        for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
            assert!(
                !rendered.contains(forbidden),
                "rendered={rendered} contained forbidden substring {forbidden}"
            );
        }
        // The logical-path field in AssetPathUnsafe is dropped from the
        // public display because the engine-supplied logical can itself be
        // a host path leak.
        if let VfsError::AssetPathUnsafe { logical, .. } = error {
            assert!(
                !rendered.contains(logical),
                "logical leaked into display: {rendered}"
            );
        }
    }
}

#[test]
fn debug_render_without_feature_flag_matches_display() {
    let error = VfsError::AssetMissing {
        id: asset_id("vfs://hello/intro.txt"),
    };
    assert_eq!(error.debug_render(), error.to_string());
}

#[test]
fn semantic_codes_all_registered_in_module_list() {
    // Each variant produces a code that is part of the canonical list so
    // a downstream allowed-code validator can not silently drop one.
    let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
    let variants = [
        VfsError::InvalidAssetId {
            raw: String::new(),
            reason: AssetIdErrorReason::MissingScheme,
        }
        .semantic_code(),
        VfsError::AssetMissing {
            id: asset_id("vfs://hello/intro.txt"),
        }
        .semantic_code(),
        VfsError::AssetOutsidePackage {
            id: asset_id("vfs://hello/intro.txt"),
            package: "hello".to_string(),
        }
        .semantic_code(),
        VfsError::AssetPathUnsafe {
            package: "hello".to_string(),
            logical: String::new(),
            kind: TraversalKind::NulByte,
        }
        .semantic_code(),
        VfsError::AssetEncrypted {
            id: asset_id("vfs://hello/intro.txt"),
            required_capability: RequiredCapability::Crypto,
        }
        .semantic_code(),
        VfsError::AssetHelperGated {
            id: asset_id("vfs://hello/intro.txt"),
            helper_id: HelperId::Named("a".to_string()),
        }
        .semantic_code(),
        VfsError::AssetTransformUnsupported {
            id: asset_id("vfs://hello/intro.txt"),
            transform: TransformKind::Crypto,
        }
        .semantic_code(),
        VfsError::AssetNotDirectory {
            id: asset_id("vfs://hello/intro.txt"),
        }
        .semantic_code(),
        VfsError::AssetNotFile {
            id: asset_id("vfs://hello/intro.txt"),
        }
        .semantic_code(),
        VfsError::PackageIo {
            id: asset_id("vfs://hello/intro.txt"),
            summary: IoSummary::Other,
        }
        .semantic_code(),
        VfsError::ResourceBound {
            id: asset_id("vfs://hello/intro.txt"),
            bound: ResourceBoundKind::FileSizeCap,
        }
        .semantic_code(),
    ];
    for code in variants {
        assert!(all.contains(code), "code {code} missing from codes::ALL");
    }
}
