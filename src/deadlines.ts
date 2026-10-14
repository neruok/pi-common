/** Preserve elapsed-budget arithmetic. The caller supplies one clock basis. */
export function remainingBudgetMs(startedMs: number, timeoutMs: number, nowMs: number): number {
  return timeoutMs - (nowMs - startedMs);
}

/** Preserve absolute-deadline arithmetic without reading a clock or rounding. */
export function remainingDeadlineMs(deadlineAtMs: number, nowMs: number): number {
  return deadlineAtMs - nowMs;
}
