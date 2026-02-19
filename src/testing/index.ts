export {
  type DeepPartial,
  deepMerge,
  createWireMessage,
  createEventEnvelope,
  createRequestEnvelope,
  createResponseEnvelope,
  createToolDeclaration,
  createManifest,
  createErrorPayload,
} from './factories.js';

export {
  type InjectedErrorType,
  type PubSubMessage,
  type RouterMessage,
  type DealerMessage,
  type FakePubSubPair,
  type FakeRouterDealerPair,
  FakePubSocket,
  FakeSubSocket,
  FakeRouterSocket,
  FakeDealerSocket,
  wireFakePubSub,
  wireFakeRouterDealer,
} from './fake-sockets.js';

export { FakeSocketFactory } from './fake-socket-factory.js';

export { MockContainerRuntime } from '../core/container/mock-runtime.js';

export { IpcTestHarness } from './ipc-test-harness.js';

export {
  createTestContext,
  createTestInvocation,
  type TestInvocationOptions,
  FakeCredentialStore,
  assertSuccessResult,
  assertErrorResult,
  assertNoCredentialLeak,
} from './plugin-test-sdk.js';

export { describePluginConformance, type ConformanceOptions } from './conformance.js';

export {
  IntegrationHarness,
  type HarnessSession,
  type SendRequestOptions,
} from './integration-harness.js';
