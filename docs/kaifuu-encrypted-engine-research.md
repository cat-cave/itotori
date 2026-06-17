# Kaifuu Encrypted Engine Research Brief

This brief records the current research basis for treating decryption and key
discovery as an alpha readiness lane. It complements
[kaifuu-key-discovery.md](kaifuu-key-discovery.md) and the roadmap nodes
`KAIFUU-035` through `KAIFUU-042`, `KAIFUU-050`, and `KAIFUU-051`.

## Research Conclusions

Kaifuu should not defer encryption/key discovery as future polish. Existing
VN/RPG tooling shows that practical extraction often depends on engine-specific
keys, runtime helpers, static executable analysis, patch databases, or
game-specific archive schemes. The alpha should therefore ship the generic
boundary and validation mechanisms even when a production adapter for a
specific encrypted commercial format remains out of scope.

The implementation stance is:

- Public CI uses only synthetic or redistributable encrypted fixtures with
  public fixture keys.
- Private-local validation is a first-class workflow under
  `fixtures/private-local/`, producing aggregate readiness evidence only.
- Pure adapters consume resolved key/profile data and never own executable
  hooks, Wine/Windows orchestration, community key databases, or remote helper
  calls.
- Helper results are structured, redacted, schema-validated, and safe to cite by
  hash and aggregate status.
- Unsupported encrypted, packed, protected, compiled, or unknown variants fail
  with stable semantic capability errors before patching writes output.
- Readiness reports must lead to production adapter nodes when evidence is
  strong enough. Once an adapter claims a profiled encrypted variant, failure to
  extract, patch, or validate that variant is treated as a bug unless the input
  is outside the declared support profile.

## Engine Findings

### KiriKiri/XP3

GARbro supports many visual novel formats, including KiriKiri `.xp3`, and its
README states that some encrypted archives require credentials or a presumed
game title. GARbro's XP3 implementation includes read/write crypt scheme
selection and per-entry encrypted handling. KrkrExtract focuses on krkr2/krkrz
XP3 extraction/packing, has a krkrz Universal Dumper, generates
`KrkrExtract.db` for Universal Patch, and warns that protected executables and
bypass conflicts are difficult.

Kaifuu implication: plaintext KAG support must not imply encrypted XP3 support.
XP3 detection should distinguish plain archive, encrypted archive, protected
executable, helper-required, and patch-database workflows. Production encrypted
XP3 patching needs an explicit support claim with fixtures and helper evidence;
once that claim exists, failures inside the declared XP3 profile are bugs, not
feature requests. Alpha detection/helper/redaction boundaries are mandatory
because they make that later claim safe.

### SiglusEngine

SiglusExtract describes Siglus as a two-layer key system where the per-game
second-layer key is required for decryption and repacking. It can dump a
`key.toml` consumed by `siglus_rs`, supports `Scene.pck` and `Gameexe.dat`, can
detect additional text encryption, and offers repack/universal patch flows.
`siglus_rs` is a multi-platform SiglusEngine implementation targeting Windows,
Linux, macOS, mobile, and WebAssembly; it documents a 16-byte secondary key,
trial zero-key behavior, and three retail-key paths: static extraction, dynamic
extraction, and known-key databases. `siglus_static_key_tool` statically
analyzes executables, packed stubs, nested PE images, and validates recovered
candidates against `Gameexe.dat` decompression.

Kaifuu implication: Siglus is the canonical proof that key discovery belongs
outside pure adapters. The pure future adapter should consume a resolved
secondary-key `secretRef`, archive parameters, and validation proof. Helper
specs must cover static parser, dynamic/runtime helper, known-key import,
manual entry, proof validation, and protected executable errors.

### RPG Maker MV/MZ

RPG Maker MV/MZ decrypter tooling supports built-in encrypted asset extensions
such as `.rpgmvp`, `.rpgmvm`, `.rpgmvo`, `.png_`, `.m4a_`, and `.ogg_`. It can
detect the encryption key from MV/MZ `System.json` or an encrypted image, and
notes that image restoration can be possible without the key while audio
requires decryption.

Kaifuu implication: the alpha readiness RPG Maker JSON-text adapter can remain text-first,
but encrypted asset detection and key-profile diagnostics are still alpha readiness. Image
text, UI textures, audio/song metadata, and media policy are localization
surfaces; the adapter must not silently ignore encrypted assets that may affect
localization scope.

### Wolf RPG Editor

WolfDec decrypts `.wolf` files. UberWolf adds full-game processing, support for
common archive extensions, automatic decryption-key detection, and Pro Editor
Protection Key detection.

Kaifuu implication: Wolf support needs archive and protection detection before
full text patching. Helper capabilities should model automatic key detection
and Pro protection-key detection. Public tests use synthetic detector fixtures;
private-local owned games provide aggregate readiness reports.

### BGI/Ethornell

VNTranslationTools supports Buriko General Interpreter/Ethornell among many VN
formats and emphasizes extracting and patching original text from scenario
files. BGIKit focuses on script decode/encode and says its encoder needs the
original script file beside the translated text because original-file
information is required.

Kaifuu implication: BGI is profile/container/bytecode-centric first, not a
single universal key workflow. Encrypted or compressed cases should fail with
semantic capability errors until a concrete key/profile requirement is proven.
Future production support must split binary patching, string reference safety,
container handling, and any key/profile requirements into reviewable nodes.

## Source Anchors

- GARbro: <https://github.com/morkt/GARbro>
- GARbro supported formats: <https://morkt.github.io/GARbro/supported.html>
- GARbro XP3 implementation:
  <https://github.com/morkt/GARbro/blob/master/ArcFormats/KiriKiri/ArcXP3.cs>
- KrkrExtract: <https://github.com/xmoezzz/KrkrExtract>
- SiglusExtract: <https://github.com/xmoezzz/SiglusExtract>
- siglus_rs: <https://github.com/xmoezzz/siglus_rs>
- siglus_static_key_tool:
  <https://github.com/xmoezzz/siglus_static_key_tool>
- RPG Maker MV/MZ Decrypter:
  <https://github.com/Petschko/RPG-Maker-MV-Decrypter>
- WolfDec: <https://github.com/Sinflower/WolfDec>
- UberWolf: <https://github.com/Sinflower/UberWolf>
- VNTranslationTools: <https://github.com/arcusmaximus/VNTranslationTools>
- BGIKit: <https://github.com/xupefei/BGIKit>
