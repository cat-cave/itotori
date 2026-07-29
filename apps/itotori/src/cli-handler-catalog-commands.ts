import { capabilityLevelValues, createCatalogResolverFixtureArtifact } from "@itotori/db";
import type {
  AdapterCapabilityMatrixRecord,
  CapabilityLevel,
  CatalogExactExternalIdLinkRequest,
  CatalogFuzzyCandidateRequest,
  CatalogResolverFixtureInput,
} from "@itotori/db";
import { runAssetDecisionsList, type AssetDecisionsCliPort } from "./asset-decisions/cli.js";
import { optionalFlag, requiredFlag } from "./cli/flags.js";
import type { ItotoriCliDependencies, ItotoriCliServices } from "./cli-handler-contracts.js";
import { parseBooleanFlag, parseNonNegativeInteger } from "./cli-handler-flags.js";
import { configuredServicePort } from "./services/configured-port.js";
import { scanCatalogLocalRoot } from "./services/catalog-local-scan.js";
import { runQueueHealthCli, type QueueHealthCliPort } from "./queue/cli.js";
import { runWikiCommand } from "./cli/wiki-command.js";

export async function runCatalogLinkExact(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const requestPath = requiredFlag(args, "--request");
  const outputPath = requiredFlag(args, "--output");
  const request = dependencies.io.readJson(requestPath) as CatalogExactExternalIdLinkRequest;
  const result = await dependencies.withServices((services) =>
    services.catalogExactExternalIdLinker.linkExactExternalIds(request),
  );
  dependencies.io.writeJson(outputPath, result);
}

export async function runCatalogFuzzyCandidates(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const requestPath = requiredFlag(args, "--request");
  const outputPath = requiredFlag(args, "--output");
  const request = dependencies.io.readJson(requestPath) as CatalogFuzzyCandidateRequest;
  const result = await dependencies.withServices((services) =>
    services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates(request),
  );
  dependencies.io.writeJson(outputPath, result);
}

export async function runCatalogResolveFixture(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const fixturePath = optionalFlag(args, "--fixture") ?? "fixtures/catalog-resolver/fixture.json";
  const outputPath =
    optionalFlag(args, "--output") ?? "artifacts/catalog/resolver-integration.json";
  const fixture = dependencies.io.readJson(fixturePath) as CatalogResolverFixtureInput;
  const artifact = createCatalogResolverFixtureArtifact(fixture);
  dependencies.io.writeJson(outputPath, artifact);
}

export async function runCatalogLocalScan(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const rootPath = requiredFlag(args, "--root");
  const outputPath = requiredFlag(args, "--output");
  const rootLabel = optionalFlag(args, "--root-label");
  const ownedRaw = optionalFlag(args, "--owned");
  const maxDepthRaw = optionalFlag(args, "--max-depth");
  const hashKey = optionalFlag(args, "--hash-key");
  const report = await scanCatalogLocalRoot({
    rootPath,
    ...(rootLabel === undefined ? {} : { rootLabel }),
    ...(ownedRaw === undefined ? {} : { owned: parseBooleanFlag(ownedRaw, "--owned") }),
    ...(maxDepthRaw === undefined
      ? {}
      : { maxDepth: parseNonNegativeInteger(maxDepthRaw, "--max-depth") }),
    ...(hashKey === undefined ? {} : { hashKey }),
  });
  dependencies.io.writeJson(outputPath, report);
}

export async function runEngineCapabilitiesRecord(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const matrixPath = requiredFlag(args, "--matrix");
  const matrix = dependencies.io.readJson(matrixPath);
  assertAdapterCapabilityMatrixRecord(matrix);
  await dependencies.withServices((services) =>
    services.engineCapabilityReports.recordMatrix(matrix),
  );
}

export async function runEngineCapabilitiesList(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const levelRaw = optionalFlag(args, "--level");
  const level = levelRaw === undefined ? undefined : asCapabilityLevel(levelRaw);
  const result = await dependencies.withServices(async (services) => {
    const summaries = await services.engineCapabilityReports.listAdapterSummaries();
    if (level === undefined) return { adapters: summaries };
    const supporting = await services.engineCapabilityReports.adaptersSupporting(level);
    const supportingSet = new Set(supporting);
    return {
      adapters: summaries,
      level,
      adaptersSupporting: supporting,
      identifyOnlyAdapterIds: summaries
        .filter((summary) => !supportingSet.has(summary.adapterId))
        .map((summary) => summary.adapterId),
    };
  });
  dependencies.io.writeJson(outputPath, result);
}

