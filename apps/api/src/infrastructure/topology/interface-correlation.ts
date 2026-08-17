import type { NetworkInterface } from '@gmj/shared';

const interfacePrefixes: Array<[RegExp, string]> = [
  [/^hundredgigabitethernet/i, '100ge'],
  [/^100gigabitethernet/i, '100ge'],
  [/^fortygigabitethernet/i, '40ge'],
  [/^tengigabitethernet/i, '10ge'],
  [/^xgigabitethernet/i, 'xge'],
  [/^gigabitethernet/i, 'ge'],
  [/^ethernet/i, 'eth'],
];

export function normalizeInterfaceName(value: string): string {
  let normalized = value.trim();
  for (const [pattern, replacement] of interfacePrefixes) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement);
      break;
    }
  }
  return normalized.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Returns normalized full text plus any Huawei interface token embedded in it. */
export function interfaceNameKeys(value: string): string[] {
  const keys = new Set<string>();
  const full = normalizeInterfaceName(value);
  if (full) keys.add(full);
  const embedded = value.match(
    /(?:100GE|HundredGigabitEthernet|40GE|FortyGigabitEthernet|10GE|TenGigabitEthernet|XGE|XGigabitEthernet|GE|GigabitEthernet|Eth-?Trunk)\s*[0-9][0-9/.-]*/i,
  )?.[0];
  if (embedded) keys.add(normalizeInterfaceName(embedded));
  return [...keys];
}

function hasUsefulAlias(networkInterface: NetworkInterface): boolean {
  const alias = networkInterface.alias.trim();
  if (!alias || /^(?:-|--|n\/?a|none|null|unknown|interface)$/i.test(alias)) return false;
  const normalized = normalizeInterfaceName(alias);
  return normalized !== normalizeInterfaceName(networkInterface.name)
    && normalized !== normalizeInterfaceName(networkInterface.description);
}

/**
 * SNMP owns identity, ifIndex, status, capacity and counters. SSH may fill the
 * configured port description only when IF-MIB did not provide a useful alias.
 * Unmatched SSH rows are intentionally not appended because they do not have a
 * trustworthy ifIndex and would otherwise create duplicate physical ports.
 */
export function mergeSnmpAndSshInterfaces(
  snmpInterfaces: NetworkInterface[],
  sshInterfaces: NetworkInterface[],
): NetworkInterface[] {
  const sshByName = new Map<string, NetworkInterface[]>();
  for (const item of sshInterfaces) {
    const key = normalizeInterfaceName(item.name);
    if (!key) continue;
    sshByName.set(key, [...(sshByName.get(key) ?? []), item]);
  }

  return snmpInterfaces.map((snmpInterface) => {
    const candidateKeys = [snmpInterface.name, snmpInterface.description]
      .map(normalizeInterfaceName)
      .filter(Boolean);
    const candidates = candidateKeys.flatMap((key) => sshByName.get(key) ?? []);
    const unique = [...new Map(candidates.map((item) => [item.name, item])).values()];
    if (unique.length !== 1) return snmpInterface;

    const sshInterface = unique[0]!;
    const sshDescription = sshInterface.alias.trim();
    const dataSources = [...new Set([...(snmpInterface.dataSources ?? ['SNMP']), 'SSH' as const])];
    return {
      ...snmpInterface,
      alias: !hasUsefulAlias(snmpInterface) && sshDescription
        ? sshDescription
        : snmpInterface.alias,
      dataSources,
    };
  });
}
