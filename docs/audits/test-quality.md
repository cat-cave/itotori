# Test Quality Audit — Contract vs Tautology

This audit grades the test suites of the 172 currently-`complete` DAG nodes
across `crates/`, `apps/`, and `packages/`, separating tests that defend a
behavior contract from tests that mirror what the implementation happens to
do. **No code edits in this commit** — proposals are sketches.

Counted on 2026-06-23: 641 TypeScript `it()` cases, ~1360 Rust `#[test]`
markers (including in-source `mod tests`), and 256 Rust integration tests
under `crates/**/tests/` — roughly **2,000 tests** total. The DAG marks 51
alpha-tier nodes complete; this audit focuses on the highest-stakes ones
(workflow agents ITOTORI-013/014/015/016, the RealLive chain KAIFUU-172/173/174,
KAIFUU-176 vault-source, and the catalog adapters).

A test suite where the bulk of cases run a synthetic builder, hand the bytes
to the parser that authored the builder's shape, and assert the parser
re-derives the builder's inputs is — by construction — a tautology. The
tests in `crates/kaifuu-reallive/tests/` are this pattern almost in full,
and the RealLive parser cannot in fact read the real RealLive Seen.txt I
probed against (see §B). Two more headline findings sit in the same shape:
the workflow-agent suites all gate on `FakeModelProvider` that emits a
default `[en-US] <sourceText>` echo (§C), and the `migrations.ts`
registration bug that the audit caught for ITOTORI-015/016 is exactly the
kind of bug a contract test should have caught and didn't (§D).

## A. Categorization

Categories per the task brief:

1. **Contract** — observable behavior on the public boundary; a refactor of
   the implementation does not move it. Bytes-on-the-wire / persisted-state /
   API-response assertions count.
2. **Implementation-mirror** — restates the implementation's internal
   structure (call order, helper exact-twice, struct field that exists
   because the struct was just written).
3. **Tautological** — restates the test setup; e.g. `assert!(builder.build(x).x == x)`,
   "parser reconstructs what the synthetic encoder wrote".
4. **Smoke** — minimal "doesn't crash / declares schema version".
5. **Coverage-for-coverage** — bumps line coverage without exercising
   behavior (e.g. iterates a list and asserts the iteration ran).

### Rust: `crates/kaifuu-reallive/tests/`

| File           | Tests | Contract | Impl-mirror | Tautology | Smoke | Notes                                                                                                                                                                                           |
| -------------- | ----- | -------- | ----------- | --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.rs`     | 8     | 1        | 1           | 6         | 0     | All bytes are produced by an in-file `synthetic` module that mirrors the parser's `lib.rs` documented shape. The "parses ... into structured AST" tests are the encoder fed to its own decoder. |
| `inventory.rs` | 9     | 1        | 1           | 7         | 0     | Same synthetic encoder + tiny Gameexe.ini literals (`#WINTITLE=Test\n#KOEPAC=koe.ovk`); never exposed to real Gameexe.                                                                          |
| `patchback.rs` | 13    | 4        | 1           | 8         | 0     | Some real contract (stale source hash → fatal; offset overflow → fatal; protected-span loss → fatal) but base round-trip is encoder/decoder symmetry.                                           |

Tautological example names (cite-able):

- `smoke.rs:174 parses_smoke_scene_001_into_structured_ast_with_named_opcodes`
  — `synthetic::smoke_scene_001_blob()` writes the same opcode bytes that
  `parser.rs` reads, then asserts the recovered opcode list.
- `smoke.rs:258 extracts_stable_string_slot_ids_derived_from_byte_offset`
  — computes the expected id from the same formula the parser uses.
- `inventory.rs:145 extracts_bridge_units_with_kaifuu_173_stable_slot_ids_as_source_unit_keys`
  — asserts every bridge unit's `source_unit_key` is in the parsed
  `slot_id` set, which is the parser feeding itself.

Real contract examples (kept honest):

- `smoke.rs:341 rejects_truncated_scene_with_kaifuu_reallive_truncated_scene_diagnostic`
- `smoke.rs:355 rejects_out_of_profile_input_with_kaifuu_reallive_out_of_profile_input`
- `patchback.rs` stale-hash / protected-span-loss negative cases.

### Rust: `crates/utsushi-core/tests/`

26 files, ~140 tests. The conformance harness has a meaningful contract —
`ResultOutcome` envelopes, manifest cross-validation, redaction guards.

