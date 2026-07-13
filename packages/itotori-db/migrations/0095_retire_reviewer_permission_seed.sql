-- Replace the old deterministic Reviewer starter set with Contributor for
-- already-provisioned accounts. Permission sets are data, so only the old
-- seed-id pattern is touched; administrator-created sets stay untouched. The
-- replacement intentionally omits queue permissions and keeps the legitimate
-- draft, feedback, style-guide, and catalog capabilities. A pre-existing
-- administrator-created `Contributor` label stays untouched: the deterministic
-- replacement gets an unambiguous migration label in that account instead.

with retired_permission_sets as (
  select
    permission_set_id as reviewer_set_id,
    account_id,
    'permission-set-' || account_id || '-contributor' as contributor_set_id
  from itotori_auth_permission_sets
  where permission_set_id = 'permission-set-' || account_id || '-reviewer'
), contributor_targets as (
  select
    retired_permission_sets.*,
    case
      when exists (
        select 1
        from itotori_auth_permission_sets as existing_set
        where existing_set.account_id = retired_permission_sets.account_id
          and existing_set.name = 'Contributor'
          and existing_set.permission_set_id <> retired_permission_sets.contributor_set_id
      ) then format(
        'Contributor (migrated: %s)',
        retired_permission_sets.contributor_set_id
      )
      else 'Contributor'
    end as contributor_name
  from retired_permission_sets
)
insert into itotori_auth_permission_sets (
  permission_set_id,
  account_id,
  name,
  description
)
select
  contributor_set_id,
  account_id,
  contributor_name,
  'Contribute drafts, feedback, style-guide changes, and catalog context.'
from contributor_targets
on conflict (permission_set_id) do nothing;

with retired_permission_sets as (
  select 'permission-set-' || account_id || '-contributor' as contributor_set_id
  from itotori_auth_permission_sets
  where permission_set_id = 'permission-set-' || account_id || '-reviewer'
)
insert into itotori_auth_permission_set_permissions (permission_set_id, permission)
select
  retired_permission_sets.contributor_set_id,
  required_permissions.permission
from retired_permission_sets
cross join (
  values
    ('draft.write'),
    ('feedback.import'),
    ('style_guide.approve'),
    ('catalog.read')
) as required_permissions(permission)
on conflict (permission_set_id, permission) do nothing;

with retired_permission_sets as (
  select
    permission_set_id as reviewer_set_id,
    'permission-set-' || account_id || '-contributor' as contributor_set_id
  from itotori_auth_permission_sets
  where permission_set_id = 'permission-set-' || account_id || '-reviewer'
)
insert into itotori_auth_principal_permission_set_grants (
  principal_id,
  permission_set_id,
  granted_at
)
select
  set_grant.principal_id,
  retired_permission_sets.contributor_set_id,
  set_grant.granted_at
from itotori_auth_principal_permission_set_grants as set_grant
join retired_permission_sets
  on retired_permission_sets.reviewer_set_id = set_grant.permission_set_id
on conflict (principal_id, permission_set_id) do nothing;

with retired_permission_sets as (
  select
    permission_set_id as reviewer_set_id,
    'permission-set-' || account_id || '-contributor' as contributor_set_id
  from itotori_auth_permission_sets
  where permission_set_id = 'permission-set-' || account_id || '-reviewer'
)
update itotori_auth_invitations as invitation
set initial_permission_set_ids = coalesce(
  (
    select jsonb_agg(deduplicated.permission_set_id order by deduplicated.ordinality)
    from (
      select distinct on (mapped.permission_set_id)
        mapped.permission_set_id,
        mapped.ordinality
      from (
        select
          coalesce(retired_permission_sets.contributor_set_id, candidate.permission_set_id) as permission_set_id,
          candidate.ordinality
        from jsonb_array_elements_text(invitation.initial_permission_set_ids)
          with ordinality as candidate(permission_set_id, ordinality)
        left join retired_permission_sets
          on retired_permission_sets.reviewer_set_id = candidate.permission_set_id
      ) as mapped
      order by mapped.permission_set_id, mapped.ordinality
    ) as deduplicated
  ),
  '[]'::jsonb
)
where jsonb_typeof(invitation.initial_permission_set_ids) = 'array'
  and exists (
    select 1
    from jsonb_array_elements_text(invitation.initial_permission_set_ids) as candidate(permission_set_id)
    join retired_permission_sets
      on retired_permission_sets.reviewer_set_id = candidate.permission_set_id
  );

delete from itotori_auth_permission_sets
where permission_set_id = 'permission-set-' || account_id || '-reviewer';
