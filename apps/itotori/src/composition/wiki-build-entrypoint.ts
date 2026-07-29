// Production source-Wiki build composition.
//
// This is the one place that joins the deterministic source-Wiki executor to
// the bespoke A1–A10 roles, the integrity-checked read model, the repository
// ledger, and the sole ZDR dispatch runtime. The CLI only calls `runWikiBuild`;
// it never reaches into source-wiki or an analyst role directly.

import type {
  ItotoriLlmWikiRepository,
  LlmContentReadAuthorizer,
  LlmContextSnapshot,
  LlmCallMemoStore,
} from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import {
  WikiObjectSchema,
  type ContextScopeValue,
  type RoleId,
  type RunModeValue,
  type WikiObject,
} from "../contracts/index.js";
import type { DispatchRuntime } from "../llm/dispatch.js";
import { resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import { buildFactSnapshot } from "../prepass/index.js";
import { buildReadModel, type ReadModel } from "../read-tools/index.js";
import {
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  parseNarrativeStructure,
} from "../structure/index.js";
import {
  createDispatchRuntime,
  type LiveDispatchRuntimeConfig,
  type RunSnapshotRevisions,
} from "./live/dispatch-runtime.js";
import {
  createRepositoryArtifactLedger,
  orchestrateSourceWiki,
  type AnalystRunner,
  type OrchestrateSourceWikiDeps,
  type SourceWikiRunReport,
} from "../source-wiki/index.js";
import type { A7PortraitSource } from "../roles/a7/index.js";
import { runAnalystRole } from "./wiki-build-analyst-roles.js";

/** Source supplied by the external render/patch-report substrate. Portrait
 * media is not present in a bridge or fact snapshot, so it is explicit input to
 * this build rather than a guessed hash/URI/dimension. */
export type WikiBuildPortraitSources = ReadonlyMap<string, A7PortraitSource>;

/** Invocation data the CLI owns. The service factory supplies the durable DB,
 * authorization, snapshot, and dispatch substrate separately. */
export interface WikiBuildInvocation {
  readonly structureJson: unknown;
  readonly bridge: BridgeBundleV02;
  readonly sourceLanguage: string;
  readonly runMode: RunModeValue;
  readonly concurrency: number;
  readonly roles?: readonly RoleId[];
  readonly portraitSources?: WikiBuildPortraitSources;
}

/** The production dependencies for one source-Wiki build. The service factory
 * owns authentication/repositories; the command owns the invocation's decode
 * artifacts and run selection. */
export interface WikiBuildDeps {
  readonly structureJson: WikiBuildInvocation["structureJson"];
  readonly bridge: WikiBuildInvocation["bridge"];
  readonly contextSnapshot: LlmContextSnapshot;
  readonly sourceLanguage: WikiBuildInvocation["sourceLanguage"];
  readonly runMode: WikiBuildInvocation["runMode"];
  readonly concurrency: WikiBuildInvocation["concurrency"];
  readonly roles?: readonly RoleId[];
  readonly maxAttempts?: number;
  readonly repository: ItotoriLlmWikiRepository;
  readonly memoStore: LlmCallMemoStore;
  readonly contentAccess: LlmContentReadAuthorizer;
  readonly dispatch: Omit<LiveDispatchRuntimeConfig, "memoStore" | "contentAccess" | "snapshots">;
  readonly dispatchSnapshots: RunSnapshotRevisions;
  readonly operatorBrief?: string;
  readonly portraitSources?: WikiBuildPortraitSources;
}

/** Build and execute the full source-language A1–A10 analyst wave. The fact
 * snapshot and read model are rebuilt from the invocation artifacts, then bound
 * to the persisted context snapshot before any model call can occur. */
export async function runWikiBuild(deps: WikiBuildDeps): Promise<SourceWikiRunReport> {
  const structure = parseNarrativeStructure(
    deps.structureJson,
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
  const snapshot = buildFactSnapshot(structure, deps.bridge);
  const model = buildReadModel({
    contextSnapshot: deps.contextSnapshot,
    factSnapshot: snapshot,
    bundle: deps.bridge,
  });
  if (model.sourceLanguage !== deps.sourceLanguage) {
    throw new Error(
      `wiki build source locale ${deps.sourceLanguage} does not match context snapshot ${model.sourceLanguage}`,
    );
  }
  const payloads = new Map<string, string>();
  const runner = createAnalystRunner({
    model,
    runtimeForRole: (role) => createAnalystDispatchRuntime({ deps, payloads, role }),
    payloads,
    repository: deps.repository,
    operatorBrief: deps.operatorBrief ?? "No additional operator brief was supplied.",
    portraitSources: deps.portraitSources ?? new Map(),
  });
  const orchestratorDeps: OrchestrateSourceWikiDeps = {
    snapshot,
    readModel: model,
    sourceLanguage: deps.sourceLanguage,
    runMode: deps.runMode,
    ...(deps.roles === undefined ? {} : { roles: deps.roles }),
    concurrency: deps.concurrency,
    ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }),
    runner,
    ledger: createRepositoryArtifactLedger({
      repository: deps.repository,
      snapshotId: deps.contextSnapshot.snapshotId,
    }),
  };
  return await orchestrateSourceWiki(orchestratorDeps);
}

