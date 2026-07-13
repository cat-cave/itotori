import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findUncoveredProjectWorkflowMutations } from "./api-mutation-coverage-guard.js";

/**
 * SHARED-026 — proves the mutation-permission guard is shape-ROBUST.
 *
 * Each negative fixture below adds a NEW mutating API route in a form the
 * legacy `sourceApiMutationRoutes` scan would MISS (route-table entry, a
 * `switch` on a non-`projectRoute.resource` discriminant, and a
 * helper-predicate `if`). Every fixture omits the `requireApiPermission` gate,
 * so a shape-robust guard MUST flag the uncovered mutation. The paired
 * `covered` fixture inserts the gate and MUST pass, proving the guard keys on
 * the permission gate rather than the routing shape.
 */

const FILE = "fixture-route.ts";

// Form 1 — ROUTE TABLE. The legacy scan only reads the direct `if`/`switch`
// statements of `routeItotoriApiRequest`; a table of `{ match, handle }`
// entries dispatched in a loop is entirely invisible to it.
const routeTableUncovered = `
async function routeItotoriApiRequest(request, services) {
  const routeTable = [
    {
      match: (r) => r.method === "POST" && r.pathname === "/api/imports/bridge",
      handle: async (services, body) => {
        return services.projectWorkflow.importBridge(body.bridge);
      },
    },
  ];
  for (const entry of routeTable) {
    if (entry.match(request)) {
      return entry.handle(services, request.body);
    }
  }
}
`;

const routeTableCovered = `
async function routeItotoriApiRequest(request, services) {
  const routeTable = [
    {
      match: (r) => r.method === "POST" && r.pathname === "/api/imports/bridge",
      handle: async (services, body) => {
        await requireApiPermission(services, apiMutationPermissionGates.bridgeImport);
        return services.projectWorkflow.importBridge(body.bridge);
      },
    },
  ];
  for (const entry of routeTable) {
    if (entry.match(request)) {
      return entry.handle(services, request.body);
    }
  }
}
`;

const aliasedRequireApiPermissionCovered = `
async function routeItotoriApiRequest(request, services) {
  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    const requireMutationPermission = requireApiPermission;
    await requireMutationPermission(services, apiMutationPermissionGates.bridgeImport);
    return services.projectWorkflow.importBridge(request.body.bridge);
  }
}
`;

// Form 2 — SWITCH ON A DIFFERENT DISCRIMINANT. The legacy scan hard-codes
// `switch (projectRoute.resource)`; a switch over any other value slips past.
const otherSwitchUncovered = `
async function routeItotoriApiRequest(request, services) {
  const findingRoute = parseFindingMutationRoute(request.pathname);
  switch (findingRoute.action) {
    case "record-finding": {
      const body = parseRecordFindingRequest(request.body);
      return ok("finding.record", await services.projectWorkflow.recordFinding(findingRoute.projectId, body));
    }
  }
}
`;

const otherSwitchCovered = `
async function routeItotoriApiRequest(request, services) {
  const findingRoute = parseFindingMutationRoute(request.pathname);
  switch (findingRoute.action) {
    case "record-finding": {
      const body = parseRecordFindingRequest(request.body);
      await requireApiPermission(services, apiMutationPermissionGates.findingRecord);
      return ok("finding.record", await services.projectWorkflow.recordFinding(findingRoute.projectId, body));
    }
  }
}
`;

// Form 3 — HELPER-PREDICATE `if`. Shaped like an asset parse
// route: `if (request.method === "POST" && parsed !== null)`. `postRoutePathname`
// in the legacy scan requires the right operand to be `request.pathname === <literal>`,
// so a `parsed !== null` predicate is skipped even though it is a POST mutation.
const helperPredicateUncovered = `
async function routeItotoriApiRequest(request, services) {
  const findingRoute = parseFindingMutationRoute(request.pathname);
  if (request.method === "POST" && findingRoute !== null) {
    const body = parseRecordFindingRequest(request.body);
    return ok("finding.record", await services.projectWorkflow.recordFinding(findingRoute.projectId, body));
  }
}
`;

const helperPredicateCovered = `
async function routeItotoriApiRequest(request, services) {
  const findingRoute = parseFindingMutationRoute(request.pathname);
  if (request.method === "POST" && findingRoute !== null) {
    const body = parseRecordFindingRequest(request.body);
    await requireApiPermission(services, apiMutationPermissionGates.findingRecord);
    return ok("finding.record", await services.projectWorkflow.recordFinding(findingRoute.projectId, body));
  }
}
`;

