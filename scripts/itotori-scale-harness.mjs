#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const specId = "UNIV-010";
const defaultDatabaseUrl = "postgres://itotori:itotori@127.0.0.1:55433/itotori";

const profiles = {
  smoke: {
    targetJapaneseCharacters: 12_000,
    assetCount: 8,
    maxUnitsPerBatch: 64,
    maxSourceCharactersPerBatch: 4_000,
    queueClaimLimit: 25,
    budgetsMs: {
      generateBundle: 1_000,
      schemaValidation: 1_000,
      importIndex: 20_000,
      batchPlanning: 500,
      queueSchedule: 5_000,
      queueClaim: 1_000,
      dashboardStatus: 1_500,
      runtimeStatus: 1_000,
      costReport: 1_000,
    },
  },
  large: {
    targetJapaneseCharacters: 1_050_000,
    assetCount: 96,
    maxUnitsPerBatch: 128,
    maxSourceCharactersPerBatch: 8_000,
    queueClaimLimit: 100,
    budgetsMs: {
      generateBundle: 10_000,
      schemaValidation: 15_000,
      importIndex: 180_000,
      batchPlanning: 5_000,
      queueSchedule: 45_000,
      queueClaim: 5_000,
      dashboardStatus: 5_000,
      runtimeStatus: 2_000,
      costReport: 2_000,
    },
  },
};

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const profile = profiles[args.profile];
  if (profile === undefined) {
    throw new Error(
      `unknown profile ${args.profile}; expected ${Object.keys(profiles).join(", ")}`,
    );
  }

  const config = {
    ...profile,
    targetJapaneseCharacters: args.targetJapaneseCharacters ?? profile.targetJapaneseCharacters,
    assetCount: args.assetCount ?? profile.assetCount,
  };
  const outputPath = args.outputPath ?? `.tmp/itotori-scale-harness/${args.profile}/summary.json`;
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? defaultDatabaseUrl;

  const modules = await loadBuiltModules();
  const schemaName = isolatedSchemaName(args.profile);
  const measurements = [];
  let context;
  let schemaKept = false;
  let summary;

  try {
    await createSchema(modules.db.createDatabaseContext, databaseUrl, schemaName);
    await modules.db.migrate(databaseUrlWithSearchPath(databaseUrl, schemaName));
    context = modules.db.createDatabaseContext(databaseUrlWithSearchPath(databaseUrl, schemaName));
    const actor = await modules.db.bootstrapLocalUser(context.db);

    const repositories = {
      project: new modules.db.ItotoriProjectRepository(context.db),
      queue: new modules.db.ItotoriEventQueueRepository(context.db),
      ledger: new modules.db.ItotoriModelLedgerRepository(context.db),
    };
    const workflow = new modules.app.ItotoriProjectWorkflowService(
      repositories.project,
      actor,
      undefined,
      repositories.ledger,
    );

    const bridge = await timed(measurements, "generateBundle", () =>
      modules.synthetic.createSyntheticLargeBridgeBundle({
        targetJapaneseCharacters: config.targetJapaneseCharacters,
        assetCount: config.assetCount,
      }),
    );
    await timed(measurements, "schemaValidation", () => {
      modules.schema.assertBridgeBundleV02(bridge);
    });
    const corpus = modules.synthetic.summarizeSyntheticLargeBridgeBundle(bridge);

    const project = await timed(measurements, "importIndex", () => workflow.importBridge(bridge));
    const plan = await timed(measurements, "batchPlanning", () =>
      modules.scale.planDraftBatches(project.bridge.units, {
        maxUnitsPerBatch: config.maxUnitsPerBatch,
        maxSourceCharactersPerBatch: config.maxSourceCharactersPerBatch,
      }),
    );

    const scheduled = await timed(measurements, "queueSchedule", () =>
      repositories.queue.appendOutboxEventWithJobs(actor, {
        event: {
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          eventType: modules.db.outboxEventTypeValues.agentTaskRequested,
          idempotencyKey: `${specId}:${args.profile}:draft-plan:${bridge.bridgeId}`,
          payload: {
            specId,
            profile: args.profile,
            sourceBundleId: bridge.bridgeId,
            batchCount: plan.batches.length,
            unitCount: plan.totalUnits,
          },
        },
        jobs: plan.batches.map((batch) => ({
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          jobType: modules.db.jobTaskTypeValues.agentTask,
          jobName: "draft.translate-batch",
          queueName: "draft",
          idempotency: {
            policy: modules.db.jobIdempotencyPolicyValues.idempotent,
            key: `${specId}:${args.profile}:draft:${batch.batchId}`,
          },
          subjectRefs: [
            {
              subjectKind: "source_bundle",
              subjectId: bridge.bridgeId,
            },
            {
              subjectKind: "locale_branch",
              subjectId: project.localeBranchId,
            },
          ],
          payload: {
            batchId: batch.batchId,
            startIndex: batch.startIndex,
            endIndexExclusive: batch.endIndexExclusive,
            unitCount: batch.unitCount,
            sourceCharacterCount: batch.sourceCharacterCount,
            firstBridgeUnitId: batch.firstBridgeUnitId,
            lastBridgeUnitId: batch.lastBridgeUnitId,
            oversized: batch.oversized,
          },
        })),
      }),
    );

    const claimedJobs = await timed(measurements, "queueClaim", () =>
      repositories.queue.claimJobs(actor, `${specId.toLowerCase()}-${args.profile}-worker`, {
        queueName: "draft",
        limit: Math.min(config.queueClaimLimit, Math.max(1, scheduled.jobs.length)),
        leaseSeconds: 60,
      }),
    );

    const dashboard = await timed(measurements, "dashboardStatus", () =>
      workflow.getDashboardStatus(),
    );
    const runtimeStatus = await timed(measurements, "runtimeStatus", () =>
      workflow.getRuntimeStatus(),
    );
    const costReport = await timed(measurements, "costReport", () =>
      workflow.getCostReport(project.projectId),
    );

    const budget = modules.scale.evaluateScaleBudgets(measurements, config.budgetsMs);
    summary = {
      schemaVersion: "itotori.scale-harness.v1",
      specId,
      profile: args.profile,
      generatedAt: new Date().toISOString(),
      database: {
        schemaName,
        kept: args.keepSchema,
      },
      config: {
        targetJapaneseCharacters: config.targetJapaneseCharacters,
        assetCount: config.assetCount,
        maxUnitsPerBatch: config.maxUnitsPerBatch,
        maxSourceCharactersPerBatch: config.maxSourceCharactersPerBatch,
        queueClaimLimit: config.queueClaimLimit,
        budgetsMs: config.budgetsMs,
      },
      corpus,
      import: {
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        targetLocale: project.targetLocale,
      },
      batchPlan: {
        totalUnits: plan.totalUnits,
        totalSourceCharacters: plan.totalSourceCharacters,
        batchCount: plan.batches.length,
        oversizedUnitCount: plan.oversizedUnitCount,
        firstBatch: plan.batches[0] ?? null,
        lastBatch: plan.batches[plan.batches.length - 1] ?? null,
      },
      queue: {
        outboxEventId: scheduled.outboxEvent.outboxEventId,
        scheduledJobCount: scheduled.jobs.length,
        claimedJobCount: claimedJobs.length,
      },
      dashboard: {
        projectId: dashboard.projectId,
        status: dashboard.status,
        unitCount: dashboard.unitCount,
        branchCount: dashboard.branchCount,
        findingCount: dashboard.findingCount,
        artifactCount: dashboard.artifactCount,
        localeBranches: dashboard.localeBranches,
      },
      runtimeStatus,
      costReport: {
        projectId: costReport.projectId,
        runCount: costReport.runCount,
        includesUnknownCost: costReport.includesUnknownCost,
      },
      timings: budget.results,
      budget: {
        passed: budget.passed,
        failures: budget.failures,
      },
    };

    await writeSummary(outputPath, summary);
    modules.scale.assertScaleBudgets(budget);
  } finally {
    if (context !== undefined) {
      await context.close();
    }
    if (args.keepSchema) {
      schemaKept = true;
    } else {
      await dropSchema(modules.db.createDatabaseContext, databaseUrl, schemaName);
    }
  }

  if (summary !== undefined) {
    console.log(
      JSON.stringify({
        profile: summary.profile,
        outputPath,
        budgetPassed: summary.budget.passed,
        unitCount: summary.corpus.unitCount,
        sourceJapaneseCharacterCount: summary.corpus.sourceJapaneseCharacterCount,
        batchCount: summary.batchPlan.batchCount,
        scheduledJobCount: summary.queue.scheduledJobCount,
        schemaKept,
      }),
    );
  }
}

