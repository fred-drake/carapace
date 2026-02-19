import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from './yaml-parse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker-compose.yml');

function readComposeFile(): Record<string, unknown> {
  const content = fs.readFileSync(COMPOSE_PATH, 'utf-8');
  return yaml.parse(content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docker-compose.yml', () => {
  let compose: Record<string, unknown>;

  it('exists in project root', () => {
    expect(fs.existsSync(COMPOSE_PATH)).toBe(true);
  });

  describe('structure', () => {
    beforeAll(() => {
      compose = readComposeFile();
    });

    // ---------------------------------------------------------------------
    // Top-level structure
    // ---------------------------------------------------------------------

    it('has services section', () => {
      expect(compose.services).toBeDefined();
      expect(typeof compose.services).toBe('object');
    });

    it('has volumes section', () => {
      expect(compose.volumes).toBeDefined();
    });

    it('has networks section', () => {
      expect(compose.networks).toBeDefined();
    });

    // ---------------------------------------------------------------------
    // Core service
    // ---------------------------------------------------------------------

    describe('core service', () => {
      let core: Record<string, unknown>;

      beforeAll(() => {
        const services = compose.services as Record<string, unknown>;
        core = services.core as Record<string, unknown>;
      });

      it('is defined', () => {
        expect(core).toBeDefined();
      });

      it('builds from project root', () => {
        const build = core.build as Record<string, unknown>;
        expect(build).toBeDefined();
        expect(build.context).toBe('.');
        expect(build.target).toBe('builder');
      });

      it('mounts plugin directory for live-reload', () => {
        const volumes = core.volumes as string[];
        expect(volumes).toBeDefined();
        const pluginMount = volumes.find((v) => typeof v === 'string' && v.includes('plugins'));
        expect(pluginMount).toBeDefined();
      });

      it('mounts data directory', () => {
        const volumes = core.volumes as string[];
        const dataMount = volumes.find((v) => typeof v === 'string' && v.includes('data'));
        expect(dataMount).toBeDefined();
      });

      it('uses the carapace network', () => {
        const networks = core.networks as string[];
        expect(networks).toContain('carapace');
      });

      it('mounts the shared socket volume', () => {
        const volumes = core.volumes as string[];
        const socketMount = volumes.find((v) => typeof v === 'string' && v.includes('socket'));
        expect(socketMount).toBeDefined();
      });
    });

    // ---------------------------------------------------------------------
    // Agent service
    // ---------------------------------------------------------------------

    describe('agent service', () => {
      let agent: Record<string, unknown>;

      beforeAll(() => {
        const services = compose.services as Record<string, unknown>;
        agent = services.agent as Record<string, unknown>;
      });

      it('is defined', () => {
        expect(agent).toBeDefined();
      });

      it('builds from project root with runtime target', () => {
        const build = agent.build as Record<string, unknown>;
        expect(build).toBeDefined();
        expect(build.context).toBe('.');
        expect(build.target).toBe('runtime');
      });

      it('uses read-only root filesystem', () => {
        expect(agent.read_only).toBe(true);
      });

      it('has no external network access', () => {
        const networks = agent.networks as Record<string, unknown>;
        // Should be on the internal carapace network only
        expect(networks).toBeDefined();
        expect(networks.carapace).toBeDefined();
      });

      it('mounts shared socket volume', () => {
        const volumes = agent.volumes as string[];
        const socketMount = volumes.find((v) => typeof v === 'string' && v.includes('socket'));
        expect(socketMount).toBeDefined();
      });

      it('mounts workspace directory as writable', () => {
        const volumes = agent.volumes as string[];
        const workspaceMount = volumes.find(
          (v) => typeof v === 'string' && v.includes('workspace'),
        );
        expect(workspaceMount).toBeDefined();
      });

      it('mounts skill files for live-reload', () => {
        const volumes = agent.volumes as string[];
        const skillMount = volumes.find((v) => typeof v === 'string' && v.includes('skill'));
        expect(skillMount).toBeDefined();
      });

      it('overrides entrypoint with credential injection script', () => {
        const entrypoint = agent.entrypoint;
        expect(entrypoint).toBeDefined();
      });

      it('has tmpfs for writable scratch areas', () => {
        const tmpfs = agent.tmpfs;
        expect(tmpfs).toBeDefined();
      });

      it('depends on core service', () => {
        const dependsOn = agent.depends_on;
        expect(dependsOn).toBeDefined();
      });
    });

    // ---------------------------------------------------------------------
    // Network configuration
    // ---------------------------------------------------------------------

    describe('network', () => {
      it('defines a carapace network', () => {
        const networks = compose.networks as Record<string, unknown>;
        expect(networks.carapace).toBeDefined();
      });

      it('carapace network is internal (no external access)', () => {
        const networks = compose.networks as Record<string, unknown>;
        const carapace = networks.carapace as Record<string, unknown>;
        expect(carapace.internal).toBe(true);
      });

      it('uses bridge driver', () => {
        const networks = compose.networks as Record<string, unknown>;
        const carapace = networks.carapace as Record<string, unknown>;
        expect(carapace.driver).toBe('bridge');
      });
    });

    // ---------------------------------------------------------------------
    // Volume configuration
    // ---------------------------------------------------------------------

    describe('volumes', () => {
      it('defines a shared socket volume', () => {
        const volumes = compose.volumes as Record<string, unknown>;
        expect(volumes['zmq-socket']).toBeDefined();
      });
    });
  });
});
