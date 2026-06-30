# Testing Standard

> **Alpha definition (2026-06-24).** The redefined alpha gates live at the top
> of [`alpha-localization-project-readiness.md`](project-readiness.md).
> "Alpha proof" mentions below refer to the `ALPHA-009` workflow and the
> SHARED-025 manifest contract — mechanisms that support the redefined
> dogfood point, not the alpha gate itself. Per the multi-game and
> no-legacy-compat standing rules, real-bytes assertions on at least two
> games of the same engine family supersede synthetic author-fixture smokes
> wherever both exist; the kaifuu-reallive 47-byte synthetic smokes are
> scheduled to be replaced by real-bytes assertions gated on the documented
> env vars.

This standard defines how Itotori, Kaifuu, and Utsushi tests describe behavior,
use fixtures, and keep CI deterministic. It applies to TypeScript packages run
through Vitest/Vite+, Rust crates run through Cargo, Drizzle/Postgres repository
tests, MSW-backed app tests, and shared fixture contracts.

## Goals

- Test observable behavior before implementation details.
- Make fixture provenance, hashes, and update intent reviewable.
- Keep public CI offline, deterministic, and free of live provider calls.
- Use property and mutation testing for high-risk invariants without making
  every package slower by default.
- Avoid test pyramid drift: many fast contract/unit tests, focused repository
  and adapter integration tests, and a small number of end-to-end fixture loops.

## Command Surface

The root `justfile` is the shared command surface:

