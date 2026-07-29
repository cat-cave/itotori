# Deployment environment files

The deployment environment is a closed, reviewed interface. Its source of truth
is [`config/environment-registry.json`](../config/environment-registry.json);
[`.env.example`](../.env.example) is generated from it and must not be edited
by hand. The registry describes the only host-held secrets and host-owned mount
or storage locations the application may read from its environment.

An operator may keep those values in a private environment file outside the
repository and supply it through the application’s supported configuration
path. Do not commit an environment file, print its values, or add an unlisted
name to local shell setup. The loader and `scripts/env-registry-guard.mjs`
reject undeclared literal reads.

This boundary is deliberately not a convenience settings store. If a translator
would ever want a different locale, corpus root inside the mounted vault,
revision, policy, budget, or game-specific choice, model it as application
configuration or a command argument. Do not turn it into an environment
variable.

The registry guard’s limit is important: it scans tracked literal read forms.
It cannot see dynamically constructed names or untracked files, so review is
still required when code changes how configuration is loaded.
