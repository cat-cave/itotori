use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("kaifuu-cli-{name}-{}-{nonce}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn temp_game(root: &std::path::Path) -> PathBuf {
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "profile-command-fixture",
  "title": "Profile Command Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "profile.command.line",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "Hello, {player}.",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 7,
          "end": 15
        }
      ]
    }
  ]
}
"#,
    )
    .unwrap();
    game_dir
}

#[test]
fn profile_init_writes_a_profile_and_rejects_the_removed_positional_spelling() {
    let root = temp_dir("profile-commands");
    let game_dir = temp_game(&root);
    let initialized_output = root.join("initialized-profile.json");
    let legacy_output = root.join("legacy-profile.json");

    let initialized = Command::new(kaifuu_cli_binary())
        .args([
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            initialized_output.to_str().unwrap(),
        ])
        .output()
        .expect("spawn kaifuu-cli profile init");
    assert!(
        initialized.status.success(),
        "profile init should succeed; stderr={}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    assert!(
        initialized_output.exists(),
        "profile init must write its requested profile output"
    );

    let legacy = Command::new(kaifuu_cli_binary())
        .args([
            "profile",
            game_dir.to_str().unwrap(),
            "--output",
            legacy_output.to_str().unwrap(),
        ])
        .output()
        .expect("spawn removed positional profile spelling");
    assert!(
        !legacy.status.success(),
        "the removed positional profile spelling must fail; stderr={}",
        String::from_utf8_lossy(&legacy.stderr)
    );
    assert!(
        !legacy_output.exists(),
        "the removed positional profile spelling must not write a profile"
    );

    let _ = fs::remove_dir_all(root);
}