| File                          | Tests | Contract | Impl-mirror | Tautology | Smoke | Notes                                                                                                                                                  |
| ----------------------------- | ----- | -------- | ----------- | --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine_port.rs`              | ~21   | 18       | 2           | 0         | 1     | The synthetic ports inside the file genuinely exercise the public Runner trait. Refactoring `EnginePort` shape would break these for the right reason. |
| `conformance_snapshot.rs`     | 5     | 5        | 0           | 0         | 0     | Cross-validates serialized envelopes against manifests.                                                                                                |
| `snapshot_redaction.rs`       | 5     | 5        | 0           | 0         | 0     | Real adversarial input (unredacted paths in serialized envelope must reject).                                                                          |
| `fixture_snapshot_restore.rs` | ~12   | 8        | 2           | 1         | 1     |                                                                                                                                                        |
| `recording_metadata.rs`       | ~16   | 14       | 1           | 0         | 1     |                                                                                                                                                        |
| `vfs_synthetic_package.rs`    | ~14   | 12       | 1           | 1         | 0     |                                                                                                                                                        |
| `embed_*.rs` (2 files)        | ~10   | 8        | 1           | 1         | 0     |                                                                                                                                                        |
| `replay_round_trip.rs`        | ~8    | 8        | 0           | 0         | 0     | Genuine round-trip; high value.                                                                                                                        |
| Remainder (10 files)          | ~50   | 30       | 8           | 8         | 4     |                                                                                                                                                        |

Utsushi has the best contract/tautology ratio in the workspace. Likely
because the architecture has a real seam (`EnginePort` trait) that tests
have to drive through.

### Rust: `crates/kaifuu-vault-source/tests/`

| File                             | Tests | Contract | Impl-mirror | Tautology | Smoke | Notes                                                                                          |
| -------------------------------- | ----- | -------- | ----------- | --------- | ----- | ---------------------------------------------------------------------------------------------- |
| `discovery_test.rs`              | 5     | 5        | 0           | 0         | 0     | Real SQLite + real 7z; legit contract.                                                         |
| `extraction_test.rs`             | 5     | 5        | 0           | 0         | 0     | Asserts a 7z is actually extracted; idempotency.                                               |
| `resolution_test.rs`             | 5     | 4        | 0           | 0         | 1     |                                                                                                |
| `metadata_test.rs`               | 6     | 6        | 0           | 0         | 0     | Cross-check embedded vs catalog.                                                               |
| `contract_failure_modes_test.rs` | ~8    | 8        | 0           | 0         | 0     | Path-traversal, hash mismatch, missing metadata, embedded-id mismatch. Real adversarial cases. |

Strongest test suite in the workspace by contract ratio. KAIFUU-176 actually
builds a synthetic vault with real 7z archives via `sevenz-rust2`,
real SQLite via `rusqlite`, asserts the resolver returns the same hash that
the bytes on disk produce, and includes a deliberate `by-name/` decoy that
tests verify is never read. This is the model the rest of the workspace
should imitate.

### TypeScript: `apps/itotori/test/` workflow agents

| File                                       | Tests | Contract | Impl-mirror | Tautology | Smoke | Notes                                                                                                                                   |
| ------------------------------------------ | ----- | -------- | ----------- | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `scene-summary-agent.test.ts`              | 10    | 3        | 2           | 4         | 1     | The "byte-stable prompt across calls" tests are tautological (deterministic builder is deterministic). The negative cases are contract. |
| `scene-summary-staleness.test.ts`          | 5     | 4        | 0           | 0         | 1     | Uses `InMemorySceneSummaryRepository` — never touches SQL.                                                                              |
| `character-relationship-agent.test.ts`     | 19    | 5        | 4           | 9         | 1     | Same pattern.                                                                                                                           |
| `character-relationship-staleness.test.ts` | 6     | 5        | 0           | 0         | 1     | InMemory repo.                                                                                                                          |
| `route-choice-map-agent.test.ts`           | 20    | 8        | 3           | 8         | 1     | Many negative cases (`RouteUncitedError`, `ChoiceUncitedError`, `UnknownRouteError`) are real contract.                                 |
| `route-choice-map-staleness.test.ts`       | 5     | 4        | 0           | 0         | 1     | InMemory repo.                                                                                                                          |
| `terminology-candidate-agent.test.ts`      | 19    | 7        | 3           | 8         | 1     |                                                                                                                                         |
| `terminology-candidate-staleness.test.ts`  | 5     | 4        | 0           | 0         | 1     | InMemory repo.                                                                                                                          |
| `agent-tool-registry.test.ts`              | 24    | 16       | 4           | 3         | 1     | Better contract ratio because registry has real input/output schemas.                                                                   |
| `project-workflow.test.ts`                 | 21    | 12       | 3           | 5         | 1     |                                                                                                                                         |

Tautological example: `scene-summary-agent.test.ts:84` "prompt is byte-stable
across calls" calls `buildPrompt(input)` twice and asserts identity. The
builder is a pure function; this is `f(x) === f(x)`.

Implementation-mirror example: `scene-summary-agent.test.ts:200`
`emits_no_live_provider_construction_at_import_time_live_opt_in_only`
asserts `process.env.ITOTORI_LIVE_PROVIDER` is empty — the test
literally tests that the test environment hasn't been broken. The
contract it claims to defend (no live calls in CI) is structurally
provable by other means.

### TypeScript: `packages/itotori-db/test/`

24 files, ~270 tests. These spin up real Postgres via
`isolatedMigratedContext()`. As a class they are the highest-value
TypeScript tests in the workspace.

| File                                 | Tests | Contract | Impl-mirror | Tautology | Smoke | Notes                                            |
| ------------------------------------ | ----- | -------- | ----------- | --------- | ----- | ------------------------------------------------ |
| `repository.test.ts`                 | 34    | 26       | 5           | 1         | 2     | Largest single repository test; mostly contract. |
| `catalog-repository.test.ts`         | 13    | 10       | 2           | 0         | 1     |                                                  |
| `catalog-recorded-importers.test.ts` | 14    | 11       | 1           | 1         | 1     | Reads real recorded JSON.                        |
| `style-guide-repository.test.ts`     | 7     | 6        | 1           | 0         | 0     |                                                  |
| `terminology-repository.test.ts`     | 14    | 11       | 2           | 0         | 1     |                                                  |
| `model-ledger-repository.test.ts`    | 11    | 10       | 1           | 0         | 0     |                                                  |
| Remainder (18 files)                 | ~177  | 130      | 27          | 8         | 12    |                                                  |

### TypeScript: `packages/localization-bridge-schema/test/`

| File                              | Tests | Contract | Impl-mirror | Tautology | Smoke | Notes                          |
| --------------------------------- | ----- | -------- | ----------- | --------- | ----- | ------------------------------ |
| `schema.test.ts`                  | 80+   | 70       | 5           | 5         | 0     | Mostly real schema validation. |
| `binary-patch-smoke.test.ts`      | 5     | 5        | 0           | 0         | 0     |                                |
| `conformance.test.ts`             | 18    | 16       | 1           | 1         | 0     |                                |
| `synthetic-large-project.test.ts` | 4     | 3        | 1           | 0         | 0     | Scale shape test.              |

Aggregate rough percentages across the surveyed suite:

| Category              | TS share | Rust share | Workspace estimate |
| --------------------- | -------- | ---------- | ------------------ |
| Contract              | ~62%     | ~68%       | ~65%               |
| Implementation-mirror | ~14%     | ~10%       | ~12%               |
| Tautological          | ~13%     | ~14%       | ~13%               |
| Smoke                 | ~6%      | ~5%        | ~6%                |
| Coverage-for-coverage | ~5%      | ~3%        | ~4%                |

Top three most tautological files:

1. **`crates/kaifuu-reallive/tests/smoke.rs`** — 6/8 cases are
   encoder-fed-to-its-own-decoder. The `synthetic` module re-implements
   the parser shape from `lib.rs`; the parser then decodes back to the
   inputs. Strong refactor resistance, zero real-data confidence.
2. **`crates/kaifuu-reallive/tests/inventory.rs`** — 7/9 cases use the
   same synthetic encoder. The Gameexe.ini cases use a 2-line literal
   that hits the catalogue's narrow happy path.
3. **`apps/itotori/test/character-relationship-agent.test.ts`** — ~9/19
   cases are byte-stable-prompt / deterministic-id assertions over a
   pure function whose determinism is structurally guaranteed.

## B. Missing tests by node

### KAIFUU-172 / KAIFUU-173 / KAIFUU-174 (RealLive parser chain)

**Critical finding:** The parser does not parse the real RealLive
SEEN.TXT envelope shape. The `lib.rs` documentation describes a
`u32 LE count` followed by `(u32 LE offset, u32 LE size)` entries — but
the actual RealLive Seen.txt format (verified against Sweetie HD,
3,876,496 bytes) is a **fixed-size 10000-slot header table** of
`(u32 offset, u32 size)` pairs at offset 0. Slot 0 is null.

I executed a probe binary (since removed) calling
`kaifuu_reallive::parse_archive(&fs::read(".../Seen.txt")?)` against the
real file. Result:

```
Seen.txt: 3876496 bytes
first 16 bytes: [00, 00, 00, 00, 00, 00, 00, 00, 80, 38, 01, 00, FA, 05, 00, 00]
parse_archive OK: schema_version=0.1.0 archive_byte_len=3876496 entries=0
```

The first 4 bytes are `0x00000000`. The parser interprets that as
`count = 0` and returns an empty `SceneIndex` as success. The actual
archive has 198 non-empty slots starting at slot 1 with offset 0x13880
(80000 = end of the 10000-slot header table). **The entire SEEN.TXT body
is silently discarded as an "empty archive."**

The KAIFUU-174 acceptance criterion says "engine-generic across
AVG32-variant RealLive titles, not specialized to one game." It cannot
even read one AVG32 title.

The Gameexe.ini parser fares better but barely. The same probe:

```
parse_gameexe_inventory: entries=1345 bridge_unit=0 asset_ref=17 unknown=1328 warnings=1328
```

Of 1,345 lines, only 17 (1.3%) are recognized as asset references and
**zero** as user-facing translatable strings. The first dozen warnings
are `#MEMORY`, `#DEBUG_MESSAGE_LOG`, `#DEBUG_GAMEEND_WARNING`,
`#DEBUG_WINDOW_CAPTION`, `#DEBUG_SAVE_HISTORY_CNT`,
`#DEBUG_MEMORY_WARNING_SIZE`, `#SCREENSIZE_MOD`, `#MMX_ENABLE`,
`#D3D_ENABLE` — all standard RealLive keys, all classified as Unknown.
The catalogue in `gameexe.rs:166 classify_key` recognizes only
`#WINTITLE`, `#TITLE`, `#REGNAME`, `#GAMEEXE_VERSION`, and prefixes
`#G00`, `#KOE`, `#SEEN`, `#NWK`, `#OVK`. Sweetie HD's `#WINTITLE` is
not present (no localized window title); the catalogue's two bridge
keys cover nothing.

