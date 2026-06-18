// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  approveStyleGuideProposal,
  loadStyleGuideContext,
  renderStyleGuideBuilder,
  styleGuideBuilderFixtureStateValues,
} from "../src/style-guide-builder.js";
import { dashboardStatusFixture } from "./api-fixtures.js";

const localeBranchId = "019ed065-0000-7000-8000-000000000010";
const policyVersionId = "019ed065-0000-7000-8000-000000000020";

describe("StyleGuideBuilder dashboard", () => {
  it("loads branch-scoped policy proposal context and allows authorized approval", async () => {
    const context = await loadStyleGuideContext({
      localeBranchId,
      policyVersionId,
      fixtureState: "empty_policy",
      permissionProfile: "reviewer",
    });

    expect(context.route).toEqual({ localeBranchId, policyVersionId });
    expect(context.branch.localeBranchId).toBe(localeBranchId);
    expect(context.currentPolicy.styleGuideVersionId).toBe(policyVersionId);
    expect(context.proposal.transcript.localeBranchId).toBe(localeBranchId);
    expect(context.proposal.transcript.basePolicyVersionId).toBe(policyVersionId);
    expect(context.validation.status).toBe("valid");

    const root = document.createElement("div");
    renderStyleGuideBuilder(root, context);

    expect(root.textContent).toContain("Policy proposal review");
    expect(root.textContent).toContain(localeBranchId);
    expect(root.textContent).toContain(policyVersionId);
    expect(root.textContent).toContain("Proposed policy");
    expect(root.textContent).toContain("Validation");
    expect(root.textContent).toContain("Consequence preview");
    expect(
      root.querySelector<HTMLButtonElement>('[data-action="approve-style-guide"]')?.disabled,
    ).toBe(false);

    await expect(approveStyleGuideProposal(context)).resolves.toMatchObject({
      status: "approved",
      versionId: "019ed065-0000-7000-8000-000000000030",
    });
  });

  it("rejects invalid dashboard fixture route IDs instead of mixing fallback contract IDs", async () => {
    const fixtureLocaleBranchId = dashboardStatusFixture.localeBranches[0]?.localeBranchId;

    expect(fixtureLocaleBranchId).toBe("locale-1");
    await expect(
      loadStyleGuideContext({
        localeBranchId: fixtureLocaleBranchId ?? "",
        policyVersionId,
        fixtureState: "empty_policy",
        permissionProfile: "reviewer",
      }),
    ).rejects.toThrow("invalid locale branch id locale-1; expected UUIDv7");
  });

  it("renders denial state and blocks proposal approval without mutation permission", async () => {
    const context = await loadStyleGuideContext({
      localeBranchId,
      policyVersionId,
      fixtureState: "empty_policy",
      permissionProfile: "reader",
    });
    const root = document.createElement("div");

    renderStyleGuideBuilder(root, context);

    expect(context.permissions.canReview).toBe(true);
    expect(context.permissions.canApprove).toBe(false);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "Missing required permission draft.write.",
    );
    expect(
      root.querySelector<HTMLButtonElement>('[data-action="approve-style-guide"]')?.disabled,
    ).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-action="mutate-policy"]')?.disabled).toBe(
      true,
    );
    await expect(approveStyleGuideProposal(context)).resolves.toMatchObject({
      status: "denied",
      diagnostics: [
        {
          code: "style_guide.permission.denied",
          source: "permission",
        },
      ],
    });
  });

  it("surfaces validation and conflict diagnostics before approval", async () => {
    const validationError = await loadStyleGuideContext({
      localeBranchId,
      policyVersionId,
      fixtureState: "validation_error",
      permissionProfile: "reviewer",
    });
    const conflictingProposal = await loadStyleGuideContext({
      localeBranchId,
      policyVersionId,
      fixtureState: "conflicting_proposal",
      permissionProfile: "reviewer",
    });

    expect(validationError.validation.status).toBe("invalid");
    expect(validationError.validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "style_guide_conversation.proposal.policy_version_scope",
    );
    expect(conflictingProposal.validation.status).toBe("invalid");
    expect(
      conflictingProposal.validation.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("style_guide_conversation.projection.conflicting_accepted_edit");
    await expect(approveStyleGuideProposal(validationError)).resolves.toMatchObject({
      status: "invalid",
    });
    await expect(approveStyleGuideProposal(conflictingProposal)).resolves.toMatchObject({
      status: "invalid",
    });
  });

  it("covers required dashboard fixture states", async () => {
    const states = await Promise.all(
      styleGuideBuilderFixtureStateValues.map((fixtureState) =>
        loadStyleGuideContext({
          localeBranchId,
          policyVersionId,
          fixtureState,
          permissionProfile: "reviewer",
        }),
      ),
    );

    expect(states.map((context) => context.state)).toEqual([
      "empty_policy",
      "validation_error",
      "conflicting_proposal",
      "approved_version",
      "stale_version",
    ]);
    expect(states.map((context) => context.validation.status)).toEqual([
      "valid",
      "invalid",
      "invalid",
      "approved",
      "stale",
    ]);
  });

  it("snapshots consequence preview for drafts, glossary entries, and exports", async () => {
    const context = await loadStyleGuideContext({
      localeBranchId,
      policyVersionId,
      fixtureState: "empty_policy",
      permissionProfile: "reviewer",
    });

    expect(context.consequences).toMatchInlineSnapshot(`
      {
        "affectedDrafts": [
          {
            "id": "draft:019ed065-0000-7000-8000-000000000010:opening-001",
            "impact": "stale",
            "label": "Opening tutorial draft",
            "reason": "Tone and placeholder rules affect the existing tutorial draft.",
          },
          {
            "id": "draft:019ed065-0000-7000-8000-000000000010:choice-002",
            "impact": "rerun",
            "label": "First choice label draft",
            "reason": "Choice text should be rechecked against the branch style policy.",
          },
        ],
        "exports": [
          {
            "id": "export:019ed065-0000-7000-8000-000000000010:patch-ready",
            "impact": "blocked",
            "label": "Patch export candidate",
            "reason": "Exports wait for approved policy and rerun completion.",
          },
        ],
        "glossaryEntries": [
          {
            "id": "glossary:019ed065-0000-7000-8000-000000000010:player-token",
            "impact": "stale",
            "label": "{player}",
            "reason": "Protected-token guidance updates glossary QA expectations.",
          },
        ],
      }
    `);
  });
});
