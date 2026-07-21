//! Compatibility-policy coverage for the legacy `kaifuu profile <game-dir>`
//! spelling. The form remains supported and shares the same validate/redact/
//! write gate as `profile init`, but must warn operators toward the explicit
//! subcommand.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const LEGACY_PROFILE_COMPAT_WARNING: &str = "warning: `kaifuu profile <game-dir>` is a compatibility spelling; prefer `kaifuu profile init <game-dir>`";

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
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 6,
          "end": 14
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
fn legacy_profile_command_emits_compatibility_warning() {
    let root = temp_dir("legacy-profile-compat-warning");
    let game_dir = temp_game(&root);
    let output = root.join("profile.json");

    let proc = Command::new(kaifuu_cli_binary())
        .args([
            "profile",
            game_dir.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ])
        .output()
        .expect("spawn kaifuu-cli for legacy profile warning");

    assert!(
        proc.status.success(),
        "legacy profile command should succeed; stderr={}",
        String::from_utf8_lossy(&proc.stderr)
    );
    let stderr = String::from_utf8_lossy(&proc.stderr);
    assert!(
        stderr.contains(LEGACY_PROFILE_COMPAT_WARNING),
        "legacy profile form must emit its compatibility warning; stderr={stderr}"
    );
    assert!(
        output.exists(),
        "legacy profile form must still write a profile after warning"
    );

    let _ = fs::remove_dir_all(&root);
}
