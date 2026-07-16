// The persistent, REUSABLE abstract style artifact — A1's second output.
//
// A1 first emits a game-bound, cited source-language StyleContract WikiObject
// (see ./run.ts). That object is snapshot-scoped: it describes ONE game. This
// module abstracts the game-specific observations of that contract into a
// persistent style POLICY that is keyed by ORG / USER / GENRE — never by game
// or by target language. The same artifact therefore applies across every game
// a house localizes in that genre: a second game's contract FOLDS INTO the same
// artifact (same key ⇒ same artifactId), accumulating provenance rather than
// minting a parallel game-bound guide.
//
// Three guarantees this module owns, each independently falsifiable:
//  1. REUSE across snapshots — a field observed identically in two games carries
//     provenance from BOTH snapshots on one artifact; the artifact is not
//     re-created per game.
//  2. Explicit VERSIONING + OPERATOR CONSTRAINTS — a fold that changes a policy
//     value mints a new version; an operator-LOCKED field is held against a
//     contradicting observation and never silently rewritten.
//  3. FIELD-SCOPED INVALIDATION — when a fold changes a set of policy fields,
//     only consumers whose fine-grained dependency edge (the fine-grained dependency-edge
//     field-path narrowing) cited a CHANGED field are invalidated. A
//     consumer that cited an unchanged field survives the new version.

import { z } from "zod";

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyTextSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  ShortTextSchema,
  type DependencyRef,
  type WikiObject,
} from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";

export const ABSTRACT_STYLE_ARTIFACT_SCHEMA_VERSION = "itotori.abstract-style-artifact.v1" as const;

/** The style policy fields A1 abstracts. These mirror the source-language
 * StyleContract body: they are POLICY decisions (how formal, how to treat
 * honorifics, name order, profanity ceiling, punctuation, audience), never a
 * target-language rendering. A consumer's dependency edge cites one of these
 * by name (its `fieldPath[0]`), which is what makes invalidation field-scoped. */
export const STYLE_POLICY_FIELDS = [
  "registerPolicy",
  "honorificPolicy",
  "nameOrder",
  "profanityCeiling",
  "punctuationRules",
  "audienceNote",
] as const;
export type StylePolicyField = (typeof STYLE_POLICY_FIELDS)[number];
export const StylePolicyFieldSchema = z.enum(STYLE_POLICY_FIELDS);

/** Where one policy field's value was abstracted FROM: a specific game snapshot
 * and the style-contract object + claims that established it. A field reused
 * across two games carries two of these. */
export const StyleObservationRefSchema = z
  .object({
    snapshotId: Sha256Schema,
    styleContractObjectId: IdentifierSchema,
    styleContractVersion: PositiveIntegerSchema,
    claimIds: z.array(IdentifierSchema).min(1).max(1_024),
  })
  .strict();
export type StyleObservationRef = z.infer<typeof StyleObservationRefSchema>;

export const StylePolicyValueSchema = z
  .object({
    field: StylePolicyFieldSchema,
    /** The abstracted, source-language policy statement — never a target form. */
    value: NonEmptyTextSchema,
    derivedFrom: z.array(StyleObservationRefSchema).min(1).max(4_096),
    /** Operator-locked: a contradicting later observation is HELD, not applied. */
    locked: z.boolean(),
  })
  .strict();
export type StylePolicyValue = z.infer<typeof StylePolicyValueSchema>;

/** The reuse anchor. Keyed by org / (optional) user / genre — NOT by game or by
 * target language. Two games in the same house + genre resolve to one key ⇒ one
 * artifactId ⇒ one reusable artifact. */
export const AbstractStyleKeySchema = z
  .object({
    orgId: IdentifierSchema,
    userId: IdentifierSchema.nullable(),
    genre: IdentifierSchema,
  })
  .strict();
export type AbstractStyleKey = z.infer<typeof AbstractStyleKeySchema>;

