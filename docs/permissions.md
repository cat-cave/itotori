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

## No-Hardcoded-Roles Guard

A CI guard enforces the "Authorization checks must not branch on role names"
rule above. `scripts/audit-no-hardcoded-roles.mjs` scans shipped source
(`apps/*/src`, `packages/*/src`, `crates/*/src`, excluding tests/fixtures/docs)
and fails the build (non-zero) on any auth-role-name branching:

- `role === "..."` / `role == "..."` — a bare `role` variable compared to a
  string literal (`if (role === "admin")`).
- `isAdmin` / `is_admin`, `hasRole(...)` / `has_role(...)` — classic
  auth-gating shortcuts.
- `roleValues` / `ROLES` — an auth-roles enum (the shape the permission model,
  `permissionValues`, replaces).
- `actor.role` — gating on the authorization actor's role (the
  permission-based `AuthorizationActor` carries only `userId`).

Property-access comparisons such as `message.role === "user"` (a chat-message
role) or `args.role === "draft"` (a proof-stage role) are NOT flagged — they
are domain roles, not auth roles.

A genuine **domain** (non-auth) role that must branch on a bare `role` value
carries an explicit per-line marker so a reviewer can judge each exemption
individually:

```ts
// authz-guard:allow domain-role — proof stage role, not an auth role
if (role === "draft") {
```

The marker requires a non-empty token after `allow` (the convention is the
literal `domain-role` tag plus a short reason); a bare `// authz-guard:allow`
does NOT exempt. The marker may sit inline on the line or in the contiguous
comment block directly above it. The two current domain-role exemptions are a
provider-proof stage role (`apps/itotori/src/provider-proof/harness.ts`) and a
DLsite translation-source role
(`packages/itotori-db/src/services/catalog-recorded-importers.ts`).

The guard runs in `just check` (which `just ci` depends on), next to the
`audit-no-hardcoded-cost` and `audit-strictness` guards, and has a companion
regression suite at `scripts/audit-no-hardcoded-roles.test.mjs`.

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
| `queue.manage`        | Append, claim, retry, complete durable jobs; mutate reviewer-queue items        |
| `queue.read`          | Read durable queue event / job internals and browse reviewer-queue items        |
| `catalog.read`        | Read catalog work identity and provenance records                               |
| `catalog.write`       | Persist catalog work identity and provenance                                    |
| `audit.write`         | Record and resolve audit findings                                               |
| `style_guide.approve` | Approve a style-guide policy version (a higher-trust action than `draft.write`) |
| `auth.admin`          | Administer principals, accounts, permission sets, and grants (multi-user auth)  |
| `system.reset`        | Reset local hello-world persisted state                                         |

Project dashboard reads do not currently require a permission gate. Catalog
reads are gated because local corpus scan entries can carry private-library
ownership and redacted-path provenance.

Permissions are **non-hierarchical exact-match grants** (see
`requirePermission` in `packages/itotori-db/src/authorization.ts`): holding
`queue.manage` does **not** imply `queue.read`. Because of this, a `queue.manage`
action that must read the very item it mutates reads it under the **manage
scope**, not `queue.read`. The reviewer-queue repository exposes
`getItemForManage` (gated on `queue.manage`) for exactly this: the reviewer
`importRuntimeFeedback` action fetches the persisted runtime-evidence tier /
observation refs to assert the supplied evidence matches before recording the
transition. Routing that read through the public `getItem` (`queue.read`) would
couple every runtime-evidence import to a separate `queue.read` grant and
silently block a future read-restricted manage role. Public reviewer-queue
browsing still goes through `getItem` / `loadItemsByBranch` under `queue.read`.

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

## Multi-User Principal Layer

Migration `0059_auth_principal_schema` adds the multi-user identity layer
(`itotori_auth_*` tables) that extends the single-user substrate above without
replacing it. A **principal** is a human user OR a service principal; grants,
sessions, and audit rows reference a principal through one supertype id
(`itotori_auth_principals.principal_id`). `principal_kind` is an identity-TYPE
discriminator (human vs machine), **not** an authorization role — no
authorization code branches on it.

A "role", if ever named, is **only** a `permission_set`: a named, editable data
bundle of permission rows (`itotori_auth_permission_sets` +
`itotori_auth_permission_set_permissions`). A principal's effective permissions
are the UNION of its direct grants (`itotori_auth_principal_permission_grants`)
and the permissions of every permission-set granted to it
(`itotori_auth_principal_permission_set_grants`). There is no role column used
for authorization branching anywhere; authorization always resolves to an
exact-match permission via `requirePermission`. Administering this layer is
itself gated on `auth.admin` (see `ItotoriPrincipalRepository`).

## Future Teams

The schema stores grants by `user_id` / `principal_id` and `permission`, not role
strings. Custom roles are realized as `permission_set` rows and set grants (see
the multi-user layer above); mutation code continues to call the authorization
helper with a typed permission value, regardless of how permissions are
assigned.
