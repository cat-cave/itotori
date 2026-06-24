import {
  assetLocalizationDecisionAssetKindList,
  assetLocalizationDecisionPolicyList,
  type AssetDecisionRecord,
  type AssetLocalizationDecisionAssetKind,
  type AssetLocalizationDecisionAssetRef,
  type AssetLocalizationDecisionPolicy,
  type RecordAssetDecisionInput,
} from "@itotori/db";

/**
 * CLI-facing surface for asset-decision read/write. Implementations
 * close over the authorization actor so CLI handlers do not have to
 * thread it through.
 */
export type AssetDecisionsCliPort = {
  loadActiveDecisions(projectId: string, localeBranchId: string): Promise<AssetDecisionRecord[]>;
  recordDecision(input: RecordAssetDecisionInput): Promise<AssetDecisionRecord>;
};

export type AssetDecisionsListCliArgs = {
  projectId: string;
  localeBranchId: string;
  outputPath: string;
};

export type AssetDecisionsRecordCliArgs = {
  projectId: string;
  localeBranchId: string;
  assetRef: AssetLocalizationDecisionAssetRef;
  assetKind: AssetLocalizationDecisionAssetKind;
  policy: AssetLocalizationDecisionPolicy;
  rationale?: string;
  outputPath?: string;
};

export type AssetDecisionsCliWriter = {
  writeJson(path: string, value: unknown): void;
};

export async function runAssetDecisionsList(
  args: AssetDecisionsListCliArgs,
  port: AssetDecisionsCliPort,
  io: AssetDecisionsCliWriter,
): Promise<AssetDecisionRecord[]> {
  const decisions = await port.loadActiveDecisions(args.projectId, args.localeBranchId);
  io.writeJson(args.outputPath, {
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    decisions,
  });
  return decisions;
}

export async function runAssetDecisionsRecord(
  args: AssetDecisionsRecordCliArgs,
  port: AssetDecisionsCliPort,
  io: AssetDecisionsCliWriter,
): Promise<AssetDecisionRecord> {
  const input: RecordAssetDecisionInput = {
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    assetRef: args.assetRef,
    assetKind: args.assetKind,
    decisionPolicy: args.policy,
  };
  if (args.rationale !== undefined) {
    input.decisionRationale = args.rationale;
  }
  const recorded = await port.recordDecision(input);
  if (args.outputPath !== undefined) {
    io.writeJson(args.outputPath, recorded);
  }
  return recorded;
}

export function parseAssetKind(value: string): AssetLocalizationDecisionAssetKind {
  if (!(assetLocalizationDecisionAssetKindList as readonly string[]).includes(value)) {
    throw new Error(
      `unknown asset kind: ${value} (expected one of ${assetLocalizationDecisionAssetKindList.join(", ")})`,
    );
  }
  return value as AssetLocalizationDecisionAssetKind;
}

export function parseAssetDecisionPolicy(value: string): AssetLocalizationDecisionPolicy {
  if (!(assetLocalizationDecisionPolicyList as readonly string[]).includes(value)) {
    throw new Error(
      `unknown asset decision policy: ${value} (expected one of ${assetLocalizationDecisionPolicyList.join(", ")})`,
    );
  }
  return value as AssetLocalizationDecisionPolicy;
}

export function parseAssetRef(value: string): AssetLocalizationDecisionAssetRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `--asset-ref must be JSON; got: ${value} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`--asset-ref must be a JSON object with kind+ref keys`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind.length === 0) {
    throw new Error(`--asset-ref.kind must be a non-empty string`);
  }
  if (typeof record.ref !== "string" || record.ref.length === 0) {
    throw new Error(`--asset-ref.ref must be a non-empty string`);
  }
  return record as AssetLocalizationDecisionAssetRef;
}
