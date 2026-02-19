# Install-Path Threat Model

> Last Updated: 2026-02-19 | Version: 1.0
> Author: Architect role (SEC-21)
> Related: INSTALL_STRATEGY.md, ARCHITECTURE.md

This document analyzes the security properties and threat surface of both
Carapace installation paths, the supply chain trust assumptions, and the
runtime security model for each supported container runtime.

---

## 1. Attack Surface Analysis

### Path A: Nix Flake (Declarative)

**Trust chain**: GitHub → Nix evaluator → local Nix store

| Surface              | Description                                                                               | Mitigation                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Flake input fetch    | `nix profile install github:fred-drake/carapace` fetches the flake from GitHub over HTTPS | TLS certificate validation by Nix; pinned to specific commit via `flake.lock`                               |
| Source build         | `buildNpmPackage` builds from source using `pnpmConfigHook`                               | Deterministic build; no pre-built binaries; `pnpm-lock.yaml` pins every dependency hash                     |
| Container image      | `dockerTools.buildLayeredImage` builds OCI image from Nix derivations                     | No Docker daemon involved; layers are content-addressed Nix store paths                                     |
| Nix binary cache     | If using `cache.nixos.org` or Cachix, pre-built derivations are fetched                   | Nix verifies NAR signatures against trusted public keys; untrusted caches produce store-path mismatches     |
| flake.lock poisoning | Attacker modifies `flake.lock` to point to malicious commit                               | Users pin to a specific rev or verify the lock diff in PRs; `--no-update-lock-file` prevents silent updates |

**Residual risk**: Nix evaluator vulnerabilities. Nix evaluates arbitrary
Nix expressions from the flake. A vulnerability in the Nix evaluator itself
could allow code execution during evaluation (before the build sandbox).
This is a shared risk across the entire Nix ecosystem, not specific to
Carapace.

**Strength**: This path has the **strongest security properties** of any
install method. Every input is content-addressed, builds are sandboxed, and
the output is reproducible. No pre-built binaries are downloaded — everything
is compiled from source in a hermetic environment.

### Path B: Install Script (Interactive)

**Trust chain**: GitHub Releases → HTTPS → SHA-256 → local filesystem

| Surface              | Description                                            | Mitigation                                                                                                                        |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Script download      | `curl \| sh` pattern trusts GitHub's HTTPS + CDN       | Two-step download-verify-run documented as default; script served from GitHub Releases with SHA-256 checksum file                 |
| Tarball download     | Pre-built binaries from GitHub Releases                | SHA-256 checksum verification (fail-closed); checksums generated in the same CI workflow that builds the tarballs                 |
| Container image pull | OCI image from GHCR                                    | Cosign keyless signature verification; digest pinned in config after install                                                      |
| Script integrity     | The install script itself could be tampered with       | SHA-256 checksum file published alongside; two-step install documented as recommended path                                        |
| Piped execution      | `curl \| sh` cannot verify the script before execution | Script detects piped mode (`[ -t 0 ]`), prints notice recommending two-step install, runs in non-interactive mode                 |
| Transient state      | Partial install during extraction                      | Transactional install: extract to `.installing/` staging dir, verify, atomic `mv` to final location; `trap` cleanup on any signal |

**Residual risks**:

1. **curl | sh TOCTOU**: Between downloading and executing, a CDN
   compromise could serve different content to the checksum fetch vs the
   script fetch. Mitigation: both files served from the same GitHub Release
   asset, and the recommended path downloads both then verifies locally.

2. **Pre-built binary trust**: Users trust that the CI pipeline produced
   the binaries honestly. Mitigation: GitHub Actions workflow is public,
   all actions pinned to commit SHA, build logs are public. Future (P2):
   reproducible build verification.

3. **npm dependency supply chain**: The tarball includes `node_modules/`
   with pre-built native addons (zeromq, better-sqlite3). A compromised
   npm package could inject malicious code. Mitigation: `pnpm audit` in
   CI, `pnpm-lock.yaml` pins exact versions and integrity hashes,
   `--frozen-lockfile` prevents lock modification during build.

