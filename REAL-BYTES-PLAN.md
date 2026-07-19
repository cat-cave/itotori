# Patchback produce + download — real-bytes proof & wiring notes

## What this node adds

A real API mutation that TRIGGERS the native patchback (`kaifuu patch`) over a
run's accepted outputs and streams back the produced, playable patched build:

- `POST /api/patchback/produce` → `application/x-tar` (produce-and-download in one call).
- Server handler: `apps/itotori/src/server.ts` `servePatchbackProduceRequest`.
- Service: `apps/itotori/src/play/patchback-produce-service.ts` `PatchbackProduceService.produceArchive`
  → `apps/itotori/src/patchback/produce-build.ts` `produceNativePatchbackBuild`
  → `runNativePatchbackApply` (the SAME native apply seam the CLI/tests use; spawns `kaifuu patch`)
  → `createDeliveredPatchArchive` (the SAME archiver the durable delivery route uses).
- UI: `apps/itotori/src/ui/screens/PassLedgerPanel.tsx` `ProducePatchedBuildAction`
  (Produce patched build → downloads the tar).

No second/mock patchback path; the tar bytes are exactly what the byte-surgical
Kaifuu apply wrote.

## Real-bytes proof — the EXACT command that was run

Native binaries were built first (never trust a stale shared target dir):

```
cd /scratch/worktrees/itotori-patchback-ui
direnv exec . cargo build -p kaifuu-cli -p utsushi-cli
```

The produce path was driven end-to-end against the real Sweetie HD RealLive
min-root (READ-ONLY, never committed):

```
cd /scratch/worktrees/itotori-patchback-ui
ITOTORI_REAL_GAME_ROOT="/scratch/itotori-research/sweetie-hd/min-root" \
  direnv exec . pnpm --filter @itotori/app exec vitest run test/patchback-produce-build.test.ts
```

Title path: `/scratch/itotori-research/sweetie-hd/min-root/オシオキSweetie＋Sweets!! HD_DL版`
(the 129-unit scene-1017 min-root). The test:

1. `kaifuu extract --whole-seen` → v0.2 bridge, `utsushi structure` → structure,
   `buildFactSnapshot` → immutable snapshot, one accepted target per scoped unit.
2. `produceNativePatchbackBuild` → real `kaifuu patch` apply → a real patched game
   tree under `patchTarget/REALLIVEDATA/Seen.txt`.
3. Asserts the patched `Seen.txt` bytes DIFFER from source (a real translation was
   spliced), all four hash-bound artifact keys are present, and
   `createDeliveredPatchArchive` yields a non-empty (>1 KiB) ustar archive whose
   entries contain `REALLIVEDATA/Seen.txt`.
4. Drives the full `PatchbackProduceService.produceArchive` (what the mutation
   invokes) through an injected produce-plan loader over the same real inputs and
   asserts the same real archive.

Expected result: the env-gated test PASSES (real patched build, real downloadable
tar). When `ITOTORI_REAL_GAME_ROOT` is unset the heavy case is skipped and only
the deterministic 404-path case runs.

## Production composition follow-up (the one remaining wiring seam)

The mutation's substrate is the optional, actor-bound `patchbackProduce` port on
`ItotoriApiServices` (declared in `apps/itotori/src/api-handlers.ts`). Until it is
populated in `withDatabaseItotoriServices`, `POST /api/patchback/produce` returns
`501 not configured` (loud, never a fabricated build). Wiring it needs a real
`PatchbackProduceInputLoaderPort` that resolves a run's produce plan
(accepted outputs → `NativePatchbackInput` + the read-only source game root +
byte-fidelity scope) from the durability substrate — the same run-state read the
existing `composition/deps.ts` `patchback.buildInput(finalized)` assembles during
a live run, lifted to a post-hoc loader. This is the one boundary that needs the
run's finalized state; the byte-producing seam itself is proven real above.

Optionally, the produced `PlayablePatchExport` can also be persisted as a
`run_finalizer`-origin patch version via
`ItotoriLocalizationResultRevisionRepository` (its injected
`PlayTesterPatchArtifactMaterializer` is exactly this producer), making the build
addressable by the durable `GET /api/play/patch-versions/{id}/delivery/archive`
route in addition to the one-shot produce download. That persistence path requires
a real Postgres (`just ci-itotori`).
