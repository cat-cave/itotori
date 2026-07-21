# Key-Discovery Engine Notes

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
