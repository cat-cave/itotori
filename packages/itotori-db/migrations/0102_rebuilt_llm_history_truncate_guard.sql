-- Statement-level truncation must not bypass immutable history triggers.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'itotori_llm_call_memos',
    'itotori_llm_http_attempts',
    'itotori_llm_conversation_events',
    'itotori_llm_accepted_outputs',
    'itotori_llm_wiki_versions',
    'itotori_llm_dependency_edges',
    'itotori_llm_human_inputs'
  ]
  loop
    execute format('drop trigger if exists itotori_llm_history_truncate_guard on %I', table_name);
    execute format(
      'create trigger itotori_llm_history_truncate_guard before truncate on %I '
      'for each statement execute function itotori_llm_reject_immutable_mutation()',
      table_name
    );
  end loop;
end;
$$;
