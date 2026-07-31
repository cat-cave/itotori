export interface FieldPopulation {
  field: string;
  nonemptyCount: number;
  totalCount: number;
}

export interface EvidenceCaseBinding {
  caseId: string;
  evidenceKind: string;
  sourceClass: string;
  privacyClass: string;
  contentCase: string;
  referenceKind: string;
}

export interface AuditReceipt extends EvidenceCaseBinding {
  schema: "itotori.portable-evidence-audit.v2";
  auditOutcome: string;
  metadataComplete: boolean;
  freshResolution: boolean;
  independentProducer: boolean;
  copiedExpectationRejected: boolean;
  coherentLineage: boolean;
  deterministicDependents: boolean;
  tamperRejected: boolean;
  staleRevisionRejected: boolean;
  localLocationRejected: boolean;
  restrictedPublicationWithheld: boolean;
  trustRole: "local-candidate-contract";
  protectedAttestationPresent: false;
  fieldPopulation: readonly FieldPopulation[];
  bundleDigest: string;
  productSourceDigest: string;
  productBuildDigest: string;
  producerImplementationDigests: readonly string[];
  producerDependencyDigests: {
    support: string;
    contract: string;
    portability: string;
  };
  producerIdentities: readonly string[];
  verifierRandomizedCommitment: string;
}

export interface AuditOptions extends EvidenceCaseBinding {
  bundleRoot: string;
  evaluatedProducerImplementationPath: string;
  expectationProducerImplementationPath: string;
  productBoundaryPath: string;
  expectedProductSourceDigest: string;
  expectedProductBuildDigest: string;
  expectedBuildRevision: string;
}
