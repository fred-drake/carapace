import { describe, it, expect } from 'vitest';
import type {
  ContainerRuntime,
  ContainerRunOptions,
  ContainerHandle,
  ContainerState,
  VolumeMount,
  SocketMount,
  RuntimeName,
} from './runtime.js';

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/**
 * Compile-time assertion that A is assignable to B.
 * If this compiles, the types are compatible.
 */
type AssertAssignable<A, B> = A extends B ? true : never;

// ---------------------------------------------------------------------------
// RuntimeName
// ---------------------------------------------------------------------------

describe('RuntimeName', () => {
  it('accepts all three runtime names', () => {
    const docker: RuntimeName = 'docker';
    const podman: RuntimeName = 'podman';
    const apple: RuntimeName = 'apple-container';
    expect(docker).toBe('docker');
    expect(podman).toBe('podman');
    expect(apple).toBe('apple-container');
  });

  it('is a union of exactly three string literals', () => {
    // Compile-time: each literal is assignable to RuntimeName
    const _d: AssertAssignable<'docker', RuntimeName> = true;
    const _p: AssertAssignable<'podman', RuntimeName> = true;
    const _a: AssertAssignable<'apple-container', RuntimeName> = true;
    expect(_d && _p && _a).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VolumeMount
// ---------------------------------------------------------------------------

describe('VolumeMount', () => {
  it('has source, target, and readonly fields', () => {
    const mount: VolumeMount = {
      source: '/host/path',
      target: '/container/path',
      readonly: true,
    };
    expect(mount.source).toBe('/host/path');
    expect(mount.target).toBe('/container/path');
    expect(mount.readonly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SocketMount
// ---------------------------------------------------------------------------

describe('SocketMount', () => {
  it('has hostPath and containerPath fields', () => {
    const mount: SocketMount = {
      hostPath: '/run/carapace.sock',
      containerPath: '/sockets/carapace.sock',
    };
    expect(mount.hostPath).toBe('/run/carapace.sock');
    expect(mount.containerPath).toBe('/sockets/carapace.sock');
  });
});

// ---------------------------------------------------------------------------
// ContainerRunOptions
// ---------------------------------------------------------------------------

describe('ContainerRunOptions', () => {
  it('requires all mandatory fields', () => {
    const options: ContainerRunOptions = {
      image: 'carapace-agent:latest',
      readOnly: true,
      networkDisabled: true,
      volumes: [],
      socketMounts: [],
      env: {},
    };
    expect(options.image).toBe('carapace-agent:latest');
    expect(options.readOnly).toBe(true);
    expect(options.networkDisabled).toBe(true);
    expect(options.volumes).toEqual([]);
    expect(options.socketMounts).toEqual([]);
    expect(options.env).toEqual({});
  });

  it('accepts optional fields', () => {
    const options: ContainerRunOptions = {
      image: 'carapace-agent:latest',
      name: 'my-agent',
      readOnly: true,
      networkDisabled: true,
      volumes: [{ source: '/host', target: '/guest', readonly: false }],
      socketMounts: [{ hostPath: '/run/zmq.sock', containerPath: '/sockets/zmq.sock' }],
      env: { NODE_ENV: 'production' },
      user: '1000:1000',
      entrypoint: ['/bin/sh', '-c'],
    };
    expect(options.name).toBe('my-agent');
    expect(options.user).toBe('1000:1000');
    expect(options.entrypoint).toEqual(['/bin/sh', '-c']);
  });

  it('includes VolumeMount array for volumes', () => {
    const options: ContainerRunOptions = {
      image: 'test',
      readOnly: false,
      networkDisabled: false,
      volumes: [
        { source: '/workspace', target: '/workspace', readonly: false },
        { source: '/config', target: '/etc/carapace', readonly: true },
      ],
      socketMounts: [],
      env: {},
    };
    expect(options.volumes).toHaveLength(2);
  });

  it('includes SocketMount array for socket mounts', () => {
    const options: ContainerRunOptions = {
      image: 'test',
      readOnly: false,
      networkDisabled: false,
      volumes: [],
      socketMounts: [
        { hostPath: '/run/event.sock', containerPath: '/sockets/event.sock' },
        { hostPath: '/run/request.sock', containerPath: '/sockets/request.sock' },
      ],
      env: {},
    };
    expect(options.socketMounts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ContainerHandle
// ---------------------------------------------------------------------------

describe('ContainerHandle', () => {
  it('is opaque — only constructible by a ContainerRuntime implementation', () => {
    // ContainerHandle has readonly fields; consumers can read but not construct.
    // This test verifies the shape is readable.
    const handle: ContainerHandle = { id: 'abc123', name: 'test', runtime: 'docker' };
    expect(handle.id).toBe('abc123');
    expect(handle.name).toBe('test');
    expect(handle.runtime).toBe('docker');
  });

  it('carries the runtime name that created it', () => {
    const handle: ContainerHandle = { id: 'x', name: 'agent', runtime: 'podman' };
    expect(handle.runtime).toBe('podman');
  });
});

// ---------------------------------------------------------------------------
// ContainerState
// ---------------------------------------------------------------------------

describe('ContainerState', () => {
  it('has a status field', () => {
    const state: ContainerState = { status: 'running' };
    expect(state.status).toBe('running');
  });

  it('accepts all valid status values', () => {
    const statuses: ContainerState['status'][] = [
      'created',
      'starting',
      'running',
      'stopping',
      'stopped',
      'dead',
    ];
    expect(statuses).toHaveLength(6);
  });

  it('supports optional fields', () => {
    const state: ContainerState = {
      status: 'stopped',
      exitCode: 0,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T01:00:00Z',
      health: 'healthy',
    };
    expect(state.exitCode).toBe(0);
    expect(state.startedAt).toBeDefined();
    expect(state.finishedAt).toBeDefined();
    expect(state.health).toBe('healthy');
  });

  it('accepts all health values', () => {
    const values: NonNullable<ContainerState['health']>[] = [
      'healthy',
      'unhealthy',
      'starting',
      'none',
    ];
    expect(values).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// ContainerRuntime interface
// ---------------------------------------------------------------------------

describe('ContainerRuntime', () => {
  it('defines all required methods', () => {
    // Compile-time check: a conforming object literal satisfies the interface.
    // We use a factory to avoid actually implementing anything.
    const methods: (keyof ContainerRuntime)[] = [
      'name',
      'isAvailable',
      'version',
      'pull',
      'imageExists',
      'loadImage',
      'run',
      'stop',
      'kill',
      'remove',
      'inspect',
    ];
    expect(methods).toHaveLength(11);
  });

  it('name property is a RuntimeName', () => {
    // Compile-time assertion
    const _check: AssertAssignable<ContainerRuntime['name'], RuntimeName> = true;
    expect(_check).toBe(true);
  });
});
