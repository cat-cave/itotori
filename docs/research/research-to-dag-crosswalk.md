# Research-to-DAG Crosswalk

**Status:** Current planning input. The executable source of truth remains
[`roadmap/spec-dag.json`](../../roadmap/spec-dag.json); this document only maps
historical research recommendations to live DAG node ids or marks them as not
adopted. It does not create product scope, reorder nodes, or replace the DAG.

**Last reviewed:** 2026-06-17 for `UNIV-015`.

Use this crosswalk when a research document proposes a node, says a capability
was not yet represented, or uses older milestone framing. Planning agents should
read the live DAG node before claiming work.

## Research Document Status

| Document                                                                                             | Planning status                          | Current use                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`engine-prioritization-and-roadmap-synthesis.md`](./engine-prioritization-and-roadmap-synthesis.md) | Historical evidence and proposal source  | Evidence for engine ordering, catalog/completeness requirements, and packed-engine readiness. Use this crosswalk for adopted node ids. |
| [`japanese-engine-opportunity-analysis.md`](./japanese-engine-opportunity-analysis.md)               | Historical evidence                      | VNDB-derived engine opportunity analysis. Current adapter/readiness scope lives in the DAG nodes mapped below.                         |
| [`erogamescape-vndb-unified-stats.md`](./erogamescape-vndb-unified-stats.md)                         | Historical evidence                      | EGS/VNDB catalog statistics and EGS-only candidate evidence. It is not a current adapter plan.                                         |
| [`research-engine-design.md`](./research-engine-design.md)                                           | Historical evidence and prototype design | The old `RESEARCH-*` proposal ids are superseded by `CATALOG-*`, Kaifuu, Itotori, and alpha nodes below.                               |

## Adopted Research Recommendations

