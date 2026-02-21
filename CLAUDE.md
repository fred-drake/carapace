# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Carapace is a security-first, plugin-driven personal AI agent framework built in TypeScript/Node.js. It runs Claude Code inside isolated containers with a ZeroMQ-based messaging system connecting to host-side plugins that hold credentials and interact with external services.

## Development Environment

Uses Nix Flakes for reproducible development. Enter the dev shell:

```bash
direnv allow          # loads .envrc → `use flake`
```

This provides: Node.js 22, pnpm, TypeScript, Docker/Docker Compose, ZeroMQ, SQLite, oxlint, prettier.

## Build & Quality Commands

```bash
pnpm install          # install dependencies
pnpm run build        # compile TypeScript
pnpm run type-check   # full type-check (includes test files — this is the CI gate)
pnpm run lint         # oxlint
pnpm run format       # prettier
pnpm test             # run full test suite
pnpm test -- <path>   # run a single test file
```

**Important**: `pnpm run build` only type-checks source files (`tsconfig.json`).
CI runs `pnpm run type-check` which uses `tsconfig.check.json` and includes test
files. Always run `type-check` before pushing to catch test file type errors.

## Architecture

### Trust Model

Two domains separated by a hard trust boundary:

- **Container (Untrusted)**: Claude Code + markdown skill files + `ipc` binary. No network, no host filesystem, no credentials. Read-only filesystem except workspace and ZeroMQ socket.
- **Host (Trusted)**: Core router + plugins + credentials store. Validates every message from container. Constructs message identity from session state (never trusts container claims).

### Core Principles

1. **Security by architecture** — VM-based container isolation is the primary boundary, not application-level controls.
2. **Plugins are local and independent** — Filesystem discovery in `plugins/`, no registry or marketplace. Plugins never depend on each other.
3. **Two halves make a whole** — Each plugin is a pair: host-side handler (TypeScript, holds credentials, executes tools) + container-side skill (markdown teaching Claude the available tools).
4. **Core owns no business logic** — Routes messages, enforces policy, manages container lifecycle. Everything else is a plugin.

### Messaging (ZeroMQ)

Two channels over Unix sockets:

| Channel         | Pattern       | Purpose                                                               |
| --------------- | ------------- | --------------------------------------------------------------------- |
| Event Bus       | PUB/SUB       | External triggers that **start** sessions (email arrives, cron fires) |
| Request Channel | ROUTER/DEALER | Tool invocations **during** sessions (agent needs a result)           |

### Wire Format (Container → Host)

Container sends only 3 fields: `topic`, `correlation`, `arguments`. Core constructs the full envelope (`id`, `version`, `type`, `source`, `group`, `timestamp`) from trusted session state. Zero overlap between wire and envelope fields prevents spoofing.

### Plugin Structure

```
plugins/{name}/
  manifest.json         # declares tools, hooks, config schema
  handler.ts            # host-side: holds credentials, executes tool logic
  skills/{name}.md      # container-side: teaches Claude about available tools
```

Tool risk levels: `"low"` (auto-execute) vs `"high"` (requires user confirmation). All schemas enforce `additionalProperties: false`.

### Data Storage

Host-side SQLite at `data/{feature}/{group}.sqlite`. Credentials never enter the container.

## End-to-End Prompt Flow

The full pipeline from CLI to Claude Code running in a container:

```
carapace auth api-key|login → stores credential at $CARAPACE_HOME/credentials/
carapace start             → detects runtime, creates Server with event dispatch pipeline
carapace prompt "text"     → writes task.triggered JSON to $CARAPACE_HOME/run/prompts/
Server polls prompts dir   → EventDispatcher → readCredentialStdin() → SpawnRequest
LifecycleManager.spawn()   → container create -i + start -ai (stdin pipes credentials)
Entrypoint reads stdin     → exports ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
Claude Code runs           → claude -p "text" (non-interactive) or claude (interactive)
```

Credential precedence: API key wins over OAuth token when both exist.

## Wiring Checklist (main.ts)

`createStartServer()` in `src/main.ts` is the factory that wires real dependencies
into the Server. When adding new Server features:

1. Add the field to `ServerConfig` or `ServerDeps`
2. Thread it through `createStartServer()` — this is easily forgotten
3. Wire real implementations (fs, runtime, etc.) in the factory

The runtime is detected once in `main()` and passed into both the CLI deps
(for image building) and `createStartServer()` (for container spawning).

## Apple Containers Gotchas

