# Kaifuu Key Discovery And Encrypted Corpus Policy

Kaifuu must be useful on owned and licensed Japanese games, so encrypted-input
readiness is an alpha requirement. The alpha readiness milestone does not claim
universal decryption or production support for every protected commercial
variant. It does require a clean boundary where local key discovery, secret
storage, archive detection, and pure extraction/patching can evolve
independently.

Readiness is the staging area for production support, not an escape hatch. The
project goal is to legitimately decrypt, extract text, produce trivial and real
patches, and validate owned games for every engine variant Kaifuu claims. Before
a claim exists, unsupported or unknown variants return semantic capability
errors. After a claim exists for an exact engine family, variant, container,
crypto, codec, and patch-back profile, a failure in that profile is a bug report
or compatibility regression unless new evidence proves the input is outside the
declared boundary.

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

## Alpha Implementation Gates

Encrypted-input readiness is not continuous expansion polish. The alpha
readiness milestone may still avoid broad production support claims for
commercial variants, but it must ship the core mechanisms that make owned
encrypted games actionable, plus one declared encrypted-profile vertical that
proves detect, key/profile resolution, extraction, trivial patching, verify, and
delta apply on public-safe fixture data:

1. **Key-profile boundary**: complete in `KAIFUU-014`. Profiles name key
   requirements and stable `secretRef` pointers without raw key material.
2. **Archive/encryption detection**: complete in `KAIFUU-034`. Detection
   classifies encrypted, packed, protected, helper-required, missing-key, and
   unknown-variant signals before adapters claim extraction support.
3. **Redaction/error enforcement**: required in `KAIFUU-035`. Helper, profile,
   CLI, report, layered access preflight, and adapter failures must be safe to
   persist and triage.
4. **Local key resolver**: required in `KAIFUU-050`. `local-secret:`,
   `os-keychain:`, `secret-manager:`, and `prompt:` refs need a shared resolver
   and local-only secret store abstraction before helpers or private triage can
   be trusted.
5. **Synthetic encrypted fixtures**: required in `KAIFUU-051`. Public CI needs
   generated encrypted/key-required cases with public fixture keys so redaction,
   validation, helper-unavailable, and missing-key behavior is tested without
   private games.
6. **Private-local corpus triage**: required in `KAIFUU-036`. Owned encrypted
   corpora get first-class local readiness reports while staying absent from
   public CI.
7. **Platform-assisted helper harness**: required in `KAIFUU-037`. Static,
   known-key import, Wine/local Windows, and manual-entry helpers use one
   structured result contract and never live inside pure adapters. Remote
   Windows helper hosts are optional continuous expansion; they must fit the
   same contract, but they are not an alpha readiness blocker.
8. **Helper execution and allowlist policy**: required in `KAIFUU-064` and
   `KAIFUU-066`. Wine/Windows helper execution must be bounded, redacted,
   versioned, hash-pinned, and unable to run arbitrary commands.
9. **Private-local key-hunting run workflow**: required in `KAIFUU-067`. Owned
   corpora can be scanned, attempted, validated, skipped, or failed through a
   redacted local-only workflow while public CI uses stub fixtures.
10. **Engine-specific encrypted slices**: alpha readiness requires
    `KAIFUU-015`, `KAIFUU-038` through `KAIFUU-041`, the encrypted/key-discovery
    slices `KAIFUU-068`, `KAIFUU-070`, and `KAIFUU-072`, plus Wolf readiness
    `KAIFUU-040`. These slices implement exact adapter/helper boundaries for
    Siglus, KiriKiri/XP3, RPG Maker MV/MZ encrypted assets, Wolf RPG Editor,
    and BGI/Ethornell triage. `KAIFUU-073` full Wolf encrypted archive patching
    is continuous/future work, not required before first alpha localization
    readiness.
11. **Encrypted readiness gate**: required in `KAIFUU-042`. Alpha readiness cannot
    pass unless the public fixture lane and private-local lane are both
    accounted for with safe evidence and no universal-decryption overclaim.
