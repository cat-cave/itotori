# Localization Surfaces

This inventory defines the shared localization surface model that future bridge,
asset, patch, and runtime evidence schemas should cover. It is engine-agnostic:
it names player-visible and localization-relevant surfaces without encoding how
RPG Maker, KiriKiri, SiglusEngine, Ren'Py, Unity, or the fixture engine stores
them.

Engine adapters may keep engine-specific details in adapter-private metadata,
but shared contracts should use the neutral fields below. If a future schema
needs a field that only makes sense for one engine, that field belongs in a
Kaifuu adapter profile or capability report, not in the shared surface contract.

## Project Boundaries

- **Kaifuu** extracts surfaces from source assets, assigns stable source keys,
  classifies surface kinds, records source revisions, detects protected spans,
  and emits patch references. Kaifuu may report source-side hints such as text
  bounds, image regions, or observed markup, but it does not decide target copy.
- **Itotori** imports surfaces, owns locale-branch policy, draft text, romanized
  or do-not-translate decisions, QA findings, feedback, and patch-ready exports.
  Itotori must operate on neutral surface fields rather than engine file shapes.
- **Utsushi** observes patched runtime behavior and links traces, captures, and
  findings back to bridge units, assets, spans, and route context. Utsushi can
  report that a localized result is missing, clipped, stale, or unreadable, but
  it does not redefine the source inventory.
- **Shared contracts** live in the neutral schema package and fixtures. Database
  schemas, dashboards, engine adapters, and generated bindings consume those
  contracts; they are not contract authorities.

## Unit, Span, And Policy Terms

- A **localization unit** is independently reviewable text or asset text with a
  source identity, source revision, locale, policy, and patch target.
- A **protected span** is a UTF-8 byte range inside a unit that must be
  preserved, mapped, or transformed according to typed rules. Control markup and
  variables usually appear as protected spans rather than independent units.
- An **annotation span** is source text attached to another range, such as ruby
  or furigana. Annotation spans can need translation, romanization, preservation,
  or removal per locale policy.
- A **policy decision** records whether a source payload should be localized,
  romanized, or preserved without translation for a specific locale branch.

## Span Offset Convention

All shared text span offsets use UTF-8 byte offsets into the exact `sourceText`
string for the containing localization unit. Ranges are half-open:
`[startByte, endByte)`.

This convention applies to control markup, variables, ruby/furigana base ranges,
ruby/furigana annotation ranges when embedded in source text, and any future
protected or annotation span. Schemas should use `startByte` and `endByte` field
names instead of ambiguous `start`, `end`, `offset`, or character-index fields.
If an adapter records UI glyph positions, UTF-16 indices, line/column numbers,
or rendered pixel bounds, those are additional metadata and do not replace the
UTF-8 byte range required by the shared contract.

## Core Field Checklist

Every future surface-bearing schema should be able to map its rows to these
typed fields. A row may be a text unit, an asset-text unit, a span attached to
another unit, or a locale-scoped policy record. Surface kinds, span kinds, and
policy record kinds are separate enums.

