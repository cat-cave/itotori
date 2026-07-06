# Itotori DB

Typed Postgres persistence for Itotori catalog identity, source provenance, local scans, seed targets, projects, source bundles, locale branches, findings, events, artifacts, and permission primitives.

This package owns migrations, Drizzle table mappings, connection management, and repositories. Application code should depend on repositories rather than issuing ad hoc SQL.

Mutating repositories require a permission-checked actor. See
`docs/permissions.md` for the current permission matrix and alpha/local
bootstrap actor model.

## Testing

The DB-backed test suites require a live Postgres instance. The connection
string MUST be provided via the `DATABASE_URL` environment variable.

`DATABASE_URL` is a hard requirement, not an optional gate: running the suite
without it does NOT silently skip the DB-backed tests. Instead the tests fail
loud with the canonical error

```
DATABASE_URL is required for DB-backed repository tests
```

(thrown from `test/db-test-context.ts`) before any DB-backed test body runs.
No suite is allowed to use a `describe`-level conditional-skip gate on
`DATABASE_URL`; the `test/db-failure-discipline.test.ts` guard enforces this so
a missing environment variable can never masquerade as a passing run. CI sets
`DATABASE_URL` for the db test lane so the suite never falls through.
