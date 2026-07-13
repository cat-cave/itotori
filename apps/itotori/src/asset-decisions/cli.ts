import type { AssetDecisionRecord, AssetLocalizationDecisionAssetKind } from "@itotori/db";

/**
 * CLI-facing, read-only surface for historic asset decisions. Implementations
 * close over the authorization actor so CLI handlers do not have to thread it
 * through. New human policy decisions are intentionally not a CLI action:
 * they neither revise a result nor create a canonical context correction.
 */
export type AssetDecisionsCliPort = {
  loadActiveDecisions(
    projectId: string,
    localeBranchId: string,
    opts?: { kindFilter?: AssetLocalizationDecisionAssetKind },
  ): Promise<AssetDecisionRecord[]>;
};

export type AssetDecisionsListCliArgs = {
  projectId: string;
  localeBranchId: string;
  outputPath: string;
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
