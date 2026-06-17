# Fixtures

This directory separates public, redistributable fixtures from local-only
private corpora.

- `hello-game/` is the existing synthetic public fixture used by the hello-world
  workflow.
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

Verify private corpus files stay untracked with:

```sh
git check-ignore -v fixtures/private-local/example-corpus/manifest.json
```
