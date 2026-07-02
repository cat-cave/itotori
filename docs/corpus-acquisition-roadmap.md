# Corpus Acquisition Roadmap (per engine family)

Planning artifact for the **multi-game validation law**: engine-family behavior
must be proven against real games, never synthetic-only.

- **ALPHA** = **>= 2** real titles per engine family, chosen to span the format's
  hardest variation axis (e.g. plain vs encrypted archive).
- **BETA** = **more (~3-5)**: broaden across the remaining axes (engine/compiler
  version, feature usage, language, vendor build).
- **FULL RELEASE** = **more still**: fill the matrix (voiced/unvoiced, audio
  encryption, plugin-heavy, KiriKiriZ vs KiriKiri2, IL2CPP vs Mono, etc.).

This doc is **metadata only** — titles, engine IDs, DLsite RJ / Steam appids,
VNDB IDs, and in-vault status. No copyrighted bytes or text. The
[vault-curation sibling project](./itotori-vault-source-adapter.md) performs the
actual acquisition; this doc identifies **what** and **why**.

Engine signatures follow [`kaifuu-detection-matrix.md`](./kaifuu-detection-matrix.md)
and [`kaifuu-encrypted-engine-research.md`](./kaifuu-encrypted-engine-research.md).

## Method / provenance

Part 1 inventoried the read-only vault at `/archive/vault` (**read-only**; never
written). Two sources were cross-referenced:

- `catalog.db` SQLite catalog — `releases.engine` normalized engine column plus
  the `facts`/`identifiers` tables (VNDB `v`, DLsite `rj`, Steam `appid`).
- `artifacts/by-id/<canonical_id>/` — each vaulted game is a `.7z` + a `.json`
  sidecar. The sidecar's `engine` field + `containers_json[].produced` **file
  listing** is the on-disk ground truth; file names were scanned for engine
  signatures (`Seen.txt`, `Scene.pck`, `*.xp3`, `*.rpgmvp`, `www/data`, `png_`,
  `il2cpp`, `*.nani`, ...). File listings are truncated at 5000 entries per
  container, so very large games report a subset (does not affect signatures).

Part 2 used web research to fill hard-axis gaps the vault does not cover.

### Vault engine breakdown (on-disk sidecar truth, 335 vaulted artifacts)

| Engine (sidecar)      | Vaulted | Engine (sidecar)                         | Vaulted |
| --------------------- | ------- | ---------------------------------------- | ------- |
| unity                 | 81      | eushully                                 | 6       |
| rpgmaker_mv           | 55      | kirikiri                                 | 4       |
| (null / unclassified) | 61      | siglus                                   | 4       |
| majiro                | 24      | softpal / nscripter / softhousechara_ags | 4 ea    |
| alicesoft             | 19      | unreal / exhibit                         | 3 ea    |
| wolfrpg               | 17      | reallive                                 | 2       |
| catsystem2            | 15      | renpy                                    | 2       |
| rpgmaker_vxace        | 13      | key_visualarts / bgi / cmvs / gamemaker  | 1 ea    |
| artemis               | 8       | RPG Maker XP / rpgmaker_vx               | 1 ea    |

The five **intended engine families** (RealLive, Siglus, RPG Maker MV/MZ,
KiriKiri, Unity Naninovel/I2Loc) are all represented in the vault; the sections
below give per-title candidates and the gaps to source next.

---

## RealLive (VisualArt's / Key)

**Signatures in vault:** `SEEN.TXT` + `SEENxxx.TXT`, `Gameexe.ini`, `*.g00`.

**Variation axes a good set must span:**

- Compiler / VM version (older AVG32-lineage `cv 10002` plain vs later
  `cv 110002` with `xor_2`-encoded `SEEN.TXT`).
- SEEN.TXT plaintext vs XOR-obfuscated scenario archive.
- Voiced vs unvoiced (`.ovk`/`.koe`/`.nwk` presence).
- Choices / route branching density; `.g00` image sub-formats.
- Native-DLL minigames (Little Busters baseball, Tomoyo After dungeon) — a known
  edge that is _not_ RealLive bytecode.

