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
rule above. `scripts/audit-no-hardcoded-roles.mjs` is **AST-based**: it parses
shipped source (`apps/*/src`, `packages/*/src`, `crates/*/src`, excluding
tests/fixtures/docs) — the TypeScript compiler API for `.ts`/`.tsx`/`.js`/`.mjs`
files (mirroring `authorization-matrix.test.ts`), a pragmatic pattern-scan for
Rust `.rs` — and fails the build (non-zero) on any auth-role-name branching.

A **role read** is an identifier named `role`, any `<obj>.role` property access,
or a variable that aliases one (`const r = x.role`, `const { role } = x`). A
role-read branch is an **auth** violation (rather than a legitimate domain role)
when ANY of these hold, in these shapes:

- **comparison** — `===`/`==`/`!==`/`!=` between a role read and a string
  literal (`if (user.role === "admin")`, `if (role !== "viewer")`);
- **switch** — `switch` on a role read with string-literal cases
  (`switch (role) { case "admin": … }`);
- **lookup map** — indexing an auth-roles map by a role read (`ROLES[role]`,
  `ROLE_PERMISSIONS[actor.role]`);
- **auth-subject read** — any `<subject>.role` where the subject is an auth
  actor (`user`, `actor`, `principal`, `session`, `subject`, …), regardless of
  the compared value (the permission-based `AuthorizationActor` carries only
  `userId`);
- **name-based** — `isAdmin`/`is_admin`, `hasRole(...)`/`has_role(...)`,
  `roleValues`, `ROLES`.

The auth-vs-domain distinction is by the role VALUE, the auth-subject object, or
the map name — because the shape alone cannot tell `user.role === "admin"`
(auth) from `args.role === "draft"` (a proof stage). A role read is auth iff it
is on an auth-subject object, OR its compared/case value is a known auth role
NAME (`admin`, `owner`, `moderator`, `editor`, `viewer`, `guest`, `member`,
`superuser`, `root`, …), OR its lookup container is a known auth-roles map. The
LLM message roles (`user`, `assistant`, `system`, `tool`, …) and the domain
roles present in the tree (`draft`, `qa`, `official_translation`,
`inventory_only`, `primary`, `TextRole` enum variants, `roles[role]` /
`accepted[role]` domain maps) are therefore NOT flagged.

A genuine **domain** (non-auth) role that must branch on an auth-role-NAME value
in a domain context carries an explicit per-line marker so a reviewer can judge
each exemption individually:

```ts
// authz-guard:allow domain-role — proof stage role, not an auth role
if (role === "draft") {
```

The marker requires a non-empty token after `allow` (the convention is the
literal `domain-role` tag plus a short reason); a bare `// authz-guard:allow`
does NOT exempt. It is **expression-narrow**: it exempts only the flagged line
(inline trailing marker) or the single code line immediately below a contiguous
`//`-comment block — never a whole file or region. The two current domain-role
exemptions branch on non-auth values (`role === "draft"` /
`role === "official_translation"`) so they already pass on value; the marker
documents that intent: a provider-proof stage role
(`apps/itotori/src/provider-proof/harness.ts`) and a DLsite translation-source
role (`packages/itotori-db/src/services/catalog-recorded-importers.ts`).

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

## Permission-Set Model (auth-004)

A permission set is a **first-class, editable, data-driven** bundle — the only
thing a "role" may ever be. `ItotoriPrincipalRepository` exposes the full CRUD,
every method gated on `auth.admin` and recorded in the permission-set audit
trail (`itotori_auth_permission_set_audit_events`, migration
`0060_auth_permission_set_model`):

- `createPermissionSet` — create a named set with an initial permission list
  (`set_created`).
- `addPermissionToSet` / `removePermissionFromSet` — edit the bundle's DATA
  (`permission_added` / `permission_removed`). Because
  `resolvePrincipalEffectivePermissions` expands granted sets at check time,
  editing a **granted** set immediately changes the effective permissions of
  every principal it is granted to: adding a permission makes each grantee gain
  it, removing one makes each grantee lose it (unless still held via a direct
  grant or another set — resolution is a union).
- `renamePermissionSet` — change the label (`set_renamed`). The name is a label
  only; authorization never reads it.
- `deletePermissionSet` — remove a set (`set_deleted`).

The name is never compared in shipped code (enforced by the no-hardcoded-roles
guard above); resolution is purely by the permissions in the set.

### Delete-vs-grant semantics

Deleting a permission set is **blocked while it is still granted to any
principal**. The schema cascades a set deletion to
`itotori_auth_principal_permission_set_grants`, which would silently strip
authorization from every principal that held the set with no explicit record of
the loss. Instead of cascading, `deletePermissionSet` refuses (throws
`ItotoriPrincipalRepositoryError`) and requires the admin to revoke the grants
first, making each authorization change deliberate and individually auditable.
Once no grants reference the set, deletion proceeds. The audit row's
`permission_set_id` is a retained plain id (not a foreign key) and `set_name`
snapshots the name at deletion time, so a `set_deleted` event survives the set's
removal.

### Least-privilege seed sets (DATA)

`seedDefaultPermissionSets(db, { accountId })` materializes the least-privilege
`defaultPermissionSetSeeds` as editable data rows for an account. These are DATA,
not code constants that authorization branches on — the names (`Viewer`,
`Reviewer`, `Director`) are labels and the bundles are ordinary permission sets
an admin edits via the CRUD above:

| Seed       | Permissions                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Viewer`   | `queue.read`, `catalog.read`                                                                                                          |
| `Reviewer` | `draft.write`, `queue.read`, `queue.manage`, `style_guide.approve`                                                                    |
| `Director` | `project.import`, `draft.write`, `patch.export`, `queue.read`, `queue.manage`, `style_guide.approve`, `catalog.read`, `catalog.write` |

Seeding is a bootstrap (like `bootstrapLocalUser`), idempotent, and account
scoped (`permission-set-<accountId>-<key>`). No seed is granted `auth.admin` or
`system.reset`.

## Future Teams

The schema stores grants by `user_id` / `principal_id` and `permission`, not role
strings. Custom roles are realized as `permission_set` rows and set grants (see
the multi-user layer above); mutation code continues to call the authorization
helper with a typed permission value, regardless of how permissions are
assigned.