Missing tests for KAIFUU-172/173/174:

- **Real fixture parse**: at least one test that feeds real Sweetie HD
  Seen.txt bytes (gated behind `ITOTORI_PRIVATE_CORPUS=1`) and asserts
  `entries.len() > 100`. This would have failed immediately and surfaced
  the format-shape mismatch.
- **Public-fixture distinguishability**: synthetic SEEN.TXT that exercises
  the real fixed-table-header shape. Today the synthetic encoder is a
  parallel implementation; nothing prevents both encoder and decoder from
  drifting together.
- **Adversarial envelope**: count = u32::MAX, count = 0 with non-zero
  table bytes, overlapping entry ranges, entry whose end address wraps
  on `saturating_add` — present in spirit (`InvalidArchiveEnvelope` for
  count above the ceiling) but not exhaustively.
- **Shift-JIS round-trip on real bytes**: `decode_shift_jis_slot` /
  `encode_shift_jis_slot` is tested only on tiny ASCII strings inside
  the patchback fixtures. No test takes a real Shift-JIS string from
  Sweetie HD (which contains Japanese dialogue throughout) and exercises
  the round-trip.
- **Gameexe key catalogue real-data coverage**: a recall metric against
  a real Gameexe.ini that asserts the catalogue recognizes more than
  some threshold (e.g. ≥80% of `#SEEN*`/`#KOE*`/`#G00*` keys, which it
  does), and reports the unknown-rate as a structured number rather than
  emitting 1,328 warnings.