interface AnalystRunnerDeps {
  readonly model: ReadModel;
  /** A role gets its own measured profile; the durable dispatch substrate stays shared. */
  readonly runtimeForRole: (role: RoleId) => DispatchRuntime;
  readonly payloads: Map<string, string>;
  readonly repository: ItotoriLlmWikiRepository;
  readonly operatorBrief: string;
  readonly portraitSources: WikiBuildPortraitSources;
}

type AnalystRoleDeps = Omit<AnalystRunnerDeps, "runtimeForRole"> & {
  readonly runtime: DispatchRuntime;
};

/**
 * Construct the dispatch runtime for one analyst role. The localization factory
 * supplies the shared ZDR routing, durable memo, content authorization,
 * snapshots, and spend cap, but P1's measured profile must never be reused for
 * an A-role CallSpec. Keep the deadline posture in lockstep with
 * `productionLocalizeDispatchConfig`: only the certified role profile identity
 * changes here.
 */
export function createAnalystDispatchRuntime(input: {
  readonly deps: Pick<
    WikiBuildDeps,
    "dispatch" | "memoStore" | "contentAccess" | "dispatchSnapshots"
  >;
  readonly payloads: ReadonlyMap<string, string>;
  readonly role: RoleId;
}): DispatchRuntime {
  const roleProfile = resolveRoleModelProfile(input.role);
  const base = createDispatchRuntime({
    ...input.deps.dispatch,
    profile: {
      name: roleProfile.modelProfile,
      version: roleProfile.version,
      deadlines: { normalMs: 30_000, deepMs: 300_000 },
      maxAttemptExposureUsd: input.deps.dispatch.profile.maxAttemptExposureUsd,
    },
    memoStore: input.deps.memoStore,
    contentAccess: input.deps.contentAccess,
    snapshots: input.deps.dispatchSnapshots,
  });
  return {
    ...base,
    readPayload: async (reference) => {
      const payload = input.payloads.get(reference.storageRef);
      if (payload === undefined) {
        throw new Error(`source-Wiki dispatch has no payload for ${reference.storageRef}`);
      }
      return payload;
    },
  };
}

/** Stamp the SYSTEM-owned provenance fields on each source-wiki object with the
 * authoritative run context. The analyst model authors the object CONTENT; the
 * audit-trail identifiers (which snapshot, which scope, which run mode, which
 * role) are deterministic system facts the model must NOT own — it cannot echo
 * the 64-char snapshot hash (it emits zeros) and has authored a wrong runMode.
 * Analyst outputs are always source objects (snapshotKind "context"). */
