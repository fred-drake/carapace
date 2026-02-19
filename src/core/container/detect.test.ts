import { describe, it, expect } from 'vitest';
import { detect } from './detect.js';

describe('detect', () => {
  it('is a function', () => {
    expect(typeof detect).toBe('function');
  });

  it('returns a promise', () => {
    const result = detect();
    expect(result).toBeInstanceOf(Promise);
  });

  it('accepts an optional RuntimeName preference', async () => {
    // Stub returns null until adapters are implemented.
    const result = await detect('docker');
    expect(result).toBeNull();
  });

  it('returns null when no runtimes are available (stub behavior)', async () => {
    const result = await detect();
    expect(result).toBeNull();
  });
});