- **Inventory walk on a non-empty archive**: every existing test runs
  the inventory walk on a single-scene synthetic archive. There is no
  test that demonstrates the walk produces N bridge units for N
  observable dialogue lines in a multi-scene archive.

### KAIFUU-176 (vault-source localCorpus adapter)

The strongest test surface in the workspace. Adversarial cases present
(`contract_failure_modes_test.rs`: path-traversal, hash mismatch,
embedded-id mismatch, missing metadata). One genuine gap:

- No test that the adapter is read-only against `/archive/vault/`. The
  declared contract says "never modifies the vault." There is no
  property test that asserts vault mtimes / contents are unchanged after
  a full discover→resolve→extract cycle. Easy add against the synthetic
  vault.

### ITOTORI-013 / 014 / 015 / 016 (workflow agents)

All four ship an in-memory repository fake and a `FakeModelProvider`.
Missing:

- **Real-DB happy path** in the agent test (today only the
  `*-repository.test.ts` files touch SQL, and they test the repository
  in isolation, not the agent + repository together). The migration bug
  (§D) would have surfaced.
- **Adversarial provider output**: today the test passes a fixed string
  through `FakeModelProvider({ generate: () => "..." })`. The provider
  contract permits the model to emit malformed JSON, JSON with extra
  fields, JSON with a citation pointing at a non-existent bridge unit,
  or JSON that breaks the schema mid-stream. The negative tests cover
  some of this (`RouteUncitedError`, `UnknownRouteError`) but not all
  (truncated JSON, unicode-bomb in `summaryText`, ten-thousand-route
  pack to test memory).
