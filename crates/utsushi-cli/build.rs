use std::collections::BTreeSet;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
struct EnginePortImpl {
    crate_name: String,
    crate_ident: String,
    type_name: String,
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

    let workspace_cargo = read_to_string(&workspace_root.join("Cargo.toml"));
    let workspace_members = workspace_members(&workspace_cargo);
    let cli_cargo = read_to_string(&manifest_dir.join("Cargo.toml"));

    let mut engine_impls = BTreeSet::new();
    for member in &workspace_members {
        if !member.starts_with("crates/utsushi-") {
            continue;
        }

        let crate_dir = workspace_root.join(member);
        let crate_manifest_path = crate_dir.join("Cargo.toml");
        let crate_manifest = read_to_string(&crate_manifest_path);
        let crate_name = package_name(&crate_manifest)
            .unwrap_or_else(|| panic!("{} has no [package] name", crate_manifest_path.display()));

        if crate_name == "utsushi-core" || crate_name == "utsushi-cli" {
            continue;
        }
        if !manifest_depends_on_utsushi_core(&crate_manifest) {
            continue;
        }

        println!("cargo:rerun-if-changed={}", crate_manifest_path.display());
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
            manifest_declares_dependency(&cli_cargo, &crate_name),
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

    assert!(
        !engine_impls.is_empty(),
        "workspace scan discovered no utsushi EnginePort implementors"
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set for build scripts"));
    let generated_path = out_dir.join("engine_parity_registry.rs");
    fs::write(&generated_path, generated_registry(&engine_impls))
        .unwrap_or_else(|error| panic!("write {}: {error}", generated_path.display()));
}

fn read_to_string(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn workspace_members(workspace_cargo: &str) -> BTreeSet<String> {
    let mut members = BTreeSet::new();
    let mut in_members = false;

    for line in workspace_cargo.lines() {
        let trimmed = strip_toml_comment(line).trim();
        if trimmed.is_empty() {
            continue;
        }
        if in_members {
            collect_quoted_strings(trimmed, &mut members);
            if trimmed.contains(']') {
                in_members = false;
            }
            continue;
        }
        if trimmed.starts_with("members") && trimmed.contains('[') {
            in_members = true;
            collect_quoted_strings(trimmed, &mut members);
            if trimmed.contains(']') {
                in_members = false;
            }
        }
    }

    members
}

fn collect_quoted_strings(line: &str, output: &mut BTreeSet<String>) {
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('"') else {
            return;
        };
        output.insert(after_start[..end].to_string());
        rest = &after_start[end + 1..];
    }
}

fn package_name(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let trimmed = strip_toml_comment(line).trim();
        if trimmed == "[package]" {
            in_package = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_package = false;
            continue;
        }
        if in_package && let Some(raw_name) = trimmed.strip_prefix("name = ") {
            return unquote(raw_name.trim()).map(ToOwned::to_owned);
        }
    }
    None
}

fn manifest_depends_on_utsushi_core(manifest: &str) -> bool {
    manifest_declares_dependency(manifest, "utsushi-core")
}

fn manifest_declares_dependency(manifest: &str, dependency_name: &str) -> bool {
    let mut in_dependencies = false;
    let table_name = format!("[{dependency_name}]");
    let dependency_prefix = format!("{dependency_name} ");
    let inline_dependency_prefix = format!("{dependency_name}.");

    for line in manifest.lines() {
        let trimmed = strip_toml_comment(line).trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('[') {
            in_dependencies = matches!(
                trimmed,
                "[dependencies]" | "[dev-dependencies]" | "[build-dependencies]"
            ) || trimmed.ends_with(&table_name);
            continue;
        }
        if in_dependencies
            && (trimmed.starts_with(&dependency_prefix)
                || trimmed.starts_with(&inline_dependency_prefix))
        {
            return true;
        }
    }
    false
}

fn strip_toml_comment(line: &str) -> &str {
    line.split_once('#')
        .map_or(line, |(before_comment, _)| before_comment)
}

fn unquote(raw: &str) -> Option<&str> {
    raw.strip_prefix('"')?
        .split_once('"')
        .map(|(value, _)| value)
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
