import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@itotori/db": fileURLToPath(new URL("./packages/itotori-db/src/index.ts", import.meta.url)),
      "@itotori/localization-bridge-schema": fileURLToPath(
        new URL("./packages/localization-bridge-schema/src/index.ts", import.meta.url),
      ),
    },
  },
  run: {
    tasks: {
      "schema:check": {
        command: "pnpm --filter @itotori/localization-bridge-schema test",
        env: ["NODE_ENV"],
      },
      "ts:typecheck": {
        command: "vp run -r typecheck",
        dependsOn: ["schema:check"],
      },
      "ts:test": {
        command: "vp run -r test",
        dependsOn: ["schema:check"],
      },
      "ts:build": {
        command: "vp run -r build",
        dependsOn: ["schema:check"],
      },
      "db:migrate:test": {
        command: "node apps/itotori/dist/cli.js db-migrate",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "catalog:resolve-fixture": {
        command: "node apps/itotori/dist/cli.js catalog-resolve-fixture",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "style-guide:provider-smoke": {
        command: "node apps/itotori/dist/style-guide-provider-smoke.js",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "style-guide:live-provider-smoke": {
        command: "node apps/itotori/dist/style-guide-provider-smoke.js --live",
        dependsOn: ["ts:build"],
        cache: false,
      },
      "rust:check": {
        command: "cargo check --workspace",
      },
      "rust:test": {
        command: "cargo test --workspace",
      },
      hello: {
        command: "just hello",
        dependsOn: ["ts:build", "rust:check"],
        cache: false,
      },
    },
  },
});
