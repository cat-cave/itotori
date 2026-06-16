# Itotori DB

Typed Postgres persistence for the Itotori hello-world state.

This package owns migrations, Drizzle table mappings, connection management, and repositories. Application code should depend on repositories rather than issuing ad hoc SQL.
