import { ITOTORI_PRODUCT_VERSION } from "@itotori/localization-bridge-schema";
import { buildCommandHelpText, buildHelpText } from "./help-text.js";
import { loadExternalEnvFile } from "./env/external-env-file.js";
import type { ItotoriCliDependencies } from "./cli-handler-contracts.js";
import {
  runAssetDecisionsListHandler,
  runCatalogFuzzyCandidates,
  runCatalogLinkExact,
  runCatalogLocalScan,
  runCatalogResolveFixture,
  runEngineCapabilitiesList,
  runEngineCapabilitiesRecord,
  runQueueHealthHandler,
  runWiki,
} from "./cli-handler-catalog-commands.js";
import {
  runDashboardStatus,
  runExtract,
  runIngestConformance,
  runIngestPatchResult,
  runIngestRuntime,
  runLocalize,
  runLocalizePortfolio,
  runPatchCommand,
  runStructureExportHandler,
  runValidateCommand,
} from "./cli-handler-core-commands.js";
import { runInitHandler } from "./cli-handler-init.js";

export async function runItotoriCliCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const envFileResult = loadExternalEnvFile({ args, env: process.env });
  if (envFileResult.path !== undefined && envFileResult.appliedKeys.length > 0) {
    process.stderr.write(
      `loaded ${envFileResult.appliedKeys.length} allowlisted var(s) from env file ` +
        `'${envFileResult.path}': ${envFileResult.appliedKeys.join(", ")}\n`,
    );
  }
  if (args.includes("--help") || args.includes("-h")) {
    const commandHelp = buildCommandHelpText(args);
    if (commandHelp !== undefined) {
      process.stdout.write(`${commandHelp}\n`);
      return;
    }
    process.stdout.write(`${buildHelpText(args.includes("--all"))}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`itotori ${ITOTORI_PRODUCT_VERSION}\n`);
    return;
  }
  switch (args[0]) {
    case "db-migrate":
      await dependencies.migrateDatabase();
      break;
    case "db-reset":
      await dependencies.resetDatabase();
      break;
    case "dashboard-status":
      await runDashboardStatus(args, dependencies);
      break;
    case "localize":
      await runLocalize(args, dependencies);
      break;
    case "localize-portfolio":
      await runLocalizePortfolio(args, dependencies);
      break;
    case "extract":
      await runExtract(args, dependencies);
      break;
    case "patch":
      await runPatchCommand(args, dependencies);
      break;
    case "validate":
      await runValidateCommand(args, dependencies);
      break;
    case "ingest-runtime":
      await runIngestRuntime(args, dependencies);
      break;
    case "ingest-patch-result":
      await runIngestPatchResult(args, dependencies);
      break;
    case "ingest-conformance":
      await runIngestConformance(args, dependencies);
      break;
    case "catalog-link-exact":
      await runCatalogLinkExact(args, dependencies);
      break;
    case "catalog-fuzzy-candidates":
      await runCatalogFuzzyCandidates(args, dependencies);
      break;
    case "catalog-resolve-fixture":
      await runCatalogResolveFixture(args, dependencies);
      break;
    case "catalog-local-corpus-scan":
    case "catalog-local-scan":
      await runCatalogLocalScan(args, dependencies);
      break;
    case "engine-capabilities-record":
      await runEngineCapabilitiesRecord(args, dependencies);
      break;
    case "engine-capabilities-list":
      await runEngineCapabilitiesList(args, dependencies);
      break;
    case "asset-decisions-list":
      await runAssetDecisionsListHandler(args, dependencies);
      break;
    case "structure-export":
      await runStructureExportHandler(args, dependencies);
      break;
    case "queue-health":
      await runQueueHealthHandler(args, dependencies);
      break;
    case "wiki":
      await runWiki(args, dependencies);
      break;
    case "help":
      process.stdout.write(`${buildHelpText(args.includes("--all"))}\n`);
      break;
    case "init":
      await runInitHandler(args, dependencies);
      break;
    default:
      throw new Error(`unknown itotori command: ${String(args[0])}`);
  }
}
