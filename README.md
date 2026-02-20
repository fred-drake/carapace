# Carapace

A personal AI agent that runs inside a locked-down container and never touches
your credentials.

## Why this exists

AI agents are useful. Giving one access to your email, calendar, and messaging
apps is terrifying. Most agent frameworks ask you to hand over API keys and let
the agent call external services on its own. If something goes wrong -- prompt
injection, a bug, a leaked context -- the agent has direct access to your
accounts and there's nothing in between.

Carapace doesn't work that way. The agent can't reach the internet. It can't
read your filesystem. It never sees an API key. The only thing it can do is
send a structured message through a Unix socket and wait for a response.
Everything sensitive happens on the other side of that socket, where code you
control holds the credentials and talks to external services.

## How it works

The system has two sides separated by a hard trust boundary.

The agent (Claude Code) runs in a container with a read-only filesystem, no
network access, and exactly one communication channel: a small binary called
`ipc`. When the agent needs to send a message or check your calendar, it calls
`ipc` with a topic and arguments. It can't construct HTTP requests or read
environment variables. That's the entire surface area.

On the host side, a core router receives those messages over a ZeroMQ Unix
socket. It never trusts what the container says about itself. Instead, it
constructs a full identity envelope from its own session state -- who this
container is, what group it belongs to, when the session started. Then it
validates the payload, checks authorization, and routes the request to the
right plugin. Plugins hold the credentials and call external APIs. Before the
response goes back to the container, a sanitization layer strips anything that
looks like a credential pattern.

```
Container (locked down)          Host (trusted)
+----------------------+         +-----------------------------+
|  Claude Code         |         |  Core Router                |
|  + skill files       |  ZeroMQ |  +- 6-stage validation      |
|  + ipc binary -------+---------+  +- Envelope construction   |
|                      |  Unix   |  +- Response sanitization   |
|  No network          |  socket |  |                          |
|  No credentials      |         |  Plugins                    |
|  Read-only FS        |         |  +- Telegram (holds API key)|
+----------------------+         |  +- Email (holds OAuth)     |
                                 |  +- Calendar                |
                                 |  +- Memory (SQLite + FTS5)  |
                                 +-----------------------------+
```

The validation pipeline has six stages: envelope construction, topic
validation, payload validation, authorization, user confirmation (for
high-risk tools), and routing. If any stage fails, the agent gets a
structured error code. It never gets raw stack traces or internal details.

## Plugins

Every plugin is a pair: a host-side handler written in TypeScript that holds
credentials and calls APIs, and a container-side skill file (markdown) that
teaches the agent what tools exist and how to call them.

```
plugins/memory/
  manifest.json         # declares tools, schemas, risk levels
  handler.ts            # host-side logic with credential access
  skills/memory.md      # teaches the agent about memory tools
```

Drop a folder in `plugins/` and it gets discovered at startup. No registry, no
marketplace. Each tool in the manifest has a risk level. Low-risk tools execute
immediately. High-risk tools pause and ask the user before running. All tool
schemas require `additionalProperties: false`, so the agent can't slip in
unexpected fields.

## Installation

### From source (current)

No releases are published yet. Clone the repo, build, and run directly:

```bash
git clone https://github.com/fred-drake/carapace.git
cd carapace
direnv allow          # or: nix develop
pnpm install
pnpm run build
node dist/main.js doctor
```

This gives you the `main.js` entry point at `dist/main.js`. Run any
subcommand with `node dist/main.js <command>`.

### Nix build