export const AbstractStyleArtifactSchema = z
  .object({
    schemaVersion: z.literal(ABSTRACT_STYLE_ARTIFACT_SCHEMA_VERSION),
    artifactId: IdentifierSchema,
    key: AbstractStyleKeySchema,
    /** Source language the policy reasons in — proof it is not target-bound. */
    sourceLanguage: ShortTextSchema,
    version: PositiveIntegerSchema,
    supersedesVersion: PositiveIntegerSchema.optional(),
    policies: z.array(StylePolicyValueSchema).min(1).max(64),
    operator: z
      .object({
        lockedFields: z.array(StylePolicyFieldSchema).max(64),
        approvedBy: ShortTextSchema.nullable(),
        approvedAt: IsoDateTimeSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const fields = artifact.policies.map((policy) => policy.field);
    if (new Set(fields).size !== fields.length) {
      context.addIssue({ code: "custom", message: "a policy field appears more than once" });
    }
    for (const [index, policy] of artifact.policies.entries()) {
      const isLocked = artifact.operator.lockedFields.includes(policy.field);
      if (policy.locked !== isLocked) {
        context.addIssue({
          code: "custom",
          path: ["policies", index, "locked"],
          message: "policy lock flag must agree with the operator lockedFields set",
        });
      }
    }
    if (artifact.version === 1 && artifact.supersedesVersion !== undefined) {
      context.addIssue({ code: "custom", message: "the first version supersedes nothing" });
    }
    if (
      artifact.supersedesVersion !== undefined &&
      artifact.supersedesVersion >= artifact.version
    ) {
      context.addIssue({ code: "custom", message: "a version must supersede an earlier one" });
    }
  });
export type AbstractStyleArtifact = z.infer<typeof AbstractStyleArtifactSchema>;

export class AbstractStyleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbstractStyleError";
  }
}

/** Deterministic artifact identity from the reuse key. The game / snapshot is
 * deliberately ABSENT: identity is org/user/genre, so a second game resolves the
 * same artifact instead of a new one. The key is content-addressed so distinct
 * org/user/genre triples never collide and the id is always a stable identifier. */
export function abstractStyleArtifactId(key: AbstractStyleKey): string {
  const parsed = AbstractStyleKeySchema.parse(key);
  return `abstract-style:${sha256({
    orgId: parsed.orgId,
    userId: parsed.userId,
    genre: parsed.genre,
  })}`;
}

/** A style-contract body field reduced to a canonical, comparable policy value.
 * Enum fields map to their literal; free-text fields carry the text; the
 * punctuation list is canonicalised so order/whitespace changes are detectable. */
function styleContractFieldValues(object: WikiObject): ReadonlyMap<StylePolicyField, string> {
  if (object.kind !== "style-contract") {
    throw new AbstractStyleError("A1 can only abstract a style-contract object");
  }
  const body = object.body;
  return new Map<StylePolicyField, string>([
    ["registerPolicy", body.registerPolicy],
    ["honorificPolicy", body.honorificPolicy],
    ["nameOrder", body.nameOrder],
    ["profanityCeiling", body.profanityCeiling],
    ["punctuationRules", canonicalJson(body.punctuationRules)],
    ["audienceNote", body.audienceNote],
  ]);
}

/** The style claims that evidence this contract — every field's provenance cites
 * them (the contract as a whole is proven by its `style` claims, each of which
 * the claim-validation gate has already validated against the snapshot). */
function styleClaimIds(object: WikiObject): string[] {
  const ids = object.claims.filter((claim) => claim.kind === "style").map((claim) => claim.claimId);
  if (ids.length === 0) {
    throw new AbstractStyleError(
      "a style contract must carry at least one style claim to abstract",
    );
  }
  return ids;
}

function observationOf(object: WikiObject): StyleObservationRef {
  if (object.kind !== "style-contract") {
    throw new AbstractStyleError("A1 can only abstract a style-contract object");
  }
  return StyleObservationRefSchema.parse({
    snapshotId: object.provenance.contextSnapshotId,
    styleContractObjectId: object.objectId,
    styleContractVersion: object.version,
    claimIds: styleClaimIds(object),
  });
}

