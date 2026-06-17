import { describe, expect, it } from "vitest";
import { localUserId } from "@itotori/db";
import { localUserActor } from "../src/auth.js";

describe("Itotori authorization wiring", () => {
  it("uses the all-permissions MVP local user for local CLI flows", () => {
    expect(localUserActor).toEqual({ userId: localUserId });
  });
});
