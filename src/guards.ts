/**
 * The package's canonical structural type guard.
 *
 * Anthropic request and response payloads are traversed as untyped JSON, so a
 * single shared guard keeps the narrowing consistent instead of each module
 * re-deriving one.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
