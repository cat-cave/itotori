-- mem-invites-billing-ui: thin account billing / seat model.
--
-- This is an internal account plan record, not an external billing-provider
-- integration. Seat usage is derived from real auth memberships and open
-- invitations in the repository so the UI does not invent billing state.

create table if not exists itotori_auth_account_billing_seats (
  account_id text primary key references itotori_auth_accounts(account_id) on delete cascade,
  plan_id text not null,
  plan_name text not null,
  seat_limit integer not null,
  included_seats integer not null,
  billing_period text not null default 'monthly',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itotori_auth_account_billing_seats_plan_id_check check (length(plan_id) > 0),
  constraint itotori_auth_account_billing_seats_plan_name_check check (length(plan_name) > 0),
  constraint itotori_auth_account_billing_seats_seat_limit_check check (seat_limit >= 1),
  constraint itotori_auth_account_billing_seats_included_seats_check check (included_seats >= 0),
  constraint itotori_auth_account_billing_seats_period_check check (
    billing_period in ('monthly', 'annual', 'manual')
  )
);

insert into itotori_auth_account_billing_seats (
  account_id,
  plan_id,
  plan_name,
  seat_limit,
  included_seats,
  billing_period
)
select
  account_id,
  'studio-team',
  'Studio Team',
  5,
  5,
  'monthly'
from itotori_auth_accounts
on conflict (account_id) do nothing;
