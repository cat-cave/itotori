import { defineConfig } from "vite-plus";

export default defineConfig({
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
      "rust:check": {
        command: "cargo check --workspace",
      },
      "rust:test": {
        command: "cargo test --workspace",
      },
      "hello": {
        command: "just hello",
        dependsOn: ["ts:build", "rust:check"],
        cache: false,
      },
    },
  },
});
