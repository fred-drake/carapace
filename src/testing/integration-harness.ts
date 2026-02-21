/**
 * Integration test harness for Carapace.
 *
 * Spins up real components (MessageRouter, RequestChannel, EventBus,
 * SessionManager, RateLimiter) using fake in-memory ZeroMQ sockets.
 * Supports sending wire messages, asserting on envelope construction,
 * routing, and responses. Includes helpers for plugin registration
 * and session simulation.
 *
 * No Docker, no real I/O, no network — runs in-process for CI.
 *
 * Usage:
 *   const harness = await IntegrationHarness.create();
 *   harness.registerTool(toolDecl, handler);
 *   const session = harness.createSession({ group: 'email' });
 *   const response = await harness.sendRequest(session, 'echo', { text: 'hi' });
 *   await harness.close();
 */

import type { ToolDeclaration } from '../types/manifest.js';
import type {
  WireMessage,
  ResponseEnvelope,
  RequestEnvelope,
  EventEnvelope,
  Envelope,
} from '../types/protocol.js';
import { PROTOCOL_VERSION } from '../types/protocol.js';
import { ErrorCode, ERROR_RETRIABLE_DEFAULTS } from '../types/errors.js';
import type { ErrorPayload } from '../types/errors.js';
import type { ToolHandler } from '../core/tool-catalog.js';
import type {
  PipelineContext,
  PipelineResult,
  PipelineStage,
  SessionContext,
} from '../core/pipeline/types.js';
import type { SubscriptionHandle } from '../core/event-bus.js';
import { ToolCatalog } from '../core/tool-catalog.js';
import { RequestChannel } from '../core/request-channel.js';
import { EventBus } from '../core/event-bus.js';
import { SessionManager } from '../core/session-manager.js';
import { RateLimiter } from '../core/rate-limiter.js';
import type { RateLimiterConfig } from '../core/rate-limiter.js';
import { stage1Construct } from '../core/pipeline/stage-1-construct.js';
import { createStage2Topic } from '../core/pipeline/stage-2-topic.js';
import { stage3Payload } from '../core/pipeline/stage-3-payload.js';
import { createStage4Authorize } from '../core/pipeline/stage-4-authorize.js';
import { createStage5Confirm } from '../core/pipeline/stage-5-confirm.js';
import { dispatchToHandler } from '../core/pipeline/stage-6-route.js';
import {
  FakePubSocket,
  FakeSubSocket,
  FakeRouterSocket,
  FakeDealerSocket,
} from './fake-sockets.js';
import type {
  SocketFactory,
  PublisherSocket,
  SubscriberSocket,
  RouterSocket,
  DealerSocket,
} from '../types/socket.js';
import { TestInputHandler } from '../plugins/test-input/handler.js';

// ---------------------------------------------------------------------------
// Auto-wiring socket factory
// ---------------------------------------------------------------------------

/**
 * A SocketFactory that auto-wires sockets by address. When a SUB socket
 * connects to an address where a PUB is bound, it's automatically wired.
 * Same for DEALER → ROUTER.
 */
class AutoWiringSocketFactory implements SocketFactory {
  private readonly publishers: FakePubSocket[] = [];
  private readonly subscribers: FakeSubSocket[] = [];
  private readonly routers: FakeRouterSocket[] = [];
  private readonly dealers: FakeDealerSocket[] = [];

  private readonly pubByAddress = new Map<string, FakePubSocket>();
  private readonly routerByAddress = new Map<string, FakeRouterSocket>();

  createPublisher(): PublisherSocket {
    const socket = new FakePubSocket();
    this.publishers.push(socket);

    // Intercept bind to track address
    const origBind = socket.bind.bind(socket);
    socket.bind = async (address: string) => {
      await origBind(address);
      this.pubByAddress.set(address, socket);
    };

    return socket;
  }

  createSubscriber(): SubscriberSocket {
    const socket = new FakeSubSocket();
    this.subscribers.push(socket);

    // Intercept connect to auto-wire to the matching PUB
    const origConnect = socket.connect.bind(socket);
    socket.connect = async (address: string) => {
      const pub = this.pubByAddress.get(address);
      if (pub) {
        socket.connectedTo = pub;
      }
      await origConnect(address);
    };

    return socket;
  }

