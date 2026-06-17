import { readFileSync, writeFileSync } from "node:fs";

const parseNodeVersion = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return undefined;
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
};

const compareNodeVersionsDesc = (left, right) => {
  for (const index of [0, 1, 2]) {
    if (left.parts[index] !== right.parts[index]) {
      return right.parts[index] - left.parts[index];
    }
  }
  return 0;
};

const response = await fetch("https://nodejs.org/dist/index.json");
if (!response.ok) {
  throw new Error(`failed to fetch Node release index: ${response.status}`);
}

const releases = await response.json();
if (!Array.isArray(releases)) {
  throw new Error("Node release index did not return an array");
}

const [latest] = releases
  .flatMap((release) => {
    if (typeof release.version !== "string") {
      return [];
    }

    const parts = parseNodeVersion(release.version);
    return parts ? [{ parts, version: release.version.replace(/^v/, "") }] : [];
  })
  .sort(compareNodeVersionsDesc);

if (!latest) {
  throw new Error("could not determine latest stable Node release");
}

const nodeVersion = latest.version;
writeFileSync(".node-version", `${nodeVersion}\n`);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
packageJson.engines = {
  ...packageJson.engines,
  node: `>=${nodeVersion}`,
};

writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`updated Node policy to ${nodeVersion}`);
