{
  description = "itotori dev environment (Rust + Node monorepo)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          # Rust (rust-toolchain.toml pins stable + rustfmt/clippy/rust-src). nixpkgs stable
          # rust covers it; rustup is not used inside the nix shell.
          rustc
          cargo
          clippy
          rustfmt
          cargo-deny
          # common native build deps for crates
          pkg-config
          openssl
          # Node side
          nodejs_24
          just
          git
          # Browser lane: nix-provided Chromium for the runtime-web Playwright
          # e2e (fe-runtime-web-playwright) AND the Rust MV/MZ real-browser
          # gates. Playwright's own downloaded browsers are dynamically linked
          # against libraries absent on NixOS, so the deterministic, hermetic
          # binary is this nix-built Chromium (pinned by flake.lock).
          chromium
        ];
        env = {
          # rust-analyzer std sources
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          # The runtime-web Playwright config reads this to launch the
          # nix-provided Chromium via `executablePath` instead of a downloaded
          # browser. The Rust adapters read `UTSUSHI_BROWSER_BIN` for the same
          # binary, so both point at one deterministic Chromium.
          PLAYWRIGHT_CHROMIUM_BIN = "${pkgs.chromium}/bin/chromium";
          UTSUSHI_BROWSER_BIN = "${pkgs.chromium}/bin/chromium";
          # Never let Playwright try to download its own (unusable on NixOS)
          # browser bundle; the nix Chromium above is the only supported one.
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        };
        shellHook = ''
          # Heavy/churny build artifacts live on the fast RAID0 scratch, not the boot drive.
          worktree_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
          worktree_root="$(cd "$worktree_root" && pwd -P)"
          worktree_basename="''${worktree_root##*/}"
          worktree_name="$(printf "%s" "$worktree_basename" | ${pkgs.coreutils}/bin/tr -c 'A-Za-z0-9._-' '_')"
          worktree_hash="$(printf "%s" "$worktree_root" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -c1-12)"
          export CARGO_TARGET_DIR="/scratch/cache/itotori/target-$worktree_name-$worktree_hash"
          # Per-worktree Postgres host port (same canonical-root scheme as
          # CARGO_TARGET_DIR) so concurrent worktrees never collide on
          # `just db-up` / db-backed tests. An explicit DATABASE_URL (CI,
          # operator) is left untouched.
          if [ -z "''${DATABASE_URL:-}" ]; then
            worktree_db_url="$(ITOTORI_DB_WORKTREE_ROOT="$worktree_root" ${pkgs.nodejs_24}/bin/node "$worktree_root/scripts/itotori-db-compose-env.mjs" --print-database-url 2>/dev/null || true)"
            [ -n "$worktree_db_url" ] && export DATABASE_URL="$worktree_db_url"
          fi
          export PNPM_HOME="/scratch/cache/itotori/pnpm-store"
          # Per-project pnpm (package.json: pnpm@10.17.1) via corepack into a writable dir.
          export COREPACK_HOME="$PWD/.corepack"
          mkdir -p "$COREPACK_HOME/bin"
          corepack enable --install-directory "$COREPACK_HOME/bin" pnpm 2>/dev/null || true
          export PATH="$PWD/bin:$COREPACK_HOME/bin:$PATH"
          echo "itotori devshell — rust $(rustc --version | cut -d\  -f2), node $(node -v); CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
        '';
      };
    };
}
