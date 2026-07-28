/** Accept only credential-free HTTP(S) product links. Userinfo can leak secrets through
 * rendered markup, browser history, referrers, and screenshots, so it fails closed. */
export function trustedSurfaceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}