### ALPHA set (>= 2) — MET by vault

| Title                               | ID                           | In vault                          | Source                      | Diversity axis                                             |
| ----------------------------------- | ---------------------------- | --------------------------------- | --------------------------- | ---------------------------------------------------------- |
| Oshioki Sweetie ~Koi Suru Onee-san~ | vndb v1859 / DLsite VJ013077 | **yes** (`reallive`, ~2843 files) | DLsite                      | The alpha e2e title; later xor_2-era build, voiced         |
| Kanon                               | vndb v33                     | **yes** (`reallive`, ~5000 files) | DLsite / Steam (VisualArts) | Older AVG32-lineage RealLive build — the _earlier-VM_ pole |

### BETA set (add ~3) — to acquire

| Title                              | ID                           | In vault                              | Source | Diversity axis                                                                              |
| ---------------------------------- | ---------------------------- | ------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| Sweets!! -Oshioki Sweetie Fandisc- | vndb v2973                   | partial (bundled w/ Oshioki artifact) | DLsite | Fandisc reusing base engine — patchback-scope regression pair                               |
| Planetarian                        | Steam (official EN)          | no                                    | Steam  | Short kinetic novel, official English release — _legit EN + minimal-branch_ pole            |
| CLANNAD                            | Steam (VisualArts/Prototype) | no                                    | Steam  | cv 1.2.3.5 (plain) vs Full Voice cv 1.5.0.4 — _compiler-version_ axis; heavy routes/choices |

### FULL set (more still)

| Title                  | ID     | Source         | Diversity axis                                                                                                                                                                                                   |
| ---------------------- | ------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Little Busters! (full) | vndb — | Steam / DLsite | ME build cv 1.5.9.1; native-DLL minigame edge case. **NOTE:** the current vault `key_visualarts` entry (`little-busters.v5`, 98 files) is a **stub/incomplete extraction**, not a usable full title — re-source. |
| AIR                    | Steam  | Steam          | Standard vs voiced editions; another VM revision                                                                                                                                                                 |
| Tomoyo After           | Steam  | Steam          | Native-DLL dungeon minigame edge                                                                                                                                                                                 |

---

## SiglusEngine (VisualArt's / Key + licensees)

**Signatures in vault:** `Scene.pck`, `Gameexe.dat`, `*.g00`.

**Variation axes:**

- `Scene.pck` compression + XOR/key obfuscation; `Gameexe.dat`.
- SiglusEngine build era (older licensee builds vs newer Key builds).
- Vendor build (Key vs Favorite vs other licensees compile differently).
- Voiced; choice/flag density; official-EN vs JP-only.

### ALPHA set (>= 2) — MET by vault

| Title                | ID                            | In vault                      | Source         | Diversity axis                                                                 |
| -------------------- | ----------------------------- | ----------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Summer Pockets       | vndb v20424 / Steam 897220    | **yes** (`siglus`, Scene.pck) | Steam / DLsite | Newer Key SiglusEngine build; official EN exists — _modern-engine_ pole        |
| Hoshi Ori Yume Mirai | vndb v14265 / DLsite VJ014500 | **yes** (`siglus`)            | DLsite         | Different vendor (Makura/Favorite-adjacent) Siglus build — _vendor-build_ pole |

### BETA set (add ~3) — mostly in vault

| Title                     | ID                            | In vault           | Source | Diversity axis                                                      |
| ------------------------- | ----------------------------- | ------------------ | ------ | ------------------------------------------------------------------- |
| Gin'iro, Haruka           | vndb v18778 / DLsite VJ010335 | **yes** (`siglus`) | DLsite | Another licensee Siglus build; large Scene.pck                      |
| Hatsukoi 1/1              | vndb v9124 / DLsite VJ006832  | **yes** (`siglus`) | DLsite | Older Siglus build era — _earlier-engine_ pole                      |
| Game (=Eroge) Mitai na... | (catalog only)                | metadata-only      | DLsite | **Not on disk** — catalog row without artifact; re-source if wanted |