export function stampSourceProvenance(
  objects: readonly WikiObject[],
  authority: {
    readonly contextSnapshotId: `sha256:${string}`;
    readonly contextScope: ContextScopeValue;
    readonly runMode: RunModeValue;
    readonly authorRoleId: RoleId;
    readonly subject: WikiObject["subject"];
    readonly scope: WikiObject["scope"];
  },
): readonly WikiObject[] {
  return objects.map((object) => {
    // Analyst outputs are always SOURCE objects; a translation object here would
    // be a contract violation, so leave it untouched rather than stamp it.
    if (object.kind === "translation") return object;
    return {
      ...object,
      // The assigned (subject, scope) identity is system-owned — the model invents
      // the subject id (a made-up game id) which acceptObject rejects off-target.
      subject: authority.subject,
      scope: authority.scope,
      // Version is system-owned: a source-Wiki build produces the FIRST version of
      // each object. The model copies the few-shot's v2/supersedes:1 pair and can
      // emit an inconsistent one that violates the version check constraint.
      version: 1,
      supersedesVersion: null,
      provenance: {
        ...object.provenance,
        contextSnapshotId: authority.contextSnapshotId,
        contextScope: authority.contextScope,
        runMode: authority.runMode,
        authorRoleId: authority.authorRoleId,
      },
    };
  });
}

/** Build the real exhaustive role dispatcher. Each branch enters that role's
 * certified dispatch helper, then lets the role's own fold/assembly code
 * re-derive citations and structural facts before the orchestrator accepts it. */
export function createAnalystRunner(deps: AnalystRunnerDeps): AnalystRunner {
  const returned = new Map<string, WikiObject>();
  const runtimes = new Map<RoleId, DispatchRuntime>();
  let persisted: readonly WikiObject[] | undefined;
  const runtimeForRole = (role: RoleId): DispatchRuntime => {
    const existing = runtimes.get(role);
    if (existing !== undefined) return existing;
    const runtime = deps.runtimeForRole(role);
    runtimes.set(role, runtime);
    return runtime;
  };
  const remember = (objects: readonly WikiObject[]): readonly WikiObject[] => {
    for (const object of objects) returned.set(object.objectId, object);
    return objects;
  };
  const sourceObjects = async (): Promise<readonly WikiObject[]> => {
    if (persisted === undefined) {
      const records = await deps.repository.listObjects({
        snapshotId: deps.model.snapshotId,
        wikiKind: "source-object",
      });
      persisted = records.map((record) => WikiObjectSchema.parse(JSON.parse(record.objectJson)));
    }
    return [...persisted, ...returned.values()];
  };
  const findObject = async (objectId: string, kind: WikiObject["kind"]): Promise<WikiObject> => {
    const object = (await sourceObjects()).find(
      (candidate) => candidate.objectId === objectId && candidate.kind === kind,
    );
    if (object === undefined) {
      throw new Error(`source-Wiki role dependency ${kind}:${objectId} is not installed`);
    }
    return object;
  };

  return async (input) => {
    const roleDeps: AnalystRoleDeps = { ...deps, runtime: runtimeForRole(input.role) };
    const produced = await runAnalystRole(input, roleDeps, findObject);
    // Provenance AND identity are SYSTEM facts, not model judgments: the analyst
    // model cannot reliably echo the 64-char snapshot hash (it emits zeros), has
    // authored a wrong runMode, and invents the subject id (e.g. a made-up game
    // id) — which makes acceptObject reject it off-target. Stamp the system-owned
    // provenance + the assigned (subject, scope) identity authoritatively from the
    // step before the object is accepted/persisted. The model still authors the
    // object CONTENT (body + claims).
    return remember(
      stampSourceProvenance(produced, {
        contextSnapshotId: deps.model.snapshotId,
        contextScope: input.contextScope,
        runMode: input.runMode,
        authorRoleId: input.role,
        subject: input.step.subject,
        scope: input.step.scope,
      }),
    );
  };
}

/** Exported for a cheap exhaustive-mapping proof without invoking ZDR/DB. */
export const ANALYST_RUNNER_ROLE_IDS: readonly RoleId[] = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
];

export function assertAnalystRunnerCoverage(roles: readonly RoleId[]): void {
  const handled = new Set(ANALYST_RUNNER_ROLE_IDS);
  for (const role of roles) {
    if (!handled.has(role))
      throw new Error(`source-Wiki runner has no dispatch mapping for ${role}`);
  }
}
