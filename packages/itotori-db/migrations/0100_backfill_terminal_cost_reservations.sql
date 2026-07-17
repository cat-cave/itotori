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
  locked_run text;
begin
  -- 1. Lock every affected run with the SAME advisory lock the app's cost
  --    accounting uses, in a stable order, so no app txn can interleave.
  for locked_run in
    select distinct reservation.run_id
    from itotori_localization_cost_reservations reservation
    join itotori_llm_attempts attempt
      on attempt.run_id = reservation.run_id
     and attempt.attempt_id = reservation.attempt_id
    where reservation.state = 'reserved'
      and attempt.lifecycle_state = 'completed'
      and attempt.finish_state = 'interrupted'
      and attempt.failure_class = 'interrupted'
    order by reservation.run_id
  loop
    perform pg_advisory_xact_lock(hashtext(locked_run));
  end loop;

  -- 2. Fail closed AFTER locking: every affected account must cover its
  --    terminal-reserved sum (no floor, no silent drift).
  if exists (
    with totals as (
      select reservation.run_id, sum(reservation.reserved_usd) as released_usd
      from itotori_localization_cost_reservations reservation
      join itotori_llm_attempts attempt
        on attempt.run_id = reservation.run_id
       and attempt.attempt_id = reservation.attempt_id
      where reservation.state = 'reserved'
        and attempt.lifecycle_state = 'completed'
        and attempt.finish_state = 'interrupted'
        and attempt.failure_class = 'interrupted'
      group by reservation.run_id
    )
    select 1
    from totals
    left join itotori_localization_run_cost_accounts account
      on account.run_id = totals.run_id
    where account.run_id is null
       or account.reserved_usd < totals.released_usd
  ) then
    raise exception
      'cannot release terminal cost reservations: an account is below its terminal reservation total';
  end if;

  -- 3. Atomic release: the released set and the account decrement reference the
  --    SAME rows (one data-modifying CTE), so nothing can drift between them.
  with released as (
    update itotori_localization_cost_reservations reservation
    set state = 'released'
    from itotori_llm_attempts attempt
    where attempt.run_id = reservation.run_id
      and attempt.attempt_id = reservation.attempt_id
      and reservation.state = 'reserved'
      and attempt.lifecycle_state = 'completed'
      and attempt.finish_state = 'interrupted'
      and attempt.failure_class = 'interrupted'
    returning reservation.run_id, reservation.reserved_usd
  ),
  totals as (
    select run_id, sum(reserved_usd) as released_usd
    from released
    group by run_id
  )
  update itotori_localization_run_cost_accounts account
  set reserved_usd = account.reserved_usd - totals.released_usd,
      updated_at = now()
  from totals
  where account.run_id = totals.run_id;
end
$$;
