{
  description = "itotori dev environment (Rust + Node monorepo)";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
  outputs =
    { nixpkgs, rust-overlay, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };
      rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

      # THE RENDERER CONTRACT for every pixel-exact oracle (DS visual baselines
      # are maxDiffPixels=0). A screenshot is a function of the browser binary,
      # the faces fontconfig resolves for it, AND the rasterization settings
      # applied to those faces. The DS type stacks are art direction, not
      # repo-shipped files, so every family falls through to a generic
      # (`system-ui`, `sans-serif`, `monospace`) that an unpinned host answers
      # with whatever it happens to have installed.
      #
      # Written by hand rather than with the nixpkgs fonts-conf helper, which is
      # ADDITIVE rather than hermetic: it appends the pinned dirs but keeps
      # `<include>/etc/fonts/conf.d`, `<dir>/usr/share/fonts`, the XDG font dir
      # and a DejaVu fallback. MEASURED on CI (run 30268820254): with that file,
      # 32 of 35 stories differed, because a stock Ubuntu image contributes
      # `10-sub-pixel-rgb.conf` (LCD subpixel text, where this workstation
      # contributes `10-sub-pixel-none`) and `/usr/share/fonts/truetype/dejavu`,
      # which its `60-latin.conf` then prefers — so `monospace` resolved to
      # DejaVu Sans Mono there and Hack here, with every path still under
      # /nix/store. Reproduced locally in an Ubuntu container: 33/35 fail with
      # that file, 0/35 and byte-identical with this one.
      #
      # Editing ANY of this changes every baseline: re-capture with it.
      browserFontsConf = pkgs.writeText "itotori-visual-fonts.conf" ''
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
        <fontconfig>
          <!-- The ENTIRE font universe. No include directive, so no host
               conf.d rule and no host font directory can reach a capture.
               CJK is listed EXPLICITLY because the DS renders Japanese (the
               bilingual text component shows a ja-JP source line). It used to
               resolve only because this workstation's
               /etc/fonts/conf.d/00-nixos-cache.conf enumerates the NixOS system
               font dirs, one of which is noto-fonts-cjk-sans — so the old
               baselines rendered Japanese with a font present on ONE machine,
               and a host without it draws tofu. -->
          <dir>${pkgs.noto-fonts}</dir>
          <dir>${pkgs.noto-fonts-cjk-sans}</dir>
          <dir>${pkgs.hack-font}</dir>
          <cachedir prefix="xdg">fontconfig</cachedir>

          <!-- Normalize the deprecated/alternate generic spellings the stock
               configs would otherwise supply. -->
          <match target="pattern"><test qual="any" name="family"><string>sans</string></test><edit name="family" mode="assign" binding="same"><string>sans-serif</string></edit></match>
          <match target="pattern"><test qual="any" name="family"><string>sans serif</string></test><edit name="family" mode="assign" binding="same"><string>sans-serif</string></edit></match>
          <match target="pattern"><test qual="any" name="family"><string>mono</string></test><edit name="family" mode="assign" binding="same"><string>monospace</string></edit></match>
          <match target="pattern"><test qual="any" name="family"><string>system ui</string></test><edit name="family" mode="assign" binding="same"><string>system-ui</string></edit></match>

          <!-- The families the DS names as art direction and deliberately does
               NOT vendor. Chromium takes whatever fontconfig answers for a
               named family rather than walking the CSS stack itself, and with
               no rule the answer is the face that sorts first — Hack, a
               MONOSPACE face, which renders all body copy monospaced. A
               default (not a prefer) appends the generic, so these stay weak
               and charset/lang fallback still works. Order matters: these must
               precede the generic rules below or the chain does not resolve. -->
          <alias binding="same"><family>Zen Kaku Gothic New</family><default><family>sans-serif</family></default></alias>
          <alias binding="same"><family>Inter</family><default><family>sans-serif</family></default></alias>
          <alias binding="same"><family>Chakra Petch</family><default><family>sans-serif</family></default></alias>
          <alias binding="same"><family>DotGothic16</family><default><family>monospace</family></default></alias>
          <alias binding="same"><family>Space Mono</family><default><family>monospace</family></default></alias>

          <!-- fontconfig's own 49-sansserif rule, restated. Dropping the host
               conf.d also drops this, and without it a family nobody ships is
               answered with whatever face sorts first — Hack — so ALL Latin
               prose rasterized monospace (confirmed via CDP
               CSS.getPlatformFontsForNode: "Hack x115" on the wiki prose).
               Appending the GENERIC rather than a concrete face is what keeps
               charset/lang fallback intact. -->
          <match target="pattern">
            <test qual="all" name="family" compare="not_eq"><string>sans-serif</string></test>
            <test qual="all" name="family" compare="not_eq"><string>serif</string></test>
            <test qual="all" name="family" compare="not_eq"><string>monospace</string></test>
            <edit name="family" mode="append_last"><string>sans-serif</string></edit>
          </match>

          <!-- Family resolution, pinned. noto-fonts ships 229 faces, so which
               one answers a generic is otherwise decided by whichever conf.d
               ruleset the host happens to ship. These are weak preferences on
               purpose: a STRONG family binding outranks fontconfig's
               charset/lang scoring, which turns every Japanese glyph into tofu
               because "Noto Sans" wins a query it cannot render. -->
          <alias binding="same"><family>sans-serif</family><prefer><family>Noto Sans</family><family>Noto Sans CJK JP</family></prefer></alias>
          <alias binding="same"><family>system-ui</family><prefer><family>Noto Sans</family><family>Noto Sans CJK JP</family></prefer></alias>
          <alias binding="same"><family>serif</family><prefer><family>Noto Serif</family></prefer></alias>
          <alias binding="same"><family>monospace</family><prefer><family>Hack</family></prefer></alias>
          <alias binding="same"><family>ui-monospace</family><prefer><family>Hack</family></prefer></alias>

          <!-- Rasterization, pinned. Grayscale antialiasing with no hinting is
               the setting least dependent on host FreeType configuration;
               subpixel output would additionally depend on a display geometry
               no headless runner actually has. -->
          <match target="font">
            <edit name="antialias" mode="assign"><bool>true</bool></edit>
            <edit name="hinting" mode="assign"><bool>false</bool></edit>
            <edit name="hintstyle" mode="assign"><const>hintnone</const></edit>
            <edit name="autohint" mode="assign"><bool>false</bool></edit>
            <edit name="rgba" mode="assign"><const>none</const></edit>
            <edit name="lcdfilter" mode="assign"><const>lcdnone</const></edit>
            <edit name="embeddedbitmap" mode="assign"><bool>false</bool></edit>
          </match>
        </fontconfig>
      '';
      browserEnv = {
        # The runtime-web Playwright config reads this to launch the
        # nix-provided Chromium via `executablePath` instead of a downloaded
        # browser. The Rust adapters read `UTSUSHI_BROWSER_BIN` for the same
        # binary, so both point at one deterministic Chromium.
        PLAYWRIGHT_CHROMIUM_BIN = "${pkgs.chromium}/bin/chromium";
        UTSUSHI_BROWSER_BIN = "${pkgs.chromium}/bin/chromium";
        # Never let Playwright try to download its own (unusable on NixOS)
        # browser bundle; the nix Chromium above is the only supported one.
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        FONTCONFIG_FILE = browserFontsConf;
      };
    in
    {
      # Minimal shell for CI's browser lane: the pinned renderer contract and
      # nothing else, so a hosted runner does not realise the Rust toolchain to
      # take a screenshot. Node and pnpm come from the runner's own setup; just
      # is a flake.lock-pinned derivation so the browser lane cannot resolve a
      # runner-provided tool that changed underneath the workflow.
      devShells.${system} = {
        browser = pkgs.mkShell {
          packages = [
            pkgs.chromium
            pkgs.fontconfig # fc-match, so the lane can PROVE which face it resolved
            pkgs.just
          ];
          env = browserEnv;
        };

        default = pkgs.mkShell {
          packages = with pkgs; [
            # Rust (rust-toolchain.toml pins the exact compiler and components).
            rustToolchain
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
          env = browserEnv // {
            # rust-analyzer std sources
            RUST_SRC_PATH = "${rustToolchain}/lib/rustlib/src/rust/library";
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
            # `just dev db-up` / db-backed tests. An explicit DATABASE_URL (CI,
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
    };
}
