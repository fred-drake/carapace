# Contributing to Carapace

Thanks for your interest in contributing. This guide covers development setup,
build commands, testing, and the PR workflow.

## Development environment

The dev environment uses [Nix Flakes](https://nixos.wiki/wiki/Flakes) for
reproducible tooling. This pins Node.js 22, pnpm, TypeScript, Docker,
ZeroMQ, SQLite, oxlint, and prettier so you don't have to install them
separately.

### With direnv (recommended)

```bash
git clone https://github.com/fred-drake/carapace.git
cd carapace
direnv allow        # loads .envrc -> `use flake`
pnpm install
```

### Without direnv

```bash
git clone https://github.com/fred-drake/carapace.git
cd carapace
nix develop         # enter the Nix dev shell
pnpm install
```

### Without Nix

If you don't use Nix, install these manually:

- Node.js >= 22
- pnpm
- Docker, Podman, or Apple Containers
- SQLite
- ZeroMQ (`libzmq`)

Then:

```bash
pnpm install
```

## Build and quality commands

```bash
pnpm run build        # compile TypeScript (tsc + tsc-alias)
pnpm run type-check   # type-check without emitting
pnpm run lint         # oxlint
pnpm run format       # prettier (write)
pnpm run format:check # prettier (check only)
```

## Testing

The project uses [Vitest](https://vitest.dev/) with multiple test projects:

```bash
pnpm test             # unit tests
pnpm test -- <path>   # run a single test file
pnpm test:all         # all test projects
pnpm test:coverage    # unit tests with coverage report
pnpm test:integration # integration tests
pnpm test:security    # security-specific tests
pnpm test:e2e         # end-to-end tests
pnpm test:conformance # plugin conformance tests
pnpm test:bench       # performance benchmarks
```

### TDD discipline

This project follows strict Red-Green-Refactor TDD:

1. **Red** -- Write ONE failing test. It must fail for the right reason
   (assertion failure, not a compilation error unrelated to the feature).
2. **Green** -- Write the MINIMAL code to make the test pass. No anticipatory
   coding, no extra branches "just in case."
3. **Refactor** -- Only when tests are green. Types, abstractions, and cleanup
   are fine. New behavior is not -- that requires a new Red step.

Incremental stubs follow a natural progression:

- "not defined" -> create module/file stub
- "not a function" -> add function/method stub
- assertion failure -> implement minimal logic

The TDD guard configuration lives in `.claude/tdd-guard/`.

## Project structure

```
src/
  core/              # Router, plugin loader, health checks, tool catalog
    container/       # Container runtime adapters (Docker, Podman, Apple)
  ipc/               # IPC binary (container-side communication)
  plugins/           # Built-in plugins (memory, etc.)
    memory/          # Memory plugin (SQLite + FTS5)
  security/          # Artifact verification, digest pinning, audit
  testing/           # Plugin test SDK, test helpers
  types/             # TypeScript interfaces (protocol, config, manifest)
  cli.ts             # CLI entry point and subcommand dispatch
  scaffold.ts        # Plugin scaffolding generator
  index.ts           # Version constant and public exports
scripts/
  install.sh         # POSIX install script
plugins/             # User plugins (filesystem-discovered at startup)
docs/                # Architecture, tasks, guides
```

## Plugin development

See [docs/PLUGIN_AUTHORING.md](docs/PLUGIN_AUTHORING.md) for the full guide.
The short version:

### Scaffolding a new plugin

```bash
carapace scaffold my-plugin
```

This creates the standard structure:

```
plugins/my-plugin/
  manifest.json       # tool declarations, risk levels, schemas
  handler.ts          # host-side logic (holds credentials, calls APIs)
  skills/my-plugin.md # container-side skill (teaches Claude the tools)
  handler.test.ts     # test file with plugin test SDK imports
```

### Manifest format

Every plugin declares its tools in `manifest.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "tools": [
    {
      "name": "my-plugin.action",
      "description": "What this tool does",
      "risk_level": "low",
      "arguments_schema": {
        "type": "object",
        "properties": {
          "input": { "type": "string" }
        },
        "required": ["input"],
        "additionalProperties": false
      }
    }
  ]
}
```

All schemas must include `"additionalProperties": false`.

### Validating a plugin

```bash
carapace validate-manifest plugins/my-plugin/manifest.json
```

### Testing with the plugin test SDK

The test SDK provides helpers for isolated plugin testing:

```typescript
import { createTestContext, createTestInvocation } from '@carapace/testing';
import { assertSuccessResult, assertNoCredentialLeak } from '@carapace/testing';

const ctx = createTestContext({ group: 'test-group' });
const invocation = createTestInvocation('my-plugin.action', { input: 'hello' });
const result = await handler.handleToolInvocation(invocation.tool, invocation.args, ctx);
assertSuccessResult(result);
assertNoCredentialLeak(result);
```

## Git workflow

### Branch protection

Branch protection is active on `master`:

- No direct pushes to `master` -- all changes go through PRs
- Squash merge with `--squash --delete-branch`

### Making changes

```bash
# Create a feature branch
git checkout -b my-feature origin/master

# Make changes, commit
git add <files>
git commit -m "feat: description of the change"

# Push and create PR
git push -u origin my-feature
gh pr create --title "feat: description" --body "## Summary
- What changed and why

## Test plan
- [ ] Tests pass locally
- [ ] New tests added for new behavior"
```

### Commit message style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` -- new feature
- `fix:` -- bug fix
- `refactor:` -- code restructuring without behavior change
- `test:` -- adding or updating tests
- `docs:` -- documentation changes
- `chore:` -- build, CI, dependencies

Task IDs go in parentheses: `feat(eng-10): implement memory data layer`

### PR checklist

Before submitting a PR:

- [ ] `pnpm test` passes (all unit tests green)
- [ ] `pnpm run lint` passes (no oxlint errors)
- [ ] `pnpm run format:check` passes (code is formatted)
- [ ] `pnpm run build` succeeds (TypeScript compiles)
- [ ] New code has corresponding tests
- [ ] PR description includes a summary and test plan

## Architecture overview

For the full design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Trust model

Two domains separated by a hard trust boundary:

- **Container (untrusted)**: Claude Code + skill files + `ipc` binary. No
  network, no host filesystem, no credentials.
- **Host (trusted)**: Core router + plugins + credentials store. Validates
  every message. Constructs identity from session state.

### Messaging (ZeroMQ)

Two channels over Unix domain sockets:

| Channel         | Pattern       | Purpose                               |
| --------------- | ------------- | ------------------------------------- |
| Event Bus       | PUB/SUB       | External triggers that start sessions |
| Request Channel | ROUTER/DEALER | Tool invocations during sessions      |

### Wire format

The container sends 3 fields: `topic`, `correlation`, `arguments`. The host
fills in everything else (`id`, `version`, `source`, `group`, `timestamp`)
from session state. Zero overlap between wire and envelope fields prevents
identity spoofing.

### Data storage

Host-side SQLite at `data/{feature}/{group}.sqlite`. Each group gets its own
database. Credentials stay on the host.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- System design, messaging,
  security model, error codes
- [docs/PLUGIN_AUTHORING.md](docs/PLUGIN_AUTHORING.md) -- Plugin development
  guide with walkthroughs
- [docs/MEMORY_DRAFT.md](docs/MEMORY_DRAFT.md) -- Memory plugin design
- [docs/FUTURE_FEATURES.md](docs/FUTURE_FEATURES.md) -- Feature roadmap
- [docs/TASKS.md](docs/TASKS.md) -- Development task list