---

## 2. Supply Chain Trust Assumptions

### 2.1 npm Registry (npmjs.com)

| Assumption                                                    | Risk                                               | Mitigation                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Registry serves packages matching published integrity hashes  | Registry compromise or account takeover            | `pnpm-lock.yaml` pins integrity hashes (SHA-512); `--frozen-lockfile` in CI; `pnpm audit` blocks high/critical CVEs |
| Package maintainers don't publish malicious updates           | Typosquatting, maintainer account compromise       | Minimal dependency tree; `pnpm audit` in CI; Socket.dev integration for supply chain risk analysis                  |
| Native addon pre-builds (zeromq, better-sqlite3) match source | Pre-built `.node` binaries could contain backdoors | prebuildify checksums verified by npm install; packages built in CI from source when possible                       |

**Accepted trade-off**: We ship pre-built `node_modules/` in release
tarballs for fast install. This means users trust the CI build environment
(GitHub Actions runners) to produce honest native addons. The alternative
— requiring users to compile from source — would need a full C/C++ toolchain
and significantly increase install friction.

### 2.2 GitHub Releases

| Assumption                                     | Risk                                          | Mitigation                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GitHub serves the correct release assets       | GitHub infrastructure compromise              | SHA-256 checksums generated in the same workflow; cosign signing provides a second verification path independent of GitHub       |
| Release workflow runs in a trusted environment | GitHub Actions runner compromise              | Actions pinned to commit SHA (not tags); minimal permissions (least-privilege `permissions:` block); no self-hosted runners      |
| Tag signing identifies the correct commit      | Tag can be force-pushed to a different commit | Tags trigger the release workflow; the workflow builds from the tagged commit; cosign signature covers the specific image digest |

### 2.3 GHCR (GitHub Container Registry)

| Assumption                                          | Risk                                               | Mitigation                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GHCR serves the image matching the requested digest | Registry compromise                                | Image digest pinning (`image@sha256:...`) in `config.toml`; digest verified on every pull                                                |
| Image layers haven't been tampered with             | Layer injection                                    | OCI content-addressable storage ensures layers match their digest; cosign signature covers the manifest digest                           |
| Image tags point to the correct manifest            | Tag mutation (re-push different image to same tag) | Digest pinning makes tags irrelevant after initial install; `carapace update` re-verifies cosign signature before updating pinned digest |

### 2.4 Sigstore / Cosign

| Assumption                                                  | Risk                                              | Mitigation                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sigstore transparency log (Rekor) is append-only and honest | Rekor compromise could allow backdated signatures | Sigstore is operated by the Linux Foundation with multiple witnesses; SCT (Signed Certificate Timestamp) provides cryptographic proof of log inclusion |
| GitHub Actions OIDC identity is unforgeable                 | OIDC token forgery                                | GitHub's OIDC provider is integrated with Sigstore's Fulcio CA; certificate binds to specific repo, workflow, and commit                               |
| Cosign verification correctly validates the signature chain | Cosign implementation bug                         | Cosign is widely audited; we verify `--certificate-oidc-issuer` and `--certificate-identity-regexp` to prevent cross-repo signature reuse              |

**Accepted trade-off**: Keyless signing means there is no long-lived
signing key to protect, but it also means we rely on Sigstore
infrastructure being available at verification time. If Sigstore is down,
cosign verification fails. The install script warns but continues if
cosign is not installed — this is a pragmatic choice to avoid blocking
installation when the user hasn't installed cosign. `carapace doctor`
reports cosign verification status post-install.

---

## 3. MITM Scenarios and Mitigations

### 3.1 Network-Level MITM

