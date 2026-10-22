import type { SnmpProfile } from './types';

/**
 * JUNIPER-SUBSCRIBER-MIB. Colunas da subscriber table usadas para contar PPPoE
 * ativos, validadas em campo contra `show subscribers summary` nos dois MX da
 * Speedyway (Junos 19.2R1.8 e 19.4R3-S10.3).
 *
 * `jnxSubscriberActiveCount` NAO e usado: aquele scalar conta todos os
 * subscribers ativos (PPPoE + DHCP + outros) e foi comprovadamente inadequado
 * como PPP online.
 */
export const JUNIPER_SUBSCRIBER_CLIENT_TYPE_OID = '1.3.6.1.4.1.2636.3.64.1.1.1.3.1.4';
export const JUNIPER_SUBSCRIBER_STATE_OID = '1.3.6.1.4.1.2636.3.64.1.1.1.3.1.12';

/** clientType PPPoE comprovado (0x010000); DHCP e 4194304 (0x400000). */
export const JUNIPER_CLIENT_TYPE_PPPOE = 65_536;
/** state ACTIVE comprovado; Configured=1, Init=0, Terminating=4. */
export const JUNIPER_SUBSCRIBER_STATE_ACTIVE = 2;

/** Ciclo completo (dois walks) medido em ~5,3-5,8 s e ~607-632 KB. */
export const JUNIPER_PPP_INTERVAL_SECONDS = 300;

export const juniperProfile: SnmpProfile = {
  id: 'juniper',
  vendor: 'Juniper',
  family: 'Junos',
  priority: 400,
  vendorPatterns: [/juniper/i],
  modelPatterns: [/\bmx\d+/i],
  sysDescrPatterns: [/juniper networks/i, /\bjunos\b/i],
  sysObjectIdPatterns: [/^1\.3\.6\.1\.4\.1\.2636(?:\.|$)/],
  metrics: {},
  pppSubscriberTable: {
    source: 'SNMP_JUNIPER',
    clientTypeOid: JUNIPER_SUBSCRIBER_CLIENT_TYPE_OID,
    stateOid: JUNIPER_SUBSCRIBER_STATE_OID,
    clientTypePppoe: JUNIPER_CLIENT_TYPE_PPPOE,
    stateActive: JUNIPER_SUBSCRIBER_STATE_ACTIVE,
    intervalSeconds: JUNIPER_PPP_INTERVAL_SECONDS,
  },
};