| Historical recommendation                                                                                                                 | Live DAG mapping                                                                                                                                 | Status                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Promote catalog identity, source provenance, releases, local scans, and seed targets into typed product state.                            | `CATALOG-000`                                                                                                                                    | Adopted as catalog foundation.                                                                                             |
| Treat catalog identity as a full outer join where VNDB is not the root source.                                                            | `CATALOG-001`                                                                                                                                    | Adopted.                                                                                                                   |
| Model language completeness with official, fan, partial, MTL, interface-only, console-unverified, none, unknown, and conflict evidence.   | `CATALOG-002`                                                                                                                                    | Adopted.                                                                                                                   |
| Make MTL-only, fan-partial, no-English, and conflict sets usable as benchmark/opportunity pools.                                          | `CATALOG-002`, `CATALOG-004`, `ITOTORI-026`, `ALPHA-003`                                                                                         | Adopted across catalog and benchmark nodes.                                                                                |
| Promote the private local library scan into a redacted, public-safe local workflow.                                                       | `CATALOG-003`, `KAIFUU-053`                                                                                                                      | Adopted.                                                                                                                   |
| Select benchmark seeds from catalog completeness, local corpus evidence, and engine readiness rather than arbitrary fixture availability. | `CATALOG-004`, `ITOTORI-026`                                                                                                                     | Adopted.                                                                                                                   |
| Rank localization opportunities from prevalence, completeness, local ownership, readiness, and benchmark usefulness.                      | `CATALOG-061`                                                                                                                                    | Adopted for continuous expansion; alpha seed selection is in `CATALOG-004`.                                                |
| Promote VNDB, EGS, DLsite, Steam, IGDB, and Wikidata importers into a resumable crawler framework.                                        | `CATALOG-005`                                                                                                                                    | Adopted.                                                                                                                   |
| Represent editions, remasters, bundles, collection members, install states, platform releases, and translation parent/child links.        | `CATALOG-006`, `CATALOG-003`                                                                                                                     | Adopted.                                                                                                                   |
| Attach MV/MZ local corpus sidecar evidence after public adapter and scanner work exist.                                                   | `CATALOG-007`, `KAIFUU-007`, `KAIFUU-053`                                                                                                        | Adopted.                                                                                                                   |
| Recast text access as layered reversible transforms, with plaintext as identity container, null-key crypto, and identity codec.           | `KAIFUU-052`, `KAIFUU-014`, `KAIFUU-034`, `KAIFUU-050`, `KAIFUU-051`                                                                             | Adopted.                                                                                                                   |
| Emit engine readiness as capability levels rather than treating recognition as support.                                                   | `KAIFUU-053`, `KAIFUU-034`, `ALPHA-004`                                                                                                          | Adopted.                                                                                                                   |
| Keep RPG Maker MV/MZ as the first positive real-engine adapter and cover the full JSON surface, not a toy slice.                          | `KAIFUU-007`, `UTSUSHI-006`, `UTSUSHI-031`, `ALPHA-001`                                                                                          | Adopted.                                                                                                                   |
| Keep MV/MZ JSON text patching separate from encrypted media and asset-localization support.                                               | `KAIFUU-039`, `KAIFUU-068`, `KAIFUU-059`, `SHARED-011`, `ITOTORI-035`, `ITOTORI-041`                                                             | Adopted as separate proof/support nodes.                                                                                   |
| Replace plaintext-only KiriKiri assumptions with XP3/readiness/encryption profile work.                                                   | `KAIFUU-038`, `KAIFUU-054`, `KAIFUU-071`, `KAIFUU-072`, `KAIFUU-057`, `UTSUSHI-039`, `ALPHA-006`                                                 | Adopted. Plaintext KAG remains `KAIFUU-009`/`UTSUSHI-008` as a continuous null-container reference path.                   |
| Keep Ren'Py as low-priority reference work rather than a Japanese opportunity driver.                                                     | `KAIFUU-008`, `UTSUSHI-007`, `ALPHA-004`                                                                                                         | Adopted.                                                                                                                   |
| Add TyranoScript as a high-reach null-key/plaintext adapter.                                                                              | `KAIFUU-016`, `UTSUSHI-052`, `UTSUSHI-053`, `ALPHA-004`                                                                                          | Adopted.                                                                                                                   |
| Pull binary patching earlier because RGSS3/VX Ace, Wolf, Majiro, and BGI depend on it.                                                    | `KAIFUU-011`                                                                                                                                     | Adopted.                                                                                                                   |
| Treat RPG Maker VX Ace/RGSS3 as local-backlog readiness work before broad adapter claims.                                                 | `KAIFUU-055`, `KAIFUU-056`, `UTSUSHI-054`, `UTSUSHI-055`                                                                                         | Partially adopted. Current DAG has readiness/profile and runtime smoke work, not a production extraction/patching adapter. |
| Keep Wolf RPG roadmapped with packed/encrypted readiness before production support.                                                       | `KAIFUU-012`, `KAIFUU-040`, `KAIFUU-073`, `KAIFUU-058`, `UTSUSHI-043`, `UTSUSHI-044`, `UTSUSHI-045`                                              | Adopted.                                                                                                                   |
| Target BGI/Ethornell as small but high-value bytecode/string-table support.                                                               | `KAIFUU-013`, `KAIFUU-041`, `KAIFUU-080`, `UTSUSHI-046`, `UTSUSHI-047`, `UTSUSHI-048`                                                            | Adopted.                                                                                                                   |
| Represent Siglus as key-profile, parser proof, helper-boundary, and known-key smoke work before broad support.                            | `KAIFUU-015`, `KAIFUU-022`, `KAIFUU-069`, `KAIFUU-070`, `UTSUSHI-034`, `UTSUSHI-035`, `UTSUSHI-036`, `UTSUSHI-057`, `UTSUSHI-058`, `UTSUSHI-059` | Adopted.                                                                                                                   |
| Split Majiro and CatSystem2 proof/readiness work before adapters.                                                                         | `KAIFUU-017`, `KAIFUU-023`, `KAIFUU-024`, `KAIFUU-075`, `KAIFUU-076`, `KAIFUU-078`, `KAIFUU-079`                                                 | Adopted.                                                                                                                   |
| Treat Unity support as pattern-specific localization asset/readiness work rather than broad Unity support.                                | `KAIFUU-018`, `KAIFUU-025`, `KAIFUU-077`, `UTSUSHI-061`                                                                                          | Adopted.                                                                                                                   |
| Keep key discovery, helpers, secret refs, Wine/Windows execution, and private-local validation separate from pure adapters.               | `KAIFUU-014`, `KAIFUU-036`, `KAIFUU-037`, `KAIFUU-050`, `KAIFUU-064`, `KAIFUU-065`, `KAIFUU-066`, `KAIFUU-067`                                   | Adopted.                                                                                                                   |
| Use generated capability/readiness artifacts instead of hand-maintained breadth claims.                                                   | `ALPHA-004`, `KAIFUU-060`, `KAIFUU-063`, `ALPHA-005`                                                                                             | Adopted.                                                                                                                   |
| Frame alpha readiness around catalog, inventory, readiness, extraction, localization, patching, and validation.                           | `ALPHA-000`, `ALPHA-001`, `ALPHA-004`, `ALPHA-005`, `ALPHA-006`                                                                                  | Adopted.                                                                                                                   |

## Historical Proposal Ids

The research docs used temporary ids before the live DAG was expanded. Those ids
are not claimable.

