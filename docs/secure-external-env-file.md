# Secure external env-file workflow (live-provider credentials)

itotori runs live translations against OpenRouter using a small set of
credentials — chiefly `OPENROUTER_API_KEY`. This document describes the
**secure, portable** way to supply those credentials: point itotori at an
arbitrary env-file you control, without any repo-local plaintext `.env` and
**without any Nix, sops, or workstation-path dependency**.

itotori is **Nix/sops-agnostic**. It does not know or care how you produce the
env file. The nix-desktop workstation happens to render one at
`~/.config/nix-desktop/secrets/env.d/itotori-openrouter.env` from a sops secret
(`openrouter-itotori-key`), but that path is **only an example** — any file you
choose works, and non-Nix users are never forced into that setup.

## TL;DR — recommended usage

```sh
# Env-var form (works for every itotori command):
ITOTORI_LOCAL_ENV_FILE=~/.config/nix-desktop/secrets/env.d/itotori-openrouter.env \
  itotori localize --run-mode production --structure <structure.json> --bridge <bridge.json>

# Or the CLI-flag form (takes precedence over the env var):
itotori localize --env-file /path/to/your/itotori-openrouter.env \
  --run-mode production --structure <structure.json> --bridge <bridge.json>
```

The env file is a plain `.env`-style file. A minimal one:

```sh
# itotori-openrouter.env — DO NOT commit; keep 0600 permissions.
OPENROUTER_API_KEY=sk-or-...your-key...
OPENROUTER_ZDR_ACCOUNT_ASSERTED=1
```

## How to supply the file

Two inputs, in precedence order (**highest first**):

1. `--env-file <path>` — a CLI flag naming any path you choose.
2. `ITOTORI_LOCAL_ENV_FILE=<path>` — an environment variable naming any path.

If **both** are given, the `--env-file` flag wins. If neither is given, no
external file is loaded (see [`.env` fallback](#env-fallback-less-preferred)).

A file specified by **either** input that cannot be read (missing path, wrong
permissions) **fails loud** with a typed `ExternalEnvFileError` — itotori never
silently continues as if you had supplied nothing.

## What is loaded — the allowlist

Only these live-provider variables are ever read from the env file. **Any other
key in the file is ignored** — a rogue `PATH=`, `AWS_SECRET_ACCESS_KEY=`, or
exfil variable in the file can never enter the process environment:

| Variable                          | Purpose                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `OPENROUTER_API_KEY`              | OpenRouter API credential.                                       |
| `OPENROUTER_ZDR_ACCOUNT_ASSERTED` | Asserts the account is Zero-Data-Retention-only (`=1` required). |
| `OPENROUTER_ZDR_DOWNGRADE`        | Operator-level per-leaf ZDR downgrade (optional).                |

The allowlist lives in `apps/itotori/src/env/external-env-file.ts`
(`EXTERNAL_ENV_FILE_ALLOWLIST`) and is kept in sync with what the OpenRouter
provider and the live-localize path actually consume.

## Precedence — an exported var always wins

An **already-exported** process environment variable is **never overwritten**
by a file value. A file value is applied only when the target variable is
currently unset. This lets you override the file at any time via the real
environment:

```sh
# The exported key wins; the file's OPENROUTER_API_KEY is ignored.
OPENROUTER_API_KEY=sk-or-override \
ITOTORI_LOCAL_ENV_FILE=/path/to/itotori-openrouter.env \
  itotori localize --run-mode production --structure <structure.json> --bridge <bridge.json>
```

## Secret hygiene

- Loaded **values never appear** in argv, logs, stdout/stderr, generated
  reports, error messages, or any command string. Never pass the key as a CLI
  argument — pass a **file path**, not a value.
- itotori's only console note about loading is a non-secret summary of the
  applied variable **names** plus the file path — never the values.
- The env file itself is your secret store: keep it out of the repo, restrict
  permissions (`chmod 600`), and never commit it.

## direnv / `.envrc` — opt-in, never auto-loaded from a tracked path

The tracked `.envrc` does **not** auto-load any plaintext secrets. It only runs
`use flake` and then optionally sources a **gitignored** `.envrc.local` if you
create one:

```sh
# .envrc  (tracked)
use flake
source_env_if_exists .envrc.local
```

If you want direnv to load credentials on `cd`, opt in by creating
`.envrc.local` (gitignored):

```sh
# .envrc.local  (gitignored — never committed)
dotenv_if_exists .env
# or point at your external file:
# dotenv /path/to/itotori-openrouter.env
```

Both `.env` and `.envrc.local` are gitignored, so secrets are never
auto-loaded from a tracked path.

## `.env` fallback — less preferred (plaintext)

<a name="env-fallback-less-preferred"></a>
A repo-local `.env` still works as a **local-only fallback** if you have opted
into loading it via `.envrc.local` (above), but it is **not the recommended
path**: it is plaintext on disk inside the repo tree. Prefer the external
env-file workflow (`--env-file` / `ITOTORI_LOCAL_ENV_FILE`) with a file kept
outside the repo. A live run works with **only** the external env file — no
repo `.env` is required.
