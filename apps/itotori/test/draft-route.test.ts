// After the API repoint, branches.draft never reaches ProjectWorkflowService.draftProject.
// Without the new-pipeline localizationSubstrate the route refuses in-band.

import { describe, expect, it, vi } from "vitest";
import { handleItotoriApiRequest, type ItotoriApiServices } from "../src/api-handlers.js";
import type { ApiDraftBranchResponse } from "../src/api-schema.js";
import { projectFixture } from "./api-fixtures.js";

describe("projects.draft HTTP boundary (new-pipeline cutover)", () => {
  it("returns an in-band refusal when localizationSubstrate is missing (never draftProject)", async () => {
    const services = {
      authorization: {
        requirePermission: vi.fn(async () => {}),
      },
      projectWorkflow: {
        listLocaleBranchIdentities: vi.fn(async () => [
          {
            localeBranchId: "locale-1",
            projectId: "project-1",
            sourceBundleId: "bridge-1",
            sourceBundleRevisionId: "revision-1",
            sourceLocale: "ja-JP",
            targetLocale: "en-US",
            branchName: "en-US",
            status: "active" as const,
          },
        ]),
        getDashboardStatus: vi.fn(async () => {
          throw new Error("getDashboardStatus must not run on a substrate-missing refuse");
        }),
      },
      // localizationSubstrate intentionally omitted — the production cut refuses.
      patchPlay: {
        loader: {
          load: vi.fn(async () => {
            throw new Error("patchPlay unused in draft-route test");
          }),
        },
        launcher: {
          launch: vi.fn(async () => {
            throw new Error("patchPlay unused in draft-route test");
          }),
        },
      },
    } as unknown as ItotoriApiServices;

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/projects/project-1/branches",
        body: { project: projectFixture, targetLocale: "fr-FR" },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "refused",
      project: null,
      status: null,
      refusalMessage: expect.stringContaining("localizationSubstrate port missing"),
    });
    expect((response.body as Record<string, unknown>).code).not.toBe("internal_error");
    const draftResponse = response.body as ApiDraftBranchResponse;
    expect(draftResponse.outcome).toBe("refused");
  });
});
