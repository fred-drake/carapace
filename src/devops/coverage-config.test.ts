/**
 * Tests for coverage configuration (QA-07).
 *
 * Validates that the vitest coverage config has the required thresholds,
 * reporters, includes, and excludes as specified in the acceptance criteria.
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

describe('coverage configuration', () => {
  // Read and parse vitest.config.ts to validate its contents.
  // We parse the actual file to ensure configuration isn't silently broken.
  const configContent = readFileSync(resolve(projectRoot, 'vitest.config.ts'), 'utf-8');

  describe('reporters', () => {
    it('includes text reporter for terminal output', () => {
      expect(configContent).toContain("'text'");
    });

    it('includes lcov reporter for CI integration', () => {
      expect(configContent).toContain("'lcov'");
    });

    it('includes html reporter for local review', () => {
      expect(configContent).toContain("'html'");
    });
  });

  describe('include/exclude patterns', () => {
    it('includes all TypeScript source files', () => {
      expect(configContent).toContain("'src/**/*.ts'");
    });

    it('excludes test files from coverage', () => {
      expect(configContent).toMatch(/exclude.*test.*spec/s);
    });

    it('excludes type definition files from coverage', () => {
      expect(configContent).toContain('.d.ts');
    });
  });

  describe('global thresholds', () => {
    it('sets 80% line coverage threshold', () => {
      expect(configContent).toMatch(/lines\s*:\s*80/);
    });

    it('sets 70% branch coverage threshold', () => {
      expect(configContent).toMatch(/branches\s*:\s*70/);
    });
  });

  describe('security-critical module thresholds', () => {
    it('sets 90% line coverage for security-critical modules', () => {
      // The config should have per-path thresholds for security modules
      expect(configContent).toMatch(/90/);
      expect(configContent).toMatch(/lines\s*:\s*90/);
    });

    it('sets 80% branch coverage for security-critical modules', () => {
      expect(configContent).toMatch(/branches\s*:\s*80/);
    });

    it('covers the core router module', () => {
      expect(configContent).toContain('src/core/router.ts');
    });

    it('covers the pipeline validation modules', () => {
      expect(configContent).toContain('src/core/pipeline');
    });

    it('covers the message validator module', () => {
      expect(configContent).toContain('src/core/message-validator.ts');
    });

    it('covers the error handler module', () => {
      expect(configContent).toContain('src/core/error-handler.ts');
    });
  });

  describe('CI script', () => {
    const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));

    it('has test:coverage script', () => {
      expect(packageJson.scripts['test:coverage']).toBeDefined();
    });

    it('test:coverage runs vitest with coverage flag', () => {
      expect(packageJson.scripts['test:coverage']).toContain('--coverage');
    });
  });
});