| Scenario                               | Attack                                                    | Mitigation                                                                                                         |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| DNS poisoning redirects `github.com`   | Attacker serves fake release assets                       | TLS certificate validation by curl (default); HSTS on github.com prevents downgrade                                |
| Corporate proxy intercepts HTTPS       | Proxy re-encrypts with corporate CA; could modify content | SHA-256 checksum verification is performed locally after download; checksum file and tarball downloaded separately |
| BGP hijack redirects GitHub's IP range | Traffic routed through attacker's network                 | TLS certificate validation; Certificate Transparency logs make rogue certificates detectable                       |
| Rogue WiFi / ARP spoofing              | Local network attacker intercepts traffic                 | TLS + certificate pinning by the OS; install script uses HTTPS exclusively (no `http://` URLs)                     |

### 3.2 Application-Level MITM

| Scenario                          | Attack                                              | Mitigation                                                                                                       |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Compromised GitHub Actions runner | Attacker modifies build output                      | Actions pinned to commit SHA; workflow is public and auditable; cosign signature binds to specific OIDC identity |
| Compromised CDN cache             | CDN serves stale or modified assets                 | SHA-256 checksum + cosign signature provide two independent verification paths                                   |
| DNS rebinding during install      | Script resolves hostname to attacker IP mid-install | Each curl call is independent; checksum verification catches any content modification                            |

### 3.3 Install Script-Specific MITM

| Scenario                         | Attack                                                     | Mitigation                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Partial download in `curl \| sh` | Connection drops mid-script; shell executes partial script | `set -eu` causes immediate exit on any error; functions aren't called until `main` at end of script                               |
| Modified script in `curl \| sh`  | Attacker modifies script in transit                        | TLS protects transport; two-step download-verify documented as recommended method; `curl \| sh` shows non-interactive mode notice |

**Proxy support**: The install script respects `$HTTPS_PROXY` and
`$HTTP_PROXY` environment variables, passing them through to both curl
(for tarball downloads) and the container runtime (for image pulls). Proxy
configuration is the user's responsibility — Carapace does not attempt to
detect or configure proxies automatically.

---

## 4. Credential Storage Threat Model

### 4.1 Directory Structure

```
~/.carapace/credentials/     # dir: 0700 (owner-only)
├── telegram.json             # file: 0600 (owner-only)
├── gmail-oauth.json          # file: 0600
└── anthropic.json            # file: 0600
```

### 4.2 Threat Matrix

| Threat                                   | Vector                                                                    | Mitigation                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Other local users read credentials       | Multi-user system; default umask allows group/world read                  | `install -d -m 0700` for directory creation (atomic, no TOCTOU); `umask 077` set before any file operations in install script                                  |
| Malicious process reads credential files | Process running as same user                                              | OS-level: credentials are as protected as any user file; Carapace: credentials never enter the container (host-side only)                                      |
| Container escape reads credentials       | VM/namespace escape from container runtime                                | Credentials are not mounted into the container; even with host access, credential directory is 0700; defense-in-depth only                                     |
| Credential leakage in logs               | Plugin accidentally logs API key in error message                         | Response sanitizer strips common credential patterns (Bearer tokens, API keys, AWS keys); audit log redacts matched patterns                                   |
| Credential leakage via docker inspect    | Credentials passed as env vars visible in process table                   | Credential injection via stdin protocol; entrypoint reads from stdin then closes it (`exec < /dev/null`); never appears in `docker inspect`                    |
| Symlink attack on credential directory   | Attacker creates symlink at `~/.carapace/credentials/` pointing elsewhere | Credential directory security module validates no symlinks in the path; `lstat` used instead of `stat` to detect symlinks                                      |
| Backup tools expose credentials          | Time Machine, rsync, cloud sync copies credential files                   | Accepted trade-off: users are responsible for excluding `~/.carapace/credentials/` from backups; documented in security guide                                  |
| Memory dump reveals credentials          | Credential values in process memory                                       | Accepted trade-off: credentials exist in host process memory while plugins are active; OS-level memory protection applies; container cannot access host memory |

### 4.3 Credential Lifecycle

