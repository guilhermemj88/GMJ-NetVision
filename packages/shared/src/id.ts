export type RandomUuidFactory = (() => string) | null;

function browserUuidFactory(): RandomUuidFactory {
  const cryptoApi = globalThis.crypto;
  return typeof cryptoApi?.randomUUID === 'function' ? cryptoApi.randomUUID.bind(cryptoApi) : null;
}

/**
 * Generates an opaque local identifier without assuming randomUUID support.
 * The optional factory keeps the fallback independently testable on older browsers.
 */
export function createLocalId(
  prefix = 'local',
  uuidFactory: RandomUuidFactory = browserUuidFactory(),
): string {
  if (uuidFactory) {
    try {
      return `${prefix}-${uuidFactory()}`;
    } catch {
      // Sandboxed/legacy browsers may expose crypto but reject randomUUID at runtime.
    }
  }

  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}-${timestamp}-${random}`;
}
