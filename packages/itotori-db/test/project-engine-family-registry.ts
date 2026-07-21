import type { ProjectEngineFamilyRegistry } from "../src/repositories/project-repository.js";

/**
 * Existing repository suites exercise persistence concerns unrelated to engine
 * selection. The binding suite supplies the real capability-matrix registry;
 * this permissive test double keeps those focused suites independent.
 */
export const testProjectEngineFamilyRegistry: ProjectEngineFamilyRegistry = {
  has: () => true,
};