```
Install-time:
  1. install -d -m 0700 ~/.carapace/credentials/
  2. No credentials written (user configures post-install)

Runtime:
  1. Plugin handler reads credential from disk (0600 file)
  2. Credential injected into container via stdin protocol
  3. Container entrypoint exports as env var
  4. stdin closed immediately (exec < /dev/null)
  5. Credential exists only in container's process memory
  6. Container termination destroys the memory

Never exposed via:
  - docker inspect (not passed as -e flag)
  - Dockerfile or image layers
  - Mounted files or volumes
  - Process arguments (not in /proc/PID/cmdline)
  - ZeroMQ messages (wire format has no credential fields)
```

---

## 5. Container Runtime Security Comparison

### 5.1 Feature Matrix

| Feature               | Docker (macOS)               | Docker (Linux)        | Podman (Linux)           | Apple Containers (macOS)    |
| --------------------- | ---------------------------- | --------------------- | ------------------------ | --------------------------- |
| **Isolation model**   | LinuxKit VM + namespaces     | Namespaces only       | Namespaces (rootless)    | VM per container            |
| **Root daemon**       | Yes (Docker Desktop)         | Yes (dockerd)         | No (rootless)            | No                          |
| **Read-only FS**      | `--read-only` flag           | `--read-only` flag    | `--read-only` flag       | Default (no flag needed)    |
| **Network isolation** | `--network none`             | `--network none`      | `--network none`         | `--network none`            |
| **Socket sharing**    | Bind mount (`-v`)            | Bind mount (`-v`)     | Bind mount (`-v` + `:Z`) | vsock (`--publish-socket`)  |
| **SELinux support**   | N/A                          | Optional              | `:Z` relabeling          | N/A                         |
| **User namespace**    | Default                      | Optional              | `--userns=keep-id`       | Default (VM boundary)       |
| **Escape difficulty** | VM escape + namespace escape | Namespace escape only | Namespace escape only    | VM escape (hardware-backed) |
| **Image format**      | OCI                          | OCI                   | OCI                      | OCI                         |

### 5.2 Isolation Level Ranking

```
Strongest ─────────────────────────────────────────── Weakest

  Apple Containers    Docker (macOS)    Podman (Linux)    Docker (Linux)
  ┌─────────────┐    ┌─────────────┐   ┌─────────────┐   ┌────────────┐
  │ Dedicated VM │    │ LinuxKit VM │   │  Rootless    │   │ Root daemon│
  │ per container│    │ shared among│   │  namespaces  │   │ namespaces │
  │ (Apple VF)  │    │ containers  │   │  (no root)   │   │ (root req) │
  └─────────────┘    └─────────────┘   └─────────────┘   └────────────┘
  Hardware virt.      Hardware virt.     Kernel only       Kernel only
  Per-container VM    Shared VM          No daemon         Root daemon
```

### 5.3 Runtime-Specific Threats

#### Docker (macOS)

| Threat                       | Risk Level | Detail                                                                        |
| ---------------------------- | ---------- | ----------------------------------------------------------------------------- |
| Docker Desktop vulnerability | Medium     | Single LinuxKit VM shared by all containers; VM escape affects all containers |
| Docker daemon compromise     | Medium     | Root daemon; compromise gives access to all containers and host Docker socket |
| Container-to-container       | Low        | Shared VM kernel; namespace isolation within the VM                           |

#### Docker (Linux)

| Threat           | Risk Level | Detail                                                                             |
| ---------------- | ---------- | ---------------------------------------------------------------------------------- |
| Namespace escape | Medium     | No VM boundary; kernel vulnerability in namespace implementation gives host access |
| Root daemon      | High       | `dockerd` runs as root; Docker socket access = root access                         |
| Kernel exploit   | Medium     | Shared kernel between host and container; container runs on same kernel            |

#### Podman (Linux)

| Threat               | Risk Level | Detail                                                                               |
| -------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Namespace escape     | Medium     | Same kernel risk as Docker Linux, but no root daemon reduces blast radius            |
| Rootless limitations | Low        | Some operations require workarounds; `--userns=keep-id` maps UID correctly           |
| SELinux bypass       | Low        | `:Z` relabeling is required for bind mounts; misconfigured labels could allow access |

