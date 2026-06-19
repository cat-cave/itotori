// Bundle the browser client (client/main.ts) into a single minified IIFE string
// that the renderer embeds in a <script> tag. esbuild is used directly so we
// don't depend on it resolving transitively through any other tool.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export async function bundleClient(): Promise<string> {
  // dist/bundle-client.js -> ../src/client/main.ts when running from source via
  // ts, but the package is built first so the TS entry sits at compile-time
  // location ../../src/client/main.ts relative to dist. We resolve the source
  // entry from the package root so it works regardless of how it is invoked.
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ -> package root -> src/client/main.ts
  const entry = resolve(here, "../src/client/main.ts");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    target: "es2020",
  });
  const file = result.outputFiles?.[0];
  if (!file) throw new Error("esbuild produced no output for the dashboard client");
  return file.text;
}
