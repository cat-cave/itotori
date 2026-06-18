#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultDatabaseUrl = "postgres://itotori:itotori@127.0.0.1:55433/itotori";
const outputPath = ".tmp/itotori-db/compose.env";

const databaseUrl = process.env.DATABASE_URL || defaultDatabaseUrl;
const parsed = new URL(databaseUrl);
const projectName =
  process.env.COMPOSE_PROJECT_NAME || `itotori-${path.basename(process.cwd()).toLowerCase()}`;
const safeProjectName = projectName.replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "itotori-");
const databaseName = parsed.pathname.replace(/^\//, "") || "itotori";

const values = {
  COMPOSE_PROJECT_NAME: safeProjectName,
  ITOTORI_DB_HOST_PORT: parsed.port || "5432",
  ITOTORI_DB_USER: decodeURIComponent(parsed.username || "itotori"),
  ITOTORI_DB_PASSWORD: decodeURIComponent(parsed.password || "itotori"),
  ITOTORI_DB_NAME: decodeURIComponent(databaseName),
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${Object.entries(values)
    .map(([key, value]) => `${key}=${escapeEnvFileValue(value)}`)
    .join("\n")}\n`,
);

console.log(`wrote ${outputPath} for ${values.COMPOSE_PROJECT_NAME}`);

function escapeEnvFileValue(value) {
  return JSON.stringify(String(value).replace(/\r?\n/gu, ""));
}
