# Itotori Permissions

Itotori authorization is permission-based. Callers present a user id, and mutating
repository or API code checks for the specific permission needed by that action.
Authorization checks must not branch on role names.

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

| Permission        | Current gate                                      |
| ----------------- | ------------------------------------------------- |
| `project.import`  | Import a bridge bundle into Itotori project state |
| `draft.write`     | Persist draft translations                        |
| `patch.export`    | Persist patch export metadata                     |
| `runtime.ingest`  | Persist runtime verification evidence and status  |
| `feedback.import` | Import manual feedback and playtest notes         |
| `queue.manage`    | Append, claim, retry, and complete durable jobs   |
| `catalog.read`    | Read catalog work identity and provenance records |
| `catalog.write`   | Persist catalog work identity and provenance      |
| `system.reset`    | Reset local hello-world persisted state           |

Project dashboard reads do not currently require a permission gate. Catalog
reads are gated because local corpus scan entries can carry private-library
ownership and redacted-path provenance.

## Future Teams

The schema stores grants by `user_id` and `permission`, not role strings. Custom
roles or teams can be added later as grant assignment helpers, for example by
adding team membership tables and deriving user grants from direct plus team
permissions. Mutation code should continue to call the authorization helper with
a typed permission value, regardless of how permissions are assigned.