- **Concurrency**: agents are invoked from `project-workflow.ts`. No
  test exercises parallel invocation against the in-memory repo to
  catch race conditions in the staleness scan.
- **Token-budget enforcement**: agents declare `contextWindowTokens`
  and `maxOutputTokens`. No test asserts the agent refuses input that
  exceeds the context window, or that
  `inputTokenEstimate <= contextWindowTokens` is structurally
  guaranteed.

### CATALOG-008 / 009 / 010 / 011 / 012 / 013 / 065 / 069 / 070

Strong contract coverage on recorded fixtures (`fixtures/catalog-recorded-importers/`
JSON replay). Real Postgres in CI. Missing:

- **Live-API drift detector**: the recorded fixtures encode one snapshot
  of DLsite / VNDB / Steam / IGDB responses. No test fails if the real
  API has drifted (because there is no live-API CI gate, by policy).
  Acceptable, but the recorded-fixture refresh cadence should be
  surfaced and audited.
- **Fuzzy candidate quality regression**: `catalog-fuzzy-candidate-generator.test.ts`
  asserts hits/misses on a tiny synthetic set. No precision/recall
  metric over a corpus that would fail loudly if the fuzzy algorithm
  regressed.

## C. The FakeModelProvider pattern

Audited at `apps/itotori/src/providers/fake.ts` (145 LOC).

**What it does**: stores an injected `generate: (request) => string`
closure (default: returns `[en-US] ${sourceText}` or the literal
`Hello, {player}.` for one hard-coded Japanese input). Reports
deterministic token estimates from a `chars/4` heuristic. Records a
synthetic `ProviderRunRecord` with zero cost and zero latency.
Determinism is structural (pure function on input).

**Does the fake catch real bugs?**

The fake catches schema-shape bugs in the agent code:

- If the agent emits an envelope that violates its own zod schema, the
  test fails.
- If the agent fails to validate model output against its schema, a
  malformed fake response gets through and a downstream assertion fails.

The fake does NOT catch model-behavior bugs:

- Truncated JSON (model emits `{"routes":[{"routeKey":"x", "rou` and
  stops at the token budget).
- Tool-call shape drift (provider returns `tool_calls` with a mangled
  `arguments` blob).
- Cost surprise (model uses 100k tokens when caller budgeted 10k).
- Refusal text (model says "I can't help with that" in `content`).
- Provider-side rate-limit / retry behavior.

**Is there ANY test path that exercises a real LLM provider?**

No. The `OpenRouterProvider` and `LocalOpenAICompatibleProvider`
constructors are tested via a mocked `fetch` (see
`provider-abstraction.test.ts:65 fetchMock = vi.fn(async () => jsonResponse({...}))`),
which is in the same epistemic class as a fake. The
`ITOTORI_LIVE_PROVIDER=1` gate, in every CLI we checked, refuses any
non-fake family and then explicitly throws "does not yet support
provider family ... in this entry point" — see
`apps/itotori/src/agents/scene-summary/cli.ts:78`. The gate is a
denial, not a wiring.

There are no recorded provider fixtures under
`fixtures/` that show real provider HTTP envelopes. The "recorded
fixture" naming throughout `apps/itotori/test/` refers to
storefront/catalog recorded fixtures (DLsite, VNDB, etc.), not LLM
provider fixtures.

**Are the "prompt determinism" tests testing the right thing?**

Today they test "the prompt template builder is a pure function of its
input." This is a tautology because `buildPrompt` is structurally pure
— no I/O, no randomness, no `Date.now()` except via injected `now()`.
`it("is byte-stable across calls")` is asserting `f(x) === f(x)` for a
deterministic `f`.

The thing they SHOULD test: that semantically equivalent inputs produce
identical prompts (e.g. `{ glossary: [a, b] }` and
`{ glossary: [b, a] }` hash to the same value, because glossary order
should not affect prompt). The route-choice-map test gets close
(`it("orders units by sourceUnitKey regardless of input order")`), but
only along one axis. There is no test that reordering glossary terms,
swapping `priorSummary` from `undefined` to an empty record, or
permuting `bridgeUnitId` field-order in a unit produces the same
prompt hash. Each of those is a real contract.

## D. Migrations + DB tests — why didn't the suite catch the missing registration?

Two SQL migrations shipped in `packages/itotori-db/migrations/` without
being appended to the `migrations` array in
`packages/itotori-db/src/migrations.ts`:

