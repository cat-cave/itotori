# Kaifuu Synthetic Encrypted-XP3 Contract Scaffolding Fixture

CONTRACT SCAFFOLDING ONLY: this harness exercises the encrypted-XP3 contract surface against a fully synthetic, public-redistributable fixture. It does NOT decrypt, extract, or patch any retail KiriKiri/XP3 game, and it is NOT a claim of retail encrypted-XP3 readiness.

This fixture is synthetic, deterministic, and public-redistributable. Every
byte is authored in-repository by
`fixtures/generate-kaifuu-encrypted-xp3-contract-scaffold.mjs` and embeds **no** retail game
material — no extracted scripts, screenshots, audio, fonts, video, helper
dumps, private paths, or private keys.

It feeds the KAIFUU-171 end-to-end contract harness in
`crates/kaifuu-delta/src/contract_scaffold.rs`, which exercises the full
encrypted-XP3 contract surface:

1. **detect** — `encrypted-envelope.xp3` routes to the encrypted variant.
2. **key resolution** — the fixture-only key in
   `keys/public-fixture-key-manifest.json` resolves the crypt profile's
   key requirement through the local key resolver.
3. **extract** — `decrypted-inner.xp3` (a real plain XP3) unpacks to a
   directory.
4. **patch** — the `scenario/intro.ks` entry is replaced with a synthetic
   translated payload and repacked.
5. **verify** — the original archive re-encodes byte-identically and the
   patched archive re-reads cleanly.
6. **delta apply** — a delta between the original and patched extract
   directories applies back to a byte-identical patched archive.

The public fixture key is a fixture-only label that "unlocks" only these
generated public bytes. It is not retail key material and proves nothing about
any retail encrypted XP3 game.

Regenerate with:

```sh
node fixtures/generate-kaifuu-encrypted-xp3-contract-scaffold.mjs
```
