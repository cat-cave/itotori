# Canonical cell subjects

[`docs/behaviors/engine-families.jsonl`](../behaviors/engine-families.jsonl) is
the only engine-row authority. This roadmap does not copy its names into
another registry. Each row's stable `sourceCapability` is the cell suffix and
the semantic issue-spec suffix.

## Audited subject sets

| Subject set                      | Selection rule                                                    | Rows | Use                                                                                 |
| -------------------------------- | ----------------------------------------------------------------- | ---: | ----------------------------------------------------------------------------------- |
| Canonical engines                | every row in the authority                                        |   47 | the four varying behaviors whose Gherkin declares an outcome for every role         |
| Production targets               | `supportRole` is `production-target`                              |   39 | the twelve varying behaviors whose scenarios require a registered production family |
| Registered or bounded production | production target with a registered or bounded production profile |   15 | five completion bundles per family                                                  |
| Unqualified production           | production target with an unqualified target profile              |   24 | six completion bundles per family                                                   |
| Non-production                   | every non-production role                                         |    8 | one bounded-role conformance bundle per row                                         |

The eight non-production rows are one synthetic reference, one benchmark
reference, one parity reference, four research roles, and one explicit
exclusion. They receive only cells for canonical Gherkin outcomes. There is no
automatic safe-refusal cell for behaviors whose scenarios do not select those
roles.

## Discovery identity reconciliation

The action plan's former discovery total had no identity-bearing manifest
behind it. It originated as a detector-scale hypothesis, so treating it as a
second registry would require inventing identities. The committed 47-row
authority is therefore the exact discovery set:

```text
18 harvested family/reference rows
+ 24 additional production-target rows
+ 4 additional research-only rows
+ 1 additional explicit-exclusion row
= 47 canonical rows
```

The 24 production additions are the rows for `decode.engine.codex-rscript`,
`decode.engine.malie`, `decode.engine.qlie`,
`decode.engine.stuff-script-engine`, `decode.engine.cmvs`,
`decode.engine.kid-engine`, `decode.engine.adv-dx`, `decode.engine.adv32`,
`decode.engine.alicesoft-system3-x`, `decode.engine.avgenginev2`,
`decode.engine.catsystem3`, `decode.engine.ddsystem`, `decode.engine.fvp`,
`decode.engine.g2`, `decode.engine.kaguya`, `decode.engine.lucifen`,
`decode.engine.musica`, `decode.engine.nitroplus-system-2`,
`decode.engine.pix-studio`, `decode.engine.silky-engine`,
`decode.engine.studio-seldom-adventure-system`, `decode.engine.willadv`,
`decode.engine.xuse-engine`, and `decode.engine.yeti-regista-engine`.
The additions do not borrow support from the first 15 production rows.

Every name relationship is closed as follows:

| Discovery wording                              | Canonical decision                                                                           | Cell consequence                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SiglusEngine                                   | alias of Siglus                                                                              | owned by `cell::support.qualify-profile::decode.engine.siglus`                                                                                                                                                |
| Softpal ADV, Softpal ADV System, Sv20, Pal.dll | family, executable, and signature spellings under Softpal                                    | owned by `cell::support.qualify-profile::decode.engine.softpal`                                                                                                                                               |
| Wolf, Udita                                    | aliases of Wolf RPG Editor                                                                   | owned by `cell::support.qualify-profile::decode.engine.wolf-rpg-editor`                                                                                                                                       |
| BGI, Ethornell, Buriko General Interpreter     | aliases of one BGI/Ethornell identity                                                        | owned by `cell::support.qualify-profile::decode.engine.bgi-ethornell`                                                                                                                                         |
| VX Ace, RGSS3                                  | generation/runtime spellings for one row                                                     | owned by `cell::support.qualify-profile::decode.engine.rpg-maker-vx-ace-rgss3`                                                                                                                                |
| MV, MZ                                         | two mandatory generation profiles under one row                                              | both must pass `cell::support.qualify-profile::decode.engine.rpg-maker-mv-mz`                                                                                                                                 |
| KiriKiri, KiriKiri Z, KAG, XP3                 | KiriKiri is the family, KAG the script layer, and XP3 the container/profile axis             | loose/plain and at least two distinct encrypted profiles aggregate under `cell::support.qualify-profile::decode.engine.kirikiri-kag-xp3`                                                                      |
| Unity I2, Naninovel                            | two independent bounded product identities                                                   | each uses its own canonical qualification cell; evidence is not interchangeable                                                                                                                               |
| generic Unity emulation                        | explicit product-scope exclusion, not a third Unity row                                      | it can satisfy neither bounded Unity cell                                                                                                                                                                     |
| registered storage profiles                    | material profiles of the applicable bounded Unity row, not family identities                 | every registered member aggregates under that row's qualification cell                                                                                                                                        |
| NScripter, ONScripter                          | one excluded family identity                                                                 | only `cell::support.qualify-profile::decode.engine.nscripter` may prove the exclusion                                                                                                                         |
| fixture/reference                              | synthetic conformance identity only                                                          | never enters the production denominator                                                                                                                                                                       |
| MAGES benchmark reference                      | comparison identity only                                                                     | never enters the production denominator                                                                                                                                                                       |
| RPG Maker 95, 2000, 2003, XP, VX               | concrete legacy-generation profiles assigned to the existing XP qualification/migration cell | `cell::support.qualify-profile::runtime.engine.rpg-maker-xp-parity-reference` remains red until every registered generation has two-title production evidence; its old parity receipt remains comparison-only |

The four additional canonical research rows are Artemis Engine, LiveMaker,
Shiina Rio, and System-NNN. YU-RIS, Aoi, Flash, and Director are research leads,
not executable suite subjects: no harvested source capability or bounded
catalog outcome identifies them. That is an explicit scope exclusion, not an
unresolved identity and not permission to infer support.

## Profile-varying acceptance

The canonical authority currently carries broad labels such as registered,
bounded, research, and unqualified profile. Those labels are not executable
profile identities. The implementation already shows narrower material axes:
container and generation variants, encryption schemes, key/helper
requirements, field inventories, runtime transports, snapshot shapes, and byte
versus semantic comparators.

A profile-varying cell therefore has this form:

```text
cell::<behavior>::<canonical sourceCapability>
```

It is green only when every concrete material profile registered for that
family executes every applicable positive and negative case. One passing
profile cannot represent its siblings. An as-yet unobserved concrete profile is
not a new cell or an unowned unknown: it is a failing selected member of that
family's qualification cell until adapter-owned inventory classifies and
executes it. Generic labels and prose research cannot increase the denominator.

## Role-specific green outcomes

- A production-target cell may report a positive content or runtime operation
  only after two independently sourced lawful titles satisfy the same public
  assertions through the private proof in [`real-bytes.md`](real-bytes.md).
- The synthetic reference proves portable contracts on redistributable
  authored input only.
- Benchmark and parity references prove their declared comparison boundary,
  never product support.
- A research row passes only the explicit bounded research outcome declared by
  one of the four canonical behaviors.
- The exclusion row passes only when those same boundaries disclose and
  enforce exclusion with no effects.
- Detection, delegation, a placeholder, an empty selection, or a successful
  process exit never grants a downstream operation.

An intended production operation stays red until positive evidence exists.
Correctly reporting its current absence can pass a negative case but cannot
turn the production cell green.
