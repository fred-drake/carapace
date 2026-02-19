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
