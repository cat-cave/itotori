# KAIFUU-039 — RPG Maker MV/MZ encrypted-media readiness fixtures

These fixtures back the `kaifuu rpgmaker encrypted-media-proof` command
(KAIFUU-039). They are intentionally **synthetic**:

- Every "encrypted" media file carries the public RPGMV 16-byte
  header magic (`52 50 47 4D 56 00 00 00 00 03 01 00 00 00 00 00`)
  followed by short non-secret payload tags.
- Every happy-path `data/System.json` uses the public test asset-key
  `00112233445566778899aabbccddeeff` (32 hex chars) and fixtures store
  only its `expectedSystemJsonKeyHash`. No private game key, no extracted
  key material, no decrypted bytes are vendored.

## Posture (load-bearing)

KAIFUU-039 is research-only. RPG Maker MV/MZ is a commercial product
(KADOKAWA / Gotcha Gotcha Games). The proof:

- **never decrypts** an encrypted asset,
- **never persists** decrypted media bytes,
- **never extracts** plaintext from encrypted media,
- **never claims** dialogue extraction or script-patch capability
  on the basis of media-key detection,
- **never claims** `patch_back` or `extract` for an encrypted media
  asset (every encrypted suffix routes to
  `patchCapabilityLevel=unsupported`).

The readiness report is for engine-research provenance only.

## Matrix

| Fixture                                             | Surface                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `encrypted-media.json`                              | Happy-path: MV + MZ encrypted images, audio, encrypted video, plus plaintext png/ogg/webm         |
| `encrypted-media-missing-key.json`                  | Encrypted asset present, `System.json` has no `encryptionKey`                                     |
| `encrypted-media-wrong-key.json`                    | Encrypted asset present, `System.json` `encryptionKey` is 32-hex but mismatches expected key hash |
| `negative/encrypted-media-leaked-game-dir.json`     | `gameDir` is absolute / contains private path — must be rejected                                  |
| `negative/encrypted-media-malformed-header.json`    | `.rpgmvp` file missing the RPGMV header magic                                                     |
| `negative/encrypted-media-unknown-key-profile.json` | `keyProfile.profileId` is not in the recognised vocabulary                                        |

The negative fixtures expect the proof to fail (status `failed`,
blocking diagnostics fired before any decryption claim).

## Game-tree layout

- `game/` — public-key happy-path tree (used by the happy-path,
  unknown-key-profile, and matrix fixtures).
- `missing-key-game/` — `System.json` without `encryptionKey`.
- `wrong-key-game/` — `System.json` with a wrong-but-well-formed key.
- `negative/game/` — malformed-header tree.

Encrypted-suffix coverage:

- MV: `.rpgmvp` (image), `.rpgmvm` (audio/m4a), `.rpgmvo` (audio/ogg),
  `.rpgmvu` (video).
- MZ: `.png_` (image), `.m4a_` (audio), `.ogg_` (audio).
- Plaintext evidence: `.png`, `.ogg`, `.webm`.

## Real-bytes corpus (optional)

When `/scratch/itotori-research/rpg-maker-mv-mz/extracted/<game>/www/`
is mounted, the CLI test
`encrypted_media_proof_command_real_bytes_rpgmaker_corpus_when_available`
walks the corpus and asserts that:

- Encrypted assets route to `readiness=ready` _only_ when their
  `data/System.json` carries a well-formed `encryptionKey`.
- `decryptedBytesPersisted` is `false` on every report.
- `scriptCapabilityClaimed` is `false` on every report.
- No `patchCapabilityLevel` value is ever `patch_back` or `extract`.
- The real-bytes absolute path never leaks into the report.

Public CI without the scratch corpus is satisfied by the synthetic
fixtures.