function asCapabilityLevel(value: string): CapabilityLevel {
  switch (value) {
    case capabilityLevelValues.identify:
    case capabilityLevelValues.inventory:
    case capabilityLevelValues.extract:
    case capabilityLevelValues.patch:
      return value;
    default:
      throw new Error(`unknown capability level: ${value}`);
  }
}

function assertAdapterCapabilityMatrixRecord(
  value: unknown,
): asserts value is AdapterCapabilityMatrixRecord {
  if (!value || typeof value !== "object") {
    throw new Error("AdapterCapabilityMatrix payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.adapterId !== "string" || record.adapterId.length === 0) {
    throw new Error("AdapterCapabilityMatrix.adapterId must be a non-empty string");
  }
  for (const level of [
    capabilityLevelValues.identify,
    capabilityLevelValues.inventory,
    capabilityLevelValues.extract,
    capabilityLevelValues.patch,
  ]) {
    assertCapabilityLevelStatus(record[level], `AdapterCapabilityMatrix.${level}`);
  }
}

function assertCapabilityLevelStatus(value: unknown, label: string): void {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "supported":
      return;
    case "partial":
      if (!Array.isArray(record.limitations) || record.limitations.length === 0) {
        throw new Error(`${label}.limitations must be a non-empty string array`);
      }
      for (const entry of record.limitations) {
        if (typeof entry !== "string")
          throw new Error(`${label}.limitations entries must be strings`);
      }
      return;
    case "unsupported":
      if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
        throw new Error(`${label}.reason must be a non-empty string`);
      }
      return;
    default:
      throw new Error(`${label}.kind must be supported, partial, or unsupported`);
  }
}

export async function runAssetDecisionsListHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale");
  const outputPath = requiredFlag(args, "--output");
  await dependencies.withServices(async (services) => {
    const port = requireAssetDecisionsPort(services);
    await runAssetDecisionsList({ projectId, localeBranchId, outputPath }, port, dependencies.io);
  });
}

function requireAssetDecisionsPort(services: ItotoriCliServices): AssetDecisionsCliPort {
  const port = configuredServicePort(services, "assetDecisions");
  if (port === undefined) {
    throw new Error(
      "asset-decisions service is not configured for this CLI context (assetDecisions port missing)",
    );
  }
  return port;
}

export async function runQueueHealthHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const deadLetterLimitRaw = optionalFlag(args, "--dead-letter-limit");
  const projectId = optionalFlag(args, "--project");
  await dependencies.withServices(async (services) => {
    const port = requireQueueHealthPort(services);
    const cliArgs: Parameters<typeof runQueueHealthCli>[0] = { outputPath };
    if (deadLetterLimitRaw !== undefined) {
      cliArgs.deadLetterLimit = parseNonNegativeInteger(deadLetterLimitRaw, "--dead-letter-limit");
    }
    if (projectId !== undefined) cliArgs.projectId = projectId;
    await runQueueHealthCli(cliArgs, port, dependencies.io);
  });
}

export async function runWiki(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  await dependencies.withServices(async (services) => {
    const building = args[1] === "build";
    const service = configuredServicePort(services, "wikiObjectApi");
    const wikiBuild = configuredServicePort(services, "wikiBuild");
    if (!building && service === undefined) {
      throw new Error(
        "wiki is not configured in this CLI build (wikiObjectApi port missing — the new-pipeline Wiki object-API service is not installed)",
      );
    }
    if (building && wikiBuild === undefined) {
      throw new Error(
        "wiki build is not configured in this CLI build (wikiBuild port missing — the source-Wiki analyst substrate is not installed)",
      );
    }
    await runWikiCommand(args, {
      io: {
        readJson: (path) => dependencies.io.readJson(path),
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
      },
      resolveWikiService: () => {
        if (service === undefined) throw new Error("wiki object API is not configured");
        return service;
      },
      ...(wikiBuild === undefined ? {} : { runBuild: (input) => wikiBuild.run(input) }),
    });
  });
}

function requireQueueHealthPort(services: ItotoriCliServices): QueueHealthCliPort {
  const port = configuredServicePort(services, "queueHealth");
  if (port === undefined) {
    throw new Error(
      "queue-health service is not configured for this CLI context (queueHealth port missing)",
    );
  }
  return port;
}
