import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import {
  activationResult,
  assertIdentifier,
  assertMemberIdentifier,
  assertProfileScope,
  fairShare,
  normalizeActivation,
  normalizeDecimal,
  type NormalizedActivation,
} from "./llm-provider-budget-cohort-values.js";
import { reallocateActiveProviderBudgetShares } from "./llm-provider-budget-cohort-reallocation.js";

export interface LlmProviderBudgetCohortMember {
  readonly projectId: string;
  readonly runId: string;
  readonly runScope: string;
}

/** The complete, immutable set of localization runs sharing one profile budget. */
export interface LlmProviderBudgetCohortActivation {
  readonly profileScope: string;
  readonly profileCostCapUsd: string;
  readonly cohortId: string;
  readonly members: readonly LlmProviderBudgetCohortMember[];
}

export interface LlmProviderBudgetCohortActivationResult {
  readonly profileScope: string;
  readonly cohortId: string;
  readonly profileCostCapUsd: string;
  readonly memberCount: number;
  readonly runCostCapUsd: string;
}

export interface LlmProviderBudgetCohortMemberLookup {
  readonly profileScope: string;
  readonly cohortId: string;
  readonly runScope: string;
}

export interface LlmProviderBudgetCohortMemberReservation {
  readonly profileScope: string;
  readonly cohortId: string;
  readonly runScope: string;
  readonly runCostCapUsd: string;
}

export interface LlmProviderBudgetCohortRelease {
  readonly profileScope: string;
  readonly cohortId: string;
  readonly projectId: string;
  readonly runId: string;
}

export interface LlmProviderBudgetCohortReleaseResult {
  readonly memberReleased: boolean;
  readonly cohortReleased: boolean;
}

export class LlmProviderBudgetCohortBusyError extends Error {
  constructor(
    readonly profileScope: string,
    readonly requestedCohortId: string,
    readonly activeCohortId: string,
  ) {
    super(
      `profile ${profileScope} already has active provider-budget cohort ${activeCohortId}; ` +
        `cannot activate ${requestedCohortId}`,
    );
    this.name = "LlmProviderBudgetCohortBusyError";
  }
}

export class LlmProviderBudgetCohortDefinitionMismatchError extends Error {
  constructor(
    readonly profileScope: string,
    readonly cohortId: string,
  ) {
    super(`provider-budget cohort ${cohortId} does not match its durable definition`);
    this.name = "LlmProviderBudgetCohortDefinitionMismatchError";
  }
}

export class LlmProviderBudgetCohortMemberUnavailableError extends Error {
  constructor(readonly lookup: LlmProviderBudgetCohortMemberLookup) {
    super(
      `provider-budget cohort member is not active for ${lookup.profileScope}/${lookup.cohortId}`,
    );
    this.name = "LlmProviderBudgetCohortMemberUnavailableError";
  }
}

type Queryable = Pick<DatabaseContext["pool"], "query">;

/** One profile cohort fixes its member set before any run is admitted. */
export class ItotoriLlmProviderBudgetCohortRepository {
  constructor(private readonly pool: DatabaseContext["pool"]) {}

  async activate(
    input: LlmProviderBudgetCohortActivation,
  ): Promise<LlmProviderBudgetCohortActivationResult> {
    const activation = normalizeActivation(input);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockLlmProviderBudgetProfile(client, activation.profileScope);
      const result = await this.declareInTransaction(client, activation);
      await client.query("commit");
      return result;
    } catch (error: unknown) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Verifies a preactivated immutable cohort; it never creates or changes one. */
  async activateInTransaction(
    client: PoolClient,
    input: LlmProviderBudgetCohortActivation,
  ): Promise<LlmProviderBudgetCohortActivationResult> {
    const activation = normalizeActivation(input);
    await lockLlmProviderBudgetProfile(client, activation.profileScope);
    const cohort = await this.findActiveCohort(client, activation.profileScope);
    if (!cohort) throw unavailable(activation);
    if (cohort.cohort_id !== activation.cohortId) {
      throw new LlmProviderBudgetCohortBusyError(
        activation.profileScope,
        activation.cohortId,
        cohort.cohort_id,
      );
    }
    await this.assertExactDefinition(client, activation, cohort);
    return this.activeResult(activation, cohort);
  }

