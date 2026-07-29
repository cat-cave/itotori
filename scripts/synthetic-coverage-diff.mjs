// Structural comparison helpers for the generated coverage manifest.

function componentSet(manifest) {
  const set = new Set();
  for (const [family, fam] of Object.entries(manifest.engineFamilies ?? {})) {
    for (const [groupName, group] of Object.entries(fam.componentGroups ?? {})) {
      for (const component of group.components ?? []) {
        set.add(`${family}/${groupName} :: ${JSON.stringify(component)}`);
      }
    }
  }
  return set;
}

export function diffManifests(committed, derived) {
  const committedSet = componentSet(committed);
  const derivedSet = componentSet(derived);
  const missing = [];
  const extra = [];
  for (const key of derivedSet) {
    if (!committedSet.has(key)) missing.push(key);
  }
  for (const key of committedSet) {
    if (!derivedSet.has(key)) extra.push(key);
  }
  return { missing, extra };
}
