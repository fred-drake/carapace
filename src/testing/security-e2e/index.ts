/**
 * Public API for the adversarial security e2e test framework (SEC-12).
 */

// Types
export type { DefenseLayer, AdversarialScenario, DefenseMapping, DefenseReport } from './types.js';
export { DEFENSE_LAYER_DESCRIPTIONS } from './types.js';

// Adversarial plugins
export {
  messageProcessorTool,
  memoryStoreTool,
  memoryBriefTool,
  credentialLeakerTool,
  fileAccessTool,
  shellExecTool,
  settingsAccessorTool,
} from './adversarial-plugins.js';

// Defense report
export { buildDefenseReport, formatDefenseReport } from './defense-map.js';
