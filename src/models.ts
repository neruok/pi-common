import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';

import type { Reasoning } from './model-types.js';
export { REASONING_LEVELS } from './model-types.js';
export type { Reasoning, ModelSelection, PickerModel } from './model-types.js';

export function supportedReasoning(model: Model<Api>): Reasoning[] {
  return ['default', ...getSupportedThinkingLevels(model)];
}
export function supportsReasoning(model: Model<Api>, level?: Reasoning): boolean {
  return level === undefined || supportedReasoning(model).includes(level);
}