  createRouter(): RouterSocket {
    const socket = new FakeRouterSocket();
    this.routers.push(socket);

    // Intercept bind to track address
    const origBind = socket.bind.bind(socket);
    socket.bind = async (address: string) => {
      await origBind(address);
      this.routerByAddress.set(address, socket);
    };

    return socket;
  }

  createDealer(): DealerSocket {
    const socket = new FakeDealerSocket();
    this.dealers.push(socket);

    // Intercept connect to auto-wire to the matching ROUTER
    const origConnect = socket.connect.bind(socket);
    socket.connect = async (address: string) => {
      const router = this.routerByAddress.get(address);
      if (router) {
        socket.connectedTo = router;
      }
      await origConnect(address);
    };

    return socket;
  }

  getPublishers(): readonly FakePubSocket[] {
    return this.publishers;
  }

  getSubscribers(): readonly FakeSubSocket[] {
    return this.subscribers;
  }

  getRouters(): readonly FakeRouterSocket[] {
    return this.routers;
  }

  getDealers(): readonly FakeDealerSocket[] {
    return this.dealers;
  }

  async cleanup(): Promise<void> {
    const all = [
      ...this.publishers.map((s) => s.close()),
      ...this.subscribers.map((s) => s.close()),
      ...this.routers.map((s) => s.close()),
      ...this.dealers.map((s) => s.close()),
    ];
    await Promise.all(all);
  }
}

// ---------------------------------------------------------------------------
// Session handle (returned to test callers)
// ---------------------------------------------------------------------------

/** Handle representing a simulated session in the harness. */
export interface HarnessSession {
  sessionId: string;
  group: string;
  containerId: string;
  connectionIdentity: string;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Options for sending a request through the harness. */
export interface SendRequestOptions {
  /** Custom correlation ID. Auto-generated if omitted. */
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Internal: full pipeline router
// ---------------------------------------------------------------------------

/**
 * Runs the full 6-stage pipeline (stages 1-5 synchronous, stage 6 async).
 * Uses the real stage 4 (authorize + rate limiting) and real stage 5
 * (confirmation gate with pre-approval set).
 */
class FullPipelineRouter {
  private readonly catalog: ToolCatalog;
  private readonly stages: PipelineStage[];

  constructor(
    catalog: ToolCatalog,
    rateLimiter: RateLimiter,
    toolGroupRestrictions: Map<string, Set<string>>,
    preApprovedCorrelations: Set<string>,
  ) {
    this.catalog = catalog;
    this.stages = [
      stage1Construct,
      createStage2Topic(catalog),
      stage3Payload,
      createStage4Authorize({ rateLimiter, toolGroupRestrictions }),
      createStage5Confirm({ preApprovedCorrelations }),
    ];
  }

  async processRequest(wire: WireMessage, session: SessionContext): Promise<ResponseEnvelope> {
    try {
      let ctx: PipelineContext = { wire, session };

      for (const stage of this.stages) {
        const result = stage.execute(ctx);

        if (this.isPipelineResult(result)) {
          if (!result.ok) {
            return this.buildErrorResponse(wire, result.error);
          }
          throw new Error('Unexpected success result from synchronous pipeline stage');
        }

        ctx = result;
      }

      if (!ctx.envelope || !ctx.tool) {
        return this.buildErrorResponse(wire, {
          code: ErrorCode.PLUGIN_ERROR,
          message: 'Pipeline error: envelope or tool not resolved after all stages',
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_ERROR],
        });
      }

      const handler = this.catalog.get(ctx.tool.name)?.handler;
      if (!handler) {
        return this.buildErrorResponse(wire, {
          code: ErrorCode.PLUGIN_UNAVAILABLE,
          message: `Handler not found for tool: "${ctx.tool.name}"`,
          retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_UNAVAILABLE],
        });
      }

      return await dispatchToHandler(ctx.envelope, handler);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.buildErrorResponse(wire, {
        code: ErrorCode.PLUGIN_ERROR,
        message: `Unexpected error: ${message}`,
        retriable: ERROR_RETRIABLE_DEFAULTS[ErrorCode.PLUGIN_ERROR],
      });
    }
  }

