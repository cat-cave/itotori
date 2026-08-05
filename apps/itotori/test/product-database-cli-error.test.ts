import { describe, expect, it } from "vitest";
import { reportCliFailure } from "../src/cli-failure.js";
import {
  RequiredDeploymentInputError,
  requireDatabaseUrl,
} from "../src/deployment-required-input.js";
import {
  mapProductDatabaseError,
  ProductDatabaseNotRunningError,
} from "../src/database-unreachable.js";

const configuredUrl = "postgres://local-user:do-not-display@127.0.0.1:55432/local_db";

function refusedConnection(port: number): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), {
    address: "127.0.0.1",
    code: "ECONNREFUSED",
    port,
  });
}

describe("product database CLI typed failures", () => {
  it("distinguishes absent DATABASE_URL with a typed missing-input code and remediation", () => {
    expect(() => requireDatabaseUrl({})).toThrow(RequiredDeploymentInputError);
    try {
      requireDatabaseUrl({});
    } catch (error) {
      expect(error).toBeInstanceOf(RequiredDeploymentInputError);
      if (!(error instanceof RequiredDeploymentInputError)) throw error;
      expect(error.code).toBe("missing-required-deployment-input");
      expect(error.inputName).toBe("DATABASE_URL");
      expect(error.remediation).toMatch(/DATABASE_URL/);
      expect(error.remediation).not.toBe("just dev db-up");
    }
  });

  it("maps a refused configured endpoint to product-database-not-running with driver cause", () => {
    const driver = refusedConnection(55432);
    const mapped = mapProductDatabaseError(driver, configuredUrl);
    expect(mapped).toBeInstanceOf(ProductDatabaseNotRunningError);
    if (!(mapped instanceof ProductDatabaseNotRunningError)) throw mapped;
    expect(mapped.code).toBe("product-database-not-running");
    expect(mapped.remediation).toBe("just dev db-up");
    expect(mapped.message).toMatch(/127\.0\.0\.1:55432\/local_db/);
    expect(mapped.message).toMatch(/just dev db-up/);
    expect(mapped.message).not.toMatch(/local-user|do-not-display|postgres:/i);
    expect(mapped.cause).toBe(driver);
    expect(mapped.cause).toBeInstanceOf(Error);
    if (!(mapped.cause instanceof Error)) throw new Error("expected Error cause");
    expect(mapped.cause.message).toBe("connect ECONNREFUSED 127.0.0.1:55432");
  });

  it("does not reclassify SQL or unrelated-endpoint connection failures", () => {
    const sql = Object.assign(new Error('relation "itotori_users" does not exist'), {
      code: "42P01",
    });
    expect(mapProductDatabaseError(sql, configuredUrl)).toBe(sql);

    const otherPort = refusedConnection(55433);
    expect(mapProductDatabaseError(otherPort, configuredUrl)).toBe(otherPort);
  });

  it("prints structured code, remediation, and driver detail without swallowing", () => {
    const lines: string[] = [];
    const mapped = mapProductDatabaseError(refusedConnection(55432), configuredUrl);
    const exitCode = reportCliFailure(mapped, (line) => lines.push(line));
    expect(exitCode).toBe(3);
    expect(lines[0]).toMatch(/product database.*is not running/u);
    expect(lines).toContain("error.code=product-database-not-running");
    expect(lines).toContain("error.remediation=just dev db-up");
    expect(lines).toContain("error.detail=connect ECONNREFUSED 127.0.0.1:55432");
    expect(lines.join("\n")).not.toMatch(/local-user|do-not-display/i);
  });

  it("prints structured missing-input failure with a different remediation and exit 1", () => {
    const lines: string[] = [];
    const exitCode = reportCliFailure(new RequiredDeploymentInputError(), (line) =>
      lines.push(line),
    );
    expect(exitCode).toBe(1);
    expect(lines[0]).toMatch(/DATABASE_URL is absent/u);
    expect(lines).toContain("error.code=missing-required-deployment-input");
    expect(lines.some((line) => line.startsWith("error.remediation="))).toBe(true);
    expect(lines.join("\n")).not.toContain("error.code=product-database-not-running");
    expect(lines.some((line) => line.startsWith("error.detail="))).toBe(false);
  });
});