| Historical proposal id                                                 | Current mapping                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `RESEARCH-000` Source adapter + raw cache contract                     | Superseded by `CATALOG-000` and `CATALOG-005`.                                                                                 |
| `RESEARCH-001` VNDB dump ingest + migrations                           | Superseded by `CATALOG-005` plus `CATALOG-000`; there is no VNDB-only claimable node.                                          |
| `RESEARCH-002` EGS SQL-endpoint adapter                                | Superseded by `CATALOG-005`.                                                                                                   |
| `RESEARCH-003` DLsite enrichment crawler                               | Superseded by `CATALOG-005`.                                                                                                   |
| `RESEARCH-004` Steam appdetails adapter                                | Superseded by `CATALOG-005`.                                                                                                   |
| `RESEARCH-005` Full-outer-join entity resolver                         | Superseded by `CATALOG-001`.                                                                                                   |
| `RESEARCH-006` Language-completeness model                             | Superseded by `CATALOG-002`.                                                                                                   |
| `RESEARCH-007` Local library scanner                                   | Superseded by `CATALOG-003`.                                                                                                   |
| `RESEARCH-008` Opportunity finders                                     | Split across `CATALOG-004` and `CATALOG-061`.                                                                                  |
| `RESEARCH-009` DLsite catalog discovery crawl                          | Deferred; no dedicated live node. Future discovery scope must be added to the DAG before implementation.                       |
| `RESEARCH-010` Stalled-TL deep signal                                  | Deferred as a standalone crawler/mining node; `CATALOG-002` records statuses and `CATALOG-061` can rank available evidence.    |
| `RESEARCH-011` Owned-library candidate finder                          | Local filesystem ownership is covered by `CATALOG-003`/`CATALOG-004`; authenticated Steam/DLsite ownership pulls are deferred. |
| `RESEARCH-012` Engine cross-feed to Kaifuu                             | Split across `CATALOG-004`, `CATALOG-061`, `KAIFUU-053`, and `ALPHA-004`.                                                      |
| `RESEARCH-013` Wikidata platform + cross-ID adapter                    | Superseded by `CATALOG-005` with resolver/platform modeling in `CATALOG-001` and `CATALOG-006`.                                |
| `RESEARCH-014` IGDB language_supports adapter                          | Superseded by `CATALOG-005` and `CATALOG-002`.                                                                                 |
| `RESEARCH-015` MobyGames console augmenter                             | Deferred; no dedicated live node. Current generic/console coverage is through IGDB/Wikidata-related catalog work.              |
| `RESEARCH-016` Platform-aware completeness                             | Superseded by `CATALOG-002` and `CATALOG-006`.                                                                                 |
| `CATALOG-000..012` placeholder range in synthesis                      | Superseded by live `CATALOG-000` through `CATALOG-007` and `CATALOG-061`.                                                      |
| `KAIFUU-Dnn`, `UTSUSHI-Cnn`, `SHARED-Cnn` placeholder ids in synthesis | Superseded by the concrete Kaifuu, Utsushi, Shared, Itotori, Catalog, and Alpha ids named in this crosswalk.                   |

## Not Adopted Or Deferred Items

These recommendations remain historical evidence only unless a future DAG edit
creates or updates a live node.

| Historical recommendation                                                        | Current state                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Dedicated MobyGames adapter/augmenter.                                           | Deferred; no live node.                                                                            |
| Dedicated DLsite catalog-discovery crawl independent of enrichment.              | Deferred; no live node beyond the generic crawler framework.                                       |
| Deep stalled-translation mining from release notes and fan-translation trackers. | Deferred; no live standalone node.                                                                 |
| Authenticated Steam owned-game API and DLsite purchase-history import.           | Deferred; local filesystem ownership is covered by `CATALOG-003`.                                  |
| Production RPG Maker VX Ace/RGSS3 extraction/patching adapter.                   | Deferred; readiness/profile and runtime smoke work are live, but production adapter scope is not.  |
| Dedicated NScripter/ONScripter adapter from the VNDB opportunity analysis.       | Deferred; no live node. Keep as historical opportunity evidence until a future DAG edit adopts it. |
| Broad Unity engine support.                                                      | Superseded by pattern-specific Unity asset/readiness nodes.                                        |
| Broad commercial KiriKiri support from plaintext KAG alone.                      | Superseded by XP3/readiness/encryption profile nodes.                                              |

## Wording Rules For Planning Agents

- Do not copy older release-stage labels from research documents into current
  planning docs. Use DAG targets such as `alpha`, `continuous`, and `baseline`.
- Treat historical claims about missing roadmap coverage as statements from the
  original publication date. Check this crosswalk and the live DAG before
  creating follow-up nodes.
- Do not claim support from engine detection alone. Current planning uses
  capability levels: identify, inventory, extract, and patch.
- Do not implement deferred items from this document without first adding or
  updating a live DAG node.
