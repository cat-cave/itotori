//! Integration tests for the UTSUSHI-020 Slice A runtime VFS.
//!
//! Exercises the diagnostic enum via a `FixturePolicyPackage` test type that
//! reads `package.toml` and produces the right `VfsError` variants on
//! `open`. Plaintext bytes are read straight off disk; encrypted and
//! helper-gated paths are modelled at the diagnostic level only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::redaction::reject_unredacted_local_paths;
use utsushi_core::vfs::case_rule_matches;
use utsushi_core::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, HelperId,
    IoSummary, MountedVfs, PackageDescriptor, PackageKind, PackageSource, RequiredCapability,
    RuntimeAdapterDiagnostic, RuntimeVfs, TraversalKind, VfsError, VfsResult,
};

/// Synthetic per-path access policy parsed from the fixture's `package.toml`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum AccessPolicy {
    Plaintext,
    Encrypted(RequiredCapability),
    HelperGated(HelperId),
}

struct FixturePolicyPackage {
    id: String,
    host_root: PathBuf,
    case_rule: CaseRule,
    source: PackageSource,
    policies: HashMap<String, AccessPolicy>,
}

impl FixturePolicyPackage {
    fn load(host_root: impl Into<PathBuf>) -> Self {
        let host_root = host_root.into();
        let manifest_text = std::fs::read_to_string(host_root.join("package.toml"))
            .expect("test fixture package.toml is present");

        let (id, source, case_rule, policies) = parse_minimal_toml(&manifest_text);

        Self {
            id,
            host_root,
            case_rule,
            source,
            policies,
        }
    }

    fn join_under_root(&self, id: &AssetId) -> VfsResult<PathBuf> {
        let path = id.path();
        let stripped = path.strip_suffix('/').unwrap_or(path);
        let mut accumulator = self.host_root.clone();
        if stripped.is_empty() {
            return Ok(accumulator);
        }
        for segment in stripped.split('/') {
            if segment.is_empty() || segment == "." || segment == ".." {
                return Err(VfsError::AssetPathUnsafe {
                    package: self.id.clone(),
                    logical: stripped.to_string(),
                    kind: TraversalKind::ParentEscape,
                });
            }
            accumulator.push(segment);
        }
        Ok(accumulator)
    }

    fn policy_for(&self, id: &AssetId) -> AccessPolicy {
        let path = id.path().trim_end_matches('/');
        self.policies
            .get(path)
            .cloned()
            .unwrap_or(AccessPolicy::Plaintext)
    }
}

impl AssetPackage for FixturePolicyPackage {
    fn id(&self) -> &str {
        &self.id
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id.clone(),
            kind: PackageKind::Plaintext,
            case_rule: self.case_rule,
            source: self.source.clone(),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        self.case_rule
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        let canonical = utsushi_core::vfs::validate_logical_path(&self.id, logical)?;
        AssetId::from_parts(&self.id, &canonical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        if id.package() != self.id {
            return Ok(false);
        }
        // Helper-gated / encrypted assets are observably present even when
        // their bytes are not.
        if matches!(
            self.policy_for(id),
            AccessPolicy::Encrypted(_) | AccessPolicy::HelperGated(_)
        ) {
            return Ok(true);
        }
        let host = self.join_under_root(id)?;
        Ok(host.exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        if id.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: id.clone(),
                package: self.id.clone(),
            });
        }
        let host = self.join_under_root(id)?;
        let metadata = match std::fs::symlink_metadata(&host) {
            Ok(m) => m,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(VfsError::AssetMissing { id: id.clone() });
            }
            Err(error) => {
                return Err(VfsError::PackageIo {
                    id: id.clone(),
                    summary: IoSummary::from_io_error_kind(error.kind()),
                });
            }
        };
        if metadata.is_dir() {
            Ok(AssetMetadata {
                id: id.clone(),
                kind: AssetKind::Directory,
                size: AssetSize::Unknown,
                revision: None,
            })
        } else {
            Ok(AssetMetadata {
                id: id.clone(),
                kind: AssetKind::File,
                size: AssetSize::Bytes(metadata.len()),
                revision: None,
            })
        }
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        if id.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: id.clone(),
                package: self.id.clone(),
            });
        }
        if id.is_directory() {
            return Err(VfsError::AssetNotFile { id: id.clone() });
        }
        match self.policy_for(id) {
            AccessPolicy::Encrypted(capability) => {
                return Err(VfsError::AssetEncrypted {
                    id: id.clone(),
                    required_capability: capability,
                });
            }
            AccessPolicy::HelperGated(helper) => {
                return Err(VfsError::AssetHelperGated {
                    id: id.clone(),
                    helper_id: helper,
                });
            }
            AccessPolicy::Plaintext => {}
        }
        let host = self.join_under_root(id)?;
        match std::fs::read(&host) {
            Ok(bytes) => Ok(AssetBytes::from(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(VfsError::AssetMissing { id: id.clone() })
            }
            Err(error) => Err(VfsError::PackageIo {
                id: id.clone(),
                summary: IoSummary::from_io_error_kind(error.kind()),
            }),
        }
    }

    fn list(&self, prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        if prefix.package() != self.id {
            return Err(VfsError::AssetOutsidePackage {
                id: prefix.clone(),
                package: self.id.clone(),
            });
        }
        if !prefix.is_directory() {
            return Err(VfsError::AssetNotDirectory { id: prefix.clone() });
        }
        let host = self.join_under_root(prefix)?;
        let entries = match std::fs::read_dir(&host) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(VfsError::AssetMissing { id: prefix.clone() });
            }
            Err(error) => {
                return Err(VfsError::PackageIo {
                    id: prefix.clone(),
                    summary: IoSummary::from_io_error_kind(error.kind()),
                });
            }
        };
        let mut children: Vec<(String, bool)> = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| VfsError::PackageIo {
                id: prefix.clone(),
                summary: IoSummary::from_io_error_kind(error.kind()),
            })?;
            let file_name = entry.file_name();
            let Some(name_str) = file_name.to_str() else {
                continue;
            };
            // Hide the manifest from listings — it is metadata, not an asset.
            if prefix.is_package_root() && name_str == "package.toml" {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| VfsError::PackageIo {
                id: prefix.clone(),
                summary: IoSummary::from_io_error_kind(error.kind()),
            })?;
            if !file_type.is_dir() && !file_type.is_file() {
                continue;
            }
            children.push((name_str.to_string(), file_type.is_dir()));
        }
        children.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut ids = Vec::with_capacity(children.len());
        for (name, is_dir) in children {
            let relative = if is_dir { format!("{name}/") } else { name };
            ids.push(prefix.join(&relative)?);
        }
        Ok(ids)
    }
}