| Field                | Applies To                          | Responsibility                                                                                          |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `surfaceId`          | units and asset-text regions        | Stable shared ID for the reviewable surface.                                                            |
| `surfaceKind`        | localization units                  | Engine-neutral surface enum such as `dialogue`, `choice_label`, or `image_text`.                        |
| `spanKind`           | spans                               | Engine-neutral span enum such as `control_markup`, `variable_placeholder`, or `ruby_annotation`.        |
| `policyRecordKind`   | policy records                      | Engine-neutral policy enum such as `romanized_term` or `non_translated_term`.                           |
| `sourceUnitKey`      | units                               | Stable source-side key within the extracted bundle.                                                     |
| `occurrenceId`       | repeated occurrences                | Distinguishes repeated uses of the same source key.                                                     |
| `sourceLocale`       | units                               | BCP 47 source locale.                                                                                   |
| `sourceText`         | text units and spans                | Exact source text before localization.                                                                  |
| `sourceAssetRef`     | asset text, metadata, audio, images | Neutral reference to the asset containing the payload.                                                  |
| `sourceHash`         | units and assets                    | Hash of the relevant source payload or region.                                                          |
| `sourceRevision`     | all patchable rows                  | Revision identity used to reject stale patch exports.                                                   |
| `sourceLocation`     | patchable rows                      | Neutral logical location: asset ID, container key, range, region, or entry path.                        |
| `context`            | units                               | Scene, route, speaker, choice group, database kind, or UI area context.                                 |
| `targetLocale`       | locale-scoped rows                  | BCP 47 target locale when the row applies to a locale.                                                  |
| `localeBranchId`     | locale-branch policy rows           | Itotori locale branch identity when a policy applies to a branch rather than only a locale tag.         |
| `policyAction`       | units and policy rows               | One of `localize`, `romanize`, or `do_not_translate`; always paired with target locale or branch scope. |
| `policyReason`       | non-default policy rows             | Human or adapter explanation for the policy decision.                                                   |
| `spans`              | text units                          | Typed protected or annotation spans with `startByte`, `endByte`, and raw text.                          |
| `patchRef`           | patchable rows                      | Engine-neutral write target, write mode, and patch constraints.                                         |
| `runtimeExpectation` | runtime-visible rows                | How Utsushi should look for the result: trace text, layout probe, screenshot region, or metadata-only.  |

## Policy Categories

These policy actions are locale-scoped. The same source can be localized for one
target locale, romanized for another, and preserved for a third.

| Policy Action      | Meaning                                                                              | Required Fields                                                                                       | Common Cases                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `localize`         | Translate or culturally adapt the payload for the target locale.                     | `targetText`, `targetLocale` or `localeBranchId`, `sourceHash`, `policyAction`.                       | Dialogue, narration, tutorials, UI, bestiary entries, image text that can be edited.                           |
| `romanize`         | Convert the source script to a target-readable form without translating the meaning. | `targetText`, `targetLocale` or `localeBranchId`, `romanizationSystem`, `policyReason`, `sourceHash`. | Character names, place names, song titles, terms where the source name should remain recognizable.             |
| `do_not_translate` | Preserve the source payload exactly or by a documented normalization rule.           | `targetLocale` or `localeBranchId`, `targetText` or preserve marker, `policyReason`, `sourceHash`.    | Trademarks, passwords, codes, file labels, iconic names, legal credits, untranslated honorific/name decisions. |

Protection is separate from policy. A localized line can still contain protected
variables or control markup, and a do-not-translate term can still appear inside
a larger localized sentence.

## Asset Policy Contract

`packages/localization-bridge-schema` now exposes `AssetPolicyBundleV02` for
non-dialogue asset decisions that live on an Itotori locale branch. The bundle
has a required `localeBranch.localeBranchId` plus `targetLocale`, so image,
audio metadata, UI art, font, credit, and video choices are tied to the branch
that approved them rather than only to a broad locale tag.

The asset policy surface enum is separate from `surfaceKind` because these
records can describe asset-level decisions before a patchable text unit exists.
The current asset policy surfaces are:

| Asset Policy Surface | Typical Asset Kinds   | Policy Use                                                              |
| -------------------- | --------------------- | ----------------------------------------------------------------------- |
| `image_text`         | `image`, `ui_texture` | Desired text for signs, title cards, CG text, maps, or frame regions.   |
| `ui_art`             | `ui_texture`, `image` | UI art or texture labels that require redraw, overlay, or preservation. |
| `song_title`         | `audio`, `metadata`   | Track title metadata that may localize, romanize, or preserve.          |
| `font`               | `font`                | Locale branch font substitution or coverage policy.                     |
| `credits`            | `metadata`, `video`   | Legal, staff, attribution, and ending-credit strings.                   |
| `video`              | `video`               | Video frame text or replacement/subtitle policy.                        |

