// The roster: three executable profile shapes and the exact 19-role manifest.
export {
  EXECUTABLE_PROFILE_SHAPES,
  PROFILE_SHAPES,
  ProfileShapeSchema,
  shapeContract,
  type CallLimits,
  type ProfileShape,
  type ReasoningPolicy,
  type ShapeContract,
  type ValidationIssue,
} from "./shapes.js";
export {
  defineSpecialist,
  expectedShapeForRole,
  toolsForRole,
  DAG_STAGES,
  GRANULARITIES,
  type DagPosition,
  type DagStage,
  type Granularity,
  type Specialist,
  type SpecialistDeclaration,
} from "./specialist.js";
export {
  DEFAULT_ROSTER_SELECTION,
  ROLE_ID_UNIVERSE,
  ROSTER,
  ROSTER_MANIFEST_VERSION,
  ROSTER_SPECIALISTS,
  specialistFor,
  validateRosterManifest,
} from "./manifest.js";
