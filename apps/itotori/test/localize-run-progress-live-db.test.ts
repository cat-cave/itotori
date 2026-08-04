import { beforeAll, describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { handleReadOnlyItotoriApiRequest, readOnlyApiServices } from "../src/api-handlers.js";
import { runLocalizeCommand } from "../src/cli/localize-command.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import {
  commandArgs,
  commandDeps,
  deferred,
  recordedRunState,
  revision,
  hash,
} from "./recorded-localize-run.js";

import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";

const postgresDescribe = requireLivePostgres(describe);

postgresDescribe("localize run progress over Postgres", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("persists real localize transitions, billed cost, and isolated portfolio runs", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const workflow = services.projectWorkflow;
        const projectId = "localize-progress-project";
        const localeBranchId = "localize-progress-branch";
        const secondLocaleBranchId = "localize-progress-branch-two";
        await workflow.ensureRunProjectScope({
          projectId,
          localeBranchId,
          sourceRevisionId: "localize-progress-source",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          engineFamily: "synthetic_fixture",
          sourceRoot: "/fixture/localize-progress/source",
          buildRoot: "/fixture/localize-progress/build",
          extractProfile: { surface: "localize-run-progress-live-db" },
        });
        const contextSnapshot = await workflow.putContext({
          sourceLanguage: "ja-JP",
          decode: revision("a"),
          sourceUnits: [{ unitId: "localize-progress-unit", sourceHash: hash("b") }],
          facts: [
            {
              factId: "unit:localize-progress-unit",
              playOrderIndex: 0,
              routeScope: { kind: "global" },
            },
          ],
          structure: revision("c"),
          routeGraph: revision("d"),
          glossary: revision("e"),
          style: revision("f"),
          revealHorizon: { kind: "complete" },
          humanCorrections: revision("0"),
          externalSources: null,
          contextScope: "whole-game",
        });
        const localizationSnapshot = await workflow.putLocalization({
          contextSnapshotId: contextSnapshot.snapshotId,
          targetLocale: "en-US",
          localeBranchId,
          acceptedBibleHead: null,
          acceptedTargetOutputHead: null,
        });
        await workflow.ensureRunProjectScope({
          projectId,
          localeBranchId: secondLocaleBranchId,
          sourceRevisionId: "localize-progress-source",
          sourceLocale: "ja-JP",
          targetLocale: "en-GB",
          engineFamily: "synthetic_fixture",
          sourceRoot: "/fixture/localize-progress/source",
          buildRoot: "/fixture/localize-progress/build",
          extractProfile: { surface: "localize-run-progress-live-db" },
        });
        const secondLocalizationSnapshot = await workflow.putLocalization({
          contextSnapshotId: contextSnapshot.snapshotId,
          targetLocale: "en-GB",
          localeBranchId: secondLocaleBranchId,
          acceptedBibleHead: null,
          acceptedTargetOutputHead: null,
        });

        const firstReviewGate = deferred();
        const firstFinalizeGate = deferred();
        const firstPatchGate = deferred();
        const firstDraftProgressGate = deferred();
        const firstState = recordedRunState(
          firstReviewGate,
          firstFinalizeGate,
          firstPatchGate,
          firstDraftProgressGate,
        );
        const first = runLocalizeCommand(
          commandArgs(projectId, "localize-progress-run-one", localeBranchId),
          commandDeps(
            services,
            contextSnapshot.snapshotId,
            localizationSnapshot.snapshotId,
            firstState,
          ),
        );
        let second: Promise<void> | undefined;
        try {
          // The raw gates port runs only after the tracker has awaited the
          // confirmed cost observer and durably upserted drafted progress.
          // Hold there: it is the exact in-flight projection this test reads.
          await firstState.draftProgressEntered;

          const during = await workflow.loadLiveReadModel(projectId, "localize-progress-run-one");
          expect(during?.run.status).toBe("running");
          expect(during?.progress.statusCounts.drafted).toBeGreaterThan(0);
          expect(during?.progress.totalCostMicrosUsd).toBeGreaterThan(0);

          const secondState = recordedRunState();
          second = runLocalizeCommand(
            commandArgs(projectId, "localize-progress-run-two", secondLocaleBranchId),
            commandDeps(
              services,
              contextSnapshot.snapshotId,
              secondLocalizationSnapshot.snapshotId,
              secondState,
            ),
          );
          firstDraftProgressGate.resolve();
          await firstState.reviewEntered;
          firstReviewGate.resolve();
          await firstState.finalizeEntered;
          const duringQa = await workflow.loadLiveReadModel(projectId, "localize-progress-run-one");
          expect(duringQa?.progress.statusCounts.QA).toBeGreaterThan(0);

          firstFinalizeGate.resolve();
          await firstState.patchEntered;
          const duringAccepted = await workflow.loadLiveReadModel(
            projectId,
            "localize-progress-run-one",
          );
          expect(duringAccepted?.progress.statusCounts.accepted).toBeGreaterThan(0);

          firstPatchGate.resolve();
          await Promise.all([first, second]);

          const [firstLive, secondLive] = await Promise.all([
            workflow.loadLiveReadModel(projectId, "localize-progress-run-one"),
            workflow.loadLiveReadModel(projectId, "localize-progress-run-two"),
          ]);
          for (const [live, state] of [
            [firstLive, firstState],
            [secondLive, secondState],
          ] as const) {
            expect(live?.run).toMatchObject({
              status: "completed",
              leaseOwnerId: null,
              cost: { spentMicrosUsd: state.providerCallCount * 7, reservedMicrosUsd: 0 },
            });
            expect(live?.progress.totalCostMicrosUsd).toBe(state.providerCallCount * 7);
            expect(live?.progress.statusCounts.patched).toBeGreaterThan(0);
            expect(live?.progress.unitCount).toBeGreaterThan(0);
          }

          const portfolio = await handleReadOnlyItotoriApiRequest(
            { method: "GET", pathname: "/api/projects" },
            readOnlyApiServices({
              ...services,
              authorization: { requirePermission: async () => undefined },
            }),
          );
          expect(portfolio.statusCode).toBe(200);
          if (!("projects" in portfolio.body))
            throw new Error("projects.list did not return a portfolio");
          const project = portfolio.body.projects.find((entry) => entry.projectId === projectId);
          expect(project?.progress).toMatchObject({
            runCount: 2,
            runStatusCounts: { completed: 2 },
            totalCostMicrosUsd: (firstState.providerCallCount + secondState.providerCallCount) * 7,
          });

          const failedLocaleBranchId = "localize-progress-branch-failed";
          await workflow.ensureRunProjectScope({
            projectId,
            localeBranchId: failedLocaleBranchId,
            sourceRevisionId: "localize-progress-source",
            sourceLocale: "ja-JP",
            targetLocale: "fr-FR",
            engineFamily: "synthetic_fixture",
            sourceRoot: "/fixture/localize-progress/source",
            buildRoot: "/fixture/localize-progress/build",
            extractProfile: { surface: "localize-run-progress-live-db" },
          });
          const failedLocalizationSnapshot = await workflow.putLocalization({
            contextSnapshotId: contextSnapshot.snapshotId,
            targetLocale: "fr-FR",
            localeBranchId: failedLocaleBranchId,
            acceptedBibleHead: null,
            acceptedTargetOutputHead: null,
          });
          const failedState = recordedRunState();
          failedState.failAfterAttempt = {
            kind: "incomplete",
            responseJson: null,
            attemptStatus: "transport-error",
            httpStatus: null,
            generationId: null,
            served: { status: "unknown" },
            routerAttempts: [],
            usage: null,
            billing: { status: "billing_unknown" },
            reportedCostUsd: null,
            failure: {
              classification: "transient",
              kind: "deadline",
              httpStatus: null,
              retryAfterMs: null,
            },
            completedAt: "2026-07-21T00:00:01.000Z",
          };
          await expect(
            runLocalizeCommand(
              commandArgs(projectId, "localize-progress-run-failed", failedLocaleBranchId),
              commandDeps(
                services,
                contextSnapshot.snapshotId,
                failedLocalizationSnapshot.snapshotId,
                failedState,
              ),
            ),
          ).rejects.toThrow("recorded terminal provider failure");
          const failedLive = await workflow.loadLiveReadModel(
            projectId,
            "localize-progress-run-failed",
            { blockerPage: { limit: 500, offset: 0 } },
          );
          expect(failedLive?.run).toMatchObject({
            status: "failed",
            cost: { spentMicrosUsd: 0, reservedMicrosUsd: 0 },
          });
          expect(failedLive?.blockerPage).toMatchObject({
            total: 3,
            limit: 500,
            offset: 0,
            items: expect.arrayContaining([
              expect.objectContaining({
                blockers: ["draft-failed:deadline:http-status:unknown:billing-unknown"],
              }),
            ]),
          });
          const reservations = await context.pool.query<{
            state: string;
            settled_micros_usd: number | null;
            released_at: Date | null;
          }>(`
            select state, settled_micros_usd, released_at
            from itotori_project_run_cost_reservations
            where run_id = 'localize-progress-run-failed'
          `);
          expect(reservations.rows).toHaveLength(2);
          expect(reservations.rows).toEqual(
            Array.from({ length: 2 }, () => ({
              state: "released",
              settled_micros_usd: null,
              released_at: expect.any(Date),
            })),
          );
        } finally {
          // Assertions deliberately inspect in-flight runs. Always open every
          // gate and settle their promises before the DB service scope closes.
          firstDraftProgressGate.resolve();
          firstReviewGate.resolve();
          firstFinalizeGate.resolve();
          firstPatchGate.resolve();
          await Promise.allSettled(second === undefined ? [first] : [first, second]);
        }
      });
    } finally {
      await context.close();
    }
  });
});
