/**
 * Mock container runtime for testing.
 *
 * Implements the {@link ContainerRuntime} interface with in-memory state,
 * enabling unit tests for the session manager (ENG-06), container lifecycle
 * manager (DEVOPS-03), and related code without a real container engine.
 *
 * Supports failure simulation for run errors, stop timeouts, and
 * unexpected container crashes.
 */

import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
  RuntimeName,
  ImageBuildOptions,
} from './runtime.js';

// ---------------------------------------------------------------------------
// Internal container record
// ---------------------------------------------------------------------------

interface ContainerRecord {
  handle: ContainerHandle;
  state: ContainerState;
}

// ---------------------------------------------------------------------------
// MockContainerRuntime
// ---------------------------------------------------------------------------

export class MockContainerRuntime implements ContainerRuntime {
  readonly name: RuntimeName;

  /** All containers ever created, indexed by ID. */
  private readonly containers = new Map<string, ContainerRecord>();

  /** Set of images that "exist" locally. */
  private readonly images = new Set<string>();

  /** Auto-incrementing counter for unique IDs. */
  private idCounter = 0;

  // -- Failure simulation flags --

  private available = true;
  private availableError: Error | null = null;
  private nextRunFailure: string | null = null;
  private nextStopTimeout = false;
  private nextStdout: NodeJS.ReadableStream | null = null;
  private nextStderr: NodeJS.ReadableStream | null = null;

  constructor(name: RuntimeName = 'docker') {
    this.name = name;
  }

  // -----------------------------------------------------------------------
  // Availability
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    if (this.availableError) {
      throw this.availableError;
    }
    return this.available;
  }

  async version(): Promise<string> {
    return `Mock ${this.name} 1.0.0`;
  }

  // -----------------------------------------------------------------------
  // Image lifecycle
  // -----------------------------------------------------------------------

  async pull(image: string): Promise<void> {
    this.images.add(image);
  }

  async imageExists(image: string): Promise<boolean> {
    return this.images.has(image);
  }

  async loadImage(_source: string): Promise<void> {
    // No-op in mock.
  }

  async build(options: ImageBuildOptions): Promise<string> {
    this.images.add(options.tag);
    return `mock-image-${options.tag}`;
  }

  async inspectLabels(_image: string): Promise<Record<string, string>> {
    return {};
  }

  // -----------------------------------------------------------------------
  // Container lifecycle
  // -----------------------------------------------------------------------

  async run(options: ContainerRunOptions): Promise<ContainerHandle> {
    if (this.nextRunFailure !== null) {
      const message = this.nextRunFailure;
      this.nextRunFailure = null;
      throw new Error(message);
    }

    this.idCounter += 1;

    const handle: ContainerHandle = {
      id: `mock-${this.idCounter}`,
      name: options.name ?? `mock-container-${this.idCounter}`,
      runtime: this.name,
      stdout: this.nextStdout ?? undefined,
      stderr: this.nextStderr ?? undefined,
    };

    this.nextStdout = null;
    this.nextStderr = null;

    const state: ContainerState = {
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    this.containers.set(handle.id, { handle, state });
    return handle;
  }

  async stop(handle: ContainerHandle, _timeout?: number): Promise<void> {
    if (this.nextStopTimeout) {
      this.nextStopTimeout = false;
      return new Promise<void>(() => {
        // Intentionally never resolves.
      });
    }

    const record = this.containers.get(handle.id);
    if (record) {
      record.state.status = 'stopped';
      record.state.exitCode = 0;
      record.state.finishedAt = new Date().toISOString();
    }
  }

  async kill(handle: ContainerHandle): Promise<void> {
    const record = this.containers.get(handle.id);
    if (record) {
      record.state.status = 'dead';
      record.state.exitCode = 137;
      record.state.finishedAt = new Date().toISOString();
    }
  }

  async remove(handle: ContainerHandle): Promise<void> {
    this.containers.delete(handle.id);
  }

  async inspect(handle: ContainerHandle): Promise<ContainerState> {
    const record = this.containers.get(handle.id);
    if (!record) {
      throw new Error(`Container "${handle.id}" not found`);
    }
    return { ...record.state };
  }

  // -----------------------------------------------------------------------
  // Failure simulation
  // -----------------------------------------------------------------------

  /**
   * Make the next `run()` call reject with an error.
   * @param error - Custom error message (defaults to `'Run failed'`).
   */
  simulateRunFailure(error?: string): void {
    this.nextRunFailure = error ?? 'Run failed';
  }

  /**
   * Make the next `stop()` call hang forever (never resolve).
   */
  simulateStopTimeout(): void {
    this.nextStopTimeout = true;
  }

  /**
   * Control what `isAvailable()` returns.
   */
  setAvailable(value: boolean): void {
    this.available = value;
  }

  /**
   * Make `isAvailable()` throw an error instead of returning a boolean.
   */
  setAvailableError(error: Error): void {
    this.availableError = error;
  }

  /**
   * Simulate an unexpected container crash. Marks the container as `'dead'`
   * with exit code 137 (SIGKILL).
   */
  simulateCrash(handle: ContainerHandle): void {
    const record = this.containers.get(handle.id);
    if (record) {
      record.state.status = 'dead';
      record.state.exitCode = 137;
      record.state.finishedAt = new Date().toISOString();
    }
  }

  /**
   * Make the next `run()` call return a handle with stdout/stderr streams.
   */
  simulateStdout(stdout: NodeJS.ReadableStream, stderr?: NodeJS.ReadableStream): void {
    this.nextStdout = stdout;
    this.nextStderr = stderr ?? null;
  }

  // -----------------------------------------------------------------------
  // Inspection helpers (test-only)
  // -----------------------------------------------------------------------

  /** Return handles for all currently running containers. */
  getRunningHandles(): ContainerHandle[] {
    return [...this.containers.values()]
      .filter((r) => r.state.status === 'running')
      .map((r) => r.handle);
  }

  /** Clear all internal state. */
  reset(): void {
    this.containers.clear();
    this.images.clear();
    this.idCounter = 0;
    this.available = true;
    this.availableError = null;
    this.nextRunFailure = null;
    this.nextStopTimeout = false;
    this.nextStdout = null;
    this.nextStderr = null;
  }
}
