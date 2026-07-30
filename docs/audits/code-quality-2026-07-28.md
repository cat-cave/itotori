# Code-quality audit — 2026-07-28

## Verdict

**Clean.** The three blocking findings were repaired and re-verified on this
branch: the retired policy surface was removed, locale-branch selection is
inferred from its declared type, and database shutdown failures now surface.

The oversized API modules and unused compiled example remain documented
non-blocking structural debt. The planning-reference guard is being repaired
on another branch and is not claimed as fixed here.

## Method and measured evidence

- Provisioned dependencies with the documented offline worktree setup.
- `just check` passed after provisioning.
- Focused dashboard audit-findings suite: 39 passed, 0 failed. Its forced
  `client.end()` rejection produced `shutdown_failed`; a query plus shutdown
  failure retained both errors.
- Focused format-stability suite: 323 passed, 0 failed. A repository search
  found no policy-module consumer after removing the barrel export, registry,
  and current policy documentation.
- The deliberate `localeBranchIdentty` mutation failed app typecheck with
  `TS2551: Property 'localeBranchIdentty' does not exist on type
'LocaleBranchStatus'. Did you mean 'localeBranchId'?`; the restored spelling
  typechecks.
- Final `vp run ts:typecheck`, TypeScript test-lane, and formatter results are
  recorded after the final rebase below.

## Verification of the eleven earlier findings

