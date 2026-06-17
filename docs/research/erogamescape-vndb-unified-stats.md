# ErogameScape × VNDB — Unified Statistics

**Status:** Historical evidence. This document is a dated statistical input from
2026-06-17, not a current adapter or roadmap plan. Use
[`research-to-dag-crosswalk.md`](./research-to-dag-crosswalk.md) for current
live DAG mappings.

**Purpose:** Add ErogameScape (EGS) as a second statistical front and join it to VNDB, so
we have one combined catalog. EGS covers many games VNDB doesn't — especially the DLsite
indie/doujin-RPG side — and contributes a Japanese-audience score that complements VNDB's
ratings. Companion to [`japanese-engine-opportunity-analysis.md`](./japanese-engine-opportunity-analysis.md).

**Data pulled 2026-06-17.** EGS catalog via EGS's public SQL endpoint; VNDB via the
`2026-06-17` dump. Scripts in [`scripts/`](./scripts/).

## How EGS access works (ported logic)

EGS (エロゲー批評空間) exposes a **public SQL query endpoint** — you POST a raw `SELECT`
and it returns an HTML results table. This is the mechanism used by
[`fabon-f/erogamescape.rb`](https://github.com/fabon-f/erogamescape.rb); the per-game
field semantics come from [`roronya/erogamescape`](https://github.com/roronya/erogamescape)
(which scrapes `game.php`). We ported the SQL approach to stdlib Python in
[`scripts/egs.py`](./scripts/egs.py):

```
POST https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php
body: sql=<SELECT ...>      # parse the #query_result_main <table>
```

The endpoint accepts arbitrary read-only SQL over the EGS Postgres DB (tables `gamelist`,
`brandlist`, `pov`, …). Row cap observed ≈ 3,000/query, so the catalog is pulled in id
ranges ([`scripts/pull.py`](./scripts/pull.py)). **Be polite** — it's a small community
server; we throttle 1 req/s.

### Relevant `gamelist` columns

`id, gamename, brandname` (→`brandlist.id`), `sellday`, **`median`** (headline EGS score,
0–100), `average2`, `stdev`, **`count2`** (vote count), `max2/min2`, **`dlsite_id` +
`dlsite_domain`** (the DLsite RJ join key), `dmm`, `gyutto_id`, `digiket`, `erogame`,
`okazu`, `model`, `total_play_time_median`, `trial_url`. **There is no engine column** —
EGS does not track engine. That is the division of labor: VNDB owns engine + EN-TL-status;
EGS owns catalog breadth + JP-audience score; DLsite RJ code is the bridge.

## The join

EGS cross-links in VNDB live on **releases**, not VNs:
`releases_extlinks → extlinks(site='egs') → EGS game id`, then `releases_vn` back to the
VN. Builder: [`scripts/build_vndb_egs_map.py`](./scripts/build_vndb_egs_map.py).

## Catalog overlap

|                                                |                     Count |
| ---------------------------------------------- | ------------------------: |
| EGS total games                                |                **34,838** |
| — linked to a VNDB release                     |                    23,723 |
| — **EGS-only (no VNDB link)**                  |                **11,115** |
| VNDB VNs total                                 | 63,770 (JP-origin 36,946) |
| EGS games carrying a `dlsite_id`               |                **15,786** |
| — also in VNDB                                 |                    11,576 |
| — **EGS-only (DLsite indie pool VNDB misses)** |                 **4,210** |

**EGS-only pool (11,115):** 9,503 have an EGS score, **4,210 have a DLsite RJ code** —
and that DLsite slice is overwhelmingly **doujin/adult-indie**: `maniax` 3,350, `pro` 436,
`home` 316, `soft` 53. This is precisely the indie/RPG market VNDB does not catalog, and
where RPG Maker / Wolf RPG dominate. (Year skew: ~250–330/yr for 2020–2025; a handful of
bogus `2050` dates are an EGS data-entry artifact.)

## EGS cross-validates the VNDB engine ranking

For JP VNs linked to EGS, the per-engine **median EGS score** (independent JP audience):

| Engine            | n scored | median EGS |
| ----------------- | -------: | ---------: |
| KiriKiri          |    3,260 |         65 |
| NScripter         |      706 |         64 |
| TyranoScript      |      679 |         65 |
| YU-RIS            |      487 |         70 |
| Unity             |      452 |         73 |
| LiveMaker         |      363 |         60 |
| Artemis           |      300 |         70 |
| **BGI/Ethornell** |      179 |     **76** |
| Majiro            |      140 |         70 |
| Ren'Py            |      209 |         68 |

Two confirmations of the prior report: (1) the **volume leaders are the same** (KiriKiri ≫
NScripter/TyranoScript), independently from a Japanese-audience source; (2) **BGI/Ethornell
scores highest** — corroborating that it's a small-but-high-value engine worth targeted
support despite being "Hard."

## What EGS adds: candidates invisible to / underweighted by VNDB

### A. Top EGS-only DLsite games (no VNDB entry) by JP score, votes ≥ 20

These need **DLsite engine inference** (neither source has engine) — but EGS gives the RJ
code + JP audience to prioritize which to inspect. Many are RPG Maker / Wolf doujin RPGs.

| EGS med | votes | RJ code    | domain | Title (likely engine — **INFERRED**)                           |
| ------: | ----: | ---------- | ------ | -------------------------------------------------------------- |
|      90 |  2323 | RJVJ001889 | pro    | 家族計画 ～絆箱～ (Kazoku Keikaku)                             |
|      90 |   275 | RJ349517   | maniax | **Demons Roots** (_INFERRED RPG Maker_)                        |
|      89 |    80 | RJ237469   | maniax | **BLACKSOULS II** (_INFERRED RPG Maker_)                       |
|      88 |    76 | RJVJ011519 | soft   | Symphonic Rain HD Edition                                      |
|      86 |    42 | RJVJ014719 | pro    | VenusBlood HOLLOW International                                |
|      84 |   185 | RJ190251   | maniax | **King Exit** (_INFERRED RPG Maker/Wolf_)                      |
|      83 |    41 | RJ297120   | maniax | **Magical Girl Celesphonia** (_INFERRED RPG Maker_)            |
|      82 |   335 | RJVJ009934 | pro    | Inganock (赫炎のインガノック) Full                             |
|      81 |    32 | RJ054932   | home   | **Recettear ルセッティア** (_INFERRED — known custom/RPG-ish_) |
|      80 |    90 | RJ203687   | maniax | **BLACKSOULS** (_INFERRED RPG Maker_)                          |

201 EGS-only DLsite games clear score-with-votes≥20; full list via
[`scripts/onlypool.py`](./scripts/onlypool.py).

### B. High-JP-audience untranslated VNs (linked, engine confirmed) that VNDB votecount underweighted

EGS surfaces large-JP-audience titles that rank lower on VNDB's (Western) votecount.
Engines are **CONFIRMED** from VNDB; UNTRANSLATED status is from VNDB releases and may lag
recent fan work — verify before acting.

| EGS med | votes | Engine           | Title                                        |
| ------: | ----: | ---------------- | -------------------------------------------- |
|      90 |  2518 | NeXAS            | Kono Aozora ni Yakusoku o                    |
|      88 |  1747 | KiriKiri         | ChuSinGura 46+1 (series)                     |
|      86 |  1948 | AliceSoft System | Ultra Mahou Shoujo Manana vol.1              |
|      85 |  1723 | Artemis          | Otome Riron to Sono Shuuhen (Ecole de Paris) |
|      85 |  1381 | Silky Engine     | Hikari no Umi no Apeiria                     |
|      85 |   693 | Xuse Engine      | Saihate no Ima                               |
|      85 |   468 | NeXAS            | BALDR HEART                                  |

## Takeaways for the unified front

1. **EGS adds ~11k games VNDB lacks, ~4.2k of them DLsite RJ-coded doujin/indie** — the
   RPG Maker/Wolf market the VNDB analysis was structurally blind to. This is the "cleaning
   things up" win: EGS is the right second source for indie/DLsite coverage.
2. **Engine is the missing column in both sources for the EGS-only pool.** EGS gives the RJ
   code; the next step is **DLsite file/trial inference** (per §5 of the engine report) to
   stamp engines on these 4,210 games — likely confirming RPG Maker MV/MZ + Wolf as the
   dominant indie engines and re-validating those early priorities on indie evidence.
3. **EGS median is a second, Japanese-audience ranking signal** — use it alongside VNDB
   votes so we don't underweight titles big in Japan but quiet in the West (e.g. _Kono
   Aozora ni Yakusoku o_, _ChuSinGura_).
4. **Unified schema proposal:** keep a join table keyed by `egs_id ⇄ vndb_release ⇄ vndb_vn
⇄ dlsite_rj`, with columns `{engine (VNDB), en_tl_status (VNDB), vndb_rating/votes,
egs_median/votes, dlsite_id, dlsite_domain}`. EGS-only rows carry null engine/TL until
   DLsite inference fills them.

### Caveats

- EGS skews adult/Japanese (median scores and catalog reflect eroge); it under-covers
  all-ages/Western VNs that VNDB covers well — the two are complementary, not redundant.
- 23,821 EGS ids are linked in the VNDB dump but 23,723 resolve to a pulled EGS game (≈100
  point to ids outside the catalog pull / deleted entries).
- EGS `median` requires enough votes to be meaningful; we filter `count2` thresholds in
  candidate lists. UNTRANSLATED status is VNDB-derived and may lag.
- Engine guesses for EGS-only DLsite titles are **INFERRED** from reputation/known facts,
  not confirmed — flagged inline. Confirm via DLsite product files.
