# Carapace Installation Strategy

> Team consensus from architect, devops, security, and DX advocate (2026-02-19).
> Covers installation paths, container runtime abstraction, security model, and UX.

---

## 1. Two Installation Paths

### Path A: Nix Flake (Declarative)

- **Target audience**: Nix users
- `nix profile install github:fred-drake/carapace` or add as flake input
- Everything pinned, reproducible, builds from source
- Flake outputs (initial release):
  - `packages.${system}.default` — host-side binary (built via `buildNpmPackage`
    with `pnpmConfigHook`)
  - `packages.${system}.container-image` — OCI image (built via
    `dockerTools.buildLayeredImage`)
  - `overlays.default` — for composing into user's nixpkgs
  - `devShells.default` — existing dev shell (unchanged)
- Future (P2): `nixosModules.default` and `darwinModules.default` for
  `services.carapace.enable = true` — requires daemon support first (depends on
  DX-02, DEVOPS-03)

### Path B: Install Script (Interactive)

- **Target audience**: everyone without Nix
- POSIX `#!/bin/sh` script — no bashisms, runs everywhere
- Distributed at `scripts/install.sh` in the repo, served from GitHub releases
- Downloads pre-built release tarballs (platform-specific: macOS arm64/x86_64,
  Linux x86_64/arm64)
- Tarballs contain: compiled JS (`dist/`), production `node_modules/` with
  pre-built native addons, `carapace` wrapper script
- Install-time container image pull from GHCR, with first-run fallback if pull
  fails

---

## 2. Install Location

**`~/.carapace/` with `$CARAPACE_HOME` override** (rustup/volta pattern)

```
~/.carapace/                    # or $CARAPACE_HOME
├── bin/carapace                # CLI wrapper (symlinked to PATH)
├── lib/
│   ├── dist/                   # compiled host-side JS
│   ├── node_modules/           # production deps
│   └── plugins/                # built-in plugins (read-only)
├── plugins/                    # user plugins (mutable)
├── data/
│   ├── audit/                  # audit logs
│   └── memory/                 # per-group SQLite databases
├── credentials/                # plugin credentials (dir: 0700, files: 0600)
├── run/                        # runtime state
│   └── sockets/                # ZeroMQ Unix domain sockets
├── config.toml                 # user configuration
└── version                     # installed version marker
```

- For Nix: read-only parts in Nix store, mutable state at `$CARAPACE_HOME`
- `$CARAPACE_HOME` allows XDG-style organization for power users who want it
- Single directory makes uninstall trivial: `rm -rf ~/.carapace`

---

## 3. Container Runtime Abstraction

**`ContainerRuntime` interface with three adapters**, located at
`src/core/container/`:

```
src/core/container/
├── runtime.ts              # Interface + types
├── docker-runtime.ts       # Docker adapter
├── podman-runtime.ts       # Podman adapter
├── apple-runtime.ts        # Apple Container adapter
├── detect.ts               # Auto-detection logic
└── index.ts                # Re-exports
```

### Interface

```typescript
interface ContainerRuntime {
  name: 'docker' | 'podman' | 'apple-container';

  // Availability
  isAvailable(): Promise<boolean>;
  version(): Promise<string>;

  // Image lifecycle
  pull(image: string): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  loadImage(source: string): Promise<void>; // for nix-built tarballs

  // Container lifecycle
  run(options: ContainerRunOptions): Promise<ContainerHandle>;
  stop(handle: ContainerHandle, timeout?: number): Promise<void>;
  kill(handle: ContainerHandle): Promise<void>;
  remove(handle: ContainerHandle): Promise<void>;
  inspect(handle: ContainerHandle): Promise<ContainerState>;
}

interface ContainerRunOptions {
  image: string;
  name?: string;
  readOnly: boolean;
  networkDisabled: boolean;
  volumes: VolumeMount[];
  socketMounts: SocketMount[]; // first-class for Apple Container vsock
  env: Record<string, string>;
  user?: string;
  entrypoint?: string[];
}
```

### Adapter Differences

- **Podman**: `:Z` suffix on bind mounts (SELinux), `--userns=keep-id` for
  rootless
