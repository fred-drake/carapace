---
Last Updated: 2026-03-03
Version: 1.0.0
---

# Bug Reference

Known bugs, root causes, solutions, and prevention strategies.

---

## BUG-001: EventBus not wired to PluginLoader

**Status**: Fixed (PR #184)

**Symptom**: Channel plugins (those declaring `provides.channels` in their
manifest) receive plain `CoreServices` instead of `ChannelServices`. Calls to
`publishEvent()` fail because the method does not exist on the services object.

**Root cause**: `server.ts` constructed `PluginLoader` without passing the
`eventBus` parameter. The `initializeWithTimeout()` method checks
`isChannelPlugin && this.eventBus` — since `this.eventBus` was `undefined`,
channel plugins were never upgraded to `ChannelServices`.

**Fix**: Added `eventBus: this.eventBus ?? undefined` to the `PluginLoader`
constructor call in `server.ts`.

**Prevention**: When adding new fields to `PluginLoader`'s constructor options,
verify they are also threaded through `Server.start()`. The wiring checklist in
CLAUDE.md covers `ServerConfig`/`ServerDeps` but should also mention
`PluginLoader` options.
