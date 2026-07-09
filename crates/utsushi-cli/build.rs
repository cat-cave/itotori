use std::collections::BTreeSet;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
struct EnginePortImpl {
    crate_name: String,
    crate_ident: String,
    type_name: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct WorkspacePackage {
    id: String,
    name: String,
    manifest_path: PathBuf,
    dependencies: BTreeSet<String>,
}

fn main() {
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set for build scripts"),
    );
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("utsushi-cli lives under <workspace>/crates/utsushi-cli");

    println!(
        "cargo:rerun-if-changed={}",
        workspace_root.join("Cargo.toml").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("Cargo.toml").display()
    );

    let workspace_manifest_path = workspace_root.join("Cargo.toml");
    let workspace_metadata = cargo_metadata(&workspace_manifest_path);
    let workspace_packages = workspace_packages_from_metadata(&workspace_metadata);
    let cli_dependencies = workspace_packages
        .iter()
        .find(|package| package.name == "utsushi-cli")
        .unwrap_or_else(|| panic!("cargo metadata did not include utsushi-cli"))
        .dependencies
        .clone();
    let engine_impls = discover_engine_impls(&workspace_packages, &cli_dependencies);

    assert!(
        !engine_impls.is_empty(),
        "workspace scan discovered no utsushi EnginePort implementors"
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set for build scripts"));
    let generated_path = out_dir.join("engine_parity_registry.rs");
    fs::write(&generated_path, generated_registry(&engine_impls))
        .unwrap_or_else(|error| panic!("write {}: {error}", generated_path.display()));
}

fn discover_engine_impls(
    workspace_packages: &[WorkspacePackage],
    cli_dependencies: &BTreeSet<String>,
) -> BTreeSet<EnginePortImpl> {
    let mut engine_impls = BTreeSet::new();
    for package in workspace_packages {
        let crate_name = &package.name;
        if crate_name == "utsushi-core" || crate_name == "utsushi-cli" {
            continue;
        }
        if !package.dependencies.contains("utsushi-core") {
            continue;
        }

        let crate_manifest_path = &package.manifest_path;
        println!("cargo:rerun-if-changed={}", crate_manifest_path.display());
        let crate_dir = crate_manifest_path.parent().unwrap_or_else(|| {
            panic!(
                "cargo metadata manifest path has no parent: {}",
                crate_manifest_path.display()
            )
        });
        let src_dir = crate_dir.join("src");
        if !src_dir.is_dir() {
            continue;
        }

        let mut rs_files = Vec::new();
        collect_rs_files(&src_dir, &mut rs_files);
        let mut crate_impl_types = BTreeSet::new();
        let mut publishes_parity_profile = false;
        for rs_file in rs_files {
            println!("cargo:rerun-if-changed={}", rs_file.display());
            let source = read_to_string(&rs_file);
            publishes_parity_profile |= source.contains("PARITY_PROFILE");
            crate_impl_types.extend(engine_port_impl_types(&source));
        }

        if crate_impl_types.is_empty() {
            continue;
        }
        assert!(
            publishes_parity_profile,
            "{crate_name} implements EnginePort but does not publish a PARITY_PROFILE"
        );
        assert!(
            cli_dependencies.contains(crate_name),
            "{crate_name} implements EnginePort but is not visible to utsushi-cli; \
             add it to crates/utsushi-cli/Cargo.toml so the generated parity gate can import it"
        );

        let crate_ident = crate_name.replace('-', "_");
        for type_name in crate_impl_types {
            engine_impls.insert(EnginePortImpl {
                crate_name: crate_name.clone(),
                crate_ident: crate_ident.clone(),
                type_name,
            });
        }
    }

    engine_impls
}

fn read_to_string(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn cargo_metadata(workspace_manifest_path: &Path) -> serde_json::Value {
    let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
        ])
        .arg(workspace_manifest_path)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "run cargo metadata for {}: {error}",
                workspace_manifest_path.display()
            )
        });
    assert!(
        output.status.success(),
        "cargo metadata failed for {}:\n{}",
        workspace_manifest_path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "parse cargo metadata JSON for {}: {error}",
            workspace_manifest_path.display()
        )
    })
}

