/**
 * Container network allowlisting for Carapace.
 *
 * Restricts container network access to a configurable set of hosts
 * and ports. Defense-in-depth: even if container permission lockdown
 * is somehow bypassed, the container still cannot exfiltrate data to
 * arbitrary hosts.
 *
 * Implementation:
 * - Creates an internal Docker/Podman bridge network (no default gateway)
 * - Generates iptables FORWARD chain rules that:
 *   1. Allow DNS (UDP 53) for hostname resolution
 *   2. Allow return traffic (ESTABLISHED,RELATED)
 *   3. Allow outbound TCP to resolved IPs on specific ports
 *   4. DROP all other outbound and inbound traffic
 *
 * The allowlist defaults to `api.anthropic.com:443` and is configurable
 * via the `[network]` section of config.toml.
 *
 * @see docs/TASKS.md DEVOPS-20 for full requirements.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single host:port entry in the network allowlist. */
export interface AllowlistEntry {
  /** Hostname to allow (will be resolved to IPs). */
  hostname: string;
  /** TCP port to allow outbound connections to. */
  port: number;
}

/** Injectable exec function for testing (shared with runtime adapters). */
export type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Injectable DNS resolver for testing. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** Options for constructing a NetworkAllowlist. */
export interface NetworkAllowlistOptions {
  /** Shell command executor (injectable for testing). */
  exec: ExecFn;
  /** Path to the docker/podman binary. */
  dockerPath: string;
  /** Name for the restricted Docker network. Defaults to `'carapace-restricted'`. */
  networkName?: string;
  /** Allowlist entries. Defaults to {@link DEFAULT_ALLOWLIST}. */
  entries?: AllowlistEntry[];
  /** DNS resolver function. Defaults to `dns.resolve4` equivalent. */
  dnsResolver?: DnsResolver;
}

