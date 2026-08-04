import type {
  LlmProviderBudgetCohortActivation,
  LlmProviderBudgetCohortActivationResult,
  LlmProviderBudgetCohortMember,
} from "./llm-provider-budget-cohort-repository.js";

const DECIMAL_SCALE = 6;
const DECIMAL_MULTIPLIER = 10n ** BigInt(DECIMAL_SCALE);

export type NormalizedActivation = Omit<
  LlmProviderBudgetCohortActivation,
  "profileCostCapUsd" | "members"
> & {
  readonly profileCostCapUsd: string;
  readonly members: readonly LlmProviderBudgetCohortMember[];
};

export type ActiveShares = {
  readonly memberCount: number;
  readonly runCostCapUsd: string;
};

export function normalizeActivation(
  input: LlmProviderBudgetCohortActivation,
): NormalizedActivation {
  assertProfileScope(input.profileScope);
  assertIdentifier(input.cohortId, "cohort ID");
  const profileCostCapUsd = normalizeCostCap(input.profileCostCapUsd);
  if (input.members.length === 0) {
    throw new Error("provider-budget cohort requires at least one member");
  }
  const members = [...input.members]
    .map((member) => {
      assertMemberIdentifier(member.projectId, "project ID");
      assertMemberIdentifier(member.runId, "run ID");
      assertIdentifier(member.runScope, "run admission scope");
      return { ...member };
    })
    .sort(compareMembers);
  const duplicateTriples = members.some(
    (member, index) => index > 0 && memberKey(member) === memberKey(members[index - 1]!),
  );
  const duplicateRunScope =
    new Set(members.map((member) => member.runScope)).size !== members.length;
  const duplicateRun = new Set(members.map(memberRunKey)).size !== members.length;
  if (duplicateTriples || duplicateRunScope || duplicateRun) {
    throw new Error("provider-budget cohort member identities must be unique");
  }
  return { ...input, profileCostCapUsd, members };
}

export function fairShare(profileCostCapUsd: string, memberCount: number): string {
  return decimalFromUnits(decimalUnits(profileCostCapUsd) / BigInt(memberCount));
}

export function activationResult(
  activation: NormalizedActivation,
  shares: ActiveShares,
): LlmProviderBudgetCohortActivationResult {
  return {
    profileScope: activation.profileScope,
    cohortId: activation.cohortId,
    profileCostCapUsd: activation.profileCostCapUsd,
    memberCount: shares.memberCount,
    runCostCapUsd: shares.runCostCapUsd,
  };
}

export function normalizeDecimal(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(?<fraction>\.\d*?)0+$/u, "$<fraction>");
}

export function assertProfileScope(value: string): void {
  assertIdentifier(value, "profile scope");
}

export function assertIdentifier(value: string, label: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new Error(`${label} is invalid`);
  }
}

export function assertMemberIdentifier(value: string, label: string): void {
  if (value.length < 1 || value.trim() !== value) throw new Error(`${label} is invalid`);
}

function normalizeCostCap(value: string): string {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,12}))?$/u.exec(value);
  if (match === null || (match[1]?.slice(DECIMAL_SCALE).match(/[1-9]/u) ?? false)) {
    throw new Error("profile cost cap must be representable in whole micros-USD");
  }
  return normalizeDecimal(value);
}

function decimalUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * DECIMAL_MULTIPLIER + BigInt(fraction.padEnd(DECIMAL_SCALE, "0"));
}

function decimalFromUnits(value: bigint): string {
  const whole = value / DECIMAL_MULTIPLIER;
  const fraction = (value % DECIMAL_MULTIPLIER)
    .toString()
    .padStart(DECIMAL_SCALE, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function compareMembers(
  left: LlmProviderBudgetCohortMember,
  right: LlmProviderBudgetCohortMember,
): number {
  const leftKey = memberKey(left);
  const rightKey = memberKey(right);
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}

function memberKey(member: LlmProviderBudgetCohortMember): string {
  return JSON.stringify([member.projectId, member.runId, member.runScope]);
}

function memberRunKey(member: LlmProviderBudgetCohortMember): string {
  return JSON.stringify([member.projectId, member.runId]);
}
