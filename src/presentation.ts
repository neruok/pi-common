export interface ReportHost {
  sendMessage(message: { customType: string; content: string; display: boolean; details: { level: 'info' | 'error' } }, options: { triggerTurn: false }): void;
}
export interface ReportContext {
  hasUI: boolean;
  ui: { notify(text: string, level: 'info' | 'error'): void };
}

/** Sanitize data before theme styling. Preserve multiline text, not terminal controls. */
export function sanitizeText(text: string): string {
  return text.replace(/\t/g, ' ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
}
export function sanitizeLabel(value: unknown): string {
  return sanitizeText(String(value ?? '')).replace(/\n/g, ' ');
}

/** Reporting never starts a turn or changes the operation's outcome. */
export function reportCommand(
  pi: ReportHost,
  ctx: ReportContext,
  customType: string,
  content: string,
  level: 'info' | 'error',
): boolean {
  try {
    const text = sanitizeText(content);
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType, content: text, display: true, details: { level } }, { triggerTurn: false });
    return true;
  } catch {
    console.error(`${sanitizeLabel(customType)}: could not report the result.`);
    return false;
  }
}
