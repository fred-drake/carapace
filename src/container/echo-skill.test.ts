import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Read the echo skill file
// ---------------------------------------------------------------------------

const SKILL_PATH = path.resolve(__dirname, '../../examples/echo-plugin/skills/echo.md');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('echo plugin skill file', () => {
  it('exists at examples/echo-plugin/skills/echo.md', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
  });

  it('is non-empty', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('documents the echo tool name', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toContain('echo');
  });

  it('shows the ipc invocation pattern', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toMatch(/ipc\s+tool\.invoke\.echo/);
  });

  it('documents the text argument', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toContain('text');
  });

  it('includes a usage example with ipc command', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toMatch(/```/);
    expect(content).toMatch(/ipc.*echo/);
  });
});