| Command                  | Purpose                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just check`             | Fast local gate: Vite+ metadata, roadmap validation, public fixture manifest validation, toolchain policy, TypeScript typecheck, Rust format check, and Cargo check. |
| `just test`              | Runs TypeScript Vitest suites through Vite+ and Rust `cargo test --workspace`.                                                                                       |
| `just ci`                | Full CI gate: check, build, DB migration, tests, clippy, and cargo-deny.                                                                                             |
| `just fixtures-validate` | Validates committed public fixture manifests and hashes.                                                                                                             |
| `just roadmap-validate`  | Validates the machine-readable spec DAG and audit report examples.                                                                                                   |

Package-level commands are allowed for tight loops, but PR verification should
name the root command that protects the changed behavior.

`just alpha-proof` and the GitHub Alpha Proof workflow are the required
integration checks (`ALPHA-009` retired the literal Hello World workflow). The
gate validates bridge, patch, provider proof, benchmark, runtime evidence,
dashboard/read-model, and SHARED-025 manifest linkage for the same fixture
identity, source revision, and locale branch; it is not a success-string smoke.
`just hello` remains only as a compatibility alias that delegates to
`just alpha-proof` for roadmap nodes that still declare it, and cannot diverge.

## Behavior Naming

Prefer test names that read like a behavior claim a reviewer can falsify:

- TypeScript: `it("renders DB-backed hello-world status from the API", ...)`.
- Rust: `fn extracts_bridge_units_from_public_fixture()`.
- DB: `it("persists and reads hello-world status against Postgres", ...)`.
- API/UI with MSW: `it("renders runtime evidence returned by the status API", ...)`.
- Round-trip: `fn patches_then_verifies_the_public_fixture_without_losing_spans()`.

Use this grammar when it fits:

```txt
<observable result> when <meaningful condition>
rejects <invalid input> when <contract rule is broken>
preserves <domain invariant> across <operation>
```

Avoid names such as `works`, `calls helper`, `sets state`, `handles data`, or
names that only restate the function name. A test name should mention the user,
contract, fixture, repository, adapter, or API behavior that matters.

Given/When/Then language is useful as structure, not ceremony. Use comments or
local variable names when they clarify a larger test:

```ts
it("renders DB-backed hello-world status from the API", async () => {
  const givenApiUrl = "http://itotori.test/api/hello/status";
  const root = document.createElement("div");

  await renderDashboard(root, givenApiUrl);

  expect(root.textContent).toContain("hello_world_passed");
});
```

Do not require Gherkin feature files unless a future runner consumes them. For
most code, Arrange/Act/Assert with behavior names is enough.

## Test Shape

Each test should have one primary behavior and a small set of contract-level
assertions. It may assert several fields when those fields define the same
observable result, such as a dashboard status card or a persisted read model.

Use public APIs, CLI boundaries, repository methods, adapter traits, schema
guards, or rendered DOM output as assertion points. Avoid assertions on private
helper call order, incidental SQL text, CSS implementation details, generated
timestamps, or exact serialized whitespace unless that is the contract.

Negative tests are required when a contract can fail in a meaningful way:
invalid schema payloads, stale patch hashes, missing protected spans, unknown
engine capabilities, rejected repository inputs, permission failures, and API
error responses.

## Fixture Layers

Fixtures should be layered by reuse and legal risk:

| Layer                 | Use                                                                                             | Rules                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline literals       | Tiny behavior examples inside a single test.                                                    | Keep them readable and synthetic. Do not paste real game text.                                                                                                                      |
| Test builders         | Repeated valid bridge, patch, runtime, or DB objects.                                           | Put shared TypeScript builders in a dedicated workspace package when duplication crosses packages. Rust builders should live in the crate test module or a dedicated fixture crate. |
| Public fixtures       | Cross-package, cross-language, or golden behavior.                                              | Raw files must be synthetic, public domain, or redistributable, and have a manifest under `fixtures/public/` that passes `just fixtures-validate`.                                  |
| Golden artifacts      | Expected bridge bundles, patch exports, runtime reports, deltas, or normalized UI/API payloads. | Store only stable, reviewed artifacts with schema versions and fixture hashes. Prefer semantic JSON comparison over broad snapshots.                                                |
| Private local corpora | Purchased games, licensed sets, and benchmark evidence that cannot be redistributed.            | Keep them under `fixtures/private-local/`, ignored by git. CI must pass when the directory is absent.                                                                               |

Public CI may depend only on committed source, committed public fixtures, and
their public manifests. Private local corpora can support local benchmark work,
but committed tests, manifests, and package metadata must not point at them.

## Golden Fixture Policy

Golden fixtures are contract evidence, not a shortcut around assertions. Add or
update a golden only when the exact artifact matters to compatibility, review,
or cross-language parity.

Golden tests must:

- Cite the public fixture id or input file.
- Include or derive the schema version and input hash.
- Normalize volatile fields such as timestamps, absolute paths, generated temp
  roots, host names, and nondeterministic IDs unless those fields are the
  behavior being tested.
- Assert the semantic payload before or while comparing the golden.
- Have review text explaining whether the update is caused by a schema change,
  adapter behavior change, fixture correction, or expected formatting change.

Avoid brittle snapshots of whole DOM trees, large logs, or provider output.
Prefer targeted DOM assertions, schema validation, stable JSON fixtures, and
hash comparisons for binary or large artifacts.

## TypeScript And Vite+

TypeScript tests use Vitest. Vite+ is the workspace task runner for package
typecheck, tests, and builds. Use package-local tests for package behavior and
root `just` recipes for verification.

TypeScript app tests should:

- Use `jsdom` only for browser-facing behavior.
- Render through exported app functions or components rather than private
  helpers.
- Assert visible text, accessible state, emitted API calls, or schema-validated
  payloads.
- Keep provider/model behavior behind fake providers, recorded fixtures, or MSW.

Example app behavior:

```ts
describe("Itotori dashboard", () => {
  it("renders DB-backed hello-world status from the API", async () => {
    await renderDashboard(root, "http://itotori.test/api/hello/status");

    expect(root.textContent).toContain("hello_world_passed");
    expect(root.textContent).toContain("1/1 translated");
  });
});
```

## MSW API Tests

Browser and dashboard tests must not call a live local or remote API. Use MSW to
serve API responses in Vitest:

```ts
const server = setupServer(
  http.get("http://itotori.test/api/hello/status", () =>
    HttpResponse.json({ finalStatus: "hello_world_passed" }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

MSW handlers should mirror real API shapes and, when schemas exist, validate the
same request and response contracts as the server. Configure new suites with
`onUnhandledRequest: "error"` so unmocked network calls fail immediately.

## DB Repository Tests

Drizzle/Postgres repository tests verify persistence behavior that pure unit
tests cannot cover: migrations, foreign keys, inserts, updates, reads, and read
models. They should stay focused on repository contracts rather than app flows.

Repository tests must:

- Require `DATABASE_URL` and make the absence explicit.
- Run migrations or depend on a migration fixture created by the test command.
- Reset only the tables or project IDs owned by the test.
- Use deterministic IDs and synthetic bridge/runtime payloads.
- Close database connections in `finally`.
- Assert repository output and important persisted state, not Drizzle internals.

The current `@itotori/db` repository test is the model: migrate, create a
database context, reset test state, save an imported project, save drafts and
runtime evidence, then assert the hello-world status read model.

## Rust Adapter Tests

Rust tests run through Cargo and should use normal `#[test]` functions unless a
future crate needs an async or property-test harness. Name tests in snake case
with the behavior first:

```rust
#[test]
fn extracts_bridge_units_from_public_fixture() {
    let extraction = FixtureAdapter
        .extract(ExtractRequest {
            game_dir: Path::new("fixtures/hello-game"),
        })
        .unwrap();

    assert_eq!(extraction.bridge.extractor_name, "kaifuu-fixture");
}
```

Adapter tests should cover:

- Extraction from a public fixture into the shared bridge contract.
- Patching from a schema-valid patch export into a temp output directory.
- Verification of the patched output.
- Negative cases for malformed source files, stale patch inputs, unsupported
  assets, encoding errors, and protected-span corruption.
- Round-trip behavior: extract, patch unchanged or translated text, verify, and
  compare stable hashes or normalized payloads.

Use temp output directories for generated files. Do not write back into
`fixtures/hello-game` or `fixtures/public`.

## Fixture Round-Trips

Round-trip tests are the highest-value integration tests for the suite. A public
fixture round-trip should prove the contract across at least these boundaries:

1. Kaifuu extracts a public fixture into a bridge bundle.
2. Itotori imports or validates the bridge and creates deterministic draft or
   patch data.
3. Kaifuu applies the patch into a temp output directory.
4. Kaifuu verifies the patched output and records stable hashes.
5. Utsushi fixture adapters produce trace or frame evidence when the spec needs
   runtime coverage.

Round-trips should assert stable domain facts: unit counts, source and target
locales, protected span preservation, patch entry identity, status values, schema
versions, and hashes. Do not compare unrelated formatting, temp paths, or
machine-local runtime details.

## Localization Quality Benchmarks

Localization quality tests and benchmark fixtures use the `itotori-lqa-1`
taxonomy from
[ADR 0003](adrs/0003-localization-quality-taxonomy.md) and
[localization-quality-taxonomy.json](localization-quality-taxonomy.json).

Do not use DAG or audit `P0`-`P3` values as translation quality severities.
Tests that create localization findings must use `qualitySeverity` values
`critical`, `major`, `minor`, or `neutral`, and must keep the orchestration
`severity` field separate when a triage or audit contract also needs one.

Seeded-defect fixtures should be small, explicit, and oracle-backed. Each seed
record should name:

- fixture or corpus id and target locale;
- affected bridge unit, span, asset, or runtime evidence id;
- seed kind from the taxonomy;
- category, subcategory, quality severity, and expected root cause;
- expected detector families, such as deterministic QA, LLM QA, patch verify,
  runtime probe, or human review;
- expected evidence fields and accepted near-match rules;
- whether the seed is public or private-local.

QA-agent tests must score findings against adjudicated or seeded truth, not
against model confidence. Required aggregate metrics are seeded recall, seeded
precision, human-confirmed precision when human review is present, category
accuracy, quality-severity accuracy, root-cause accuracy, critical recall, and
unscorable rate.

A finding is unscorable when it lacks any required taxonomy field, concrete
evidence, affected subject reference, or adjudication state. Tests should fail
on unscorable findings before computing precision or recall.

Benchmark reports should aggregate counts by quality severity, category, root
cause, detector kind, and adjudication state. A single quality score is allowed
only as a dashboard trend field; tests must still assert the structured
distribution because it is the repairable evidence.

## Property Testing

Property tests are for invariants that are easy to under-sample with examples.
They are especially useful for:

- Protected span preservation and index math.
- Source hash and stale patch rejection rules.
- Delta apply/reverse/apply-idempotence behavior.
- Schema round-trips where field ordering or optional fields should not change
  meaning.
- Encoding and path normalization rules.

Property tests should start small and deterministic, with fixed seeds or printed
seeds on failure. They belong in normal CI only when they are fast and stable.
Larger generators, broad corpus sweeps, and stress properties should be opt-in
until a dedicated quality-gate node adds thresholds and scheduling.

## Mutation Testing

Mutation testing checks whether the assertions would catch plausible bugs. It is
not a replacement for behavior tests and should not be applied uniformly.

Use mutation testing for high-risk, compact logic:

- Schema guards and negative validation.
- Protected span mapping.
- Patch eligibility and stale-hash checks.
- Permission gates and policy decisions.
- Delta package apply logic.

Mutation testing is a targeted quality audit until a dedicated gate exists. Do
not add broad mutation thresholds to `just check` or `just ci` without measuring
runtime and false-positive cost. A mutation report should name surviving mutants,
the missing behavior assertion, and whether the fix is a test, clearer code, or
a deliberate equivalent mutant.

## No-Live-API CI Rule

Public CI, `just check`, `just test`, `just ci`, unit tests, repository tests,
dashboard tests, roadmap validation, and fixture validation must not require or
perform live calls to model providers, paid APIs, local developer services, or
remote game services.

Allowed in CI:

- Fake providers.
- MSW handlers.
- Local Postgres started by the CI job.
- Public fixtures and committed manifests.
- Recorded, sanitized, redistributable response fixtures.

Not allowed in CI:

- Reading provider credentials from `.env` or local secret files.
- Failing because a provider key is absent.
- Calling OpenRouter, OpenAI, Anthropic, Google, model routers, storefronts, or
  other remote APIs.
- Reaching `fixtures/private-local/`.
- Writing raw provider logs, raw private corpus text, screenshots, or paid API
  payloads into committed paths.

Live provider experiments are opt-in local work under the provider policy in
`docs/orchestration-operating-model.md`. They may use credentials already loaded
by the user or explicitly loaded from approved local-only env sources, record
provider/model/cost metadata in ignored artifacts, and commit only sanitized
summaries or public fixtures.

## Review Checklist

Before merging testing changes:

1. Test names describe observable behavior.
2. Fixtures are at the lowest suitable layer and public fixtures have manifests.
3. MSW/browser suites fail on unhandled network requests.
4. DB tests isolate state and close connections.
5. Golden updates are stable, normalized, and justified.
6. Property or mutation tests target real invariants instead of blanket quotas.
7. `just roadmap-validate` and `just check` pass.
8. No committed test requires live providers, private corpora, or local-only
   credentials.
