import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogWorkSnapshot,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogExternalIdKindValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogSource,
} from "../schema.js";

export const catalogExactExternalIdLinkSchemaVersion =
  "catalog.exact_external_id_link.v0.1" as const;

export const catalogExactExternalIdLinkStatusValues = {
  linked: "linked",
  noMatch: "no_match",
  conflict: "conflict",
  unsupported: "unsupported",
} as const;

export type CatalogExactExternalIdLinkStatus =
  (typeof catalogExactExternalIdLinkStatusValues)[keyof typeof catalogExactExternalIdLinkStatusValues];

export const catalogExactExternalIdLinkDiagnosticCodeValues = {
  invalidRequest: "catalog.exact_external_id.invalid_request",
  unsupportedExternalIdKind: "catalog.exact_external_id.unsupported_external_id_kind",
  noMatch: "catalog.exact_external_id.no_match",
  ambiguousConflict: "catalog.exact_external_id.ambiguous_conflict",
} as const;

export type CatalogExactExternalIdLinkDiagnosticCode =
  (typeof catalogExactExternalIdLinkDiagnosticCodeValues)[keyof typeof catalogExactExternalIdLinkDiagnosticCodeValues];

export type CatalogExactExternalIdLinkSubject = {
  kind: "catalog_source_record" | "local_scan_entry" | "manual_request" | "fixture";
  id: string;
};

export type CatalogExactExternalIdLinkExternalId = {
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind?: CatalogExternalIdKind;
  evidenceRef?: string;
};

export type CatalogExactExternalIdLinkRequest = {
  schemaVersion?: typeof catalogExactExternalIdLinkSchemaVersion;
  subject?: CatalogExactExternalIdLinkSubject;
  externalIds: CatalogExactExternalIdLinkExternalId[];
};

export type CatalogExactExternalIdLinkDiagnostic = {
  code: CatalogExactExternalIdLinkDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  inputIndex?: number;
  metadata?: Record<string, unknown>;
};

export type CatalogExactExternalIdLinkMatch = {
  inputIndex: number;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
  workId: string;
  canonicalTitle: string;
};

export type CatalogExactExternalIdLinkResult = {
  schemaVersion: typeof catalogExactExternalIdLinkSchemaVersion;
  status: CatalogExactExternalIdLinkStatus;
  subject: CatalogExactExternalIdLinkSubject | null;
  workId: string | null;
  matches: CatalogExactExternalIdLinkMatch[];
  diagnostics: CatalogExactExternalIdLinkDiagnostic[];
};

export interface ItotoriCatalogExactExternalIdLinkerPort {
  linkExactExternalIds(
    request: CatalogExactExternalIdLinkRequest,
  ): Promise<CatalogExactExternalIdLinkResult>;
}

type CatalogExternalIdLookupRepository = Pick<ItotoriCatalogRepositoryPort, "getWorkByExternalId">;

type NormalizedExternalId = {
  inputIndex: number;
  catalogSource: CatalogSource;
  sourceId: string;
  externalIdKind: CatalogExternalIdKind;
};

type NormalizedRequest = {
  subject: CatalogExactExternalIdLinkSubject | null;
  externalIds: NormalizedExternalId[];
  diagnostics: CatalogExactExternalIdLinkDiagnostic[];
};

const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
const catalogExternalIdKinds = Object.values(
  catalogExternalIdKindValues,
) as CatalogExternalIdKind[];

export class ItotoriCatalogExactExternalIdLinkerService implements ItotoriCatalogExactExternalIdLinkerPort {
  constructor(
    private readonly repository: CatalogExternalIdLookupRepository,
    private readonly actor: AuthorizationActor,
  ) {}

