# Engine Prioritization & Roadmap Synthesis

**Written:** 2026-06-17 (interim — enrichment crawl still running; market/VNDB/EGS data is final)

This is the capstone report. It fuses three evidence streams into one set of
recommendations for **what engines to prioritize, what capabilities to build, and what
to add to the monorepo (itotori / kaifuu / utsushi / shared)** — including **proposed**
DAG nodes and roadmap adjustments.

> **Note:** No `roadmap/spec-dag.json` edits are made here. All DAG nodes below are
> _proposals_ for after the research phase closes, per the standing rule.

The three streams:

1. **Broad market** — VNDB + ErogameScape (final): what's prevalent and untranslated.
   See [`japanese-engine-opportunity-analysis.md`](./japanese-engine-opportunity-analysis.md),
   [`erogamescape-vndb-unified-stats.md`](./erogamescape-vndb-unified-stats.md).
2. **Cross-source catalog** — the research engine (VNDB+EGS+DLsite+Steam+IGDB+Wikidata,
   full outer join + completeness model). See [`research-engine-design.md`](./research-engine-design.md).
3. **Local backlog** — the private corpus on this machine (packed/encrypted reality).
   See `.tmp/kaifuu-local-translation-corpus-summary.md`.

---

## 1. Executive read

The three streams **disagree on what's _prevalent_ but agree on what to _build first_**.

- The market's biggest untranslated VN pools are **KiriKiri (4,046)** and **TyranoScript
  (3,430)** — but KiriKiri is XP3-**packed/encrypted** (a readiness problem, not a
  plaintext win), and TyranoScript, while plaintext, is absent from the local backlog.
- The local backlog and the DLsite indie market are **RPG-Maker-dominated** —
  MV/MZ (plaintext JSON) plus RGSS3/VX Ace (Ruby Marshal, packed).
- **RPG Maker MV/MZ is the one engine all three streams endorse as the first positive
  adapter**: tractable (plaintext JSON), large in the indie/DLsite market, the single
  most-represented family in the local corpus, and it still exercises real complexity
  (encrypted media, plugin text, collections, DLsite-only identity).

The deeper conclusion (both the local report and the cross-source data reach it
independently): **the product is not "a translator." It is a catalog + inventory +
engine-detection + readiness + translation-completeness intelligence system, with
extraction/patch adapters layered on top.** 91% of Japanese-origin VNs are untranslated,
but the _actionable_ value is in precisely classifying engine, encryption/readiness, and
**how complete any existing translation is** — including the abandoned and MTL-only cases.

---

## 2. Data foundation & status

| Stream                                   | State                               | Confidence                          |
| ---------------------------------------- | ----------------------------------- | ----------------------------------- |
| VNDB engine × localization-gap           | complete (full dump)                | high                                |
| EGS cross-validation + DLsite-indie pool | complete                            | high                                |
| Full-outer-join resolver (72,088 works)  | complete                            | high                                |
| Completeness model (EN) + 689 conflicts  | complete for VNDB/Steam/IGDB-linked | medium (sharpens as crawl finishes) |
| DLsite enrichment                        | ~6.5k/22.3k done                    | provisional                         |
| Steam enrichment                         | ~1.1k/10.4k done                    | provisional                         |
| IGDB language_supports                   | 6,929 games (5,900 list English)    | good for Steam-linked               |
| Local corpus                             | 30 top-level + 5 members, sidecar'd | high (ground truth)                 |

**Live completeness rollup (works):** `none` 35,573 · `fan_full` 16,455 ·
`fan_partial` 3,980 · `mtl` 1,272 · `official_full` 4,032 · `unknown` 10,776 ·
**conflicts 689** (VNDB says gap, Steam/DLsite/IGDB show official EN).

---

## 3. Engine prioritization (synthesized)

Ranked by **(local-backlog weight + market untranslated value) ÷ adapter tractability**,
with each engine's _type of work_ (positive adapter vs readiness/encryption profile).

