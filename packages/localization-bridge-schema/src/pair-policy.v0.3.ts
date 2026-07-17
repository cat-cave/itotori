/** Retired legacy pair-policy wire contract. */
type Retired = any;
export const PAIR_POLICY_SCHEMA_VERSION = "retired" as const;
export type PairPolicySchemaVersion = Retired;
export const KNOWN_LEGACY_PAIR_POLICY_VERSIONS: ReadonlyArray<string> = [];
export type PairPolicyV03Pair = Retired;
export type StagePostureV03 = Retired;
export type PairPolicyV03Stages = Retired;
export type PairPolicyV03 = Retired;
export const PAIR_POLICY_V03_STAGE_LEAF_PATHS: Retired = [];
export type PairPolicyV03StageLeafPath = Retired;
export const PAIR_POLICY_V03_OPTIONAL_STAGE_LEAF_PATHS: Retired = [];
export function deriveDefaultSeed(_stagePath: string): number {
  return 0;
}
export function deriveDefaultMaxPriceUsd(_defaultCostCapUsd: number, _stageCount: number): number {
  return 0;
}
export function parseZdrDowngradeEnv(_value: string | undefined): Set<string> {
  return new Set();
}
export class PairPolicyVersionMismatchError extends Error {}
export class PairPolicyV03ValidationError extends Error {}
export type PairPolicyV03ParseOptions = Retired;
export function parsePairPolicyV03(_raw: string, _options?: Retired): PairPolicyV03 {
  throw new PairPolicyV03ValidationError("The legacy pair-policy contract has been removed.");
}
export function flattenPairPolicyV03Postures(_policy: PairPolicyV03): Retired[] {
  return [];
}