- `0032_route_choice_maps.sql` (ITOTORI-015)
- `0033_terminology_candidates.sql` (ITOTORI-016)

Audit reports `AUDIT-ITOTORI-015-20260624T032727Z.json` and
`AUDIT-ITOTORI-016-20260624T032727Z.json` flagged both. The audit text
for 015 explicitly says: _"The 25 vitest cases all use an
`InMemoryRouteChoiceMapRepository` (see
`apps/itotori/test/route-choice-map-staleness.test.ts:14`) and never
exercise the SQL repository, so the green suite hides the gap."_

Why the suite didn't catch it:

1. The agent tests use `InMemory*Repository` fakes; they never call
   `migrate()` or run any SQL. So a missing migration cannot fail
   them.
2. The repository tests (`packages/itotori-db/test/route-choice-map-repository.test.ts`
   does not yet exist; for ITOTORI-016 there is no
   `terminology-candidate-repository.test.ts` in `packages/itotori-db/test/` either)
   were never written. Even though `repository.test.ts` is 4,222
   lines and covers many repositories, ITOTORI-015 and 016
   shipped new repository classes (`ItotoriRouteChoiceMapRepository`
   in `packages/itotori-db/src/repositories/route-choice-map-repository.ts`,
   710 LOC) with no SQL test of any kind.
3. `migrate()` itself is not exercised by a test that verifies the
   SQL file count under `packages/itotori-db/migrations/` equals the
   array length in `migrations.ts`.

**What test would have caught it?**

A `migrations-registration.test.ts` that:

- reads `packages/itotori-db/migrations/*.sql` from disk;
- reads the exported `migrations` array from
  `packages/itotori-db/src/migrations.ts`;
- asserts the on-disk filenames and the array entries match 1:1 (same
  count, same ids, same order).

Code sketch (not committed):

```ts
// packages/itotori-db/test/migrations-registration.test.ts
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

describe("migrations.ts registration", () => {
  it("registers exactly the SQL files present on disk in numeric order", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const registered = migrations.map((m) => m.file).sort();
    expect(registered).toEqual(onDisk);
  });

  it("each registered id matches its file basename without .sql", () => {
    for (const m of migrations) {
      expect(`${m.id}.sql`).toBe(m.file);
    }
  });

  it("registration order matches numeric filename prefix", () => {
    const prefixes = migrations.map((m) => Number.parseInt(m.file.split("_")[0]!, 10));
    expect(prefixes).toEqual([...prefixes].sort((a, b) => a - b));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
```

This is ~30 LOC, runs in milliseconds, requires no DB, and would have
failed the moment 0032 (or 0033) was created without being registered.
It is the canonical example of a contract test that the workspace
structurally needs.

## E. Cross-cutting findings

### Patterns of tautology

1. **Encoder/decoder symmetry as proof of correctness.** When the
   test's `synthetic` module mirrors the production parser's `lib.rs`
   shape, "decoder reconstructs what encoder wrote" provides no
   evidence about real-world inputs. Affects all of
   `crates/kaifuu-reallive/tests/`. **Closure: at least one real-bytes
   test per parser, gated behind a private-corpus env var.**

2. **Pure-function determinism asserted as "prompt determinism."**
   Affects all four workflow-agent suites (scene-summary,
   character-relationship, route-choice-map, terminology-candidate).
   `buildPrompt(x) === buildPrompt(x)` is `f(x) === f(x)`. The
   contract that matters is invariance under semantically-equivalent
   input shuffles. **Closure: rename and reshape these tests to
   property-style invariance checks.**

3. **Builder builds.** Schema validators that assert `parse(builder.build())`
   succeeds. Affects `provider-abstraction.test.ts` for several
   `descriptor` shape tests. **Closure: assert behavior the descriptor
   drives, not that the descriptor is valid.**

4. **Echo through a fake.** `FakeModelProvider({ generate: () => "x" })`
   then `expect(result.summary.summaryText).toBe("x")`. **Closure:
   convert echo cases into negative cases (fake emits malformed shape;
   agent rejects).**

### Patterns of mock-overuse

1. **InMemory repositories everywhere**. Eight `In*Repository` classes
   in `apps/itotori/test/` and (as noted in §D) the green suite hides
   migration regressions. **Closure: every agent that ships a SQL
   repository must have one end-to-end test that runs against a real
   migrated database. The infrastructure exists
   (`isolatedMigratedContext`); it just is not used in the agent test
   files.**

