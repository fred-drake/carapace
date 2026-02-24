# Handler API Reference

## Imports

```typescript
import type {
  PluginHandler,
  CoreServices,
  PluginContext,
  ToolInvocationResult,
} from '@carapace/core/plugin';
```

## PluginHandler Interface

```typescript
interface PluginHandler {
  initialize(services: CoreServices): Promise<void>;
  handleToolInvocation(
    tool: string,
    args: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ToolInvocationResult>;
  shutdown(): Promise<void>;

  // Optional:
  handleEvent?(envelope: EventEnvelope): Promise<void>;
  resolveSession?(event: EventEnvelope, sessions: SessionLookup): Promise<string | null>;
  verify?(): Promise<PluginVerifyResult>; // max 10 seconds, non-destructive
}
```

## Export Pattern

Default export (preferred):

```typescript
const handler: PluginHandler = { ... };
export default handler;
```

Named export also accepted: `export { handler };`

## ToolInvocationResult

Discriminated union — MUST use `as const` on the `ok` field:

```typescript
// Success
return { ok: true as const, result: { greeting: `Hello, ${name}!` } };

// Error
return {
  ok: false,
  error: {
    code: 'HANDLER_ERROR', // or ErrorCode.HANDLER_ERROR
    message: 'What went wrong',
    retriable: false,
    // field?: 'argName',       // which argument caused the error
    // retry_after?: 30,        // seconds to wait
  },
};
```

## CoreServices (available in initialize())

```typescript
interface CoreServices {
  getAuditLog(filters: AuditLogFilter): Promise<AuditLogEntry[]>;
  getToolCatalog(): ToolDeclaration[];
  getSessionInfo(): SessionInfo; // scoped to current group
  readCredential(key: string): string; // reads $CARAPACE_HOME/credentials/plugins/{pluginName}/{key}
}
```

Channel plugins (those with `provides.channels.length > 0`) receive `ChannelServices`
which adds `publishEvent()`.

## PluginContext (per-invocation)

```typescript
interface PluginContext {
  group: string;
  sessionId: string;
  correlationId: string;
  timestamp: string; // ISO 8601
}
```

## Structured Errors (ToolError)

For richer error handling, throw `ToolError` instead of returning error objects:

```typescript
import { ToolError, ErrorCode } from '@carapace/core/plugin';

throw new ToolError({
  code: ErrorCode.HANDLER_ERROR,
  message: 'API rate limit exceeded',
  retriable: true,
  retry_after: 60,
});
```

The core catches `ToolError` and converts it to a structured response. Any other thrown
error becomes a generic `PLUGIN_ERROR` with no internals leaked.

Reserved pipeline codes (`UNKNOWN_TOOL`, `VALIDATION_FAILED`, `UNAUTHORIZED`,
`RATE_LIMITED`, `CONFIRMATION_TIMEOUT`, `CONFIRMATION_DENIED`) are normalized to
`HANDLER_ERROR` if thrown by a handler.

## Multi-Tool Handler Pattern

```typescript
async handleToolInvocation(tool, args, context) {
  switch (tool) {
    case 'my_search': return this.handleSearch(args, context);
    case 'my_create': return this.handleCreate(args, context);
    default:
      return {
        ok: false,
        error: { code: 'HANDLER_ERROR', message: `Unknown tool: ${tool}`, retriable: false },
      };
  }
}
```