export interface FoldOptions {
  /** Fields the operator has locked; a contradicting observation is held. */
  readonly lockedFields?: readonly StylePolicyField[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface FoldResult {
  readonly artifact: AbstractStyleArtifact;
  /** Fields whose POLICY VALUE changed in this fold (drives invalidation). */
  readonly changedFields: readonly StylePolicyField[];
  /** Fields newly introduced by this fold. */
  readonly addedFields: readonly StylePolicyField[];
  /** Locked fields whose incoming observation contradicted the held value. */
  readonly heldFields: readonly StylePolicyField[];
  /** Whether a new version was minted (⇔ changedFields ∪ addedFields non-empty). */
  readonly versionBumped: boolean;
}

/**
 * Create the FIRST version of the reusable artifact from a single game's
 * cited style contract. Every field the contract fixes becomes a policy whose
 * provenance cites this one snapshot; a later game folds in via
 * {@link foldStyleContract}.
 */
export function abstractStyleFromContract(
  key: AbstractStyleKey,
  object: WikiObject,
  options: FoldOptions = {},
): AbstractStyleArtifact {
  if (object.kind !== "style-contract") {
    throw new AbstractStyleError("A1 can only abstract a style-contract object");
  }
  const locked = new Set(options.lockedFields ?? []);
  const observation = observationOf(object);
  const values = styleContractFieldValues(object);
  const policies: StylePolicyValue[] = [...values].map(([field, value]) => ({
    field,
    value,
    derivedFrom: [observation],
    locked: locked.has(field),
  }));
  return AbstractStyleArtifactSchema.parse({
    schemaVersion: ABSTRACT_STYLE_ARTIFACT_SCHEMA_VERSION,
    artifactId: abstractStyleArtifactId(key),
    key,
    sourceLanguage: object.lang,
    version: 1,
    policies,
    operator: {
      lockedFields: [...locked].filter((field) => values.has(field)),
      approvedBy: options.approvedBy ?? null,
      approvedAt: options.approvedAt ?? null,
    },
  });
}

/**
 * Fold a SECOND (or later) game's cited style contract into the existing
 * reusable artifact. This is where reuse, versioning, and operator constraints
 * live:
 *  - a field observed with the SAME value accumulates the new snapshot's
 *    provenance (REUSE — one artifact, two games) and is not a change;
 *  - a field observed with a DIFFERENT value is updated and recorded as CHANGED,
 *    UNLESS the operator locked it, in which case the held value stands and the
 *    contradiction is reported in `heldFields`;
 *  - a new field is ADDED;
 *  - the version bumps iff at least one field changed or was added.
 */
export function foldStyleContract(
  artifact: AbstractStyleArtifact,
  object: WikiObject,
  options: FoldOptions = {},
): FoldResult {
  const base = AbstractStyleArtifactSchema.parse(artifact);
  if (object.kind !== "style-contract") {
    throw new AbstractStyleError("A1 can only abstract a style-contract object");
  }
  if (object.lang !== base.sourceLanguage) {
    throw new AbstractStyleError(
      `cannot fold a ${object.lang} contract into a ${base.sourceLanguage} artifact`,
    );
  }
  const lockedFields = new Set<StylePolicyField>([
    ...base.operator.lockedFields,
    ...(options.lockedFields ?? []),
  ]);
  const observation = observationOf(object);
  const incoming = styleContractFieldValues(object);
  const existing = new Map(base.policies.map((policy) => [policy.field, policy] as const));

  const changedFields: StylePolicyField[] = [];
  const addedFields: StylePolicyField[] = [];
  const heldFields: StylePolicyField[] = [];
  const nextPolicies: StylePolicyValue[] = [];

  for (const policy of base.policies) {
    const incomingValue = incoming.get(policy.field);
    const locked = lockedFields.has(policy.field);
    if (incomingValue === undefined) {
      nextPolicies.push({ ...policy, locked });
      continue;
    }
    if (incomingValue === policy.value) {
      // REUSE: same policy, another game — accumulate provenance, value unchanged.
      nextPolicies.push({
        ...policy,
        locked,
        derivedFrom: appendObservation(policy.derivedFrom, observation),
      });
      continue;
    }
    if (locked) {
      // OPERATOR CONSTRAINT: hold the value, do not apply the contradiction.
      heldFields.push(policy.field);
      nextPolicies.push({ ...policy, locked });
      continue;
    }
    changedFields.push(policy.field);
    nextPolicies.push({
      field: policy.field,
      value: incomingValue,
      locked,
      derivedFrom: appendObservation(policy.derivedFrom, observation),
    });
  }

  for (const [field, value] of incoming) {
    if (existing.has(field)) continue;
    addedFields.push(field);
    nextPolicies.push({
      field,
      value,
      locked: lockedFields.has(field),
      derivedFrom: [observation],
    });
  }

  const versionBumped = changedFields.length > 0 || addedFields.length > 0;
  const nextVersion = versionBumped ? base.version + 1 : base.version;
  const orderedPolicies = STYLE_POLICY_FIELDS.flatMap((field) => {
    const policy = nextPolicies.find((candidate) => candidate.field === field);
    return policy ? [policy] : [];
  });
  const next = AbstractStyleArtifactSchema.parse({
    ...base,
    version: nextVersion,
    ...(versionBumped ? { supersedesVersion: base.version } : {}),
    policies: orderedPolicies,
    operator: {
      lockedFields: [...lockedFields].filter((field) => existing.has(field) || incoming.has(field)),
      approvedBy: options.approvedBy ?? base.operator.approvedBy,
      approvedAt: options.approvedAt ?? base.operator.approvedAt,
    },
  });
  return { artifact: next, changedFields, addedFields, heldFields, versionBumped };
}

function appendObservation(
  existing: readonly StyleObservationRef[],
  observation: StyleObservationRef,
): StyleObservationRef[] {
  const already = existing.some((ref) => canonicalJson(ref) === canonicalJson(observation));
  return already ? [...existing] : [...existing, observation];
}

/** The set of distinct game snapshots a field's policy was abstracted from —
 * proof of reuse across games. */
export function snapshotsForField(
  artifact: AbstractStyleArtifact,
  field: StylePolicyField,
): readonly string[] {
  const policy = artifact.policies.find((candidate) => candidate.field === field);
  if (!policy) return [];
  return [...new Set(policy.derivedFrom.map((ref) => ref.snapshotId))].sort();
}

/** Whether the reusable artifact carries a policy abstracted (in part) from the
 * given game snapshot — used to prove one artifact APPLIES to two games. */
export function appliesToSnapshot(artifact: AbstractStyleArtifact, snapshotId: string): boolean {
  return artifact.policies.some((policy) =>
    policy.derivedFrom.some((ref) => ref.snapshotId === snapshotId),
  );
}

/**
 * FIELD-SCOPED invalidation. Given the fields a fold changed and the fine-grained
 * dependency edges of downstream consumers (the fine-grained `DependencyRef`, the same
 * shape the dependency-edge store persists and narrows by field path), return exactly the consumers
 * that cited a CHANGED policy field. A consumer that cited an unchanged field is
 * NOT returned even though a new artifact version was minted; a coarse
 * object-wide consumer (empty field path) is invalidated by any change.
 */
export function invalidatedStyleConsumers<
  T extends { readonly dependencies: readonly DependencyRef[] },
>(
  artifact: AbstractStyleArtifact,
  changedFields: readonly StylePolicyField[],
  consumers: readonly T[],
): T[] {
  const changed = new Set<string>(changedFields);
  if (changed.size === 0) return [];
  return consumers.filter((consumer) =>
    consumer.dependencies.some((dependency) => citesChangedField(artifact, dependency, changed)),
  );
}

function citesChangedField(
  artifact: AbstractStyleArtifact,
  dependency: DependencyRef,
  changed: ReadonlySet<string>,
): boolean {
  if (dependency.upstreamObjectId !== artifact.artifactId) return false;
  // A bare object-wide edge (no field path) consumes the whole artifact — any
  // change to it invalidates the consumer.
  if (dependency.fieldPath.length === 0) return true;
  return changed.has(dependency.fieldPath[0]!);
}
