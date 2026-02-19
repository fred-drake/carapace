/**
 * Mock container runtime for testing.
 *
 * Implements the ContainerRuntime interface with an in-memory store,
 * enabling unit tests for session manager (ENG-06), container lifecycle
 * manager (DEVOPS-03), and related code without Docker.
 *
 * Supports failure simulation for spawn errors, stop timeouts, and
 * unexpected container crashes.
 */

import type { ContainerInfo, ContainerRuntime, SpawnOptions } from '../core/container-runtime.js';

// ---------------------------------------------------------------------------
// Stop call record
// ---------------------------------------------------------------------------

/** A recorded call to `stop()`, used for test assertions. */
export interface StopCallRecord {
  containerId: string;
  timeoutMs: number | undefined;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Mock container runtime
// ---------------------------------------------------------------------------

export class MockContainerRuntime implements ContainerRuntime {
  /** All containers ever spawned (includes stopped ones). */
  private readonly allContainers = new Map<string, ContainerInfo>();

  /** Currently running containers. */
  private readonly activeContainers = new Map<string, ContainerInfo>();

  /** Log of every stop() call. */
  private readonly stopCalls: StopCallRecord[] = [];

  /** Auto-incrementing counter for generating unique container IDs. */
  private idCounter = 0;

  // -- Failure simulation flags --

  /** When set, the next spawn() call rejects with this error message. */
  private nextSpawnFailure: string | null = null;

  /** When true, the next stop() call never resolves. */
  private nextStopTimeout = false;

  // -----------------------------------------------------------------------
  // ContainerRuntime implementation
  // -----------------------------------------------------------------------

  async spawn(options: SpawnOptions): Promise<ContainerInfo> {
    // Check for simulated spawn failure.
    if (this.nextSpawnFailure !== null) {
      const message = this.nextSpawnFailure;
      this.nextSpawnFailure = null;
      throw new Error(message);
    }

    this.idCounter += 1;

    const info: ContainerInfo = {
      id: `mock-container-${this.idCounter}`,
      name: options.name,
      connectionIdentity: `mock-identity-${this.idCounter}`,
      status: 'running',
      startedAt: new Date(),
    };

    this.allContainers.set(info.id, info);
    this.activeContainers.set(info.id, info);

    return info;
  }

  async stop(containerId: string, timeoutMs?: number): Promise<void> {
    // Record the call regardless of simulation.
    this.stopCalls.push({
      containerId,
      timeoutMs,
      timestamp: new Date(),
    });

    // Check for simulated stop timeout.
    if (this.nextStopTimeout) {
      this.nextStopTimeout = false;
      // Return a promise that never resolves, simulating a hung stop.
      return new Promise<void>(() => {
        // intentionally never resolves
      });
    }

    const info = this.allContainers.get(containerId);
    if (info) {
      info.status = 'stopped';
    }
    this.activeContainers.delete(containerId);
  }

  async isRunning(containerId: string): Promise<boolean> {
    return this.activeContainers.has(containerId);
  }

  async getInfo(containerId: string): Promise<ContainerInfo | null> {
    return this.allContainers.get(containerId) ?? null;
  }

  async cleanup(): Promise<void> {
    // Stop all active containers.
    const ids = [...this.activeContainers.keys()];
    for (const id of ids) {
      const info = this.allContainers.get(id);
      if (info) {
        info.status = 'stopped';
      }
      this.activeContainers.delete(id);
    }
  }

  // -----------------------------------------------------------------------
  // Failure simulation
  // -----------------------------------------------------------------------

  /**
   * Make the next `spawn()` call reject with an error.
   * @param error - Optional custom error message (defaults to 'Spawn failed').
   */
  simulateSpawnFailure(error?: string): void {
    this.nextSpawnFailure = error ?? 'Spawn failed';
  }

  /**
   * Make the next `stop()` call hang forever (never resolve).
   * The stop call is still recorded in the stop call log.
   */
  simulateStopTimeout(): void {
    this.nextStopTimeout = true;
  }

  /**
   * Simulate an unexpected container crash. Marks the container as 'stopped'
   * and removes it from the active set, as if the process inside died.
   * @param containerId - The container to crash.
   */
  simulateCrash(containerId: string): void {
    const info = this.allContainers.get(containerId);
    if (info) {
      info.status = 'stopped';
    }
    this.activeContainers.delete(containerId);
  }

  // -----------------------------------------------------------------------
  // Inspection methods
  // -----------------------------------------------------------------------

  /** Return all containers ever spawned (including stopped ones). */
  getSpawnedContainers(): ContainerInfo[] {
    return [...this.allContainers.values()];
  }

  /** Return only currently running containers. */
  getActiveContainers(): ContainerInfo[] {
    return [...this.activeContainers.values()];
  }

  /** Return the log of all stop() calls with timestamps. */
  getStopCalls(): StopCallRecord[] {
    return [...this.stopCalls];
  }

  /** Clear all internal state, returning the runtime to a fresh state. */
  reset(): void {
    this.allContainers.clear();
    this.activeContainers.clear();
    this.stopCalls.length = 0;
    this.idCounter = 0;
    this.nextSpawnFailure = null;
    this.nextStopTimeout = false;
  }
}
