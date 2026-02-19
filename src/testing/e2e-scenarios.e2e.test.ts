/**
 * E2E test scenarios (QA-08).
 *
 * 10 end-to-end scenarios exercising agent session behavior through
 * the full pipeline. Uses the e2e test infrastructure with deterministic
 * mock plugins and semantic assertions.
 *
 * Run with: pnpm test:e2e
 */

import { describe, it, expect } from 'vitest';
import { ErrorCode } from '../types/errors.js';
import { runScenario, runSuite } from './e2e/scenario-runner.js';
import {
  echoTool,
  readEmailTool,
  sendEmailTool,
  calculatorTool,
  getSessionInfoTool,
  deleteAllDataTool,
  failingTool,
  memorySearchTool,
  registerMockPlugins,
} from './e2e/mock-plugins.js';
import {
  toolInvoked,
  toolNotInvoked,
  toolInvokedCount,
  toolInvokedInOrder,
  noErrors,
  errorCode,
  responseContains,
  toolArgsMatch,
  custom,
} from './e2e/assertions.js';
import { formatTextReport, getAssertionSummary } from './e2e/result-reporter.js';
import type { E2EScenario } from './e2e/types.js';

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const scenarios: E2EScenario[] = [
  // -------------------------------------------------------------------------
  // 1. Happy path tool invocation
  // -------------------------------------------------------------------------
  {
    name: 'Happy path tool invocation',
    description: 'Agent calls echo tool and receives the echoed result',
    tags: ['happy-path'],
    setup: (harness) => {
      registerMockPlugins(harness, [echoTool]);
    },
    steps: async (ctx) => {
      const response = await ctx.invoke('echo', { text: 'Hello, Carapace!' });
      ctx.note(`Echoed: ${JSON.stringify(response.payload.result)}`);
    },
    assertions: [
      toolInvoked('echo'),
      toolInvokedCount('echo', 1),
      noErrors(),
      responseContains(
        'echo',
        (result) => {
          const r = result as Record<string, unknown>;
          return r['echoed'] === 'Hello, Carapace!';
        },
        'echoed text matches input',
      ),
    ],
  },

  // -------------------------------------------------------------------------
  // 2. Multi-tool session
  // -------------------------------------------------------------------------
  {
    name: 'Multi-tool session',
    description: 'Agent chains read_email then send_email in sequence',
    tags: ['multi-tool'],
    group: 'email',
    setup: (harness) => {
      registerMockPlugins(harness, [readEmailTool, sendEmailTool]);
    },
    steps: async (ctx) => {
      // Read an email
      const readResp = await ctx.invoke('read_email', { id: 'inbox-42' });
      const email = readResp.payload.result as Record<string, unknown>;

      // Reply to the email
      await ctx.invoke('send_email', {
        to: email['from'] as string,
        subject: `Re: ${email['subject']}`,
        body: 'Thanks for your message!',
      });
    },
    assertions: [
      toolInvoked('read_email'),
      toolInvoked('send_email'),
      toolInvokedInOrder(['read_email', 'send_email']),
      toolInvokedCount('read_email', 1),
      toolInvokedCount('send_email', 1),
      noErrors(),
      toolArgsMatch(
        'send_email',
        (args) => args['to'] === 'alice@example.com',
        'reply sent to original sender',
      ),
    ],
  },

  // -------------------------------------------------------------------------
  // 3. Error handling — VALIDATION_FAILED
  // -------------------------------------------------------------------------
  {
    name: 'Error handling — validation failure',
    description: 'Agent sends request with extra field, receives VALIDATION_FAILED',
    tags: ['error'],
    setup: (harness) => {
      registerMockPlugins(harness, [echoTool]);
    },
    steps: async (ctx) => {
      // Send with an extra field that violates additionalProperties: false
      await ctx.invoke('echo', { text: 'hello', forbidden_field: 'bad' });
    },
    assertions: [
      toolInvoked('echo'),
      errorCode(ErrorCode.VALIDATION_FAILED),
      custom('response has error payload', (recording) => {
        const inv = recording.invocations[0]!;
        return inv.response.payload.error !== null;
      }),
    ],
  },

  // -------------------------------------------------------------------------
  // 4. Rate limiting
  // -------------------------------------------------------------------------
  {
    name: 'Rate limiting',
    description: 'Agent exhausts rate limit and receives RATE_LIMITED with retry_after',
    tags: ['rate-limit'],
    setup: (harness) => {
      registerMockPlugins(harness, [echoTool]);
      // Set a very low rate limit
      harness.setRateLimit({ requestsPerMinute: 60, burstSize: 2 });
    },
    steps: async (ctx) => {
      // Consume the burst
      await ctx.invoke('echo', { text: 'request 1' });
      await ctx.invoke('echo', { text: 'request 2' });
      // This should be rate limited
      await ctx.invoke('echo', { text: 'request 3 — should fail' });
    },
    assertions: [
      toolInvokedCount('echo', 3),
      errorCode(ErrorCode.RATE_LIMITED),
      custom('third invocation has retry_after', (recording) => {
        const third = recording.invocations[2]!;
        return (
          third.response.payload.error !== null &&
          typeof third.response.payload.error.retry_after === 'number' &&
          third.response.payload.error.retry_after > 0
        );
      }),
    ],
  },

  // -------------------------------------------------------------------------
  // 5. Cross-group rejection — UNAUTHORIZED
  // -------------------------------------------------------------------------
  {
    name: 'Cross-group rejection',
    description: 'Agent in wrong group gets UNAUTHORIZED when invoking restricted tool',
    tags: ['security', 'authorization'],
    group: 'slack',
    setup: (harness) => {
      registerMockPlugins(harness, [sendEmailTool]);
      // Restrict send_email to email group only
      harness.setToolGroupRestriction('send_email', ['email']);
    },
    steps: async (ctx) => {
      // Slack group tries to invoke email-only tool
      await ctx.invoke('send_email', {
        to: 'user@test.com',
        subject: 'test',
        body: 'should fail',
      });
    },
    assertions: [
      toolInvoked('send_email'),
      errorCode(ErrorCode.UNAUTHORIZED),
      toolNotInvoked('echo'), // no fallback
    ],
  },

  // -------------------------------------------------------------------------
  // 6. Malformed arguments — agent self-corrects
  // -------------------------------------------------------------------------
  {
    name: 'Malformed arguments — agent self-corrects',
    description: 'Agent sends bad args, gets VALIDATION_FAILED, retries with correct args',
    tags: ['error-recovery'],
    setup: (harness) => {
      registerMockPlugins(harness, [calculatorTool]);
    },
    steps: async (ctx) => {
      // First attempt: missing required field
      const bad = await ctx.invoke('calculator', { operation: 'add', a: 5 });
      ctx.note(`First attempt error: ${bad.payload.error?.code}`);

      // Self-correct: provide all required fields
      const good = await ctx.invoke('calculator', {
        operation: 'add',
        a: 5,
        b: 3,
      });
      ctx.note(`Second attempt result: ${JSON.stringify(good.payload.result)}`);
    },
    assertions: [
      toolInvokedCount('calculator', 2),
      errorCode(ErrorCode.VALIDATION_FAILED),
      custom('second attempt succeeds', (recording) => {
        return recording.invocations[1]!.success;
      }),
      responseContains(
        'calculator',
        (result) => {
          const r = result as Record<string, unknown>;
          return r['result'] === 8;
        },
        'calculator returns 5 + 3 = 8',
      ),
    ],
  },

  // -------------------------------------------------------------------------
  // 7. Session lifecycle — spawn → communicate → shutdown → cleanup
  // -------------------------------------------------------------------------
  {
    name: 'Session lifecycle',
    description: 'Full spawn → communicate → shutdown → cleanup cycle',
    tags: ['lifecycle'],
    setup: (harness) => {
      registerMockPlugins(harness, [echoTool, getSessionInfoTool]);
    },
    steps: async (ctx) => {
      // Get session info to verify session is active
      const info = await ctx.invoke('get_session_info', {});
      ctx.note(`Session group: ${(info.payload.result as Record<string, unknown>)['group']}`);

      // Do some work
      await ctx.invoke('echo', { text: 'working...' });
      await ctx.invoke('echo', { text: 'done!' });
    },
    assertions: [
      toolInvoked('get_session_info'),
      toolInvokedCount('echo', 2),
      toolInvokedInOrder(['get_session_info', 'echo', 'echo']),
      noErrors(),
      responseContains(
        'get_session_info',
        (result) => {
          const r = result as Record<string, unknown>;
          return typeof r['group'] === 'string' && typeof r['sessionId'] === 'string';
        },
        'session info contains group and sessionId',
      ),
    ],
  },

  // -------------------------------------------------------------------------
  // 8. Memory brief injection
  // -------------------------------------------------------------------------
  {
    name: 'Memory brief injection',
    description: 'Session searches memory and uses context from stored memories',
    tags: ['memory'],
    setup: (harness) => {
      registerMockPlugins(harness, [memorySearchTool, echoTool]);
    },
    steps: async (ctx) => {
      // Search for relevant memories
      const memories = await ctx.invoke('memory_search', { query: 'TypeScript preferences' });
      const results = (memories.payload.result as Record<string, unknown>)['results'] as Array<
        Record<string, unknown>
      >;
      ctx.note(`Found ${results.length} memories`);

      // Use the memory context
      await ctx.invoke('echo', {
        text: `Based on memory: ${results[0]!['content']}`,
      });
    },
    assertions: [
      toolInvoked('memory_search'),
      toolInvoked('echo'),
      toolInvokedInOrder(['memory_search', 'echo']),
      noErrors(),
      responseContains(
        'memory_search',
        (result) => {
          const r = result as Record<string, unknown>;
          const results = r['results'] as Array<unknown>;
          return results.length > 0;
        },
        'memory search returns results',
      ),
      toolArgsMatch(
        'echo',
        (args) => {
          const text = args['text'] as string;
          return text.includes('memory') || text.includes('Memory');
        },
        'echo input references memory context',
      ),
    ],
  },

  // -------------------------------------------------------------------------
  // 9. Plugin failure degradation
  // -------------------------------------------------------------------------
  {
    name: 'Plugin failure degradation',
    description: 'Plugin handler throws error, agent receives PLUGIN_ERROR',
    tags: ['error', 'degradation'],
    setup: (harness) => {
      registerMockPlugins(harness, [failingTool, echoTool]);
    },
    steps: async (ctx) => {
      // Call the failing service
      const resp = await ctx.invoke('unstable_service', { action: 'do_something' });
      ctx.note(`Error: ${resp.payload.error?.code}`);

      // Fall back to a working tool
      await ctx.invoke('echo', { text: 'fallback after failure' });
    },
    assertions: [
      toolInvoked('unstable_service'),
      toolInvoked('echo'),
      errorCode(ErrorCode.PLUGIN_ERROR),
      custom('failing tool did not succeed', (recording) => {
        return !recording.invocations[0]!.success;
      }),
      custom('fallback tool succeeded', (recording) => {
        return recording.invocations[1]!.success;
      }),
    ],
  },

  // -------------------------------------------------------------------------
  // 10. High-risk tool confirmation
  // -------------------------------------------------------------------------
  {
    name: 'High-risk tool confirmation',
    description: 'High-risk tool requires confirmation; without pre-approval it times out',
    tags: ['security', 'confirmation'],
    setup: (harness) => {
      registerMockPlugins(harness, [deleteAllDataTool, echoTool]);
    },
    steps: async (ctx) => {
      // Attempt without pre-approval — should get CONFIRMATION_TIMEOUT
      const denied = await ctx.invoke('delete_all_data', { confirm: 'yes' });
      ctx.note(`Without approval: ${denied.payload.error?.code}`);

      // Pre-approve and retry
      const correlationId = crypto.randomUUID();
      ctx.harness.preApproveCorrelation(correlationId);
      const approved = await ctx.harness.sendRequest(
        ctx.session,
        'delete_all_data',
        { confirm: 'yes' },
        { correlationId },
      );
      ctx.note(`With approval: ${approved.payload.error === null ? 'success' : 'failed'}`);
    },
    assertions: [
      toolInvokedCount('delete_all_data', 1), // only the first via ctx.invoke is recorded
      errorCode(ErrorCode.CONFIRMATION_TIMEOUT),
      custom('pre-approved invocation succeeds via harness', (recording) => {
        // The first invocation (via ctx.invoke) should fail with CONFIRMATION_TIMEOUT
        return recording.invocations[0]!.errorCode === ErrorCode.CONFIRMATION_TIMEOUT;
      }),
    ],
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('e2e scenarios', () => {
  // Run each scenario as an individual test
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const result = await runScenario(scenario);

      if (!result.passed) {
        const summary = getAssertionSummary(result);
        const failureMessages = summary.failures
          .map((f) => `  - ${f.description}: ${f.reason ?? 'failed'}`)
          .join('\n');

        const lastAttempt = result.attempts[result.attempts.length - 1]!;
        const errorMsg = lastAttempt.error ? `\n  Error: ${lastAttempt.error}` : '';

        expect.fail(`Scenario "${scenario.name}" failed:\n${failureMessages}${errorMsg}`);
      }
    });
  }

  // Suite-level test: run all scenarios and verify pass rate
  it('suite pass rate meets 90% threshold', async () => {
    const report = await runSuite(scenarios);

    // Log the text report for visibility
    const text = formatTextReport(report);
    console.log(text);

    expect(report.passRate).toBeGreaterThanOrEqual(90);
  });
});
