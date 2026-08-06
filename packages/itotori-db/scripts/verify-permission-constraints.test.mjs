import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPermissionConstraintDrift } from "./verify-permission-constraints.mjs";

const permissions = [
  ["projectImport", "project.import"],
  ["draftWrite", "draft.write"],
  ["patchExport", "patch.export"],
  ["runtimeIngest", "runtime.ingest"],
  ["feedbackImport", "feedback.import"],
  ["queueManage", "queue.manage"],
  ["queueRead", "queue.read"],
  ["catalogRead", "catalog.read"],
  ["catalogWrite", "catalog.write"],
  ["systemReset", "system.reset"],
];
const allPermissionValues = permissions.map(([, value]) => value);
const stalePermissionValues = allPermissionValues.filter((value) => value !== "catalog.write");

test("scans every on-disk migration SQL file (filesystem is the registry)", async () => {
  const fixture = await createFixture({
    migrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
      "0002_later_permissions.sql": namedGrantsConstraintSql(allPermissionValues),
    },
  });

  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /0002_later_permissions\.sql/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects duplicate ordinal prefixes among on-disk migrations", async () => {
  const fixture = await createFixture({
    migrations: {
      "0122_fanout_test_1.sql": namedGrantsConstraintSql(allPermissionValues),
      "0122_fanout_test_2.sql": "-- empty\n",
    },
  });

  try {
    const result = runVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate migration ordinals/u);
    assert.match(result.stderr, /0122/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("requires the named permission constraint on the grants table", async () => {
  const fixture = await createFixture({
    migrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
      "0002_unrelated_permission_check.sql": `
        create table unrelated_permission_checks (
          permission text not null check (
            permission in (${sqlStringList(allPermissionValues)})
          )
        );

        alter table itotori_user_permission_grants
          add check (
            permission in (${sqlStringList(allPermissionValues)})
          );
      `,
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing from 0001_permissions\.sql:\d+ permission constraint/);
    assert.doesNotMatch(
      result.stderr,
      /0002_unrelated_permission_check\.sql:\d+ permission constraint/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ignores block-commented named grants-table constraints", async () => {
  const fixture = await createFixture({
    migrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
      "0002_commented_exact_permission_check.sql": blockComment(
        namedGrantsConstraintSql(allPermissionValues),
      ),
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing from 0001_permissions\.sql:\d+ permission constraint/);
    assert.doesNotMatch(
      result.stderr,
      /0002_commented_exact_permission_check\.sql:\d+ permission constraint/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("accepts the latest matching grants-table permission constraint", async () => {
  const fixture = await createFixture({
    migrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
      "0002_permissions_refresh.sql": namedGrantsConstraintSql(allPermissionValues),
    },
  });

  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /0002_permissions_refresh\.sql/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a drift when the latest constraint is stale", async () => {
  const fixture = await createFixture({
    migrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(allPermissionValues),
      "0002_permissions_stale.sql": namedGrantsConstraintSql(stalePermissionValues),
    },
  });

  try {
    const result = runVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0002_permissions_stale\.sql:\d+ permission constraint/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects non-string permission list entries", async () => {
  const fixture = await createFixture({
    migrations: {
      "0001_permissions.sql": namedGrantsConstraintSqlWithList(
        `${sqlStringList(allPermissionValues)}, 42`,
      ),
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0001_permissions\.sql:\d+ permission constraint/);
    assert.match(result.stderr, /invalid permission in \(\.\.\.\) list: 'project\.import'.*, 42/);
    assert.doesNotMatch(result.stderr, /drop constraint if exists/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture({ migrations }) {
  const root = await mkdtemp(path.join(tmpdir(), "itotori-permission-constraint-"));
  const srcDir = path.join(root, "src");
  const migrationsDir = path.join(root, "migrations");
  await mkdir(srcDir, { recursive: true });
  await mkdir(migrationsDir, { recursive: true });

  const authorizationPath = path.join(srcDir, "authorization.ts");

  await writeFile(authorizationPath, authorizationSource(), "utf8");

  for (const [file, sql] of Object.entries(migrations)) {
    await writeFile(path.join(migrationsDir, file), sql, "utf8");
  }

  return { root, authorizationPath, migrationsDir };
}

function runVerifier(fixture) {
  const stdout = [];
  const originalLog = console.log;
  console.log = (...args) => {
    stdout.push(args.join(" "));
  };

  try {
    verifyPermissionConstraintDrift(fixture);
    return { status: 0, stdout: stdout.join("\n"), stderr: "" };
  } catch (error) {
    return {
      status: 1,
      stdout: stdout.join("\n"),
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    console.log = originalLog;
  }
}

function authorizationSource() {
  const valueLines = permissions.map(([key, value]) => `  ${key}: "${value}",`).join("\n");
  const permissionLines = permissions.map(([key]) => `  permissionValues.${key},`).join("\n");

  return `
    export const permissionValues = {
${valueLines}
    } as const;

    export const allPermissions = [
${permissionLines}
    ] as const;
  `;
}

function namedGrantsConstraintSql(values) {
  return namedGrantsConstraintSqlWithList(sqlStringList(values));
}

function namedGrantsConstraintSqlWithList(list) {
  return `
    alter table itotori_user_permission_grants
      drop constraint if exists itotori_user_permission_grants_permission_check;

    alter table itotori_user_permission_grants
      add constraint itotori_user_permission_grants_permission_check check (
        permission in (${list})
      );
  `;
}

function sqlStringList(values) {
  return values.map((value) => `'${value}'`).join(", ");
}

function blockComment(sql) {
  return `/*\n${sql}\n*/\n`;
}
