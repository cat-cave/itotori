-- Provider attribution is eventually consistent. Keep reconciliation state in
-- a mutable ledger keyed to the immutable physical response receipt.
create table if not exists itotori_llm_provider_attributions (
  attribution_id text primary key,
  memo_key text not null references itotori_llm_call_memos(memo_key) on delete restrict,
  attempt_ordinal integer not null check (attempt_ordinal between 1 and 3),
  response_event_id text not null references itotori_llm_conversation_events(event_id) on delete restrict,
  generation_id text,
  requested_model text not null,
  provider_policy jsonb not null,
  served_pair_status text not null check (served_pair_status in ('confirmed', 'unknown')),
  served_model text,
  served_provider text,
  router_attempts jsonb not null,
  reported_cost_usd numeric,
  attribution_status text not null check (attribution_status in ('pending', 'verified', 'unavailable')),
  lookup_attempts integer not null check (lookup_attempts >= 0),
  next_lookup_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (memo_key, attempt_ordinal),
  check (jsonb_typeof(provider_policy) = 'object' and jsonb_typeof(router_attempts) = 'array'),
  check (
    (attribution_status = 'verified' and generation_id is not null
      and served_pair_status = 'confirmed' and served_model is not null and served_provider is not null
      and next_lookup_at is null)
    or (attribution_status = 'pending' and generation_id is not null
      and served_pair_status = 'unknown' and served_model is null and served_provider is null
      and next_lookup_at is not null)
    or (attribution_status = 'unavailable' and generation_id is null
      and served_pair_status = 'unknown' and served_model is null and served_provider is null
      and next_lookup_at is null)
  )
);

create index if not exists itotori_llm_provider_attributions_pending_idx
  on itotori_llm_provider_attributions(next_lookup_at, attribution_id)
  where attribution_status = 'pending';
