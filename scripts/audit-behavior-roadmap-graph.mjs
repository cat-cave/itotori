const INSTANCE_FIELDS = [
  "spec",
  "bundle",
  "engine",
  "dependsOn",
  "cells",
  "estimateLines",
  "estimatedFiles",
  "basis",
];

function applicabilityScopes(applicability) {
  if (applicability === "shared") return new Set(["shared"]);
  if (applicability === "production-targets") {
    return new Set(["admitted-production", "unqualified-production"]);
  }
  return new Set(["admitted-production", "unqualified-production", "non-production"]);
}

function cellName(behavior, engine) {
  return `cell::${behavior}::${engine?.sourceCapability ?? "all"}`;
}

export function expandRoadmap(bundles, classifications, scopeEngines, engines, errors) {
  const classificationByBehavior = new Map(
    classifications
      .filter((classification) => classification && typeof classification === "object")
      .map((classification) => [classification.behavior, classification]),
  );
  const bundleByName = new Map(
    bundles
      .filter((bundle) => bundle && typeof bundle === "object")
      .map((bundle) => [bundle.name, bundle]),
  );
  const instances = [];
  const instanceByBundleEngine = new Map();
  for (const [bundleIndex, bundle] of bundles.entries()) {
    if (
      !bundle ||
      typeof bundle !== "object" ||
      !scopeEngines.has(bundle.scope) ||
      typeof bundle.name !== "string" ||
      !bundle.name
    )
      continue;
    for (const engine of scopeEngines.get(bundle.scope)) {
      const engineName = engine?.sourceCapability ?? "all";
      const spec = bundle.scope === "shared" ? bundle.name : `${bundle.name}/${engineName}`;
      const cells = [];
      for (const behavior of Array.isArray(bundle.behaviors) ? bundle.behaviors : []) {
        const classification = classificationByBehavior.get(behavior);
        if (!classification) continue;
        if (!applicabilityScopes(classification.applicability).has(bundle.scope)) {
          errors.push(
            `spec-bundles.jsonl:${bundleIndex + 1}: ${behavior} is incompatible with ${bundle.scope}`,
          );
          continue;
        }
        cells.push(cellName(behavior, engine));
      }
      const instance = {
        spec,
        bundle: bundle.name,
        engine: engineName,
        dependsOn: [],
        cells,
        estimateLines: bundle.estimateLines,
        estimatedFiles: bundle.estimatedFiles,
        basis: bundle.basis,
        scope: bundle.scope,
        bundleIndex,
      };
      instances.push(instance);
      instanceByBundleEngine.set(`${bundle.name}\0${engineName}`, instance);
    }
  }

  const firstProduction = engines.find(
    ({ supportRole }) => supportRole === "production-target",
  )?.sourceCapability;
  for (const instance of instances) {
    const bundle = bundles[instance.bundleIndex];
    for (const dependencyName of Array.isArray(bundle.dependsOn) ? bundle.dependsOn : []) {
      const target = bundleByName.get(dependencyName);
      if (!target) {
        errors.push(`${instance.spec}: unknown bundle dependency ${dependencyName}`);
        continue;
      }
      let targetEngine;
      if (target.scope === "shared") targetEngine = "all";
      else if (target.scope === bundle.scope) targetEngine = instance.engine;
      else {
        errors.push(`${instance.spec}: dependency ${dependencyName} has incompatible scope`);
        continue;
      }
      const dependency = instanceByBundleEngine.get(`${dependencyName}\0${targetEngine}`);
      if (!dependency) errors.push(`${instance.spec}: unresolved dependency ${dependencyName}`);
      else if (!instance.dependsOn.includes(dependency.spec))
        instance.dependsOn.push(dependency.spec);
    }
    if (bundle.afterFirstProduction !== false) {
      const dependency = instanceByBundleEngine.get(
        `${bundle.afterFirstProduction}\0${firstProduction}`,
      );
      if (!dependency) {
        errors.push(
          `${instance.spec}: afterFirstProduction target ${bundle.afterFirstProduction} has no first-production instance`,
        );
      } else if (
        dependency.spec !== instance.spec &&
        !instance.dependsOn.includes(dependency.spec)
      ) {
        instance.dependsOn.push(dependency.spec);
      }
    }
  }

  const expectedCells = [];
  for (const row of classifications) {
    if (!row || typeof row !== "object") continue;
    if (row.applicability === "shared") expectedCells.push(cellName(row.behavior, null));
    else {
      const candidates =
        row.applicability === "canonical-engines"
          ? engines
          : engines.filter(({ supportRole }) => supportRole === "production-target");
      expectedCells.push(...candidates.map((engine) => cellName(row.behavior, engine)));
    }
  }
  const publicInstances = instances.map(({ scope, bundleIndex, ...instance }) => instance);
  const owners = new Map(expectedCells.map((cell) => [cell, []]));
  for (const instance of publicInstances) {
    if (instance.cells.length === 0) errors.push(`${instance.spec}: spec flips no behavior cell`);
    for (const cell of instance.cells) {
      if (!owners.has(cell)) errors.push(`${instance.spec}: owns unexpected cell ${cell}`);
      else owners.get(cell).push(instance.spec);
    }
  }
  const missing = [...owners].filter(([, specs]) => specs.length === 0).map(([cell]) => cell);
  const duplicate = [...owners].filter(([, specs]) => specs.length > 1).map(([cell]) => cell);
  if (missing.length > 0) {
    errors.push(
      `missing ownership for ${missing.length} expected cells: ${missing.slice(0, 4).join(", ")}`,
    );
  }
  if (duplicate.length > 0) {
    errors.push(
      `multiple owners for ${duplicate.length} expected cells: ${duplicate.slice(0, 4).join(", ")}`,
    );
  }
  return { instances: publicInstances, cells: expectedCells };
}

