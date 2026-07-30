# Canonical source accounting

## Decision

The source universe is exactly **582 canonical capabilities**. Its authority is
the unique `c` identities in
[`docs/behaviors/source-inventory/*.jsonl`](../behaviors/source-inventory/).
Evidence observations, prose labels, behavior cells, and generated matrix rows
may be many-to-one or one-to-many views of that universe; none creates another
source total.

The source inventory and
[`docs/behaviors/capability-map/*.jsonl`](../behaviors/capability-map/) both
contain 582 unique identities. The catalog audit requires exact set equality,
source order, source state, and one mapping row per source identity. There are
no missing, duplicate, or extra identities.

## Exact current counts

| Subsystem     |   Total | `proven-real` | `proven-synthetic` | `built` | `asserted` | `intended` | `dropped` |
| ------------- | ------: | ------------: | -----------------: | ------: | ---------: | ---------: | --------: |
| decode        |     150 |            20 |                 35 |      51 |          3 |         41 |         0 |
| runtime       |      72 |             2 |                 16 |      40 |          1 |         13 |         0 |
| localization  |     109 |             0 |                 65 |      27 |          8 |          7 |         2 |
| quality       |      83 |             3 |                 24 |      35 |         15 |          5 |         1 |
| product       |      95 |             0 |                 34 |      26 |         11 |         21 |         3 |
| platform      |      73 |             0 |                 16 |      40 |          0 |          7 |        10 |
| **Canonical** | **582** |        **25** |            **190** | **219** |     **38** |     **94** |    **16** |

The behavior mapping preserves those source states and records exactly 188
`folded`, 190 `merged`, 146 `split`, and 58 `dropped` dispositions. Those 582
mapping rows reduce to 47 portable behaviors; the reduction does not change
source cardinality.

## Identity lineage

The earlier stable-name scope had 553 identities. The current lineage is:

```text
543 unchanged identities + 10 one-for-one neutral replacements
= 553 carried-scope identities
+ 29 appended intended decode-engine identities
= 582 canonical identities
```

The ten replacements preserve source order, meaning, acceptance boundary, and
`dropped` state while removing retired planning-control terminology. Their
current identities are:

```text
platform.retired-planning-control-plane
platform.retired-planning-state-import
platform.retired-audit-disposition-workflow
platform.retired-planning-state-export
platform.retired-roadmap-path-validator
platform.retired-milestone-reporting
platform.retired-planning-dashboard-provenance
platform.retired-issue-synchronization
platform.retired-planning-gate-reconciliation
platform.retired-planning-graph-validation
```

The 29 appended identities are all `decode` and all `intended`: 24 are
production targets, four are research-only, and one is an explicit exclusion:

```text
decode.engine.codex-rscript
decode.engine.malie
decode.engine.qlie
decode.engine.stuff-script-engine
decode.engine.artemis-engine
decode.engine.cmvs
decode.engine.kid-engine
decode.engine.nscripter
decode.engine.shiina-rio
decode.engine.system-nnn
decode.engine.adv-dx
decode.engine.adv32
decode.engine.alicesoft-system3-x
decode.engine.avgenginev2
decode.engine.catsystem3
decode.engine.ddsystem
decode.engine.fvp
decode.engine.g2
decode.engine.kaguya
decode.engine.livemaker
decode.engine.lucifen
decode.engine.musica
decode.engine.nitroplus-system-2
decode.engine.pix-studio
decode.engine.silky-engine
decode.engine.studio-seldom-adventure-system
decode.engine.willadv
decode.engine.xuse-engine
decode.engine.yeti-regista-engine
```

Before those 29 additions, the carried 553 identities had state counts of 25
`proven-real`, 190 `proven-synthetic`, 219 `built`, 38 `asserted`, 65
`intended`, and 16 `dropped`. Appending 29 `intended` rows yields the canonical
state table above.

## Why the historical totals were invalid

