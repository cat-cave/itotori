use super::*;
use kaifuu_core::write_json;
use std::time::{SystemTime, UNIX_EPOCH};

const ROOT_PATCH_RESULT_ARTIFACT: &str = "patch-result.json";

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-delta-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let file_path = root.join(path);
    fs::create_dir_all(file_path.parent().unwrap()).unwrap();
    fs::write(file_path, bytes).unwrap();
}

fn write_sample_dirs(root: &Path) -> (PathBuf, PathBuf) {
    let original = root.join("original");
    let patched = root.join("patched");
    fs::create_dir_all(&original).unwrap();
    fs::create_dir_all(&patched).unwrap();
    write_file(&original, "source.json", br#"{"units":[]}"#);
    write_file(&original, "data/unchanged.txt", b"same\n");
    write_file(&original, "data/delete.txt", b"remove\n");
    write_file(&original, "bin/raw.dat", &[0, 159, 146, 150]);

    write_file(
        &patched,
        "source.json",
        br#"{"units":[{"targetText":"Hello"}]}"#,
    );
    write_file(&patched, "data/unchanged.txt", b"same\n");
    write_file(&patched, "data/add.txt", b"add\n");
    write_file(&patched, "bin/raw.dat", &[0, 159, 146, 151]);
    (original, patched)
}

const UNSAFE_PACKAGE_PATH_FIXTURES: &[(&str, &str)] = &[
    ("empty", ""),
    ("absolute slash", "/source.json"),
    ("absolute backslash", "\\source.json"),
    ("ordinary backslash", "data\\source.json"),
    ("drive absolute slash", "C:/source.json"),
    ("drive absolute backslash", "C:\\source.json"),
    ("drive relative upper", "C:source.json"),
    ("drive relative lower", "c:source.json"),
    ("drive prefix component slash", "data/C:source.json"),
    ("drive prefix component backslash", "data\\C:source.json"),
    ("dot only", "."),
    ("leading dot slash", "./source.json"),
    ("leading dot backslash", ".\\source.json"),
    ("dot component slash", "data/./source.json"),
    ("dot component backslash", "data\\.\\source.json"),
    ("trailing dot component", "data/."),
    ("parent leading slash", "../source.json"),
    ("parent leading backslash", "..\\source.json"),
    ("parent component slash", "data/../source.json"),
    ("parent component backslash", "data\\..\\source.json"),
    ("empty component slash", "data//source.json"),
    ("empty component backslash", "data\\\\source.json"),
    ("nul byte", "source.json\0suffix"),
];

include!("tests/create_apply.rs");

include!("tests/preflight.rs");

include!("tests/replacement.rs");
