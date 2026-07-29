import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { findViolations } from "./audit-no-hardcoded-roles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-hardcoded-roles.mjs");

export const TS = "apps/itotori/src/some/module.ts";
export const RS = "crates/foo/src/lib.rs";

export const LABELS = {
  comparison: "auth role-name branching (comparison on a role read)",
  switch: "auth role-name branching (switch on a role read)",
  lookup: "auth role-keyed lookup map (indexing by a role read)",
  subject: "auth-subject role gating (`<subject>.role`)",
  isAdmin: "auth-role boolean `isAdmin` / `is_admin`",
  hasRole: "auth-role helper `hasRole(...)` / `has_role(...)`",
  roleValues: "auth-roles enum `roleValues`",
  roles: "auth-roles enum `ROLES`",
};

export function labels(path, contents) {
  return findViolations(path, contents).map((v) => v.pattern);
}

export function isFlagged(path, contents) {
  return findViolations(path, contents).length > 0;
}

// Invoke the auditor CLI as a fully CAPTURED subprocess so an intentional
// detection's stderr stays inside the helper (tooling grepping the test's own
// stderr does not false-trip), while the tests still PROVE detection by
// asserting on the captured stderr. Mirrors audit-no-hardcoded-cost.test.mjs.
export function runAuditCli(...files) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

export function writeShippedProbe(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "audit-roles-"));
  const srcDir = join(dir, "apps/itotori/src");
  mkdirSync(srcDir, { recursive: true });
  const probe = join(srcDir, name);
  writeFileSync(probe, contents);
  return probe;
}