  async linkExactExternalIds(
    request: CatalogExactExternalIdLinkRequest,
  ): Promise<CatalogExactExternalIdLinkResult> {
    const normalized = normalizeRequest(request);
    if (normalized.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return result(
        catalogExactExternalIdLinkStatusValues.unsupported,
        normalized.subject,
        null,
        [],
        normalized.diagnostics,
      );
    }

    const matches: CatalogExactExternalIdLinkMatch[] = [];
    const unmatched: NormalizedExternalId[] = [];

    for (const externalId of normalized.externalIds) {
      const snapshot = await this.repository.getWorkByExternalId(
        this.actor,
        externalId.catalogSource,
        externalId.sourceId,
        externalId.externalIdKind,
      );
      if (snapshot === null) {
        unmatched.push(externalId);
        continue;
      }
      matches.push(matchFromSnapshot(externalId, snapshot));
    }

    if (matches.length === 0) {
      return result(
        catalogExactExternalIdLinkStatusValues.noMatch,
        normalized.subject,
        null,
        [],
        [
          ...normalized.diagnostics,
          diagnostic(
            catalogExactExternalIdLinkDiagnosticCodeValues.noMatch,
            "info",
            "No catalog work has an exact external-id match.",
            {
              externalIds: normalized.externalIds.map(externalIdDiagnosticMetadata),
            },
          ),
        ],
      );
    }

    const matchedWorkIds = Array.from(new Set(matches.map((match) => match.workId))).sort();
    if (matchedWorkIds.length > 1) {
      return result(
        catalogExactExternalIdLinkStatusValues.conflict,
        normalized.subject,
        null,
        matches,
        [
          ...normalized.diagnostics,
          diagnostic(
            catalogExactExternalIdLinkDiagnosticCodeValues.ambiguousConflict,
            "error",
            "Exact external IDs point at multiple catalog works; no link was selected.",
            {
              matchedWorkIds,
              matches: matches.map(matchDiagnosticMetadata),
            },
          ),
        ],
      );
    }

    const workId = matchedWorkIds[0];
    if (workId === undefined) {
      throw new Error("exact external-id linker produced a match without a work id");
    }

    const diagnostics =
      unmatched.length === 0
        ? normalized.diagnostics
        : [
            ...normalized.diagnostics,
            diagnostic(
              catalogExactExternalIdLinkDiagnosticCodeValues.noMatch,
              "info",
              "Some supplied external IDs had no exact catalog match; the matched work remains deterministic.",
              {
                externalIds: unmatched.map(externalIdDiagnosticMetadata),
              },
            ),
          ];

    return result(
      catalogExactExternalIdLinkStatusValues.linked,
      normalized.subject,
      workId,
      matches,
      diagnostics,
    );
  }
}

function normalizeRequest(request: CatalogExactExternalIdLinkRequest): NormalizedRequest {
  const diagnostics: CatalogExactExternalIdLinkDiagnostic[] = [];
  const subject = normalizeSubject(request.subject, diagnostics);
  const externalIds = Array.isArray(request.externalIds)
    ? request.externalIds.map((externalId, inputIndex) =>
        normalizeExternalId(externalId, inputIndex, diagnostics),
      )
    : [];

  if (
    request.schemaVersion !== undefined &&
    request.schemaVersion !== catalogExactExternalIdLinkSchemaVersion
  ) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
        "error",
        `Unsupported exact external-id link request schemaVersion ${request.schemaVersion}.`,
      ),
    );
  }

  if (!Array.isArray(request.externalIds) || externalIds.length === 0) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
        "error",
        "Exact external-id linking requires at least one external ID.",
      ),
    );
  }

  return {
    subject,
    externalIds: externalIds.filter((externalId): externalId is NormalizedExternalId => {
      return externalId !== null;
    }),
    diagnostics,
  };
}

function normalizeSubject(
  subject: CatalogExactExternalIdLinkSubject | undefined,
  diagnostics: CatalogExactExternalIdLinkDiagnostic[],
): CatalogExactExternalIdLinkSubject | null {
  if (subject === undefined) {
    return null;
  }
  const supportedKinds: CatalogExactExternalIdLinkSubject["kind"][] = [
    "catalog_source_record",
    "local_scan_entry",
    "manual_request",
    "fixture",
  ];
  if (!supportedKinds.includes(subject.kind) || !nonEmptyString(subject.id)) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
        "error",
        "Exact external-id link subject must use a supported kind and non-empty id.",
      ),
    );
    return null;
  }
  return subject;
}

