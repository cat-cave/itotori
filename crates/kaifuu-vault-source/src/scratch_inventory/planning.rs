use super::*;

/// LRU key for a tree: unknown mtime sorts as *newest* (kept longest / never
/// horizon-pruned).
fn lru_key(entry: &ScratchGameEntry) -> i64 {
    entry.mtime_unix.unwrap_or(i64::MAX)
}

pub(super) fn plan_quota(
    games: &[ScratchGameEntry],
    max_total_bytes: u64,
) -> (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) {
    // Evict least-recently-modified first (oldest mtime), ties broken by id for
    // determinism, until the remaining total fits under the cap.
    let mut ordered: Vec<&ScratchGameEntry> = games.iter().collect();
    ordered.sort_by(|a, b| lru_key(a).cmp(&lru_key(b)).then_with(|| a.id.cmp(&b.id)));

    let mut total: u64 = games.iter().map(|g| g.size_bytes).sum();
    let mut prune_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in ordered {
        if total <= max_total_bytes {
            break;
        }
        prune_ids.insert(entry.id.clone());
        total = total.saturating_sub(entry.size_bytes);
    }

    partition_by_ids(games, &prune_ids)
}

pub(super) fn plan_lru_horizon(
    games: &[ScratchGameEntry],
    max_age_secs: u64,
    now_unix: i64,
) -> (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) {
    let threshold = now_unix.saturating_sub(i64::try_from(max_age_secs).unwrap_or(i64::MAX));
    let mut prune_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in games {
        // Unknown mtime → lru_key == i64::MAX → never older than threshold → kept.
        if lru_key(entry) < threshold {
            prune_ids.insert(entry.id.clone());
        }
    }
    partition_by_ids(games, &prune_ids)
}

fn partition_by_ids(
    games: &[ScratchGameEntry],
    prune_ids: &std::collections::BTreeSet<String>,
) -> (Vec<ScratchGameEntry>, Vec<ScratchGameEntry>) {
    let mut pruned = Vec::new();
    let mut kept = Vec::new();
    for g in games {
        if prune_ids.contains(&g.id) {
            pruned.push(g.clone());
        } else {
            kept.push(g.clone());
        }
    }
    (pruned, kept)
}
