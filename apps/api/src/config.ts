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
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
});

export const config = envSchema.parse(process.env);
