import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SkillLoader,
  type SkillFile,
  type SkillLoadResult,
  generateIntrinsicSkill,
  INTRINSIC_TOOL_SKILLS,
} from './skill-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPluginDir(
  root: string,
  pluginName: string,
  skills: Record<string, string>,
): Promise<string> {
  const pluginDir = join(root, pluginName);
  const skillsDir = join(pluginDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  for (const [filename, content] of Object.entries(skills)) {
    await writeFile(join(skillsDir, filename), content, 'utf-8');
  }
  return pluginDir;
}

// ---------------------------------------------------------------------------
// SkillFile type
// ---------------------------------------------------------------------------

describe('SkillFile', () => {
  it('has required fields', () => {
    const skill: SkillFile = {
      pluginName: 'reminders',
      filename: 'reminders.md',
      content: '# Reminders',
      containerPath: '.claude/skills/reminders.md',
    };
    expect(skill.pluginName).toBe('reminders');
    expect(skill.filename).toBe('reminders.md');
    expect(skill.content).toBe('# Reminders');
    expect(skill.containerPath).toBe('.claude/skills/reminders.md');
  });
});

// ---------------------------------------------------------------------------
// discoverSkills()
// ---------------------------------------------------------------------------

describe('SkillLoader.discoverSkills', () => {
  let testRoot: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `carapace-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testRoot, { recursive: true });
    loader = new SkillLoader({ pluginsDir: testRoot });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('discovers skill files from plugin directories', async () => {
    await createPluginDir(testRoot, 'reminders', {
      'reminders.md': '# Reminders\nManage reminders.',
    });

    const result = await loader.discoverSkills(['reminders']);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.pluginName).toBe('reminders');
    expect(result.skills[0]!.filename).toBe('reminders.md');
    expect(result.skills[0]!.content).toBe('# Reminders\nManage reminders.');
  });

  it('discovers multiple skill files from a single plugin', async () => {
    await createPluginDir(testRoot, 'calendar', {
      'calendar.md': '# Calendar',
      'events.md': '# Events',
    });

    const result = await loader.discoverSkills(['calendar']);
    expect(result.skills).toHaveLength(2);
    const filenames = result.skills.map((s) => s.filename).sort();
    expect(filenames).toEqual(['calendar.md', 'events.md']);
  });

  it('discovers skills from multiple plugins', async () => {
    await createPluginDir(testRoot, 'reminders', {
      'reminders.md': '# Reminders',
    });
    await createPluginDir(testRoot, 'calendar', {
      'calendar.md': '# Calendar',
    });

    const result = await loader.discoverSkills(['reminders', 'calendar']);
    expect(result.skills).toHaveLength(2);
    const plugins = result.skills.map((s) => s.pluginName).sort();
    expect(plugins).toEqual(['calendar', 'reminders']);
  });

  it('warns when plugin has no skills directory', async () => {
    const pluginDir = join(testRoot, 'no-skills');
    await mkdir(pluginDir, { recursive: true });
    // No skills/ subdirectory created

    const result = await loader.discoverSkills(['no-skills']);
    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no-skills/);
    expect(result.warnings[0]).toMatch(/skills/i);
  });

  it('warns when skills directory is empty', async () => {
    const skillsDir = join(testRoot, 'empty-plugin', 'skills');
    await mkdir(skillsDir, { recursive: true });

    const result = await loader.discoverSkills(['empty-plugin']);
    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/empty-plugin/);
  });

  it('only reads .md files from skills directory', async () => {
    await createPluginDir(testRoot, 'mixed', {
      'tool.md': '# Tool',
    });
    // Also write a non-md file
    await writeFile(join(testRoot, 'mixed', 'skills', 'notes.txt'), 'not a skill');

    const result = await loader.discoverSkills(['mixed']);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.filename).toBe('tool.md');
  });

  it('does not crash when plugin directory does not exist', async () => {
    const result = await loader.discoverSkills(['nonexistent']);
    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/nonexistent/);
  });

  it('sets containerPath to .claude/skills/{pluginName}/{filename}', async () => {
    await createPluginDir(testRoot, 'reminders', {
      'reminders.md': '# Reminders',
    });

    const result = await loader.discoverSkills(['reminders']);
    expect(result.skills[0]!.containerPath).toBe('.claude/skills/reminders/reminders.md');
  });

  it('returns sorted skills by pluginName then filename', async () => {
    await createPluginDir(testRoot, 'beta', {
      'z.md': '# Z',
      'a.md': '# A',
    });
    await createPluginDir(testRoot, 'alpha', {
      'b.md': '# B',
    });

    const result = await loader.discoverSkills(['beta', 'alpha']);
    expect(result.skills.map((s) => `${s.pluginName}/${s.filename}`)).toEqual([
      'alpha/b.md',
      'beta/a.md',
      'beta/z.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// generateIntrinsicSkill()
// ---------------------------------------------------------------------------

describe('generateIntrinsicSkill', () => {
  it('generates skill for get_diagnostics', () => {
    const skill = generateIntrinsicSkill('get_diagnostics');
    expect(skill.pluginName).toBe('_intrinsic');
    expect(skill.filename).toBe('get_diagnostics.md');
    expect(skill.containerPath).toBe('.claude/skills/_intrinsic/get_diagnostics.md');
    expect(skill.content).toContain('get_diagnostics');
    expect(skill.content).toContain('ipc');
  });

  it('generates skill for list_tools', () => {
    const skill = generateIntrinsicSkill('list_tools');
    expect(skill.pluginName).toBe('_intrinsic');
    expect(skill.filename).toBe('list_tools.md');
    expect(skill.content).toContain('list_tools');
  });

  it('generates skill for get_session_info', () => {
    const skill = generateIntrinsicSkill('get_session_info');
    expect(skill.pluginName).toBe('_intrinsic');
    expect(skill.filename).toBe('get_session_info.md');
    expect(skill.content).toContain('get_session_info');
  });

  it('throws for unknown intrinsic tool name', () => {
    expect(() => generateIntrinsicSkill('unknown_tool')).toThrow(/unknown.*intrinsic/i);
  });
});

// ---------------------------------------------------------------------------
// INTRINSIC_TOOL_SKILLS
// ---------------------------------------------------------------------------

describe('INTRINSIC_TOOL_SKILLS', () => {
  it('has entries for all three core intrinsic tools', () => {
    expect(INTRINSIC_TOOL_SKILLS).toHaveLength(3);
    const names = INTRINSIC_TOOL_SKILLS.map((s) => s.filename);
    expect(names).toContain('get_diagnostics.md');
    expect(names).toContain('list_tools.md');
    expect(names).toContain('get_session_info.md');
  });

  it('all intrinsic skills belong to _intrinsic plugin', () => {
    for (const skill of INTRINSIC_TOOL_SKILLS) {
      expect(skill.pluginName).toBe('_intrinsic');
    }
  });

  it('all intrinsic skills have valid containerPaths', () => {
    for (const skill of INTRINSIC_TOOL_SKILLS) {
      expect(skill.containerPath).toMatch(/^\.claude\/skills\/_intrinsic\//);
    }
  });
});

// ---------------------------------------------------------------------------
// collectAllSkills()
// ---------------------------------------------------------------------------

describe('SkillLoader.collectAllSkills', () => {
  let testRoot: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `carapace-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testRoot, { recursive: true });
    loader = new SkillLoader({ pluginsDir: testRoot });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('includes both plugin skills and intrinsic skills', async () => {
    await createPluginDir(testRoot, 'reminders', {
      'reminders.md': '# Reminders',
    });

    const result = await loader.collectAllSkills(['reminders']);
    const pluginSkills = result.skills.filter((s) => s.pluginName === 'reminders');
    const intrinsicSkills = result.skills.filter((s) => s.pluginName === '_intrinsic');
    expect(pluginSkills).toHaveLength(1);
    expect(intrinsicSkills).toHaveLength(3);
  });

  it('includes intrinsic skills even with no plugins', async () => {
    const result = await loader.collectAllSkills([]);
    expect(result.skills).toHaveLength(3);
    expect(result.skills.every((s) => s.pluginName === '_intrinsic')).toBe(true);
  });

  it('propagates warnings from plugin skill discovery', async () => {
    const pluginDir = join(testRoot, 'no-skills');
    await mkdir(pluginDir, { recursive: true });

    const result = await loader.collectAllSkills(['no-skills']);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/no-skills/);
  });

  it('does not duplicate intrinsic skills', async () => {
    const result = await loader.collectAllSkills([]);
    const intrinsicNames = result.skills
      .filter((s) => s.pluginName === '_intrinsic')
      .map((s) => s.filename);
    const unique = new Set(intrinsicNames);
    expect(unique.size).toBe(intrinsicNames.length);
  });
});
