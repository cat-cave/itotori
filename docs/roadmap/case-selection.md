# Executable case selection

The feature corpus contains 570 authored Examples rows. Selection is not an
engine cross-product. The protected planner expands a row only when its
declared subject selector applies, keeps comparison inputs subordinate to that
subject, and rejects skips or unexpected executions.

## Subject selectors

The source of truth for identity and role is
[`engine-families.jsonl`](../behaviors/engine-families.jsonl). Selectors use
stable `sourceCapability` values:

- `shared` selects the single `all` subject once.
- `canonical:<sourceCapability>` selects exactly that canonical row.
- `production` selects all 39 `production-target` rows.
- `production-trait:native` selects 35 production rows.
- `production-trait:web` selects five production rows.
- `production-trait:plain` selects nine production rows.
- `production-trait:mixed` selects each of the 39 production rows once and
  supplies the next production row in sorted `sourceCapability` order as its
  comparison peer.

The web set is `decode.engine.rpg-maker-mv-mz`, `decode.engine.renpy`,
`decode.engine.tyranoscript`, `decode.engine.unity-i2`, and
`decode.engine.unity-naninovel`. The native set is every production row except
the four web-only rows: RPG Maker MV/MZ, TyranoScript, Unity I2, and
Unity/Naninovel. Ren'Py deliberately belongs to both transport sets.

The plain set is `decode.engine.softpal`, `decode.engine.nexas`,
`decode.engine.rpg-maker-mv-mz`, `decode.engine.kirikiri-kag-xp3`,
`decode.engine.renpy`, `decode.engine.bgi-ethornell`,
`decode.engine.tyranoscript`, `decode.engine.unity-i2`, and
`decode.engine.unity-naninovel`. The mixed set is all 39 production rows.
Unqualified production rows are native and non-plain until their qualification
cell registers contrary material evidence; that choice selects red work and
does not claim support.

Literal family names resolve by exact canonical `engineFamily` and must match
one row. An unknown or ambiguous literal is a collection failure. Synthetic,
benchmark, parity, research, and exclusion rows never appear in a production
selector and are absent rather than reported skipped or not applicable.

## Partial-outline map

For production-varying outlines, `registered family` and `registered
production family` select `production`; native, web, plain, and mixed wording
select the corresponding trait. A literal family selects its one canonical
row. The two invariant outlines keep their engine-shaped values as fixture or
comparison data and execute each authored row once.

| Behavior                                           | Authored rows | Subject/applicability mapping                                               | Selected cases |
| -------------------------------------------------- | ------------: | --------------------------------------------------------------------------- | -------------: |
| `source.prepare-owned-content`                     |             8 | 2 native + 1 plain + 4 production + 1 mixed                                 |            274 |
| `run.localize-complete-scope`                      |            11 | 1 native + 1 web + 9 production                                             |            391 |
| `journey.localize-owned-release`                   |             5 | 1 native + 1 web + 3 production                                             |            157 |
| `play.control-reproducible-session`                |             9 | 1 native + 1 web + 5 production + 2 literal                                 |            237 |
| `play.explore-routes`                              |             2 | 1 native + 1 web                                                            |             40 |
| `play.observe-localized-surfaces`                  |            20 | 6 native + 1 web + 4 production + 9 literal                                 |            380 |
| `evidence.capture-runtime-observation`             |             7 | 1 native + 1 web + 5 production; producer class remains comparison evidence |            235 |
| `evidence.publish-safe-runtime-proof`              |             2 | shared; engine wording is publication-fixture data                          |              2 |
| `quality.untrusted-inputs-fail-without-harm`       |            12 | 12 production                                                               |            468 |
| `quality.output-completeness-is-reported`          |             3 | 3 production                                                                |            117 |
| `quality.same-inputs-reproduce-equivalent-results` |             6 | 1 native + 1 web + 4 production; `comparison_source` never changes subject  |            196 |
| `review.play-exact-patch`                          |             9 | 9 production                                                                |            351 |
| `export.download-played-patch`                     |             3 | 1 native + 1 web + 1 production                                             |             79 |
| `evaluation.compare-contestants`                   |            13 | shared; MAGES and production-family wording identify contestant archetypes  |             13 |
| **Partial-outline total**                          |       **110** |                                                                             |      **2,940** |

`native reference producer`, `comparison_source`, contestant identities, and
the deterministic mixed-family peer are comparisons for the selected subject.
They never create another cell or allow reference evidence to qualify a
production row.

## Exact executable count

The 460 authored rows outside the partial set contribute 272 shared cases and
188 exact canonical cases. The 15 invariant partial rows contribute one case
each. The complete expansion is:

```text
287 shared authored rows
+ 188 rows for four full-canonical outlines
+ (59 generic-production rows × 39 subjects)
+ (15 native rows × 35 subjects)
+ (8 web rows × 5 subjects)
+ (1 plain row × 9 subjects)
+ (1 mixed row × 39 subjects)
+ 11 literal-family rows
= 3,400 selected executable cases
```

Collection must report exactly 47 canonical rows, 39 production rows, 570
authored rows, 687 cells, and 3,400 selected cases. A changed trait membership,
generic/literal selector, partial-outline classification, or count is a
reviewed contract change. Zero matches, duplicate matches, a nonproduction
production match, a selected/executed mismatch, or any selected skip fails
collection.
