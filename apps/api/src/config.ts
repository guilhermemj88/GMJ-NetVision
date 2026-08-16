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
});

export const config = envSchema.parse(process.env);
