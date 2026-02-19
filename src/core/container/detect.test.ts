import { describe, it, expect } from 'vitest';
import { detectRuntime, listAvailableRuntimes } from './detect.js';
import { MockContainerRuntime } from './mock-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock runtime that reports as available. */
function available(name: 'docker' | 'podman' | 'apple-container'): MockContainerRuntime {
  return new MockContainerRuntime(name);
}

/** Create a mock runtime that reports as unavailable. */
function unavailable(name: 'docker' | 'podman' | 'apple-container'): MockContainerRuntime {
  const rt = new MockContainerRuntime(name);
  rt.setAvailable(false);
  return rt;
}

// ---------------------------------------------------------------------------
// detectRuntime
// ---------------------------------------------------------------------------

describe('detectRuntime', () => {
  describe('single runtime available', () => {
    it('selects Docker when it is the only runtime', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker')],
        platform: 'linux',
      });
      expect(result).not.toBeNull();
      expect(result!.selected.runtime.name).toBe('docker');
    });

    it('selects Podman when it is the only runtime', async () => {
      const result = await detectRuntime({
        runtimes: [available('podman')],
        platform: 'linux',
      });
      expect(result).not.toBeNull();
      expect(result!.selected.runtime.name).toBe('podman');
    });
  });

  describe('priority order (no preference)', () => {
    it('prefers Apple Containers over Podman and Docker', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker'), available('podman'), available('apple-container')],
        platform: 'darwin',
      });
      expect(result!.selected.runtime.name).toBe('apple-container');
    });

    it('prefers Podman over Docker when Apple Containers unavailable', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker'), available('podman'), unavailable('apple-container')],
        platform: 'linux',
      });
      expect(result!.selected.runtime.name).toBe('podman');
    });

    it('falls back to Docker when nothing else is available', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker'), unavailable('podman'), unavailable('apple-container')],
        platform: 'linux',
      });
      expect(result!.selected.runtime.name).toBe('docker');
    });
  });

  describe('user preference', () => {
    it('selects preferred runtime even if lower priority', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker'), available('podman'), available('apple-container')],
        platform: 'darwin',
        preference: 'docker',
      });
      expect(result!.selected.runtime.name).toBe('docker');
    });

    it('falls back to priority order if preferred runtime is unavailable', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker'), unavailable('podman')],
        platform: 'linux',
        preference: 'podman',
      });
      expect(result!.selected.runtime.name).toBe('docker');
    });
  });

  describe('no runtimes available', () => {
    it('returns null when no runtimes are found', async () => {
      const result = await detectRuntime({
        runtimes: [unavailable('docker'), unavailable('podman')],
        platform: 'linux',
      });
      expect(result).toBeNull();
    });

    it('returns null with empty runtime list', async () => {
      const result = await detectRuntime({
        runtimes: [],
        platform: 'linux',
      });
      expect(result).toBeNull();
    });
  });

  describe('isolation level', () => {
    it('Apple Containers → vm', async () => {
      const result = await detectRuntime({
        runtimes: [available('apple-container')],
        platform: 'darwin',
      });
      expect(result!.selected.isolationLevel).toBe('vm');
    });

    it('Docker on macOS → vm (Docker Desktop VM)', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker')],
        platform: 'darwin',
      });
      expect(result!.selected.isolationLevel).toBe('vm');
    });

    it('Docker on Linux → namespace', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker')],
        platform: 'linux',
      });
      expect(result!.selected.isolationLevel).toBe('namespace');
    });

    it('Podman → rootless-namespace', async () => {
      const result = await detectRuntime({
        runtimes: [available('podman')],
        platform: 'linux',
      });
      expect(result!.selected.isolationLevel).toBe('rootless-namespace');
    });
  });

  describe('detection result includes all available runtimes', () => {
    it('lists all available runtimes with their isolation levels', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker'), available('podman'), unavailable('apple-container')],
        platform: 'linux',
      });

      expect(result!.available).toHaveLength(2);
      const names = result!.available.map((r) => r.runtime.name).sort();
      expect(names).toEqual(['docker', 'podman']);
    });
  });

  describe('detection failure is not a crash', () => {
    it('handles runtime that throws during isAvailable', async () => {
      const broken = new MockContainerRuntime('docker');
      broken.setAvailableError(new Error('daemon crashed'));

      const result = await detectRuntime({
        runtimes: [broken, available('podman')],
        platform: 'linux',
      });

      expect(result).not.toBeNull();
      expect(result!.selected.runtime.name).toBe('podman');
      expect(result!.available).toHaveLength(1);
    });
  });

  describe('version is captured', () => {
    it('includes version string in detection result', async () => {
      const result = await detectRuntime({
        runtimes: [available('docker')],
        platform: 'linux',
      });
      expect(result!.selected.version).toMatch(/Mock docker/i);
    });
  });
});

// ---------------------------------------------------------------------------
// listAvailableRuntimes
// ---------------------------------------------------------------------------

describe('listAvailableRuntimes', () => {
  it('returns only available runtimes', async () => {
    const results = await listAvailableRuntimes({
      runtimes: [available('docker'), unavailable('podman'), available('apple-container')],
      platform: 'darwin',
    });

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.runtime.name).sort();
    expect(names).toEqual(['apple-container', 'docker']);
  });

  it('returns empty array when none available', async () => {
    const results = await listAvailableRuntimes({
      runtimes: [unavailable('docker')],
      platform: 'linux',
    });
    expect(results).toEqual([]);
  });

  it('includes isolation levels for each runtime', async () => {
    const results = await listAvailableRuntimes({
      runtimes: [available('docker'), available('podman')],
      platform: 'linux',
    });

    const dockerInfo = results.find((r) => r.runtime.name === 'docker')!;
    const podmanInfo = results.find((r) => r.runtime.name === 'podman')!;

    expect(dockerInfo.isolationLevel).toBe('namespace');
    expect(podmanInfo.isolationLevel).toBe('rootless-namespace');
  });
});
