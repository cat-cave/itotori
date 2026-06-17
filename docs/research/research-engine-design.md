# Cross-Source Localization Research Engine — Design & Roadmap Mapping

**Status:** Historical evidence and prototype design. The canonical executable
plan is `roadmap/spec-dag.json`; older milestone wording and `RESEARCH-*`
proposal ids here are preserved only as research context. Use
[`research-to-dag-crosswalk.md`](./research-to-dag-crosswalk.md) for current
live DAG mappings.

**Implementation note:** A temporary Python pipeline exists today under [`/research`](../../research)
and is producing real data. This document specifies the **full feature set** so the work
can be promoted into the monorepo as a first-class Rust subsystem (DB + migrations + core
schema) with proper DAG nodes. The Python pipeline is the prototype/oracle; the Rust
subsystem is the product.

**Goal.** Build one unified, entity-resolved catalog of Japanese games across VNDB, EGS,
DLsite, and Steam (extensible), with a precise per-language **completeness** model, so we
can rank **localization opportunities** — especially abandoned/partial/MTL translations and
high-demand titles missing from any single catalog — and feed Kaifuu's engine-adapter
priorities with evidence.

---

## 1. Sources and their roles (all access verified 2026-06-17)

| Source            | Access                                                             | Authoritative for                                                                                                                                                                | Notes                                                                                                |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **VNDB**          | nightly DB dump (zstd tar of COPY TSV)                             | engine, per-release **language + MTL/partial/trial/patch/official** flags, ratings, and extlinks (dlsite/steam/dmm/egs/getchu/…)                                                 | The spine. ~63.8k VNs, 150k releases. Already carries most join keys.                                |
| **EGS**           | public **SQL endpoint** (`sql_for_erogamer_form.php`, POST `sql=`) | broad catalog (esp. DLsite indie), **JP-audience median** score, `dlsite_id`                                                                                                     | ~34.8k games; no engine field. Ported in [`research/lib/sources.py`](../../research/lib/sources.py). |
| **DLsite**        | product-info AJAX (`/{domain}/product/info/ajax?product_id=`) JSON | sales (`dl_count`), **`work_type`** (RPG/ADV/…), ratings, age, **`translation_info`** tree (official language editions via `child_worknos`/`parent_workno`, community-MTL flags) | The official-translation graph lives here.                                                           |
| **Steam**         | storefront `appdetails`                                            | official **`supported_languages`**, type, release date                                                                                                                           | The "got an official EN that bypassed VNDB" signal.                                                  |
| **Local library** | filesystem scan                                                    | **owned** flag + **engine ground-truth** (file signatures) + discovery of source-only worknos/appids                                                                             | Solves engine inference and DLsite-only discovery at once.                                           |
| **Wikidata**      | REST/SPARQL (free, no auth)                                        | **platforms + cross-IDs** (IGDB, MobyGames, Steam, PlayStation Store, Nintendo eShop)                                                                                            | Already linked from VNDB (10.9k). Weak on supported-languages.                                       |
| **IGDB**          | v4 API (Twitch OAuth: client_id+secret)                            | **`language_supports`** (language × audio/subtitles/interface) across **all platforms incl. console**                                                                            | Authoritative official-language source; the console fix.                                             |
| **MobyGames**     | v1 API (key)                                                       | broad console/historical coverage, release regions                                                                                                                               | Augmenter for console titles.                                                                        |

**Why a generic/console tier (the 13 Sentinels case):** VN/eroge sources (VNDB/EGS/DLsite/
Steam) are PC-and-eroge-centric. A title like _13 Sentinels: Aegis Rim_ shipped **PS4/Switch
with official English and no PC store** — invisible to Steam/DLsite, and absent from VNDB —
so a naïve model false-flags it as an untranslated opportunity. Note VNDB _does_ carry
console data for games it lists (8,014 of its English releases are console-only across
`swi`/`ps4`/`psv`/`psp`/`nds`/…), so this tier only fills the **non-VNDB console gap**.

**Extensibility:** the same adapter shape (pull → normalize → cache) fits DMM/Fanza,
Getchu, Gyutto, Digiket, itch.io, Booth — all already present as VNDB extlink namespaces.

---

## 2. The core data model: a FULL OUTER JOIN

The earlier analyses were VNDB-anchored. That is wrong for discovery: **games exist on
DLsite (or Steam) and nowhere else** — confirmed by auditing a local library. The model
must be a full outer join where a _work_ may belong to any subset of sources, with **no
required anchor**.

- **Node** = `(source, source_id)` — e.g. `vn:v17`, `egs:12874`, `dl:RJ349517`, `st:333600`.
- **Edge** = a shared identity link (below). **Work** = a connected component (union-find).
- A node with zero edges is still its own work (the DLsite-only / Steam-only case).

