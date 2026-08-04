import { describe, expect, it } from "vitest";

import { providerBudgetCohort } from "../src/composition/provider-budget-cohort.js";
import { localizeProviderBudgetAdmissionIdentity } from "../src/llm/localize-admission-budget.js";

describe("localize provider-budget cohort identity", () => {
  it("hashes the complete normalized member snapshot deterministically", () => {
    const members = [
      { projectId: "project-b", runId: "run-b" },
      { projectId: " project-a ", runId: " run-a " },
    ];
    const cohort = providerBudgetCohort(members);
    const reordered = providerBudgetCohort([...members].reverse());
    const extended = providerBudgetCohort([...members, { projectId: "project-c", runId: "run-c" }]);

    expect(reordered).toEqual(cohort);
    expect(cohort.cohortId).toMatch(/^localize-cohort:[a-f0-9]{64}$/u);
    expect(extended.cohortId).not.toBe(cohort.cohortId);
  });

  it("rejects an ID whose member snapshot has been narrowed", () => {
    const fullCohort = providerBudgetCohort([
      { projectId: "project-a", runId: "run-a" },
      { projectId: "project-b", runId: "run-b" },
    ]);

    expect(() =>
      localizeProviderBudgetAdmissionIdentity({
        profileScope: "localize:profile-a",
        projectId: "project-a",
        runId: "run-a",
        cohort: {
          cohortId: fullCohort.cohortId,
          members: [{ projectId: "project-a", runId: "run-a" }],
        },
      }),
    ).toThrow("provider budget cohort ID does not match its member snapshot");
  });
});
