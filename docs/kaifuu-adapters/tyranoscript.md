# TyranoScript `.ks` Adapter — Capability Record

- Adapter id: `kaifuu.tyranoscript`
- Crate: `kaifuu-tyrano`
- Roadmap node: KAIFUU-016 (TyranoScript extraction + patching adapter — a
  high-reach null-key/plaintext adapter on the layered pipeline).
- Engine family token: `tyranoscript`
  (`kaifuu_core::compat_profile::CompatEngineFamily::TyranoScript`).

## The layered pipeline

TyranoScript is a JavaScript-based VN engine. Its scenario files (`.ks`,
typically under `data/scenario/`) sit **loose on disk** and are **plaintext**
(UTF-8, or Shift-JIS on some legacy Japanese projects). This adapter is built
as the three-stage layered pipeline, at the null-key / plaintext floor:

| stage     | transform              | why                                                            |
| --------- | ---------------------- | -------------------------------------------------------------- |
| container | `identity`             | `.ks` files are loose on disk — there is no archive to unpack. |
| crypto    | `null_key`             | scenarios are plaintext — there is no cipher / key material.   |
| codec     | `tyrano_script_markup` | the KAG-style square-bracket markup dialect (parse + patch).   |

The claim tuple (`engineFamily=tyranoscript`, `container=identity`,
`crypto=null_key`, `codec=tyrano_script_markup`, `surface=identity`,
`patchBackMode=replace_file`, level `patch`) lives in
`kaifuu_core::compat_profile::fixtures::level_patch_tyranoscript` and is mirrored
on disk at `fixtures/kaifuu/compat-profile/tyranoscript.patch.tuple.json`. It is
part of the honest catalogue and validates green at the `patch` level (full
extraction + validation + patch-back evidence chain).

This mirrors the _shape_ of the KiriKiri KAG plaintext adapter (stable
extraction units + a byte-preserving splice-back) but is implemented
**independently** — `kaifuu-tyrano` does not depend on `kaifuu-kirikiri`.

## What carries translatable text vs structure

Extraction is deliberately conservative: only scenario **text** is translatable;
all engine structure is preserved byte-for-byte.

**Translatable** (extracted into stable `TsUnit`s):

- **Dialogue** — plain message-text runs between inline tags. Role
  `dialogue`.
- **Choice / link captions** — the inline caption of a `[link] … [endlink]`
  block, and the quoted `text="…"` attribute of a `[glink]` / `[button]`
  choice tag. Role `choice`.
- **Speaker display names** — a `#name` line, and the quoted `text="…"`
  attribute of a `[chara_ptext]` tag. Role `speaker_name`. Each dialogue/choice
  unit records the active speaker.

**Structure** (preserved byte-identical, never extracted):

- `;` comment lines and `*label|caption` label lines.
- `@command …` line commands (recorded as a `LineCommand` finding — no silent
  skip).
- every inline `[tag …]` — `[l]` / `[p]` / `[r]` waits, `[jump target=*label
storage=file.ks]`, `[call]`, `[if]` / `[endif]`, `[eval exp="f.x=1"]`, and
  all their attributes (including `target=` / `storage=` on choice tags).
- inline variable embeds `&expr` (e.g. `&f.count`) — see the assumption note
  below.
- `[[` literal-bracket escapes; the quote characters delimiting an attribute
  value; and all newlines.

`verify_byte_preserving` re-parses source and patched buffers and asserts (a)
the ordered translatable-unit key set is identical and (b) the structural
(non-text) byte streams are byte-identical, so any edit that touched a
tag/label/jump/variable/comment is caught.

## API surface

- `parse_ks` / `parse_ks_with_encoding` → `TsDocument` (units + findings),
  encoding-aware (UTF-8 + Shift-JIS) at the byte level so a Shift-JIS trailing
  byte equal to an ASCII delimiter (`[`, `]`, `&`, `#`, `@`) is skipped whole
  and never mistaken for a marker.
- `TsDocument::dialogue_units` / `choice_units` / `speaker_units`.
- `apply_patch` — byte-preserving splice of translations (keyed by
  `tyranoscript:<file>#L<line>#seg<segment>#<role>`) into their exact
  `[start_byte, end_byte)` spans. Hard-errors on unknown unit, stale source,
  newline-in-translation, an attribute translation containing its delimiting
  quote, overlap, or an encoding-unrepresentable translation.
- `verify_byte_preserving` — proves a patch changed only translatable spans.
- `layered_stack()` → `("identity", "null_key", "tyrano_script_markup")` and
  `ENGINE_FAMILY` (`"tyranoscript"`) — the pipeline tokens, queryable from code.

Determinism: pure in-process parsing, SHA-256-derived UUID7-shaped
`bridge_unit_id`s, no shell-outs / network / helper processes. Fixtures are
synthetic, authored, CC0 (`crates/kaifuu-tyrano/fixtures/scenario_basic.ks`);
no retail TyranoScript bytes.

## Assumed vs verified tag semantics

The core KAG-style shape (square-bracket tags, `#name` speaker lines, `[l]` /
`[p]` waits, `*label` jump targets, `[[` escape) is well-established across the
KAG/TyranoScript lineage. The following are **assumptions** the adapter pins
(documented so they can be re-checked against a real project):

- **`&expr` variable embed** consumes the `&` plus a JS member-path token
  `[A-Za-z0-9_.$]+` and terminates at the first non-path character. This makes
  it a clean run delimiter against following message text (e.g. `&f.count回目`).
  A consequence: a translation placed _immediately_ after an embed with no
  separating tag/whitespace must not begin with a member-path character (the
  source text there did not either). Real scripts separate `&exp` from
  following text with a space or a tag, so this is rarely load-bearing.
- **Choice `text="…"` attributes** are extracted only when **quoted** (single
  or double). An unquoted `text=value` is left as structure, because replacing
  it with translated text containing whitespace would corrupt the tag. Tag
  scanning is quote-aware, so a `]` inside `text="a]b"` does not end the tag.
- **`[chara_ptext text="…"]`** is treated as a speaker-name display tag (its
  quoted `text` attribute is the translatable name and it sets the active
  speaker). This is the assumed form; the primary, well-established speaker
  mechanism handled is the `#name` line.
