// Shared classification and allowlist helpers for the no-hardcoded-roles guard.

export const AUTH_ROLE_NAMES = new Set([
  "admin",
  "administrator",
  "superadmin",
  "superuser",
  "sysadmin",
  "root",
  "owner",
  "coowner",
  "moderator",
  "mod",
  "editor",
  "viewer",
  "guest",
  "member",
  "operator",
  "maintainer",
  "manager",
  "staff",
  "subscriber",
]);

export const AUTH_SUBJECT_OBJECTS = new Set([
  "user",
  "actor",
  "principal",
  "session",
  "subject",
  "requester",
  "caller",
  "currentuser",
  "curuser",
  "auth",
  "account",
  "identity",
  "viewer",
]);

export const AUTH_ROLE_MAP_NAMES = new Set([
  "ROLES",
  "ROLE_PERMISSIONS",
  "ROLE_PERMS",
  "ROLE_MAP",
  "ROLE_POLICY",
  "ROLE_POLICIES",
  "rolePermissions",
  "rolePolicies",
  "roleToPermissions",
  "permissionsByRole",
  "roleValues",
]);

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

export function isAuthRoleName(value) {
  return AUTH_ROLE_NAMES.has(value.toLowerCase());
}

export function isAuthSubjectName(name) {
  return name !== undefined && AUTH_SUBJECT_OBJECTS.has(name.toLowerCase());
}

export function isAuthRoleMapName(name) {
  return name !== undefined && AUTH_ROLE_MAP_NAMES.has(name);
}

function isCommentLine(trimmed) {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("#")
  );
}

function hasAllowMarker(line) {
  return /authz-guard:allow\s+\S/u.test(line);
}

// A marker exempts just its line or the one code line below its comment block.
export function markerOnLineOrAbove(lines, lineIndex) {
  if (lineIndex < 0 || lineIndex >= lines.length) return false;
  if (hasAllowMarker(lines[lineIndex])) return true;
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const above = lines[index].trim();
    if (!isCommentLine(above)) break;
    if (hasAllowMarker(lines[index])) return true;
  }
  return false;
}