  private isPipelineResult(value: PipelineResult | PipelineContext): value is PipelineResult {
    return 'ok' in value;
  }

  private buildErrorResponse(wire: WireMessage, error: ErrorPayload): ResponseEnvelope {
    return {
      id: crypto.randomUUID(),
      version: PROTOCOL_VERSION,
      type: 'response',
      topic: wire.topic,
      source: 'core',
      correlation: wire.correlation,
      timestamp: new Date().toISOString(),
      group: '',
      payload: { result: null, error },
    };
  }
}

// ---------------------------------------------------------------------------
// IntegrationHarness
// ---------------------------------------------------------------------------

/** Auto-incrementing counter for unique container/connection IDs. */
let harnessCounter = 0;

export class IntegrationHarness {
  private readonly socketFactory: AutoWiringSocketFactory;
  private readonly catalog: ToolCatalog;
  private readonly sessionManager: SessionManager;
  private readonly rateLimiter: RateLimiter;
  private readonly toolGroupRestrictions: Map<string, Set<string>>;
  private readonly preApprovedCorrelations: Set<string>;
  private readonly router: FullPipelineRouter;
  private readonly requestChannel: RequestChannel;
  private readonly eventBus: EventBus;
  private closed = false;
  private _overrideRateConfig: RateLimiterConfig | null = null;
  private _testInputHandler: TestInputHandler | null = null;

  private constructor(
    socketFactory: AutoWiringSocketFactory,
    catalog: ToolCatalog,
    sessionManager: SessionManager,
    rateLimiter: RateLimiter,
    toolGroupRestrictions: Map<string, Set<string>>,
    preApprovedCorrelations: Set<string>,
    router: FullPipelineRouter,
    requestChannel: RequestChannel,
    eventBus: EventBus,
  ) {
    this.socketFactory = socketFactory;
    this.catalog = catalog;
    this.sessionManager = sessionManager;
    this.rateLimiter = rateLimiter;
    this.toolGroupRestrictions = toolGroupRestrictions;
    this.preApprovedCorrelations = preApprovedCorrelations;
    this.router = router;
    this.requestChannel = requestChannel;
    this.eventBus = eventBus;
  }

  /**
   * Create a new IntegrationHarness with all components wired together.
   *
   * Uses fake in-memory sockets — no real ZeroMQ, no Docker.
   */
  static async create(options?: {
    rateLimiterConfig?: RateLimiterConfig;
  }): Promise<IntegrationHarness> {
    const socketFactory = new AutoWiringSocketFactory();
    const catalog = new ToolCatalog();
    const sessionManager = new SessionManager();
    const rateLimiter = new RateLimiter(
      options?.rateLimiterConfig ?? { requestsPerMinute: 600, burstSize: 100 },
    );
    const toolGroupRestrictions = new Map<string, Set<string>>();
    const preApprovedCorrelations = new Set<string>();

    const router = new FullPipelineRouter(
      catalog,
      rateLimiter,
      toolGroupRestrictions,
      preApprovedCorrelations,
    );

    // Set up the request channel (ROUTER side)
    const requestChannel = new RequestChannel(socketFactory);
    await requestChannel.bind('inproc://harness-request');

    // Wire request handler: DEALER → ROUTER → pipeline → response
    requestChannel.onRequest((connectionIdentity, wireMessage) => {
      const session = sessionManager.getByConnectionIdentity(connectionIdentity);
      if (!session) {
        return;
      }

      const sessionContext = sessionManager.toSessionContext(session.sessionId);
      if (!sessionContext) {
        return;
      }

      void router.processRequest(wireMessage, sessionContext).then((response) => {
        void requestChannel.sendResponse(connectionIdentity, response);
      });
    });

    // Set up the event bus (PUB side)
    const eventBus = new EventBus(socketFactory);
    await eventBus.bind('inproc://harness-events');

    return new IntegrationHarness(
      socketFactory,
      catalog,
      sessionManager,
      rateLimiter,
      toolGroupRestrictions,
      preApprovedCorrelations,
      router,
      requestChannel,
      eventBus,
    );
  }

