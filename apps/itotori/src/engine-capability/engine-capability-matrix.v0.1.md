# Engine capability matrix (generated)

> GENERATED ARTIFACT — do not hand-edit. Regenerate with `node scripts/generate-engine-capability-matrix.mjs`. Manual edits fail `--check`.

- Schema: `itotori.engine_capability_matrix.v0.1`
- Generator: `scripts/generate-engine-capability-matrix.mjs`
- Capability levels: identify, inventory, extract, patch, helper, runtime
- Input categories covered: claimed_support_tuples, fixture_output, readiness_profile, validation_artifact
- Input kinds covered: adapter_registry, detection_report, detection_summary, detector_profile, production_capability_tuple, readiness_profile, validation_artifact

## Capability rows

| Row | Engine family | Posture | identify | inventory | extract | patch | helper | runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic-fixture-plaintext-identity | synthetic_fixture | positive_adapter | yes | yes | yes | partial | n/a | no |
| tyranoscript-null-key-readiness | tyranoscript | readiness_only | yes | yes | no | no | n/a | no |
| kirikiri-xp3-plain-readiness | kiri_kiri_xp3 | readiness_only | yes | yes | no | no | partial | no |
| kirikiri-xp3-compressed-readiness | kiri_kiri_xp3 | readiness_only | yes | yes | no | no | partial | no |
| kirikiri-xp3-encrypted-crypt-smoke | kiri_kiri_xp3 | readiness_only | yes | yes | no | no | partial | no |
| kirikiri-xp3-plain-extract-patch | kiri_kiri_xp3 | positive_adapter | yes | yes | yes | yes | n/a | no |
| siglus-scene-pck-detector-readiness | siglus | readiness_only | yes | yes | no | no | partial | no |
| siglus-known-key-scene-gameexe-smoke | siglus | readiness_only | yes | yes | partial | no | partial | no |
| rpg-maker-mv-mz-encrypted-media | rpg_maker_mv_mz | readiness_only | yes | no | no | no | partial | no |
| rpg-maker-mv-mz-json-text-extract-patch | rpg_maker_mv_mz | positive_adapter | yes | yes | yes | yes | n/a | no |
| wolf-rpg-editor-encrypted-archive-smoke | wolf_rpg_editor | readiness_only | yes | no | no | no | partial | no |
| bgi-ethornell-container-readiness | bgi_ethornell | readiness_only | yes | no | no | no | no | no |
| reallive-seen-txt-detector-readiness | reallive | readiness_only | yes | yes | no | no | no | no |
| reallive-accepted-output-patchback-produce | reallive | readiness_only | yes | n/a | partial | partial | n/a | no |
| softpal-script-src-text-dat-extract-patch | softpal | positive_adapter | yes | yes | yes | partial | n/a | no |

## Posture legend

- `positive_adapter`: a real adapter that extracts and/or patches, evidenced by an adapter-registry / claimed-support tuple.
- `readiness_only`: detector/profile/readiness/validation evidence; identification and (sometimes) inventory only — no extract/patch adapter is claimed.

## Inputs

- `reallive-detector-capabilities` (claimed_support_tuples/adapter_registry) — fixtures/public/reallive-detector/capabilities.json
- `xp3-plain-detector-profile` (fixture_output/detector_profile) — fixtures/public/kaifuu-encrypted-matrix/expected/xp3-plain-detector-profile-v0.1.json
- `xp3-compressed-detector-profile` (fixture_output/detector_profile) — fixtures/public/kaifuu-encrypted-matrix/expected/xp3-compressed-detector-profile-v0.1.json
- `xp3-encrypted-detector-profile` (fixture_output/detector_profile) — fixtures/public/kaifuu-encrypted-matrix/expected/xp3-encrypted-detector-profile-v0.1.json
- `siglus-detector-profile` (fixture_output/detector_profile) — fixtures/public/kaifuu-encrypted-matrix/expected/siglus-detector-profile-v0.1.json
- `siglus-known-key-parser-boundary-smoke` (validation_artifact/validation_artifact) — fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json
- `rpg-maker-mv-mz-key-validation` (validation_artifact/validation_artifact) — fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json
- `rpg-maker-mv-mz-readiness-merge` (readiness_profile/readiness_profile) — fixtures/public/catalog-capability-evidence-mv-mz-merge/expected/readiness-merge-v0.1.json
- `production-extract-patch-proofs` (claimed_support_tuples/production_capability_tuple) — fixtures/kaifuu/production-capabilities/extract-patch-proofs.v0.1.json
- `reallive-patchback-produce` (validation_artifact/validation_artifact) — fixtures/public/itotori-patchback-produce/expected/reallive-patchback-produce-capability-v0.1.json
- `rpg-maker-mv-mz-encrypted-suffixes-detection` (fixture_output/detection_report) — fixtures/public/kaifuu-rpg-maker-encrypted-suffixes/expected/detection-report-v0.1.json
- `encrypted-matrix-detection-summary` (readiness_profile/detection_summary) — fixtures/public/kaifuu-encrypted-matrix/expected/detection-summary-v0.1.json
- `tyranoscript-null-key-readiness` (readiness_profile/detector_profile) — fixtures/kaifuu/tyranoscript/null-key-readiness-profile.json

## Exclusions

