# Kaifuu Subproject

Kaifuu owns extraction, patching, verification, and `.kaifuu` delta packages.

The scaffold implements a fixture engine only. Real engines such as RPG Maker MV/MZ, KiriKiri, SiglusEngine, and Ren'Py come after the shared contracts and hello world are stable.

## Fixture Adapter CLI

The current CLI resolves game-backed commands through the adapter registry. The fixture adapter handles `fixtures/hello-game` today, and future engine adapters should plug into the same registry path instead of adding command-specific fixture logic.

Machine-readable adapter capability output is available with:

```sh
cargo run -p kaifuu-cli -- capabilities --output .tmp/kaifuu-capabilities.json
```

Fixture commands preserve the hello-world file contract:

```sh
cargo run -p kaifuu-cli -- detect fixtures/hello-game --output .tmp/kaifuu-detect.json
cargo run -p kaifuu-cli -- profile init fixtures/hello-game --output .tmp/kaifuu-profile.json
cargo run -p kaifuu-cli -- profile validate .tmp/kaifuu-profile.json --output .tmp/kaifuu-profile-validation.json
cargo run -p kaifuu-cli -- extract fixtures/hello-game --output .tmp/hello-world/bridge.json
cargo run -p kaifuu-cli -- patch fixtures/hello-game --patch .tmp/hello-world/patch-export.json --output .tmp/hello-world/patched-game
cargo run -p kaifuu-cli -- verify .tmp/hello-world/patched-game --output .tmp/hello-world/kaifuu-verify.json
```

`detect` emits a deterministic detection report for every registered adapter. It reports evidence records such as matched or missing manifest files and returns `unknown` instead of failing when no adapter matches. Detection output does not include LLM-style confidence.

`profile init` writes stable JSON profiles. Profiles include assets, capability reports, and explicit requirements for files, platform constraints, and secret keys. Secret requirements use placeholders only; actual secret values must stay out of profile files. The fixture engine marks decryption keys as `not_required`, so missing-key handling does not block unencrypted games.
