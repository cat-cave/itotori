use std::{
    fs,
    path::{Path, PathBuf},
};

use super::*;

#[test]
fn holder_and_resolver_debug_are_redacted() {
    let raw = b"shared-secret-holder-test-key".to_vec();
    let secret_ref = SecretRef::new("local-secret:shared-secret-holder-test").unwrap();
    let resolver =
        SecretRefSecretResolver::from_entries(vec![(secret_ref.as_str().to_string(), raw)]);
    let holder = resolver.resolve(&secret_ref).expect("secret resolves");

    for rendered in [format!("{holder:?}"), format!("{resolver:?}")] {
        assert!(rendered.contains(REDACTED));
        assert!(!rendered.contains("shared-secret-holder-test-key"));
    }
}

#[test]
fn resolver_scans_all_held_key_bytes() {
    let a_ref = SecretRef::new("local-secret:shared-secret-holder-a").unwrap();
    let b_ref = SecretRef::new("local-secret:shared-secret-holder-b").unwrap();
    let resolver = SecretRefSecretResolver::from_entries(vec![
        (a_ref.as_str().to_string(), b"held-key-a".to_vec()),
        (b_ref.as_str().to_string(), b"held-key-b".to_vec()),
    ]);

    assert!(resolver.any_key_appears_in(b"prefix held-key-a suffix"));
    assert!(resolver.any_key_appears_in(b"prefix held-key-b suffix"));
    assert!(!resolver.any_key_appears_in(b"prefix held-key-c suffix"));
}

#[test]
fn crypt_modules_do_not_expose_raw_key_constructors_or_debug_derives() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("kaifuu-core is under crates/");
    let crypt_sources = collect_kaifuu_crypt_sources(root);
    assert_has_crypt_source(&crypt_sources, "crates/kaifuu-kirikiri/src/xp3_crypt.rs");
    assert_has_crypt_source(
        &crypt_sources,
        "crates/kaifuu-kirikiri/src/xp3_production.rs",
    );
    assert_has_crypt_source(
        &crypt_sources,
        "crates/kaifuu-core/src/wolf_encrypted_smoke.rs",
    );
    assert_has_crypt_source(
        &crypt_sources,
        "crates/kaifuu-core/src/wolf_profiled_production.rs",
    );
    assert_has_crypt_source(
        &crypt_sources,
        "crates/kaifuu-siglus/src/known_key_smoke.rs",
    );
    assert_has_crypt_source(&crypt_sources, "crates/kaifuu-siglus/src/adapter.rs");
    assert_has_crypt_source(&crypt_sources, "crates/kaifuu-core/src/mv_mz_asset_xor.rs");

    for source_path in crypt_sources {
        let source = fs::read_to_string(&source_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", source_path.display()));
        assert!(
            public_raw_key_constructor_findings(&source).is_empty(),
            "{} exposes a crate-wide raw-key constructor",
            source_path.display()
        );
        assert!(
            debug_secret_derive_findings(&source).is_empty(),
            "{} derives Debug on a crypt key holder",
            source_path.display()
        );
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("kaifuu-core is under crates/");
    let xp3_crypt = fs::read_to_string(root.join("crates/kaifuu-kirikiri/src/xp3_crypt.rs"))
        .expect("read xp3 crypt source");
    assert!(
        !xp3_crypt.contains("pub(crate) fn from_entries(entries: Vec<(String, Vec<u8>)>)")
            && !xp3_crypt.contains("pub fn from_entries(entries: Vec<(String, Vec<u8>)>)"),
        "XP3 fixture resolver must not expose a crate-wide raw-entry constructor"
    );

    let xp3_production =
        fs::read_to_string(root.join("crates/kaifuu-kirikiri/src/xp3_production.rs"))
            .expect("read xp3 production source");
    assert!(
        !xp3_production.contains("archive_key: Vec<u8>")
            && !xp3_production.contains("resolved_key_evidence: Option<Vec<u8>>"),
        "XP3 production public constructor must require ZeroizingSecretBytes holders, not raw Vec<u8> keys"
    );
}

fn collect_kaifuu_crypt_sources(root: &Path) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    let crates_dir = root.join("crates");
    for entry in fs::read_dir(&crates_dir).expect("read crates directory") {
        let entry = entry.expect("read crate directory entry");
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("kaifuu-") {
            continue;
        }
        collect_crypt_sources_under(&path.join("src"), &mut sources);
    }
    sources.sort();
    sources
}