  async activeMember(
    lookup: LlmProviderBudgetCohortMemberLookup,
    queryable: Queryable = this.pool,
  ): Promise<LlmProviderBudgetCohortMemberReservation> {
    assertProfileScope(lookup.profileScope);
    assertIdentifier(lookup.cohortId, "cohort ID");
    assertIdentifier(lookup.runScope, "run admission scope");
    const result = await queryable.query<MemberCostRow>(
      `
        select member.run_cost_cap_usd::text
        from itotori_llm_provider_budget_cohorts cohort
        join itotori_llm_provider_budget_cohort_members member
          on member.profile_scope = cohort.profile_scope and member.cohort_id = cohort.cohort_id
        where cohort.profile_scope = $1 and cohort.cohort_id = $2
          and cohort.cohort_state = 'active'
          and member.admission_run_scope = $3 and member.member_state = 'active'
      `,
      [lookup.profileScope, lookup.cohortId, lookup.runScope],
    );
    const row = result.rows[0];
    if (!row) throw new LlmProviderBudgetCohortMemberUnavailableError(lookup);
    return {
      profileScope: lookup.profileScope,
      cohortId: lookup.cohortId,
      runScope: lookup.runScope,
      runCostCapUsd: normalizeDecimal(row.run_cost_cap_usd),
    };
  }

  async release(
    input: LlmProviderBudgetCohortRelease,
  ): Promise<LlmProviderBudgetCohortReleaseResult> {
    assertProfileScope(input.profileScope);
    assertIdentifier(input.cohortId, "cohort ID");
    assertMemberIdentifier(input.projectId, "project ID");
    assertMemberIdentifier(input.runId, "run ID");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockLlmProviderBudgetProfile(client, input.profileScope);
      const cohort = (await this.findCohort(client, input)).rows[0];
      if (!cohort) {
        await client.query("commit");
        return { memberReleased: false, cohortReleased: false };
      }
      if (cohort.cohort_state === "released") {
        await client.query("commit");
        return { memberReleased: false, cohortReleased: false };
      }
      const released = await client.query(
        `
          update itotori_llm_provider_budget_cohort_members
          set member_state = 'released', released_at = now()
          where profile_scope = $1 and cohort_id = $2 and project_id = $3 and run_id = $4
            and member_state = 'active'
        `,
        [input.profileScope, input.cohortId, input.projectId, input.runId],
      );
      if (released.rowCount !== 1) {
        await client.query("commit");
        return { memberReleased: false, cohortReleased: false };
      }
      const activeCount = await this.activeMemberCount(client, input.profileScope, input.cohortId);
      const closed =
        activeCount === 0
          ? await client.query(
              `
                update itotori_llm_provider_budget_cohorts
                set member_count = 0, cohort_state = 'released', released_at = now()
                where profile_scope = $1 and cohort_id = $2 and cohort_state = 'active'
              `,
              [input.profileScope, input.cohortId],
            )
          : undefined;
      if (activeCount > 0) {
        await this.reallocateActiveShares(client, input, cohort.profile_cost_cap_usd, activeCount);
      }
      await client.query("commit");
      return { memberReleased: true, cohortReleased: closed?.rowCount === 1 };
    } catch (error: unknown) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async declareInTransaction(
    client: PoolClient,
    activation: NormalizedActivation,
  ): Promise<LlmProviderBudgetCohortActivationResult> {
    const active = await this.findActiveCohort(client, activation.profileScope);
    if (active && active.cohort_id !== activation.cohortId) {
      throw new LlmProviderBudgetCohortBusyError(
        activation.profileScope,
        activation.cohortId,
        active.cohort_id,
      );
    }
    const cohort = active ?? (await this.findCohort(client, activation)).rows[0];
    if (!cohort) return await this.createCohort(client, activation);
    await this.assertExactDefinition(client, activation, cohort);
    if (cohort.cohort_state === "released") {
      if (activation.members.length !== 1) throw unavailable(activation);
      return await this.reactivateSingleton(client, activation);
    }
    return this.activeResult(activation, cohort);
  }