`patchMode` records required downstream work. Values such as
`region_redraw_required`, `asset_replacement_required`, and
`font_substitution_required` do not claim that editing is complete. A
`metadata_only` decision is metadata-first: it must use a `metadata_only`
runtime expectation and must not be treated as OCR, image redraw, or video edit
support.

## Surface Kinds

| Surface Kind     | Localizable Payload                                                                                                           | Future Typed Fields                                                                                                                                | Default Policy And Notes                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dialogue`       | Spoken line or message-window text.                                                                                           | `speakerRef`, `sceneRef`, `routeRef`, `voiceRef`, `spans`, `patchRef`, `runtimeExpectation`.                                                       | Usually `localize`. Preserve variables, control markup, voice sync hints, and speaker identity.                                                                                                                                                        |
| `narration`      | Prose shown without an in-world speaker.                                                                                      | `sceneRef`, `routeRef`, `narrationMode`, `spans`, `patchRef`, `runtimeExpectation`.                                                                | Usually `localize`. Must not be collapsed into dialogue just because an engine stores both in one command list.                                                                                                                                        |
| `speaker_name`   | Name plate, backlog speaker label, chat sender, or battle callout name.                                                       | `speakerRef`, `displayContext`, `canonicalNameRef`, `policyAction`, `targetLocale` or `localeBranchId`, `patchRef`.                                | Locale branch decides `localize`, `romanize`, or `do_not_translate`. Itotori owns consistency across all occurrences.                                                                                                                                  |
| `choice_label`   | Player-visible option text.                                                                                                   | `choiceGroupId`, `choiceId`, `optionIndex`, `routeTargetRef`, `spans`, `patchRef`, `runtimeExpectation`.                                           | Usually `localize`. Preserve branch identity separately from display text so patching cannot change game logic.                                                                                                                                        |
| `ui_label`       | Menus, buttons, settings, status labels, HUD text, save/load labels, and system messages.                                     | `uiArea`, `controlRef`, `layoutConstraint`, `spans`, `patchRef`, `runtimeExpectation`.                                                             | Usually `localize`. Length and layout constraints are first-class because Utsushi should find clipping regressions.                                                                                                                                    |
| `tutorial_text`  | Help text, input prompts, onboarding, glossary help, and control explanations.                                                | `tutorialStepRef`, `inputActionRefs`, `platformCondition`, `spans`, `patchRef`.                                                                    | Usually `localize`. Button glyphs and input variables are protected spans, not free text.                                                                                                                                                              |
| `database_entry` | Bestiary, item, skill, quest, location, achievement, character bio, codex, or encyclopedia text.                              | `databaseKind`, `entryId`, `fieldKey`, `sortKey`, `spans`, `patchRef`, `runtimeExpectation`.                                                       | Usually `localize`. Includes both names and descriptions; names may use romanize or preserve policy.                                                                                                                                                   |
| `song_title`     | Song, BGM, ending theme, album, music-room, or jukebox title.                                                                 | `audioAssetRef`, `trackId`, `titleField`, `creditRefs`, `policyAction`, `targetLocale` or `localeBranchId`, `patchRef`.                            | Policy is explicit: localize, romanize, or preserve. Do not infer from dialogue rules.                                                                                                                                                                 |
| `image_text`     | Text rendered into an image, texture, CG, sign, logo, title card, map, video frame, or UI sprite.                             | `sourceAssetRef`, `region`, `ocrText`, `editable`, `replacementMode`, `patchRef`, `runtimeExpectation`.                                            | Policy plus asset action is required. Itotori records the desired localized text; Kaifuu records whether patching is possible; Utsushi validates visible output when practical. Asset policy metadata does not imply OCR or image editing is complete. |
| `metadata_text`  | Titles, subtitles, save metadata, credits, package text, achievements, tags, config descriptions, or platform-facing strings. | `metadataScope`, `fieldKey`, `visibility`, `sourceAssetRef`, `policyAction`, `targetLocale` or `localeBranchId`, `patchRef`, `runtimeExpectation`. | May be `localize`, `romanize`, or `do_not_translate`. Some metadata is not runtime-visible but still shipped to players.                                                                                                                               |

## Span Kinds

Span kinds are not top-level localization surfaces. They are typed ranges inside
`sourceText` for a containing surface, and every offset below uses UTF-8
half-open byte bounds.

| Span Kind              | Payload                                                                   | Future Typed Fields                                                                                                                                                                              | Notes                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `control_markup`       | Engine or UI control codes embedded in text.                              | `spanKind`, `raw`, `parsedName`, `arguments`, `startByte`, `endByte`, `preserveMode`.                                                                                                            | Must survive localization and patching without being interpreted as translatable prose.                                                |
| `variable_placeholder` | Runtime substitution such as player name, item count, currency, or stat.  | `spanKind`, `variableName`, `formatHint`, `exampleValues`, `startByte`, `endByte`, `preserveMode`.                                                                                               | Itotori may reorder or map it in target text, but cannot drop or corrupt it.                                                           |
| `ruby_annotation`      | Ruby, furigana, pronunciation guide, reading aid, or parallel text gloss. | `spanKind`, `baseStartByte`, `baseEndByte`, `annotationStartByte`, `annotationEndByte`, `annotationText`, `annotationLocale`, `displayMode`, `policyAction`, `targetLocale` or `localeBranchId`. | Can be localized, romanized, preserved, or omitted by locale policy. Treating ruby as disposable markup loses meaning in many scripts. |

## Policy Record Kinds

Policy record kinds are not surface kinds and do not imply a separate runtime
unit. They document locale-scoped decisions that can apply across many surfaces
or spans.

| Policy Record Kind    | Payload                                                                 | Future Typed Fields                                                                                                               | Notes                                                                                        |
| --------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `romanized_term`      | A term intentionally rendered in Latin script or another target script. | `policyRecordKind`, `termKey`, `sourceScript`, `targetLocale` or `localeBranchId`, `romanizationSystem`, `scope`, `policyReason`. | Itotori owns consistency and QA across linked units.                                         |
| `non_translated_term` | A term intentionally preserved from the source locale.                  | `policyRecordKind`, `termKey`, `preserveForm`, `targetLocale` or `localeBranchId`, `scope`, `policyReason`, `reviewRequired`.     | Common for names, trademarks, codes, honorific style choices, or fan-facing canonical terms. |

## Schema Work Checklist

- [ ] Every inventory row maps to exactly one of `surfaceKind`, `spanKind`, or
      `policyRecordKind`.
- [ ] Dialogue and narration are separate surface kinds even if an engine stores
      them in the same command stream.
- [ ] Speaker labels, choices, UI, tutorials, bestiary/database text, song
      titles, images with text, and metadata are first-class surfaces.
- [ ] Control markup, variables, and ruby/furigana are typed spans or annotation
      records with UTF-8 byte offsets, half-open `[startByte, endByte)` bounds,
      and patch behavior.
- [ ] `localize`, `romanize`, and `do_not_translate` decisions are explicit,
      locale-scoped with `targetLocale` or `localeBranchId`, and reviewable.
- [ ] Asset policy decisions are branch-scoped and cover image text, UI art,
      song titles, fonts, credits, and videos without implying OCR or asset
      editing completion.
- [ ] Source identity includes a stable key, occurrence identity, source hash,
      and source revision so stale patch exports can be rejected.
- [ ] Patch references are neutral and do not expose engine-specific file
      internals to Itotori.
- [ ] Utsushi evidence can link back to the same surface IDs, spans, assets, and
      route context emitted by Kaifuu and reviewed by Itotori.
- [ ] Shared enums avoid engine names. Engine-specific capabilities belong in
      Kaifuu adapter profiles or private metadata.
- [ ] Metadata-only surfaces are represented even when Utsushi cannot observe
      them at runtime.
