# Native dependency provisioning

The installed application may drive native extraction, replay, database, and
browser components. Provision them through the supported installer or host
configuration.

The checked-in `doctor` delegate is presently not usable: `just doctor core`,
`just doctor render`, and `just doctor full` pass the profile as a positional
argument, while `scripts/native-deps.mjs` requires `--profile <profile>`. Each
exits with `unknown argument`. Do not report a native-dependency check as run
until that dispatcher mismatch is repaired; this documentation change does not
change command behavior.

Native executable locations, browser selection, and local database details are
application/installer configuration. Do not document them as ad-hoc deployment
environment variables. The only deployment environment inputs are the entries
in `config/environment-registry.json`: operator-held secrets and host-owned
mount or scratch roots. A translator’s corpus selection, locale, run policy,
or executable preference is application configuration.

The doctor can establish availability only. It cannot prove that an executable
will decode a particular corpus, that a database migration contains the desired
data, or that a browser has rendered a private corpus correctly. Those are
separate extraction, database, and evidence checks.
