# Security, Legal Boundaries & Limitations

This document states the alpha security/legal posture **as it actually is** —
practical boundaries, not aspirational ones. Where a boundary is a toggle or an
operator responsibility rather than an absolute guarantee, it says so.

## 1. Data & credential boundaries

### Read-only game corpora

Real game bytes are never copied into the repo or mutated in place.

- Vault/catalog ingest is **read-only**: the vault-source adapter opens
  `/archive/vault/` (managed by the sibling vault-curation project) strictly
  read-only ([`itotori-vault-source-adapter.md`](itotori-vault-source-adapter.md)).
- The `just localize-project` driver refuses to write inside the source tree and
  requires a separate writable `TARGET`; it sha256-checks the source
  `Seen.txt` before **and** after a run and fails on any drift.
- Local purchased-game corpora live under `fixtures/private-local/` and
  `.kaifuu/secrets.local/`, both git-ignored. The real-bytes CI lane reads
  staged corpora in place and never copies copyrighted bytes.

### Credentials & ZDR

- Provider credentials live only in git-ignored `.env*` files. Repo tooling must
  not read, print, expose, or commit them (`.gitignore` enforces `.env` /
  `.env.*` with `.env.example` exceptions).
- Privacy relies on **OpenRouter account-wide Zero-Data-Retention**. A live run
  is fail-closed: the `OpenRouterModelProvider` constructor requires
  `OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`, and the `localize-project` /
  `provider-proof --live` paths require an explicit exported
  `OPENROUTER_API_KEY`. Without both, the driver fails loudly rather than
  downgrading to a recorded provider. Every model invocation declares an
  explicit `(modelId, providerId)` pair — no defaulting.
- ZDR is an **account-wide OpenRouter setting**, not something Itotori can
  enforce provider-side; the assertion env var is the operator's fail-closed
  acknowledgement, and recorded default runs make no network calls at all.

### No shell-outs to foreign tools in the shipped pipeline

The shipped extraction/patch/runtime pipeline contains no foreign-tool
subprocess invocations and no vendored third-party code. (External tools may be
used out-of-band as validation oracles during development, but never inside the
shipped path.)

## 2. Redaction & the copyright boundary

The copyright boundary is **what is committed / published**, not what an
operator can render locally on their own legally-owned copy.

- Redaction is a **configurable toggle**, default ON for committed proof. Public
  / committed runtime and render artifacts replace local filesystem paths and
  copyrighted game-art frames with redaction markers plus `redactedFields` /
  redaction-rule metadata ([`utsushi-runtime-artifacts.md`](utsushi-runtime-artifacts.md)).
- Full-fidelity private frames (real decoded pixels) are written only under the
  git-ignored `/.private-render/` scratch path for local inspection; they are
  never committed. The public frame is the redacted one.
- Public fixtures and proof manifests carry explicit redistribution +
  license/provenance metadata and contain no copyrighted game assets
  ([`fixtures-and-corpora.md`](fixtures-and-corpora.md)).

This is a deliberate posture, not a claim that the tool prevents an operator from
producing copyrighted output locally — it governs what leaves the repo.

## 3. Authorization

Itotori authorization is permission-based, checked against
`packages/itotori-db/src/authorization.ts` (the source of truth), with a
migration drift guard (`SHARED-014`) and a permission-gate negative test matrix
(`SHARED-013`). Local alpha mode bootstraps a single `local-user` with all alpha
permissions ([`permissions.md`](permissions.md)).

## 4. Known limitations (not overstated)

These are the honest limits at alpha. Alpha is **readiness to start a real
localization project**, not a finished product.

- **Single-game, single-engine end-to-end.** Alpha end-to-end is RealLive only.
  In the generated capability matrix
  ([`alpha-readiness.md`](alpha-readiness.md) §3) every engine family except the
  synthetic fixture adapter is `readiness_only` (detection / key-posture
  evidence), **not** an end-to-end extract/patch claim. Multi-game and
  encrypted-variant end-to-end coverage is beta work.
- **Output quality is NOT guaranteed.** The bar at alpha is that every pipeline
  stage fires and is swappable, not that the localization reads well;
  worse-than-MTL output is acceptable ([`project-readiness.md`](project-readiness.md)).
- **Some engines are corpus-blocked.** SiglusEngine has a landed skeleton but its
  real-bytes chain is parked behind re-acquiring a realizable (download-edition)
  corpus; copy-protected DVD images are unrealizable under the
  no-Wine / no-shell-out / no-installer laws.
- **Ren'Py and unknown-format inputs are explicitly excluded** from the
  capability breadth ([`alpha-readiness.md`](alpha-readiness.md) §3).
- **Linux-only runtime.** The `utsushi-reallive` replay path targets Linux; there
  is no Wine or Windows-helper fallback.
- **Live provider proof is opt-in.** CI proves the recorded path deterministically;
  real ZDR calls (`--live`, `alpha-006d`, `agentic-repair-live`) run only when a
  human opts in with credentials.

## 5. What the alpha gate does NOT claim

- It does not claim beta multi-game coverage, encrypted-variant end-to-end
  support, or non-technical-user readiness — those are later tiers
  ([`project-readiness.md`](project-readiness.md) §2.3–§2.4).
- It does not claim provider-side ZDR enforcement; ZDR is an account-wide
  OpenRouter posture the operator asserts.
- It does not claim to prevent local production of copyrighted output; the
  boundary is what is committed/published.
