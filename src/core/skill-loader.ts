/**
 * Skill file loader for Carapace.
 *
 * Reads container-side skill markdown files from plugin directories
 * and prepares them for injection into the container's `.claude/`
 * directory. Also auto-generates skill files for core intrinsic tools.
 *
 * Skills teach Claude what tools are available and how to invoke them
 * via the `ipc` binary.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A skill file prepared for container injection. */
export interface SkillFile {
  /** Plugin that owns this skill (or '_intrinsic' for core tools). */
  pluginName: string;
  /** Filename of the skill (e.g. 'reminders.md'). */
  filename: string;
  /** Markdown content of the skill. */
  content: string;
  /** Target path inside the container (relative to workspace root). */
  containerPath: string;
}

/** Result of skill discovery. */
export interface SkillLoadResult {
  /** Successfully loaded skill files. */
  skills: SkillFile[];
  /** Non-fatal warnings (e.g. missing skills directory). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Intrinsic tool skill templates
// ---------------------------------------------------------------------------

const INTRINSIC_SKILL_TEMPLATES: Record<string, string> = {
  get_diagnostics: `# get_diagnostics

Query the session-scoped audit log for diagnostic information.

## Usage

\`\`\`bash
ipc tool.invoke.get_diagnostics '{"correlation": "<correlation-id>"}'
\`\`\`

## Arguments

- \`correlation\` (string, optional): Filter by correlation ID to trace a specific request lifecycle.
- \`last_n\` (number, optional): Return the N most recent entries. Defaults to 10.

## When to use

- When a tool invocation returns an error and you need to understand what went wrong.
- When you want to trace the full lifecycle of a specific request by its correlation ID.
- When you need to check recent errors in the current session.

## Notes

- Results are automatically scoped to the current session and group.
- The audit log shows validation stages, routing decisions, and error details.
`,

  list_tools: `# list_tools

Enumerate all available tools with their descriptions and risk levels.

## Usage

\`\`\`bash
ipc tool.invoke.list_tools '{}'
\`\`\`

## Arguments

None required.

## When to use

- At the start of a session to discover what tools are available.
- When you need to check the exact name or description of a tool.
- When you want to see which tools require user confirmation (risk_level: "high").

## Notes

- Returns both plugin-provided tools and core intrinsic tools.
- Each tool entry includes: name, description, and risk_level.
`,

  get_session_info: `# get_session_info

Return information about the current session.

## Usage

\`\`\`bash
ipc tool.invoke.get_session_info '{}'
\`\`\`

## Arguments

None required.

## When to use

- To check which group this session belongs to.
- To check plugin health status (which plugins loaded successfully vs failed).
- To diagnose issues when tools seem unavailable.

## Notes

- Returns: group name, session start time, and plugin health.
- Plugin health shows two categories: healthy (loaded successfully) and failed (with error category).
- Failed plugins' tools are unavailable — use this to understand why a tool might not be found.
`,
};

// ---------------------------------------------------------------------------
// Core intrinsic skill generation
// ---------------------------------------------------------------------------

/**
 * Generate a skill file for a core intrinsic tool.
 *
 * @throws If the tool name is not a known intrinsic.
 */
export function generateIntrinsicSkill(toolName: string): SkillFile {
  const template = INTRINSIC_SKILL_TEMPLATES[toolName];
  if (!template) {
    throw new Error(
      `Unknown intrinsic tool: "${toolName}". ` +
        `Known intrinsics: ${Object.keys(INTRINSIC_SKILL_TEMPLATES).join(', ')}`,
    );
  }
  return {
    pluginName: '_intrinsic',
    filename: `${toolName}.md`,
    content: template,
    containerPath: `.claude/skills/_intrinsic/${toolName}.md`,
  };
}

/** Pre-generated skill files for all core intrinsic tools. */
export const INTRINSIC_TOOL_SKILLS: readonly SkillFile[] =
  Object.keys(INTRINSIC_SKILL_TEMPLATES).map(generateIntrinsicSkill);

// ---------------------------------------------------------------------------
// SkillLoader
// ---------------------------------------------------------------------------

export class SkillLoader {
  private readonly pluginsDir: string;

  constructor(opts: { pluginsDir: string }) {
    this.pluginsDir = opts.pluginsDir;
  }

  /**
   * Discover skill files for the given plugin names.
   *
   * Scans `{pluginsDir}/{pluginName}/skills/` for `.md` files.
   * Missing directories or empty skills folders produce warnings,
   * not errors — the system continues without those skills.
   */
  async discoverSkills(pluginNames: string[]): Promise<SkillLoadResult> {
    const skills: SkillFile[] = [];
    const warnings: string[] = [];

    for (const pluginName of pluginNames) {
      const skillsDir = join(this.pluginsDir, pluginName, 'skills');

      // Check if skills directory exists
      try {
        await access(skillsDir);
      } catch {
        warnings.push(
          `Plugin "${pluginName}" has no skills/ directory — ` +
            `no skill files will be available for this plugin`,
        );
        continue;
      }

      // Read skill files
      let entries: string[];
      try {
        entries = await readdir(skillsDir);
      } catch {
        warnings.push(`Plugin "${pluginName}": could not read skills/ directory`);
        continue;
      }

      // Filter to .md files only
      const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();

      if (mdFiles.length === 0) {
        warnings.push(`Plugin "${pluginName}" has an empty skills/ directory`);
        continue;
      }

      for (const filename of mdFiles) {
        const filePath = join(skillsDir, filename);
        const content = await readFile(filePath, 'utf-8');
        skills.push({
          pluginName,
          filename,
          content,
          containerPath: `.claude/skills/${pluginName}/${filename}`,
        });
      }
    }

    // Sort by pluginName, then filename
    skills.sort((a, b) => {
      const pluginCmp = a.pluginName.localeCompare(b.pluginName);
      if (pluginCmp !== 0) return pluginCmp;
      return a.filename.localeCompare(b.filename);
    });

    return { skills, warnings };
  }

  /**
   * Collect all skill files: plugin skills + intrinsic tool skills.
   *
   * This is the main entry point for container setup — it returns
   * everything that needs to be mounted into the container's
   * `.claude/skills/` directory.
   */
  async collectAllSkills(pluginNames: string[]): Promise<SkillLoadResult> {
    const { skills: pluginSkills, warnings } = await this.discoverSkills(pluginNames);

    // Combine plugin skills with intrinsic skills
    const allSkills = [...pluginSkills, ...INTRINSIC_TOOL_SKILLS];

    return { skills: allSkills, warnings };
  }
}
