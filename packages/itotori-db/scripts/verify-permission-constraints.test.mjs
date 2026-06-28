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

test("ignores unregistered migration files", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
    },
    unregisteredMigrations: {
      "9999_unregistered_permissions.sql": namedGrantsConstraintSql(allPermissionValues),
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing from 0001_permissions\.sql:\d+ permission constraint/);
    assert.doesNotMatch(
      result.stderr,
      /9999_unregistered_permissions\.sql:\d+ permission constraint/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ignores commented-out migration registry entries", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
    },
    commentedOutMigrations: {
      "9999_unregistered_permissions.sql": namedGrantsConstraintSql(allPermissionValues),
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing from 0001_permissions\.sql:\d+ permission constraint/);
    assert.doesNotMatch(
      result.stderr,
      /9999_unregistered_permissions\.sql:\d+ permission constraint/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("requires the named permission constraint on the grants table", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
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
    registeredMigrations: {
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

test("ignores line-commented named grants-table constraints", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(stalePermissionValues),
      "0002_commented_exact_permission_check.sql": lineComment(
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

test("accepts the registered named grants-table constraint", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
      "0001_permissions.sql": namedGrantsConstraintSql(allPermissionValues),
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /permission constraint drift check ok/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects bare permission tokens in the registered permission list", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
      "0001_permissions.sql": namedGrantsConstraintSqlWithList(
        `${sqlStringList(allPermissionValues)}, permission`,
      ),
    },
  });

  try {
    const result = runVerifier(fixture);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /0001_permissions\.sql:\d+ permission constraint permission in \(\.\.\.\) list must contain only SQL string literals separated by commas/,
    );
    assert.match(
      result.stderr,
      /invalid permission in \(\.\.\.\) list: 'project\.import'.*, permission/,
    );
    assert.doesNotMatch(result.stderr, /drop constraint if exists/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects other non-string tokens in the registered permission list", async () => {
  const fixture = await createFixture({
    registeredMigrations: {
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

async function createFixture({
  registeredMigrations,
  unregisteredMigrations = {},
  commentedOutMigrations = {},
}) {
  const root = await mkdtemp(path.join(tmpdir(), "itotori-permission-constraint-"));
  const srcDir = path.join(root, "src");
  const migrationsDir = path.join(root, "migrations");
  await mkdir(srcDir, { recursive: true });
  await mkdir(migrationsDir, { recursive: true });

  const authorizationPath = path.join(srcDir, "authorization.ts");
  const migrationsSourcePath = path.join(srcDir, "migrations.ts");

  await writeFile(authorizationPath, authorizationSource(), "utf8");
  await writeFile(
    migrationsSourcePath,
    migrationRegistrySource(Object.keys(registeredMigrations), Object.keys(commentedOutMigrations)),
    "utf8",
  );

  for (const [file, sql] of Object.entries({
    ...registeredMigrations,
    ...unregisteredMigrations,
    ...commentedOutMigrations,
  })) {
    await writeFile(path.join(migrationsDir, file), sql, "utf8");
  }

  return { root, authorizationPath, migrationsDir, migrationsSourcePath };
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

function migrationRegistrySource(files, commentedOutFiles = []) {
  const entries = files
    .map((file) => {
      const id = file.replace(/\.sql$/u, "");
      return `  { id: "${id}", file: "${file}" },`;
    })
    .join("\n");
  const commentedOutEntries = commentedOutFiles
    .map((file) => {
      const id = file.replace(/\.sql$/u, "");
      return `  // { id: "${id}", file: "${file}" },`;
    })
    .join("\n");

  return `
    const migrations = [
${entries}
${commentedOutEntries}
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

function blockComment(sql) {
  return `/*${sql}*/`;
}

function lineComment(sql) {
  return `-- ${sql.replaceAll(/\s+/gu, " ").trim()}\n`;
}

function sqlStringList(values) {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}
