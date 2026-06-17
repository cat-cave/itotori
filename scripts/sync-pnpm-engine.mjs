import { readFileSync, writeFileSync } from "node:fs";

const packageJsonPath = "package.json";
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const parsePnpmPackageManagerVersion = (value) => {
  const match = /^pnpm@(?<version>\d+\.\d+\.\d+)(?:\+sha512\.[0-9a-f]+)?$/iu.exec(value ?? "");
  return match?.groups?.version;
};

const pnpmVersion = parsePnpmPackageManagerVersion(packageJson.packageManager);

if (!pnpmVersion) {
  throw new Error(
    "package.json packageManager must be an exact pnpm@x.y.z version with optional Corepack integrity metadata",
  );
}

const pnpmEngine = `>=${pnpmVersion}`;

if (packageJson.engines?.pnpm === pnpmEngine) {
  console.log(`pnpm engine policy already matches ${pnpmEngine}`);
  process.exit(0);
}

packageJson.engines = {
  ...packageJson.engines,
  pnpm: pnpmEngine,
};

writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`updated pnpm engine policy to ${pnpmEngine}`);
