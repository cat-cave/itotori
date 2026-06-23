//! Game-id derivation per the contract's *Extraction* section.
//!
//! Order of preference (deterministic):
//!
//! 1. VNDB `v`-id (e.g. `v12345`)
//! 2. DLsite `RJ`/`VJ`/`BJ` code (lowercased)
//! 3. EGS numeric id (e.g. `egs-1234`)
//! 4. Slug of `works.canonical_title` + `-r<release_id>`
//!
//! The slug is stable across runs so a cached extraction keyed by `<game-id>`
//! survives re-runs.

use crate::config::GameIdSource;

/// External-identifier shape from the catalog `identifiers` table.
#[derive(Debug, Clone)]
pub struct ExternalId {
    /// e.g. `vndb`, `dlsite`, `egs`.
    pub source: String,
    /// e.g. `v`, `rj`, `id`.
    pub kind: String,
    /// The literal id value.
    pub value: String,
}

/// Input bundle for game-id derivation.
#[derive(Debug, Clone)]
pub struct GameIdContext<'a> {
    /// All identifiers attached to the work.
    pub identifiers: &'a [ExternalId],
    /// The release id this artifact resolves under (used for slug fallback).
    pub release_id: i64,
    /// `works.canonical_title` (used for slug fallback).
    pub canonical_title: &'a str,
}

/// Result of game-id derivation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameId {
    /// The slug itself, suitable for use as a directory name.
    pub id: String,
    /// Which source was chosen.
    pub source: GameIdSource,
}

/// Derive a deterministic, filesystem-safe game id from a release context.
pub fn derive_game_id(ctx: &GameIdContext<'_>) -> GameId {
    if let Some(v) = find_id(ctx.identifiers, "vndb", &["v"]) {
        return GameId {
            id: format!("v{}", normalize_value(&v)),
            source: GameIdSource::Vndb,
        };
    }
    if let Some(v) = find_id(ctx.identifiers, "dlsite", &["rj", "vj", "bj"]) {
        return GameId {
            id: normalize_value(&v).to_uppercase(),
            source: GameIdSource::DlsiteRj,
        };
    }
    if let Some(v) = find_id(ctx.identifiers, "egs", &["id"]) {
        return GameId {
            id: format!("egs-{}", normalize_value(&v)),
            source: GameIdSource::Egs,
        };
    }
    let slug = slugify(ctx.canonical_title);
    GameId {
        id: format!("{slug}-r{rel}", slug = slug, rel = ctx.release_id),
        source: GameIdSource::SlugFallback,
    }
}

fn find_id(ids: &[ExternalId], source: &str, kinds: &[&str]) -> Option<String> {
    for id in ids {
        if id.source.eq_ignore_ascii_case(source) {
            for k in kinds {
                if id.kind.eq_ignore_ascii_case(k) {
                    return Some(id.value.clone());
                }
            }
        }
    }
    None
}

/// Strip a leading single-letter kind prefix (`v12345` -> `12345`) so the
/// numeric core can be re-prefixed by the source-specific normalizer.
fn normalize_value(v: &str) -> String {
    // VNDB `v12345`. Some adapters store as `12345`; we accept both.
    let s = v.trim();
    if s.is_empty() {
        return String::new();
    }
    let first = s.chars().next().unwrap();
    if first.is_ascii_alphabetic() && s.len() > 1 && s[1..].chars().all(|c| c.is_ascii_digit()) {
        // strip leading letter ('v12345' -> '12345'); the format! callers
        // re-prefix as needed (e.g. "v{value}", "egs-{value}").
        s[1..].to_string()
    } else {
        s.to_string()
    }
}

/// Tiny, dependency-free slugifier: lowercase ASCII alnum + dashes.
///
/// Non-ASCII characters are dropped (the contract acknowledges the title
/// may be JP; the slug is intended as a directory name and the fallback
/// is anyway the least preferred). The result is bounded to 80 chars.
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("work");
    }
    if out.len() > 80 {
        out.truncate(80);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(source: &str, kind: &str, value: &str) -> ExternalId {
        ExternalId {
            source: source.into(),
            kind: kind.into(),
            value: value.into(),
        }
    }

    #[test]
    fn derives_stable_game_id_from_vndb_id_when_present() {
        let ids = vec![
            id("dlsite", "rj", "RJ123456"),
            id("vndb", "v", "v12345"),
            id("egs", "id", "9999"),
        ];
        let ctx = GameIdContext {
            identifiers: &ids,
            release_id: 7,
            canonical_title: "Hello World",
        };
        let g = derive_game_id(&ctx);
        assert_eq!(g.id, "v12345");
        assert_eq!(g.source, GameIdSource::Vndb);
    }

    #[test]
    fn falls_back_to_dlsite_rj_code_when_vndb_absent() {
        let ids = vec![id("dlsite", "rj", "RJ123456")];
        let ctx = GameIdContext {
            identifiers: &ids,
            release_id: 7,
            canonical_title: "x",
        };
        let g = derive_game_id(&ctx);
        assert_eq!(g.id, "RJ123456");
        assert_eq!(g.source, GameIdSource::DlsiteRj);
    }

    #[test]
    fn falls_back_to_egs_id_then_to_canonical_title_slug_with_release_id() {
        let ids = vec![id("egs", "id", "9999")];
        let ctx_a = GameIdContext {
            identifiers: &ids,
            release_id: 1,
            canonical_title: "x",
        };
        let g_a = derive_game_id(&ctx_a);
        assert_eq!(g_a.id, "egs-9999");
        assert_eq!(g_a.source, GameIdSource::Egs);

        // no ids → slug fallback
        let ctx_b = GameIdContext {
            identifiers: &[],
            release_id: 42,
            canonical_title: "Hello, World!",
        };
        let g_b = derive_game_id(&ctx_b);
        assert_eq!(g_b.id, "hello-world-r42");
        assert_eq!(g_b.source, GameIdSource::SlugFallback);
    }

    #[test]
    fn produces_identical_game_id_across_two_independent_calls_for_the_same_release() {
        let ids = vec![id("vndb", "v", "v9001")];
        let ctx = GameIdContext {
            identifiers: &ids,
            release_id: 100,
            canonical_title: "irrelevant",
        };
        let a = derive_game_id(&ctx);
        let b = derive_game_id(&ctx);
        assert_eq!(a, b);
    }

    #[test]
    fn slug_drops_non_ascii_and_collapses_separators() {
        assert_eq!(slugify("Hello   World---ABC"), "hello-world-abc");
        assert_eq!(slugify("日本語タイトル"), "work");
        assert_eq!(slugify("foo / bar 1.0"), "foo-bar-1-0");
    }
}
