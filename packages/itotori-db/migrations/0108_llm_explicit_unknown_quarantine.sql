-- Upstream TanStack metadata is authoritative only when RUN_FINISHED carries
-- both the generation ID and served pair. Until that upstream surface lands,
-- schema-valid responses are usable with an explicit unknown flag; malformed,
-- refused, and truncated responses are quarantined from projection.

drop trigger if exists itotori_llm_history_immutable on itotori_llm_call_memos;

alter table itotori_llm_call_memos
  drop constraint if exists itotori_llm_call_memos_verification;

update itotori_llm_call_memos
set verification_status = case
      when outcome_kind in ('invalid', 'refusal', 'truncation') then 'quarantined'
      when generation_id is not null and served_pair_status = 'confirmed' then 'verified'
      else 'explicit-unknown'
    end;

alter table itotori_llm_call_memos
  add constraint itotori_llm_call_memos_verification check (
    (verification_status = 'verified'
      and outcome_kind in ('terminal', 'tool-calls')
      and generation_id is not null and served_pair_status = 'confirmed')
    or (verification_status = 'explicit-unknown'
      and outcome_kind in ('terminal', 'tool-calls')
      and (generation_id is null or served_pair_status = 'unknown'))
    or (verification_status = 'quarantined'
      and outcome_kind in ('invalid', 'refusal', 'truncation'))
  );

create trigger itotori_llm_history_immutable
before update or delete on itotori_llm_call_memos
for each row execute function itotori_llm_enforce_history_immutability();

drop trigger if exists itotori_llm_history_immutable on itotori_llm_http_attempts;

alter table itotori_llm_http_attempts
  drop constraint if exists itotori_llm_http_attempts_verification;

update itotori_llm_http_attempts attempt
set verification_status = case
      when attempt.attempt_status = 'in-flight' then 'pending'
      when attempt.attempt_status <> 'completed' then 'quarantined'
      when exists (
        select 1 from itotori_llm_call_memos memo
        where memo.memo_key = attempt.memo_key
          and memo.outcome_kind in ('invalid', 'refusal', 'truncation')
      ) then 'quarantined'
      when attempt.generation_id is not null and attempt.served_pair_status = 'confirmed'
        then 'verified'
      else 'explicit-unknown'
    end;

alter table itotori_llm_http_attempts
  add constraint itotori_llm_http_attempts_verification check (
    (attempt_status = 'in-flight' and verification_status = 'pending'
      and served_pair_status = 'unknown' and generation_id is null)
    or (attempt_status <> 'in-flight' and (
      (verification_status = 'verified'
        and attempt_status = 'completed'
        and generation_id is not null and served_pair_status = 'confirmed')
      or (verification_status = 'explicit-unknown'
        and attempt_status = 'completed'
        and (generation_id is null or served_pair_status = 'unknown'))
      or (verification_status = 'quarantined')
    ))
  );

create trigger itotori_llm_history_immutable
before update or delete on itotori_llm_http_attempts
for each row execute function itotori_llm_enforce_attempt_lifecycle();

drop trigger if exists itotori_llm_accepted_output_quarantine
  on itotori_llm_accepted_outputs;
drop function if exists itotori_llm_require_verified_output_memos();

-- Existing accepted outputs are immutable historical records, including records
-- whose memo content was subsequently quarantined or deleted. Do not reject an
-- upgrade for those rows; the trigger below enforces the projection boundary on
-- every new accepted output.

create or replace function itotori_llm_require_projectable_output_memos()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from unnest(new.memo_keys) required(memo_key)
    left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
    where memo.verification_status not in ('verified', 'explicit-unknown')
      or memo.deletion_state is distinct from 'active'
  ) then
    raise exception 'accepted output requires a live memo whose content is not quarantined'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger itotori_llm_accepted_output_quarantine
before insert on itotori_llm_accepted_outputs
for each row execute function itotori_llm_require_projectable_output_memos();

create or replace function itotori_llm_enforce_cas_head_advance()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CAS heads cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    if new.head_namespace <> old.head_namespace
      or new.snapshot_id <> old.snapshot_id
      or new.subject_type <> old.subject_type
      or new.subject_id <> old.subject_id
      or new.head_stage <> old.head_stage
      or new.head_version <> old.head_version + 1
      or (new.head_id = old.head_id and new.head_content_hash = old.head_content_hash)
    then
      raise exception 'CAS head advance is invalid';
    end if;
  end if;
  if new.head_namespace = 'accepted-output' then
    if not exists (
      select 1
      from itotori_llm_accepted_outputs output
      where output.output_id = new.head_id
        and output.output_version = new.head_version
        and output.output_content_hash = new.head_content_hash
        and cardinality(output.memo_keys) > 0
        and not exists (
          select 1
          from unnest(output.memo_keys) required(memo_key)
          left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
          where memo.verification_status not in ('verified', 'explicit-unknown')
            or memo.deletion_state is distinct from 'active'
        )
    ) then
      raise exception 'CAS head target is invalid';
    end if;
  elsif not exists (
    select 1 from itotori_llm_wiki_versions
    where wiki_version_id = new.head_id and object_version = new.head_version
      and wiki_content_hash = new.head_content_hash
  ) then
    raise exception 'CAS head target is invalid';
  end if;
  return new;
end;
$$;
