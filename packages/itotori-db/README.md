# Itotori DB

Typed Postgres persistence for Itotori catalog identity, source provenance, local scans, seed targets, projects, source bundles, locale branches, findings, events, artifacts, and permission primitives.

This package owns migrations, Drizzle table mappings, connection management, and repositories. Application code should depend on repositories rather than issuing ad hoc SQL.

Mutating repositories require a permission-checked actor. See `docs/permissions.md` for the current permission matrix and MVP local-user baseline.