### FULL set (more still)

| Title                          | ID                  | Source | Diversity axis                              |
| ------------------------------ | ------------------- | ------ | ------------------------------------------- |
| Summer Pockets Reflection Blue | Steam               | Steam  | Expanded re-release, newest Siglus revision |
| LOOPERS                        | Steam (official EN) | Steam  | Short official-EN Key Siglus title          |

---

## RPG Maker MV / MZ

**Signatures in vault:** MV = `www/data/*.json` + `www/js/` + `package.json`
(nwjs); MZ = top-level `data/` + `js/` (no `www/`). Encrypted assets = `.rpgmvp`
/ `.rpgmvo` / `.rpgmvm` (MV) or `.png_` / `.ogg_` / `.m4a_` (MZ). Key lives in
`System.json` (`encryptionKey`).

**Variation axes:** MV vs MZ folder layout; encrypted-asset extension vs plain
`img/`; audio encryption (`rpgmvo`/`ogg_`); JP DLsite vs EN Steam vs ZH; plugin
density (`js/plugins/`); language.

This family is the **deepest-covered** in the vault: 55 MV/MZ artifacts spanning
plain + encrypted, MV + MZ, JP + EN + ZH, plus 13 VX Ace and 1 each VX / XP.

### ALPHA set (>= 2) — MET by vault

| Title                       | ID              | In vault | Layout                               | Diversity axis                                           |
| --------------------------- | --------------- | -------- | ------------------------------------ | -------------------------------------------------------- |
| Last Memory (rasutomemorii) | DLsite RJ262855 | **yes**  | MV, `www/data` + `.rpgmvp`/`.rpgmvo` | **Encrypted-asset** MV pole (image+audio encryption), JP |
| From Frontier               | Steam 1348180   | **yes**  | MV, `www/data`, **no** encrypted ext | **Plain-asset** MV pole, EN Steam                        |

### BETA set (add ~3) — in vault

| Title                                 | ID                | In vault                                              | Layout                     | Diversity axis                                                                                      |
| ------------------------------------- | ----------------- | ----------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| Beyond the Portal: Island's Salvation | Steam 2828960     | **yes**                                               | **MZ** (`png_`, no `www/`) | **MZ + encrypted** pole (distinct from MV)                                                          |
| Joe's Quest                           | Steam 1280920     | **yes**                                               | MZ (`png_`)                | MZ encrypted, long-running Steam title, plugin-heavy                                                |
| Bu Chuan Qunzi... (bianli shangdian)  | DLsite RJ01056550 | **yes** (unity build; ZH sibling exists in MZ family) | —                          | **ZH-language** axis (see Unity note); for MZ-ZH use `saikuruobukorappushon` RJ01543883 (MV, ZH/JP) |

### FULL set (more still)

| Title                                      | ID                                      | Source | Diversity axis                                                    |
| ------------------------------------------ | --------------------------------------- | ------ | ----------------------------------------------------------------- |
| Succubus Puttel / Succubus in Wonderland   | Steam 1963740 / 1964670                 | Steam  | MV `rpgmvp`+`rpgmvo` audio-encryption confirm, EN                 |
| Monmusu Quest! Paradox (Zen/Chuu/Shuushou) | DLsite RJ150726 / RJ201109 / RJ01114724 | DLsite | **VX Ace** bridge (`rgss3a`) — adjacent RGSS family, huge scripts |
| Pokemon Infinite Fusion                    | fan build                               | direct | **RPG Maker XP** (`rgssad`) edge — oldest RGSS                    |

---

## KiriKiri / XP3 (plain KAG3 + encrypted XP3)

**Signatures in vault:** `*.xp3`, `data.xp3` split, `.tpm`/`.tpp` plugin
(KiriKiriUnencryptedArchive / crypt helper). Per
`kaifuu-encrypted-engine-research.md`, XP3 detection must distinguish **plain
archive vs encrypted archive vs cxdec-profiled vs helper-required vs
patch.xp3**.

**Variation axes:**

