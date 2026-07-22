use super::*;

#[test]
fn sha256_matches_known_digest() {
    assert_eq!(
        sha256_hex(b"abc"),
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

fn add_utf8_changed_entry(package: &mut Value, path: &str, bytes: &[u8]) {
    let text = std::str::from_utf8(bytes).unwrap();
    package["changedEntries"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "path": path,
            "operation": "add",
            "targetHash": sha256_hex(bytes),
            "targetSizeBytes": bytes.len() as u64,
            "contentEncoding": "utf8",
            "content": text,
        }));
}

fn add_target_file_record(package: &mut Value, path: &str, bytes: &[u8]) {
    package["target"]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "path": path,
            "hash": sha256_hex(bytes),
            "sizeBytes": bytes.len() as u64,
        }));
}

fn refresh_manifest(package: &mut Value, manifest_key: &str) {
    let mut files = BTreeMap::new();
    for record in package[manifest_key]["files"].as_array().unwrap() {
        let path = record["path"].as_str().unwrap().to_string();
        files.insert(
            path.clone(),
            FileSnapshot {
                path,
                hash: record["hash"].as_str().unwrap().to_string(),
                size_bytes: record["sizeBytes"].as_u64().unwrap(),
            },
        );
    }
    let byte_count = files.values().map(|file| file.size_bytes).sum::<u64>();
    package[manifest_key]["fileCount"] = json!(files.len() as u64);
    package[manifest_key]["byteCount"] = json!(byte_count);
    package[manifest_key]["rootHash"] = json!(root_hash(files.values()));
}

fn remove_changed_entry(package: &mut Value, path: &str) {
    let entries = package["changedEntries"].as_array_mut().unwrap();
    let index = entries
        .iter()
        .position(|entry| entry["path"] == path)
        .unwrap();
    entries.remove(index);
}

fn assert_no_staging_dirs(root: &Path, output_name: &str) {
    let prefix = format!(".{output_name}.tmp-");
    let staging_count = fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .count();
    assert_eq!(staging_count, 0);
}

#[test]
fn replacement_delta_embeds_only_replaced_bytes_and_inherits_siblings() {
    let root = temp_dir("replacement-only");
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    write_file(&source, "data/target.bin", b"before");
    write_file(&source, "data/large-sibling.bin", &vec![7; 32 * 1024]);
    write_file(&source, "config/settings.bin", b"keep");
    let delta = create_replacement_delta(
        &source,
        &[Replacement {
            path: "data/target.bin".to_string(),
            bytes: b"after".to_vec(),
        }],
        SourceProvenance::complete(),
    )
    .unwrap();
    assert_eq!(delta["changedEntries"].as_array().unwrap().len(), 1);
    assert_eq!(delta["changedEntries"][0]["operation"], "replace");
    assert!(
        delta["changedEntries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["operation"] != "delete")
    );
    let output = root.join("output");
    let delta_path = root.join("patch.kaifuu");
    write_json(&delta_path, &delta).unwrap();
    apply_delta(&source, &delta_path, &output).unwrap();
    assert_eq!(fs::read(output.join("data/target.bin")).unwrap(), b"after");
    assert_eq!(
        fs::read(output.join("data/large-sibling.bin")).unwrap(),
        vec![7; 32 * 1024]
    );
    assert_eq!(
        fs::read(output.join("config/settings.bin")).unwrap(),
        b"keep"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn replacement_delta_rejects_unknown_duplicate_and_unsafe_paths() {
    let root = temp_dir("replacement-reject");
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    write_file(&source, "present.bin", b"present");
    for replacements in [
        vec![Replacement {
            path: "missing.bin".to_string(),
            bytes: vec![1],
        }],
        vec![
            Replacement {
                path: "present.bin".to_string(),
                bytes: vec![1],
            },
            Replacement {
                path: "present.bin".to_string(),
                bytes: vec![2],
            },
        ],
        vec![Replacement {
            path: "../escape.bin".to_string(),
            bytes: vec![1],
        }],
    ] {
        assert!(
            create_replacement_delta(&source, &replacements, SourceProvenance::complete()).is_err()
        );
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn replacement_delta_apply_refuses_source_provenance_drift() {
    let root = temp_dir("replacement-drift");
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    write_file(&source, "present.bin", b"before");
    let delta = create_replacement_delta(
        &source,
        &[Replacement {
            path: "present.bin".to_string(),
            bytes: b"after".to_vec(),
        }],
        SourceProvenance::complete(),
    )
    .unwrap();
    write_file(&source, "present.bin", b"drifted");
    let delta_path = root.join("patch.kaifuu");
    write_json(&delta_path, &delta).unwrap();
    assert!(apply_delta(&source, &delta_path, &root.join("output")).is_err());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn replacement_delta_rejects_symlinked_source_tree() {
    use std::os::unix::fs::symlink;

    let root = temp_dir("replacement-symlink");
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    write_file(&source, "regular.bin", b"regular");
    symlink(source.join("regular.bin"), source.join("linked.bin")).unwrap();
    assert!(
        create_replacement_delta(
            &source,
            &[Replacement {
                path: "regular.bin".to_string(),
                bytes: b"after".to_vec()
            }],
            SourceProvenance::complete(),
        )
        .is_err()
    );
    let _ = fs::remove_dir_all(root);
}
