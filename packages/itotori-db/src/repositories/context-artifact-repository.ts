/** Retired legacy context-artifact boundary. */
import { contextArtifactCategoryValues, contextArtifactStatusValues } from "../schema.js";

type Retired = any;
export { contextArtifactCategoryValues, contextArtifactStatusValues };
export const contextArtifactToolName = "retired";
export const contextArtifactToolVersion = "retired";
export const contextArtifactSchemaVersion = "retired";
export const contextArtifactDiagnosticCodeValues: Retired = [];
export type ContextArtifactDiagnosticCode = Retired;
export type ContextArtifactDiagnostic = Retired;
export type ContextArtifactJsonRecord = Retired;
export type ContextArtifactSourceUnitInput = Retired;
export type UpsertContextArtifactInput = Retired;
export type RetrieveContextArtifactsInput = Retired;
export type InvalidateContextArtifactsInput = Retired;
export const contextCorrectionAuthorityValues: Retired = [];
export type ContextCorrectionAuthority = Retired;
export type PersistContextCorrectionInput = Retired;
export type PersistContextCorrectionResult = Retired;
export type ListContextEntryVersionsInput = Retired;
export type LoadContextArtifactInput = Retired;
export type ContextArtifactSourceUnitRecord = Retired;
export type ContextArtifactRecord = Retired;
export type ContextEntryVersionRecord = Retired;
export type ContextArtifactMatch = Retired;
export type ContextArtifactRetrievalResult = Retired;
export type ContextArtifactInvalidationResult = Retired;
export type ItotoriContextArtifactRepositoryPort = Retired;
export type ItotoriContextCorrectionPersistencePort = Retired;
export class ItotoriContextArtifactRepository {
  [key: string]: Retired;
  constructor(..._args: Retired[]) {}
}
export class ContextArtifactRepositoryError extends Error {}
export function normalizeContextArtifactText(value: string): string {
  return value.trim();
}