12. **First encrypted-profile vertical**: required in `ALPHA-006`. The current
    declared vertical is a synthetic KiriKiri/XP3 profile that runs detect,
    key/profile resolution, extract, trivial patch, verify, and `.kaifuu` delta
    apply without leaking keys, private paths, helper dumps, or decrypted private
    text.

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
  "requirements": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:siglus/example/secondary-key",
      "source": "local-only-placeholder",
      "material": {
        "kind": "fixedBytes",
        "bytes": 16
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
secret `requirements[].requirementId` with a `keyRequirements[].requirementId`
entry that has a valid placeholder `secretRef`. Requirements blocks must not
store raw keys, raw key-looking strings, absolute paths, helper dump offsets, or
decrypted material; they may only point at local-only secret material by stable
reference. The plaintext fixture adapter intentionally emits no key requirement
declarations.

## Helper Classes

Kaifuu should support multiple helper classes behind one structured result
contract:

- **Static parser**: reads project files or executables directly and extracts or
  validates key candidates when the format is known.
- **Known-key database import**: imports local/community key entries into local
  secret storage, recording source metadata without publishing the key.
- **Wine/local Windows helper**: runs engine-specific helper code beside the
  owned game to produce a redacted key-profile result.
- **Remote Windows helper**: optionally lets a Linux/macOS development agent
  request a local network Windows host to run a helper and return structured
  redacted evidence. This belongs to continuous helper expansion unless a later
  DAG node makes an exact remote workflow alpha-blocking.
- **Manual key entry**: lets the user provide a known key and validates it
  against local assets before pure adapters consume it.

All helper outputs must be schema-validated, redacted before persistence, and
safe to include in aggregate readiness reports.

Known-key database imports are allowed only as local helper inputs. Kaifuu may
import an entry into local secret storage and record provenance such as source
label, import time, engine family, validation proof hash, and tool version, but
it must not require live community services, publish imported keys, or make
public CI depend on a private key table. A failed lookup is a missing-key or
helper-unavailable result, not a reason to weaken adapter boundaries.

## 2026 Research Snapshot

Current tooling points to several different key-discovery mechanisms. Kaifuu
should model each as evidence and helper capability, not collapse them into a
single decryption flag.

| Engine family   | Observed existing-tool behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Kaifuu implication                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| KiriKiri/XP3    | GARbro can browse many VN archive formats and says some encrypted archives ask for credentials or a game title. Its supported-format table includes KiriKiri `.xp3`. KrkrExtract handles krkr2/krkrz XP3 extract/pack, has a `Universal Dumper` for krkrz, generates `KrkrExtract.db` for universal patching, and explicitly warns that protected executables and bypass interactions are difficult.                                                                                                                                                             | Detection must separate plain XP3, encrypted XP3, protected executable, helper-required, and patch-workflow cases. Pure KAG support must not imply encrypted-XP3 support. Helper work may be Windows-oriented or database-backed, but adapter reports stay redacted and capability-scoped. |
| SiglusEngine    | SiglusExtract is a Windows tool that extracts/repackages Siglus resources including `Scene.pck` and `Gameexe.dat`, detects additional text encryption, and provides repack/universal patch flows. `siglus_rs` documents a `key.toml` handoff with a 16-byte secondary key, notes that trial versions often work with a zero key, and names static extraction, dynamic extraction, and known-key databases for retail keys. `siglus_static_key_tool` statically analyzes executables, packed stubs, and validates candidates against `Gameexe.dat` decompression. | Siglus should be the canonical proof that key discovery is outside pure adapters. The adapter consumes a resolved secondary-key secret ref and validation proof; helper specs cover static parser, dynamic/runtime helper, known-key import, and validation failure paths.                 |
| RPG Maker MV/MZ | RPG Maker MV/MZ decrypter tooling supports built-in encrypted asset extensions `.rpgmvp`, `.rpgmvm`, `.rpgmvo`, `.png_`, `.m4a_`, and `.ogg_`; it can detect keys from MV/MZ `System.json` or encrypted images, notes images can sometimes be restored without the key, and treats audio as key-required.                                                                                                                                                                                                                                                        | The alpha readiness milestone RPG Maker JSON-text adapter must include encrypted-asset diagnostics and key-profile handling even if full encrypted media patching is a later claim. Text-bearing images and media metadata are localization surfaces.                                      |
| Wolf RPG Editor | WolfDec describes `.wolf` archive decryption. UberWolf adds GUI/CLI full-game processing, all common archive extensions, automatic decryption-key detection, and Pro Editor Protection Key detection.                                                                                                                                                                                                                                                                                                                                                            | Wolf triage needs helper capability rows for archive decryption, automatic key detection, and Pro protection-key detection before full text patching. Public CI should use synthetic detector fixtures; owned games use private-local redacted readiness reports.                          |
| BGI/Ethornell   | VNTranslationTools supports Buriko General Interpreter/Ethornell among many VN formats. BGIKit focuses on script decode/encode and requires the original file beside translated text because the encoder needs original-file information. Public evidence found here is more about bytecode/container patching than a universal key-discovery path.                                                                                                                                                                                                              | Treat BGI as profile/container/bytecode-first. If an encrypted/compressed case appears, it must fail as an unknown transform, missing crypto capability, or unsupported layered transform until a concrete variant proves that key/profile material is required.                           |

## Engine Notes

- **KiriKiri/XP3**: tools such as GARbro know many XP3 variants and may prompt
  for a crypt scheme or game-specific option for encrypted archives. KrkrExtract
  shows the practical Windows-oriented runtime/patch workflow, including
  universal dump and patch paths, while warning that protected executables and
  bypass conflicts are hard. Alpha needs XP3/archive detection, local helper
  boundaries, and one profiled encrypted XP3 extract/patch/verify vertical.
  Broader production encrypted-XP3 support remains scoped per declared profile.
- **SiglusEngine**: Siglus tools center on `Scene.pck`, `Gameexe.dat`, and a
  game-specific secondary key. Practical paths include static extraction,
  dynamic extraction, and known-key databases. Alpha needs the key-profile
  boundary, static helper adapter, known-key Scene/Gameexe smoke, and redaction
  tests before any broader production Siglus adapter claim.
- **RPG Maker MV/MZ**: built-in asset encryption commonly exposes key recovery
  through `System.json` or encrypted image files. Some image restoration can be
  possible without a key, while audio needs one. Alpha adapter support remains
  JSON-text-first for the main vertical, but encrypted asset detection,
  key-profile handling, and a trivial encrypted-asset replacement patch belong
  in alpha readiness because text-bearing images and media metadata are
  localization surfaces.
- **Wolf RPG Editor**: Wolf tools show `.wolf` archive decryption, broad
  extension handling, automatic key detection, and Pro protection-key
  detection. Alpha needs archive/protection detection and the `KAIFUU-040`
  readiness/helper slice; `KAIFUU-073` full encrypted archive patching remains
  continuous/future and can still wait for binary patching support.
- **BGI/Ethornell**: public tools emphasize script decoding/encoding,
  string-table or bytecode handling, and original-file-informed encoding. The
  immediate alpha readiness need is profile/container triage and
  encrypted/compressed boundary detection. BGI transformed inputs should stay
  `unknown_variant`, `kaifuu.missing_capability.crypto`, or
  `kaifuu.unsupported_layered_transform` until exact variant evidence establishes
  a key requirement.

## Detection Matrix Surface

`kaifuu detect` includes an `archiveDetection` matrix from `kaifuu-core`. The
matrix is evidence for triage, not an extraction support claim. Rows cover
KiriKiri/XP3, Siglus, RPG Maker MV/MZ encrypted assets, Wolf RPG Editor
archives, BGI/Ethornell containers, Ren'Py packed inputs, and unknown
archive-like variants.

The top-level detection report `status` describes registered adapter detection
only. Archive-only unsupported inputs keep top-level `status: "unknown"` and
put their independent archive match under `archiveDetection.status`. This split
keeps encrypted or packed triage evidence from overstating extraction adapter
support.

Matrix evidence is aggregate-only: extension counts, known neutral marker names,
header classes, and metadata-field presence. It must not serialize raw keys,
helper dumps, decrypted text, local paths, or concrete source filenames. RPG
Maker encrypted asset detection counts MV-style `.rpgmvp`, `.rpgmvm`, and
`.rpgmvo` files plus MZ-style `.png_`, `.m4a_`, and `.ogg_` files. `System.json`
detection records that encryption fields exist; it never records the
`encryptionKey` value. The top-level detection report keeps `gameDir` only as a
redacted placeholder so private-local absolute paths and game titles do not
leave the local machine through report artifacts.

Rows emit stable diagnostics for encrypted, packed, protected, missing-key,
helper-required, and unknown-variant cases. A matching row also reports
unsupported extraction and patching capabilities unless a future adapter
separately proves and documents support for that exact variant.
Subtype-only markers without primary archive/container evidence are normalized
out of the family row and reported as aggregate unknown-variant marker evidence
instead of emitting family-specific key requirements.

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
- `kaifuu.unsupported_layered_transform`
- `kaifuu.missing_capability.container`
- `kaifuu.missing_capability.crypto`
- `kaifuu.missing_capability.codec`
- `kaifuu.missing_capability.patch_back`
- `kaifuu.secret_redacted`
- `kaifuu.unsupported_variant.encrypted`
- `kaifuu.unsupported_variant.packed`
- `kaifuu.unknown_engine_variant`

Layered access preflight failures use these same stable errors before any patch
writer runs. Missing container, crypto, codec, or patch-back support is a
capability failure, not a parser panic, partial patch, or raw helper exception.

Key validation may record proof hashes, decrypted header class, byte counts,
tool version, and aggregate readiness status. It must not record decrypted
private strings or the raw key.

## CI And Private-Local Split

Public CI stays public-fixture-only. It may include synthetic encrypted archives
with public test keys, negative detector fixtures, and redaction tests. It must
not depend on private corpora, retail keys, commercial archives, helper dumps,
Wine, Windows, or live community key services.

Private-local encrypted validation is still a first-class alpha evidence lane.
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
