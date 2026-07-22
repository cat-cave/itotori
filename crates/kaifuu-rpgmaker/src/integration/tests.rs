use super::*;

#[test]
fn honest_tuple_has_no_violations() {
    let tuple = MvMzCapabilityTuple::honest();
    assert!(
        tuple.violations().is_empty(),
        "violations: {:?}",
        tuple.violations()
    );
    assert_eq!(tuple.capability, CapabilityLevel::Patch);
    assert_eq!(tuple.covered_roles.len(), 6);
}

#[test]
fn tuple_rejects_media_overclaim() {
    let mut tuple = MvMzCapabilityTuple::honest();
    // Claim encrypted media as an in-scope patchable text scope.
    tuple.in_scope.push(CapabilityScope {
        scope_id: SCOPE_ENCRYPTED_MEDIA.to_string(),
        description: "overclaim".to_string(),
        capability: CapabilityLevel::Patch,
        roles: vec![],
    });
    let violations = tuple.violations();
    assert!(!violations.is_empty());
    assert!(
        violations.iter().any(|v| v.contains("not a text scope")),
        "{violations:?}"
    );
    assert!(
        violations
            .iter()
            .any(|v| v.contains("both claimed and declined")),
        "{violations:?}"
    );
}

#[test]
fn tuple_rejects_dropped_media_declaration() {
    let mut tuple = MvMzCapabilityTuple::honest();
    tuple
        .out_of_scope
        .retain(|s| s.scope_id != SCOPE_ENCRYPTED_MEDIA);
    assert!(
        tuple
            .violations()
            .iter()
            .any(|v| v.contains(SCOPE_ENCRYPTED_MEDIA)),
        "dropping the encrypted-media decline must be a violation"
    );
}

#[test]
fn role_assignment_splits_system_and_terms() {
    assert_eq!(
        role_for_data_key("rpgmaker:System.json#/gameTitle"),
        Some(MvMzSurfaceRole::System)
    );
    assert_eq!(
        role_for_data_key("rpgmaker:System.json#/currencyUnit"),
        Some(MvMzSurfaceRole::System)
    );
    assert_eq!(
        role_for_data_key("rpgmaker:System.json#/terms/messages/actorDamage"),
        Some(MvMzSurfaceRole::Terms)
    );
    assert_eq!(
        role_for_data_key("rpgmaker:System.json#/equipTypes/1"),
        Some(MvMzSurfaceRole::Terms)
    );
    assert_eq!(
        role_for_data_key("rpgmaker:Map001.json#/events/1/pages/0/list/1/parameters/0"),
        Some(MvMzSurfaceRole::Maps)
    );
    assert_eq!(
        role_for_data_key("rpgmaker:CommonEvents.json#/1/list/1/parameters/0"),
        Some(MvMzSurfaceRole::CommonEvents)
    );
    assert_eq!(
        role_for_data_key("rpgmaker:Items.json#/1/name"),
        Some(MvMzSurfaceRole::Database)
    );
    assert_eq!(role_for_data_key("rpgmaker:MapInfos.json#/1/name"), None);
}

#[test]
fn trivial_target_is_non_empty_and_differs() {
    let t = trivial_target("Hello");
    assert_ne!(t, "Hello");
    assert!(t.starts_with('\u{8a33}'));
    assert!(!t.is_empty());
}
