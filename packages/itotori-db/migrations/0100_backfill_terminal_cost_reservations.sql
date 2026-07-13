-- 0099 introduced the terminal `released` reservation state but could not
-- repair reservations stranded by deployments before resume released them.
-- A completed attempt is no longer in flight, so its still-reserved capacity
-- must be returned exactly once.  `released` is terminal: its unknown bill
-- is deliberately not settled by a speculative later reconciliation.
--
-- The migration runner wraps this whole file in one transaction.  Reject
-- ledger drift before changing either side of the accounting pair so a bad
-- account cannot be silently floored or leave partially released rows.

do $$
declare
  inconsistent_run_id text;
begin
  with terminal_reservation_totals as (
    select
      reservation.run_id,
      sum(reservation.reserved_usd) as released_usd
    from itotori_localization_cost_reservations reservation
    join itotori_llm_attempts attempt
      on attempt.run_id = reservation.run_id
      and attempt.attempt_id = reservation.attempt_id
    where reservation.state = 'reserved'
      and attempt.lifecycle_state = 'completed'
    group by reservation.run_id
  )
  select totals.run_id
  into inconsistent_run_id
  from terminal_reservation_totals totals
  left join itotori_localization_run_cost_accounts account
    on account.run_id = totals.run_id
  where account.run_id is null
     or account.reserved_usd < totals.released_usd
  limit 1;

  if inconsistent_run_id is not null then
    raise exception
      'cannot release terminal cost reservations for run %: account reserved_usd is below reservation total',
      inconsistent_run_id;
  end if;
end
$$;

with terminal_reservation_totals as (
  select
    reservation.run_id,
    sum(reservation.reserved_usd) as released_usd
  from itotori_localization_cost_reservations reservation
  join itotori_llm_attempts attempt
    on attempt.run_id = reservation.run_id
    and attempt.attempt_id = reservation.attempt_id
  where reservation.state = 'reserved'
    and attempt.lifecycle_state = 'completed'
  group by reservation.run_id
)
update itotori_localization_run_cost_accounts account
set
  reserved_usd = account.reserved_usd - totals.released_usd,
  updated_at = now()
from terminal_reservation_totals totals
where account.run_id = totals.run_id;

update itotori_localization_cost_reservations reservation
set state = 'released'
from itotori_llm_attempts attempt
where attempt.run_id = reservation.run_id
  and attempt.attempt_id = reservation.attempt_id
  and reservation.state = 'reserved'
  and attempt.lifecycle_state = 'completed';