describe("SHARED-026 shape-robust API mutation-permission guard", () => {
  it.each([
    { form: "route-table entry", source: routeTableUncovered, method: "importBridge" },
    {
      form: "switch on a non-projectRoute discriminant",
      source: otherSwitchUncovered,
      method: "recordFinding",
    },
    { form: "helper-predicate if", source: helperPredicateUncovered, method: "recordFinding" },
  ])("FAILS on an uncovered mutating route declared as a $form", ({ source, method }) => {
    const uncovered = findUncoveredProjectWorkflowMutations(source, FILE);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.method).toBe(method);
  });

  it.each([
    { form: "route-table entry", source: routeTableCovered },
    { form: "switch on a non-projectRoute discriminant", source: otherSwitchCovered },
    { form: "helper-predicate if", source: helperPredicateCovered },
    { form: "aliased requireApiPermission helper", source: aliasedRequireApiPermissionCovered },
  ])(
    "passes the same $form once the matching API permission gate covers the mutation",
    ({ source }) => {
      expect(findUncoveredProjectWorkflowMutations(source, FILE)).toEqual([]);
    },
  );

  it("FAILS on an uncovered optional-chained mutation (`services.projectWorkflow?.importBridge`)", () => {
    // Babel emits OptionalCallExpression / OptionalMemberExpression for `?.`
    // call chains; the guard must still discover the mutation (P1).
    const optionalUncovered = `
async function routeItotoriApiRequest(request, services) {
  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    return services.projectWorkflow?.importBridge(request.body.bridge);
  }
}
`;
    const uncovered = findUncoveredProjectWorkflowMutations(optionalUncovered, FILE);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.method).toBe("importBridge");
  });

  it('FAILS on uncovered computed optional mutation (`services?.projectWorkflow?.["importBridge"]`)', () => {
    // Literal-computed method names must match static `.importBridge` (P1 re-audit).
    const computedUncovered = `
async function routeItotoriApiRequest(request, services) {
  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    return services?.projectWorkflow?.["importBridge"](request.body.bridge);
  }
}
`;
    const uncovered = findUncoveredProjectWorkflowMutations(computedUncovered, FILE);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.method).toBe("importBridge");
    expect(uncovered[0]?.surface).toBe("projectWorkflow");
  });

  it("passes when an optional-chained mutation is covered by requireApiPermission", () => {
    const optionalCovered = `
async function routeItotoriApiRequest(request, services) {
  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    await requireApiPermission(services, apiMutationPermissionGates.bridgeImport);
    return services.projectWorkflow?.importBridge(request.body.bridge);
  }
}
`;
    expect(findUncoveredProjectWorkflowMutations(optionalCovered, FILE)).toEqual([]);
  });

  it("passes when a computed optional mutation is covered by requireApiPermission", () => {
    const computedCovered = `
async function routeItotoriApiRequest(request, services) {
  if (request.method === "POST" && request.pathname === "/api/imports/bridge") {
    await requireApiPermission?.(services, apiMutationPermissionGates.bridgeImport);
    return services?.projectWorkflow?.["importBridge"](request.body.bridge);
  }
}
`;
    expect(findUncoveredProjectWorkflowMutations(computedCovered, FILE)).toEqual([]);
  });

  it("does NOT treat dynamic computed method names as known mutations (conservative)", () => {
    const dynamic = `
async function routeItotoriApiRequest(request, services) {
  const method = "importBridge";
  return services.projectWorkflow[method](request.body.bridge);
}
`;
    expect(findUncoveredProjectWorkflowMutations(dynamic, FILE)).toEqual([]);
  });

  it("treats read-only projectWorkflow reads as non-mutations", () => {
    const readOnly = `
      async function routeItotoriApiRequest(request, services) {
        if (request.method === "GET" && request.pathname === "/api/projects/status") {
          return ok("projects.status", await services.projectWorkflow.getDashboardStatus());
        }
      }
    `;
    expect(findUncoveredProjectWorkflowMutations(readOnly, FILE)).toEqual([]);
  });

  it("keeps the shipped api-handlers.ts source fully permission-covered", () => {
    const sourceUrl = new URL("../src/api-handlers.ts", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8");
    expect(findUncoveredProjectWorkflowMutations(source, sourceUrl.pathname)).toEqual([]);
  });
});
