export type ProviderErrorCategory = 'authentication' | 'provider-rejection' | 'rate-limit' | 'transport' | 'unknown';

/** Classify own status/code metadata without exposing private error text. */
export function providerErrorCategory(error: unknown): ProviderErrorCategory {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return 'unknown';
  try {
    const statusDescriptor = Object.getOwnPropertyDescriptor(error, 'status');
    const status = statusDescriptor && Object.hasOwn(statusDescriptor, 'value') ? statusDescriptor.value : undefined;
    switch (status) {
      case 401: case 403: return 'authentication';
      case 400: case 404: case 409: case 413: case 422: return 'provider-rejection';
      case 429: return 'rate-limit';
      case 408: case 500: case 502: case 503: case 504: return 'transport';
    }
    const codeDescriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = codeDescriptor && Object.hasOwn(codeDescriptor, 'value') ? codeDescriptor.value : undefined;
    switch (code) {
      case 'ECONNRESET': case 'ECONNREFUSED': case 'ETIMEDOUT': case 'ENOTFOUND': case 'EAI_AGAIN': return 'transport';
    }
  } catch { /* Descriptor failures are unknown, not replacement failures. */ }
  return 'unknown';
}
