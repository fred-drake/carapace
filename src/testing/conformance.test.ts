/**
 * Conformance test suite validation.
 *
 * Runs the conformance suite against the echo plugin example to prove
 * that the suite works correctly with a known-good plugin.
 */

import { resolve } from 'node:path';
import { describePluginConformance } from './conformance.js';

// Run conformance against the echo plugin — all tests should pass.
describePluginConformance({
  pluginDir: resolve(import.meta.dirname, '../../examples/echo-plugin'),
  sampleArgs: {
    echo: { text: 'hello world' },
  },
});