fn workspace_packages_from_metadata(metadata: &serde_json::Value) -> Vec<WorkspacePackage> {
    let workspace_members: BTreeSet<&str> = metadata["workspace_members"]
        .as_array()
        .unwrap_or_else(|| panic!("cargo metadata JSON missing workspace_members array"))
        .iter()
        .map(|member| {
            member
                .as_str()
                .unwrap_or_else(|| panic!("cargo metadata workspace member id is not a string"))
        })
        .collect();
    let mut packages: Vec<WorkspacePackage> = metadata["packages"]
        .as_array()
        .unwrap_or_else(|| panic!("cargo metadata JSON missing packages array"))
        .iter()
        .filter(|package| {
            let id = package["id"]
                .as_str()
                .unwrap_or_else(|| panic!("cargo metadata package id is not a string"));
            workspace_members.contains(id)
        })
        .map(|package| {
            let id = package["id"]
                .as_str()
                .unwrap_or_else(|| panic!("cargo metadata package id is not a string"))
                .to_string();
            let name = package["name"]
                .as_str()
                .unwrap_or_else(|| panic!("cargo metadata package {id} has no string name"))
                .to_string();
            let manifest_path =
                PathBuf::from(package["manifest_path"].as_str().unwrap_or_else(|| {
                    panic!("cargo metadata package {id} has no string manifest_path")
                }));
            let dependencies = package["dependencies"]
                .as_array()
                .unwrap_or_else(|| panic!("cargo metadata package {id} has no dependencies array"))
                .iter()
                .map(|dependency| {
                    dependency["name"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("cargo metadata dependency in package {id} has no string name")
                        })
                        .to_string()
                })
                .collect();
            WorkspacePackage {
                id,
                name,
                manifest_path,
                dependencies,
            }
        })
        .collect();
    packages.sort_by(|left, right| left.manifest_path.cmp(&right.manifest_path));
    packages
}