  private async assertExactDefinition(
    client: PoolClient,
    activation: NormalizedActivation,
    cohort: CohortRow,
  ): Promise<void> {
    if (normalizeDecimal(cohort.profile_cost_cap_usd) !== activation.profileCostCapUsd) {
      throw definitionMismatch(activation);
    }
    const members = await this.members(client, activation);
    if (!sameMembers(activation.members, members)) throw definitionMismatch(activation);
  }

  private activeResult(
    activation: NormalizedActivation,
    cohort: CohortRow,
  ): LlmProviderBudgetCohortActivationResult {
    return activationResult(activation, {
      memberCount: cohort.member_count,
      runCostCapUsd: fairShare(activation.profileCostCapUsd, cohort.member_count),
    });
  }

  private async reactivateSingleton(
    client: PoolClient,
    activation: NormalizedActivation,
  ): Promise<LlmProviderBudgetCohortActivationResult> {
    const shares = { memberCount: 1, runCostCapUsd: activation.profileCostCapUsd };
    const restored = await client.query(
      `
        update itotori_llm_provider_budget_cohort_members
        set member_state = 'active', released_at = null, run_cost_cap_usd = $3::numeric
        where profile_scope = $1 and cohort_id = $2 and member_state = 'released'
      `,
      [activation.profileScope, activation.cohortId, shares.runCostCapUsd],
    );
    if (restored.rowCount !== shares.memberCount) throw definitionMismatch(activation);
    const reactivated = await client.query(
      `
        update itotori_llm_provider_budget_cohorts
        set member_count = $3, cohort_state = 'active', released_at = null
        where profile_scope = $1 and cohort_id = $2 and cohort_state = 'released'
      `,
      [activation.profileScope, activation.cohortId, shares.memberCount],
    );
    if (reactivated.rowCount !== shares.memberCount) throw definitionMismatch(activation);
    return activationResult(activation, shares);
  }

  private async findActiveCohort(
    client: PoolClient,
    profileScope: string,
  ): Promise<CohortRow | undefined> {
    return (
      await client.query<CohortRow>(
        `
          select cohort_id, profile_cost_cap_usd::text, member_count, cohort_state
          from itotori_llm_provider_budget_cohorts
          where profile_scope = $1 and cohort_state = 'active'
          for update
        `,
        [profileScope],
      )
    ).rows[0];
  }

  private async findCohort(
    client: PoolClient,
    input: Pick<LlmProviderBudgetCohortActivation, "profileScope" | "cohortId">,
  ) {
    return await client.query<CohortRow>(
      `
        select cohort_id, profile_cost_cap_usd::text, member_count, cohort_state
        from itotori_llm_provider_budget_cohorts
        where profile_scope = $1 and cohort_id = $2
        for update
      `,
      [input.profileScope, input.cohortId],
    );
  }

  private async createCohort(
    client: PoolClient,
    activation: NormalizedActivation,
  ): Promise<LlmProviderBudgetCohortActivationResult> {
    const shares = {
      memberCount: activation.members.length,
      runCostCapUsd: fairShare(activation.profileCostCapUsd, activation.members.length),
    };
    await client.query(
      `
        insert into itotori_llm_provider_budget_cohorts (
          profile_scope, cohort_id, profile_cost_cap_usd, member_count, cohort_state
        ) values ($1, $2, $3::numeric, $4, 'active')
      `,
      [
        activation.profileScope,
        activation.cohortId,
        activation.profileCostCapUsd,
        shares.memberCount,
      ],
    );
    await this.insertMembers(client, activation, shares.runCostCapUsd);
    return activationResult(activation, shares);
  }

