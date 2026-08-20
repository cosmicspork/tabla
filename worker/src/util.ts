/** Small helpers shared by the Durable Objects. */

/**
 * Compares two tokens without leaking where they first differ.
 *
 * Both are base64url of the same length by schema, so comparing characters is
 * safe and the length check is a formality rather than an early exit worth
 * hiding.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
