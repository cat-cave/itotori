#!/usr/bin/env node
// itotori bin entry — a thin wrapper that imports the bundled CLI and invokes
// `main()` explicitly.
//
// WHY A WRAPPER (not pointing `bin` straight at `dist/cli.js`): the bundled
// `apps/itotori/src/cli.ts` gates its self-invocation on
// `process.argv[1] === fileURLToPath(import.meta.url)`. When npm installs a bin
// it symlinks `node_modules/.bin/itotori` at this wrapper; the bundle is then
// reached through a symlink, so `process.argv[1]` (the symlink path) and the
// bundle's resolved `import.meta.url` diverge and the guard never fires — `main()`
// would not run. Calling `main()` directly here is symlink-proof, so the
// installed `itotori` runs identically whether invoked directly or via the
// `node_modules/.bin/itotori` symlink.
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
