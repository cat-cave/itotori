-- Harden the strict WikiObject substrate with the cross-record bindings that
-- cannot be expressed by scalar CHECK constraints. A source object must belong
-- to its exact context snapshot and source language; target artifacts must
-- belong to the localization snapshot's exact target and context. A rendering
-- also has to localize a source object from that parent context with the same
-- kind, preventing a cross-game or cross-category bible entry.

create or replace function itotori_llm_validate_wiki_version()
returns trigger
language plpgsql
as $$
declare
  source_language text;
  source_context_scope text;
  localization_context_snapshot_id text;
  localization_target_language text;
  localization_context_scope text;
begin
  if new.snapshot_kind = 'localization'
    and new.snapshot_id is distinct from new.localization_snapshot_id then
    raise exception 'localization wiki object snapshot must equal its localization snapshot'
      using errcode = '23514';
  end if;

  if new.wiki_kind = 'source-object' then
    select snapshot_identity ->> 'sourceLanguage', snapshot_identity ->> 'contextScope'
      into source_language, source_context_scope
      from itotori_llm_context_snapshots
      where snapshot_id = new.snapshot_id;
    if not found then
      raise exception 'source wiki object must reference an existing context snapshot'
        using errcode = '23503';
    end if;
    if new.object_language is distinct from source_language then
      raise exception 'source wiki object language must equal its context snapshot source language'
        using errcode = '23514';
    end if;
    if new.context_scope is distinct from source_context_scope then
      raise exception 'source wiki object context scope must equal its context snapshot scope'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select localization.context_snapshot_id,
         localization.snapshot_identity ->> 'targetLanguage',
         context.snapshot_identity ->> 'contextScope'
    into localization_context_snapshot_id,
         localization_target_language,
         localization_context_scope
    from itotori_llm_localization_snapshots localization
    join itotori_llm_context_snapshots context
      on context.snapshot_id = localization.context_snapshot_id
    where localization.snapshot_id = new.localization_snapshot_id;
  if not found then
    raise exception 'target wiki artifact must reference an existing localization snapshot'
      using errcode = '23503';
  end if;
  if new.object_language is distinct from localization_target_language then
    raise exception 'target wiki artifact language must equal its localization snapshot target language'
      using errcode = '23514';
  end if;

  if new.wiki_kind = 'translation-object' then
    if new.context_scope is distinct from localization_context_scope then
      raise exception 'translation object context scope must equal its localization context scope'
        using errcode = '23514';
    end if;
  elsif not exists (
    select 1
    from itotori_llm_wiki_versions source_object
    where source_object.object_id = new.source_object_id
      and source_object.wiki_kind = 'source-object'
      and source_object.snapshot_id = localization_context_snapshot_id
      and source_object.object_kind = new.object_kind
      and source_object.deletion_state = 'active'
  ) then
    raise exception 'localized rendering must reference a same-context source object of the same kind'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_llm_wiki_version_validate on itotori_llm_wiki_versions;
create trigger itotori_llm_wiki_version_validate
before insert on itotori_llm_wiki_versions
for each row execute function itotori_llm_validate_wiki_version();
