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
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  DEMO_ADMIN_PASSWORD: z.string().min(6).default('netvision'),
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
};
