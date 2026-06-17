# Japanese VN/RPG Engine & Untranslated-Game Opportunity Analysis

**Purpose:** Reframe Kaifuu adapter priorities using real catalog data rather than
reputation. The point of this analysis is _opportunity discovery_ — it deliberately
challenges the current MVP/roadmap ordering where the evidence warrants.

**Primary data source (confirmed, quantitative):** Official VNDB database dump
`vndb-db-2026-06-17.tar.zst` (full public dump, downloaded 2026-06-17 from
<https://dl.vndb.org/dump/>; schema per <https://vndb.org/d14>). All engine counts,
localization-status splits, and candidate lists below are computed directly from that
dump's `vn`, `releases`, `releases_vn` (rtype), `releases_titles` (per-language `mtl`
flag), and `engines` tables. This is authoritative, not a web-search guess.

**Secondary data source (qualitative, verified):** A fan-out web-research pass over
tooling repos and wikis (VNTranslationTools/VNTextPatch, RPGMTL, GARbro, arc*unpacker,
Wolf Trans, KrkrExtract, KirikiriTools, thewiki.moe, SteamDB FileDetectionRuleSets,
Translator++ docs), with adversarial verification. Used only for engine \_format /
encryption / tooling* facts, cited inline.

### Method & definitions

- **Scope:** Japanese-origin VNs only (`vn.olang = 'ja'`), 36,946 entries. Engine is
  taken from a VN's releases (most common non-patch engine). 17,236 have a known engine;
  19,710 have none recorded (mostly older/console titles) — so engine-level tables cover
  the ~47% with an attributable engine.
- **EN localization status per VN** (from its EN releases):
  - `UNTRANSLATED` — no English release at all
  - `MTL_ONLY` — every English release is flagged machine-translation (`releases_titles.mtl`)
  - `PARTIAL` — has a non-MTL English release but only `rtype = partial` (incomplete)
  - `TL_FAN` — has a complete, non-official, non-MTL English release (fan patch)
  - `TL_OFFICIAL` — has a complete official English release
- **"Opportunity"** = `UNTRANSLATED + MTL_ONLY + PARTIAL` (+ trial-only) — i.e. no
  complete human English exists. These are also **benchmark targets**: MTL-only and
  partial games already have reference text to evaluate Kaifuu output against.
- Ratings shown 0–10 (`c_rating/100`); votecount = `c_votecount`.

### Source-bias caveats (read before trusting any single number)

1. **VNDB catalogs _visual novels_, not RPGs.** The huge DLsite RPG-Maker/Wolf doujin
   _eroge_ market is almost entirely absent here. RPG Maker (535) and Wolf RPG (170)
   are therefore **massively undercounted** — their true opportunity is large but lives
   in DLsite data, which we have **not** yet pulled (see §7, recommended next step).
2. **VNDB skews toward catalogued/indie/English-facing VNs**, inflating Ren'Py globally.
   Restricting to `olang='ja'` (as done here) corrects most of this.
3. The MTL/partial/engine fields are community-maintained and incomplete; absolute
   counts are lower bounds. Engine attribution is null for ~53% of JP VNs.

---

## 1. Engine prevalence & the English-localization gap (Japanese-origin VNs)

Per-VN (not per-release), engine known. `gap%` = share with no complete human EN.

