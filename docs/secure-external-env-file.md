# Deployment environment files

The deployment environment is a closed, reviewed interface. Its source of truth
is [`config/environment-registry.json`](../config/environment-registry.json);
[`.env.example`](../.env.example) is generated from it and must not be edited
by hand. The registry describes the only host-held secrets and host-owned mount
or storage locations the application may read from its environment.

An operator may keep those values in a private environment file outside the
repository and supply it through the application’s supported `--env-file`
configuration path. Do not commit an environment file, print its values, or
add an unlisted name to local shell setup. At CLI startup the loader requires a
private regular file, validates every entry before applying any of them, and
refuses unknown, malformed, duplicate, non-Unicode, or insecure input before a
command becomes ready. Diagnostics name a path or setting name only, never a
value. The loader and `scripts/env-registry-guard.mjs` reject undeclared
literal reads.

For compatibility with `itotori init`, a private file may also contain its
existing `DATABASE_URL` line. The env-file loader recognizes that documented
line but never applies it to the process; source it explicitly for database
commands. This preserves the provider-only process injection boundary.

This boundary is deliberately not a convenience settings store. If a translator
would ever want a different locale, corpus root inside the mounted vault,
revision, policy, budget, or game-specific choice, model it as application
configuration or a command argument. Do not turn it into an environment
variable.

## Application deployment configuration

Use `--deployment-config <path>` for the reviewed, non-environment application
configuration surface. It is also a private regular UTF-8 file and is loaded
before command dispatch. The flag does not add, synthesize, or read an
environment variable. A supplied file must contain `application.profile`; it
may contain the other documented settings below. Values are not echoed in CLI
output. The validated immutable settings map is retained in the command's
startup context; `db-migrate` and `db-reset` receive and re-check that context
before they begin database work. It is an admission/provenance boundary, not a
replacement for command-specific arguments or a mechanism for mutating process
environment.

```text
application.profile                 application.display_name
application.locale                  application.source_locale
application.engine_family           application.run_mode
application.release_channel         application.update_policy
application.telemetry_policy        workspace.root
workspace.cache_root                workspace.artifact_root
workspace.retention_policy          workspace.concurrency
database.migration_policy           database.connection_policy
database.backup_policy              database.recovery_policy
provider.model                      provider.routing_policy
provider.retry_policy               provider.cost_policy
provider.redaction_policy           render.font_policy
render.browser_policy               render.accessibility_policy
render.capture_policy               patch.output_policy
patch.validation_policy             patch.rollback_policy
security.custody_policy             security.audit_policy
security.secret_reference_policy
```

The schema intentionally has more than thirty-two documented names without
expanding the eight-name environment registry. Each name may appear once;
unknown, malformed, duplicate, non-Unicode, insecure, or unsupported trailing
value forms are a typed refusal before readiness. Quoted values preserve the
supported dollar signs, quotes, spaces, and backslashes literally; the parser
does not perform shell expansion.

The registry guard’s limit is important: it scans tracked literal read forms.
It cannot see dynamically constructed names or untracked files, so review is
still required when code changes how configuration is loaded. The runtime file
loader is the complementary boundary for supplied file contents; it never
silently ignores a setting or expands shell syntax.
