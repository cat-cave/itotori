import { auditAndPrincipalsPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-audit-and-principals.js";
import { catalogDiscoveryPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-catalog-discovery.js";
import { crawlerAndLanguageAssetsPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-crawler-and-language-assets.js";
import { identityAndSettingsPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-identity-and-settings.js";
import { localizationWorkflowPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-localization-workflow.js";
import { projectFeedbackLedgerPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-project-feedback-ledger.js";
import { queueAndCatalogSeedsPermissionGateMatrixExpected } from "./authorization-matrix.test.expected-queue-and-catalog-seeds.js";

export const permissionGateMatrixExpected = [
  ...projectFeedbackLedgerPermissionGateMatrixExpected,
  ...queueAndCatalogSeedsPermissionGateMatrixExpected,
  ...catalogDiscoveryPermissionGateMatrixExpected,
  ...crawlerAndLanguageAssetsPermissionGateMatrixExpected,
  ...localizationWorkflowPermissionGateMatrixExpected,
  ...auditAndPrincipalsPermissionGateMatrixExpected,
  ...identityAndSettingsPermissionGateMatrixExpected,
];