#### Apple Containers (macOS 26+)

| Threat                   | Risk Level | Detail                                                                                    |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------- |
| VM escape                | Very Low   | Apple Virtualization Framework; hardware-backed; each container is a separate VM          |
| Hypervisor vulnerability | Very Low   | Apple's hypervisor is part of macOS; attack surface is small and well-audited             |
| vsock security           | Low        | Virtual socket bypasses network stack entirely; no IP-level attacks possible              |
| Experimental status      | Medium     | New runtime (macOS 26+); API surface may change; fewer security audits than Docker/Podman |

### 5.4 Carapace Runtime Preference Order (Security Rationale)

1. **User-configured** — Always wins; user takes responsibility
2. **Apple Containers** — VM-per-container matches our architecture
   doc's security model ("VM-based isolation, not just namespaces")
3. **Podman** — Rootless by default; no root daemon attack surface
4. **Docker** — Widest compatibility; adequate security with `--read-only`
   and `--network none`

---

## 6. Residual Risks and Accepted Trade-offs

### 6.1 Accepted Risks

| Risk                                   | Severity | Rationale                                                                                                                     |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| npm supply chain compromise            | Medium   | Mitigated by lockfile pinning, audit, and Socket.dev; eliminating npm would require rewriting in Go/Rust                      |
| Pre-built binaries in tarballs         | Medium   | Required for practical install UX; mitigated by SHA-256 checksums and public CI; P2: reproducible builds                      |
| `curl \| sh` install path              | Low      | Convenience pattern widely used; documented as non-recommended; script detects piped mode and warns                           |
| Cosign not required for install        | Low      | Not all users have cosign installed; blocking install on missing cosign would harm adoption; `carapace doctor` reports status |
| Credential files readable by same user | Low      | Fundamental OS limitation; Carapace applies 0700/0600 permissions; keychain integration is P2                                 |
| Backup tools may capture credentials   | Low      | User responsibility; documented; keychain integration (P2) would eliminate file-based credentials                             |

### 6.2 Residual Risks Requiring Future Work

| Risk                               | Priority      | Planned Mitigation                                                                            |
| ---------------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| No GPG signing on releases         | P1            | Add GPG signatures alongside cosign; provides offline verification                            |
| No reproducible build verification | P2            | Nix path is already reproducible; script path needs `rebuilderd`-style verification           |
| No OS keychain integration         | P2            | Move credentials from files to macOS Keychain / Linux Secret Service API                      |
| Docker Linux has weakest isolation | Informational | Documented; `carapace doctor` reports isolation level; Apple Containers or Podman recommended |
| Node.js runtime vulnerabilities    | Medium        | Node.js 22 (LTS); auto-update via `carapace update`; Nix path pins exact Node version         |

### 6.3 Security Invariants (Must Never Be Violated)

1. **Checksums are fail-closed**: SHA-256 mismatch always aborts;
   no `--skip-verify` flag exists or will be added
2. **Credentials never enter the container**: Not via env vars at spawn,
   not via mounted files, not via CLI arguments
3. **Container filesystem is read-only**: Enforced by runtime flag
   (Docker/Podman) or default (Apple Containers)
4. **No network access from container**: `--network none` on all runtimes
5. **No sudo in install script**: The installer never escalates privileges
6. **Wire format cannot carry identity**: Container sends only `topic`,
   `correlation`, `arguments`; core constructs identity from session state
7. **All CI actions pinned to commit SHA**: No tag-based action references
   in any workflow

---

## 7. Verification Checklist

Post-install verification (`carapace doctor` output):

```
  PASS  Node.js: v22.22.0
  PASS  Container runtime: Apple Containers (VM isolation)
  PASS  Container image: digest matches config
  PASS  Cosign signature: verified
  PASS  Credential directory: 0700 permissions
  PASS  Socket directory: 0700 permissions
  PASS  Read-only filesystem: enforced
  PASS  Network isolation: enforced
```

Each check maps to a threat in this document. A failing check indicates
a security property is not holding and should be investigated before use.