  // -------------------------------------------------------------------------
  // Plugin registration
  // -------------------------------------------------------------------------

  /** Register a tool with its handler in the catalog. */
  registerTool(tool: ToolDeclaration, handler: ToolHandler): void {
    this.catalog.register(tool, handler);
  }

  /**
   * Register only the tool declaration (no handler). Useful for testing
   * the PLUGIN_UNAVAILABLE path when a handler isn't available.
   *
   * Registers with a null handler so stage 2 (topic) passes but
   * stage 6 (dispatch) detects missing handler.
   */
  registerToolDeclarationOnly(tool: ToolDeclaration): void {
    this.catalog.register(tool, null as unknown as ToolHandler);
  }

  /** Get names of all registered tools. */
  getRegisteredTools(): string[] {
    return this.catalog.list().map((t) => t.name);
  }

  // -------------------------------------------------------------------------
  // Test-input plugin convenience
  // -------------------------------------------------------------------------

  /**
   * Register the test-input plugin's `test_respond` tool with a handler
   * backed by a TestInputHandler instance. Returns the handler for
   * direct access to `getResponses()`, `reset()`, etc.
   */
  registerTestInput(): TestInputHandler {
    const handler = new TestInputHandler();
    // Initialize with a mock ChannelServices that publishes through the harness event bus
    void handler.initialize({
      getAuditLog: async () => [],
      getToolCatalog: () => [],
      getSessionInfo: () => ({ group: 'test', sessionId: '', startedAt: '' }),
      publishEvent: async (partial) => {
        await this.eventBus.publish({
          id: crypto.randomUUID(),
          version: PROTOCOL_VERSION,
          type: 'event',
          topic: partial.topic,
          source: partial.source,
          correlation: null,
          timestamp: new Date().toISOString(),
          group: partial.group,
          payload: partial.payload,
        });
      },
    });

    // Register the test_respond tool with its manifest schema
    this.catalog.register(
      {
        name: 'test_respond',
        description: 'Respond to a test prompt with a text body',
        risk_level: 'low',
        arguments_schema: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: {
            body: {
              type: 'string',
              maxLength: 8192,
            },
          },
        },
      },
      async (envelope: RequestEnvelope) => {
        const args = envelope.payload.arguments;
        const context = {
          group: envelope.group,
          sessionId: envelope.source,
          correlationId: envelope.correlation,
          timestamp: envelope.timestamp,
        };
        const result = await handler.handleToolInvocation('test_respond', args, context);
        if (result.ok) {
          return result.result;
        }
        throw new Error(result.error.message);
      },
    );

