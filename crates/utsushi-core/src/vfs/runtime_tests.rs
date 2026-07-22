use super::*;
use tempfile::TempDir;

fn make_temp_package(case_rule: CaseRule) -> (TempDir, PlaintextDirPackage) {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("intro.txt"), "hello world\n").unwrap();
    fs::write(temp.path().join("nested").join("glyph.txt"), "glyph").unwrap();
    let package = PlaintextDirPackage::new(
        "hello",
        temp.path(),
        case_rule,
        PackageSource::PublicName("public-fixture:plaintext".to_string()),
    );
    (temp, package)
}

#[test]
fn insensitive_ascii_resolve_matches_uppercase_request() {
    let (_temp, package) = make_temp_package(CaseRule::InsensitiveAscii);
    let id = package.resolve("INTRO.TXT").unwrap();
    // Resolution recovers the stored case so the id is canonical.
    assert_eq!(id.path(), "intro.txt");
}

#[test]
fn sensitive_resolve_rejects_case_mismatch() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let id = package.resolve("INTRO.TXT").unwrap();
    // Sensitive does not change the case; the file is missing under
    // that stored form.
    assert!(matches!(package.exists(&id), Ok(false)));
    // The lowercase form exists.
    let canonical = package.resolve("intro.txt").unwrap();
    assert_eq!(canonical.path(), "intro.txt");
    assert!(package.exists(&canonical).unwrap());
}

#[test]
fn list_returns_children_in_byte_lexicographic_order() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["c.txt", "a.txt", "b.txt"] {
        fs::write(temp.path().join(name), name).unwrap();
    }
    let package = PlaintextDirPackage::new(
        "lex",
        temp.path(),
        CaseRule::Sensitive,
        PackageSource::PublicName("public-fixture:lex".to_string()),
    );
    let prefix = AssetId::from_parts("lex", "").unwrap();
    let children = package.list(&prefix).unwrap();
    let names: Vec<&str> = children
        .iter()
        .map(super::super::id::AssetId::path)
        .collect();
    assert_eq!(names, vec!["a.txt", "b.txt", "c.txt"]);
}

#[test]
fn list_on_non_directory_returns_asset_not_directory() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let id = AssetId::from_parts("hello", "intro.txt").unwrap();
    let err = package.list(&id).unwrap_err();
    assert!(matches!(err, VfsError::AssetNotDirectory { .. }));
}

#[test]
fn open_on_directory_returns_asset_not_file() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let id = AssetId::from_parts("hello", "nested/").unwrap();
    let err = package.open(&id).unwrap_err();
    assert!(matches!(err, VfsError::AssetNotFile { .. }));
}

#[test]
fn open_missing_returns_asset_missing() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let id = AssetId::from_parts("hello", "absent.txt").unwrap();
    let err = package.open(&id).unwrap_err();
    match err {
        VfsError::AssetMissing { id: missing } => {
            assert_eq!(missing.path(), "absent.txt");
        }
        other => panic!("expected AssetMissing, got {other:?}"),
    }
}

#[test]
fn case_folded_index_is_built_once_and_cached() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let first = std::ptr::from_ref::<CaseFoldedIndex>(package.case_folded_index().unwrap());
    let second = std::ptr::from_ref::<CaseFoldedIndex>(package.case_folded_index().unwrap());
    assert_eq!(first, second, "OnceLock must hand back the same reference");
}

#[test]
fn case_folded_index_contains_every_file_under_root() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let index = package.case_folded_index().unwrap();
    assert_eq!(index.len(), 2);
    assert_eq!(
        index.lookup("intro.txt").unwrap().stored_path(),
        "intro.txt"
    );
    assert_eq!(
        index.lookup("nested/glyph.txt").unwrap().stored_path(),
        "nested/glyph.txt"
    );
}

#[test]
fn mounted_vfs_routes_through_internal_composite() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let mut vfs = MountedVfs::new(
        "hello",
        PackageSource::PublicName("public-fixture:hello".to_string()),
    );
    vfs.mount_plaintext_dir(package);
    let id = vfs.resolve("intro.txt").unwrap();
    let bytes = vfs.open(&id).unwrap();
    assert_eq!(bytes.as_slice(), b"hello world\n");
}

#[test]
fn mounted_vfs_unknown_logical_returns_asset_missing() {
    let (_temp, package) = make_temp_package(CaseRule::Sensitive);
    let mut vfs = MountedVfs::new(
        "hello",
        PackageSource::PublicName("public-fixture:hello".to_string()),
    );
    vfs.mount_plaintext_dir(package);
    let err = vfs.resolve("definitely-absent.bin").unwrap_err();
    assert!(matches!(err, VfsError::AssetMissing { .. }));
}

#[test]
fn vfs_error_for_real_host_path_input_does_not_leak_path_into_display() {
    // Build a package rooted under a real tempdir so the host path
    // contains /tmp/... — a forbidden substring.
    let (temp, package) = make_temp_package(CaseRule::Sensitive);
    let host_root_display = temp.path().display().to_string();
    let id = AssetId::from_parts("hello", "definitely-absent.bin").unwrap();
    let err = package.open(&id).unwrap_err();
    let rendered = err.to_string();
    assert!(
        !rendered.contains(&host_root_display),
        "rendered display leaked host path: {rendered}"
    );
    // Sanity: tempdir paths under Linux start with `/tmp/`.
    if host_root_display.starts_with("/tmp/") {
        assert!(!rendered.contains("/tmp/"));
    }
}

#[test]
fn package_io_failure_summary_does_not_include_errno_text() {
    // Mount a package whose root does not exist; stat will report a
    // missing path. The `Display` for the resulting AssetMissing must
    // not include the system errno text.
    let nonexistent = std::env::temp_dir().join("utsushi-vfs-no-such-dir-xyz");
    let _ = fs::remove_dir_all(&nonexistent);
    let package = PlaintextDirPackage::new(
        "ghost",
        nonexistent,
        CaseRule::Sensitive,
        PackageSource::PublicName("public-fixture:ghost".to_string()),
    );
    let id = AssetId::from_parts("ghost", "anything.txt").unwrap();
    let err = package.open(&id).unwrap_err();
    let rendered = err.to_string();
    assert!(!rendered.contains("os error"));
    assert!(!rendered.contains("No such file"));
}
