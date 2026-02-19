# Carapace

A personal AI agent that runs inside a locked-down container and never touches your credentials.

## Why this exists

AI agents are useful. Giving one access to your email, calendar, and messaging apps is terrifying. Most agent frameworks ask you to hand over API keys and let the agent call external services on its own. If something goes wrong -- prompt injection, a bug, a leaked context -- the agent has direct access to your accounts and there's nothing in between.

Carapace doesn't work that way. The agent can't reach the internet. It can't read your filesystem. It never sees an API key. The only thing it can do is send a structured message through a Unix socket and wait for a response. Everything sensitive happens on the other side of that socket, where code you control holds the credentials and talks to external services.

## How it works

The system has two sides separated by a hard trust boundary.

The agent (Claude Code) runs in a container with a read-only filesystem, no network access, and exactly one communication channel: a small binary called `ipc`. When the agent needs to send a message or check your calendar, it calls `ipc` with a topic and arguments. It can't construct HTTP requests or read environment variables. That's the entire surface area.

On the host side, a core router receives those messages over a ZeroMQ Unix socket. It never trusts what the container says about itself. Instead, it constructs a full identity envelope from its own session state -- who this container is, what group it belongs to, when the session started. Then it validates the payload, checks authorization, and routes the request to the right plugin. Plugins hold the credentials and call external APIs. Before the response goes back to the container, a sanitization layer strips anything that looks like a credential pattern.

```
Container (locked down)          Host (trusted)
┌──────────────────────┐         ┌─────────────────────────────┐
│  Claude Code         │         │  Core Router                │
│  + skill files       │  ZeroMQ │  ├─ 6-stage validation      │
│  + ipc binary ───────┼─────────┤  ├─ Envelope construction   │
│                      │  Unix   │  ├─ Response sanitization   │
│  No network          │  socket │  │                          │
│  No credentials      │         │  Plugins                    │
│  Read-only FS        │         │  ├─ Telegram (holds API key)│
└──────────────────────┘         │  ├─ Email (holds OAuth)     │
                                 │  ├─ Calendar                │
                                 │  └─ Memory (SQLite + FTS5)  │
                                 └─────────────────────────────┘
```

The validation pipeline has six stages: envelope construction, topic validation, payload validation, authorization, user confirmation (for high-risk tools), and routing. If any stage fails, the agent gets a structured error code. It never gets raw stack traces or internal details.

## Plugins

Every plugin is a pair: a host-side handler written in TypeScript that holds credentials and calls APIs, and a container-side skill file (markdown) that teaches the agent what tools exist and how to call them.

```
plugins/memory/
  manifest.json         # declares tools, schemas, risk levels
  handler.ts            # host-side logic with credential access
  skills/memory.md      # teaches the agent about memory tools
```

Drop a folder in `plugins/` and it gets discovered at startup. No registry, no marketplace. Each tool in the manifest has a risk level. Low-risk tools execute immediately. High-risk tools pause and ask the user before running. All tool schemas require `additionalProperties: false`, so the agent can't slip in unexpected fields.

## What's working

The foundation is done: message types, the ZeroMQ event bus (PUB/SUB) and request channel (ROUTER/DEALER), the message router with the full 6-stage pipeline, the filesystem-based plugin loader, the Dockerfile, and CI. Tests cover the validation pipeline, socket communication, plugin loading, and container runtime mocking.

Still in progress: the IPC binary, session manager, memory plugin, CLI entry point, response sanitization, container security verification, and the end-to-end test infrastructure (which uses Claude Code as the actual test driver -- the agent runs real sessions against mock plugins).

The full task list is in [docs/TASKS.md](docs/TASKS.md).

## Getting started

### Prerequisites

The dev environment uses [Nix Flakes](https://nixos.wiki/wiki/Flakes). This pins Node.js 22, pnpm, TypeScript, Docker, ZeroMQ, SQLite, and the linting tools so you don't have to install them separately.

With Nix and direnv:

```bash
git clone https://github.com/fred-drake/carapace.git
cd carapace
direnv allow        # loads the Nix dev shell
pnpm install
```

Without direnv:

```bash
nix develop
pnpm install
```

### Build and test

```bash
pnpm run build      # compile TypeScript
pnpm test           # unit tests
pnpm test:coverage  # tests with coverage
pnpm run lint       # oxlint
pnpm run format     # prettier
```

Run a single test file:

```bash
pnpm test -- src/core/router.test.ts
```

## Architecture

The full design doc is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Here's the short version.

Two ZeroMQ channels run over Unix sockets. PUB/SUB carries events that start sessions -- an email arrives, a cron fires. ROUTER/DEALER carries tool invocations during sessions, when the agent needs a result from a plugin.

The wire format is deliberately minimal. The container sends three fields: `topic`, `correlation`, `arguments`. The host fills in everything else (ID, version, source, group, timestamp) from its own session state. Zero overlap between what the container sends and what the host constructs. This makes identity spoofing structurally impossible.

Storage is host-side SQLite at `data/{feature}/{group}.sqlite`. Each group gets its own database. Credentials stay on the host.

Memory is a plugin, not a core feature. It stores typed entries (preferences, facts, instructions, corrections) in SQLite with FTS5 full-text search. All memories are treated as untrusted because they may have been written during a session that was influenced by prompt injection. When the agent starts a new session, the memory brief flags behavioral entries and tells the agent to verify anything unusual with the user. The full design is in [docs/MEMORY_DRAFT.md](docs/MEMORY_DRAFT.md).

## Project status

Early stage, active development. The foundation (P0 tasks) is complete. Core functionality (P1) and features (P2) are in progress. [docs/TASKS.md](docs/TASKS.md) has the full breakdown with dependencies.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- system design, messaging protocol, security model
- [docs/MEMORY_DRAFT.md](docs/MEMORY_DRAFT.md) -- memory plugin design, FTS5 search, provenance tracking
- [docs/FUTURE_FEATURES.md](docs/FUTURE_FEATURES.md) -- roadmap with tiered priorities
- [docs/TASKS.md](docs/TASKS.md) -- development task list with dependency graph
