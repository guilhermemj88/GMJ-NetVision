/**
 * Configuracao do renderer de snapshot (servico isolado, rede local apenas).
 * NENHUM segredo de dominio entra aqui: sem DATABASE_URL, sem
 * CREDENTIAL_ENCRYPTION_KEY, sem community SNMP, sem SSH, sem token de webhook.
 */
export interface SnapshotRendererConfig {
  port: number;
  host: string;
  allowedOrigin: string;
  renderToken: string | null;
  cacheDir: string;
  maxConcurrent: number;
  timeoutMs: number;
  navTimeoutMs: number;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SnapshotRendererConfig {
  return {
    port: readNumber(env.SNAPSHOT_RENDERER_PORT, 3351),
    host: env.SNAPSHOT_RENDERER_HOST ?? '127.0.0.1',
    allowedOrigin: (env.SNAPSHOT_ALLOWED_ORIGIN ?? 'http://127.0.0.1:3005').replace(/\/+$/, ''),
    renderToken: env.SNAPSHOT_RENDER_TOKEN?.trim() || null,
    cacheDir: env.SNAPSHOT_CACHE_DIR ?? '/var/lib/netvision-alarm-snapshots',
    maxConcurrent: readNumber(env.SNAPSHOT_MAX_CONCURRENT, 1),
    timeoutMs: readNumber(env.SNAPSHOT_RENDER_TIMEOUT_MS, 15_000),
    navTimeoutMs: readNumber(env.SNAPSHOT_NAV_TIMEOUT_MS, 10_000),
  };
}
