# Kaifuu Key Discovery And Encrypted Corpus Policy

Kaifuu must be useful on owned and licensed Japanese games, so encrypted-input
readiness is an MVP requirement. The MVP does not claim universal decryption or
production support for every protected commercial variant. It does require a
clean boundary where local key discovery, secret storage, archive detection, and
pure extraction/patching can evolve independently.

## Architecture Boundary

Kaifuu treats key discovery as a local helper workflow and treats
extraction/patching as pure adapter work.

- **Detection** fingerprints archives, asset encryption, engine family,
  platform requirements, and probable key requirements without modifying files.
- **Discovery helpers** may use static analysis, known-key imports, Wine,
  Windows-only launch helpers, or remote Windows helper hosts. Helpers return
  structured results, never raw unredacted logs.
- **Key profiles** describe what secret material exists and how adapters can ask
  for it. Profiles reference secrets by id, not by raw key bytes.
- **Pure adapters** consume resolved keys, archive parameters, and compression
  options. They do not own Windows hooks, executable bypasses, community
  databases, or helper orchestration.
- **Patch and verify** must work on Linux and macOS whenever required keys and
  formats are already supplied.

This lets Kaifuu support commercial local workflows without committing keys,
retail files, helper dumps, or platform-specific discovery internals.

## Key Profile Shape

The executable v0.1 profile contract is engine-agnostic and strict enough for
adapters to fail semantically. Key-bearing profiles extend the normal Kaifuu
game profile with these top-level fields:

```json
{
  "schemaVersion": "0.1.0",
  "profileId": "uuid7",
  "engine": {
    "adapterId": "kaifuu.siglus",
    "engineFamily": "siglus",
    "engineVersion": null,
    "detectedVariant": "scene-pck-secondary-key"
  },
  "sourceFingerprint": {
    "gameRootHash": "sha256:...",
    "engineEvidence": ["Scene.pck", "Gameexe.dat"]
  },
  "keyRequirements": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:siglus/example/secondary-key",
      "kind": "fixedBytes",
      "bytes": 16,
      "validation": {
        "method": "decryptHeaderProof",
        "proofHash": "sha256:..."
      }
    }
  ],
  "archiveParameters": [],
  "helperEvidence": {
    "helperKind": "staticParser",
    "toolVersion": "kaifuu-key-helper/0.1.0",
    "redactedLogHash": "sha256:..."
  }
}
```

Raw key material stays in local secret storage, not in committed profiles,
bridge bundles, reports, logs, or CI artifacts. Acceptable local stores include
an ignored local keyring file, OS keychain integration, a configured secret
manager, or an interactive prompt. Public fixtures may use public test keys only
when the generated archive and key are both safe to redistribute.

`secretRef` is the only persisted pointer to private key material. The current
contract accepts local-only references using `local-secret:`, `os-keychain:`,
`secret-manager:`, or `prompt:` schemes. Secret refs must be stable ids, not
absolute paths, raw hex/base64/base64url keys, helper dump offsets, account ids,
or machine-specific filenames.

Adapters declare required key material through capability output
`keyRequirements`, including the requirement id, material kind, byte length when
fixed, required archive parameters, validation proof method, and stable
semantic errors they may return. Key-bearing profiles must match each required
secret `requirements[].key` with a `keyRequirements[].requirementId` entry that
has a valid `secretRef`. The plaintext fixture adapter intentionally emits no
key requirement declarations.

## Helper Classes

Kaifuu should support multiple helper classes behind one structured result
contract:

- **Static parser**: reads project files or executables directly and extracts or
  validates key candidates when the format is known.
- **Known-key database import**: imports local/community key entries into local
  secret storage, recording source metadata without publishing the key.
- **Wine/local Windows helper**: runs engine-specific helper code beside the
  owned game to produce a redacted key-profile result.
- **Remote Windows helper**: lets a Linux/macOS development agent request a
  local network Windows host to run a helper and return structured redacted
  evidence.
- **Manual key entry**: lets the user provide a known key and validates it
  against local assets before pure adapters consume it.

All helper outputs must be schema-validated, redacted before persistence, and
safe to include in aggregate readiness reports.

## Engine Notes