// Hand-rolled minimal manifest parser: enough for the four keys the fixture
// uses, with no extra dependencies. The format is a strict subset of TOML.
fn parse_minimal_toml(
    text: &str,
) -> (
    String,
    PackageSource,
    CaseRule,
    HashMap<String, AccessPolicy>,
) {
    let mut id = String::new();
    let mut public_source = String::new();
    let mut case_rule = CaseRule::Sensitive;
    let mut policies = HashMap::new();
    let mut current_policy: Option<PolicyBuilder> = None;

    fn extract_string(value: &str) -> String {
        let trimmed = value.trim();
        trimmed
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(trimmed)
            .to_string()
    }

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "[[policy]]" {
            if let Some(builder) = current_policy.take() {
                let (path, policy) = builder.build();
                policies.insert(path, policy);
            }
            current_policy = Some(PolicyBuilder::default());
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = extract_string(value);
        match (current_policy.as_mut(), key) {
            (None, "id") => id = value,
            (None, "public_source") => public_source = value,
            (None, "case_rule") => {
                case_rule = match value.as_str() {
                    "insensitive_ascii" => CaseRule::InsensitiveAscii,
                    _ => CaseRule::Sensitive,
                };
            }
            (Some(builder), "path") => builder.path = value,
            (Some(builder), "access") => builder.access = value,
            (Some(builder), "required_capability") => builder.required_capability = value,
            (Some(builder), "helper_id") => builder.helper_id = value,
            _ => {}
        }
    }
    if let Some(builder) = current_policy.take() {
        let (path, policy) = builder.build();
        policies.insert(path, policy);
    }

    (
        id,
        PackageSource::PublicName(public_source),
        case_rule,
        policies,
    )
}

#[derive(Default)]
struct PolicyBuilder {
    path: String,
    access: String,
    required_capability: String,
    helper_id: String,
}

impl PolicyBuilder {
    fn build(self) -> (String, AccessPolicy) {
        let policy = match self.access.as_str() {
            "encrypted" => {
                let cap = match self.required_capability.as_str() {
                    "key_profile" => RequiredCapability::KeyProfile,
                    "key_material" => RequiredCapability::KeyMaterial,
                    "container" => RequiredCapability::Container,
                    _ => RequiredCapability::Crypto,
                };
                AccessPolicy::Encrypted(cap)
            }
            "helper_gated" => AccessPolicy::HelperGated(HelperId::Named(self.helper_id)),
            _ => AccessPolicy::Plaintext,
        };
        (self.path, policy)
    }
}

fn fixture_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("tests/fixtures/synthetic-package")
}

fn fixture_package() -> Arc<FixturePolicyPackage> {
    Arc::new(FixturePolicyPackage::load(fixture_root()))
}

// The UTSUSHI-020 route-by-package-id `MountedVfs` is removed; the
// synthetic fixture exercises the `AssetPackage` boundary directly. The
// composite path is exercised by `composite_asset_package.rs` and the
// real-bytes integration suite. See
// `docs/orchestration-operating-model.md` "Legacy-path preservation"
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
    let names: Vec<&str> = children.iter().map(|id| id.path()).collect();
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
/// after UTSUSHI-224 we exercise the redaction filter directly.
fn assert_message_passes_redaction(message: &str) -> Result<(), Box<dyn std::error::Error>> {
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
    // /tmp/... directory — Display output must still not contain that
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