- Plain KAG3 (unencrypted XP3) vs encrypted XP3.
- Simple master-key / XOR crypt vs **cxdec profiled encryption** (cxdec games
  carry **no** `.tpm` plugin — decryption is compiled into the exe).
- Single `.xp3` vs `data.xp3` + `patch.xp3` split.
- KiriKiri2 vs KiriKiriZ runtime.

### ALPHA set (>= 2) — MET by vault (with caveat)

| Title       | ID                                            | In vault             | Signature                      | Diversity axis                     |
| ----------- | --------------------------------------------- | -------------------- | ------------------------------ | ---------------------------------- |
| Monkeys!¡   | vndb v31262 / Steam 3883050                   | **yes** (`kirikiri`) | single `.xp3`, no plugin       | **Simplest / near-plain** XP3 pole |
| Ouka Sabaki | vndb v16858 / Steam 1066630 / DLsite VJ010698 | **yes** (`kirikiri`) | `.xp3` + `data.xp3`, no `.tpm` | **Encrypted split-archive** pole   |

### BETA set (add ~3) — 2 in vault, 1 to acquire

| Title                                 | ID         | In vault | Signature                    | Diversity axis                                                   |
| ------------------------------------- | ---------- | -------- | ---------------------------- | ---------------------------------------------------------------- |
| Coμ -Kuroi Ryuu to Yasashii Oukoku-   | vndb v1896 | **yes**  | `.xp3` + `data.xp3` + `.tpm` | **Helper-plugin crypt** variant (`.tpm` present)                 |
| Noble ☆ Works                         | vndb v4806 | **yes**  | `.xp3` + `data.xp3` + `.tpm` | Second `.tpm`-helper title (regression pair)                     |
| _(cxdec-profiled title — TO ACQUIRE)_ | see gaps   | **no**   | cxdec, no `.tpm`             | **cxdec profiled-encryption** hard crypto axis — not represented |

### FULL set (more still)

- A KiriKiriZ (krkrz) title vs the KiriKiri2 titles above (runtime axis).
- A title shipping `patch.xp3` over `data.xp3` (patch-database workflow).

> **Caveat (unsure):** the plain-vs-encrypted labels above are inferred from
> file listings (`.xp3` layout + `.tpm` presence), **not** confirmed crypto
> profiles. Whether any vault KiriKiri title is truly _unencrypted KAG3_ vs
> simple-key vs cxdec requires runtime confirmation via GARbro / KrkrExtract.
> Treat "acquire a known-cxdec title" as the concrete crypto-axis gap.

---

## Unity (Naninovel + I2Localization)

**Signatures in vault:** scripting backend `il2cpp/GameAssembly.dll` (IL2CPP) vs
`Assembly-CSharp.dll` (Mono); `*.nani` / `Naninovel` (Naninovel); Addressables
vs `StreamingAssets` vs plain `.assets`. I2Localization data lives inside asset
bundles and is **not** visible in file listings.

**Variation axes:**

- **Scripting backend: Mono vs IL2CPP** — string/script extraction differs
  drastically (Mono = readable IL; IL2CPP = native + `global-metadata.dat`).
- **Localization framework: Naninovel `.nani` vs I2Localization vs custom** —
  different text stores and patchback surfaces.
- Asset delivery: Addressables vs StreamingAssets vs plain assets.
- Language (JP DLsite vs EN/ZH Steam).

**Naninovel titles confirmed in vault by `.nani`/Naninovel signature (5):**

### ALPHA set (>= 2) — MET by vault

| Title             | ID            | In vault            | Backend    | Diversity axis                                                        |
| ----------------- | ------------- | ------------------- | ---------- | --------------------------------------------------------------------- |
| Married Into Hell | Steam 3907210 | **yes** (Naninovel) | **Mono**   | Naninovel + Mono + Addressables — _readable-backend_ pole             |
| DeviDevi Survivor | Steam 3159800 | **yes** (Naninovel) | **IL2CPP** | Naninovel + **IL2CPP** — _native-backend_ pole (hard extraction axis) |

### BETA set (add ~3) — in vault