    this._testInputHandler = handler;
    return handler;
  }

  /**
   * Submit a prompt through the test-input plugin. Requires
   * `registerTestInput()` to have been called first.
   *
   * Publishes a `message.inbound` event to the event bus with the
   * canonical schema shape. Returns the correlation ID.
   */
  async submitPrompt(prompt: string, options?: { group?: string }): Promise<string> {
    if (!this._testInputHandler) {
      throw new Error('Call registerTestInput() before submitPrompt()');
    }
    return this._testInputHandler.submit(prompt, options);
  }

  // -------------------------------------------------------------------------
  // Group restrictions
  // -------------------------------------------------------------------------

  /** Set group restriction for a tool. Only listed groups can invoke it. */
  setToolGroupRestriction(toolName: string, allowedGroups: string[]): void {
    this.toolGroupRestrictions.set(toolName, new Set(allowedGroups));
  }

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  /**
   * Set a rate limit override applied to all groups on session creation.
   * Must be called before createSession() to take effect.
   */
  setRateLimit(config: RateLimiterConfig): void {
    this._overrideRateConfig = config;
  }

  // -------------------------------------------------------------------------
  // Confirmation pre-approval
  // -------------------------------------------------------------------------

  /** Pre-approve a correlation ID for high-risk tool execution. */
  preApproveCorrelation(correlationId: string): void {
    this.preApprovedCorrelations.add(correlationId);
  }

  // -------------------------------------------------------------------------
  // Session simulation
  // -------------------------------------------------------------------------

  /** Create a simulated session. */
  createSession(options: { group: string; containerId?: string }): HarnessSession {
    harnessCounter += 1;
    const containerId = options.containerId ?? `harness-container-${harnessCounter}`;
    const connectionIdentity = Buffer.from(`harness-conn-${harnessCounter}`).toString('hex');

    const session = this.sessionManager.create({
      containerId,
      group: options.group,
      connectionIdentity,
    });

    if (this._overrideRateConfig) {
      this.rateLimiter.setGroupConfig(options.group, this._overrideRateConfig);
    }

    return {
      sessionId: session.sessionId,
      group: session.group,
      containerId: session.containerId,
      connectionIdentity: session.connectionIdentity,
    };
  }

  // -------------------------------------------------------------------------
  // Request sending (high-level)
  // -------------------------------------------------------------------------

  /**
   * Send a request through the full pipeline.
   *
   * Constructs a WireMessage, passes it through the FullPipelineRouter
   * (all 6 stages), and returns the ResponseEnvelope.
   */
  async sendRequest(
    session: HarnessSession,
    toolName: string,
    args: Record<string, unknown>,
    options?: SendRequestOptions,
  ): Promise<ResponseEnvelope> {
    const correlationId = options?.correlationId ?? crypto.randomUUID();

    const wire: WireMessage = {
      topic: `tool.invoke.${toolName}`,
      correlation: correlationId,
      arguments: args,
    };

    const sessionContext = this.sessionManager.toSessionContext(session.sessionId);
    if (!sessionContext) {
      throw new Error(`Session "${session.sessionId}" not found`);
    }

    return this.router.processRequest(wire, sessionContext);
  }

  // -------------------------------------------------------------------------
  // Wire-level request sending (ROUTER/DEALER)
  // -------------------------------------------------------------------------

  /**
   * Send a raw WireMessage through a DEALER socket and wait for the
   * response through the ROUTER. This exercises the full RequestChannel
   * wire-format path.
   */
  async sendWireRequest(
    session: HarnessSession,
    wire: WireMessage,
  ): Promise<ResponseEnvelope | null> {
    // Create a DEALER with the correct identity for this session.
    // The identity must match what the RequestChannel will convert via
    // identity.toString('hex') to look up the session.
    const dealer = new FakeDealerSocket();

    // Override identity to match the session's connectionIdentity.
    // The RequestChannel converts identity.toString('hex') to get
    // the connectionIdentity string, so the buffer must be the hex-decoded
    // form of the connectionIdentity.
    Object.defineProperty(dealer, 'identity', {
      value: Buffer.from(session.connectionIdentity, 'hex'),
      writable: false,
      configurable: true,
    });

    // Wire to the ROUTER socket
    const routers = this.socketFactory.getRouters();
    if (routers.length === 0) {
      throw new Error('No ROUTER socket bound yet');
    }
    dealer.connectedTo = routers[0] as FakeRouterSocket;
    await dealer.connect('inproc://harness-request');

    return new Promise<ResponseEnvelope | null>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 5000);

      dealer.on('message', (payload: Buffer) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(JSON.parse(payload.toString()) as ResponseEnvelope);
        }
      });

      void dealer.send(Buffer.from(JSON.stringify(wire)));
    });
  }

  // -------------------------------------------------------------------------
  // Event bus
  // -------------------------------------------------------------------------

  /** Publish an event through the event bus. */
  async publishEvent(envelope: EventEnvelope): Promise<void> {
    await this.eventBus.publish(envelope);
  }

  /**
   * Subscribe to events on the event bus.
   *
   * The returned handle can be used to unsubscribe.
   */
  async subscribeEvents(
    topics: string[],
    handler: (envelope: Envelope) => void,
  ): Promise<SubscriptionHandle> {
    const sub = await this.eventBus.subscribe('inproc://harness-events', topics);
    sub.onMessage(handler);
    return sub;
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  /** Get the underlying socket factory for advanced assertions. */
  getSocketFactory(): AutoWiringSocketFactory {
    return this.socketFactory;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close all resources. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.requestChannel.close();
    await this.eventBus.close();
    this.sessionManager.cleanup();
    this.rateLimiter.cleanup();
    await this.socketFactory.cleanup();
  }
}
