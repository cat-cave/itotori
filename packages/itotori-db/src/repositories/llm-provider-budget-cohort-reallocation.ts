import type { PoolClient } from "pg";

/** Reclaims only capacity that remains after all profile spend and exposure. */
export async function reallocateActiveProviderBudgetShares(
  client: PoolClient,
  input: { readonly profileScope: string; readonly cohortId: string },
  profileCostCapUsd: string,
): Promise<void> {
  await client.query(
    `
      with global_exposure as (
        select
          coalesce(sum(cost_usd) filter (where billing_state = 'confirmed'), 0)
          + coalesce(sum(max_exposure_usd) filter (where attempt_status = 'in-flight'), 0)
            as usd
        from itotori_llm_http_attempts
        where admission_scope = $1
      ), active_members as (
        select admission_run_scope
        from itotori_llm_provider_budget_cohort_members
        where profile_scope = $1 and cohort_id = $2 and member_state = 'active'
      ), active_count as (
        select count(*)::numeric as member_count from active_members
      ), member_exposure as (
        select
          member.admission_run_scope,
          coalesce(sum(attempt.cost_usd) filter (where attempt.billing_state = 'confirmed'), 0)
          + coalesce(sum(attempt.max_exposure_usd) filter (where attempt.attempt_status = 'in-flight'), 0)
            as usd
        from active_members member
        left join itotori_llm_http_attempts attempt
          on attempt.admission_scope = $1
          and attempt.admission_cohort_id = $2
          and attempt.admission_run_scope = member.admission_run_scope
        group by member.admission_run_scope
      ), allocations as (
        select
          member.admission_run_scope,
          member.usd
            + trunc(
              greatest($3::numeric - global_exposure.usd, 0)
                / nullif(active_count.member_count, 0),
              6
            )
            as run_cost_cap_usd
        from member_exposure member cross join global_exposure cross join active_count
      )
      update itotori_llm_provider_budget_cohort_members cohort_member
      set run_cost_cap_usd = allocation.run_cost_cap_usd
      from allocations allocation
      where cohort_member.profile_scope = $1 and cohort_member.cohort_id = $2
        and cohort_member.admission_run_scope = allocation.admission_run_scope
    `,
    [input.profileScope, input.cohortId, profileCostCapUsd],
  );
}
