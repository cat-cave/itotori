//! End-to-end coverage for the manifest-backed KAG plaintext replay command.

use std::path::Path;
use std::process::Command;

#[test]
fn run_command_emits_the_committed_kag_replay_trace() {
    let output_dir = tempfile::tempdir().expect("temporary output directory");
    let output = output_dir.path().join("trace.json");
    let result = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
        .args([
            "run",
            "--adapter",
            "utsushi-kirikiri-xp3",
            "--fixture",
            "kaifuu-kag-synthetic-corpus",
            "--output",
        ])
        .arg(&output)
        .output()
        .expect("run utsushi-cli");
    assert!(
        result.status.success(),
        "run command failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let expected_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../utsushi-kirikiri-xp3/tests/fixtures/kag-corpus-e0-e1-trace.json");
    assert_eq!(
        std::fs::read_to_string(&output).expect("emitted trace"),
        std::fs::read_to_string(&expected_path).expect("committed trace snapshot"),
    );
}
