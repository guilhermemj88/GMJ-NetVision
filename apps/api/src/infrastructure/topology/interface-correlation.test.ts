import { describe, expect, it } from 'vitest';
import type { NetworkInterface } from '@gmj/shared';
import { mergeSnmpAndSshInterfaces, normalizeInterfaceName } from './interface-correlation';

function networkInterface(overrides: Partial<NetworkInterface>): NetworkInterface {
  return {
    id: 'snmp-1', deviceId: 'device-1', name: '100GE0/0/1', alias: '',
    description: '100GE0/0/1', ifIndex: 501, mac: '', mtu: 1500,
    speedBps: 100_000_000_000, adminStatus: 'UP', operStatus: 'UP',
    rxBps: 1, txBps: 2, rxUtilization: 0, txUtilization: 0,
    rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0,
    dataSources: ['SNMP'], ...overrides,
  };
}

describe('interface source correlation', () => {
  it('normalizes common Huawei long and abbreviated names', () => {
    expect(normalizeInterfaceName('XGigabitEthernet 0/0/1')).toBe(
      normalizeInterfaceName('XGE0/0/1'),
    );
  });

  it('fills an empty SNMP alias from SSH without losing IF-MIB fields', () => {
    const snmp = networkInterface({});
    const ssh = networkInterface({ id: 'ssh-1', ifIndex: 1, alias: 'BHE-LIKEE-6730-MPLS-01', dataSources: ['SSH'] });
    const [merged] = mergeSnmpAndSshInterfaces([snmp], [ssh]);

    expect(merged).toMatchObject({
      id: 'snmp-1', ifIndex: 501, name: '100GE0/0/1',
      description: '100GE0/0/1', alias: 'BHE-LIKEE-6730-MPLS-01',
      dataSources: ['SNMP', 'SSH'],
    });
  });

  it('preserves a valid ifAlias instead of overwriting it with SSH', () => {
    const snmp = networkInterface({ alias: 'SNMP CONFIGURED DESCRIPTION' });
    const ssh = networkInterface({ id: 'ssh-1', alias: 'SSH DESCRIPTION' });
    expect(mergeSnmpAndSshInterfaces([snmp], [ssh])[0]?.alias).toBe(
      'SNMP CONFIGURED DESCRIPTION',
    );
  });

  it('does not append unmatched SSH rows or duplicate a correlated port', () => {
    const snmp = networkInterface({});
    const ssh = networkInterface({ id: 'ssh-1', name: 'Eth-Trunk3', alias: 'ITOP TELECOM' });
    const merged = mergeSnmpAndSshInterfaces([snmp], [ssh]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('100GE0/0/1');
  });
});
