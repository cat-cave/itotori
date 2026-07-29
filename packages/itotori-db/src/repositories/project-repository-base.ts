import type * as deps from "./project-repository-dependencies.js";
import type * as api from "./project-repository-types.js";

export class ProjectRepositoryBase {
  constructor(
    protected readonly db: deps.ItotoriDatabase,
    protected readonly engineFamilyRegistry: api.ProjectEngineFamilyRegistry,
  ) {}
}

export type ProjectRepositoryConstructor = new (...args: never[]) => ProjectRepositoryBase;
