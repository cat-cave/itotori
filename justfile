set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# The developer surface is intentionally six parameterized delegates.  The
# selector is validated by scripts/developer-command.mjs; aliases belong there
# only when they describe a real capability, never as another recipe name.
worktree-setup:
    node scripts/developer-command.mjs worktree-setup

dev service="app" *args:
    node scripts/developer-command.mjs dev {{service}} {{args}}

doctor profile="full" *args:
    node scripts/developer-command.mjs doctor {{profile}} {{args}}

check scope="all" *args:
    node scripts/developer-command.mjs check {{scope}} {{args}}

test selector="all" *args:
    node scripts/developer-command.mjs test {{selector}} {{args}}

ci lane="public" *args:
    node scripts/developer-command.mjs ci {{lane}} {{args}}
