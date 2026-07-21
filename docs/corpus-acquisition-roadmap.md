# Corpus acquisition roadmap (engine-family validation)

Planning artifact for the **multi-game validation law**: engine-family behavior
must be proven against **real owned titles**, never synthetic-only. This doc is
**metadata and method only** — no copyrighted bytes or text. Actual acquisition
is owned by the
[vault-curation sibling contract](./itotori-vault-source-adapter.md).

Engine signatures follow [`kaifuu-detection-matrix.md`](./kaifuu-detection-matrix.md)
and [`kaifuu-encrypted-engine-research.md`](./kaifuu-encrypted-engine-research.md).

## Validation tiers (per engine family)

| Tier             | Bar                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Alpha**        | ≥ **2** real titles spanning the family’s hardest variation axis (e.g. plain vs encrypted archive, Mono vs IL2CPP). |
| **Beta**         | ~3–5 titles: broaden remaining axes (compiler/engine version, feature usage, language, vendor build).               |
| **Full release** | Fill the matrix (audio encryption, plugin-heavy builds, major runtime forks, etc.).                                 |

A detector match is never an extraction or patch claim. Per-engine readiness
records under `docs/kaifuu-adapters/` are the support source of truth.

## Method

1. Inventory vault/catalog metadata (engine field, identifier tables, container
   file-name signatures) — read-only; never write vault bytes from this tree.
2. Map each intended family to **variation axes** that matter for decode /
   patch / runtime proof (archive crypto, scripting backend, layout forks).
3. Prefer titles already vaulted that **positively** show the signature; treat
   truncated file listings as incomplete for _absence_ proofs.
4. Source gaps only when an axis is unrepresented; record **why** (axis), not
   a named-title wishlist as product scope.

## Intended engine families (signatures, not titles)

| Family                          | Typical on-disk signatures (positive evidence)                                   | Hard axes to span                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| RealLive                        | `SEEN.TXT` / `SEENxxx.TXT`, `Gameexe.ini`, `*.g00`                               | VM/compiler era; SEEN plain vs XOR; voice archives                           |
| Siglus                          | `Scene.pck`, `Gameexe.dat`                                                       | Key/vendor build era; encryption; official-EN vs JP-only                     |
| RPG Maker MV/MZ                 | MV `www/data` + nwjs; MZ top-level `data/`; encrypted ext (`.rpgmvp` / `png_` …) | MV vs MZ; plain vs encrypted media; plugin density                           |
| KiriKiri / XP3                  | `*.xp3`, optional `.tpm`/`.tpp`                                                  | Plain vs encrypted vs cxdec-profiled; `data.xp3`+`patch.xp3`; krkr2 vs krkrz |
| Unity (Naninovel / I2 / custom) | IL2CPP vs Mono; `*.nani` / Naninovel; Addressables                               | Scripting backend; loc framework; asset delivery                             |

Other engines may appear in the vault for triage; promotion into claimed support
still requires the full Kaifuu readiness ladder on real bytes.

## What not to do

- Do **not** hard-code commercial title names into product docs, UI, or
  fixtures (see title-reference allowlist in
  [`fixtures-and-corpora.md`](./fixtures-and-corpora.md)).
- Do **not** treat a catalog row without an on-disk artifact as usable corpus.
- Do **not** promote synthetic-only ladders to “shipped adapter” claims.

Point-in-time title checklists, if needed for private vault ops, belong outside
active product docs (vault-curation / private notes), not here.