| Tier  | Engine                                                | Market (JP VNs / gap)                | Local backlog                 | Tractability                            | **Build as**                                       |
| ----- | ----------------------------------------------------- | ------------------------------------ | ----------------------------- | --------------------------------------- | -------------------------------------------------- |
| **1** | **RPG Maker MV/MZ**                                   | indie/DLsite-huge (VNDB undercounts) | **heaviest** (10+ titles)     | Easy (plaintext JSON)                   | **Positive adapter — first**                       |
| **2** | **RPG Maker VX Ace / RGSS3**                          | large indie                          | **heavy** (ROBF/Re:BF family) | Moderate (Ruby Marshal in RGSSAD)       | Positive adapter (needs binary-patcher core)       |
| **3** | **KiriKiri/KAG**                                      | **4,046 / 88%** (#1 VN pool)         | present (XP3)                 | Easy plaintext / **Hard encrypted XP3** | **Readiness+encryption profile first**, then patch |
| **4** | **TyranoScript**                                      | **3,430 / 96%** (greenfield)         | absent                        | Easy (plaintext .ks/.ksx)               | Positive adapter (cheap; high VN reach)            |
| **5** | **Unity (Naninovel/AssetBundle)**                     | mid (rising)                         | present (4 titles)            | Hard / profile-specific                 | Profile-specific readiness+inventory               |
| **6** | **SiglusEngine**                                      | high prestige (Key/VA)               | present (2 titles)            | Hard (encrypted Scene.pck)              | Readiness + key profile                            |
| **7** | **Wolf RPG**                                          | DLsite-indie-large                   | present                       | Moderate (packed)                       | Positive adapter (after binary core)               |
| **8** | **NScripter / RealLive / NeXAS / Aoi / Majiro / BGI** | long tail                            | scattered                     | Moderate–Hard                           | Readiness profiles; targeted adapters              |
| **—** | **Ren'Py**                                            | 307 JP / 41% (already done)          | **absent**                    | Easy                                    | Keep as reference only; **low JP value**           |

**Reframes vs. the current MVP set:**

- **RPG Maker MV/MZ → unambiguous #1** (all three streams agree). Already MVP; this
  _strengthens_ it and says invest in the full MV/MZ surface (events/db/UI/plugins +
  encrypted-media gating + collections), not a toy slice.
- **KiriKiri MVP scope is wrong as "plaintext-only."** Both local KiriKiri titles are
  XP3-packed; commercial KiriKiri is encrypted. Rescope to **readiness + XP3/encryption**
  (bind to the key-discovery boundary) — plaintext-only reaches almost none of the 4,046.
- **Ren'Py is over-weighted in the MVP.** Near-zero local backlog, 41% already translated,
  307 JP VNs. Keep it as the easy reference adapter; do not expect JP opportunity from it.
- **TyranoScript is under-weighted.** Biggest plaintext greenfield in the market; cheap to
  add; missing from MVP and roadmap. Propose promoting.
- **RGSS3/VX Ace is under-weighted relative to the _local_ backlog** (ROBF/Re:BF). Its
  binary-patcher dependency should be pulled earlier than a pure VN-market view implies.

---

## 3a. Architectural correction: plaintext is the null-key special case

"Plaintext-first" is the wrong framing. **Text access is a pipeline of reversible
transforms, applied per text-bearing surface:**

```
locate surface → unpack container → decrypt → decompile/decode → normalized text → patch back
```

There are three distinct transform layers — **container/archive** (XP3, RGSSAD, PFS,
AssetBundle, DAT…), **encryption/obfuscation** (null, XOR-0x84, per-game key, Blowfish…),
and **codec** (plaintext SJIS/UTF, JSON, Ruby Marshal, compiled bytecode). **Plaintext =
all three layers set to identity** (no container, null key, identity codec). So plaintext
must be a _configuration_ of the general pipeline, not a separate adapter architecture;
building plaintext adapters first and adding encryption later is a guaranteed re-architecture.

Per-surface matters: RPG Maker MV/MZ has **plaintext text (JSON) but encrypted media** — the
text path is null-key even when the asset path isn't.

**Pool consequence:** surfaces reachable with no container/crypto work are essentially only
Ren'Py `.rpy`, TyranoScript `.ks`, and MV/MZ text JSON — and Ren'Py is low-JP-value /
already 59% translated. Everything else in the ~17k engine-known JP VN universe (KiriKiri
4,046, Siglus, BGI, Majiro, CatSystem2, NScripter, LiveMaker, RealLive, YU-RIS, Wolf, RGSS)
is packed/compiled/encrypted. The local corpus says it directly: _"not a plaintext-fixture
world."_ **Skipping encrypted ≈ skipping the pool.** Therefore the **container + key-profile
model belongs in the core adapter contract from day one**; plaintext engines populate it
with identities.

## 3b. Change classification: modify vs. net-new vs. reprioritize

**Modify (reshape existing):** (1) recast per-engine "plaintext adapter" nodes as configs
of one layered access pipeline; modify the adapter trait / GameProfile to carry
container + key-profile fields. (2) KiriKiri scope plaintext→XP3+encryption. (3) detection
emits capability levels (identify/inventory/extract/patch) + container/crypto facts, not
just an engine name. (4) consume VNDB's existing mtl/partial/official flags in prioritization.

**Net-new (absent from roadmap):** (1) **layered decryption/container framework +
key-profile model** (Kaifuu); (2) **catalog/cross-source research engine** as an Itotori
subsystem; (3) **translation-completeness intelligence** (status + conflict detection +
benchmark-set construction); (4) **engine detector registry** (capability-leveled);
(5) **readiness profiles** as a deliverable type; (6) **local corpus inventory + sidecar
writer**; (7) **console/generic DB tier** (IGDB/Wikidata); (8) **archive/install-state +
edition mapping**; (9) **benchmark-vs-existing-TL harness** (Utsushi).

**Reprioritize (reorder existing):** (1) pull encryption/key-discovery (KAIFUU-014) +
binary-patcher core (KAIFUU-011) into the MVP — they gate the pool; (2) MV/MZ stays #1 via
the full pipeline; (3) RGSS3/VX Ace earlier (local backlog); (4) Ren'Py → reference adapter;
(5) TyranoScript added early (null-key config); (6) KiriKiri high but on the encryption track.

**Single highest-leverage item:** build the layered pipeline with a key-profile model _now_
so every encrypted engine is an incremental decryptor stage, not a rebuild.

## 4. Capabilities needed (beyond per-engine adapters)

The local corpus and the cross-source data both say the same thing: adapters are
necessary but not sufficient. The core capabilities:

1. **Catalog identity / entity resolution (full outer join).** One canonical "work"
   across VNDB/EGS/DLsite/DMM/Steam/IGDB/Wikidata/local — keyed by external IDs, with a
   fuzzy/Wikidata fallback. **Catalog identity must not depend on VNDB** (DLsite-only and
   console-only works exist; 3,589 DLsite-in-EGS-not-VNDB; 6,905 EGS-only).
2. **Engine detector registry** with capability levels `identify / inventory / extract /
patch` — so a recognized-but-packed engine is never presented as usable. (Local report
   §"Engine Detector Registry" is the seed.)
3. **Local corpus inventory + sidecar writer** — read-only scan → stable IDs + engine
   ground-truth + owned flag + redacted sidecars. (Built in prototype: `scan_library.py`.)
4. **Translation-completeness model** — per-(work, language) status `official_full /
fan_full / fan_partial / mtl / interface_only / unverified_console / none`, with
   provenance and **cross-source conflict detection** (the 689). This is the engine for
   _opportunity ranking_ and _benchmark-set construction_, and it is **absent from the
   current roadmap**.
5. **Readiness profiles for packed/encrypted engines** (Siglus / KiriKiri XP3 / NeXAS PAC /
   RGSS / Unity bundles / Aoi VFS / RealLive Seen) — classify container/version/key
   readiness _before_ extraction; never leak keys/raw text.
6. **Encryption / key-discovery boundary** — local-only key helpers + redaction; gates the
   high-value commercial pools (KiriKiri XP3, Siglus, RPG Maker encrypted assets).
7. **Edition mapping** — HD/remaster/fandisc/bundle rows differ; DLsite `translation_info`
   parent/child + VNDB releases model this. Essential for **translation porting**.
8. **Archive / install-state handling** — ZIP/RAR/7z/ISO/self-extractor, collection
   members (Daydreamer-style), "not installed vs installed member vs source archive."
9. **Console / generic-DB tier** — IGDB `language_supports` (+ Wikidata cross-IDs) so
   console-only official localizations don't read as untranslated.
10. **Resilient crawler framework** — resumable, single-writer-safe, rate-limited, with
    provenance/`fetched_at`. (Prototype: per-source checkpointing + sequential supervisor.)
11. **Benchmark / validation harness** — owned-game golden manifests; benchmark output
    against existing fan/MTL/partial translations (the `mtl` 1,272 and `fan_partial` 3,980
    sets are ready-made benchmark corpora); privacy-safe (no raw text in public artifacts).

---

## 5. Core technologies to add, by subproject

**Kaifuu (extraction / patch / engine):**

- Engine **detector registry** (capability-leveled) — shared fingerprints with the local
  scanner.
- **RPG Maker MV/MZ positive adapter** (full surface) — first.
- **Binary-patcher core** → RGSS3/VX Ace (Ruby Marshal), then Wolf, Majiro, BGI.
- **Encryption / key-profile boundary** (XP3, Siglus Scene.pck, RPG Maker encrypted assets).
- **Readiness profiles** for packed engines (identify/inventory only until round-trip proven).
- **Edition/collection model** + archive/install-state helpers.

**Itotori (orchestration / suite) — host the catalog/research engine:**

- Source adapters: VNDB dump, EGS SQL, DLsite AJAX, Steam appdetails, IGDB, Wikidata
  (prototyped in `research/`).
- **Full-outer-join entity resolver** + external-ID registry + fuzzy/Wikidata fallback.
- **Translation-completeness model** + conflict detection + **opportunity finders**.
- Local **corpus scanner + sidecar writer** + redacted report renderer.
- Resilient crawler framework + scheduler.

**Utsushi (translation / rendering) — consume completeness intelligence:**

- **Edition-aware translation porting** (HD/remaster/fandisc; uses edition mapping +
  DLsite translation tree).
- **Benchmark harness vs existing TLs** — score against `mtl`/`fan_partial`/official sets;
  the 689 conflicts and 1,272 MTL-only works are immediate evaluation corpora.
- **Partial-TL completion targeting** — drive work from the `fan_partial` (3,980) backlog.

**Shared / monorepo:**

- Unified **catalog schema + migrations**: `work / work_source / work_lang_status /
generic_game / release_platform / local_scan / seed_target` (prototype SQLite → Postgres).
- **External-ID + provenance + conflict** model (repeatable records, not one column/source).
- Shared **engine-fingerprint registry** used by both Kaifuu (local scan) and Itotori
  (catalog), so engine ground-truth has one source of truth.

---

## 6. Proposed DAG nodes (NOT applied — for post-research adoption)

Builds on the `RESEARCH-*` set in [`research-engine-design.md`](./research-engine-design.md)
and adds the cross-cutting / per-subproject nodes implied by this synthesis. Schema mirrors
`roadmap/spec-dag.json` (id/title/priority/target/projects/dependsOn).

| Proposed id      | title                                                                                              | proj           | pri   | dependsOn          |
| ---------------- | -------------------------------------------------------------------------------------------------- | -------------- | ----- | ------------------ |
| CATALOG-000..012 | (the `RESEARCH-*` engine: adapters, resolver, completeness, finders, IGDB/Wikidata, local scanner) | itotori/shared | P1–P3 | UNIV-000           |
| KAIFUU-Dnn       | Engine detector registry (capability-leveled)                                                      | kaifuu         | P1    | KAIFUU-001         |
| KAIFUU-Dnn       | RPG Maker MV/MZ **full-surface** positive adapter                                                  | kaifuu         | P1    | detector           |
| KAIFUU-Dnn       | Binary-patcher core → RGSS3/VX Ace adapter                                                         | kaifuu         | P1    | MV/MZ              |
| KAIFUU-Dnn       | KiriKiri **rescope**: readiness + XP3/encryption (not plaintext-only)                              | kaifuu         | P2    | KAIFUU-014         |
| KAIFUU-Dnn       | TyranoScript plaintext adapter (new — market greenfield)                                           | kaifuu         | P2    | detector           |
| KAIFUU-Dnn       | Packed-engine readiness profiles (Siglus/Unity/NeXAS/Aoi/RealLive/Wolf)                            | kaifuu         | P2    | detector           |
| KAIFUU-Dnn       | Edition mapping + archive/install-state                                                            | kaifuu         | P2    | catalog resolver   |
| UTSUSHI-Cnn      | Completeness-driven targeting + benchmark-vs-existing-TL harness                                   | utsushi        | P2    | completeness model |
| UTSUSHI-Cnn      | Edition-aware translation porting                                                                  | utsushi        | P3    | edition mapping    |
| SHARED-Cnn       | Unified catalog schema + migrations + provenance/conflict model                                    | shared         | P1    | UNIV-000           |
| SHARED-Cnn       | Shared engine-fingerprint registry                                                                 | shared         | P2    | detector           |

---

## 7. Roadmap adjustments (summary)

1. **Keep RPG Maker MV/MZ as the first positive adapter** — now triple-validated; invest in
   the _full_ surface, not a slice.
2. **Rescope KiriKiri** from "plaintext-only" to "readiness + XP3/encryption"; bind to the
   key-discovery boundary. Plaintext-only misses ~all of the 4,046.
3. **Down-weight Ren'Py** to "reference adapter" — low JP value, no local backlog.
4. **Add TyranoScript** as an early, cheap, high-reach plaintext adapter.
5. **Pull RGSS3/VX Ace (binary-patcher core) earlier** — local backlog weight (ROBF/Re:BF).
6. **Elevate the catalog + completeness engine to a first-class Itotori subsystem**, not a
   research script — it's the substrate for prioritization, benchmarking, and identity.
7. **Add the console/generic tier (IGDB/Wikidata)** so completeness is correct.
8. **Frame the MVP** as inventory → identity → readiness → MV/MZ extraction/patch →
   packed-engine readiness → expand-on-proven-round-trip (matches the local-corpus report's
   conclusion).

---

## 8. Opportunity & benchmark targets (ready now)

- **Abandoned partial TLs (`fan_partial`, 3,980)** — stalled fan projects; top by demand
  include _Yosuga no Sora_, _FORTUNE ARTERIAL_, _Flyable Heart_, _Your Turn To Die_
  (RPG Maker). Both opportunities and round-trip benchmark corpora.
- **MTL-only (1,272)** — reference-translation benchmark set (e.g. _Kono Aozora ni Yakusoku
  o_, _AMBITIOUS MISSION_).
- **Cross-source-only gems** — _Demons Roots_, _BLACKSOULS II_, _Zakuzaku Actors_ (DLsite
  RPG, VNDB-absent); IGDB-verified `IGDB:noEN` cases (_Ecole de Paris_, _Doukyuusei_) are
  confirmed-no-official-EN, the strongest leads.
- **689 conflicts** — VNDB-vs-store official-EN disagreements: a data-quality fix list and
  a localized-already benchmark set.
- **Local corpus** — the MV/MZ titles (`kcorp-003/016/018/020-023/025/030/015*`) are the
  first private validation set; RGSS3 (`ROBF/Re:BF`) and Siglus the readiness set.

---

## 9. Caveats / what the running crawl will sharpen

- DLsite/Steam enrichment is partial; `official_full` and the conflict count will rise as
  the crawl completes, **clearing console/PC false positives** in the opportunity lists.
- The DLsite `work_type` sample so far is **VN-biased** (ADV 46% + DNV 29%, RPG 13%) because
  our DLsite crawl set is VNDB-linked; the **RPG-Maker indie pool lives in the EGS-only /
  local-corpus segment** (confirmed by the corpus) and is under-sampled here. A DLsite
  catalog-discovery crawl (proposed) would size it directly.
- Engine attribution is null for ~53% of JP VNs in VNDB; local-scan ground-truth + DLsite
  `work_type` + IGDB are the fill.
- All DAG nodes above are **proposals**; the live `roadmap/` is untouched.
