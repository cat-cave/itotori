import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { describe, expect, it } from "vitest";
import { FormatVersionMismatchError } from "@itotori/localization-bridge-schema";

import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  escapeRegExp,
  invalidManagedRuntimeArtifactUriCases,
  localActor,
  projectFixture,
  projectFixtureUnitId,
  runtimeEvidenceReportFixture,
  stableSerializeHashInput,
  v02Sha256,
} from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("records runtime artifact hash provenance (content vs repository_fallback) with exact deterministic fallback hash", async () => {
    // Runtime artifact refs must EXPOSE whether a hash came from
    // adapter/content evidence or REPOSITORY FALLBACK metadata, and the
    // generated fallback hash must be deterministic so dashboards/proof
    // manifests cannot overstate placeholder evidence as content proof.
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const runtimeReportId = "019ed003-0000-7000-8000-000000000907";
      const contentArtifactId = "019ed003-0000-7000-8000-000000000936";
      const fallbackArtifactId = "019ed003-0000-7000-8000-000000000937";
      const contentUri = `artifacts/utsushi/runtime/${runtimeReportId}/screenshots/${contentArtifactId}.png`;
      const fallbackUri = `artifacts/utsushi/runtime/${runtimeReportId}/screenshots/${fallbackArtifactId}.png`;
      const contentHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

      const runtimeReport = runtimeEvidenceReportFixture({
        runtimeReportId,
        captures: [
          {
            captureId: "019ed003-0000-7000-8000-000000000926",
            bridgeUnitRef: {
              bridgeUnitId: projectFixtureUnitId,
              sourceUnitKey: "hello.scene.001.line.001",
            },
            evidenceTier: "E2",
            frame: 1,
            width: 320,
            height: 180,
            nonZeroPixels: 57600,
            artifactRef: {
              artifactId: contentArtifactId,
              artifactKind: "screenshot",
              uri: contentUri,
              mediaType: "image/png",
              hash: contentHash,
            },
          },
          {
            captureId: "019ed003-0000-7000-8000-000000000927",
            bridgeUnitRef: {
              bridgeUnitId: projectFixtureUnitId,
              sourceUnitKey: "hello.scene.001.line.001",
            },
            evidenceTier: "E2",
            frame: 2,
            width: 320,
            height: 180,
            nonZeroPixels: 57600,
            // No adapter hash: the repository must generate the deterministic
            // placeholder and mark provenance as `repository_fallback`.
            artifactRef: {
              artifactId: fallbackArtifactId,
              artifactKind: "screenshot",
              uri: fallbackUri,
              mediaType: "image/png",
            },
          },
        ],
      });

      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeReport,
        "019ed003-0000-7000-8000-000000000987",
      );

      // Assert the EXACT deterministic fallback hash for the no-adapter-hash
      // fixture. This is sha256 over stableJsonStringify of the run-scoped
      // managed-artifact metadata; any drift (key order, field set) breaks.
      const expectedFallbackHash =
        "sha256:21321ec359221f445db4ca68a8dc8de002b49e4441cd488f19347de0f3f86613";

      const status = await repo.getRuntimeStatus(localActor);
      const artifacts = status.artifacts;
      const contentArtifact = artifacts.find(
        (artifact) => artifact.artifactId === `${runtimeReportId}:${contentArtifactId}`,
      );
      const fallbackArtifact = artifacts.find(
        (artifact) => artifact.artifactId === `${runtimeReportId}:${fallbackArtifactId}`,
      );

      expect(contentArtifact).toBeDefined();
      expect(fallbackArtifact).toBeDefined();

      // Content-backed ref: provenance is `content` and the adapter hash is
      // preserved verbatim (not regenerated from metadata).
      expect(contentArtifact?.hashProvenance).toBe("content");
      expect(contentArtifact?.hash).toBe(contentHash);

      // Fallback ref: provenance is `repository_fallback` and the EXACT
      // deterministic placeholder hash is asserted.
      expect(fallbackArtifact?.hashProvenance).toBe("repository_fallback");
      expect(fallbackArtifact?.hash).toBe(expectedFallbackHash);

      // Provenance is persisted in the artifact metadata too, so direct SQL
      // reads cannot mistake a placeholder for content proof.
      const metadataRows = await context.pool.query<{
        hash_provenance: string | null;
      }>(
        `
        select metadata->>'hashProvenance' as hash_provenance
        from itotori_artifacts
        where artifact_id in ($1, $2)
        order by artifact_id
        `,
        [`${runtimeReportId}:${contentArtifactId}`, `${runtimeReportId}:${fallbackArtifactId}`],
      );
      expect(metadataRows.rows.map((row) => row.hash_provenance).sort()).toEqual([
        "content",
        "repository_fallback",
      ]);

      // Sanity check: re-deriving the fallback hash from the same metadata
      // produces the same value. This protects against accidental drift in
      // the stableJsonStringify key set even if both sides were updated.
      const rederived = await context.pool.query<{
        artifact_id: string;
        artifact_kind: string;
        uri: string;
        media_type: string | null;
      }>(
        `
        select artifact_id, artifact_kind, uri,
          coalesce(metadata->>'mediaType', metadata->'artifactRef'->>'mediaType') as media_type
        from itotori_artifacts
        where artifact_id = $1
        `,
        [`${runtimeReportId}:${fallbackArtifactId}`],
      );
      const fallbackRow = rederived.rows[0]!;
      const mediaType = fallbackRow.media_type ?? undefined;
      expect(
        v02Sha256(
          stableSerializeHashInput({
            artifactId: fallbackRow.artifact_id,
            artifactKind: fallbackRow.artifact_kind,
            uri: fallbackRow.uri,
            ...(mediaType === undefined ? {} : { mediaType }),
          }),
        ),
      ).toBe(expectedFallbackHash);
    } finally {
      await context.close();
    }
  });
  it("rejects v0.1 runtime reports version-first at the repository boundary without writes", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      const countSql = `
        select
          (select count(*)::int from itotori_artifacts) as artifacts,
          (select count(*)::int from itotori_runtime_evidence_runs) as runtime_runs,
          (select count(*)::int from itotori_runtime_evidence_items) as runtime_items,
          (select count(*)::int from itotori_runtime_evidence_bridge_unit_refs) as runtime_refs,
          (select count(*)::int from itotori_runtime_validation_findings) as runtime_findings,
          (select count(*)::int from itotori_findings) as findings,
          (select count(*)::int from itotori_events) as events
      `;
      type RuntimeWriteCounts = {
        artifacts: number;
        runtime_runs: number;
        runtime_items: number;
        runtime_refs: number;
        runtime_findings: number;
        findings: number;
        events: number;
      };
      const before = await context.pool.query<RuntimeWriteCounts>(countSql);
      const currentReport = runtimeEvidenceReportFixture({
        runtimeReportId: "019ed003-0000-7000-8000-000000000908",
      });
      let siblingFieldReads = 0;
      const legacyReport: Record<string, unknown> = {
        ...currentReport,
        schemaVersion: "0.1.0",
      };
      Object.defineProperty(legacyReport, "traceEvents", {
        enumerable: true,
        get: () => {
          siblingFieldReads += 1;
          return currentReport.traceEvents;
        },
      });

      let rejection: unknown;
      try {
        await repo.saveRuntimeReport(
          localActor,
          project,
          legacyReport,
          "019ed003-0000-7000-8000-000000000988",
        );
      } catch (error: unknown) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(FormatVersionMismatchError);
      expect(rejection).toMatchObject({
        observed: "0.1.0",
        supported: "0.2.0",
        message: expect.stringMatching(/Migration path:/u),
      });
      expect(siblingFieldReads).toBe(0);
      const after = await context.pool.query<RuntimeWriteCounts>(countSql);
      expect(after.rows).toEqual(before.rows);
    } finally {
      await context.close();
    }
  });
  it("rejects non-portable runtime artifact refs before storage conversion", async () => {
    const invalidRuntimeArtifactUris = [
      ["current-directory dot segment", "./capture.png"],
      ["parent-directory dot segment", "../capture.png"],
      ["nested parent-directory dot segment", "artifacts/utsushi/../capture.png"],
      ["empty path segment", "artifacts/utsushi/runtime/runtime-report//capture.png"],
      ["URI scheme", "https://example.invalid/capture.png"],
      ["embedded data URI", "data:image/png;base64,AAAA"],
      ["absolute POSIX path", "/tmp/runtime/frame.png"],
      ["Windows path", "C:\\runtime\\frame.png"],
    ] as const;
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      for (const [_label, uri] of invalidRuntimeArtifactUris) {
        await expect(
          repo.saveRuntimeReport(
            localActor,
            project,
            runtimeEvidenceReportFixture({
              runtimeReportId: "019ed003-0000-7000-8000-000000000903",
              captures: [
                {
                  ...runtimeEvidenceReportFixture().captures[0]!,
                  captureId: "019ed003-0000-7000-8000-000000000923",
                  artifactRef: {
                    ...runtimeEvidenceReportFixture().captures[0]!.artifactRef,
                    artifactId: "019ed003-0000-7000-8000-000000000934",
                    uri,
                  },
                },
              ],
            }),
            "019ed003-0000-7000-8000-000000000983",
          ),
        ).rejects.toThrow(new RegExp(`portable relative artifact path.*${escapeRegExp(uri)}`));
      }
    } finally {
      await context.close();
    }
  });
  it("rejects malformed managed runtime artifact refs through repository and direct SQL", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      for (const [index, [_label, uri]] of invalidManagedRuntimeArtifactUriCases.entries()) {
        await expect(
          repo.linkArtifact(localActor, {
            artifactId: `runtime-uri-repository-${index}`,
            projectId: project.projectId,
            artifactKind: "screenshot",
            uri,
          }),
        ).rejects.toThrow(/runtime artifact uri must be/u);
      }

      const runtimeReport = runtimeEvidenceReportFixture({
        runtimeReportId: "019ed003-0000-7000-8000-000000000906",
      });
      const capture = runtimeReport.captures[0]!;
      const runtimeArtifactId = `${runtimeReport.runtimeReportId}:${capture.artifactRef.artifactId}`;
      const runtimeEvidenceId = `${runtimeReport.runtimeReportId}:${capture.captureId}`;
      await repo.saveRuntimeReport(
        localActor,
        project,
        runtimeReport,
        "019ed003-0000-7000-8000-000000000986",
      );

      for (const [_label, uri] of invalidManagedRuntimeArtifactUriCases) {
        await expect(
          context.pool.query("update itotori_artifacts set uri = $1 where artifact_id = $2", [
            uri,
            runtimeArtifactId,
          ]),
        ).rejects.toThrow(/itotori_runtime_artifact_uri_check/u);
        await expect(
          context.pool.query(
            "update itotori_runtime_evidence_items set portable_artifact_uri = $1 where runtime_evidence_id = $2",
            [uri, runtimeEvidenceId],
          ),
        ).rejects.toThrow(/itotori_runtime_evidence_managed_uri_check/u);
      }

      const persisted = await context.pool.query<{
        artifact_uri: string;
        portable_artifact_uri: string;
      }>(
        `
        select a.uri as artifact_uri, e.portable_artifact_uri
        from itotori_artifacts a
        join itotori_runtime_evidence_items e on e.artifact_id = a.artifact_id
        where a.artifact_id = $1
        `,
        [runtimeArtifactId],
      );
      expect(persisted.rows).toEqual([
        {
          artifact_uri: capture.artifactRef.uri,
          portable_artifact_uri: capture.artifactRef.uri,
        },
      ]);
    } finally {
      await context.close();
    }
  });
});
