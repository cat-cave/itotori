import { expect, it } from "vitest";
import { interpolateRoutePath } from "../src/api-routes.js";

it("encodes reserved characters in a route path parameter", () => {
  expect(
    interpolateRoutePath("catalog.contextPanel", {
      projectId: "project/a?b#c",
      localeBranchId: "l",
      workId: "w",
    }),
  ).toBe("/api/projects/project%2Fa%3Fb%23c/locale-branches/l/catalog-context/w");
});
