# Hello World

The hello world is a full fixture localization loop.

```sh
just install
just hello
```

The command runs:

1. `kaifuu extract` on `fixtures/hello-game`.
2. `itotori import`, `draft`, and `export-patch`.
3. `kaifuu patch`, `diff`, `apply`, and `verify`.
4. `utsushi trace`, `capture`, and `smoke`.
5. `itotori ingest-runtime` and final summary generation.

Expected final line:

```txt
status=hello_world_passed
```

The fixture source text is `こんにちは、{player}。`; the fake provider outputs `Hello, {player}.` and the deterministic checks preserve the `{player}` protected span.
