#!/usr/bin/env node
// itotori native-deps provisioning + doctor (itotori-native-deps-provisioning).
//
// Public façade for the installable Node-built-ins-only native dependency
// provisioner. Keep every supported import at this path while implementation
// modules group configuration, resolution, doctor probing, and provisioning.

import { pathToFileURL } from "node:url";

export {
  LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES,
  parseLiveProviderSecretVarsBlock,
  PROFILES,
  RUST_BINS,
} from "./native-deps-config.mjs";
export {
  chromiumCandidates,
  nodeSatisfies,
  parsePinnedNodeVersion,
  postgresPlan,
  rustBinCandidates,
} from "./native-deps-resolution.mjs";
export { contractProbeHonored, defaultProbe, runDoctor, tcpReachable } from "./native-deps-doctor.mjs";
export { formatReport, provisionPlan } from "./native-deps-provisioning.mjs";

import { main } from "./native-deps-provisioning.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = main(process.argv.slice(2));
}
