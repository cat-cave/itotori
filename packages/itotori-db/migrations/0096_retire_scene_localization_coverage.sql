-- The manual per-scene validated/flagged/needs_check state could claim a
-- terminal human-review outcome without changing a result revision or
-- canonical context. Route-map freshness is now derived directly from the
-- canonical route/choice artifacts, so retire this independent state table.

drop table if exists itotori_scene_localization_coverage;
