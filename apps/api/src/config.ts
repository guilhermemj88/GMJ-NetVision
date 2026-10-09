import { z } from 'zod';

const envSchema = z.object({
  DEMO_MODE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),
  ZABBIX_URL: z.string().url().optional().or(z.literal('')),
  ZABBIX_TOKEN: z.string().optional(),
  ZABBIX_AUTH_MODE: z.enum(['AUTH_FIELD', 'BEARER']).default('AUTH_FIELD'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  SNMP_POLLING_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  SNMP_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
  OPTICAL_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(300),
  /** Validade dos thresholds opticos coletados por SSH (slow path). */
  OPTICAL_THRESHOLD_REFRESH_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Cooldown por device depois de falha SSH ao coletar thresholds. */
  OPTICAL_THRESHOLD_FAILURE_COOLDOWN_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  DEMO_ADMIN_PASSWORD: z.string().min(1).default('admin'),
  DEFAULT_ADMIN_USERNAME: z.string().min(1).default('admin'),
  DEFAULT_ADMIN_EMAIL: z.string().email().default('admin@netvision.local'),
  DEFAULT_ADMIN_NAME: z.string().default('Administrador'),
  DEFAULT_ADMIN_PASSWORD: z.string().min(1).default('admin'),
  /**
   * Snapshot do gráfico do alarme (renderer isolado em 127.0.0.1:3351). Sem
   * estas variaveis o recurso fica DESLIGADO e o alarme segue texto-only.
   */
  SNAPSHOT_RENDERER_URL: z.string().optional(),
  SNAPSHOT_SIGNING_KEY: z.string().min(16).optional(),
  SNAPSHOT_WEB_INTERNAL_URL: z.string().optional(),
  SNAPSHOT_PUBLIC_API_URL: z.string().optional(),
  SNAPSHOT_CACHE_DIR: z.string().default('/var/lib/netvision-alarm-snapshots'),
  SNAPSHOT_TTL_SECONDS: z.coerce.number().int().min(60).max(7200).default(900),
  /** Retencao dos PNGs no cache do snapshot (horas). */
  SNAPSHOT_CACHE_KEEP_HOURS: z.coerce.number().int().min(1).max(720).default(24),
});

const parsed = envSchema.parse(process.env);
const isTest = process.env.NODE_ENV === 'test';

// Tests must not inherit production integration settings from the host running
// the suite. Keeping them in demo mode prevents accidental PostgreSQL, SNMP or
// Zabbix access and makes the API tests deterministic on deployment servers.
export const config = {
  ...parsed,
  DEMO_MODE: isTest ? true : parsed.DEMO_MODE,
  SNMP_POLLING_ENABLED: isTest ? false : parsed.SNMP_POLLING_ENABLED,
  ZABBIX_URL: isTest ? undefined : parsed.ZABBIX_URL,
  ZABBIX_TOKEN: isTest ? undefined : parsed.ZABBIX_TOKEN,
  SNAPSHOT_RENDERER_URL: isTest ? undefined : parsed.SNAPSHOT_RENDERER_URL,
  SNAPSHOT_SIGNING_KEY: isTest ? undefined : parsed.SNAPSHOT_SIGNING_KEY,
  SNAPSHOT_WEB_INTERNAL_URL: isTest ? undefined : parsed.SNAPSHOT_WEB_INTERNAL_URL,
  SNAPSHOT_PUBLIC_API_URL: isTest ? undefined : parsed.SNAPSHOT_PUBLIC_API_URL,
};
