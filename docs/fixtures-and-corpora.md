# Fixtures And Corpora

Itotori needs fixtures that are safe for public CI and private corpora that can
support credible benchmark work without redistributing copyrighted game assets.
This policy separates those use cases.

## Repository Layout

```txt
fixtures/
  hello-game/                 Synthetic public fixture used by hello world.
  public/                     Public fixture manifests, schema, and validator.
  private-local/              Local-only corpora ignored by git.
```

`fixtures/private-local/` is reserved for purchased games, licensed evaluation
sets, and other material that cannot be redistributed. The path is ignored by
git and must stay local to the developer or benchmark runner.

## Public Fixtures

Public fixtures are the only fixtures allowed in public CI. A public fixture
must meet all of these requirements before a committed test, benchmark, or demo
depends on it:

- It is synthetic, public domain, or explicitly open-licensed for redistribution.
- Its raw files are small enough for repository review and do not contain
  commercial game scripts, images, audio, fonts, videos, dumps, save files, or
  other copyrighted raw assets unless those assets are redistributable under the
  fixture license.
- It has a manifest under `fixtures/public/` that validates against
  `fixtures/public/manifest.schema.json`.
- Every raw file named by the manifest includes a SHA-256 hash and byte length.
- The manifest records aggregate stats that benchmark reports can cite without
  re-reading raw files.

The `fixtures/hello-game/source.json` fixture is synthetic and is described by
`fixtures/public/hello-game.manifest.json`. Its expected bridge snapshots,
patch export, patch result, delta metadata, runtime report, benchmark report,
standalone finding, and surface coverage matrix live beside the source fixture.
The `fixtures/public/hello-game-alpha-vertical-proof.manifest.json` catalog
entry lists `fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json`.
That proof manifest records fixture identity, source revision, bridge units,
runtime targets, artifact refs, provider proof ids, benchmark output refs, and
content hashes without raw provider text or private-local paths.
The `fixtures/seeded-localization-defects/` fixture is synthetic and is
described by `fixtures/public/seeded-localization-defects.manifest.json`. Its
source fixture, seeded-defect oracle, false-positive calibration cases, and
defect coverage matrix are listed in the public manifest. Its expected
benchmark finding report lives beside the source fixture and cites the manifest
hash for the input corpus. The expected findings map to `itotori-lqa-1`
categories, quality severities, root causes, detector kinds, and adjudication
states.
Future public fixtures may place their raw files under
`fixtures/public/<fixture-id>/` when that is the least surprising layout, but
committed manifests should use repo-relative paths so tools can validate hashes
from the repository root.

Validate public fixture manifests with:

```sh
pnpm exec node fixtures/validate-public-manifests.mjs
```

The validator checks the JSON Schema, confirms that referenced files stay inside
the repository and outside `fixtures/private-local/`, and verifies the recorded
SHA-256 and byte counts.

## Private Local Corpora

Private corpora are local inputs for adapters, benchmarks, and credibility
checks that cannot be committed. Put them under:

```txt
fixtures/private-local/<corpus-id>/
```

Recommended local layout:

```txt
fixtures/private-local/<corpus-id>/
  raw/                         Purchased or otherwise restricted source files.
  derived/                     Local-only extracted text, traces, or reports.
  key-profiles.local.json      Local key profile refs and validation evidence.
  secrets.local/               Optional ignored local secret material.
  private-manifest.local.json  Local metadata, hashes, and aggregate stats.
  README.local.md              Local notes about acquisition and scope.
```

Private corpus commands should take the corpus path from a CLI flag,
environment variable, or local config file under `.tmp/`. Do not edit committed
paths, public manifests, tests, or package metadata to point at private inputs.
CI must pass with the private path absent.

Private local manifests should record:

- Corpus id and local owner or runner.
- Acquisition class, such as purchased copy, internal test build, or licensed
  evaluation set.
- SHA-256 hashes and byte counts for raw files or a hash-list file.
- Aggregate stats: file counts, text-unit counts, source locales, target
  locales, character counts, asset counts, engine type, and benchmark split.
- Tool versions and command lines used to derive local reports.
- Encrypted-input readiness metadata when relevant: redacted key-profile ids,
  helper class, helper version, helper availability, key-validation proof hashes,
  and archive/encryption detector results.

Never commit private raw files, extracted raw text, screenshots, audio, video,
font files, save files, raw keys, helper dumps, decrypted scripts, local secret
stores, or local manifests that reveal restricted content.