- `renpy`: Ren'Py is not an alpha Japanese-localization opportunity driver: it is over-represented in catalog data by Western/English doujin output and already has high existing translation coverage. Per docs/research/japanese-engine-opportunity-analysis.md it is the easy, already-done reference engine, not a greenfield Japanese driver. It surfaces only as a packed-input detector row and is excluded from the capability breadth.
- `unknown`: The unknown-archive-variant row is a non-engine triage bucket, not an engine family, and carries no capability claim.

## Known limitations

- [kirikiri-xp3-plain-readiness] helper: key/helper requirement is named but not resolved by this readiness evidence
- [kirikiri-xp3-plain-readiness] KiriKiri breadth is XP3 container/readiness evidence only; plaintext .ks/.tjs is not claimed as standalone extract/patch support
- [kirikiri-xp3-compressed-readiness] helper: key/helper requirement is named but not resolved by this readiness evidence
- [kirikiri-xp3-compressed-readiness] KiriKiri breadth is XP3 container/readiness evidence only; plaintext .ks/.tjs is not claimed as standalone extract/patch support
- [kirikiri-xp3-encrypted-crypt-smoke] helper: key/helper requirement is named but not resolved by this readiness evidence
- [kirikiri-xp3-encrypted-crypt-smoke] KiriKiri breadth is XP3 container/readiness evidence only; plaintext .ks/.tjs is not claimed as standalone extract/patch support
- [kirikiri-xp3-plain-extract-patch] runtime: archive rebuild proof does not establish runtime compatibility
- [kirikiri-xp3-plain-extract-patch] positive extract/patch support is limited to plain XP3 archive rebuild; compressed-entry replacement, encrypted/protected variants, and standalone script support are not claimed
- [siglus-scene-pck-detector-readiness] helper: key/helper requirement is named but not resolved by this readiness evidence
- [siglus-known-key-scene-gameexe-smoke] extract: parser-boundary smoke parses known-key text slots only; production extraction is not claimed
- [siglus-known-key-scene-gameexe-smoke] patch: patch write was not attempted; Siglus patch-back/repack is not claimed
- [siglus-known-key-scene-gameexe-smoke] helper: known-key reference plumbing is validated for fixture inputs only; no production key resolution is claimed
- [siglus-known-key-scene-gameexe-smoke] runtime: runtime compatibility is not claimed by the parser-boundary smoke
- [rpg-maker-mv-mz-encrypted-media] inventory: MV/MZ readiness merge does not claim inventory support
- [rpg-maker-mv-mz-encrypted-media] extract: encrypted-media key validation matches key evidence only; it does not decrypt, extract, or replace media
- [rpg-maker-mv-mz-encrypted-media] patch: no decrypt/patch is claimed from media-key detection alone
- [rpg-maker-mv-mz-encrypted-media] helper: key evidence is validated against System.json; no key material is resolved or decrypted
- [rpg-maker-mv-mz-encrypted-media] runtime: no runtime evidence is claimed for MV/MZ readiness
- [rpg-maker-mv-mz-json-text-extract-patch] runtime: JSON text extract/patch proof does not establish runtime compatibility
- [rpg-maker-mv-mz-json-text-extract-patch] positive extract/patch support is limited to JSON text in maps, common events, database, system, and terms; plugin JavaScript and encrypted media are not claimed
- [wolf-rpg-editor-encrypted-archive-smoke] inventory: detection summary provides identify-only readiness; no inventory parser is claimed
- [wolf-rpg-editor-encrypted-archive-smoke] extract: no extraction is claimed; detector/profile readiness evidence only
- [wolf-rpg-editor-encrypted-archive-smoke] patch: no parser or patch support is claimed
- [wolf-rpg-editor-encrypted-archive-smoke] helper: a key/helper requirement is named but not resolved by this readiness evidence
- [wolf-rpg-editor-encrypted-archive-smoke] runtime: no runtime evidence is claimed
- [bgi-ethornell-container-readiness] inventory: detection summary provides identify-only readiness; no inventory parser is claimed
- [bgi-ethornell-container-readiness] extract: no extraction is claimed; detector/profile readiness evidence only
- [bgi-ethornell-container-readiness] patch: no parser or patch support is claimed
- [bgi-ethornell-container-readiness] helper: an encrypted/keyed surface is detected but no key or helper handling is claimed
- [bgi-ethornell-container-readiness] runtime: no runtime evidence is claimed
- [reallive-seen-txt-detector-readiness] helper: no key/helper handling is claimed
- [reallive-accepted-output-patchback-produce] extract: the two-corpus proof derives the source bridge through real Kaifuu extraction, but production starts from that accepted-output input
- [reallive-accepted-output-patchback-produce] patch: produceNativePatchbackBuild drives the real kaifuu patch seam and records a hash-bound playable build; validation evidence is not an EngineAdapter registry claim
- [reallive-accepted-output-patchback-produce] runtime: produce proves patched-build creation and delivery, not a runtime replay claim
- [reallive-accepted-output-patchback-produce] patchback-produce is gate-enforced only while the strict two-corpus real-byte oracle and both production surfaces remain declared by its capability artifact
- [exclusion:renpy] Ren'Py is not an alpha Japanese-localization opportunity driver: it is over-represented in catalog data by Western/English doujin output and already has high existing translation coverage. Per docs/research/japanese-engine-opportunity-analysis.md it is the easy, already-done reference engine, not a greenfield Japanese driver. It surfaces only as a packed-input detector row and is excluded from the capability breadth.
- [exclusion:unknown] The unknown-archive-variant row is a non-engine triage bucket, not an engine family, and carries no capability claim.