If you use [Nix](https://nixos.org/) with flakes enabled, you can build a
self-contained package with a `carapace` wrapper script:

```bash
nix build            # from a local checkout
./result/bin/carapace doctor
```

Or build and install directly from GitHub:

```bash
nix profile install github:fred-drake/carapace
carapace doctor
```

### Install script (not yet available)

Once releases are published, the install script will download a release
tarball, verify the SHA-256 checksum, pull the container image, and verify
its cosign signature:

```bash
curl -fsSL https://get.carapace.dev | sh
```

The install script detects your platform (`darwin`/`linux`) and architecture
(`arm64`/`x64`), downloads the matching release artifact, and installs to
`$CARAPACE_HOME` (defaults to `~/.carapace/`).

**Requirements**: `curl` or `wget`, `tar`, `sha256sum` or `shasum`, and a
container runtime (`docker`, `podman`, or Apple Containers on macOS 26+).

## Quick start

The examples below use `carapace` as the command. If you installed from
source, substitute `node dist/main.js`; if you used `nix build`, use
`./result/bin/carapace`.

```bash
# Check that all dependencies are satisfied
carapace doctor

# Start the system (init container, detect runtime, begin session)
carapace start

# Check running status
carapace status

# Graceful shutdown
carapace stop
```

### Configuration

Configuration lives at `$CARAPACE_HOME/config.toml`. View and modify it with
the built-in config subcommand:

```bash
# Show current configuration
carapace config show

# Get a specific value
carapace config get runtime.engine

# Set a value
carapace config set runtime.engine docker
```

### Updating

Check for and install updates explicitly. Carapace never phones home on
startup.

```bash
# Check for available updates
carapace update --check

# Download, verify, and install the latest release
carapace update

# Skip the confirmation prompt
carapace update --yes
```

Updates verify SHA-256 checksums on the host artifact, pull and pin the
matching container image digest, and run `carapace doctor` post-update.
If any verification fails, the current install is left intact.

### Managing credentials

```bash
# Set an API key for a plugin
carapace auth api-key --plugin telegram --key "..."

# Interactive login flow for OAuth plugins
carapace auth login --plugin email

# Check credential status across plugins
carapace auth status
```

Credentials are stored on the host only. The container never sees them.

### Uninstalling

```bash
carapace uninstall
```

This removes the installation at `$CARAPACE_HOME` after confirmation.
Pass `--yes` to skip the prompt.

## Security model

Carapace's security is architectural, not application-level:

- **Container isolation** -- The agent runs in a VM-based container with no
  network, read-only filesystem, and no access to host credentials.
- **Identity construction** -- The host constructs message identity from its
  own session state. The container can't claim to be someone else.
- **Schema enforcement** -- All tool argument schemas require
  `additionalProperties: false`. The agent can't inject unexpected fields.
- **Digest pinning** -- Container images are referenced by sha256 digest, not
  mutable tags. Digests are verified on every pull.
- **Artifact verification** -- Release tarballs are verified against SHA-256
  checksums. Container images are verified via cosign signatures.
- **Response sanitization** -- Credential patterns are stripped from responses
  before they reach the container.
- **Memory provenance** -- Memories written during sessions are tagged as
  untrusted. Behavioral entries are flagged for user verification on new
  sessions.

## Project status

Active development. Foundation (P0), core functionality (P1), and most
feature/hardening tasks (P2) are complete. End-to-end plumbing (Phase E2E)
is validated — the full pipeline from host server through container to echo
plugin round-trip works. See [docs/TASKS.md](docs/TASKS.md) for the full
breakdown.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- System design, messaging
  protocol, security model, error codes
- [docs/PLUGIN_AUTHORING.md](docs/PLUGIN_AUTHORING.md) -- Complete guide to
  building plugins
- [docs/MEMORY_DRAFT.md](docs/MEMORY_DRAFT.md) -- Memory plugin design, FTS5
  search, provenance tracking
- [docs/FUTURE_FEATURES.md](docs/FUTURE_FEATURES.md) -- Roadmap with tiered
  priorities
- [docs/TASKS.md](docs/TASKS.md) -- Development task list
- [CONTRIBUTING.md](CONTRIBUTING.md) -- Developer setup, build commands, PR
  workflow

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands,
testing guidelines, and the PR workflow.