Private-local encrypted validation commands should produce safe aggregate
readiness reports. Those reports may be cited publicly by corpus label, private
manifest hash, hash-list hash, engine counts, redacted key-profile ids,
redacted proof hashes, tool versions, and command lines. They must not include
raw key material, decrypted text, raw helper logs, retail filenames that reveal
story content, local absolute paths, or storefront/account identifiers.

## Canonical Private Corpus Hash Lists

Use `private-hash-list.local.jsonl` when a private corpus needs stable raw-file
identity without redistributing the files. The file is local-only and ignored
with the rest of `fixtures/private-local/`, but its aggregate hash can be cited
in benchmark reports.

The canonical format is UTF-8 JSON Lines with one compact JSON object per raw
file. Each line must serialize exactly these keys in this order:

```json
{ "path": "raw/script-0001.dat", "bytes": 1234, "sha256": "<64 lowercase hex chars>" }
```

Build the hash list with these rules:

- Hash algorithm: `sha256` over the exact raw file bytes.
- Relative path normalization: make each path relative to the corpus directory,
  use `/` separators, remove `.` segments, reject absolute paths, reject empty
  paths, reject `..` segments, and reject paths outside the corpus directory.
- Ordering: sort entries by normalized `path` using bytewise lexicographic order
  over the UTF-8 path string. If two entries normalize to the same path, the
  hash list is invalid.
- Serialization: emit one JSON object per line with no extra spaces, lowercase
  hex hashes, decimal byte counts, LF line endings, and a final trailing LF. Do
  not include a top-level wrapper, comments, timestamps, tool versions, locale
  metadata, or machine-specific fields in the hash-list file.
- Redaction: do not include absolute paths, usernames, volume names, storefront
  ids, license keys, account ids, order ids, save-slot ids, raw strings, text
  snippets, screenshots, filenames that reveal story content, or any extracted
  private data. If filenames are sensitive, copy or symlink raw inputs into a
  stable redacted layout such as `raw/file-000001.bin` before generating the
  list, and record the private source-to-redacted mapping only in local notes.

Compute the hash-list hash as `sha256` over the exact UTF-8 bytes of
`private-hash-list.local.jsonl` after canonical serialization. Public benchmark
reports may cite the corpus label, aggregate stats, private manifest hash, and
this hash-list hash, but must not publish the hash-list contents unless the
corpus owner has confirmed that every path is safe to disclose.

## Hash Policy

Use SHA-256 for fixture and corpus identity. Benchmark reports may cite:

- Public fixture manifest id and schema version.
- Public fixture file hashes and byte counts.
- Private corpus label, private manifest hash, and raw file hash-list hash.
- Private encrypted corpus readiness status, redacted key-profile ids, and
  key-validation proof hashes when present.
- Git commit, tool versions, model/provider versions, prompt or preset id, and
  deterministic seed when relevant.

For public fixtures, reports may link to the committed manifest. For private
corpora, reports should cite hashes and aggregate stats, while keeping raw
content, local paths, and license-sensitive evidence in the runner's private
records.

If a private corpus changes, treat it as a new benchmark input unless the report
can show exactly which file hashes were added, removed, or replaced.

## Aggregate Metrics Policy

Benchmark reports can be credible without publishing raw copyrighted data when
they include stable aggregate metrics:

- Fixture or corpus labels, hashes, and schema versions.
- Counts of files, text units, protected spans, speakers, choices, images with
  text, UI labels, and runtime traces.
- Archive/encryption detector counts, helper availability counts, key-profile
  readiness counts, and key-validation pass/fail counts when private encrypted
  corpora are used.
- Source and target locales.
- Character counts, token counts, cost, latency, pass/fail counts, QA finding
  counts, severity distributions, and seeded-defect recall/precision.
- Human-evaluation sample counts and anonymized score distributions.

Private reports must not include raw strings, screenshots, extracted tables,
dialogue examples, filenames that reveal restricted content, or tiny histogram
bins that effectively disclose individual source lines. When an example is
needed in a public report, use a public fixture.

## Review Checklist

Before merging fixture or corpus changes:

1. Run `pnpm exec node fixtures/validate-public-manifests.mjs`.
2. Run `git check-ignore -v fixtures/private-local/example-corpus/manifest.json`
   and confirm the path is ignored.
3. Run the spec verification commands for the change, including `just check`.
4. Review new committed files for copyrighted raw assets.
5. Confirm public CI can run with only committed public fixtures.