/** Minimal config shape for the `[network]` section of config.toml. */
export interface NetworkConfig {
  allowed_hosts?: AllowlistEntry[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default allowlist: only the Anthropic API. */
export const DEFAULT_ALLOWLIST: AllowlistEntry[] = [{ hostname: 'api.anthropic.com', port: 443 }];

const DEFAULT_NETWORK_NAME = 'carapace-restricted';

// ---------------------------------------------------------------------------
// NetworkAllowlist
// ---------------------------------------------------------------------------

export class NetworkAllowlist {
  readonly networkName: string;

  private readonly exec: ExecFn;
  private readonly dockerPath: string;
  private readonly entries: AllowlistEntry[];
  private readonly dnsResolver: DnsResolver;

  /** IPs resolved during the last `applyRules()` call, for `removeRules()`. */
  private lastResolvedIPs: string[] = [];

  constructor(options: NetworkAllowlistOptions) {
    this.exec = options.exec;
    this.dockerPath = options.dockerPath;
    this.networkName = options.networkName ?? DEFAULT_NETWORK_NAME;
    this.entries = options.entries ?? [...DEFAULT_ALLOWLIST];
    this.dnsResolver = options.dnsResolver ?? defaultDnsResolver(options.exec);
  }

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  /**
   * Create a NetworkAllowlist from a `[network]` config section.
   */
  static fromConfig(
    config: NetworkConfig,
    options: Pick<NetworkAllowlistOptions, 'exec' | 'dockerPath'> &
      Partial<NetworkAllowlistOptions>,
  ): NetworkAllowlist {
    return new NetworkAllowlist({
      ...options,
      entries: config.allowed_hosts ?? undefined,
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Return the current allowlist entries. */
  getEntries(): AllowlistEntry[] {
    return [...this.entries];
  }

  /**
   * Create the restricted Docker network.
   *
   * Idempotent — safe to call if the network already exists.
   * Uses `--internal` to prevent default gateway (no external routing).
   */
  async setup(): Promise<void> {
    try {
      await this.docker('network', 'create', '--driver', 'bridge', '--internal', this.networkName);
    } catch (err) {
      // Idempotent: ignore "already exists" errors
      if (err instanceof Error && err.message.includes('already exists')) {
        return;
      }
      throw err;
    }
  }

  /**
   * Remove the restricted Docker network.
   *
   * Idempotent — safe to call if the network does not exist.
   */
  async teardown(): Promise<void> {
    try {
      await this.docker('network', 'rm', this.networkName);
    } catch (err) {
      // Idempotent: ignore "not found" errors
      if (err instanceof Error && err.message.includes('not found')) {
        return;
      }
      throw err;
    }
  }

  /**
   * Resolve all allowlisted hostnames to IP addresses.
   *
   * Returns a deduplicated array of IPv4 addresses. Entries whose
   * DNS resolution fails are silently skipped (logged in production).
   */
  async resolveAllowedIPs(): Promise<string[]> {
    const allIPs = new Set<string>();

    for (const entry of this.entries) {
      try {
        const ips = await this.dnsResolver(entry.hostname);
        for (const ip of ips) {
          allIPs.add(ip);
        }
      } catch {
        // DNS resolution failed for this entry — skip it
      }
    }

    return [...allIPs];
  }

  /**
   * Generate iptables rules for the allowlist.
   *
   * Rules operate on the FORWARD chain using the bridge interface
   * name derived from the Docker network name.
   *
   * @param resolvedIPs - Pre-resolved IP addresses to allowlist.
   * @returns Array of iptables rule strings (without the `iptables` prefix).
   */
  getIptablesRules(resolvedIPs: string[]): string[] {
    const bridge = `br-${this.networkName}`;
    const rules: string[] = [];

    // Collect unique ports from entries
    const ports = [...new Set(this.entries.map((e) => e.port))];

    // 1. Allow DNS resolution (UDP 53 outbound)
    rules.push(`-A FORWARD -o ${bridge} -p udp --dport 53 -j ACCEPT`);

    // 2. Allow established/related return traffic (inbound responses)
    rules.push(`-A FORWARD -i ${bridge} -m state --state ESTABLISHED,RELATED -j ACCEPT`);

    // 3. Allow outbound TCP to each resolved IP on each allowlisted port
    for (const ip of resolvedIPs) {
      for (const port of ports) {
        rules.push(`-A FORWARD -o ${bridge} -d ${ip} -p tcp --dport ${port} -j ACCEPT`);
      }
    }

    // 4. DROP all other outbound traffic from the bridge
    rules.push(`-A FORWARD -o ${bridge} -j DROP`);

    // 5. DROP all inbound traffic to the bridge
    rules.push(`-A FORWARD -i ${bridge} -j DROP`);

    return rules;
  }

  /**
   * Resolve IPs and apply iptables rules.
   *
   * Resolves all allowlisted hostnames, generates the iptables rules,
   * and applies them via the exec function.
   */
  async applyRules(): Promise<void> {
    const ips = await this.resolveAllowedIPs();
    this.lastResolvedIPs = ips;

    if (ips.length === 0) return;

    const rules = this.getIptablesRules(ips);
    for (const rule of rules) {
      await this.iptables(...rule.split(' '));
    }
  }

  /**
   * Remove previously applied iptables rules.
   *
   * Uses the IPs from the last `applyRules()` call and replaces
   * `-A` (append) with `-D` (delete) in each rule.
   */
  async removeRules(): Promise<void> {
    if (this.lastResolvedIPs.length === 0) return;

    const rules = this.getIptablesRules(this.lastResolvedIPs);
    for (const rule of rules) {
      const deleteRule = rule.replace('-A ', '-D ');
      await this.iptables(...deleteRule.split(' '));
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async docker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(this.dockerPath, args);
  }

  private async iptables(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec('iptables', args);
  }
}

// ---------------------------------------------------------------------------
// Default DNS resolver
// ---------------------------------------------------------------------------

function defaultDnsResolver(exec: ExecFn): DnsResolver {
  return async (hostname: string): Promise<string[]> => {
    const { stdout } = await exec('dig', ['+short', 'A', hostname]);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^\d+\.\d+\.\d+\.\d+$/.test(line));
  };
}