  private async members(
    client: PoolClient,
    activation: NormalizedActivation,
  ): Promise<MemberRow[]> {
    return (
      await client.query<MemberRow>(
        `
          select project_id, run_id, admission_run_scope
          from itotori_llm_provider_budget_cohort_members
          where profile_scope = $1 and cohort_id = $2
          for update
        `,
        [activation.profileScope, activation.cohortId],
      )
    ).rows;
  }

  private async insertMembers(
    client: PoolClient,
    activation: NormalizedActivation,
    runCostCapUsd: string,
  ): Promise<void> {
    for (const member of activation.members) {
      await client.query(
        `
          insert into itotori_llm_provider_budget_cohort_members (
            profile_scope, cohort_id, project_id, run_id, admission_run_scope,
            run_cost_cap_usd, member_state
          ) values ($1, $2, $3, $4, $5, $6::numeric, 'active')
        `,
        [
          activation.profileScope,
          activation.cohortId,
          member.projectId,
          member.runId,
          member.runScope,
          runCostCapUsd,
        ],
      );
    }
  }

  private async activeMemberCount(
    client: PoolClient,
    profileScope: string,
    cohortId: string,
  ): Promise<number> {
    const result = await client.query<CountRow>(
      `
        select count(*)::integer as member_count
        from itotori_llm_provider_budget_cohort_members
        where profile_scope = $1 and cohort_id = $2 and member_state = 'active'
      `,
      [profileScope, cohortId],
    );
    return result.rows[0]?.member_count ?? 0;
  }

  private async reallocateActiveShares(
    client: PoolClient,
    input: Pick<LlmProviderBudgetCohortActivation, "profileScope" | "cohortId">,
    profileCostCapUsd: string,
    memberCount: number,
  ): Promise<void> {
    await reallocateActiveProviderBudgetShares(client, input, normalizeDecimal(profileCostCapUsd));
    await client.query(
      `
        update itotori_llm_provider_budget_cohorts
        set member_count = $3, cohort_state = 'active', released_at = null
        where profile_scope = $1 and cohort_id = $2
      `,
      [input.profileScope, input.cohortId, memberCount],
    );
  }
}

export async function lockLlmProviderBudgetProfile(
  client: PoolClient,
  profileScope: string,
): Promise<void> {
  assertProfileScope(profileScope);
  await client.query(
    "select pg_advisory_xact_lock(hashtext($1), hashtext('itotori-llm-profile-admission'))",
    [profileScope],
  );
}

type CohortRow = {
  cohort_id: string;
  profile_cost_cap_usd: string;
  member_count: number;
  cohort_state: "active" | "released";
};

type MemberRow = { project_id: string; run_id: string; admission_run_scope: string };

type MemberCostRow = { run_cost_cap_usd: string };
type CountRow = { member_count: number };

function unavailable(
  activation: NormalizedActivation,
): LlmProviderBudgetCohortMemberUnavailableError {
  return new LlmProviderBudgetCohortMemberUnavailableError({
    profileScope: activation.profileScope,
    cohortId: activation.cohortId,
    runScope: activation.members[0]!.runScope,
  });
}

function definitionMismatch(
  activation: Pick<LlmProviderBudgetCohortActivation, "profileScope" | "cohortId">,
): LlmProviderBudgetCohortDefinitionMismatchError {
  return new LlmProviderBudgetCohortDefinitionMismatchError(
    activation.profileScope,
    activation.cohortId,
  );
}

function sameMembers(
  declared: readonly LlmProviderBudgetCohortMember[],
  durable: readonly MemberRow[],
): boolean {
  if (declared.length !== durable.length) return false;
  const declaredKeys = new Set(declared.map(memberKey));
  return durable.every((member) => declaredKeys.has(durableMemberKey(member)));
}

function memberKey(member: LlmProviderBudgetCohortMember): string {
  return JSON.stringify([member.projectId, member.runId, member.runScope]);
}

function durableMemberKey(member: MemberRow): string {
  return JSON.stringify([member.project_id, member.run_id, member.admission_run_scope]);
}