| Title                  | ID                              | In vault            | Backend | Diversity axis                                          |
| ---------------------- | ------------------------------- | ------------------- | ------- | ------------------------------------------------------- |
| Dekiru Kouhai Aoi-chan | vndb v63566 / DLsite RJ01473408 | **yes** (Naninovel) | Mono    | **JP DLsite** Naninovel title — language axis           |
| Lust Poker Club        | Steam 4442190                   | **yes** (Naninovel) | Mono    | Naninovel + Addressables, EN                            |
| ButtKnight             | Steam 2772820                   | **yes** (Naninovel) | Mono    | Naninovel + Addressables, large script set (~732 files) |

### FULL set (more still)

| Title                                    | ID                          | Source                    | Diversity axis                                                                  |
| ---------------------------------------- | --------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| _(I2Localization Unity VN — TO ACQUIRE)_ | see gaps                    | Steam/DLsite              | **I2Localization** framework (distinct from Naninovel) — not confirmed in vault |
| Love Esquire                             | vndb v24315 / Steam 849740  | Steam (in vault, `unity`) | Non-Naninovel Unity VN/SRPG (custom loc) — framework-diversity                  |
| GEARS of DRAGOON 2                       | vndb v17988 / Steam 1999870 | Steam (in vault, `unity`) | Unity "adv"-style build, JP+EN                                                  |

> **Note:** the Naninovel homepage "made-with" gallery is unreliable for VN
> scoping (it surfaces generic Unity AAA logos). The 5 titles above are
> **signature-confirmed in the vault** and are the trustworthy Naninovel ground
> truth. I2Localization coverage is a genuine gap because I2 data is bundle-
> internal and cannot be confirmed from file listings alone.

---

## Immediate gaps — what to source NEXT

Per engine family, the concrete next acquisitions to reach **alpha-2 + start
beta**:

| Engine family       | Alpha-2 status                                 | Source next (why)                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RealLive**        | MET (Oshioki + Kanon)                          | **Planetarian** (Steam, official EN — legit + minimal-branch pole) and **CLANNAD** (Steam — cv 1.2.3.5 vs Full Voice 1.5.0.4 compiler-version axis). Re-extract **Little Busters** in full (current vault entry is a 98-file stub). |
| **Siglus**          | MET (Summer Pockets + Hoshi Ori)               | Beta already largely in vault (Gin'iro, Hatsukoi). Optional: **LOOPERS** or **Summer Pockets Reflection Blue** (Steam) for newest-engine + official-EN axis. Re-source _Game (=Eroge) Mitai na_ (catalog-only).                     |
| **RPG Maker MV/MZ** | MET (Last Memory + From Frontier)              | Deepest coverage already (MV plain+enc, MZ enc, VX Ace, XP). Minor: a **plain (unencrypted) MZ** title and an audio-encryption (`rpgmvo`/`ogg_`) confirm.                                                                           |
| **KiriKiri**        | MET-with-caveat (Monkeys + Ouka Sabaki)        | **One known cxdec profiled-encryption KiriKiriZ title** (hard crypto axis — vault's 4 are simple/plugin crypt, none confirmed cxdec) + confirm a truly-plain KAG3 title via GARbro/KrkrExtract.                                     |
| **Unity Naninovel** | MET (Married Into Hell/Mono + DeviDevi/IL2CPP) | **One confirmed I2Localization Unity VN** (distinct loc framework — not confirmable from listings, needs runtime confirmation).                                                                                                     |

### Cross-cutting notes / unsure items

- **Metadata-only catalog rows:** a few `releases` rows have no on-disk artifact
  (e.g. _Game (=Eroge) Mitai na_ Siglus; the RealLive fandisc is bundled inside
  the Oshioki artifact). These are catalog knowledge, not usable bytes.
- **KiriKiri crypto profile** and **Unity I2Localization** cannot be settled from
  file listings; both need a runtime oracle (GARbro / KrkrExtract for XP3;
  bundle inspection for I2Loc).
- **File-listing truncation at 5000 entries** means signature _absence_ on very
  large games is not proof of absence — signatures are used only positively.
