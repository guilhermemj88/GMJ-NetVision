/**
 * Allowlist de destino: o renderer so abre a pagina INTERNA do NetVision. Sem
 * isso, o servico seria um SSRF de rede local (metadata, paineis, qualquer
 * host alcancavel).
 */
export function isAllowedTarget(target: string, allowedOrigin: string): boolean {
  let parsed: URL;
  let allowed: URL;
  try {
    parsed = new URL(target);
    allowed = new URL(allowedOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname !== allowed.hostname) return false;
  if (parsed.port !== allowed.port) return false;
  return true;
}

/** Somente a pagina `/snapshot/<token>` e navegavel. */
export function isAllowedSnapshotPath(target: string): boolean {
  try {
    // Base sintetica: aceita tanto a URL absoluta (uso real) quanto o caminho
    // relativo, sem nunca resolver para outro host.
    const { pathname, search } = new URL(target, 'http://snapshot.invalid');
    if (search.length > 0) return false;
    if (pathname.includes('..')) return false;
    return /^\/snapshot\/[A-Za-z0-9._~-]{16,4096}$/.test(pathname);
  } catch {
    return false;
  }
}
