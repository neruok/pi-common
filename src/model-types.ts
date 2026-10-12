/** Data-only types and values. Safe for provider-free cores and standalone scripts. */
export const REASONING_LEVELS = Object.freeze(['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const);
export type Reasoning = typeof REASONING_LEVELS[number];
export type ModelSelection = { provider: string; model: string; reasoning?: Reasoning };
export type PickerModel = { provider: string; id: string; name?: string };