async function loadBuiltModules() {
  try {
    const [schema, synthetic, db, app, scale] = await Promise.all([
      import(new URL("../packages/localization-bridge-schema/dist/index.js", import.meta.url)),
      import(
        new URL(
          "../packages/localization-bridge-schema/dist/synthetic-large-project.js",
          import.meta.url,
        )
      ),
      import(new URL("../packages/itotori-db/dist/index.js", import.meta.url)),
      import(new URL("../apps/itotori/dist/services/project-workflow.js", import.meta.url)),
      import(new URL("../apps/itotori/dist/services/scale-harness.js", import.meta.url)),
    ]);
    return { schema, synthetic, db, app, scale };
  } catch (error) {
    throw new Error(
      `scale harness requires built TypeScript packages; run just itotori-scale-smoke or pnpm exec vp run ts:build first: ${errorMessage(error)}`,
    );
  }
}

async function timed(measurements, operation, fn) {
  const started = performance.now();
  const result = await fn();
  measurements.push({
    operation,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  });
  return result;
}

async function createSchema(createDatabaseContext, databaseUrl, schemaName) {
  const admin = createDatabaseContext(databaseUrl);
  try {
    await admin.pool.query(`create schema ${quoteIdentifier(schemaName)}`);
  } finally {
    await admin.close();
  }
}

async function dropSchema(createDatabaseContext, databaseUrl, schemaName) {
  const admin = createDatabaseContext(databaseUrl);
  try {
    await admin.pool.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
  } finally {
    await admin.close();
  }
}

async function writeSummary(outputPath, summary) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {
    profile: "smoke",
    keepSchema: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--profile":
        args.profile = requiredValue(argv, (index += 1), arg);
        break;
      case "--target-japanese-characters":
        args.targetJapaneseCharacters = positiveInteger(
          requiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--asset-count":
        args.assetCount = positiveInteger(requiredValue(argv, (index += 1), arg), arg);
        break;
      case "--database-url":
        args.databaseUrl = requiredValue(argv, (index += 1), arg);
        break;
      case "--output":
        args.outputPath = requiredValue(argv, (index += 1), arg);
        break;
      case "--keep-schema":
        args.keepSchema = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function isolatedSchemaName(profile) {
  const safeProfile = profile.replace(/[^a-z0-9_]/giu, "_").toLowerCase();
  return `itotori_scale_${safeProfile}_${process.pid}_${Date.now()}`;
}

function databaseUrlWithSearchPath(databaseUrl, schemaName) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  const script = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} [--profile smoke|large] [options]

Options:
  --profile smoke|large
  --target-japanese-characters N
  --asset-count N
  --database-url URL
  --output PATH
  --keep-schema
`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
