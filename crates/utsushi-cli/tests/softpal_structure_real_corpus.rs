//! Read-only regression proof for the shipped Softpal structure producer.
//!
//! No retail bytes are committed. This compile-time `real-bytes` proof requires
//! both staged corpora and fails loudly when either required input is absent.

use std::fs;
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

struct CorpusExpectation {
    identity: &'static str,
    game_subdir: &'static str,
    messages: usize,
    speakers: usize,
    choices: usize,
}

const CORPORA: [CorpusExpectation; 2] = [
    CorpusExpectation {
        identity: "softpal/1/plain",
        game_subdir: "v21465/game",
        messages: 30_165,
        speakers: 19_990,
        choices: 11,
    },
    CorpusExpectation {
        identity: "softpal/2/plain",
        game_subdir: "v60663/game",
        messages: 39_832,
        speakers: 28_665,
        choices: 16,
    },
];

#[test]
fn exports_complete_linear_structure_for_each_staged_corpus() {
    let output_root = TempDir::new().expect("temporary output root");
    for (index, corpus) in CORPORA.iter().enumerate() {
        let staged_root =
            corpus_registry::resolve_identity(corpus.identity).unwrap_or_else(|err| {
                panic!(
                    "real-bytes proof requires staged Softpal corpus {} ({}): {err}",
                    index + 1,
                    corpus.identity
                )
            });
        let game_root = staged_root.join(corpus.game_subdir);
        assert!(
            game_root.is_dir(),
            "real-bytes proof requires corpus {} game root at {}",
            index + 1,
            game_root.display()
        );
        let output = output_root
            .path()
            .join(format!("structure-{}.json", index + 1));
        let command = Command::new(env!("CARGO_BIN_EXE_utsushi-cli"))
            .args(["structure", "--engine", "softpal", "--game-root"])
            .arg(&game_root)
            .args(["--output"])
            .arg(&output)
            .output()
            .expect("run structure producer");
        assert!(
            command.status.success(),
            "structure producer failed for corpus {}: {}",
            index + 1,
            String::from_utf8_lossy(&command.stderr)
        );

        let structure: Value = serde_json::from_slice(
            &fs::read(&output).expect("structure producer writes an artifact"),
        )
        .expect("structure artifact is JSON");
        let scene = &structure["scenes"][0];
        let messages = scene["messages"].as_array().expect("messages array");
        let speakers = messages
            .iter()
            .filter(|message| message["speaker"].is_string())
            .count();
        let choices = scene["choices"].as_array().expect("choices array");

        assert_eq!(structure["engine"], "softpal");
        assert_eq!(structure["scenes"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            messages.len(),
            corpus.messages,
            "corpus {} messages",
            index + 1
        );
        assert_eq!(speakers, corpus.speakers, "corpus {} speakers", index + 1);
        assert_eq!(
            choices.len(),
            corpus.choices,
            "corpus {} choices",
            index + 1
        );
        eprintln!(
            "softpal structure corpus {}: messages={} speakers={} choices={}",
            index + 1,
            messages.len(),
            speakers,
            choices.len(),
        );
    }
}