| Rank | Engine               | JP VNs | Untransl. | MTL-only | Partial | Fan-TL | Official | **Gap %** |
| ---: | -------------------- | -----: | --------: | -------: | ------: | -----: | -------: | --------: |
|    1 | **KiriKiri**         |   4046 |      3200 |      335 |      34 |    361 |      111 |   **88%** |
|    2 | **TyranoScript**     |   3430 |      3203 |       63 |       8 |    144 |        7 |   **96%** |
|    3 | **LiveMaker**        |   1337 |      1278 |       32 |       0 |     27 |        0 |   **98%** |
|    4 | **NScripter**        |   1264 |      1167 |        8 |       4 |     78 |        4 |   **94%** |
|    5 | Unity                |    594 |       262 |       37 |       9 |    242 |       43 |       52% |
|    6 | RPG Maker¹           |    535 |       412 |       23 |       9 |     71 |       18 |       83% |
|    7 | YU-RIS               |    483 |       360 |       58 |       0 |     35 |       29 |       87% |
|    8 | Ren'Py               |    307 |        90 |       20 |      11 |    153 |       29 |       41% |
|    9 | Flash Player         |    245 |       205 |        2 |       1 |     37 |        0 |       85% |
|   10 | Artemis Engine       |    219 |       106 |       32 |       3 |     57 |       21 |       64% |
|   11 | Macromedia Director  |    196 |       187 |        0 |       0 |      6 |        3 |       95% |
|   12 | **Wolf RPG Editor**¹ |    170 |       157 |        0 |       0 |     10 |        2 |       93% |
|   13 | Shiina Rio           |    160 |       136 |       17 |       0 |      4 |        3 |       96% |
|   14 | Majiro               |    120 |        97 |        9 |       3 |      6 |        5 |       91% |
|   15 | RealLive             |    117 |       100 |       11 |       0 |      3 |        0 |       97% |
|   16 | System-NNN           |    109 |        97 |        2 |       0 |      2 |        8 |       91% |
|    — | BGI/Ethornell        |     91 |        37 |        7 |       4 |     20 |       22 |       54% |
|    — | CatSystem2           |     82 |        48 |       14 |       2 |     13 |        4 |       79% |
|    — | SiglusEngine         |     79 |        48 |       11 |       2 |     18 |        0 |       77% |

¹ RPG Maker / Wolf are undercounted — DLsite doujin RPGs are not in VNDB (see caveat 1).

**Overall JP-origin opportunity sizing:**

- 36,946 JP-origin VNs total → **32,061 (86.8%) fully untranslated**, 1,365 (3.7%)
  MTL-only, 212 (0.6%) partial. **Only 8.8% have any complete human EN (fan + official).**
- **Total opportunity (no complete human EN): 33,693 VNs = 91.2%.**

### Key correction to the "surface" finding

A naïve "most common VN engine" query returns **Ren'Py** (~23k titles globally). That is
an artifact of Western/English doujin output. **Among Japanese-origin VNs, Ren'Py is only
8th (307 titles) and is already 59% translated.** The real Japanese-content leaders are
**KiriKiri, TyranoScript, LiveMaker, NScripter** — and they are 88–98% untranslated.

---

## 2. Where localization tooling matters most (the deep, untouched backlog)

The single most decision-relevant table. **Tooling-maturity proxy** = already-translated
rate (`(fan+official)/total`). A _low_ rate on a _high-volume_ engine = large backlog the
community has barely touched = highest leverage for a new tool.

| Engine            | JP VNs | Already TL'd | **TL rate** | Read as                                   |
| ----------------- | -----: | -----------: | ----------: | ----------------------------------------- |
| **TyranoScript**  |   3430 |          151 |      **4%** | huge + almost untouched                   |
| **LiveMaker**     |   1337 |           27 |      **2%** | huge + almost untouched                   |
| **NScripter**     |   1264 |           82 |      **6%** | huge + barely touched                     |
| **KiriKiri**      |   4046 |          472 |     **12%** | biggest pool; still 88% open              |
| RPG Maker¹        |    535 |           89 |         17% | (VNDB subset only)                        |
| YU-RIS            |    483 |           64 |         13% | mid-volume, open                          |
| CatSystem2        |     82 |           17 |         21% | franchise-heavy (Koihime)                 |
| Artemis Engine    |    219 |           78 |         36% | partly served                             |
| **BGI/Ethornell** |     91 |           42 |     **46%** | small but _high-value_, well-served       |
| Unity             |    594 |          285 |         48% | served via runtime hooks, not reinsertion |
| **Ren'Py**        |    307 |          182 |     **59%** | already easy + already done               |

**Interpretation (inferred from the proxy):**

- **Ren'Py, Unity, BGI/Ethornell, Artemis** already have high translation rates → mature
  tooling and/or motivated translators. A new tool adds _less_ marginal value here.