fn collect_crypt_sources_under(dir: &Path, sources: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let entry = entry.expect("read source entry");
        let path = entry.path();
        if path.is_dir() {
            collect_crypt_sources_under(&path, sources);
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("rs") {
            continue;
        }
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        if is_crypt_source(&path, &source) {
            sources.push(path);
        }
    }
}

fn is_crypt_source(path: &Path, source: &str) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if name == "secret_holder.rs" || name.ends_with("_tests.rs") {
        return false;
    }
    let path_text = path.to_string_lossy();
    let crypt_path = ["crypt", "encrypt", "decrypt", "key", "xor"]
        .iter()
        .any(|token| path_text.contains(token));
    let shared_holder_path = [
        "ZeroizingSecretBytes",
        "KnownKeyMaterial",
        "ResolvedSiglusKey",
        "WolfEncryptedArchiveKey",
        "Xp3CryptKey",
        "MvMzAssetKey",
    ]
    .iter()
    .any(|token| source.contains(token));
    crypt_path || shared_holder_path
}

fn assert_has_crypt_source(sources: &[PathBuf], suffix: &str) {
    assert!(
        sources
            .iter()
            .any(|path| path.to_string_lossy().ends_with(suffix)),
        "crypt source discovery missed {suffix}; found: {sources:?}"
    );
}

fn public_raw_key_constructor_findings(source: &str) -> Vec<&'static str> {
    [
        "pub(crate) fn from_resolved_bytes",
        "pub fn from_resolved_bytes",
        "pub(crate) fn from_entries(entries: Vec<(String, Vec<u8>)>)",
        "pub fn from_entries(entries: Vec<(String, Vec<u8>)>)",
        "pub(crate) fn xp3_key_from_secret_ref_entry",
        "pub fn xp3_key_from_secret_ref_entry",
        "pub(crate) fn wolf_key_from_secret_ref_entry",
        "pub fn wolf_key_from_secret_ref_entry",
    ]
    .into_iter()
    .filter(|pattern| source.contains(pattern))
    .collect()
}

fn debug_secret_derive_findings(source: &str) -> Vec<String> {
    let mut findings = Vec::new();
    let lines = source.lines().collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains("#[derive(") || !line.contains("Debug") {
            continue;
        }
        let Some((struct_line_index, struct_name)) = next_struct_name(&lines, index + 1) else {
            continue;
        };
        if !is_secretish_name(struct_name) {
            continue;
        }
        let body = struct_body(&lines, struct_line_index);
        if contains_raw_secret_field(&body) {
            findings.push(format!(
                "{struct_name} derives Debug while holding raw secret bytes"
            ));
        }
    }
    findings
}

fn next_struct_name<'a>(lines: &'a [&str], start: usize) -> Option<(usize, &'a str)> {
    for (index, line) in lines.iter().enumerate().skip(start) {
        let trimmed = line.trim();
        if trimmed.starts_with("#[") || trimmed.is_empty() {
            continue;
        }
        let rest = trimmed
            .strip_prefix("pub(crate) struct ")
            .or_else(|| trimmed.strip_prefix("pub struct "))
            .or_else(|| trimmed.strip_prefix("struct "))?;
        let name = rest
            .split(|character: char| {
                character == '<'
                    || character == '{'
                    || character == '('
                    || character.is_whitespace()
            })
            .next()?;
        return Some((index, name));
    }
    None
}

fn is_secretish_name(name: &str) -> bool {
    ["Key", "Secret", "Password", "Material"]
        .iter()
        .any(|token| name.contains(token))
}

fn struct_body(lines: &[&str], start: usize) -> String {
    let mut body = String::new();
    let mut depth = 0_i32;
    let mut saw_open = false;
    for line in lines.iter().skip(start) {
        for character in line.chars() {
            if character == '{' {
                depth += 1;
                saw_open = true;
            } else if character == '}' {
                depth -= 1;
            }
        }
        body.push_str(line);
        body.push('\n');
        if saw_open && depth <= 0 {
            break;
        }
    }
    body
}

fn contains_raw_secret_field(body: &str) -> bool {
    [
        "Vec<u8>",
        "[u8;",
        ": ZeroizingSecretBytes",
        ": KnownKeyMaterial",
    ]
    .iter()
    .any(|token| body.contains(token))
}