function normalizeExternalId(
  externalId: CatalogExactExternalIdLinkExternalId,
  inputIndex: number,
  diagnostics: CatalogExactExternalIdLinkDiagnostic[],
): NormalizedExternalId | null {
  const catalogSource = externalId.catalogSource;
  if (!catalogSources.includes(catalogSource)) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
        "error",
        `External ID ${inputIndex} uses unsupported catalogSource ${String(catalogSource)}.`,
        undefined,
        inputIndex,
      ),
    );
    return null;
  }

  if (!nonEmptyString(externalId.sourceId)) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
        "error",
        `External ID ${inputIndex} requires a non-empty sourceId.`,
        undefined,
        inputIndex,
      ),
    );
    return null;
  }

  const externalIdKind = externalId.externalIdKind ?? catalogExternalIdKindValues.sourceRecord;
  if (!catalogExternalIdKinds.includes(externalIdKind)) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.invalidRequest,
        "error",
        `External ID ${inputIndex} uses unsupported externalIdKind ${String(externalIdKind)}.`,
        undefined,
        inputIndex,
      ),
    );
    return null;
  }

  if (externalIdKind === catalogExternalIdKindValues.localDetection) {
    diagnostics.push(
      diagnostic(
        catalogExactExternalIdLinkDiagnosticCodeValues.unsupportedExternalIdKind,
        "error",
        "local_detection IDs are detector observations and cannot authoritatively link catalog works.",
        {
          catalogSource,
          sourceId: externalId.sourceId,
          externalIdKind,
        },
        inputIndex,
      ),
    );
    return null;
  }

  return {
    inputIndex,
    catalogSource,
    sourceId: externalId.sourceId,
    externalIdKind,
  };
}

function matchFromSnapshot(
  externalId: NormalizedExternalId,
  snapshot: CatalogWorkSnapshot,
): CatalogExactExternalIdLinkMatch {
  return {
    inputIndex: externalId.inputIndex,
    catalogSource: externalId.catalogSource,
    sourceId: externalId.sourceId,
    externalIdKind: externalId.externalIdKind,
    workId: snapshot.workId,
    canonicalTitle: snapshot.canonicalTitle,
  };
}

function result(
  status: CatalogExactExternalIdLinkStatus,
  subject: CatalogExactExternalIdLinkSubject | null,
  workId: string | null,
  matches: CatalogExactExternalIdLinkMatch[],
  diagnostics: CatalogExactExternalIdLinkDiagnostic[],
): CatalogExactExternalIdLinkResult {
  return {
    schemaVersion: catalogExactExternalIdLinkSchemaVersion,
    status,
    subject,
    workId,
    matches,
    diagnostics,
  };
}

function diagnostic(
  code: CatalogExactExternalIdLinkDiagnosticCode,
  severity: CatalogExactExternalIdLinkDiagnostic["severity"],
  message: string,
  metadata?: Record<string, unknown>,
  inputIndex?: number,
): CatalogExactExternalIdLinkDiagnostic {
  return {
    code,
    severity,
    message,
    ...(inputIndex === undefined ? {} : { inputIndex }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function externalIdDiagnosticMetadata(externalId: NormalizedExternalId): Record<string, unknown> {
  return {
    inputIndex: externalId.inputIndex,
    catalogSource: externalId.catalogSource,
    sourceId: externalId.sourceId,
    externalIdKind: externalId.externalIdKind,
  };
}

function matchDiagnosticMetadata(match: CatalogExactExternalIdLinkMatch): Record<string, unknown> {
  return {
    inputIndex: match.inputIndex,
    catalogSource: match.catalogSource,
    sourceId: match.sourceId,
    externalIdKind: match.externalIdKind,
    workId: match.workId,
    canonicalTitle: match.canonicalTitle,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