export function validateCommittedInstances(rows, expected, exactFields, errors) {
  if (rows.length !== expected.length) {
    errors.push(`spec instances have ${rows.length}/${expected.length} rows`);
  }
  for (let index = 0; index < Math.max(rows.length, expected.length); index += 1) {
    const row = rows[index];
    const generated = expected[index];
    const location = `docs/roadmap/spec-instances.jsonl:${index + 1}`;
    if (!row || !generated) continue;
    exactFields(row, INSTANCE_FIELDS, location, errors);
    for (const field of INSTANCE_FIELDS) {
      if (JSON.stringify(row[field]) !== JSON.stringify(generated[field])) {
        errors.push(`${location}: ${field} differs from generated expansion for ${generated.spec}`);
      }
    }
  }
}

function hasAlternatePath(outgoing, start, target, skippedEdge) {
  const visited = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === target) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of outgoing.get(node) ?? []) {
      if (node === skippedEdge[0] && next === skippedEdge[1]) continue;
      pending.push(next);
    }
  }
  return false;
}

export function buildDependencyGraph(instances) {
  const nodes = new Set(instances.map(({ spec }) => spec));
  const outgoing = new Map([...nodes].map((node) => [node, new Set()]));
  const incoming = new Map([...nodes].map((node) => [node, new Set()]));
  const errors = [];

  for (const { spec, dependsOn } of instances) {
    for (const dependency of dependsOn) {
      if (!nodes.has(dependency)) {
        errors.push(`${spec}: dependency references missing spec ${dependency}`);
        continue;
      }
      outgoing.get(dependency).add(spec);
      incoming.get(spec).add(dependency);
    }
  }

  const relationships = [...outgoing.values()].reduce((total, links) => total + links.size, 0);
  const roots = [...nodes].filter((node) => incoming.get(node).size === 0).sort();
  const remaining = new Map([...incoming].map(([node, links]) => [node, links.size]));
  const ready = [...remaining].filter(([, count]) => count === 0).map(([node]) => node);
  let visitedCount = 0;
  while (ready.length > 0) {
    const node = ready.pop();
    visitedCount += 1;
    for (const blocked of outgoing.get(node)) {
      const next = remaining.get(blocked) - 1;
      remaining.set(blocked, next);
      if (next === 0) ready.push(blocked);
    }
  }

  const redundantEdges = [];
  for (const [blocker, blockedSpecs] of outgoing) {
    for (const blocked of blockedSpecs) {
      if (hasAlternatePath(outgoing, blocker, blocked, [blocker, blocked])) {
        redundantEdges.push([blocker, blocked]);
      }
    }
  }

  return {
    nodes,
    outgoing,
    incoming,
    relationships,
    roots,
    acyclic: visitedCount === nodes.size,
    redundantEdges,
    maxOutgoing: Math.max(0, ...[...outgoing.values()].map((links) => links.size)),
    maxIncoming: Math.max(0, ...[...incoming.values()].map((links) => links.size)),
    errors,
  };
}

export function reachableFrom(graph, root) {
  const reached = new Set();
  const pending = graph.nodes.has(root) ? [root] : [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (reached.has(node)) continue;
    reached.add(node);
    pending.push(...(graph.outgoing.get(node) ?? []));
  }
  return reached;
}