- **TyranoScript, LiveMaker, NScripter, KiriKiri** have low rates on large volumes →
  this is where Kaifuu can unlock content nobody else is reaching. **KiriKiri** combines
  the largest absolute backlog (3,569 untranslated/MTL/partial) with proven-but-gated
  tooling; **TyranoScript** is the biggest _greenfield_ (3,274 open, only 4% touched).

---

## 3. Engine text-extraction difficulty (for Kaifuu adapter cost)

Difficulty = f(storage format, encoding, encryption/compilation, archive, tooling
maturity). Format/encryption facts are **[confirmed]** from cited tooling/wikis; the
empirical TL-rate from §2 corroborates tractability.

| Engine                   | Script storage                                   | Encoding    | Archive / encryption                            | Mature reinsert tooling?                                                                 | **Verdict**                           |
| ------------------------ | ------------------------------------------------ | ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| **Ren'Py**               | `.rpy` plaintext (+ `.rpyc`)                     | UTF-8       | `.rpa` (trivial unpack)                         | Native + VNTextPatch + RPGMTL                                                            | **Easy**                              |
| **RPG Maker MV/MZ**      | JSON                                             | UTF-8       | assets may be encrypted; **text is plain JSON** | RPGMTL, Translator++, RPGMaker Trans                                                     | **Easy**                              |
| **TyranoScript**         | `.ks`/`.ksx` plaintext (HTML5/JS)                | UTF-8       | usually unpacked `data/`; opt. `.ts`            | Plaintext-simple, but **no dominant dedicated reinserter**                               | **Easy–Moderate (greenfield)**        |
| **Wolf RPG**             | binary data/event tables                         | Shift-JIS   | opt. `.wolf` archive                            | Wolf Trans (extract+reinsert, needs unpacked)                                            | **Moderate**                          |
| **RPG Maker VX/VXAce**   | Ruby Marshal `.rvdata2`                          | UTF-8       | RGSSAD `.rgss*a`                                | RPGMTL, RPGMaker Trans                                                                   | **Moderate**                          |
| **NScripter/ONScripter** | `nscript.dat` (simple XOR 0x84)                  | Shift-JIS   | `arc.nsa`/`.sar`                                | nsdec + ONScripter tools; partial VNTextPatch                                            | **Moderate**                          |
| **LiveMaker**            | `.lsb` compiled bytecode                         | Shift-JIS   | exe-embedded archive                            | **pylivemaker** (real extract+reinsert)                                                  | **Moderate**                          |
| **Artemis**              | `.ast`/`.asb`                                    | UTF-8/SJIS  | `.pfs`                                          | VNTextPatch (Artemis), GARbro                                                            | **Moderate**                          |
| **YU-RIS**               | `.ybn` compiled                                  | Shift-JIS   | `.ypf` (sometimes keyed)                        | VNTextPatch + RPGMTL (YPF/YBN), GARbro                                                   | **Moderate–Hard**                     |
| **CatSystem2**           | `.cst` compiled (opt. Blowfish)                  | Shift-JIS   | `.int`                                          | VNTextPatch (CatSystem2), GARbro, asmodean                                               | **Moderate–Hard**                     |
| **KiriKiri/KAG**         | `.ks`/`.tjs` (often scrambled)                   | SJIS/UTF-16 | **XP3, frequently per-game encrypted**          | KrkrExtract, KirikiriTools (`version.dll`), GARbro, arc_unpacker, VNTextPatch            | **Easy unpacked / Hard encrypted**    |
| **Majiro**               | `.mjo` opcode-XOR bytecode                       | Shift-JIS   | `.arc`                                          | VNTextPatch (Majiro), GARbro                                                             | **Hard**                              |
| **BGI/Ethornell**        | extensionless compiled `_bp` bytecode            | Shift-JIS   | `arc*`                                          | VNTextPatch (BGI), asmodean exfiles                                                      | **Hard** (but high community success) |
| **SiglusEngine**         | `Scene.pck` compiled + encrypted                 | UTF-16      | encrypted pack + `Gameexe`                      | SiglusExtract, GARbro                                                                    | **Hard**                              |
| **Unity**                | `Assembly-CSharp` / MonoBehaviour / AssetBundles | UTF-8/16    | varies; no standard text layer                  | AssetStudio/UnityEX (extract); **XUnity.AutoTranslator = runtime hook, not reinsertion** | **Hard / non-uniform**                |