| Earlier finding                                           | Status                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped catalog-context request could lose its project     | **Verified fixed**                           | The route calls the project-required read at [api-handlers.ts:2072](../../apps/itotori/src/api-handlers.ts#L2072) and checks the returned project at [api-handlers.ts:2079](../../apps/itotori/src/api-handlers.ts#L2079). The two-project live-database test deliberately makes the other project newer and checks the requested locale at [catalog-context-project-scope-live-db.test.ts:34](../../apps/itotori/test/catalog-context-project-scope-live-db.test.ts#L34) and [catalog-context-project-scope-live-db.test.ts:68](../../apps/itotori/test/catalog-context-project-scope-live-db.test.ts#L68); it passed.                                                                                                     |
| Workflow boundary used variadic `any`                     | **Verified fixed**                           | The port now requires `projectId: string` for the scoped read at [project-operations-port.ts:81](../../apps/itotori/src/services/project-operations-port.ts#L81)-[82](../../apps/itotori/src/services/project-operations-port.ts#L82). A no-argument call to the project-required method is therefore a TypeScript error (inferred from that signature); the measured search found no `...args: any[]` in production source.                                                                                                                                                                                                                                                                                                |
| Browser response validation checked only top-level keys   | **Verified fixed**                           | The browser guard validates each nested member at [api-client-guards.ts:113](../../apps/itotori/src/api-client-guards.ts#L113)-[134](../../apps/itotori/src/api-client-guards.ts#L134). Its regression test rejects malformed nested row, release, and branch fields at [api-client-guards.test.ts:127](../../apps/itotori/test/api-client-guards.test.ts#L127)-[151](../../apps/itotori/test/api-client-guards.test.ts#L151); 5 focused tests passed.                                                                                                                                                                                                                                                                      |
| Selected-candidate lookup was copied with weakening casts | **Verified fixed**                           | One checked helper finds the selected candidate and throws on a broken invariant at [draft-artifact-bundle.ts:65](../../packages/localization-bridge-schema/src/draft-artifact-bundle.ts#L65)-[78](../../packages/localization-bridge-schema/src/draft-artifact-bundle.ts#L78). Its consumers use it directly at [exporter.ts:378](../../apps/itotori/src/patch-export/exporter.ts#L378), [preflight.ts:276](../../apps/itotori/src/patch-export/preflight.ts#L276)-[278](../../apps/itotori/src/patch-export/preflight.ts#L278), and [locale-branch-seed-fixtures.ts:197](../../apps/itotori/src/services/locale-branch-seed-fixtures.ts#L197)-[205](../../apps/itotori/src/services/locale-branch-seed-fixtures.ts#L205). |
| Catalog-context test bypassed its owner                   | **Verified fixed**                           | The live-database test drives the real request handler at [catalog-context-project-scope-live-db.test.ts:43](../../apps/itotori/test/catalog-context-project-scope-live-db.test.ts#L43)-[59](../../apps/itotori/test/catalog-context-project-scope-live-db.test.ts#L59), rather than invoking the panel helper. It passed 1/1.                                                                                                                                                                                                                                                                                                                                                                                              |
| API schema is an unbounded multi-domain boundary          | **Still open, non-blocking structural debt** | [api-schema.ts](../../apps/itotori/src/api-schema.ts) is 7,556 lines (measured). The only line-cap guard deliberately scans Rust files only at [file-line-cap-guard.mjs:25](../../scripts/file-line-cap-guard.mjs#L25)-[27](../../scripts/file-line-cap-guard.mjs#L27), so this module has no enforced shrink boundary.                                                                                                                                                                                                                                                                                                                                                                                                     |
| API handlers are an oversized all-routes switchboard      | **Still open, non-blocking structural debt** | [api-handlers.ts](../../apps/itotori/src/api-handlers.ts) is 3,678 lines (measured). The same guard excludes TypeScript by scope at [file-line-cap-guard.mjs:25](../../scripts/file-line-cap-guard.mjs#L25)-[27](../../scripts/file-line-cap-guard.mjs#L27).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Compiled API-client example had no consumer               | **Still open, non-blocking vestigial code**  | The app compiler includes every source TypeScript file at [tsconfig.json:11](../../apps/itotori/tsconfig.json#L11), while the example is mentioned only by a comment at [api-client.ts:21](../../apps/itotori/src/api-client.ts#L21). The measured repository search found no import or test of [api-client-example.ts](../../apps/itotori/src/api-client-example.ts).                                                                                                                                                                                                                                                                                                                                                      |
| Planning-reference guard excluded the primary application | **Open; repaired on another branch**         | The guard's stated scope excludes the application at [audit-no-node-ids.mjs:10](../../scripts/audit-no-node-ids.mjs#L10)-[14](../../scripts/audit-no-node-ids.mjs#L14) and its executable exclusion list repeats that at [audit-no-node-ids.mjs:28](../../scripts/audit-no-node-ids.mjs#L28)-[39](../../scripts/audit-no-node-ids.mjs#L39). That repair is outside this branch; this report does not claim it.                                                                                                                                                                                                                                                                                                              |

## Fresh findings, ranked by potential incorrect behavior

### P2 — Published retired policy API fabricated values

**Verified fixed.** The repository search found no production consumer beyond
the retired module's barrel export, stability declaration, and current policy
documentation. This branch removes all three, including
`pair-policy.v0.3.ts`, so callers cannot receive fabricated values or erased
types. [index.ts:14](../../packages/localization-bridge-schema/src/index.ts#L14)
now skips directly to its next public export, and
[format-stability.test.ts:78](../../packages/localization-bridge-schema/test/format-stability.test.ts#L78)
asserts that the retired format is absent from
[`PUBLIC_FORMAT_STABILITY`](../../packages/localization-bridge-schema/src/format-stability.ts#L196);
the focused suite passed 323/323.

### P2 — Scoped handler suppressed locale-selection typing

**Verified fixed.** The callback at
[api-handlers.ts:2086](../../apps/itotori/src/api-handlers.ts#L2086) now infers its
`LocaleBranchStatus` parameter from `localeBranches`, whose declaration remains
at [project-repository.ts:288](../../packages/itotori-db/src/repositories/project-repository.ts#L288)-[314](../../packages/itotori-db/src/repositories/project-repository.ts#L314).
The type-level identity guard and scoped-route behavior regression at
[catalog-context-project-scope-live-db.test.ts:18](../../apps/itotori/test/catalog-context-project-scope-live-db.test.ts#L18)
use `localeBranchId`; the deliberate misspelling failed typecheck with TS2551
before restoration.

## Final re-verification

- Rebased with `git rebase --autostash origin/main`; Git reported the branch
  up to date and restored the intended worktree changes.
- `pnpm exec vp run ts:typecheck` passed all 8 reported tasks.
- `pnpm exec vp run ts:test` exited 0. Its package reporters included 323
  schema tests, 67 design-system tests, and 94 runtime-review tests, all
  passing; the database scripts also reported 8/8 and 4/4 passing assertions.
- `pnpm exec vp fmt --check` printed: `All matched files use the correct format.`

## Mandatory anti-pattern checklist

Measured checks found production consumers for the required substrate slices and migration parity was included in the passing `just check` gate. No new P0/P1 code-quality finding was established from the checklist in the audited static scope. The retired policy surface was removed rather than retained as callable compatibility-shaped API.

Not examined: private real-byte runtime proofs, real-browser strict tests, a full semantic review of every existing roadmap claim, and a test-by-test classification of the entire suite. Those require a broader audit than this code-quality pass; no claim here relies on them.

## Standing-expectation applicability

No structured-data producer changed, so real-input output-population rates are
not applicable. The shutdown regression is destructive: swallowing `end()`
made 2/2 of its assertions fail before restoration. The retired-policy removal
and locale-identity fix have the scoped tests and typecheck described above.
