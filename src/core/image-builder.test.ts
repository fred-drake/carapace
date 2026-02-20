import { describe, it, expect, vi } from 'vitest';
import { buildImage, type ImageBuilderDeps } from './image-builder.js';
import type { ContainerRuntime } from './container/runtime.js';
import {
  LABEL_REVISION,
  LABEL_VERSION,
  LABEL_CLAUDE_VERSION,
  LABEL_CREATED,
} from './image-identity.js';

const DEFAULT_LABELS = {
  [LABEL_REVISION]: 'abc1234',
  [LABEL_VERSION]: '0.0.1',
  [LABEL_CLAUDE_VERSION]: 'latest',
  [LABEL_CREATED]: '2026-02-20T00:00:00.000Z',
};

function createMockDeps(overrides?: Partial<ImageBuilderDeps>): ImageBuilderDeps {
  return {
    runtime: {
      name: 'docker',
      isAvailable: vi.fn(),
      version: vi.fn(),
      pull: vi.fn(),
      imageExists: vi.fn(),
      loadImage: vi.fn(),
      run: vi.fn(),
      stop: vi.fn(),
      kill: vi.fn(),
      remove: vi.fn(),
      inspect: vi.fn(),
      build: vi.fn().mockResolvedValue('sha256:abc123'),
      inspectLabels: vi.fn().mockResolvedValue(DEFAULT_LABELS),
    } as unknown as ContainerRuntime,
    exec: vi.fn().mockResolvedValue({ stdout: 'abc1234\n', stderr: '' }),
    readPackageVersion: vi.fn().mockReturnValue('0.0.1'),
    ...overrides,
  };
}

describe('image-builder', () => {
  describe('buildImage', () => {
    it('builds image with correct args and labels', async () => {
      const deps = createMockDeps();
      const identity = await buildImage(deps, '/project');

      const build = deps.runtime.build as ReturnType<typeof vi.fn>;
      expect(build).toHaveBeenCalledOnce();

      const opts = build.mock.calls[0][0];
      expect(opts.contextDir).toBe('/project');
      expect(opts.tag).toBe('carapace:latest-abc1234');
      expect(opts.buildArgs).toMatchObject({
        CLAUDE_CODE_VERSION: 'latest',
        CARAPACE_VERSION: '0.0.1',
        GIT_SHA: 'abc1234',
      });
      expect(opts.buildArgs.BUILD_DATE).toBeDefined();
      expect(opts.labels).toMatchObject({
        [LABEL_REVISION]: 'abc1234',
        [LABEL_VERSION]: '0.0.1',
        [LABEL_CLAUDE_VERSION]: 'latest',
      });
      expect(opts.labels[LABEL_CREATED]).toBeDefined();

      const inspectLabels = deps.runtime.inspectLabels as ReturnType<typeof vi.fn>;
      expect(inspectLabels).toHaveBeenCalledWith('carapace:latest-abc1234');

      expect(identity.gitSha).toBe('abc1234');
      expect(identity.carapaceVersion).toBe('0.0.1');
      expect(identity.claudeVersion).toBe('latest');
      expect(identity.tag).toBe('carapace:latest-abc1234');
    });

    it("uses 'latest' when resolveClaudeVersion is not provided", async () => {
      const deps = createMockDeps();
      await buildImage(deps, '/project');

      const build = deps.runtime.build as ReturnType<typeof vi.fn>;
      const opts = build.mock.calls[0][0];
      expect(opts.buildArgs.CLAUDE_CODE_VERSION).toBe('latest');
    });

    it('uses resolved Claude Code version when provided', async () => {
      const deps = createMockDeps({
        resolveClaudeVersion: vi.fn().mockResolvedValue('2.1.49'),
      });
      (deps.runtime.inspectLabels as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...DEFAULT_LABELS,
        [LABEL_CLAUDE_VERSION]: '2.1.49',
      });

      const identity = await buildImage(deps, '/project');

      const build = deps.runtime.build as ReturnType<typeof vi.fn>;
      const opts = build.mock.calls[0][0];
      expect(opts.buildArgs.CLAUDE_CODE_VERSION).toBe('2.1.49');
      expect(opts.tag).toBe('carapace:2.1.49-abc1234');
      expect(identity.claudeVersion).toBe('2.1.49');
    });

    it('throws when post-build label verification fails', async () => {
      const deps = createMockDeps();
      (deps.runtime.inspectLabels as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await expect(buildImage(deps, '/project')).rejects.toThrow(
        'Image built but labels could not be verified',
      );
    });

    it('propagates build errors', async () => {
      const deps = createMockDeps();
      (deps.runtime.build as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('build failed'));

      await expect(buildImage(deps, '/project')).rejects.toThrow('build failed');
    });

    it('propagates git SHA resolution errors', async () => {
      const deps = createMockDeps({
        exec: vi.fn().mockRejectedValue(new Error('git not found')),
      });

      await expect(buildImage(deps, '/project')).rejects.toThrow('git not found');
    });

    it('propagates resolveClaudeVersion errors', async () => {
      const deps = createMockDeps({
        resolveClaudeVersion: vi.fn().mockRejectedValue(new Error('version resolution failed')),
      });

      await expect(buildImage(deps, '/project')).rejects.toThrow('version resolution failed');
    });

    it('includes BUILD_DATE as ISO timestamp in build args', async () => {
      const deps = createMockDeps();
      await buildImage(deps, '/project');

      const build = deps.runtime.build as ReturnType<typeof vi.fn>;
      const opts = build.mock.calls[0][0];
      // BUILD_DATE should be a valid ISO 8601 string
      expect(() => new Date(opts.buildArgs.BUILD_DATE)).not.toThrow();
      expect(new Date(opts.buildArgs.BUILD_DATE).toISOString()).toBe(opts.buildArgs.BUILD_DATE);
    });

    it('uses Dockerfile at context root by default', async () => {
      const deps = createMockDeps();
      await buildImage(deps, '/my/project');

      const build = deps.runtime.build as ReturnType<typeof vi.fn>;
      const opts = build.mock.calls[0][0];
      expect(opts.contextDir).toBe('/my/project');
    });
  });
});