**Edge sources (identity links):**

1. VNDB release/vn extlink → dlsite / steam / egs node (release→vn via `releases_vn`).
2. EGS `dlsite_id` → dlsite node.
3. DLsite `translation_info` → `parent_workno` / `child_worknos` / `original_workno`
   (same work, different **language edition** — must not be treated as separate works).
4. Discovery seeds (local library, future DLsite catalog crawl) introduce source-only nodes.
5. _(Future)_ fuzzy fallback: normalized title + brand + release-year for items with no
   shared id (needed for EGS↔DLsite indie with no VNDB cross-link).

**Current resolver output (VNDB+EGS complete; DLsite/Steam still enriching):** 71,701
works. Source-combination coverage already isolates the VNDB-missing pools —
**EGS-only 6,905**, **DLsite+EGS-not-VNDB 3,589**, plus VNDB-only 31,855. A pure
DLsite-only bucket appears only once a discovery seed (local library / catalog crawl)
introduces worknos absent from VNDB & EGS — by design.

---

## 3. Language-completeness model (the differentiator)

The point of the engine is not "is it translated" but **per (work, language): how complete,
by whom, and is it stalled.** Controlled vocabulary:

| status           | meaning                                                 | derived from                                                                       |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `official_full`  | complete official release in lang                       | Steam `supported_languages`; DLsite official child edition; VNDB official+complete |
| `fan_full`       | complete unofficial/fan release                         | VNDB non-official complete (`rtype=complete`, `mtl=0`)                             |
| `fan_partial`    | **incomplete human TL (the "70% then abandoned" case)** | VNDB `rtype=partial`, `mtl=0`                                                      |
| `mtl`            | machine translation only                                | VNDB `mtl=1`; DLsite `translation_info` community-MTL                              |
| `interface_only` | UI/menus only, not script                               | VNDB notes/patch heuristics (best-effort)                                          |
| `none`           | no release in lang                                      | absence across all sources                                                         |

