//! Env-gated real-bytes proof for the Softpal structure producer.
//!
//! The private corpus root is read-only and never contributes bytes to this
//! repository. When unavailable, this test emits one clean skip line.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

const RESEARCH_ROOT_ENV: &str = "ITOTORI_SOFTPAL_RESEARCH_ROOT";

fn data_archives(root: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            data_archives(&path, out)?;
        } else if metadata.is_file()
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("data.pac"))
        {
            out.push(path);
        }
    }
    Ok(())
}

#[test]
fn exports_nontrivial_linear_structure_for_each_private_corpus() {
    let Some(root) = std::env::var_os(RESEARCH_ROOT_ENV).map(PathBuf::from) else {
        eprintln!("SKIP softpal structure real bytes: {RESEARCH_ROOT_ENV} is unset");
        return;
    };
    if !root.is_dir() {
        eprintln!("SKIP softpal structure real bytes: {RESEARCH_ROOT_ENV} is not a directory");
        return;
    }
    let mut archives = Vec::new();
    data_archives(&root, &mut archives).expect("walk private corpus root");
    archives.sort();
    assert!(
        archives.len() >= 2,
        "private corpus must contain at least two data archives; found {}",
        archives.len()
    );

    let output_root = TempDir::new().expect("temporary output root");
    for (index, archive) in archives.iter().enumerate() {
        let game_root = archive.parent().expect("data archive parent");
        let output = output_root.path().join(format!("structure-{index}.json"));
        let command = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
            .args(["structure", "--engine", "softpal", "--game-root"])
            .arg(game_root)
            .args(["--output"])
            .arg(&output)
            .output()
            .expect("run structure producer");
        assert!(
            command.status.success(),
            "structure producer failed for corpus {index}: {}",
            String::from_utf8_lossy(&command.stderr)
        );

        let structure: Value = serde_json::from_slice(
            &fs::read(&output).expect("structure producer writes an artifact"),
        )
        .expect("structure artifact is JSON");
        let scene = structure["scenes"]
            .as_array()
            .and_then(|scenes| scenes.first());
        let messages = scene
            .and_then(|value| value["messages"].as_array())
            .map_or(0, Vec::len);
        let choices = scene
            .and_then(|value| value["choices"].as_array())
            .map_or(0, Vec::len);
        assert_eq!(structure["engine"], "softpal");
        assert_eq!(structure["scenes"].as_array().map(Vec::len), Some(1));
        assert!(
            messages > 100,
            "corpus {index} must expose a nontrivial dialogue stream; got {messages} messages"
        );
        eprintln!(
            "softpal structure corpus {index}: scenes=1 messages={messages} choices={choices}"
        );
    }
}
