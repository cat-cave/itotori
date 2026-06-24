import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriAuditFindingRepository,
  auditFindingSeverityValues,
} from "../src/repositories/audit-finding-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

function pgErrorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

const baseInput = {
  auditReportId: "docs/audits/alpha-scope-honesty.md",
  nodeId: "UTSUSHI-200",
  severity: auditFindingSeverityValues.p1,
  category: "load-bearing",
  summary: "non-synthetic engine port crate must not depend on author fixtures",
} as const;

describe.skipIf(!process.env.DATABASE_URL)("audit finding migration drift", () => {
  it("registers the self-referencing supersede foreign key on itotori_audit_findings", async () => {
    const context = await isolatedMigratedContext();
    try {
      const rows = await context.db.execute(sql`
        select
          c.relname as table_name,
          con.conname as constraint_name,
          pg_get_constraintdef(con.oid) as constraint_definition
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname = 'itotori_audit_findings'
          and con.contype = 'f'
        order by con.conname
      `);

      const definitions = rows.rows.map(
        (row) => `${String(row.table_name)}: ${String(row.constraint_definition)}`,
      );
      expect(
        definitions.some(
          (def) =>
            def.startsWith("itotori_audit_findings:") &&
            def.includes("REFERENCES itotori_audit_findings"),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("severity check constraint rejects values outside P0..P3", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_audit_findings set severity = $1 where audit_finding_id = $2`,
          ["P9", finding.auditFindingId],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");

      for (const validSeverity of ["P0", "P1", "P2", "P3"]) {
        await context.pool.query(
          `update itotori_audit_findings set severity = $1 where audit_finding_id = $2`,
          [validSeverity, finding.auditFindingId],
        );
      }
    } finally {
      await context.close();
    }
  });

  it("status check constraint enforces only the five status values", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_audit_findings set status = $1 where audit_finding_id = $2`,
          ["queued", finding.auditFindingId],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("resolved-state consistency check rejects an open row with resolvedAt set", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });

      let captured: unknown;
      try {
        await context.pool.query(
          `update itotori_audit_findings set resolved_at = now() where audit_finding_id = $1`,
          [finding.auditFindingId],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });

  it("audit.write permission grant is part of the constraint set", async () => {
    const context = await isolatedMigratedContext();
    try {
      // Ability to grant audit.write proves the constraint accepts it.
      await context.pool.query(
        `insert into itotori_user_permission_grants (user_id, permission) values ($1, $2)
         on conflict (user_id, permission) do nothing`,
        [localUserId, "audit.write"],
      );

      let captured: unknown;
      try {
        await context.pool.query(
          `insert into itotori_user_permission_grants (user_id, permission) values ($1, $2)`,
          [localUserId, "audit.invalid"],
        );
      } catch (error) {
        captured = error;
      }
      expect(pgErrorCodeOf(captured)).toBe("23514");
    } finally {
      await context.close();
    }
  });
});
