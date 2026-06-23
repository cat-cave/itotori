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
        ];
        env = {
          # rust-analyzer std sources
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
        };
        shellHook = ''
          # Heavy/churny build artifacts live on the fast RAID0 scratch, not the boot drive.
          export CARGO_TARGET_DIR="/scratch/cache/itotori/target"
          export PNPM_HOME="/scratch/cache/itotori/pnpm-store"
          # Per-project pnpm (package.json: pnpm@10.17.1) via corepack into a writable dir.
          export COREPACK_HOME="$PWD/.corepack"
          mkdir -p "$COREPACK_HOME/bin"
          corepack enable --install-directory "$COREPACK_HOME/bin" pnpm 2>/dev/null || true
          export PATH="$COREPACK_HOME/bin:$PATH"
          echo "itotori devshell — rust $(rustc --version | cut -d\  -f2), node $(node -v); CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
        '';
      };
    };
}