Sources for this table: VNTranslationTools/VNTextPatch README
(<https://github.com/arcusmaximus/VNTranslationTools>), RPGMTL
(<https://github.com/MizaGBF/RPGMTL>), Wolf Trans
(<https://github.com/elizagamedev/wolftrans>), GARbro (<https://github.com/morkt/GARbro>),
arc_unpacker (<https://github.com/vn-tools/arc_unpacker>), KrkrExtract
(<https://github.com/xmoezzz/KrkrExtract>), KirikiriTools
(<https://github.com/arcusmaximus/KirikiriTools>), thewiki.moe
(<https://thewiki.moe/tutorials/visualnovels/>).

**The decisive nuance for KiriKiri:** the engine splits into _plaintext `.ks`_ (Easy —
what the current MVP scopes) and _encrypted XP3_ (Hard — most **commercial** titles).
KirikiriTools' `version.dll` trick lets the engine accept unencrypted XP3 without
reversing per-game keys [confirmed], but extracting the original encrypted archive still
needs key discovery. So a plaintext-only KiriKiri adapter mostly reaches the **doujin /
unpacked** subset; the commercial backlog needs the encryption boundary (Kaifuu
KAIFUU-014 / 038) landed alongside it.

---

## 4. Concrete candidate games (confirmed engine from VNDB unless noted)

All engines below are **[CONFIRMED]** — taken from VNDB release metadata in the dump,
not inferred. Ratings 0–10, votes in parentheses.

### 4a. Most-wanted untranslated (highest popularity) — pure opportunities

| VN                                           | Engine        | Rating (votes) |
| -------------------------------------------- | ------------- | -------------- |
| Bishoujo Mangekyou Ibun – Yuki Onna (v44184) | QLIE          | 7.35 (228)     |
| Omoide Kakaete Ai ni Koi!! (v31125)          | BGI/Ethornell | 7.64 (190)     |
| Houkago Cinderella 2 (v36131)                | BGI/Ethornell | 7.72 (181)     |
| Hajimeru Sekai no Risouron (v47458)          | YU-RIS        | 7.55 (155)     |
| Ore no Hitomi de Maruhadaka! (v44098)        | KiriKiri      | 7.12 (150)     |
| Kyokkou no Marriage (v49512)                 | Unity         | 7.93 (145)     |
| AMBITIOUS MISSION After Episode 1 (v42712)   | KiriKiri      | 7.41 (143)     |
| Jewelry Nights Arcadia (v50416)              | BGI/Ethornell | 7.88 (139)     |

### 4b. High-rated untranslated "hidden gems" (rating ≥ 7.5, votes ≥ 80)

| VN                                                 | Engine                | Rating (votes) |
| -------------------------------------------------- | --------------------- | -------------- |
| Chou no Doku Hana no Kusari ~Gensou Yawa~ (v11134) | _(engine unrecorded)_ | 8.04 (104)     |
| Kyokkou no Marriage (v49512)                       | Unity                 | 7.93 (145)     |
| Jewelry Nights Arcadia (v50416)                    | BGI/Ethornell         | 7.88 (139)     |
| Houkago Cinderella 2 (v36131)                      | BGI/Ethornell         | 7.72 (181)     |
| Role player (v54509)                               | KiriKiri              | 7.71 (81)      |
| Momiji to One Room (v31177)                        | Softpal ADV           | 7.63 (86)      |
| Waga Himegimi ni Eikan o (v32165)                  | Whale                 | 7.56 (107)     |

### 4c. MTL-only — **benchmark targets** (machine TL exists to score Kaifuu against)

| VN                               | Engine   | Rating (votes) |
| -------------------------------- | -------- | -------------- |
| LimeLight Lemonade Jam (v56650)  | KiriKiri | 8.12 (548)     |
| AMBITIOUS MISSION (v33036)       | KiriKiri | 8.03 (469)     |
| Jewelry Hearts Academia (v33175) | NeXAS    | 8.12 (374)     |
| Amakano 3 (v50215)               | Artemis  | 8.21 (310)     |
| BLACK SHEEP TOWN (v21069)        | Unity    | 8.72 (177)     |
| Same to Ikiru Nanokakan (v37716) | KiriKiri | 7.67 (226)     |

### 4d. Partial human TL — **finish/benchmark candidates**

| VN                         | Engine                | Rating (votes) |
| -------------------------- | --------------------- | -------------- |
| Your Turn To Die (v25931)  | **RPG Maker**         | 8.22 (1393)    |
| Jiangshi x Daoshi (v20538) | KiriKiri              | 7.67 (148)     |
| Custom Reido V (v7044)     | KiriKiri              | 7.15 (147)     |
| Morenatsu (v6487)          | Ren'Py                | 7.65 (134)     |
| ghostpia (v32274)          | O2 Engine/novelsphere | 7.92 (95)      |

### 4e. Per-engine top untranslated (for the engines Kaifuu may adopt)

- **KiriKiri:** AMBITIOUS MISSION After Ep.1 (v42712, 7.41/143), Koibana Ren'ai mini FD
  (v49227, 110), Mecha-con! (v5932, 101), Yume Kui (v2965, 85).
- **CatSystem2 (Koihime franchise cluster):** Makai Tenshi Djibril 4 (v3307, 7.28/110),
  Girls Be Ambitious! (v12435, 84), Sengoku † Koihime EX 2/3 (v31819/v31820), multiple
  Shin Koihime Eiyuutan entries — a whole untranslated franchise on one engine.
- **SiglusEngine:** Prima Doll: Winter Sky Fireworks (v29761, 7.32/56), Prima Doll:
  Ceremony of the Unknown (v49954, 7.53/33). _(Siglus = Key/VisualArts; prestige but
  encrypted Scene.pck.)_
- **BGI/Ethornell:** the highest-popularity untranslated cluster (Omoide Kakaete 190,
  Houkago Cinderella 2 181, Jewelry Nights Arcadia 139) — small engine, high-value games.
- **TyranoScript:** large but low per-title popularity (top untranslated ~15–42 votes,
  e.g. NO SALVATION v34509 7.71/42) — breadth play, not marquee titles.
- **RPG Maker (VNDB subset):** mostly low-vote eroge; the real volume is on DLsite.

---

## 5. DLsite / metadata engine-inference feasibility

**Yes — engine is reliably inferable** from product files and metadata, via documented
signals [confirmed: Translator++ docs <https://dreamsavior.net/docs/translator/how-to/identify-a-game-engine/>;
SteamDB FileDetectionRuleSets
<https://github.com/SteamDatabase/FileDetectionRuleSets>]:

| Signal                                                                                                                                    | Reliability              | Notes                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| Packaged-archive extension (`data.xp3`+`krflash.dll`→KiriKiri; `.rgss*a`→RPG Maker; `.ypf`→YU-RIS; `.int`→CatSystem2; `Scene.pck`→Siglus) | **High** (spoofable)     | Strongest single signal; extensions can be renamed (OMORI's `.KEL`)   |
| Folder/file structure + exe icon                                                                                                          | High                     | Each engine has a recognizable layout                                 |
| exe description / license string                                                                                                          | Medium–High              | KiriKiri/NScripter leave fingerprints                                 |
| **VNDB cross-link** (DLsite RJ-code → VNDB release → `engine` field)                                                                      | **Highest when present** | Confirmed engine; this dump already provides it for catalogued titles |
| Store tags / descriptions / reviews                                                                                                       | Low                      | Rarely state engine; unreliable                                       |

**Practical pipeline:** for a DLsite RJ product, first try VNDB cross-link (authoritative
`engine`); if uncatalogued, infer from trial-download file structure + archive extensions.
Trials are usually built on the same engine as the full product → reliable for inference.

---

## 6. Recommendation: reframed Kaifuu adapter priority

This **diverges from the current frozen MVP set and post-MVP order** where the data
justifies it. Ranking axis = _untranslated-JP value × tractability for Kaifuu_.

**Tier 0 — keep, but re-scope (MVP):**

- **KiriKiri/KAG — strongly validated as #1 by volume** (4,046 JP VNs, 3,569 open).
  **But:** scope the adapter to land _with_ the XP3 encryption/key-discovery boundary
  (KAIFUU-014/038), or it only reaches the doujin/unpacked subset and misses the
  commercial backlog that makes KiriKiri valuable. This is the single most important
  re-scope.
- **RPG Maker MV/MZ (JSON)** — keep; Easy and it is the _only_ MVP engine addressing the
  RPG side. **But its value is invisible in VNDB** — validate/size it against **DLsite**
  before over- or under-investing (§7).
- **Ren'Py** — keep as the easy reference adapter and for Western indie, **but reset
  expectations:** it contributes little _untranslated-JP_ value (307 JP VNs, already 59%
  done). It proves the pipeline; it is not an opportunity engine.

**Tier 1 — promote (data says these are under-weighted):**

- **TyranoScript** — _the biggest reframe._ #2 JP VN engine (3,430), **96% untranslated,
  only 4% ever touched**, and **plaintext `.ks`/`.ksx` (HTML5/JS) → Easy**, reusing most
  of the KiriKiri-KAG plaintext machinery. It is the largest greenfield in the catalog
  yet is absent from the MVP/early roadmap. **Recommend adding it as an early adapter.**
- **NScripter/ONScripter** — 1,264 JP VNs, 94% open, Moderate (simple XOR + Shift-JIS),
  mature open ecosystem. High volume, low effort.

**Tier 2 — high-value, targeted (small pools, prestige/popularity per title):**

- **BGI/Ethornell** — only 91 JP VNs but the _highest-popularity untranslated cluster_;
  46% already done proves the format is cracked. Hard (compiled) but VNTextPatch covers
  it. Good for marquee targets.
- **CatSystem2** — unlocks the large untranslated **Koihime** franchise on one adapter.
- **Wolf RPG** — keep roadmapped; real volume is on DLsite, not VNDB.

**Tier 3 — defer / encryption-gated:**

- **SiglusEngine** (Key/VisualArts prestige but encrypted Scene.pck), **Majiro**,
  **YU-RIS**, **LiveMaker** (huge volume but compiled `.lsb`; pylivemaker exists so
  revisit), **Unity** (no uniform text layer; community solves it with _runtime
  auto-translation hooks_, a different paradigm than extract/reinsert — note this before
  committing adapter effort).

**Net change vs. current roadmap:** validate KiriKiri-first (✓) but bind it to the
encryption boundary; **insert TyranoScript and NScripter ahead of the binary-format
engines** (they are high-volume and plaintext/simple, matching Kaifuu's plaintext-first
architecture); treat Ren'Py as a reference/Western play, not a JP-opportunity engine;
and **resolve the RPG-Maker/Wolf question with DLsite data** rather than VNDB.

---

## 7. Recommended next analysis (the biggest blind spot)

VNDB does **not** catalog the DLsite doujin RPG-Maker/Wolf _eroge_ market — likely the
single largest untranslated, tooling-relevant pool, and exactly where the easy
(JSON/plaintext) engines dominate. Pull **DLsite** structured data (product/maniax JSON
API + per-RJ metadata; engine inferable per §5) and run the same prevalence × gap
analysis. Expect it to substantially raise RPG Maker MV/MZ and Wolf RPG in the priority
order — potentially validating the current RPG-Maker MVP pick on _different_ evidence
than VNDB provides.

### Open questions / limitations

- 53% of JP VNs have no engine recorded in VNDB — true per-engine counts are lower bounds.
- "Interface-patch-only" releases can't be cleanly separated from `PARTIAL` in the dump;
  treated together.
- ErogameScape (adult/JP-skewed) was not queried; it would likely raise SiglusEngine,
  BGI/Ethornell, Majiro, CatSystem2 relative to their VNDB ranks.
- Popularity (votecount) skews toward titles with existing fan interest; deep-catalog
  untranslated titles may be undervalued by votes.

---

_Reproducibility:_ dump downloaded with `curl https://dl.vndb.org/dump/vndb-db-2026-06-17.tar.zst`,
decompressed via Node `zlib.createZstdDecompress`; aggregation scripts in `/tmp/vndb/`
(`analyze.py`, `extract.py`, `maturity.py`). Re-run against the daily dump to refresh.