- **Apple Containers**: `--publish-socket` for Unix sockets (vsock, bypasses
  network stack — superior to Docker's bind mount approach), read-only filesystem
  is the default
- **Docker**: reference implementation, most compatible

---

## 4. Container Runtime Preference Order

**Auto-detection priority** (security posture ordering):

1. **User-configured preference** (from `config.toml`) — always wins
2. **Apple Containers** (macOS 26+ with Apple Silicon) — VM-per-container
   isolation, matches our architecture doc's "VM-based isolation, not just
   namespaces"
3. **Podman** — rootless by default, no root daemon
4. **Docker** — widest compatibility, fallback

### UX Approach

- When only one runtime is found: auto-select, no questions asked
- When multiple are found: show recommendation with brief explanation, default to
  most secure
- When none found: guide user to install one with platform-specific instructions
- **Never nag or block** a user who has only Docker — it works fine, it's just not
  the strongest isolation
- Store selection in `config.toml` so user is never asked again

```
  Found multiple container runtimes:
    1) Apple Containers (recommended — VM-level isolation)
    2) Docker Desktop 4.38.0

  Which should Carapace use? [1]
```

---

## 5. Install Script Flow

### Security Model

Docs lead with **two-step download-verify-run** as the default:

```bash
curl -fsSL -o install.sh https://get.carapace.dev/install.sh
curl -fsSL -o install.sh.sha256 https://get.carapace.dev/install.sh.sha256
sha256sum -c install.sh.sha256
bash install.sh
```

**One-liner still supported** for convenience:
`curl -fsSL https://get.carapace.dev | sh`

Script behavior:

- Detects piped execution (`[ -t 0 ]`), switches to non-interactive mode when
  piped
- Never silently `sudo`
- Supports `--dry-run`, `--yes`, `--no-modify-path`,
  `--runtime docker|podman|apple`, `--version v1.2.3`

### Interactive Flow

```
  ╭──────────────────────────────────────╮
  │  Carapace Installer v1.0.0          │
  │  Security-first AI agent framework  │
  ╰──────────────────────────────────────╯

  Detecting system...
  ✓ Platform: macOS 15.3 (arm64)
  ✓ Node.js 22.14.0

  Checking container runtime...
  ✓ Docker Desktop 4.38.0 (auto-detected)

  Installing Carapace...
  ✓ Downloaded carapace-v1.0.0-darwin-arm64.tar.gz
  ✓ Verified checksum
  ✓ Extracted to ~/.carapace/
  ✓ Added to PATH

  Pulling container image...
  ✓ carapace/agent:v1.0.0 (142 MB)
  ✓ Image signature verified (cosign)

  ✓ Carapace v1.0.0 installed!

  Next steps:
    $ carapace doctor    # verify setup
    $ carapace start     # launch
```

### Error Handling

Every missing prerequisite shows what's missing, how to fix it (exact command),
and what to do after fixing (re-run installer).

---

## 6. Security Requirements

### P0 (must ship with installer)

- SHA-256 checksums on all release artifacts
- Container image cosign signing (keyless via GitHub Actions / Sigstore)
- Container image digest pinning in config (`image@sha256:...`, not just tag)
- Zero-sudo installation
- Install-time security checks (permissions, image signature, basic container
  test)
- Two-step download-verify-run as documented default

### P1

- GPG-signed releases
- SBOM published with each release
- Post-install permission verification in `carapace doctor`
- `carapace doctor` surfaces isolation level (VM vs namespace)

### P2

- Reproducible builds verification
- OS keychain integration for credentials
- NixOS/darwin service modules

---

## 7. First-Run Experience

**Built-in "hello" intrinsic tools** — registered like core intrinsic tools
(alongside `get_diagnostics`, `list_tools`, `get_session_info`), not as a plugin
directory entry:

- `hello.greet` — returns a greeting (basic tool invocation)
- `hello.echo` — echoes back arguments (argument passing)
- `hello.time` — returns current time (host-side computation)

Persists until explicitly disabled via `carapace config set hello.enabled false`.
`carapace doctor` shows a gentle hint when real plugins are also loaded.

---

## 8. Config Format

**TOML** — supports comments (critical for user-edited config), used by
Cargo/Poetry, clean syntax.

```toml
# Carapace configuration

[runtime]
engine = "docker"  # "docker", "podman", or "apple-container"
image = "ghcr.io/fred-drake/carapace-agent@sha256:abc123..."

[plugins]
dirs = ["~/.carapace/plugins"]

[security]
max_sessions_per_group = 3
```

---

## 9. Update Mechanism

- **Nix**: `nix flake update` — no custom mechanism needed
- **Script install**: `carapace update`
  - Checks GitHub Releases API
  - Downloads and verifies new host artifacts (SHA-256)
  - Pulls matching container image (prevents version skew)
  - Runs `carapace doctor` to verify
  - No phone-home on startup — update check is explicit only

---

## 10. Distribution Channels

| Channel         | Artifact                                        | Audience             |
| --------------- | ----------------------------------------------- | -------------------- |
| Nix flake       | `packages.default` + `packages.container-image` | Nix users            |
| GitHub Releases | Platform-specific tarballs + install script     | Script install users |
| GHCR            | `ghcr.io/fred-drake/carapace-agent:v{version}`  | Container image      |
| Homebrew        | `brew install carapace` (future, post-1.0)      | macOS                |

---

## 11. Plugin Directory Design

Two-directory approach:

1. **Built-in plugins** (`$CARAPACE_HOME/lib/plugins/`) — read-only, shipped with
   Carapace
2. **User plugins** (`$CARAPACE_HOME/plugins/`) — mutable, user-managed

`carapace plugin create` scaffolds into user directory. User plugins override
built-in plugins of the same name. `carapace plugin list` labels each as
`(built-in)` or `(user)`.

---

## 12. README Structure

Split current README:

- **README.md** — user-focused: what Carapace is, quick start (both install
  paths), link to docs
- **CONTRIBUTING.md** — developer-focused: dev environment setup, build commands,
  TDD discipline, PR workflow

---

## Implementation Priority

### Existing Tasks Affected

- **DEVOPS-03** (container lifecycle manager) — now needs `ContainerRuntime`
  interface
- **DEVOPS-05** (`carapace doctor`) — should be promoted to P1
- **DEVOPS-09** (Nix build output) — expanded to include container image output
- **DX-02** (CLI entry point) — needs `update`, `doctor`, `uninstall`
  subcommands

### New Tasks Needed

- Container runtime adapter implementations (Docker, Podman, Apple Containers)
- Install script (`scripts/install.sh`)
- Release pipeline (GitHub Actions: build matrix, cosign signing, GHCR push)
- Config system (TOML parsing, `$CARAPACE_HOME` resolution)
- Built-in "hello" intrinsic tools
