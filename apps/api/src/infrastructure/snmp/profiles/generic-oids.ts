/**
 * Consolidated GENERIC SNMP base profile OIDs (SNMPv2-MIB + IF-MIB).
 *
 * These are the universal, vendor-agnostic OIDs every SNMP-capable device is
 * expected to answer. Vendor-specific profiles complement — never duplicate —
 * this base set.
 */
export const GENERIC_SYSTEM_OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectId: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysContact: '1.3.6.1.2.1.1.4.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
  hrSystemUptime: '1.3.6.1.2.1.25.1.1.0',
} as const;

export const GENERIC_INTERFACE_OIDS = {
  ifIndex: '1.3.6.1.2.1.2.2.1.1',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifMtu: '1.3.6.1.2.1.2.2.1.4',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifInDiscards: '1.3.6.1.2.1.2.2.1.13',
  ifOutDiscards: '1.3.6.1.2.1.2.2.1.19',
} as const;

/** Generic legacy (non-64-bit) interface counters used as an IF-MIB fallback. */
export const GENERIC_LEGACY_COUNTER_OIDS = {
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
} as const;