Each (work, lang, status) carries **provenance** (which source/release asserted it) and a
**conflict flag** when sources disagree (e.g. VNDB says untranslated, Steam lists English →
an official EN VNDB hasn't catalogued: both a data-quality fix _and_ a benchmark candidate).

**Platform-aware official detection (console).** `official_full` must be derived from _any_
platform, not just PC stores: VNDB releases (platform-agnostic, already covers console VNs),
**IGDB `language_supports`** (console + PC), MobyGames, Steam, DLsite. A work whose only
platforms are console and which has no PC-store/VNDB coverage is marked
`unverified_console` (not `none`) until the generic tier confirms its languages — so the
finders never present a console-localized title as a clean opportunity. Record `platform`
on each edition (`release_platform`) so completeness can be reported per platform.

**Stalled detection (heuristic, v1):** `fan_partial` AND original released ≥ N years ago AND
VNDB devstatus ≠ in-development AND no newer release row → "abandoned partial". VNDB has no
numeric %, so v1 does not parse free-text percentages; a later node can mine release notes
and fan-TL trackers for explicit %/last-activity.

---

## 4. Discovery vs. Enrichment (architectural split)

- **Enrichment** = given an id, fetch its metadata (DLsite/Steam crawlers; resumable).
- **Discovery** = find ids we don't already have. Three discovery sources:
  1. **VNDB/EGS cross-references** (have today).
  2. **Local library scan** ([`research/scan_library.py`](../../research/scan_library.py)) —
     walks installed-game folders, extracts RJ/VJ codes + Steam appids, **and detects the
     engine from file signatures** (KiriKiri `*.xp3`, RPG Maker `*.rgss*a`/`www/`, Wolf
     `*.wolf`, Ren'Py `*.rpa`, Unity `*_Data/`, …). Writes `seed_target` (so crawlers
     enrich it) + `local_scan` (owned + engine ground-truth).
  3. **DLsite catalog crawl** (future node) — enumerate by `work_type`/genre/ranking to
     discover the indie RPG long tail systematically, independent of VNDB/EGS.

Engine ground-truth from (2) is the highest-confidence engine signal we can get and
directly closes the "engine unknown for EGS/DLsite-only pool" gap.

---

## 5. Opportunity finders (v1 outputs)

1. **Abandoned / partial / MTL finder** — works whose best English status is
   `fan_partial` (stalled), `mtl`, or `interface_only`, ranked by demand (VNDB votes + EGS
   median + DLsite `dl_count`). These are both opportunities and **benchmark targets**.
2. **Cross-source-only gems** — high EGS-median / high DLsite-`dl_count` works with **no
   VNDB entry and no official Steam EN**, i.e. the indie blind spot. Steam check prevents
   false positives (titles that quietly shipped an official EN).
3. **Owned-candidate finder** _(designed, deferred)_ — intersect `local_scan(owned=1)` with
   the opportunity set: "games you own that are strong, untranslated, and on a tractable
   engine." Mechanisms weighed below.

---

## 6. Deferred: "what games do I own" (mechanism options)

| Mechanism                                     | Yields                                         | Auth/effort                                     | Recommendation                          |
| --------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| **Local filesystem scan**                     | owned worknos/appids + **engine ground-truth** | none (already built)                            | **Primary.** Most signal, no auth.      |
| Steam `GetOwnedGames` Web API                 | full Steam library                             | Steam API key + SteamID; profile must be public | Add when Steam-owned candidates matter. |
| Steam local `appmanifest_*.acf`               | installed Steam appids                         | none                                            | Already handled by the scanner.         |
| DLsite purchase history / DLsite Play library | owned DLsite worknos                           | logged-in session (cookie)                      | Defer; needs auth handling + ToS care.  |

v1 ships the local scan; the Web-API/purchase-history paths become their own DAG nodes.

---

## 7. Resilience requirements (already met in prototype; mandatory in production)

- **Checkpoint every fetch** — presence in the raw cache == done; a crash at hour 3 loses
  nothing (prototype: `dlsite_raw`/`steam_raw` rows committed as fetched).
- **Definitive-vs-transient** — only retry true transient failures (timeout/5xx/429); record
  4xx/empty as done to avoid infinite re-fetch.
- **Polite rate limiting + backoff** — Steam `appdetails` 429-backoff; DLsite ~0.4s spacing.
- **Provenance + fetched_at** on every raw row (re-crawl/staleness later).
- Production adds: real **migrations**, incremental dump ingest, and a scheduler.

---

## 8. Production schema (Postgres) — promotion target

Mirror of the prototype SQLite, normalized for migrations:

```
source_raw(source, source_id, http_status, ok, payload JSONB, fetched_at)   -- unified raw cache
egs_game(...), vndb_vn(...), vndb_release(...), vndb_rel_lang(...),
vndb_rel_vn(...), vndb_extlink(...)                                          -- normalized source tables
work(work_id, canonical_title, engine, engine_source, olang, year)
work_source(work_id, source, source_id)                                     -- membership (outer join)
work_lang_status(work_id, lang, status, provenance, conflict)               -- completeness
seed_target(source, source_id, origin, added_at)                            -- discovery
local_scan(path, source, source_id, engine, signals, owned, scanned_at)     -- library + engine truth
```

`engine_source ∈ {local_scan, vndb, dlsite_worktype_inferred}` records confidence.

---

## 9. Historical proposed roadmap DAG nodes

This section preserves the original proposal table. The `RESEARCH-*` ids are
historical placeholders and are not claimable. The live DAG absorbed adopted
scope into `CATALOG-*`, Kaifuu, Itotori, Utsushi, Shared, and Alpha nodes; see
[`research-to-dag-crosswalk.md`](./research-to-dag-crosswalk.md).

| id           | title                                | pri    | dependsOn         | summary                                                                                                                  |
| ------------ | ------------------------------------ | ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| RESEARCH-000 | Source adapter + raw cache contract  | P2     | UNIV-000          | Unified `source_raw` JSONB cache; adapter trait (pull→normalize→cache); resumable/idempotent.                            |
| RESEARCH-001 | VNDB dump ingest + migrations        | P2     | RESEARCH-000      | Nightly dump fetch/decompress/load into normalized tables; engine+lang+mtl+rtype+extlinks.                               |
| RESEARCH-002 | EGS SQL-endpoint adapter             | P2     | RESEARCH-000      | Port `egs_query`; load gamelist incrementally; JP median/votes/dlsite_id.                                                |
| RESEARCH-003 | DLsite enrichment crawler            | P2     | RESEARCH-000      | Resumable per-workno AJAX pull; sales, work_type, translation_info tree.                                                 |
| RESEARCH-004 | Steam appdetails adapter             | P2     | RESEARCH-000      | supported_languages + type; 429-backoff.                                                                                 |
| RESEARCH-005 | **Full-outer-join entity resolver**  | **P1** | 001-004           | Union-find over all source nodes incl. DLsite translation tree; source-only works first-class.                           |
| RESEARCH-006 | Language-completeness model          | P1     | RESEARCH-005      | Per-(work,lang) status vocabulary + provenance + cross-source conflict flags.                                            |
| RESEARCH-007 | Local library scanner                | P2     | RESEARCH-005      | Discovery seeds + engine ground-truth from file signatures + owned flag.                                                 |
| RESEARCH-008 | Opportunity finders                  | P2     | RESEARCH-006      | Abandoned/partial/MTL + cross-source-only gems; demand ranking; export.                                                  |
| RESEARCH-009 | DLsite catalog discovery crawl       | P3     | RESEARCH-003      | Enumerate indie RPG long tail by work_type/ranking, independent of VNDB/EGS.                                             |
| RESEARCH-010 | Stalled-TL deep signal               | P3     | RESEARCH-006      | Mine release notes / fan-TL trackers for explicit %-complete & last-activity.                                            |
| RESEARCH-011 | Owned-library candidate finder       | P3     | RESEARCH-007, 008 | Steam GetOwnedGames / DLsite purchases; intersect with opportunity set.                                                  |
| RESEARCH-012 | Engine cross-feed to Kaifuu          | P2     | RESEARCH-006, 007 | Feed engine prevalence × completeness gap into Kaifuu adapter prioritization.                                            |
| RESEARCH-013 | Wikidata platform + cross-ID adapter | P2     | RESEARCH-005      | Free/no-auth: platforms + cross-IDs (IGDB/MobyGames/Steam/PS/eShop); flags console-only; strengthens dedup.              |
| RESEARCH-014 | IGDB language_supports adapter       | P2     | RESEARCH-006, 013 | Twitch-OAuth; authoritative official languages across console+PC; resolves console-only official EN (13 Sentinels case). |
| RESEARCH-015 | MobyGames console augmenter          | P3     | RESEARCH-013      | Broaden console/historical coverage and release-region data.                                                             |
| RESEARCH-016 | Platform-aware completeness          | P1     | RESEARCH-006, 014 | `release_platform` + `unverified_console`; per-platform official detection; remove console false positives.              |

`RESEARCH-005` (resolver) and `RESEARCH-006` (completeness) were the load-bearing
proposal ids. They are now superseded by `CATALOG-001` and `CATALOG-002`;
adapter, finder, and discovery scope is mapped in the crosswalk.

---

## 10. Prototype → Rust mapping

| Prototype (Python)                           | Promotes to                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `research/lib/store.py`                      | migrations + `work`/`work_source`/`work_lang_status` schema (RESEARCH-000/001) |
| `research/lib/sources.py`                    | source adapter crate (RESEARCH-002/003/004)                                    |
| `research/load_vndb.py`                      | VNDB ingest job (RESEARCH-001)                                                 |
| `research/crawl_dlsite.py`, `crawl_steam.py` | resumable enrichment workers (RESEARCH-003/004)                                |
| `research/crawl_wikidata.py`                 | Wikidata platform + cross-ID adapter (RESEARCH-013)                            |
| `research/crawl_igdb.py`                     | IGDB language_supports adapter (RESEARCH-014)                                  |
| `research/build_works.py`                    | resolver service (RESEARCH-005)                                                |
| `research/scan_library.py`                   | local scanner CLI + engine fingerprint table (RESEARCH-007)                    |
| `research/finders.py`                        | opportunity queries/exports (RESEARCH-008)                                     |

---

## 11. Caveats / open questions

- EGS↔DLsite indie with **no** VNDB cross-link needs the fuzzy-title fallback (RESEARCH-005
  follow-up) to merge correctly; until then such pairs may double-count as separate works.
- DLsite `translation_info` covers **official** DLsite translations; fan patches still come
  from VNDB. Interface-only detection is heuristic until RESEARCH-010.
- VNDB engine attribution is null for ~53% of JP VNs; local-scan ground-truth and DLsite
  `work_type` are the way to fill it for the indie pool.
- Rate-limit/ToS posture for DLsite/Steam/EGS at scale must be reviewed before the catalog
  discovery crawl (RESEARCH-009) and any authenticated owned-library pull (RESEARCH-011).
- **Console gap (partly closed):** Wikidata + IGDB adapters are built. IGDB resolves
  official languages incl. console deterministically via the **Steam-appid bridge** (6.9k
  games; lifted `official_full` and exposed 689 VNDB-vs-store conflicts). The remaining gap
  is **console-only works with Japanese-only titles and no Steam id** (e.g. 13 Sentinels =
  十三機兵防衛圏): neither the Steam bridge nor the English-title bridge links them. Closing
  it needs the **fuzzy/Wikidata-search bridge on the JP title** (RESEARCH-005 follow-up /
  RESEARCH-016); meanwhile any specific title resolves on demand via `crawl_igdb.py --names`.
- IGDB `external_games` filters by `external_game_source` (Steam=1); the older `category`
  enum no longer filters — worth carrying into the Rust adapter.