- **KiriKiri/XP3**: tools such as GARbro know many XP3 variants and may prompt
  for a crypt scheme or game-specific option for encrypted archives. KrkrExtract
  shows the practical Windows-oriented runtime/patch workflow, including
  universal dump and patch paths, while warning that protected executables and
  bypass conflicts are hard. MVP needs XP3/archive detection, local helper
  boundaries, and a KiriKiri encrypted research slice; production encrypted-XP3
  patch support is a later adapter claim.
- **SiglusEngine**: Siglus tools center on `Scene.pck`, `Gameexe.dat`, and a
  game-specific secondary key. Practical paths include static extraction,
  dynamic extraction, and known-key databases. MVP needs the key-profile
  boundary, static/dynamic helper result shape, and redaction tests before any
  production Siglus adapter claim.
- **RPG Maker MV/MZ**: built-in asset encryption commonly exposes key recovery
  through `System.json` or encrypted image files. Some image restoration can be
  possible without a key, while audio needs one. MVP adapter support can remain
  JSON-text-first, but encrypted asset detection and key-profile handling belong
  in MVP because text-bearing images and media metadata are localization
  surfaces.
- **Wolf RPG Editor**: Wolf tools show `.wolf` archive decryption, broad
  extension handling, automatic key detection, and Pro protection-key
  detection. MVP needs archive/protection detection and a helper research slice;
  full Wolf text patching can still wait for binary patching support.
- **BGI/Ethornell**: public tools emphasize script decoding/encoding,
  string-table or bytecode handling, and original-file-informed encoding. The
  immediate MVP need is profile/container triage and encrypted/compressed
  boundary detection rather than assuming a universal key workflow.

## Logging And Redaction

No command, helper, adapter, report, panic, or dashboard state may print raw
keys, local absolute paths, retail filenames that disclose story content,
storefront ids, account ids, helper memory dumps, decrypted scripts, or
unredacted exception payloads.

`kaifuu-core` exposes profile validation and redaction helpers that preserve
valid `secretRef` values while rejecting or redacting raw key fields such as
`rawKey`, `keyMaterial`, `keyBytes`, `keyHex`, helper dumps/logs, local absolute
paths, raw key-looking archive parameter values, and decrypted private text.
`kaifuu profile validate` reports those as `kaifuu.secret_redacted` without
echoing the raw value.

Required stable semantic errors include:

- `kaifuu.missing_capability.key_profile`
- `kaifuu.missing_key_material`
- `kaifuu.helper_unavailable`
- `kaifuu.key_validation_failed`
- `kaifuu.protected_executable_unsupported`
- `kaifuu.secret_redacted`
- `kaifuu.unsupported_variant.encrypted`

Key validation may record proof hashes, decrypted header class, byte counts,
tool version, and aggregate readiness status. It must not record decrypted
private strings or the raw key.

## CI And Private-Local Split

Public CI stays public-fixture-only. It may include synthetic encrypted archives
with public test keys, negative detector fixtures, and redaction tests. It must
not depend on private corpora, retail keys, commercial archives, helper dumps,
Wine, Windows, or live community key services.

Private-local encrypted validation is still a first-class MVP evidence lane.
Local workflows under `fixtures/private-local/` should produce aggregate
readiness reports that can be cited publicly by corpus label, manifest hash,
hash-list hash, engine family counts, key-profile ids, redacted proof hashes,
tool versions, and command lines.

## Reference Anchors

- GARbro: <https://github.com/morkt/GARbro>
- GARbro KiriKiri XP3 implementation: <https://github.com/morkt/GARbro/blob/master/ArcFormats/KiriKiri/ArcXP3.cs>
- KrkrExtract: <https://github.com/xmoezzz/KrkrExtract>
- SiglusExtract: <https://github.com/xmoezzz/SiglusExtract>
- siglus_rs: <https://github.com/xmoezzz/siglus_rs>
- siglus_static_key_tool: <https://github.com/xmoezzz/siglus_static_key_tool>
- RPG Maker MV/MZ Decrypter: <https://github.com/Petschko/RPG-Maker-MV-Decrypter>
- WolfDec: <https://github.com/Sinflower/WolfDec>
- UberWolf: <https://github.com/Sinflower/UberWolf>
- VNTranslationTools: <https://github.com/arcusmaximus/VNTranslationTools>
- BGIKit: <https://github.com/xupefei/BGIKit>
