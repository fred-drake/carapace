import { describe, it, expect, vi } from 'vitest';
import {
  resolveGitSha,
  isImageCurrent,
  compositeTag,
  parseLabels,
  LABEL_REVISION,
  LABEL_VERSION,
  LABEL_CLAUDE_VERSION,
  LABEL_CREATED,
} from './image-identity.js';

describe('image-identity', () => {
  describe('resolveGitSha', () => {
    it('returns trimmed short SHA from git', async () => {
      const exec = vi.fn().mockResolvedValue({ stdout: 'abc1234\n', stderr: '' });
      const sha = await resolveGitSha(exec);
      expect(sha).toBe('abc1234');
      expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--short', 'HEAD']);
    });

    it('propagates exec errors', async () => {
      const exec = vi.fn().mockRejectedValue(new Error('git not found'));
      await expect(resolveGitSha(exec)).rejects.toThrow('git not found');
    });
  });

  describe('isImageCurrent', () => {
    it('returns true when SHA matches', () => {
      const labels = { [LABEL_REVISION]: 'abc1234' };
      expect(isImageCurrent(labels, 'abc1234')).toBe(true);
    });

    it('returns false when SHA differs', () => {
      const labels = { [LABEL_REVISION]: 'abc1234' };
      expect(isImageCurrent(labels, 'def5678')).toBe(false);
    });

    it('returns false when revision label is missing', () => {
      expect(isImageCurrent({}, 'abc1234')).toBe(false);
    });
  });

  describe('compositeTag', () => {
    it('formats tag as carapace:{version}-{sha}', () => {
      expect(compositeTag('2.1.49', 'abc1234')).toBe('carapace:2.1.49-abc1234');
    });

    it('handles latest as version', () => {
      expect(compositeTag('latest', 'abc1234')).toBe('carapace:latest-abc1234');
    });
  });

  describe('parseLabels', () => {
    it('parses all labels into ImageIdentity', () => {
      const labels = {
        [LABEL_REVISION]: 'abc1234',
        [LABEL_VERSION]: '0.1.0',
        [LABEL_CLAUDE_VERSION]: '2.1.49',
        [LABEL_CREATED]: '2026-02-20T00:00:00Z',
      };
      const id = parseLabels(labels);
      expect(id).toEqual({
        tag: 'carapace:2.1.49-abc1234',
        gitSha: 'abc1234',
        claudeVersion: '2.1.49',
        carapaceVersion: '0.1.0',
        buildDate: '2026-02-20T00:00:00Z',
      });
    });

    it('returns null when revision is missing', () => {
      const labels = { [LABEL_CLAUDE_VERSION]: '2.1.49' };
      expect(parseLabels(labels)).toBeNull();
    });

    it('returns null when claude version is missing', () => {
      const labels = { [LABEL_REVISION]: 'abc1234' };
      expect(parseLabels(labels)).toBeNull();
    });

    it('uses defaults for optional fields', () => {
      const labels = {
        [LABEL_REVISION]: 'abc1234',
        [LABEL_CLAUDE_VERSION]: '2.1.49',
      };
      const id = parseLabels(labels)!;
      expect(id.carapaceVersion).toBe('unknown');
      expect(id.buildDate).toBe('unknown');
    });
  });
});
