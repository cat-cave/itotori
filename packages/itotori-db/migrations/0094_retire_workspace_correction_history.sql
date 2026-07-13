-- The workspace-correction table belonged solely to the retired manual
-- decision path. Result revisions, context corrections, wiki context, and
-- localization iterations persist their own canonical state, so there is no
-- compatible history to carry forward from this dead model.

drop table if exists itotori_workspace_correction_edits;
