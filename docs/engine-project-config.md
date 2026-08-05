# Engine project configuration

`extract` and `structure-export` use one JSON project document. JSON follows
the existing `localize-portfolio --portfolio <file>` convention while keeping
the project contract strict and independently discoverable.

```sh
itotori extract --project project.json
itotori structure-export --project project.json
```

Ask an installed adapter for the exact schema before creating a file:

```sh
itotori extract --engine reallive --describe
itotori structure-export --engine siglus --describe
```

Both commands read the same document:

```json
{
  "schemaVersion": 1,
  "engine": "reallive",
  "adapter": {},
  "source": {
    "root": "<read-only-source-root>"
  },
  "identity": {
    "id": "work-neutral-001",
    "version": "1.0",
    "sourceLocale": "ja-JP",
    "sourceProfileId": "source-profile-neutral"
  },
  "extract": {
    "output": "artifacts/bridge.json",
    "scope": {
      "kind": "all"
    }
  },
  "structure": {
    "output": "artifacts/structure.json"
  }
}
```

All engines use the same extraction-scope vocabulary:

- `{ "kind": "all" }` extracts every unit.
- `{ "kind": "unit-set", "unitIds": ["12", "24"] }` extracts named units.
- `{ "kind": "unit-range", "start": 12, "endExclusive": 24 }` extracts
  a half-open unit range.

Every declared adapter accepts every one of those three forms. There is no
per-engine scope-capability setting in either the config or its manifest.
`unitIds` are strings because their _values_ are source-format coordinates,
not because the config has engine-specific fields:

- archive adapters use their format's numeric scene-directory identifiers;
- packed-scene adapters use decimal `SceneList` directory identifiers;
- script-and-text adapters use the complete emitted `TEXT.DAT` record key;
- JSON-data adapters use `rpgmaker:<file>#<RFC-6901-pointer>` source keys.

`unit-range` always means a half-open range over the format's deterministic
source order: its archive directory, packed-scene directory, text-record
order, or JSON file/pointer order respectively. Each native adapter validates
those format facts after the shared config layer has accepted the same
vocabulary. It may reject an invalid coordinate or an out-of-bounds range, but
it cannot remove, rename, or replace a scope kind.

## Adapter parameters

The current RealLive, Siglus, Softpal, and RPG Maker project schemas each
declare **zero engine-specific parameters**. Source location, identity, scope,
and artifact outputs are project concerns, so they are shared fields above.
Engine source files are found below `source.root` by the adapter.

`adapter` is required in every document, even when empty. It is the only
location for a format-defined engine setting. Its accepted keys, primitive
types, required status, and descriptions come from the selected adapter's
declaration and are shown by `--describe`; each declared key must also name the
source `formatProperty` that justifies it. A key that describes decoder policy,
runtime convenience, or another implementation choice is a defect and must
not be declared. An undeclared key is refused. The CLI forwards a non-empty
adapter object as one generic native adapter-config value, so the command
surface never grows a per-engine flag.

There is deliberately no Siglus cipher setting. Its supported cipher profile
is fixed by the decoder and the archive decides whether a second-layer key is
needed; asking an operator to repeat that implementation detail was a defect.
Likewise, legacy aliases such as `gameRoot`, `gameDir`, `wholeSeen`, `scene`,
`gameexe`, `seen`, `cipherMethod`, and `vaultCanonicalId` are not valid
project-config keys.

Every invalid config produces an `EngineProjectConfigError` with a stable code,
the selected engine, and the offending key. For example, a missing
`identity.id` reports `missing-required-key` for that engine; an obsolete
`cipherMethod` reports `unknown-key` for that engine.

## Adding an engine

The CLI discovers adapter declarations from its adapter directory. Adding a
new engine's declared project schema means adding its adapter declaration (and
the native implementation that actually decodes that engine); it needs no new
top-level flag, no `if engine` branch in a command handler, and no shared
command-file edit. The declaration supplies the human description and any
format-only parameter list; it inherits the complete shared scope contract.
