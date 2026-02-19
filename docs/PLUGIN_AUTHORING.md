# Plugin Authoring Guide

> Last Updated: 2026-02-19 | Carapace v0.1.0

A complete guide to building, testing, and shipping plugins for Carapace. By the
end, you'll have built two plugins from scratch — a simple echo plugin and a
complex memory plugin — and understand the full lifecycle from manifest to
production.

## Table of Contents

1. [Overview](#overview)
2. [Plugin Structure](#plugin-structure)
3. [Manifest Reference](#manifest-reference)
4. [Handler Interface](#handler-interface)
5. [Skill Files](#skill-files)
6. [Error Handling](#error-handling)
7. [Testing Guide](#testing-guide)
8. [Walkthrough: Echo Plugin](#walkthrough-echo-plugin)
9. [Walkthrough: Memory Plugin](#walkthrough-memory-plugin)
10. [Debugging](#debugging)
11. [Validation & Deployment](#validation--deployment)
12. [Security Considerations](#security-considerations)

---

## Overview

Carapace plugins follow a "two halves make a whole" architecture:

- **Host-side handler** (TypeScript): Runs on the trusted host. Holds
  credentials, calls external APIs, stores data. Implements the `PluginHandler`
  interface.
- **Container-side skill** (Markdown): Injected into the isolated container.
  Teaches Claude what tools are available and how to invoke them via the `ipc`
  binary.

The core owns no business logic — it routes messages, enforces policy, and
manages the container lifecycle. Everything else is a plugin.

### Trust Boundary

```
┌─────────────────────────┐     ZeroMQ     ┌────────────────────────────┐
│  Container (Untrusted)  │ ←────────────→ │     Host (Trusted)         │
│                         │                │                            │
│  Claude + skill files   │  wire message  │  Core router + PluginLoader│
│  ipc binary             │  ───────────→  │  PluginHandler instances   │
│                         │  response      │  Credentials store         │
│  No network, no creds   │  ←───────────  │  SQLite data layer         │
└─────────────────────────┘                └────────────────────────────┘
```

The container sends only three fields across the boundary: `topic`,
`correlation`, and `arguments`. The core constructs the full envelope (`id`,
`version`, `type`, `source`, `group`, `timestamp`) from trusted session state.

---

## Plugin Structure

Every plugin lives in a directory under `plugins/` (user-managed) or
`lib/plugins/` (built-in, read-only):

```
plugins/my-plugin/
  manifest.json         # Declares tools, metadata, config schema
  handler.ts            # Host-side: implements PluginHandler
  handler.test.ts       # Tests using plugin test SDK
  skills/
    my-plugin.md        # Container-side: teaches Claude the tools
```

### Scaffolding

Use the CLI to generate a complete skeleton:

```bash
carapace plugin create my-plugin
```

This creates all four files with sensible defaults. Options:

```bash
carapace plugin create my-plugin --tool my-plugin.search --risk high
```

- `--tool <name>`: Set the initial tool name (default: `my-plugin.example`)
- `--risk <low|high>`: Set the tool's risk level (default: `low`)

### Naming Convention

Plugin names must be **kebab-case**: lowercase letters, digits, and hyphens.
The regex: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`

Tool names use **dot notation**: `<plugin-name>.<tool-name>` (e.g.
`memory.store`, `github.create-issue`).

---

## Manifest Reference

The `manifest.json` file declares everything the core needs to load and validate
your plugin. Every field is validated at load time against a JSON Schema.

### Complete Example

```json
{
  "description": "Persistent memory with FTS5 search",
  "version": "1.0.0",
  "app_compat": ">=0.1.0",
  "author": {
    "name": "Carapace Team",
    "url": "https://github.com/fred-drake/carapace"
  },
  "provides": {
    "channels": ["request"],
    "tools": [
      {
        "name": "memory.store",
        "description": "Store a typed memory entry",
        "risk_level": "low",
        "arguments_schema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "content"],
          "properties": {
            "type": {
              "type": "string",
              "description": "Entry type",
              "enum": ["preference", "fact", "instruction", "context", "correction"]
            },
            "content": {
              "type": "string",
              "description": "The memory content to store",
              "maxLength": 2000
            },
            "tags": {
              "type": "array",
              "description": "Categorization tags",
              "items": { "type": "string", "maxLength": 50 },
              "maxItems": 10
            }
          }
        }
      }
    ]
  },
  "subscribes": ["agent.started"],
  "allowed_groups": ["personal"],
  "config_schema": {
    "type": "object",
    "required": ["max_entries"],
    "properties": {
      "max_entries": {
        "type": "number",
        "description": "Maximum stored entries per group",
        "minimum": 1,
        "maximum": 10000
      }
    }
  }
}
```

### Required Fields

| Field         | Type       | Description                                  |
| ------------- | ---------- | -------------------------------------------- |
| `description` | `string`   | What the plugin does (shown in `list_tools`) |
| `version`     | `string`   | Semver version of the plugin                 |
| `app_compat`  | `string`   | Minimum Carapace version required            |
| `author`      | `object`   | `{ name: string, url?: string }`             |
| `provides`    | `object`   | Channels and tools this plugin offers        |
| `subscribes`  | `string[]` | Event topics to receive via PUB/SUB          |

### Tool Declaration

Each tool in `provides.tools` has:

| Field              | Type              | Description                                      |
| ------------------ | ----------------- | ------------------------------------------------ |
| `name`             | `string`          | Unique tool name (e.g. `my-plugin.action`)       |
| `description`      | `string`          | What the tool does (shown to Claude)             |
| `risk_level`       | `"low" \| "high"` | `low` = auto-execute, `high` = user confirmation |
| `arguments_schema` | `object`          | JSON Schema for tool arguments                   |

### Argument Schema Rules

Every `arguments_schema` **must** set `additionalProperties: false`. This
prevents the container from injecting unexpected fields. The schema validator
enforces this at load time.

Supported JSON Schema property fields:

- `type` (required): `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`
- `description`: Shown to Claude for context
- `maxLength`: Maximum string length
- `maximum` / `minimum`: Numeric bounds
- `enum`: Allowed values
- `format`: String format hint (e.g. `"date-time"`)
- `items`: Schema for array elements
- `maxItems`: Maximum array length
- `default`: Default value

### Optional Fields

| Field            | Type       | Description                          |
| ---------------- | ---------- | ------------------------------------ |
| `allowed_groups` | `string[]` | Restrict plugin to specific groups   |
| `config_schema`  | `object`   | JSON Schema for plugin configuration |

### Reserved Tool Names

The following names are reserved for core intrinsic tools and cannot be used by
plugins:

- `get_diagnostics`
- `list_tools`
- `get_session_info`

Tools prefixed with `hello.` are reserved when the hello module is enabled.

---

## Handler Interface

Every plugin must export a class (or object) implementing `PluginHandler`.

### Interface Definition

```typescript
import type {
  PluginHandler,
  PluginContext,
  CoreServices,
  ToolInvocationResult,
} from '@carapace/core/plugin-handler.js';

interface PluginHandler {
  // Called once during plugin loading
  initialize(services: CoreServices): Promise<void>;

  // Called for each tool invocation (may be called many times)
  handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult>;

  // Optional: react to PUB/SUB events
  handleEvent?(envelope: EventEnvelope): Promise<void>;

  // Called during graceful teardown
  shutdown(): Promise<void>;
}
```

### Lifecycle

```
┌────────────┐    ┌──────────────────────────┐    ┌────────────┐
│ initialize │ →  │ handleToolInvocation (×N) │ →  │  shutdown   │
│  (once)    │    │    (many times)           │    │   (once)    │
└────────────┘    └──────────────────────────┘    └────────────┘
```

1. **`initialize(services)`**: Called once when the plugin is loaded. Use this to
   set up connections, load config, prepare databases. Receives `CoreServices`
   for accessing the audit log, tool catalog, and session info. Has a 10-second
   timeout by default.

2. **`handleToolInvocation(tool, args, context)`**: Called for each tool request
   from the container. The `tool` parameter is the tool name without the
   `tool.invoke.` prefix. Arguments have already been validated against your
   schema.

3. **`handleEvent(envelope)`**: Optional. Called when an event matching your
   `subscribes` patterns arrives on the PUB/SUB channel.

4. **`shutdown()`**: Called during graceful teardown. Close database connections,
   flush buffers, release resources. Has a 5-second timeout.

### CoreServices

Services provided to your plugin during initialization:

```typescript
interface CoreServices {
  // Query the audit log (automatically scoped to current group)
  getAuditLog(filters: AuditLogFilter): Promise<AuditLogEntry[]>;

  // List all registered tools
  getToolCatalog(): ToolDeclaration[];

  // Get current session info
  getSessionInfo(): SessionInfo;
}
```

**Important**: All methods are automatically scoped to the current request's
group. You never pass group or session identifiers — the core handles isolation.

### PluginContext

Per-invocation metadata passed to `handleToolInvocation`:

```typescript
interface PluginContext {
  group: string; // Which group this request belongs to
  sessionId: string; // Current session identifier
  correlationId: string; // Unique ID linking request to response
  timestamp: string; // ISO 8601 timestamp
}
```

Use `context.group` and `context.sessionId` for provenance tracking. Never
trust tool arguments for identity — always use the context.

### ToolInvocationResult

Return a discriminated union from `handleToolInvocation`:

```typescript
// Success
return { ok: true, result: { message: 'Done', count: 42 } };

// Error
return {
  ok: false,
  error: {
    code: 'HANDLER_ERROR',
    message: 'Entry not found',
    retriable: false,
  },
};
```

The `result` field must be a `Record<string, unknown>` (a plain object). The
`error` field follows the `ErrorPayload` structure.

### Export Format

The plugin loader accepts either a **default export** or a **named `handler`
export**:

```typescript
// Option A: Default export (recommended)
export default class MyHandler implements PluginHandler { ... }

// Option B: Named export
export const handler = new MyHandler();
```

The loader looks for `handler.js` first, then `handler.ts`.

---

## Skill Files

Skill files are markdown documents placed in `skills/` that teach Claude how to
use your tools from inside the container.

### Location

```
plugins/my-plugin/skills/my-plugin.md
```

The skill loader discovers all `.md` files in the `skills/` directory and mounts
them into the container at `.claude/skills/<plugin-name>/<filename>.md`.

### Format

```markdown
# my-plugin

Brief description of what this plugin does.

## Tools

### my-plugin.action

Describe what this tool does and when Claude should use it.

**Arguments:**

- `input` (string, required): What this argument controls.
- `limit` (number, optional): Maximum results. Default: 10.

**Example usage:**
```

Use my-plugin.action to process the input.

```

**When to use:**
- When the user asks to [specific scenario].
- After [specific event] has occurred.

**When NOT to use:**
- When [alternative is better].
```

### Conventions

1. **One skill file per plugin** is typical, but you can split across multiple
   `.md` files for complex plugins.
2. **Tool names must match** the names in `manifest.json` exactly.
3. **Describe the `ipc` invocation**: Claude invokes tools via
   `ipc tool.invoke.<tool-name> '<json-args>'`.
4. **Include examples** with concrete argument values.
5. **Explain when to use and when not to use** each tool — this guides Claude's
   decision-making.
6. **Document error cases**: What errors can occur and how Claude should handle
   them.

### Intrinsic Skills

Core intrinsic tools (`get_diagnostics`, `list_tools`, `get_session_info`) have
auto-generated skill files. Your skills complement these.

---

## Error Handling

### Structured Errors with ToolError

For detailed error responses, throw `ToolError` from your handler:

```typescript
import { ToolError } from '@carapace/core/tool-error.js';
import { ErrorCode } from '@carapace/types/errors.js';

throw new ToolError({
  code: ErrorCode.HANDLER_ERROR,
  message: 'Entry not found: abc-123',
  retriable: false,
  field: 'id',
});
```

The core catches `ToolError` and converts it to a structured error response.
Any other thrown error becomes a generic `PLUGIN_ERROR` with no internal details
leaked.

### Error Codes

Plugin handlers should use `HANDLER_ERROR` for their errors. The following codes
are reserved for the core pipeline and will be normalized to `HANDLER_ERROR` if
thrown by a handler:

| Code                   | Owner  | Description                             |
| ---------------------- | ------ | --------------------------------------- |
| `UNKNOWN_TOOL`         | Core   | Tool name not found in catalog          |
| `VALIDATION_FAILED`    | Core   | Argument schema validation failed       |
| `UNAUTHORIZED`         | Core   | Group not authorized for this plugin    |
| `RATE_LIMITED`         | Core   | Too many requests                       |
| `CONFIRMATION_TIMEOUT` | Core   | User didn't respond to high-risk prompt |
| `CONFIRMATION_DENIED`  | Core   | User rejected high-risk tool            |
| `PLUGIN_TIMEOUT`       | Core   | Handler didn't respond in time          |
| `PLUGIN_UNAVAILABLE`   | Core   | Plugin failed to load                   |
| `PLUGIN_ERROR`         | Core   | Handler threw non-ToolError exception   |
| `HANDLER_ERROR`        | Plugin | Plugin's own structured error           |

### Returning Errors Without Throwing

You can also return errors directly from `handleToolInvocation` instead of
throwing. This is useful when errors are expected flow (not exceptional):

```typescript
async handleToolInvocation(tool, args, context) {
  const entry = this.store.get(args.id as string);
  if (!entry) {
    return {
      ok: false,
      error: {
        code: 'HANDLER_ERROR',
        message: `Entry "${args.id}" not found.`,
        retriable: false,
      },
    };
  }
  return { ok: true, result: { entry } };
}
```

### Actionable Error Messages

Follow the Carapace error message format for developer-facing errors:

```typescript
import { formatErrorMessage } from '@carapace/core/plugin-handler.js';

const msg = formatErrorMessage({
  component: 'MEMORY',
  what: 'Entry limit exceeded',
  how: 'Delete old entries with memory_delete or increase max_entries in config',
  docs: 'docs/MEMORY_DRAFT.md',
});
// → [MEMORY] Error: Entry limit exceeded. Fix: Delete old entries with
//   memory_delete or increase max_entries in config. Docs: docs/MEMORY_DRAFT.md
```

---

## Testing Guide

Carapace provides a plugin test SDK for testing handlers in isolation — no
ZeroMQ, no running core, no containers.

### Setup

```typescript
import {
  createTestContext,
  createTestInvocation,
  FakeCredentialStore,
  assertSuccessResult,
  assertErrorResult,
  assertNoCredentialLeak,
} from '@carapace/testing/plugin-test-sdk.js';
```

### createTestContext

Create a mock `PluginContext` with sensible defaults:

```typescript
const ctx = createTestContext();
// { group: 'test-group', sessionId: 'test-session',
//   correlationId: 'test-correlation', timestamp: '2026-...' }

const ctx = createTestContext({ group: 'production' });
// Override specific fields
```

### createTestInvocation

Simulate a tool invocation against your handler:

```typescript
const handler = new MyHandler();
const result = await createTestInvocation(
  handler,
  'my-plugin.action', // tool name
  { input: 'test data' }, // arguments
  { group: 'my-group' }, // context overrides (optional)
  { autoInit: true }, // options: auto-call initialize() (optional)
);
```

When `autoInit: true`, the SDK calls `handler.initialize()` with a stub
`CoreServices` before invoking the tool. This is convenient for handlers that
need initialization.

### Assertion Helpers

**`assertSuccessResult(result)`** — Assert success and return the result data:

```typescript
const data = assertSuccessResult(result);
expect(data.message).toBe('Hello!');
```

**`assertErrorResult(result, expectedCode?)`** — Assert error and optionally
check the code:

```typescript
const error = assertErrorResult(result, 'HANDLER_ERROR');
expect(error.message).toContain('not found');
```

**`assertNoCredentialLeak(result)`** — Ensure no credential patterns appear in
the result (checks recursively through all string values):

```typescript
assertNoCredentialLeak(result);
// Throws if Bearer tokens, API keys, GitHub tokens, etc. are found
```

Detected patterns include:

- Bearer tokens (`Bearer <token>`)
- OpenAI/Anthropic keys (`sk-...`)
- GitHub personal access tokens (`ghp_...`)
- Slack tokens (`xoxb-...`, `xoxp-...`)
- API key headers (`X-API-Key: ...`)

### FakeCredentialStore

In-memory credential store for testing plugins that need secrets:

```typescript
const creds = new FakeCredentialStore({
  'github-token': 'ghp_test123',
  'api-key': 'sk-test456',
});

expect(creds.get('github-token')).toBe('ghp_test123');
expect(creds.has('api-key')).toBe(true);
expect(creds.keys()).toEqual(['github-token', 'api-key']);
```

### Testing Pyramid

For a complete plugin, write tests at three levels:

**Unit tests** (plugin test SDK):

```typescript
describe('my-plugin', () => {
  it('handles the happy path', async () => {
    const handler = new MyHandler();
    const result = await createTestInvocation(
      handler,
      'my-plugin.action',
      { input: 'test' },
      undefined,
      { autoInit: true },
    );
    const data = assertSuccessResult(result);
    expect(data.message).toBeDefined();
  });

  it('returns error for unknown tools', async () => {
    const handler = new MyHandler();
    const result = await createTestInvocation(handler, 'my-plugin.nonexistent', {}, undefined, {
      autoInit: true,
    });
    assertErrorResult(result, 'HANDLER_ERROR');
  });

  it('does not leak credentials', async () => {
    const handler = new MyHandler();
    const result = await createTestInvocation(
      handler,
      'my-plugin.action',
      { input: 'test' },
      undefined,
      { autoInit: true },
    );
    assertNoCredentialLeak(result);
  });
});
```

**Conformance tests** (verify manifest + handler alignment):

- All tools declared in `manifest.json` are handled
- Unknown tool names return `HANDLER_ERROR`
- Schema-valid arguments don't cause crashes
- Schema-invalid arguments produce sensible errors

**Integration tests** (with PluginLoader, if needed):

- Plugin loads successfully from a directory
- Tools are registered in the catalog
- Initialization timeout is respected
- Shutdown releases resources

### Running Tests

```bash
# Run all tests
pnpm test

# Run a single plugin's tests
pnpm test -- src/plugins/my-plugin/

# Run with coverage
pnpm test -- --coverage
```

---

## Walkthrough: Echo Plugin

Let's build a simple echo plugin from scratch. This plugin has one tool that
echoes back whatever Claude sends it — useful for verifying the pipeline.

### Step 1: Scaffold

```bash
carapace plugin create echo --tool echo.send
```

### Step 2: Manifest (`manifest.json`)

```json
{
  "description": "Echo plugin — mirrors tool arguments back to the caller",
  "version": "0.1.0",
  "app_compat": ">=0.1.0",
  "author": { "name": "Your Name" },
  "provides": {
    "channels": ["request"],
    "tools": [
      {
        "name": "echo.send",
        "description": "Echo back the provided message with metadata",
        "risk_level": "low",
        "arguments_schema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["message"],
          "properties": {
            "message": {
              "type": "string",
              "description": "The message to echo back",
              "maxLength": 500
            },
            "uppercase": {
              "type": "boolean",
              "description": "If true, convert the message to uppercase"
            }
          }
        }
      }
    ]
  },
  "subscribes": []
}
```

### Step 3: Handler (`handler.ts`)

```typescript
import type {
  PluginHandler,
  PluginContext,
  CoreServices,
  ToolInvocationResult,
} from '@carapace/core/plugin-handler.js';

export default class EchoHandler implements PluginHandler {
  async initialize(_services: CoreServices): Promise<void> {
    // No initialization needed for echo
  }

  async handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    switch (tool) {
      case 'echo.send':
        return this.handleSend(args, context);
      default:
        return {
          ok: false,
          error: {
            code: 'HANDLER_ERROR',
            message: `Unknown tool: "${tool}"`,
            retriable: false,
          },
        };
    }
  }

  async shutdown(): Promise<void> {
    // No cleanup needed
  }

  private async handleSend(
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult> {
    const message = args.message as string;
    const uppercase = args.uppercase as boolean | undefined;

    const output = uppercase ? message.toUpperCase() : message;

    return {
      ok: true,
      result: {
        echo: output,
        original: message,
        group: context.group,
        timestamp: context.timestamp,
      },
    };
  }
}
```

### Step 4: Skill File (`skills/echo.md`)

```markdown
# echo

A simple echo plugin that mirrors messages back with optional transformation.

## Tools

### echo.send

Echo back a message, optionally converting it to uppercase.

**Arguments:**

- `message` (string, required): The message to echo back. Max 500 characters.
- `uppercase` (boolean, optional): If true, convert the message to uppercase.

**Example usage:**
```

Use echo.send to verify the pipeline is working: {"message": "hello"}
Use echo.send with uppercase: {"message": "hello", "uppercase": true}

```

**When to use:**
- To verify that the tool pipeline is working correctly.
- For testing and debugging message flow.
```

### Step 5: Tests (`handler.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import {
  createTestInvocation,
  assertSuccessResult,
  assertErrorResult,
  assertNoCredentialLeak,
} from '@carapace/testing/plugin-test-sdk.js';
import EchoHandler from './handler.js';

describe('echo plugin', () => {
  it('echoes back a message', async () => {
    const handler = new EchoHandler();
    const result = await createTestInvocation(
      handler,
      'echo.send',
      { message: 'hello world' },
      undefined,
      { autoInit: true },
    );

    const data = assertSuccessResult(result);
    expect(data.echo).toBe('hello world');
    expect(data.original).toBe('hello world');
  });

  it('converts to uppercase when requested', async () => {
    const handler = new EchoHandler();
    const result = await createTestInvocation(
      handler,
      'echo.send',
      { message: 'hello', uppercase: true },
      undefined,
      { autoInit: true },
    );

    const data = assertSuccessResult(result);
    expect(data.echo).toBe('HELLO');
  });

  it('includes context metadata in response', async () => {
    const handler = new EchoHandler();
    const result = await createTestInvocation(
      handler,
      'echo.send',
      { message: 'test' },
      { group: 'my-group' },
      { autoInit: true },
    );

    const data = assertSuccessResult(result);
    expect(data.group).toBe('my-group');
    expect(data.timestamp).toBeDefined();
  });

  it('returns error for unknown tools', async () => {
    const handler = new EchoHandler();
    const result = await createTestInvocation(handler, 'echo.nonexistent', {}, undefined, {
      autoInit: true,
    });

    assertErrorResult(result, 'HANDLER_ERROR');
  });

  it('does not leak credentials in responses', async () => {
    const handler = new EchoHandler();
    const result = await createTestInvocation(
      handler,
      'echo.send',
      { message: 'test' },
      undefined,
      { autoInit: true },
    );

    assertNoCredentialLeak(result);
  });
});
```

### Step 6: Validate

```bash
carapace plugin validate plugins/echo
```

---

## Walkthrough: Memory Plugin

The memory plugin is a real-world example showing advanced patterns: SQLite
storage, FTS5 search, rate limiting, provenance tracking, and the supersession
chain.

### Architecture

```
memory/
  manifest.json           # 4 tools: store, search, brief, delete
  handler.ts              # PluginHandler wrapper
  memory-handler.ts       # Tool dispatch + rate limiting
  memory-store.ts         # SQLite data layer + FTS5
  memory-security.ts      # Newline stripping (injection defense)
  memory-brief-hook.ts    # Session start hook
  skills/memory.md        # Skill file for Claude
  handler.test.ts         # Unit tests
  memory-handler.test.ts  # Handler tests
  memory-store.test.ts    # Data layer tests
```

### Key Design Decisions

**Provenance from context, never arguments**: The `session_id` and `group`
fields are always taken from `PluginContext`, never from tool arguments. This
prevents a compromised container from claiming a different identity.

```typescript
// Correct — provenance from context
const entry = this.store.store({
  type: args['type'] as MemoryEntryType,
  content: args['content'] as string,
  session_id: context.sessionId, // from trusted context
  group: context.group, // from trusted context
});
```

**Per-session rate limiting**: Memory operations are rate-limited per session to
prevent a runaway agent from flooding the store:

```typescript
const MAX_STORES_PER_SESSION = 20;
const MAX_SUPERSEDES_PER_SESSION = 5;
const MAX_DELETES_PER_SESSION = 5;
```

**Behavioral flag derived from type**: The `behavioral` flag (which controls
whether an entry affects Claude's behavior) is derived from the entry type
(`preference`, `instruction`, `correction` → behavioral), never from an
agent-supplied field.

**Supersession chains**: Entries can supersede older entries. The store
atomically updates both the new entry's `supersedes` field and the old entry's
`superseded_by` field. Superseded entries are excluded from searches by default.

### Tool dispatch pattern

The memory plugin uses a common dispatch pattern — a switch statement on the
tool name with dedicated private methods:

```typescript
async handleToolInvocation(
  tool: string,
  args: Record<string, unknown>,
  context: PluginContext,
): Promise<ToolInvocationResult> {
  switch (tool) {
    case 'memory_store':
      return this.handleStore(args, context);
    case 'memory_search':
      return this.handleSearch(args);
    case 'memory_brief':
      return this.handleBrief(args);
    case 'memory_delete':
      return this.handleDelete(args, context);
    default:
      return {
        ok: false,
        error: {
          code: ErrorCode.HANDLER_ERROR,
          message: `Unknown tool: "${tool}"`,
          retriable: false,
        },
      };
  }
}
```

### Rate limiting pattern

Track counters per session and check before each operation:

```typescript
private readonly sessionLimits: Map<string, SessionLimits> = new Map();

private async handleStore(args, context): Promise<ToolInvocationResult> {
  const limits = this.getLimits(context.sessionId);
  if (limits.stores >= MAX_STORES_PER_SESSION) {
    return {
      ok: false,
      error: {
        code: ErrorCode.RATE_LIMITED,
        message: `Maximum ${MAX_STORES_PER_SESSION} stores per session.`,
        retriable: false,
      },
    };
  }

  // ... do the work ...
  limits.stores++;
  return { ok: true, result: { ... } };
}
```

### Event handling (brief hook)

The memory plugin subscribes to `agent.started` to inject a memory brief at the
start of each session. This is an example of the optional `handleEvent` method:

```typescript
async handleEvent(envelope: EventEnvelope): Promise<void> {
  if (envelope.topic === 'agent.started') {
    // Generate and cache a memory brief for this session
    await this.prepareBrief(envelope.group);
  }
}
```

---

## Debugging

### Message Tracing

Enable debug mode to see real-time message flow:

```bash
carapace start --debug
```

This traces six event types through the pipeline:

| Event                  | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `wire_received`        | Raw wire message arrived from container            |
| `envelope_constructed` | Core built full envelope from wire + session state |
| `stage_passed`         | Message passed a validation stage (1-6)            |
| `stage_rejected`       | Message rejected at a validation stage             |
| `dispatched`           | Message handed to plugin handler                   |
| `response_sent`        | Response sent back to container                    |

Filter output by topic or plugin:

```bash
# Only show memory plugin traffic
carapace start --debug --trace-filter "tool.invoke.memory*"

# Only show rejections
carapace start --debug --trace-filter "stage_rejected"
```

Credential data is automatically redacted in trace output using the same patterns
as the response sanitizer.

### Audit Log

Use the `get_diagnostics` intrinsic tool from inside the container to query the
session-scoped audit log:

```bash
# From inside the container
ipc tool.invoke.get_diagnostics '{"last_n": 5}'
ipc tool.invoke.get_diagnostics '{"correlation": "abc-123"}'
```

### Common Issues

**"Unknown tool" error**: Check that your tool name in `manifest.json` matches
exactly what your handler expects. The topic format is `tool.invoke.<name>`, and
the handler receives just `<name>`.

**"Handler initialization failed"**: Your `initialize()` method threw or timed
out (10s default). Check for missing dependencies, invalid config, or
slow network calls during init.

**"Tool name already registered"**: Another plugin already registered a tool with
the same name. Tool names must be globally unique. Use the `<plugin>.<tool>`
naming convention to avoid collisions.

**"manifest.json is not valid JSON"**: Check for trailing commas, missing quotes,
or other JSON syntax errors. Run `carapace plugin validate <path>` for detailed
error messages.

**"additionalProperties not set to false"**: Every `arguments_schema` must have
`"additionalProperties": false`. This is a security requirement.

---

## Validation & Deployment

### Pre-flight Validation

Always validate your plugin before deploying:

```bash
carapace plugin validate plugins/my-plugin
```

This runs 6 validation stages:

1. **JSON syntax**: Is `manifest.json` valid JSON?
2. **Schema validation**: Does it conform to the manifest JSON Schema?
3. **Tool name uniqueness**: Are all tool names unique within the manifest?
4. **additionalProperties enforcement**: Do all argument schemas set it to false?
5. **Skill file check**: Does `skills/` contain at least one `.md` file?
6. **Risk level warnings**: Are any tools marked as `high` risk?

### Deployment

Copy your plugin directory into the Carapace plugins folder:

```bash
cp -r plugins/my-plugin ~/.carapace/plugins/my-plugin
```

User plugins in `~/.carapace/plugins/` override built-in plugins of the same
name. The plugin loader discovers plugins automatically on startup.

### Hot Reload (Development)

During development, use watch mode to auto-reload plugins when files change:

```bash
carapace start --watch
```

Changes to `manifest.json`, `handler.ts`, or skill files trigger a 4-stage
reload: validate → compile → unregister → register. The CLI shows color-coded
output for each stage.

---

## Security Considerations

### Never Trust Tool Arguments for Identity

Always use `PluginContext` for `group`, `sessionId`, and `correlationId`. The
container cannot be trusted to provide correct identity information.

### Validate All Inputs

Even though the core validates arguments against your schema, apply additional
validation in your handler for business rules (e.g. maximum array lengths,
valid enum values, string format checks).

### No Credential Leakage

Never include secrets, tokens, or API keys in tool results. The response
sanitizer catches common patterns, but defense-in-depth means your handler
should never put credentials in results in the first place.

Use `assertNoCredentialLeak()` in your tests to verify this automatically.

### Rate Limit Destructive Operations

For tools that modify state (store, delete, update), implement per-session rate
limits to prevent a runaway agent from causing damage. See the memory plugin
for the pattern.

### additionalProperties: false

Always set `"additionalProperties": false` on your argument schemas. This
prevents the container from injecting unexpected fields that your handler
might accidentally process.

### Error Message Safety

Never include stack traces, internal paths, or system details in error messages
returned to the container. Use `ToolError` for structured errors — the core
strips internals from non-ToolError exceptions automatically.
