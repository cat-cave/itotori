import { createServer } from "vite";
import { fileURLToPath } from "node:url";

if (process.send === undefined) {
  throw new Error("restart worker requires an IPC channel");
}
process.send("restart-worker-ready");
const encodedInput = await receiveEncodedInput();

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const server = await createServer({ root: repositoryRoot, logLevel: "error" });
try {
  const worker = await server.ssrLoadModule(
    "/apps/itotori/test/production-localize-restart-worker.ts",
  );
  await worker.runProductionLocalizeRestartWorker(JSON.parse(encodedInput));
} finally {
  await server.close();
}

function receiveEncodedInput() {
  return new Promise((resolve, reject) => {
    process.once("message", (value) => {
      if (typeof value !== "string") {
        reject(new Error("restart worker input must be encoded text"));
        return;
      }
      resolve(value);
    });
  });
}
