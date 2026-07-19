//! `run --adapter utsushi-kirikiri-xp3 --fixture kaifuu-kag-synthetic-corpus`.
//!
//! The command reads the committed CC0 KAG corpus manifest, replays every
//! declared plaintext script, and writes the deterministic E0/E1 bridge-linked
//! trace. It does not open, decrypt, or inspect an XP3 archive.

use std::path::{Path, PathBuf};

use serde_json::Value;
use utsushi_kirikiri_xp3::{KagReplayInput, emit_kag_replay_e0_e1_trace};

const ADAPTER: &str = "utsushi-kirikiri-xp3";
const FIXTURE: &str = "kaifuu-kag-synthetic-corpus";
const MANIFEST_PATH: &str = "fixtures/public/kaifuu-kag-synthetic-corpus.manifest.json";

/// Run the fixed, manifest-backed KAG plaintext replay command. `tail` is argv
/// with the leading `run` slot removed.
pub fn run_kag_plaintext_replay_command(tail: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (adapter, fixture, output) = parse_args(tail)?;
    if adapter != ADAPTER {
        return Err(format!("unsupported adapter `{adapter}`; expected `{ADAPTER}`").into());
    }
    if fixture != FIXTURE {
        return Err(format!("unsupported fixture `{fixture}`; expected `{FIXTURE}`").into());
    }

    let scripts = load_corpus_scripts(&repo_root())?;
    let inputs: Vec<KagReplayInput<'_>> = scripts
        .iter()
        .map(|script| KagReplayInput {
            source_file: &script.source_file,
            bytes: &script.bytes,
        })
        .collect();
    let json = emit_kag_replay_e0_e1_trace(&inputs).to_deterministic_json()?;
    write_trace(&output, &json)
}

fn parse_args(tail: &[String]) -> Result<(String, String, PathBuf), Box<dyn std::error::Error>> {
    let mut adapter = None;
    let mut fixture = None;
    let mut output = None;
    let mut index = 0;
    while index < tail.len() {
        let flag = tail[index].as_str();
        let value = tail
            .get(index + 1)
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| format!("missing value for `{flag}`"))?;
        match flag {
            "--adapter" => set_once(&mut adapter, value, flag)?,
            "--fixture" => set_once(&mut fixture, value, flag)?,
            "--output" => set_once(&mut output, value, flag)?,
            _ => return Err(format!("unexpected argument `{flag}`").into()),
        }
        index += 2;
    }
    let adapter = adapter.ok_or("missing `--adapter`")?;
    let fixture = fixture.ok_or("missing `--fixture`")?;
    let output = output.ok_or("missing `--output`")?;
    Ok((adapter, fixture, PathBuf::from(output)))
}

fn set_once(
    slot: &mut Option<String>,
    value: &str,
    flag: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if slot.replace(value.to_string()).is_some() {
        return Err(format!("`{flag}` given more than once").into());
    }
    Ok(())
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct CorpusScript {
    source_file: String,
    bytes: Vec<u8>,
}

fn load_corpus_scripts(root: &Path) -> Result<Vec<CorpusScript>, Box<dyn std::error::Error>> {
    let manifest_path = root.join(MANIFEST_PATH);
    let manifest: Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    let files = manifest["files"]
        .as_array()
        .ok_or("corpus manifest has no `files` array")?;
    let mut scripts = Vec::with_capacity(files.len());
    for file in files {
        let relative_path = file["path"]
            .as_str()
            .ok_or("corpus manifest file has no `path`")?;
        let source_file = Path::new(relative_path)
            .file_name()
            .ok_or("corpus file path has no filename")?
            .to_string_lossy()
            .into_owned();
        scripts.push(CorpusScript {
            source_file,
            bytes: std::fs::read(root.join(relative_path))?,
        });
    }
    Ok(scripts)
}

fn write_trace(output: &Path, json: &str) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(output, format!("{json}\n"))?;
    Ok(())
}
