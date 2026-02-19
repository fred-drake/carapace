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
