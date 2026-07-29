# Localizing a RealLive corpus

This is the operator path for a corpus the operator is entitled to modify. Keep
the source tree read-only and create the patched build and every extracted
artifact outside this checkout. Do not commit retail bytes, output builds,
credentials, or provider logs.

The production path is:

```text
extract → structure export → source wiki and localization
→ accepted outputs in Postgres → Produce patched build → re-extract and verify
```

## Configuration boundary

Environment variables are closed deployment inputs for the person hosting the
application. Their complete allowlist is
[`config/environment-registry.json`](../config/environment-registry.json), and
the generated [`.env.example`](../.env.example) is the operator reference. The
loader rejects undeclared inputs.

Do not create a per-corpus environment variable, a title-specific path
variable, or numbered localization variables. A locale, corpus identity, source
and build path, production policy, revision, or spending choice a translator
might change belongs in application configuration or command arguments. An
environment value is appropriate only for a deployment secret or host-owned
mount/storage root declared in the registry.

## Operator sequence

1. Provision the native dependencies and a migrated database for the deployment.
   `itotori init` owns guided local configuration; it does not make a corpus
   path or localization preference an environment variable.
2. Extract the selected source scope into a bridge bundle. For RealLive, the
   command requires an engine, source root, corpus identity, source locale, and
   exactly one scope.
3. Derive narrative structure from the exact source bundle. The structure export
   accepts the direct engine metadata paths and an output path; it can include
   the bridge bundle.
4. Build the source wiki and run localization using the same bridge and
   structure. Production requires the configured provider, database, and field
   cipher. The localization summary is redacted evidence, not patch input.
5. Produce the persistent writable build from accepted outputs. Studio’s
   **Produce patched build** path owns the database-backed production input.
   The lower-level `patch produce` command only accepts a serialized
   `NativePatchbackInput`; never pass it a localization run summary.
6. Re-extract the writable build and compare it to the source bridge. Report
   changed target units, unchanged unit texts, and protected spans preserved
   byte-for-byte for the corpus and scope actually exercised.

The installed CLI is the flag authority. These help commands were verified
against the built CLI and are the safe starting point for an operator with the
required private inputs:

```sh
itotori extract --help
itotori structure-export --help
itotori localize --help
itotori patch produce --help
```

## Boundaries and failure meaning

- Missing configured deployment input, migration, accepted output, or matching
  source hash is a configuration or integrity failure, not a successful no-op.
- The source contains the script text needed for patching. Missing accepted
  output is run-state or implementation work, not evidence that the source
  lacks data.
- A patch receipt proves persistent-build production only. Runtime replay and
  rendering require their own evidence.

See [native dependency provisioning](native-deps-provisioning.md),
[fixture policy](fixtures-and-corpora.md), and
[runtime fidelity policy](utsushi-fidelity-policy.md).
