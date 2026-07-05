// Dev-only entrypoint for the reviewer review-queue FIXTURE SEEDER.
//
// `runReviewQueueFixtureCommand` migrates + seeds a scratch Postgres
// project scope and writes the deterministic review-queue fixture bundle
// artifact. It is DEVELOPMENT / CI tooling, not an end-user command, so
// it is HARD-GATED here by COMPILE-TIME SEPARATION: it is deliberately
// absent from the production CLI dispatch (`cli.js` /
// `runItotoriCliCommand`). The only way to reach the seeder is this
// dedicated dev binary, which the vite `itotori:review-queue-fixture`
// task invokes. No fixture seeder is reachable from the shipped CLI
// command surface.
//
// Flags:
//   --output <PATH>   where to write the fixture bundle JSON
//                     (default: artifacts/itotori/review-queue-fixture.json)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runReviewQueueFixtureCommand } from "./reviewer/review-queue-fixture-command.js";

function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`review-queue-fixture-dev refused: ${flag} requires a value`);
  }
  return value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function main(cliArgs = process.argv.slice(2)): Promise<void> {
  const outputPath = optionalFlag(cliArgs, "--output");
  await runReviewQueueFixtureCommand({
    ...(outputPath === undefined ? {} : { outputPath }),
    writeJson,
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
