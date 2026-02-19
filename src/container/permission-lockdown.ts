/**
 * Container permission lockdown (Layer 2).
 *
 * Generates the Claude Code settings.json that restricts Bash to only the
 * `ipc` binary, and computes the volume mounts needed to enforce read-only
 * overlays for settings.json, CLAUDE.md, and skill files inside the container.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillFile {
  /** Absolute path on the host to the skill markdown file. */
  hostPath: string;
  /** Filename (e.g. "reminders.md") used as the mount target name. */
  name: string;
}

export interface ContainerMountOptions {
  /** Host path to the ZeroMQ Unix domain socket. */
  socketPath: string;
  /** Host path to the group workspace directory. */
  workspacePath: string;
  /** Host path to the .claude/ session directory. */
  claudeDir: string;
  /** Generated settings.json content (will be written to a temp file). */
  settingsJson: string;
  /** Generated CLAUDE.md content (will be written to a temp file). */
  claudeMd: string;
  /** Skill files to mount into the container. */
  skillFiles: SkillFile[];
}

export interface ContainerMount {
  source: string;
  target: string;
  readonly: boolean;
}

// ---------------------------------------------------------------------------
// Container paths (constants)
// ---------------------------------------------------------------------------

const CONTAINER_SOCKET_PATH = '/run/carapace.sock';
const CONTAINER_WORKSPACE_PATH = '/workspace/group';
const CONTAINER_CLAUDE_DIR = '/home/node/.claude/';
const CONTAINER_SETTINGS_PATH = '/home/node/.claude/settings.json';
const CONTAINER_CLAUDE_MD_PATH = '/home/node/.claude/CLAUDE.md';
const CONTAINER_SKILLS_DIR = '/home/node/.claude/skills/';

// ---------------------------------------------------------------------------
// generateSettingsJson
// ---------------------------------------------------------------------------

/**
 * Generate the Claude Code settings.json content that restricts Bash
 * to only the `ipc` binary.
 *
 * The `deny` list blocks all Bash commands. The `allow` list permits
 * only `ipc *` — any invocation of the ipc binary with arguments.
 */
export function generateSettingsJson(): string {
  const settings = {
    permissions: {
      allow: ['Bash(ipc *)'],
      deny: ['Bash'],
    },
  };
  return JSON.stringify(settings, null, 2);
}

// ---------------------------------------------------------------------------
// computeContainerMounts
// ---------------------------------------------------------------------------

/**
 * Compute the ordered list of volume mounts for the agent container.
 *
 * Mount ordering matters: the writable `.claude/` directory mount must come
 * BEFORE the read-only overlays (settings.json, CLAUDE.md, skills/) so that
 * container runtimes apply the overlays on top of the writable directory.
 *
 * The settings.json and CLAUDE.md content is provided as strings. The caller
 * is responsible for writing them to temp files on the host before spawning
 * the container. The `source` field for these mounts uses a marker path
 * that the container lifecycle manager will resolve to the actual temp file.
 */
export function computeContainerMounts(options: ContainerMountOptions): ContainerMount[] {
  const mounts: ContainerMount[] = [];

  // 1. ZeroMQ socket (read-write for bidirectional IPC)
  mounts.push({
    source: options.socketPath,
    target: CONTAINER_SOCKET_PATH,
    readonly: false,
  });

  // 2. Group workspace (read-write for agent work files)
  mounts.push({
    source: options.workspacePath,
    target: CONTAINER_WORKSPACE_PATH,
    readonly: false,
  });

  // 3. Writable .claude/ directory (session state, transcripts, logs)
  //    MUST come before read-only overlays
  mounts.push({
    source: options.claudeDir,
    target: CONTAINER_CLAUDE_DIR,
    readonly: false,
  });

  // 4. Read-only settings.json overlay (Layer 2 permission lockdown)
  mounts.push({
    source: `${options.claudeDir}/settings.json`,
    target: CONTAINER_SETTINGS_PATH,
    readonly: true,
  });

  // 5. Read-only CLAUDE.md overlay (agent instructions)
  mounts.push({
    source: `${options.claudeDir}/CLAUDE.md`,
    target: CONTAINER_CLAUDE_MD_PATH,
    readonly: true,
  });

  // 6. Read-only skill file overlays
  for (const skill of options.skillFiles) {
    mounts.push({
      source: skill.hostPath,
      target: `${CONTAINER_SKILLS_DIR}${skill.name}`,
      readonly: true,
    });
  }

  return mounts;
}
