import { describe, it, expect, vi } from 'vitest';
import { runPrompt, PROMPTS_DIR_NAME, type PromptDeps } from './prompt-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<PromptDeps>): PromptDeps {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
    home: '/tmp/test-carapace-home',
    readPidFile: vi.fn().mockReturnValue(12345),
    processExists: vi.fn().mockReturnValue(true),
    writeFile: vi.fn(),
    ensureDir: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPrompt', () => {
  it('writes a prompt file and returns 0', () => {
    const deps = createTestDeps();
    const code = runPrompt(deps, 'summarize my emails', 'default');
    expect(code).toBe(0);
    expect(deps.writeFile).toHaveBeenCalledOnce();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('Prompt submitted'));
  });

  it('creates the prompts directory', () => {
    const deps = createTestDeps();
    runPrompt(deps, 'do something', 'default');
    expect(deps.ensureDir).toHaveBeenCalledWith(expect.stringContaining(PROMPTS_DIR_NAME));
  });

  it('writes a valid JSON event envelope', () => {
    const deps = createTestDeps();
    runPrompt(deps, 'my prompt', 'email');

    const writtenPath = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;

    expect(writtenPath).toMatch(/\.json$/);
    expect(writtenPath).toContain(PROMPTS_DIR_NAME);

    const envelope = JSON.parse(writtenContent);
    expect(envelope.type).toBe('event');
    expect(envelope.topic).toBe('task.triggered');
    expect(envelope.source).toBe('cli');
    expect(envelope.group).toBe('email');
    expect(envelope.payload.prompt).toBe('my prompt');
    expect(envelope.version).toBe(1);
    expect(envelope.id).toBeDefined();
    expect(envelope.timestamp).toBeDefined();
  });

  it('prints the event ID on success', () => {
    const deps = createTestDeps();
    runPrompt(deps, 'hello', 'default');

    const stdoutCalls = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.flat();
    const idMessage = stdoutCalls.find((msg: string) => msg.includes('Prompt submitted'));
    expect(idMessage).toBeDefined();
    // Should contain a UUID-like pattern
    expect(idMessage).toMatch(/[0-9a-f-]{36}/);
  });

  it('prints the group on success', () => {
    const deps = createTestDeps();
    runPrompt(deps, 'hello', 'slack');

    expect(deps.stdout).toHaveBeenCalledWith('  Group: slack');
  });

  it('returns 1 when prompt text is empty', () => {
    const deps = createTestDeps();
    const code = runPrompt(deps, '', 'default');
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('returns 1 when Carapace is not running (no PID file)', () => {
    const deps = createTestDeps({
      readPidFile: vi.fn().mockReturnValue(null),
    });
    const code = runPrompt(deps, 'do something', 'default');
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('not running'));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('returns 1 when Carapace process is dead (stale PID)', () => {
    const deps = createTestDeps({
      processExists: vi.fn().mockReturnValue(false),
    });
    const code = runPrompt(deps, 'do something', 'default');
    expect(code).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('stale PID'));
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('generates unique file names for each prompt', () => {
    const deps = createTestDeps();
    runPrompt(deps, 'first', 'default');
    runPrompt(deps, 'second', 'default');

    const calls = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const path1 = calls[0][0] as string;
    const path2 = calls[1][0] as string;
    expect(path1).not.toBe(path2);
  });

  it('uses default group when group is "default"', () => {
    const deps = createTestDeps();
    runPrompt(deps, 'hello', 'default');

    const content = JSON.parse(
      (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
    );
    expect(content.group).toBe('default');
  });
});
