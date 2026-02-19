import { describe, it, expect } from 'vitest';
import {
  NetworkAllowlist,
  type NetworkAllowlistOptions,
  type AllowlistEntry,
  DEFAULT_ALLOWLIST,
} from './network-allowlist.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface ExecCall {
  file: string;
  args: readonly string[];
}

function createMockExec() {
  const calls: ExecCall[] = [];
  const exec = async (
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/** Create options with a mock exec. */
function createOptions(overrides?: Partial<NetworkAllowlistOptions>): {
  options: NetworkAllowlistOptions;
  calls: ExecCall[];
} {
  const { exec, calls } = createMockExec();
  return {
    options: {
      exec,
      dockerPath: 'docker',
      networkName: 'carapace-restricted',
      ...overrides,
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NetworkAllowlist', () => {
  describe('DEFAULT_ALLOWLIST', () => {
    it('includes api.anthropic.com on port 443', () => {
      const anthropic = DEFAULT_ALLOWLIST.find((e) => e.hostname === 'api.anthropic.com');
      expect(anthropic).toBeDefined();
      expect(anthropic!.port).toBe(443);
    });
  });

  describe('construction', () => {
    it('creates with default allowlist when none specified', () => {
      const { options } = createOptions();
      const allowlist = new NetworkAllowlist(options);
      expect(allowlist.getEntries()).toEqual(DEFAULT_ALLOWLIST);
    });

    it('accepts custom allowlist entries', () => {
      const custom: AllowlistEntry[] = [
        { hostname: 'example.com', port: 443 },
        { hostname: 'internal.api.com', port: 8443 },
      ];
      const { options } = createOptions({ entries: custom });
      const allowlist = new NetworkAllowlist(options);
      expect(allowlist.getEntries()).toEqual(custom);
    });

    it('uses default network name when not specified', () => {
      const { exec } = createMockExec();
      const allowlist = new NetworkAllowlist({ exec, dockerPath: 'docker' });
      expect(allowlist.networkName).toBe('carapace-restricted');
    });
  });

  describe('setup()', () => {
    it('creates a Docker network with internal flag', async () => {
      const { options, calls } = createOptions();
      const allowlist = new NetworkAllowlist(options);

      await allowlist.setup();

      // First call should create the network
      const createCall = calls.find((c) => c.args.includes('network') && c.args.includes('create'));
      expect(createCall).toBeDefined();
      expect(createCall!.args).toContain('--internal');
      expect(createCall!.args).toContain('carapace-restricted');
    });

    it('creates the network as a bridge driver', async () => {
      const { options, calls } = createOptions();
      const allowlist = new NetworkAllowlist(options);

      await allowlist.setup();

      const createCall = calls.find((c) => c.args.includes('network') && c.args.includes('create'));
      expect(createCall!.args).toContain('--driver');
      expect(createCall!.args).toContain('bridge');
    });

    it('is idempotent — does not error if network already exists', async () => {
      const calls: ExecCall[] = [];
      const exec = async (file: string, args: readonly string[]) => {
        calls.push({ file, args });
        if (args.includes('create')) {
          throw new Error('network carapace-restricted already exists');
        }
        return { stdout: '', stderr: '' };
      };
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        networkName: 'carapace-restricted',
      });

      // Should not throw
      await allowlist.setup();
    });

    it('propagates unexpected errors during network creation', async () => {
      const exec = async (_file: string, args: readonly string[]) => {
        if (args.includes('create')) {
          throw new Error('permission denied');
        }
        return { stdout: '', stderr: '' };
      };
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        networkName: 'carapace-restricted',
      });

      await expect(allowlist.setup()).rejects.toThrow('permission denied');
    });

    it('uses the configured docker path', async () => {
      const { options, calls } = createOptions({ dockerPath: '/usr/local/bin/docker' });
      const allowlist = new NetworkAllowlist(options);

      await allowlist.setup();

      for (const call of calls) {
        expect(call.file).toBe('/usr/local/bin/docker');
      }
    });
  });

  describe('teardown()', () => {
    it('removes the Docker network', async () => {
      const { options, calls } = createOptions();
      const allowlist = new NetworkAllowlist(options);

      await allowlist.teardown();

      const removeCall = calls.find((c) => c.args.includes('network') && c.args.includes('rm'));
      expect(removeCall).toBeDefined();
      expect(removeCall!.args).toContain('carapace-restricted');
    });

    it('does not error if network does not exist', async () => {
      const exec = async (_file: string, args: readonly string[]) => {
        if (args.includes('rm')) {
          throw new Error('network carapace-restricted not found');
        }
        return { stdout: '', stderr: '' };
      };
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        networkName: 'carapace-restricted',
      });

      // Should not throw
      await allowlist.teardown();
    });

    it('propagates unexpected errors during teardown', async () => {
      const exec = async (_file: string, args: readonly string[]) => {
        if (args.includes('rm')) {
          throw new Error('network has active endpoints');
        }
        return { stdout: '', stderr: '' };
      };
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        networkName: 'carapace-restricted',
      });

      await expect(allowlist.teardown()).rejects.toThrow('network has active endpoints');
    });
  });

  describe('resolveAllowedIPs()', () => {
    it('resolves hostnames to IP addresses', async () => {
      // Mock DNS resolution by overriding exec to return IPs for dig
      const calls: ExecCall[] = [];
      const exec = async (file: string, args: readonly string[]) => {
        calls.push({ file, args });
        if (args[0] === 'dig' || file === 'dig') {
          return { stdout: '160.79.104.1\n160.79.104.2\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        networkName: 'carapace-restricted',
        dnsResolver: async () => ['160.79.104.1', '160.79.104.2'],
      });

      const ips = await allowlist.resolveAllowedIPs();
      expect(ips).toContain('160.79.104.1');
      expect(ips).toContain('160.79.104.2');
    });

    it('deduplicates IP addresses across entries', async () => {
      const entries: AllowlistEntry[] = [
        { hostname: 'api.anthropic.com', port: 443 },
        { hostname: 'api.anthropic.com', port: 8443 },
      ];
      const allowlist = new NetworkAllowlist({
        exec: async () => ({ stdout: '', stderr: '' }),
        dockerPath: 'docker',
        entries,
        dnsResolver: async () => ['160.79.104.1'],
      });

      const ips = await allowlist.resolveAllowedIPs();
      expect(ips).toEqual(['160.79.104.1']);
    });

    it('returns empty array when DNS resolution fails', async () => {
      const allowlist = new NetworkAllowlist({
        exec: async () => ({ stdout: '', stderr: '' }),
        dockerPath: 'docker',
        entries: [{ hostname: 'nonexistent.example.com', port: 443 }],
        dnsResolver: async () => {
          throw new Error('DNS resolution failed');
        },
      });

      const ips = await allowlist.resolveAllowedIPs();
      expect(ips).toEqual([]);
    });
  });

  describe('getIptablesRules()', () => {
    it('generates iptables rules for allowlisted IPs and ports', () => {
      const { options } = createOptions({
        entries: [{ hostname: 'api.anthropic.com', port: 443 }],
      });
      const allowlist = new NetworkAllowlist(options);

      const rules = allowlist.getIptablesRules(['160.79.104.1', '160.79.104.2']);
      // Allow DNS (UDP 53)
      expect(rules).toContain('-A FORWARD -o br-carapace-restricted -p udp --dport 53 -j ACCEPT');
      // Allow each IP on port 443
      expect(rules).toContain(
        '-A FORWARD -o br-carapace-restricted -d 160.79.104.1 -p tcp --dport 443 -j ACCEPT',
      );
      expect(rules).toContain(
        '-A FORWARD -o br-carapace-restricted -d 160.79.104.2 -p tcp --dport 443 -j ACCEPT',
      );
      // Drop everything else outbound
      expect(rules).toContain('-A FORWARD -o br-carapace-restricted -j DROP');
      // Drop all inbound
      expect(rules).toContain('-A FORWARD -i br-carapace-restricted -j DROP');
    });

    it('generates rules with the correct bridge interface name', () => {
      const { options } = createOptions({ networkName: 'my-network' });
      const allowlist = new NetworkAllowlist(options);

      const rules = allowlist.getIptablesRules(['1.2.3.4']);
      for (const rule of rules) {
        if (rule.includes('br-')) {
          expect(rule).toContain('br-my-network');
        }
      }
    });

    it('allows established/related return traffic', () => {
      const { options } = createOptions();
      const allowlist = new NetworkAllowlist(options);

      const rules = allowlist.getIptablesRules(['1.2.3.4']);
      expect(rules).toContain(
        '-A FORWARD -i br-carapace-restricted -m state --state ESTABLISHED,RELATED -j ACCEPT',
      );
    });

    it('includes rules for all unique ports across entries', () => {
      const entries: AllowlistEntry[] = [
        { hostname: 'api.anthropic.com', port: 443 },
        { hostname: 'other.api.com', port: 8443 },
      ];
      const { options } = createOptions({ entries });
      const allowlist = new NetworkAllowlist(options);

      const rules = allowlist.getIptablesRules(['1.1.1.1', '2.2.2.2']);
      // Both IPs should have rules for all ports from their respective entries
      const portRules = rules.filter((r) => r.includes('--dport'));
      expect(portRules.length).toBeGreaterThan(0);
    });
  });

  describe('applyRules()', () => {
    it('resolves IPs and applies iptables rules via exec', async () => {
      const { exec, calls } = createMockExec();
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        entries: [{ hostname: 'api.anthropic.com', port: 443 }],
        dnsResolver: async () => ['160.79.104.1'],
      });

      await allowlist.applyRules();

      // Should have iptables calls
      const iptablesCalls = calls.filter((c) => c.file === 'iptables');
      expect(iptablesCalls.length).toBeGreaterThan(0);
    });

    it('skips iptables when no IPs are resolved', async () => {
      const { exec, calls } = createMockExec();
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        entries: [{ hostname: 'nonexistent.example.com', port: 443 }],
        dnsResolver: async () => {
          throw new Error('DNS failed');
        },
      });

      await allowlist.applyRules();

      const iptablesCalls = calls.filter((c) => c.file === 'iptables');
      expect(iptablesCalls.length).toBe(0);
    });
  });

  describe('removeRules()', () => {
    it('removes iptables rules by replacing -A with -D', async () => {
      const { exec, calls } = createMockExec();
      const allowlist = new NetworkAllowlist({
        exec,
        dockerPath: 'docker',
        entries: [{ hostname: 'api.anthropic.com', port: 443 }],
        dnsResolver: async () => ['160.79.104.1'],
      });

      // First apply, then remove
      await allowlist.applyRules();
      const applyCount = calls.filter((c) => c.file === 'iptables').length;
      calls.length = 0; // Reset

      await allowlist.removeRules();

      const removeCalls = calls.filter((c) => c.file === 'iptables');
      expect(removeCalls.length).toBe(applyCount);
      // All args should use -D instead of -A
      for (const call of removeCalls) {
        expect(call.args).toContain('-D');
        expect(call.args).not.toContain('-A');
      }
    });
  });

  describe('config integration', () => {
    it('can be constructed from a network config section', () => {
      const { exec } = createMockExec();
      const networkConfig = {
        allowed_hosts: [
          { hostname: 'api.anthropic.com', port: 443 },
          { hostname: 'custom.api.com', port: 8443 },
        ],
      };

      const allowlist = NetworkAllowlist.fromConfig(networkConfig, {
        exec,
        dockerPath: 'docker',
      });

      expect(allowlist.getEntries()).toHaveLength(2);
      expect(allowlist.getEntries()[0].hostname).toBe('api.anthropic.com');
      expect(allowlist.getEntries()[1].hostname).toBe('custom.api.com');
    });

    it('uses DEFAULT_ALLOWLIST when config has no allowed_hosts', () => {
      const { exec } = createMockExec();
      const allowlist = NetworkAllowlist.fromConfig({}, { exec, dockerPath: 'docker' });
      expect(allowlist.getEntries()).toEqual(DEFAULT_ALLOWLIST);
    });
  });
});