- **`--publish-socket` direction**: Publishes container sockets TO the host
  (opposite of what's needed). Use `-v` bind mounts to make host sockets
  accessible inside containers, same as Docker/Podman.
- **stdinData**: Supports `container create -i` + `container start -ai` for
  stdin piping (same pattern as Docker).
- **VM-per-container**: Each container is a full lightweight VM. Spawn time
  is ~100-150ms (total prompt-to-spawn ~260ms including polling interval).
- **Image store is separate**: Apple Container images are NOT shared with
  Docker/Podman. Images built with `container build` only exist in the
  Apple Container image store.

## TypeScript Patterns

### Vitest mock typing for discriminated unions

`vi.fn(() => 'fresh')` infers `Mock<() => string>`, which won't satisfy union types
like `SessionPolicy = 'fresh' | 'resume' | 'explicit'`. Always add explicit return
type annotations:

```typescript
// BAD — infers string, fails type-check
getSessionPolicy: vi.fn(() => 'fresh'),

// GOOD — explicit return type
getSessionPolicy: vi.fn((): SessionPolicy => 'fresh'),
```

Same issue with object literals in discriminated unions — `{ ok: true }` infers
`{ ok: boolean }`. Use `as const`:

```typescript
handleToolInvocation: async () => ({ ok: true as const, result: {} }),
```

### Ajv ESM interop

Ajv's CJS/ESM interop requires a runtime fallback. Use the pattern from
`plugin-loader.ts`:

```typescript
import _Ajv from 'ajv';
const Ajv = _Ajv.default ?? _Ajv;
```

Do **not** use typed casts like `(_Ajv as unknown as { default: typeof _Ajv }).default`
— this breaks under `tsconfig.check.json`.

## Known Issues

- **Path aliases need runtime resolver**: `tsconfig.json` path aliases (`@carapace/core/*`, etc.) only work at type-check time. `tsc` with `NodeNext` does not rewrite imports in emitted JS. Add `tsc-alias` or equivalent to the build pipeline before code starts using aliases.
- **pnpm version mismatch**: `packageManager` in `package.json` says `pnpm@9.15.4` but Nix shell provides 10.28.0. Update to match.

## TDD Discipline

This project follows strict Red-Green-Refactor TDD (see `.claude/tdd-guard/`):

- **Red**: Write ONE failing test. Must fail for the right reason.
- **Green**: Write MINIMAL code to pass. No anticipatory coding.
- **Refactor**: Only when tests are green. Types, abstractions, cleanup allowed; new behavior is not.

Incremental stubs: "not defined" → create stub, "not a function" → add method stub, assertion failure → implement minimal logic.

## Git & PR Workflow

Repository is public on GitHub (`fred-drake/carapace`). Branch protection is active on `master`:

- **No direct pushes to master** — all changes go through PRs
- **0 approvals required** — solo project, self-merge is fine
- **Squash merge** — use `--squash --delete-branch` when merging

Workflow: feature branch → commit → push → PR with summary + test plan → code review comment → squash merge → update local master.

**gh CLI**: Available via Nix dev shell. If not in PATH, use the nix store path directly. Authenticated as `fred-drake`.

## Task Completion Tracking

When a task from `docs/TASKS.md` is completed:

1. Mark it in `docs/TASKS.md` with strikethrough + `DONE` + PR reference and date
2. Example: `### ~~ARCH-01: Bootstrap project structure~~ DONE`
3. Add a `**Status**: Completed (PR #N, merged YYYY-MM-DD)` line
4. Commit this update through a PR (branch protection requires it)

Code review findings go in `TASK.md` (root) with priority-tagged actionable items.

## Key Documentation

- `docs/ARCHITECTURE.md` — Full system design, messaging protocol, security model, error codes
- `docs/MEMORY_DRAFT.md` — Memory plugin design (typed entries, FTS5 search, provenance tracking)
- `docs/FUTURE_FEATURES.md` — Roadmap with tiered priorities and competitive analysis
- `docs/TASKS.md` — Master development task list (check for `DONE` markers to see progress)
- `TASK.md` — Code review follow-up items

## AI Planning Team

Six specialized roles for task generation and architectural review. Re-create with: `TeamCreate` named `carapace-planning`, then spawn each role as a teammate with `team_name: "carapace-planning"`. Each role has a persistent instruction file in `docs/team-roles/`.

**Nix environment caveat**: If `flake.nix` is modified during a session, any running AI team agents must be shut down and re-spawned so they pick up the new dev shell environment. The Nix flake is evaluated when an agent starts; changes are not reflected in already-running agents.

**Git worktree caveat**: When agents work in isolated worktrees, they may merge
dependency branches that introduce stale or conflicting code. Always verify the
diff against master contains only the intended file changes before creating a PR.
If contamination is found, create a clean branch from master and cherry-pick or
manually apply only the target changes.

| Role              | Name          | Focus                                                                                              |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| Architect         | `architect`   | System decomposition, module boundaries, dependency ordering, interface contracts, critical path   |
| DevOps            | `devops`      | Container runtime, CI/CD, Nix packaging, ZeroMQ socket lifecycle, health checks, deployment        |
| Security          | `security`    | Trust boundaries, schema validation, credential isolation, rate limiting, prompt injection defense |
| DX Advocate       | `dx-advocate` | Plugin authoring experience, CLI ergonomics, scaffolding, error messages, debugging tools          |
| Software Engineer | `engineer`    | Core implementation: router, IPC binary, plugin loader, messaging, SQLite, memory plugin           |
| QA                | `qa`          | Test framework, TDD enforcement, integration harness, security testing, plugin conformance         |

### Spawning a Teammate

```
Task tool with:
  subagent_type: "general-purpose"
  name: "{role-name}"
  team_name: "carapace-planning"
  prompt: "You are the {Role} on the Carapace planning team. Read your role file at docs/team-roles/{role-name}.md and the architecture docs, then proceed with your assigned task."
```
