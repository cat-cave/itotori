import type { RepositoryPermissionGateCase } from "./authorization-matrix.test.helpers.js";
import {
  modelRoutingSettingsGate,
  translationScopeSettingsGate,
  localizationPassRunConfigGate,
  authSessionServiceGate,
} from "./authorization-matrix.test.factories.js";

export const repositoryPermissionGateMatrixPart3 = [
  modelRoutingSettingsGate(
    "loadSettings",
    "catalogRead",
    "model-routing-settings-repository.test.ts load settings coverage",
    (repo) => repo.loadSettings(deniedActor, "project-denied"),
  ),
  modelRoutingSettingsGate(
    "saveRoute",
    "draftWrite",
    "model-routing-settings-repository.test.ts save route coverage",
    (repo) => repo.saveRoute(deniedActor, undefined as never),
  ),
  translationScopeSettingsGate(
    "loadSettings",
    "catalogRead",
    "translation-scope-settings-repository.test.ts load settings coverage",
    (repo) =>
      repo.loadSettings(deniedActor, {
        projectId: "project-denied",
        localeBranchId: "locale-branch-denied",
      }),
  ),
  translationScopeSettingsGate(
    "saveSettings",
    "draftWrite",
    "translation-scope-settings-repository.test.ts save settings coverage",
    (repo) =>
      repo.saveSettings(deniedActor, {
        projectId: "project-denied",
        localeBranchId: "locale-branch-denied",
        scope: "dialogue-only",
      }),
  ),
  localizationPassRunConfigGate(
    "saveRunConfig",
    "draftWrite",
    "localization-pass-run-config-repository.test.ts save coverage",
    (repo) => repo.saveRunConfig(deniedActor, undefined as never),
  ),
  authSessionServiceGate(
    "listPrincipalSessions",
    "authSessionsManage",
    "auth-session-service.test.ts list principal sessions coverage",
    (repo) => repo.listPrincipalSessions(deniedActor, undefined as never),
  ),
  authSessionServiceGate(
    "revokePrincipalSession",
    "authSessionsManage",
    "auth-session-service.test.ts revoke principal session coverage",
    (repo) => repo.revokePrincipalSession(deniedActor, undefined as never),
  ),
] satisfies readonly RepositoryPermissionGateCase[];