2. **`vi.fn() as typeof fetch`**. The OpenRouter provider tests mock
   `fetch` and assert the call shape. This catches client-side
   serialization bugs but not real OpenRouter envelope drift. Audit
   the recorded-fixture corpus (does not exist yet) and add a single
   real-recording per provider family. The provider contract
   already permits this.

3. **Synthetic ports for `EnginePort` conformance.** `engine_port.rs`
   defines its `ReferencePort`, `MissingObservePort`, etc. inline. This
   is necessary because the trait has no production implementation yet
   (it predates KAIFUU-174). After KAIFUU-174 lands a real port the
   conformance test should run against it too — today it does not.

### Structural gaps

1. **No real-corpus test gate.** The repo declares the policy of
   "private local corpora can support local benchmark work, but
   committed tests must not point at them"
   (`docs/testing-standard.md:108-110`). The test infrastructure has no
   counterpart that lets a developer say "this test SHOULD run when
   `/scratch/itotori-research/sweetie-hd/` exists and skip otherwise."
   Closure: add an `env-gated test` helper that skips with a clear
   reason and a CLI command (`just test-private`) that runs the gated
   set. Without it, the only way to catch the RealLive Seen.txt
   regression is the kind of ad-hoc probe this audit just ran.

2. **No multi-component integration test.** The DAG describes a
   discover → resolve → extract → detect → parse → inventory → patch-back
   chain. There is no single test that runs the whole chain on one
   input. Closure: a single round-trip integration test against the
   `kaifuu-vault-source` synthetic vault that drives
   `kaifuu-reallive` end-to-end.

3. **No SQL-vs-InMemory parity test.** Every InMemory repository is
   hand-written to "look like" the SQL one. There is no test that the
   InMemory and SQL implementations behave identically on the same
   sequence of operations. Closure: a parity property test per
   `RepositoryPort` interface.

## F. Concrete proposals

Ten new tests, ordered by risk-closure value.

### F.1 Real RealLive Seen.txt opens (gated)

- **File**: `crates/kaifuu-reallive/tests/real_corpus_smoke.rs`
- **Test**: `parses_oshioki_sweetie_hd_seen_txt_into_non_empty_scene_index_when_corpus_available`
- **Gate**: `cfg(feature = "private-corpus")` or env-skip at
  `ITOTORI_PRIVATE_CORPUS != "1"`.
- **Asserts**: `parse_archive(&fs::read(seen_path)?)` returns a
  `SceneIndex` with `entries.len() > 100`. Asserts a sampled entry's
  byte range is well-formed (`offset >= header_end && offset + len <=
archive_bytes.len()`). Currently `entries.len() == 0`. Closes the
  single most consequential gap in the workspace.
- **Input**: Sweetie HD `/scratch/itotori-research/sweetie-hd/extracted/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt`.

### F.2 Migrations registration parity

- **File**: `packages/itotori-db/test/migrations-registration.test.ts`
- **Test**: `registers_exactly_the_sql_files_present_on_disk_in_numeric_order`
- **Asserts**: per §D code sketch. SQL files in `migrations/` map 1:1
  to entries in `migrations` array; ids and order match.
- **Input**: filesystem read at test time. No DB.
- **Closes**: the bug already shipped twice (ITOTORI-015, 016).

### F.3 Gameexe real-corpus recall metric (gated)

- **File**: `crates/kaifuu-reallive/tests/real_corpus_gameexe_recall.rs`
- **Test**: `recognizes_at_least_eighty_percent_of_real_gameexe_seen_g00_koe_keys_in_sweetie_hd`
- **Gate**: same private-corpus env.
- **Asserts**: of all Sweetie HD Gameexe.ini entries whose key starts
  with `#SEEN`, `#G00`, `#KOE`, `#NWK`, or `#OVK`, at least 80% are
  classified as `AssetReference` (not `Unknown`). Today the probe shows
  17 matched of 1,345 lines — but the prefixes do match where present
  in Sweetie HD, so this test should pass and stays as a regression
  guard.
- **Input**: Sweetie HD Gameexe.ini.
- **Closes**: future drift in `classify_key` rules.

### F.4 Migration-aware agent integration test

- **File**: `apps/itotori/test/route-choice-map-integration.test.ts`
  (and three siblings: scene-summary, character-relationship,
  terminology-candidate).
- **Test**: `route_choice_map_agent_persists_a_fresh_map_through_real_postgres_when_migrations_are_registered`
- **Asserts**: with `isolatedMigratedContext()` + the real
  `ItotoriRouteChoiceMapRepository`, calling
  `generateRouteChoiceMap` once writes rows visible to a follow-up
  `loadByRevision` query. Today this would have FAILED at
  `relation "itotori_route_maps" does not exist` until the orchestrator
  patched migrations.ts after the fact. Per-spec branches now have a
  gating test.
