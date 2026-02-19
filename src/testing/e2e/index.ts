/**
 * E2E test infrastructure public API (QA-08).
 */

// Types
export type {
  E2EScenario,
  ScenarioContext,
  SemanticAssertion,
  ScenarioRecording,
  RecordedInvocation,
  ScenarioAttempt,
  ScenarioResult,
  SuiteReport,
  CostMetrics,
  AssertionResult,
} from './types.js';

// Assertion builders
export {
  toolInvoked,
  toolNotInvoked,
  toolInvokedCount,
  toolInvokedInOrder,
  noErrors,
  errorCode,
  responseContains,
  toolArgsMatch,
  custom,
  describeAssertion,
  evaluateAssertion,
  evaluateAllAssertions,
} from './assertions.js';

// Scenario runner
export { runScenario, runSuite } from './scenario-runner.js';

// Mock plugins
export {
  type MockPlugin,
  echoTool,
  readEmailTool,
  sendEmailTool,
  calculatorTool,
  getSessionInfoTool,
  deleteAllDataTool,
  failingTool,
  memorySearchTool,
  registerMockPlugin,
  registerMockPlugins,
} from './mock-plugins.js';

// Result reporter
export {
  formatTextReport,
  formatJsonReport,
  formatJUnitReport,
  getAssertionSummary,
} from './result-reporter.js';
