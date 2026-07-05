# Shared Contract Compatibility

SHARED-010 validates the committed v0.2 contract fixture suite in both
TypeScript and Rust.

## Commands

```sh
just contract-validate
pnpm --filter @itotori/localization-bridge-schema test
cargo test -p kaifuu-core shared_contract_fixture_suite
```

`just schema`, `cargo test --workspace`, and `pnpm exec vp run ts:test` remain
the spec verification targets.

## Report

The machine-readable compatibility report is committed at:

```txt
packages/localization-bridge-schema/test/examples/contract-compatibility-v0.2.json
```

It documents compatible TypeScript and Rust validators for bridge, patch export,
patch result, delta metadata, runtime evidence, benchmark report, asset policy,
triage/finding, standalone finding, contract manifest/report, and
permission/local-user fixtures. Invalid fixtures are listed in
`contract-fixtures-v0.2.json` and must fail with semantic errors in both
languages.

## RFC3339 timestamp acceptance parity

`SHARED-019` locks the Rust and TypeScript contract validators to the same
RFC3339 date-time instant acceptance rule. The canonical rule, deliberate
decisions (leap seconds rejected), and the shared semantic rejection code
`itotori.contract.rfc3339_instant_malformed` are documented in
[`docs/contracts/rfc3339-instant-acceptance.md`](contracts/rfc3339-instant-acceptance.md).
The shared accept/reject matrix at
`packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json`
is run through both validators
(`cargo test -p kaifuu-core rfc3339_instant_parity_matrix_matches_typescript_validator`
and `packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.test.ts`).
