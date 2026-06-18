alter table itotori_provider_runs
  alter column completed_at drop not null,
  alter column latency_ms drop not null;
