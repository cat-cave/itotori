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