fn collect_rs_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("read directory {}: {error}", dir.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| {
                    panic!("read directory entry in {}: {error}", dir.display())
                })
                .path()
        })
        .collect();
    entries.sort_unstable();

    for path in entries {
        if path.is_dir() {
            collect_rs_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn engine_port_impl_types(source: &str) -> BTreeSet<String> {
    let source_without_line_comments = source
        .lines()
        .map(|line| line.split_once("//").map_or(line, |(code, _)| code))
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = source_without_line_comments
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut types = BTreeSet::new();
    let mut cursor = normalized.as_str();

    while let Some(impl_offset) = cursor.find("impl ") {
        cursor = &cursor[impl_offset + "impl ".len()..];
        let Some(for_offset) = cursor.find(" for ") else {
            break;
        };
        let trait_part = cursor[..for_offset].trim();
        let after_for = &cursor[for_offset + " for ".len()..];
        if trait_part.ends_with("EnginePort")
            && let Some(type_name) = engine_port_impl_type_name(after_for)
        {
            types.insert(type_name.to_string());
        }
        cursor = after_for;
    }

    types
}

fn engine_port_impl_type_name(after_for: &str) -> Option<&str> {
    let before_body = after_for
        .split_once('{')
        .map_or(after_for, |(head, _)| head);
    let before_where = before_body
        .split_once(" where ")
        .map_or(before_body, |(head, _)| head);
    let base_type = before_where
        .trim()
        .trim_start_matches('&')
        .split_once('<')
        .map_or(before_where.trim(), |(head, _)| head.trim());
    let type_name = base_type.rsplit("::").next()?.trim();
    is_rust_ident(type_name).then_some(type_name)
}

fn is_rust_ident(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|char| char == '_' || char.is_ascii_alphanumeric())
}

fn generated_registry(engine_impls: &BTreeSet<EnginePortImpl>) -> String {
    let mut generated =
        String::from("// @generated by crates/utsushi-cli/build.rs; do not edit by hand.\n\n");
    generated
        .push_str("fn registered_engine_profiles() -> Vec<EngineParityProfile> {\n    vec![\n");
    for engine_impl in engine_impls {
        writeln!(
            &mut generated,
            "        {}::{}::PARITY_PROFILE,",
            engine_impl.crate_ident, engine_impl.type_name
        )
        .expect("write generated profile expression");
    }
    generated.push_str("    ]\n}\n\n");
    generated.push_str("const DISCOVERED_ENGINE_PORT_IMPLS: &[(&str, &str)] = &[\n");
    for engine_impl in engine_impls {
        writeln!(
            &mut generated,
            "    (\"{}\", \"{}\"),",
            engine_impl.crate_name, engine_impl.type_name
        )
        .expect("write generated impl label");
    }
    generated.push_str("];\n");
    generated
}

#[cfg(test)]
mod tests {
    use super::{EnginePortImpl, discover_engine_impls, workspace_packages_from_metadata};
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::env;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn metadata_driven_discovery_finds_engine_crate_with_atypical_manifest_layout() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after unix epoch")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "utsushi-cli-build-script-discovery-{}-{unique}",
            std::process::id()
        ));
        let crate_dir = root.join("crates").join("utsushi-atypical");
        let src_dir = crate_dir.join("src");
        fs::create_dir_all(&src_dir)
            .unwrap_or_else(|error| panic!("create {}: {error}", src_dir.display()));
        fs::write(
            crate_dir.join("Cargo.toml"),
            r#"
[package]
edition.workspace = true
name = "utsushi-atypical"
version = "0.0.0"

[dependencies]
"core-facade" = { package = "utsushi-core", path = "../utsushi-core" }
"#,
        )
        .unwrap_or_else(|error| panic!("write atypical Cargo.toml: {error}"));
        fs::write(
            src_dir.join("lib.rs"),
            r"
pub struct OddPort;

impl utsushi_core::substrate::EnginePort for OddPort {}

impl OddPort {
    pub const PARITY_PROFILE: () = ();
}
",
        )
        .unwrap_or_else(|error| panic!("write atypical lib.rs: {error}"));

        let cli_manifest = root
            .join("crates")
            .join("utsushi-cli")
            .join("Cargo.toml")
            .to_string_lossy()
            .into_owned();
        let engine_manifest = crate_dir.join("Cargo.toml").to_string_lossy().into_owned();
        let metadata = json!({
            "workspace_members": [
                "path+file:///tmp/utsushi-cli#0.0.0",
                "path+file:///tmp/utsushi-atypical#0.0.0"
            ],
            "packages": [
                {
                    "id": "path+file:///tmp/utsushi-cli#0.0.0",
                    "name": "utsushi-cli",
                    "manifest_path": cli_manifest,
                    "dependencies": [
                        { "name": "utsushi-atypical", "rename": null }
                    ]
                },
                {
                    "id": "path+file:///tmp/utsushi-atypical#0.0.0",
                    "name": "utsushi-atypical",
                    "manifest_path": engine_manifest,
                    "dependencies": [
                        { "name": "utsushi-core", "rename": "core-facade" }
                    ]
                }
            ]
        });
        let packages = workspace_packages_from_metadata(&metadata);
        let cli_dependencies = packages
            .iter()
            .find(|package| package.name == "utsushi-cli")
            .expect("synthetic metadata includes utsushi-cli")
            .dependencies
            .clone();

        let discovered = discover_engine_impls(&packages, &cli_dependencies);

        assert_eq!(
            discovered,
            BTreeSet::from([EnginePortImpl {
                crate_name: "utsushi-atypical".to_string(),
                crate_ident: "utsushi_atypical".to_string(),
                type_name: "OddPort".to_string(),
            }]),
            "Cargo metadata must make renamed/quoted dependency declarations discoverable",
        );

        if let Err(error) = fs::remove_dir_all(&root) {
            eprintln!("failed to remove {}: {error}", root.display());
        }
    }
}
