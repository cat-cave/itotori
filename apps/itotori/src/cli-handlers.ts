/**
 * Public façade for the CLI. Command implementations are split by concern so
 * consumers retain this stable entrypoint while the individual modules stay small.
 */
export type {
  ItotoriCliDependencies,
  ItotoriCliServices,
  JsonFileStore,
} from "./cli-handler-contracts.js";
export { runItotoriCliCommand } from "./cli-handler-dispatch.js";
export {
  ConcurrencyFlagError,
  MAX_LOCALIZE_CONCURRENCY,
  parseConcurrencyFlag,
} from "./cli-handler-concurrency.js";
