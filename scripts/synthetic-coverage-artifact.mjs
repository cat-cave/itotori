import { buildManifest, loadSources, repoRoot } from "./synthetic-coverage-manifest.mjs";

function serializeJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildArtifact(root = repoRoot) {
  const manifest = buildManifest(loadSources(root));
  return { manifest, json: serializeJson(manifest) };
}
