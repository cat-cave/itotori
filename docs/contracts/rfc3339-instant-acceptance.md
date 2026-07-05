# RFC3339 Instant Acceptance (canonical, cross-language)

`SHARED-019`. Both contract validators for the shared v0.2 fixture suite —
Rust `crates/kaifuu-core/src/contracts.rs :: validate_rfc3339_instant` and
TypeScript `packages/localization-bridge-schema/src/index.ts ::
assertRfc3339Instant` — enforce the SAME RFC3339 date-time instant acceptance
rule. A timestamp accepted by one validator is accepted by the other; a
timestamp rejected by one is rejected by the other with the SAME semantic code.

## Canonical accepted form

```
YYYY-MM-DDTHH:MM:SS[.fraction](Z | (+|-)HH:MM)
```

A value is accepted if and only if ALL of the following hold:

- **Date**: 4-digit year, `-`, 2-digit month, `-`, 2-digit day; the date is a
  real Gregorian calendar date (leap years honored: `2024-02-29` is valid,
  `2026-02-29` is not).
- **Separator**: a single uppercase `T` between date and time. A space, a
  lowercase `t`, or any other separator is rejected.
- **Time**: 2-digit hour (`00`–`23`), `:`, 2-digit minute (`00`–`59`), `:`,
  2-digit second (`00`–`59`). **Seconds are required.**
- **Fractional seconds** (optional): a `.` followed by one or more ASCII
  digits, at any precision (`.1`, `.123`, `.123456`, `.123456789`, …). A bare
  `.` with no digits, or a `,` decimal separator, is rejected.
- **Timezone** (required): either an uppercase `Z`, or a numeric offset
  `(+|-)HH:MM` with offset hours `00`–`23` and offset minutes `00`–`59`. A
  lowercase `z`, a missing timezone, an offset without the `:` (`+0900`), a
  single-digit offset field, or combining `Z` with an offset (`...Z+09:00`) is
  rejected.

The acceptance decision is a pure regular-expression + numeric-range check in
both languages. TypeScript deliberately does **not** consult `Date.parse`:
its engine-defined leniency (rolling `2026-02-29` over to March, version- or
engine-specific offset handling) is a cross-language divergence hazard and is
redundant with the range checks. See "Divergence removed" below.

## Deliberate decisions

- **Leap seconds are REJECTED.** `2026-07-05T12:00:60Z` (second `60`) is
  rejected by both validators even though RFC3339 permits `:60` for leap
  seconds. Neither downstream (Rust `chrono`-free hand parser, TS numeric range)
  represents leap seconds, so the canonical set excludes them. This is the one
  place the canonical set is intentionally stricter than RFC3339. Flagged for
  review; if leap-second inputs ever appear in real bridge data this decision
  must be revisited in BOTH validators together.
- **`-00:00` is ACCEPTED.** RFC3339 assigns `-00:00` the "unknown local offset"
  meaning; both validators accept it numerically (offset hour/minute `0`).
- **Year range**: any 4-digit year `0000`–`9999` is accepted; there is no
  additional lower/upper bound beyond 4 digits and a valid calendar date.

## Semantic rejection code

Malformed / ambiguous / unsupported forms are rejected with a typed, named
semantic error carrying a single shared code (not a generic parse failure):

```
itotori.contract.rfc3339_instant_malformed
```

- Rust: `BridgeContractValidationError` with `.code() ==
Some(SEMANTIC_RFC3339_INSTANT_MALFORMED)` (`crates/kaifuu-core/src/lib.rs`).
- TypeScript: `Rfc3339InstantValidationError` with `.code ==
RFC3339_INSTANT_MALFORMED_CODE` (`packages/localization-bridge-schema/src/index.ts`).

The v0.1 conformance ingestion validator
(`packages/localization-bridge-schema/src/conformance.ts :: assertRecordedAt`)
uses the identical regular expression and range logic, so it agrees on the
accepted set; it keeps its own domain code
`itotori.conformance.recorded_at_malformed` for its `recordedAt` field.

## Parity matrix (single source of truth)

The shared accept/reject matrix is committed at:

```
packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json
```

It is executed against BOTH validators and both must agree on every row:

- Rust: `cargo test -p kaifuu-core
rfc3339_instant_parity_matrix_matches_typescript_validator`
- TypeScript:
  `packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.test.ts`

Accept rows must pass; reject rows must fail with
`itotori.contract.rfc3339_instant_malformed` in both languages.

## Divergence removed

Before `SHARED-019` the TypeScript validator had an extra `Number.isFinite(Date.parse(value))`
gate absent from the Rust validator — a latent cross-language divergence: a
value accepted by Rust could have been rejected by TypeScript if `Date.parse`
disagreed. An exhaustive sweep (all offsets, all clock fields, fraction lengths
1–30) confirmed `Date.parse` never rejected a regex+range-valid value, so the
gate was removed to make both validators share identical format+range
semantics. The TypeScript rejection path also previously threw a generic
`Error` and treated the empty string via the generic "non-empty string" guard;
both now emit the shared typed semantic error, matching Rust.
