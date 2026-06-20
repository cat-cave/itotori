do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_attribute attr
      on attr.attrelid = rel.oid
      and attr.attnum = any(con.conkey)
    where nsp.nspname = current_schema()
      and rel.relname = 'itotori_context_artifact_source_units'
      and con.contype = 'f'
      and attr.attname = 'bridge_unit_id'
      and con.confrelid = 'itotori_source_units'::regclass
  loop
    execute format(
      'alter table %I.%I drop constraint %I',
      current_schema(),
      'itotori_context_artifact_source_units',
      constraint_record.conname
    );
  end loop;
end $$;
