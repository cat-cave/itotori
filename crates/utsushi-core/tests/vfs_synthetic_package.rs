//! Integration tests for the UTSUSHI-020 Slice A runtime VFS.
//!
//! Exercises the diagnostic enum via a `FixturePolicyPackage` test type that
//! reads `package.toml` and produces the right `VfsError` variants on
//! `open`. Plaintext bytes are read straight off disk; encrypted and
//! helper-gated paths are modelled at the diagnostic level only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use utsushi_core::vfs::case_rule_matches;
use utsushi_core::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, EvidenceTier,
    HelperId, IoSummary, MountedVfs, OBSERVATION_HOOK_SCHEMA_VERSION, ObservationAdapterId,
    ObservationEnvironment, ObservationErrorPayload, ObservationHookEvent,
    ObservationHookEventKind, ObservationHookPayload, ObservationRedactionMetadata,
    PackageDescriptor, PackageKind, PackageSource, RequiredCapability, RuntimeAdapterDiagnostic,
    RuntimeVfs, TraversalKind, VfsError, VfsResult,
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

fn mount(package: Arc<FixturePolicyPackage>) -> MountedVfs {
    let mut vfs = MountedVfs::new();
    vfs.mount(package as Arc<dyn AssetPackage>).unwrap();
    vfs
}

#[test]
fn synthetic_package_open_returns_plaintext_bytes_for_intro_txt() {
    let vfs = mount(fixture_package());
    let id = vfs.resolve("synthetic", "hello/intro.txt").unwrap();
    let bytes = vfs.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"hello world!");
    assert_eq!(bytes.len(), 12);
}

#[test]
fn synthetic_package_list_root_returns_three_subdirectories() {
    let vfs = mount(fixture_package());
    let root = AssetId::from_parts("synthetic", "").unwrap();
    let children = vfs.list(&root).unwrap();
    let names: Vec<&str> = children.iter().map(|id| id.path()).collect();
    assert_eq!(names, vec!["encrypted/", "hello/", "helper-gated/"]);
}

#[test]
fn synthetic_package_stat_directory_reports_directory_kind() {
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("synthetic", "hello/").unwrap();
    let metadata = vfs.stat(&id).unwrap();
    assert_eq!(metadata.kind, AssetKind::Directory);
    assert_eq!(metadata.size, AssetSize::Unknown);
}

#[test]
fn synthetic_package_stat_file_reports_file_kind_and_byte_size() {
    let vfs = mount(fixture_package());
    let id = vfs.resolve("synthetic", "hello/intro.txt").unwrap();
    let metadata = vfs.stat(&id).unwrap();
    assert_eq!(metadata.kind, AssetKind::File);
    assert_eq!(metadata.size, AssetSize::Bytes(12));
}

#[test]
fn synthetic_package_open_missing_path_returns_asset_missing() {
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("synthetic", "hello/absent.txt").unwrap();
    let error = vfs.open(&id).unwrap_err();
    match error {
        VfsError::AssetMissing { id: missing } => {
            assert_eq!(missing.path(), "hello/absent.txt");
        }
        other => panic!("expected AssetMissing, got {other:?}"),
    }
}

#[test]
fn synthetic_package_open_encrypted_asset_returns_asset_encrypted_with_crypto_capability() {
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("synthetic", "encrypted/locked.bin").unwrap();
    let error = vfs.open(&id).unwrap_err();
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
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("synthetic", "helper-gated/remote.bin").unwrap();
    let error = vfs.open(&id).unwrap_err();
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
    let vfs = mount(fixture_package());
    let error = vfs.resolve("synthetic", "../escape.txt").unwrap_err();
    match error {
        VfsError::AssetPathUnsafe { kind, .. } => {
            assert_eq!(kind, TraversalKind::ParentEscape);
        }
        other => panic!("expected AssetPathUnsafe, got {other:?}"),
    }
}

#[test]
fn synthetic_package_resolve_drive_letter_returns_asset_path_unsafe_absolute_root() {
    let vfs = mount(fixture_package());
    let error = vfs.resolve("synthetic", "C:/Windows/system32").unwrap_err();
    match error {
        VfsError::AssetPathUnsafe { kind, .. } => {
            assert_eq!(kind, TraversalKind::AbsoluteRoot);
        }
        other => panic!("expected AssetPathUnsafe, got {other:?}"),
    }
}

#[test]
fn mounted_vfs_routes_to_correct_package_by_id() {
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("synthetic", "hello/intro.txt").unwrap();
    let bytes = vfs.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"hello world!");
}

#[test]
fn mounted_vfs_unknown_package_id_returns_asset_outside_package() {
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("not-mounted", "x.txt").unwrap();
    let error = vfs.open(&id).unwrap_err();
    match error {
        VfsError::AssetOutsidePackage { package, .. } => assert_eq!(package, "not-mounted"),
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

fn observation_event_for_message(message: String) -> ObservationHookEvent {
    ObservationHookEvent {
        schema_version: OBSERVATION_HOOK_SCHEMA_VERSION.to_string(),
        event_id: "obs-vfs-0001".to_string(),
        observed_at: "2026-06-23T12:00:00.000Z".to_string(),
        event_kind: ObservationHookEventKind::Error,
        runtime_target_id: "fixture:runtime-target".to_string(),
        adapter_id: ObservationAdapterId {
            name: "utsushi-vfs-test".to_string(),
            version: "0.0.0-test".to_string(),
        },
        evidence_tier: EvidenceTier::E1,
        environment: ObservationEnvironment {
            runtime: "browser".to_string(),
            engine: Some("test-engine".to_string()),
            platform: Some("linux".to_string()),
            display: Some("browser-headless".to_string()),
            locale: Some("ja-JP".to_string()),
        },
        source_revision: None,
        bridge_refs: Vec::new(),
        redaction: ObservationRedactionMetadata::not_required(),
        payload: ObservationHookPayload::Error(ObservationErrorPayload {
            error_type: "vfs_diagnostic".to_string(),
            message,
            fatal: false,
            stack: None,
        }),
    }
}

#[test]
fn vfs_error_serialized_into_runtime_diagnostic_passes_observation_redaction() {
    // Wrap a VfsError into a RuntimeAdapterDiagnostic, embed its
    // `Display` text into an ObservationHookEvent error payload, and
    // round-trip it through ObservationHookEvent::from_json_value (which
    // calls `validate`). The internal `reject_unredacted_local_paths`
    // filter must accept it.
    let vfs = mount(fixture_package());
    let id = AssetId::from_parts("synthetic", "hello/absent.txt").unwrap();
    let error = vfs.open(&id).unwrap_err();
    let asset_ref = error.asset_ref();
    let diagnostic =
        RuntimeAdapterDiagnostic::new("asset_loader", "blocked", "warning", error.to_string())
            .with_detail("semanticCode", error.semantic_code())
            .with_detail_value(
                "assetRef",
                serde_json::to_value(&asset_ref).expect("AssetRef serializes"),
            );

    let event = observation_event_for_message(diagnostic.message.clone());
    let value = event
        .to_json_value()
        .expect("observation hook payload validates with VFS diagnostic display message embedded");
    let round_tripped = ObservationHookEvent::from_json_value(value).unwrap();
    assert_eq!(round_tripped.event_kind, ObservationHookEventKind::Error);
}

#[test]
fn every_vfs_error_display_passes_observation_redaction() {
    // Exhaustively check the Display text for every variant — feed each as
    // an ObservationErrorPayload message and require validate() to accept.
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
        let event = observation_event_for_message(error.to_string());
        event
            .to_json_value()
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
