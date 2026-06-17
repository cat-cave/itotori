# Fixtures

This directory separates public, redistributable fixtures from local-only
private corpora.

- `hello-game/` is the existing synthetic public fixture used by the hello-world
  workflow.
- `seeded-localization-defects/` is the synthetic public localization QA corpus
  used for seeded defect recall, expected findings, false-positive calibration,
  and taxonomy coverage review.
- `public/` contains fixture manifests, the public manifest schema, and the
  manifest validator.
- `private-local/` is ignored by git and reserved for purchased games, licensed
  corpora, and other private benchmark inputs.

See `docs/fixtures-and-corpora.md` for the policy, reporting rules, and private
corpus conventions.

Validate public manifests with:

```sh
pnpm exec node fixtures/validate-public-manifests.mjs
```

Regenerate the public Kaifuu round-trip report with:

```sh
cargo run -p kaifuu-cli -- golden fixtures/hello-game --adapter kaifuu.fixture --translated-patch fixtures/hello-game/expected/patch-export-v0.2.fr-FR.json --translated-source-bridge fixtures/hello-game/expected/bridge-v0.2.json --work-dir .tmp/kaifuu-golden-fixture --output fixtures/hello-game/expected/round-trip-golden-report-v0.1.json
```

Verify private corpus files stay untracked with:

```sh
git check-ignore -v fixtures/private-local/example-corpus/manifest.json
```
