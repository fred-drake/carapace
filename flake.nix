{
  description = "Carapace - Security-first, plugin-driven personal AI agent framework";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        # -------------------------------------------------------------------
        # packages.default — deployable host binary
        # -------------------------------------------------------------------
        #
        # Build with: nix build
        # Run with:   ./result/bin/carapace
        #
        # Produces compiled JS + production node_modules + wrapper script.
        # Uses fetchPnpmDeps for reproducible offline dependency
        # resolution within the Nix sandbox.
        #
        # To update the pnpmDeps hash after lockfile changes:
        #   1. Set hash to pkgs.lib.fakeHash
        #   2. Run: nix build 2>&1 | grep 'got:'
        #   3. Replace the hash with the value from step 2
        #
        packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "carapace";
          version = "0.0.1";

          src = pkgs.lib.cleanSource self;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            hash = pkgs.lib.fakeHash;
            fetcherVersion = 3;
          };

          nativeBuildInputs = with pkgs; [
            nodejs_22
            pnpm_10
            pnpmConfigHook
            makeWrapper
          ];

          buildPhase = ''
            runHook preBuild
            pnpm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            # Copy compiled output and package manifest
            mkdir -p $out/lib/carapace
            cp -r dist $out/lib/carapace/
            cp package.json $out/lib/carapace/

            # Copy production node_modules (pnpm virtual store)
            cp -r node_modules $out/lib/carapace/

            # Create executable wrapper
            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/carapace \
              --add-flags "$out/lib/carapace/dist/index.js"

            runHook postInstall
          '';
        });

        # -------------------------------------------------------------------
        # devShells.default — development environment
        # -------------------------------------------------------------------
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Runtime
            nodejs_22

            # Package management
            nodePackages.pnpm

            # TypeScript tooling
            nodePackages.typescript
            nodePackages.typescript-language-server

            # Container runtime
            docker
            docker-compose

            # Messaging / IPC
            zeromq

            # Database
            sqlite

            # Linting / formatting
            nodePackages.prettier
            oxlint

            # Utilities
            jq
            curl

            # Github
            gh
          ];

          shellHook = ''
            echo "🐚 Carapace dev shell loaded"
            echo "   Node.js: $(node --version)"
            echo "   pnpm:    $(pnpm --version)"
          '';
        };
      });
}
