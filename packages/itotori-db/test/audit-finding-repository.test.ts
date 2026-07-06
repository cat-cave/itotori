import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriAuditFindingRepository,
  auditFindingSeverityValues,
  auditFindingStatusValues,
} from "../src/repositories/audit-finding-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

const baseInput = {
  auditReportId: "docs/audits/alpha-scope-honesty.md",
  nodeId: "UTSUSHI-200",
  severity: auditFindingSeverityValues.p1,
  category: "load-bearing",
  summary: "non-synthetic engine port crate must not depend on author fixtures",
  detail: "AC must require real-bytes drive of the smallest credible opcode subset.",
  fileRef: "crates/utsushi-reallive/src/lib.rs:1",
  proposedDagNode: "UTSUSHI-200",
} as const;

describe("ItotoriAuditFindingRepository", () => {
  it("recordFinding persists a new open finding with the carried metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });

      expect(finding.auditFindingId).toMatch(/^audit-finding-/);
      expect(finding.nodeId).toBe("UTSUSHI-200");
      expect(finding.severity).toBe(auditFindingSeverityValues.p1);
      expect(finding.category).toBe("load-bearing");
      expect(finding.summary).toBe(baseInput.summary);
      expect(finding.detail).toBe(baseInput.detail);
      expect(finding.fileRef).toBe(baseInput.fileRef);
      expect(finding.proposedDagNode).toBe("UTSUSHI-200");
      expect(finding.status).toBe(auditFindingStatusValues.open);
      expect(finding.supersededByFindingId).toBeNull();
      expect(finding.resolvedAt).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("recordFinding rejects empty summary/category/node/report", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      await expect(
        repo.recordFinding(localActor, { ...baseInput, summary: "" }),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_invalid_input",
      });
      await expect(
        repo.recordFinding(localActor, { ...baseInput, category: "" }),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_invalid_input",
      });
      await expect(
        repo.recordFinding(localActor, { ...baseInput, nodeId: "" }),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_invalid_input",
      });
      await expect(
        repo.recordFinding(localActor, { ...baseInput, auditReportId: "" }),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_invalid_input",
      });
    } finally {
      await context.close();
    }
  });

  it("markFindingFixed transitions an open finding to fixed and stamps resolvedAt", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });
      const resolvedAt = new Date("2026-06-24T12:00:00Z");
      await repo.markFindingFixed(localActor, finding.auditFindingId, resolvedAt);

      const reloaded = await repo.loadFindingsByNode(localActor, "UTSUSHI-200");
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]!.status).toBe(auditFindingStatusValues.fixed);
      expect(reloaded[0]!.resolvedAt).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("markFindingFixed refuses to re-resolve a non-open finding", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });
      await repo.markFindingFixed(localActor, finding.auditFindingId, new Date());
      await expect(
        repo.markFindingFixed(localActor, finding.auditFindingId, new Date()),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_not_open",
      });
    } finally {
      await context.close();
    }
  });

  it("markFindingSuperseded chains an old finding to a successor", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const oldFinding = await repo.recordFinding(localActor, { ...baseInput });
      const newFinding = await repo.recordFinding(localActor, {
        ...baseInput,
        summary: "successor finding sharpens load-bearing AC",
      });
      const resolvedAt = new Date("2026-06-24T13:00:00Z");
      await repo.markFindingSuperseded(
        localActor,
        oldFinding.auditFindingId,
        newFinding.auditFindingId,
        resolvedAt,
      );

      const findings = await repo.loadFindingsByNode(localActor, "UTSUSHI-200");
      const supersededRow = findings.find(
        (row) => row.auditFindingId === oldFinding.auditFindingId,
      );
      const successorRow = findings.find((row) => row.auditFindingId === newFinding.auditFindingId);
      expect(supersededRow?.status).toBe(auditFindingStatusValues.superseded);
      expect(supersededRow?.supersededByFindingId).toBe(newFinding.auditFindingId);
      expect(supersededRow?.resolvedAt).not.toBeNull();
      expect(successorRow?.status).toBe(auditFindingStatusValues.open);
    } finally {
      await context.close();
    }
  });

  it("markFindingSuperseded rejects self-supersede and missing successor", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const finding = await repo.recordFinding(localActor, { ...baseInput });
      await expect(
        repo.markFindingSuperseded(
          localActor,
          finding.auditFindingId,
          finding.auditFindingId,
          new Date(),
        ),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_supersede_chain_invalid",
      });
      await expect(
        repo.markFindingSuperseded(
          localActor,
          finding.auditFindingId,
          "audit-finding-not-real",
          new Date(),
        ),
      ).rejects.toMatchObject({
        name: "AuditFindingRepositoryError",
        code: "audit_finding_not_found",
      });
    } finally {
      await context.close();
    }
  });

  it("loadFindingsByNode honors statusFilter and severityFilter", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const p0 = await repo.recordFinding(localActor, {
        ...baseInput,
        severity: auditFindingSeverityValues.p0,
        summary: "p0 finding",
      });
      await repo.recordFinding(localActor, {
        ...baseInput,
        severity: auditFindingSeverityValues.p1,
        summary: "p1 finding",
      });
      await repo.markFindingFixed(localActor, p0.auditFindingId, new Date());

      const onlyP1 = await repo.loadFindingsByNode(localActor, "UTSUSHI-200", {
        severityFilter: auditFindingSeverityValues.p1,
      });
      expect(onlyP1).toHaveLength(1);
      expect(onlyP1[0]!.severity).toBe(auditFindingSeverityValues.p1);

      const onlyOpen = await repo.loadFindingsByNode(localActor, "UTSUSHI-200", {
        statusFilter: auditFindingStatusValues.open,
      });
      expect(onlyOpen).toHaveLength(1);
      expect(onlyOpen[0]!.severity).toBe(auditFindingSeverityValues.p1);

      const onlyFixed = await repo.loadFindingsByNode(localActor, "UTSUSHI-200", {
        statusFilter: auditFindingStatusValues.fixed,
      });
      expect(onlyFixed).toHaveLength(1);
      expect(onlyFixed[0]!.severity).toBe(auditFindingSeverityValues.p0);
    } finally {
      await context.close();
    }
  });

  it("loadFindingsByReport returns every finding the named report introduced", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      await repo.recordFinding(localActor, { ...baseInput, nodeId: "UTSUSHI-200" });
      await repo.recordFinding(localActor, { ...baseInput, nodeId: "KAIFUU-188" });
      await repo.recordFinding(localActor, {
        ...baseInput,
        auditReportId: "docs/audits/silenced-2026-06-24.md",
        nodeId: "ITOTORI-202",
      });

      const fromOne = await repo.loadFindingsByReport(
        localActor,
        "docs/audits/alpha-scope-honesty.md",
      );
      expect(fromOne).toHaveLength(2);
      expect(fromOne.map((row) => row.nodeId).sort()).toEqual(["KAIFUU-188", "UTSUSHI-200"]);
    } finally {
      await context.close();
    }
  });

  it("loadOpenFindings filters by severity and never returns closed findings", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      const p0 = await repo.recordFinding(localActor, {
        ...baseInput,
        severity: auditFindingSeverityValues.p0,
        nodeId: "UTSUSHI-200",
      });
      await repo.recordFinding(localActor, {
        ...baseInput,
        severity: auditFindingSeverityValues.p1,
        nodeId: "KAIFUU-188",
      });
      await repo.markFindingFixed(localActor, p0.auditFindingId, new Date());

      const open = await repo.loadOpenFindings(localActor);
      expect(open).toHaveLength(1);
      expect(open[0]!.severity).toBe(auditFindingSeverityValues.p1);

      const onlyP0 = await repo.loadOpenFindings(localActor, {
        severityFilter: auditFindingSeverityValues.p0,
      });
      expect(onlyP0).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("denies audit.write paths when the actor lacks the audit.write permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      await expect(repo.recordFinding(deniedActor, { ...baseInput })).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "audit.write",
      });
      await expect(
        repo.markFindingFixed(deniedActor, "audit-finding-x", new Date()),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "audit.write" });
      await expect(
        repo.markFindingSuperseded(deniedActor, "audit-finding-x", "audit-finding-y", new Date()),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "audit.write" });
    } finally {
      await context.close();
    }
  });

  it("denies catalog.read paths when the actor lacks the catalog.read permission", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriAuditFindingRepository(context.db);
      await expect(repo.loadFindingsByNode(deniedActor, "UTSUSHI-200")).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
      await expect(
        repo.loadFindingsByReport(deniedActor, "docs/audits/x.md"),
      ).rejects.toMatchObject({ name: "AuthorizationError", permission: "catalog.read" });
      await expect(repo.loadOpenFindings(deniedActor)).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
    } finally {
      await context.close();
    }
  });
});