The historical **482** account combined unlike units: 192 state-word line
occurrences from the bytes/runtime grounding prose plus 290 named product
observations. The 192 included state-definition text and an incidental state
word; it was not a count of capability rows. The product observations were
valid evidence labels, but they had no canonical `c` identity column.

The historical **497** state buckets were likewise prose keyword frequencies,
not classifications of unique rows. A row-aware audit finds 185 bytes/runtime
capability observations and 290 product observation/crosswalk rows. Even their
475-row sum is an evidence-row count at mixed granularity, not a source
identity set, so it is not a candidate source total.

The apparent 15-row difference does not repair either account. Those 15
generated matrix observations are already included in the 185 bytes/runtime
rows and project onto only nine canonical source identities:

| Canonical source identity         | Included observations                                                                 | Rows | Current source state |
| --------------------------------- | ------------------------------------------------------------------------------------- | ---: | -------------------- |
| `decode.engine.fixture-reference` | synthetic fixture plaintext identity                                                  |    1 | `proven-synthetic`   |
| `decode.engine.tyranoscript`      | TyranoScript null-key readiness                                                       |    1 | `built`              |
| `decode.engine.kirikiri-kag-xp3`  | XP3 plain readiness; compressed readiness; encrypted crypt smoke; plain extract-patch |    4 | `built`              |
| `decode.engine.siglus`            | scene detector; known-key scene/Gameexe smoke                                         |    2 | `built`              |
| `decode.engine.rpg-maker-mv-mz`   | encrypted media; JSON extract-patch                                                   |    2 | `built`              |
| `decode.engine.wolf-rpg-editor`   | encrypted-archive smoke                                                               |    1 | `built`              |
| `decode.engine.bgi-ethornell`     | container readiness                                                                   |    1 | `built`              |
| `decode.engine.reallive`          | scene detector; accepted-output patchback-produce                                     |    2 | `built`              |
| `decode.engine.softpal`           | script/text extract-patch                                                             |    1 | `built`              |

The grounding labels remain useful evidence provenance. They add **zero**
source identities and cannot override a canonical source state.

## Hashes and executable enforcement

Identity hashes use lexicographically sorted IDs joined by `"\n"` with one
trailing newline:

| Identity set                     |    Rows | SHA-256                                                            |
| -------------------------------- | ------: | ------------------------------------------------------------------ |
| unchanged carryovers             |     543 | `8bcad008a0da0d7bb74641df9caae62002b1c843462bb555b179cc47b3a2cf1b` |
| neutral replacements             |      10 | `b35444541040185ae0ae7bc6eed9aec210b220a82a8cb4857b859381bbe4bef4` |
| carried scope after replacements |     553 | `9c9f55e21b731ef2a6aed1138aab5c761292ab690c8d5ceeb5ef142802233f8c` |
| appended intended identities     |      29 | `e0d2b22395f9497d1be3537588cfdbc51011ee695cb528356ce88784fa98403e` |
| **canonical source identities**  | **582** | `48777d244fafe26e8ba834ed6b456b1756217380ef6a4af17ef27b42a942bcb3` |

The stronger stable-JSON hash over every sorted source row and field is
`e2c30430ed92f2888e8b30b1f42d60ba6c72a33dc74e9ef63a5f89e303595535`.
[`scripts/audit-behavior-catalog-core.mjs`](../../scripts/audit-behavior-catalog-core.mjs)
pins that hash, the 582 total, all subsystem/state totals, the exact mapping,
and the disposition totals.

Run the authority checks with:

```sh
jq -r .c docs/behaviors/source-inventory/*.jsonl | LC_ALL=C sort | sha256sum
jq -r .c docs/behaviors/source-inventory/*.jsonl | wc -l
jq -r .c docs/behaviors/source-inventory/*.jsonl | LC_ALL=C sort | uniq -d
node scripts/audit-behavior-catalog.mjs
```

The first command must print the canonical identity hash, the second must print
582, the third must print nothing, and the catalog audit must pass. Any source
change must update the inventory, one-to-one mapping, derived human views, and
pinned counts/hashes in the same reviewed change.
