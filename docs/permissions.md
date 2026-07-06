# Itotori Permissions

Itotori authorization is permission-based. Callers present a user id, and mutating
repository or API code checks for the specific permission needed by that action.
Authorization checks must not branch on role names.

## Source of Truth

`packages/itotori-db/src/authorization.ts` is the source of truth for permission
values. Add, rename, or retire permission values only by changing
`permissionValues` and `allPermissions` there.

Database migrations enforce the same set through the
`itotori_user_permission_grants_permission_check` constraint. Historical
migrations are immutable once they may have been applied. When the TypeScript
permission set changes, add a new forward migration that drops and recreates
that constraint with the full current permission set instead of editing older
migrations.

The drift guard runs as part of `pnpm --filter @itotori/db test` and can also be
run directly:

```sh
pnpm --filter @itotori/db verify:permissions
```

The guard reads the TypeScript constants and the latest SQL permission check. A
permission added to TypeScript without a matching migration constraint update
fails verification.

## Local Alpha User

Local alpha mode bootstraps one user:

| User id      | Display name | Grants                |
| ------------ | ------------ | --------------------- |
| `local-user` | Local user   | All alpha permissions |

`itotori db-migrate` creates the permission tables and idempotently grants every
known permission to `local-user`. The CLI also idempotently bootstraps this user
before repository access, so the local hello-world workflow remains frictionless
after the database has been migrated.

## Permission Matrix

| Permission            | Current gate                                                                    |
| --------------------- | ------------------------------------------------------------------------------- |
| `project.import`      | Import a bridge bundle into Itotori project state                               |
| `draft.write`         | Persist draft translations                                                      |
| `patch.export`        | Persist patch export metadata                                                   |
| `runtime.ingest`      | Persist runtime verification evidence and status                                |
| `feedback.import`     | Import manual feedback and playtest notes                                       |
| `queue.manage`        | Append, claim, retry, and complete durable jobs                                 |
| `queue.read`          | Read durable queue event and job internals                                      |
| `catalog.read`        | Read catalog work identity and provenance records                               |
| `catalog.write`       | Persist catalog work identity and provenance                                    |
| `audit.write`         | Record and resolve audit findings                                               |
| `style_guide.approve` | Approve a style-guide policy version (a higher-trust action than `draft.write`) |
| `system.reset`        | Reset local hello-world persisted state                                         |

Project dashboard reads do not currently require a permission gate. Catalog
reads are gated because local corpus scan entries can carry private-library
ownership and redacted-path provenance.

## Changing Permissions

For every new permission:

1. Add the value to `permissionValues` in
   `packages/itotori-db/src/authorization.ts`.
2. Add the same value to `allPermissions` so `local-user` receives the grant.
3. Add a new numbered migration that replaces
   `itotori_user_permission_grants_permission_check` with the full permission
   set, including the new value.
4. Add or update the repository/API permission matrix tests that exercise the
   new gate.
5. Update the table above and run `pnpm --filter @itotori/db verify:permissions`
   before the broader test gate.

For a rename, keep the same workflow and include any required data migration for
existing `itotori_user_permission_grants.permission` rows before tightening the
new check constraint. For a retired permission, first remove active call sites
and grants, then add a migration that removes the value from the check
constraint. Do not weaken the constraint to an unconstrained text column.

## Future Teams

The schema stores grants by `user_id` and `permission`, not role strings. Custom
roles or teams can be added later as grant assignment helpers, for example by
adding team membership tables and deriving user grants from direct plus team
permissions. Mutation code should continue to call the authorization helper with
a typed permission value, regardless of how permissions are assigned.