- **Input**: synthetic Japanese fixture (existing
  `inputFixture()` from `route-choice-map-agent.test.ts`).
- **Closes**: hidden migration regressions; SQL repository assumed-equivalent
  to in-memory.

### F.5 InMemory ↔ SQL repository parity

- **File**: `packages/itotori-db/test/repository-parity.test.ts`
- **Test**: `in_memory_and_postgres_route_choice_map_repository_agree_on_save_then_load_round_trip`
  (and siblings per repository).
- **Asserts**: same input sequence to both implementations produces
  the same `RouteChoiceMapRecord` (modulo timestamps).
- **Input**: a 20-step canonical sequence of save/loadByX/markStale.
- **Closes**: the latent risk that "passing in-memory tests" implies
  "passing SQL tests."

### F.6 Vault read-only invariant

- **File**: `crates/kaifuu-vault-source/tests/read_only_invariant_test.rs`
- **Test**: `discover_resolve_extract_cycle_never_modifies_vault_root`
- **Asserts**: snapshot every file mtime + sha256 under `vault_root`
  before the cycle; assert all unchanged after. Walk the by-name decoy
  too; verify it is never touched.
- **Input**: synthetic vault (existing `SyntheticVault::build`).
- **Closes**: the contract claim in KAIFUU-176 ("never modifies the
  vault") that today is asserted in prose but not in code.

### F.7 Prompt invariance over input shuffles

- **File**: `apps/itotori/test/scene-summary-prompt-invariance.test.ts`
  (and three siblings).
- **Test**: `prompt_hash_is_invariant_under_unit_shuffle_and_glossary_shuffle_and_field_reorder`
- **Asserts**: with a property generator over input fixtures, the
  prompt hash is identical for every permutation of `units[]`,
  `glossaryExcerpt[]`, and for every JSON-field-order rotation of the
  unit shape. Today's "byte-stable across calls" test is the trivial
  axis (one input, two calls); this test enforces the real contract
  (input shape canonicalization).
- **Input**: fast-check generator from existing `unitsFixture()`.
- **Closes**: the tautological prompt-determinism cluster.

### F.8 Adversarial provider output

- **File**: `apps/itotori/test/route-choice-map-adversarial-provider.test.ts`
- **Test**: `rejects_truncated_json_with_route_choice_map_parse_error` and four
  siblings: malformed UTF-8 in `summaryText`, citation pointing at a
  bridge unit not in the input, ten-thousand-route response (memory),
  schema-extra-fields strict-mode check.
- **Asserts**: each malformed payload produces the documented error
  class (`RouteChoiceMapParseError`, `RouteUncitedError`, etc.) and
  never persists a partial record.
- **Input**: hand-crafted JSON strings; no live calls.
- **Closes**: §C model-behavior-bug class.

### F.9 RealLive multi-scene archive end-to-end

- **File**: `crates/kaifuu-reallive/tests/multi_scene_archive.rs`
- **Test**: `parses_archive_with_three_scenes_and_distinct_string_slot_ids_across_scenes`
- **Asserts**: builds a synthetic envelope with 3 scenes, parses each,
  and asserts the `scene_id` formula and `slot_id` formula yield 0
  collisions across scenes. Today every test runs the inventory walk on
  a one-scene archive.
- **Input**: synthetic three-scene fixture.
- **Closes**: the silent assumption that scene-id derivation works for
  N > 1.

### F.10 Engine-port conformance against the real port

- **File**: `crates/kaifuu-reallive/tests/engine_port_conformance.rs`
  (new — does not exist).
- **Test**: `kaifuu_reallive_when_wrapped_in_an_engine_port_adapter_satisfies_utsushi_core_engine_port_conformance`
- **Asserts**: runs the `utsushi_core::port::conformance` harness
  against the kaifuu-reallive port (today the parser is library-only;
  the port adapter has not been written, but that's the gap to close
  before claiming KAIFUU-174 satisfies the "engine-port" path).
- **Input**: the same synthetic SEEN fixtures the parser already uses.
- **Closes**: the path between the parser and the runtime substrate
  that is currently asserted only in prose.

---

Filed by the test-quality subagent, no code changes attached.
Cross-references: `docs/testing-standard.md`,
`docs/audits/dag-critique.md`,
`roadmap/audits/AUDIT-ITOTORI-015-20260624T032727Z.json`,
`roadmap/audits/AUDIT-ITOTORI-016-20260624T032727Z.json`,
`roadmap/audits/AUDIT-KAIFUU-174-20260623T201439Z.json`.
