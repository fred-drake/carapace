import { describe, it, expect } from 'vitest';
import { generateSettingsJson, computeContainerMounts } from './permission-lockdown.js';

// ---------------------------------------------------------------------------
// generateSettingsJson
// ---------------------------------------------------------------------------

describe('generateSettingsJson', () => {
  it('returns a valid JSON string', () => {
    const result = generateSettingsJson();
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('restricts Bash to only the ipc binary', () => {
    const settings = JSON.parse(generateSettingsJson());
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.allow).toContain('Bash(ipc *)');
  });

  it('denies all Bash commands by default', () => {
    const settings = JSON.parse(generateSettingsJson());
    expect(settings.permissions.deny).toContain('Bash');
  });

  it('does not include any other allow entries beyond ipc', () => {
    const settings = JSON.parse(generateSettingsJson());
    const bashAllows = settings.permissions.allow.filter((entry: string) =>
      entry.startsWith('Bash'),
    );
    expect(bashAllows).toHaveLength(1);
    expect(bashAllows[0]).toBe('Bash(ipc *)');
  });
});

// ---------------------------------------------------------------------------
// computeContainerMounts
// ---------------------------------------------------------------------------

describe('computeContainerMounts', () => {
  const defaultOptions = {
    socketPath: '/run/zmq/carapace.sock',
    workspacePath: '/host/groups/email',
    claudeDir: '/host/claude-sessions/abc123',
    settingsJson: '{"permissions":{}}',
    claudeMd: '# Agent instructions',
    skillFiles: [
      { hostPath: '/host/plugins/reminders/skill/reminders.md', name: 'reminders.md' },
      { hostPath: '/host/plugins/telegram/skill/telegram.md', name: 'telegram.md' },
    ],
  };

  it('includes the ZeroMQ socket mount as read-write', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const socketMount = mounts.find((m) => m.target === '/run/carapace.sock');
    expect(socketMount).toBeDefined();
    expect(socketMount!.source).toBe('/run/zmq/carapace.sock');
    expect(socketMount!.readonly).toBe(false);
  });

  it('includes the workspace mount as read-write', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const wsMount = mounts.find((m) => m.target === '/workspace/group');
    expect(wsMount).toBeDefined();
    expect(wsMount!.source).toBe('/host/groups/email');
    expect(wsMount!.readonly).toBe(false);
  });

  it('includes the .claude/ directory mount as read-write', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const claudeMount = mounts.find((m) => m.target === '/home/node/.claude/');
    expect(claudeMount).toBeDefined();
    expect(claudeMount!.source).toBe('/host/claude-sessions/abc123');
    expect(claudeMount!.readonly).toBe(false);
  });

  it('includes settings.json as a read-only mount', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const settingsMount = mounts.find((m) => m.target === '/home/node/.claude/settings.json');
    expect(settingsMount).toBeDefined();
    expect(settingsMount!.readonly).toBe(true);
  });

  it('includes CLAUDE.md as a read-only mount', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const claudeMdMount = mounts.find((m) => m.target === '/home/node/.claude/CLAUDE.md');
    expect(claudeMdMount).toBeDefined();
    expect(claudeMdMount!.readonly).toBe(true);
  });

  it('includes skill files as read-only mounts under /home/node/.claude/skills/', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const skillMounts = mounts.filter((m) => m.target.startsWith('/home/node/.claude/skills/'));
    expect(skillMounts).toHaveLength(2);
    expect(skillMounts.every((m) => m.readonly)).toBe(true);
    expect(skillMounts[0].target).toBe('/home/node/.claude/skills/reminders.md');
    expect(skillMounts[1].target).toBe('/home/node/.claude/skills/telegram.md');
  });

  it('orders mounts so .claude/ comes before read-only overlays', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const claudeDirIndex = mounts.findIndex((m) => m.target === '/home/node/.claude/');
    const settingsIndex = mounts.findIndex((m) => m.target === '/home/node/.claude/settings.json');
    const claudeMdIndex = mounts.findIndex((m) => m.target === '/home/node/.claude/CLAUDE.md');
    const skillIndices = mounts
      .map((m, i) => ({ target: m.target, i }))
      .filter((x) => x.target.startsWith('/home/node/.claude/skills/'))
      .map((x) => x.i);

    // The writable .claude/ must come before all read-only overlays
    expect(claudeDirIndex).toBeLessThan(settingsIndex);
    expect(claudeDirIndex).toBeLessThan(claudeMdIndex);
    for (const si of skillIndices) {
      expect(claudeDirIndex).toBeLessThan(si);
    }
  });

  it('works with zero skill files', () => {
    const mounts = computeContainerMounts({ ...defaultOptions, skillFiles: [] });
    const skillMounts = mounts.filter((m) => m.target.startsWith('/home/node/.claude/skills/'));
    expect(skillMounts).toHaveLength(0);
  });

  it('settings.json mount uses a generated temp path as source', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const settingsMount = mounts.find((m) => m.target === '/home/node/.claude/settings.json');
    // Source should be defined (the caller provides content; the mount function
    // returns a marker source that the container lifecycle will write to disk)
    expect(settingsMount!.source).toBeDefined();
    expect(typeof settingsMount!.source).toBe('string');
    expect(settingsMount!.source.length).toBeGreaterThan(0);
  });

  it('CLAUDE.md mount uses a generated temp path as source', () => {
    const mounts = computeContainerMounts(defaultOptions);
    const claudeMdMount = mounts.find((m) => m.target === '/home/node/.claude/CLAUDE.md');
    expect(claudeMdMount!.source).toBeDefined();
    expect(typeof claudeMdMount!.source).toBe('string');
    expect(claudeMdMount!.source.length).toBeGreaterThan(0);
  });
});
