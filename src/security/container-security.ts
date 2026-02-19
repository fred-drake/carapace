/**
 * Container security verification for Carapace.
 *
 * Defines the security constraints that the container must enforce and
 * provides static verification functions that analyze source artifacts
 * (Dockerfile, docker-compose.yml, runtime adapters, permission lockdown)
 * without requiring a running container.
 *
 * See docs/ARCHITECTURE.md §3 (Trust Model) for the full security model.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateSettingsJson, computeContainerMounts } from '../container/permission-lockdown.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityConstraint {
  id: string;
  name: string;
  description: string;
  category: 'filesystem' | 'network' | 'execution' | 'configuration';
}

export interface VerificationResult {
  check: string;
  pass: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Security constraints
// ---------------------------------------------------------------------------

export const SECURITY_CONSTRAINTS: SecurityConstraint[] = [
  {
    id: 'read-only-rootfs',
    name: 'Read-only root filesystem',
    description: 'Container root filesystem is mounted read-only to prevent binary tampering',
    category: 'filesystem',
  },
  {
    id: 'no-network',
    name: 'No network access',
    description: 'Container has no network access — DNS, HTTP, and raw sockets are blocked',
    category: 'network',
  },
  {
    id: 'ipc-only-executable',
    name: 'Only ipc binary is executable',
    description: 'Claude Code Bash is restricted to only invoke the ipc binary',
    category: 'execution',
  },
  {
    id: 'settings-json-read-only',
    name: 'settings.json is read-only',
    description: 'Permission lockdown file is a read-only overlay to prevent tampering',
    category: 'configuration',
  },
  {
    id: 'skills-claude-md-read-only',
    name: 'Skills and CLAUDE.md are read-only',
    description: 'Skill files and agent instructions are read-only overlays',
    category: 'configuration',
  },
  {
    id: 'limited-writable-mounts',
    name: 'Writable mounts are limited',
    description: 'Only workspace, .claude/ session dirs, and ZeroMQ socket are writable',
    category: 'filesystem',
  },
  {
    id: 'no-package-managers',
    name: 'No package managers or extra shells',
    description: 'No apt, pip, npm, or other package managers available in the container',
    category: 'execution',
  },
];

// ---------------------------------------------------------------------------
// Dockerfile verification
// ---------------------------------------------------------------------------

export function verifyDockerfile(dockerfile: string): VerificationResult[] {
  const lines = dockerfile.split('\n');
  const results: VerificationResult[] = [];

  // Check non-root USER
  const userLine = lines.find((l) => l.startsWith('USER '));
  results.push({
    check: 'non-root-user',
    pass: !!userLine && !userLine.includes('root'),
    detail: userLine ? `Found: ${userLine.trim()}` : 'No USER directive found',
  });

  // Check ipc binary in PATH
  const hasIpc = lines.some(
    (l) => l.includes('ipc') && (l.includes('ln -s') || l.includes('printf') || l.includes('echo')),
  );
  results.push({
    check: 'ipc-binary-in-path',
    pass: hasIpc,
    detail: hasIpc ? 'ipc binary wrapper found' : 'No ipc binary creation found',
  });

  // Check writable directories for read-only root
  const hasWorkspace = lines.some((l) => l.includes('mkdir') && l.includes('/workspace'));
  const hasClaude = lines.some((l) => l.includes('mkdir') && l.includes('.claude'));
  results.push({
    check: 'writable-dirs-created',
    pass: hasWorkspace && hasClaude,
    detail: `workspace: ${hasWorkspace}, .claude: ${hasClaude}`,
  });

  // Check entrypoint is set
  const entrypointLine = lines.find((l) => l.startsWith('ENTRYPOINT'));
  results.push({
    check: 'entrypoint-set',
    pass: !!entrypointLine && entrypointLine.includes('entrypoint.sh'),
    detail: entrypointLine ? `Found: ${entrypointLine.trim()}` : 'No ENTRYPOINT directive found',
  });

  // Check no EXPOSE (no ports needed — communication via Unix socket)
  const hasExpose = lines.some((l) => l.startsWith('EXPOSE '));
  results.push({
    check: 'no-expose',
    pass: !hasExpose,
    detail: hasExpose ? 'EXPOSE directive found — ports should not be exposed' : 'No EXPOSE found',
  });

  // Check no CMD override
  const hasCmdInRuntime = lines.some((l) => l.startsWith('CMD '));
  // Allow CMD in builder stage but not runtime — check if CMD appears after runtime FROM
  const runtimeFromIdx = lines.findIndex((l) => l.startsWith('FROM') && l.includes('AS runtime'));
  const cmdAfterRuntime =
    runtimeFromIdx >= 0
      ? lines.slice(runtimeFromIdx).some((l) => l.startsWith('CMD '))
      : hasCmdInRuntime;
  results.push({
    check: 'no-cmd-override',
    pass: !cmdAfterRuntime,
    detail: cmdAfterRuntime
      ? 'CMD found in runtime stage — could override entrypoint security'
      : 'No CMD in runtime stage',
  });

  return results;
}

// ---------------------------------------------------------------------------
// Docker Compose verification
// ---------------------------------------------------------------------------

export function verifyDockerCompose(compose: string): VerificationResult[] {
  const results: VerificationResult[] = [];

  // Check agent read_only: true
  const hasReadOnly = /read_only:\s*true/.test(compose);
  results.push({
    check: 'agent-read-only',
    pass: hasReadOnly,
    detail: hasReadOnly
      ? 'Agent service has read_only: true'
      : 'Agent service missing read_only: true',
  });

  // Check network is internal
  const hasInternal = /internal:\s*true/.test(compose);
  results.push({
    check: 'network-internal',
    pass: hasInternal,
    detail: hasInternal ? 'Network is internal: true' : 'Network not marked as internal',
  });

  // Check skills are mounted read-only
  const skillsRo = /skills.*:ro/.test(compose);
  results.push({
    check: 'skills-read-only',
    pass: skillsRo,
    detail: skillsRo ? 'Skills mount is :ro' : 'Skills mount not read-only',
  });

  // Check tmpfs has size limits
  const tmpfsLines = compose.match(/- \/tmp:.*|\/tmp:size=/g) || [];
  const hasTmpfsSizeLimit = tmpfsLines.some((l) => l.includes('size='));
  results.push({
    check: 'tmpfs-size-limits',
    pass: hasTmpfsSizeLimit,
    detail: hasTmpfsSizeLimit ? 'tmpfs mounts have size limits' : 'tmpfs mounts lack size limits',
  });

  return results;
}

// ---------------------------------------------------------------------------
// Permission lockdown verification
// ---------------------------------------------------------------------------

export function verifyPermissionLockdown(): VerificationResult[] {
  const results: VerificationResult[] = [];

  const settingsJson = generateSettingsJson();
  const settings = JSON.parse(settingsJson);
  const permissions = settings.permissions || {};
  const allow = permissions.allow || [];
  const deny = permissions.deny || [];

  // Check Bash is denied
  results.push({
    check: 'bash-denied',
    pass: deny.includes('Bash'),
    detail: deny.includes('Bash') ? 'Bash is in deny list' : `Deny list: ${JSON.stringify(deny)}`,
  });

  // Check ipc is allowed
  const hasIpcAllow = allow.some((a: string) => a.includes('ipc'));
  results.push({
    check: 'ipc-allowed',
    pass: hasIpcAllow,
    detail: hasIpcAllow
      ? `ipc allowed via: ${allow.find((a: string) => a.includes('ipc'))}`
      : `Allow list: ${JSON.stringify(allow)}`,
  });

  // Check no extra allows beyond ipc
  const nonIpcAllows = allow.filter((a: string) => !a.includes('ipc'));
  results.push({
    check: 'no-extra-allows',
    pass: nonIpcAllows.length === 0,
    detail:
      nonIpcAllows.length === 0
        ? 'Only ipc is in allow list'
        : `Extra allows found: ${JSON.stringify(nonIpcAllows)}`,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Runtime adapter verification
// ---------------------------------------------------------------------------

export function verifyRuntimeAdapters(projectRoot: string): VerificationResult[] {
  const results: VerificationResult[] = [];

  const dockerRuntime = fs.readFileSync(
    path.join(projectRoot, 'src/core/container/docker-runtime.ts'),
    'utf-8',
  );
  const podmanRuntime = fs.readFileSync(
    path.join(projectRoot, 'src/core/container/podman-runtime.ts'),
    'utf-8',
  );

  // Docker --read-only
  const dockerReadOnly = dockerRuntime.includes("'--read-only'");
  results.push({
    check: 'docker-read-only',
    pass: dockerReadOnly,
    detail: dockerReadOnly
      ? 'Docker adapter pushes --read-only flag'
      : 'Docker adapter missing --read-only flag',
  });

  // Docker --network none
  const dockerNetworkNone =
    dockerRuntime.includes("'--network'") && dockerRuntime.includes("'none'");
  results.push({
    check: 'docker-network-none',
    pass: dockerNetworkNone,
    detail: dockerNetworkNone
      ? 'Docker adapter pushes --network none'
      : 'Docker adapter missing --network none',
  });

  // Podman --read-only
  const podmanReadOnly = podmanRuntime.includes("'--read-only'");
  results.push({
    check: 'podman-read-only',
    pass: podmanReadOnly,
    detail: podmanReadOnly
      ? 'Podman adapter pushes --read-only flag'
      : 'Podman adapter missing --read-only flag',
  });

  // Podman --network none
  const podmanNetworkNone =
    podmanRuntime.includes("'--network'") && podmanRuntime.includes("'none'");
  results.push({
    check: 'podman-network-none',
    pass: podmanNetworkNone,
    detail: podmanNetworkNone
      ? 'Podman adapter pushes --network none'
      : 'Podman adapter missing --network none',
  });

  // Mount ordering: writable .claude/ must come before read-only overlays
  const mounts = computeContainerMounts({
    socketPath: '/tmp/test.sock',
    workspacePath: '/tmp/workspace',
    claudeDir: '/tmp/.claude',
    settingsJson: '{}',
    claudeMd: '# test',
    skillFiles: [{ hostPath: '/tmp/skill.md', name: 'skill.md' }],
  });

  const claudeDirIdx = mounts.findIndex((m) => m.target.endsWith('.claude/') && !m.readonly);
  const settingsIdx = mounts.findIndex((m) => m.target.includes('settings.json') && m.readonly);
  const claudeMdIdx = mounts.findIndex((m) => m.target.includes('CLAUDE.md') && m.readonly);
  const skillsIdx = mounts.findIndex((m) => m.target.includes('skills/') && m.readonly);

  const orderCorrect =
    claudeDirIdx >= 0 &&
    settingsIdx >= 0 &&
    claudeMdIdx >= 0 &&
    skillsIdx >= 0 &&
    claudeDirIdx < settingsIdx &&
    claudeDirIdx < claudeMdIdx &&
    claudeDirIdx < skillsIdx;

  results.push({
    check: 'mount-ordering',
    pass: orderCorrect,
    detail: orderCorrect
      ? `Writable .claude/ at index ${claudeDirIdx}, read-only overlays after`
      : `Mount ordering issue: .claude/=${claudeDirIdx}, settings=${settingsIdx}, CLAUDE.md=${claudeMdIdx}, skills=${skillsIdx}`,
  });

  return results;
}
