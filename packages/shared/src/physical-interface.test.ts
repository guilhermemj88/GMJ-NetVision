import { describe, expect, it } from 'vitest';
import {
  breakoutCageName,
  breakoutLane,
  classifyPhysicalInterface,
  isPhysicalConnectorCandidate,
  physicalConnectorKey,
} from './physical-interface';

/**
 * Classification rules from the DCIM prompt: breakout policy plus the MikroTik
 * and Juniper naming conventions. The physical layer must never fabricate a
 * connector for a logical interface.
 */

describe('classifyPhysicalInterface', () => {
  it('treats sub-interfaces and breakout lanes as logical', () => {
    for (const name of [
      '100GE1/0/1.100',
      'Virtual-Ethernet0/1/101.500',
      'ge-0/0/0.0',
      'xe-0/0/1.100',
      'irb.100',
      'lo0.0',
    ]) {
      expect(classification(name)).toBe('LOGICAL');
      expect(physicalConnectorKey(name)).toBeNull();
    }
    expect(classifyPhysicalInterface('et-0/0/0:0').reason).toContain('breakout');
    expect(classification('et-0/0/0:0')).toBe('LOGICAL');
    expect(classification('100GE1/0/1:1')).toBe('LOGICAL');
  });

  it('classifies the MikroTik conventions', () => {
    expect(classification('ether1')).toBe('PHYSICAL');
    expect(classification('sfp-sfpplus1')).toBe('PHYSICAL');
    expect(classification('sfp28-1')).toBe('PHYSICAL');
    expect(classification('qsfp28-1')).toBe('PHYSICAL');
    for (const name of ['vlan100', 'bridge1', 'bonding1', 'eoip-tunnel1', 'pppoe-out1', 'wireguard1', 'vrrp1']) {
      expect(classification(name)).toBe('LOGICAL');
    }
  });

  it('classifies the Juniper conventions', () => {
    expect(classification('ge-0/0/0')).toBe('PHYSICAL');
    expect(classification('xe-0/0/1')).toBe('PHYSICAL');
    expect(classification('et-0/0/0')).toBe('PHYSICAL');
    for (const name of ['ae0', 'irb', 'lo0', 'reth0']) {
      expect(classification(name)).toBe('LOGICAL');
    }
  });

  it('classifies Huawei, Cisco and Linux spellings used in the field', () => {
    expect(classification('Vlanif230')).toBe('LOGICAL');
    expect(classification('LoopBack0')).toBe('LOGICAL');
    expect(classification('Eth-Trunk1')).toBe('LOGICAL');
    expect(classification('Port-Channel12')).toBe('LOGICAL');
    expect(classification('100GE1/0/1')).toBe('PHYSICAL');
    expect(classification('GigabitEthernet0/0/1')).toBe('PHYSICAL');
    expect(classification('Gi1/0/1')).toBe('PHYSICAL');
    expect(classification('TenGigabitEthernet1/1')).toBe('PHYSICAL');
    expect(classification('XGigabitEthernet0/0/1')).toBe('PHYSICAL');
    expect(classification('25GE1/0/1')).toBe('PHYSICAL');
    expect(classification('400GE1/0/1')).toBe('PHYSICAL');
    expect(classification('swp1')).toBe('PHYSICAL');
    expect(classification('ens192')).toBe('PHYSICAL');
    expect(classification('eno1')).toBe('PHYSICAL');
  });

  it('never guesses for unknown names', () => {
    const unknown = classifyPhysicalInterface('core-engine-zone');
    expect(unknown.classification).toBe('UNKNOWN');
    expect(unknown.connectorKey).toBeNull();
    expect(unknown.reason).toContain('não reconhecido');
    expect(classifyPhysicalInterface('   ').classification).toBe('UNKNOWN');
    expect(isPhysicalConnectorCandidate('core-engine-zone')).toBe(false);
  });

  it('correlates vendor spellings into one connector key', () => {
    // template port ↔ real interface spellings of the same chassis connector
    expect(physicalConnectorKey('Ethernet 1')).toBe(physicalConnectorKey('ether1'));
    expect(physicalConnectorKey('Ethernet 1')).toBe(physicalConnectorKey('Ethernet1'));
    expect(physicalConnectorKey('SFP+ 1')).toBe(physicalConnectorKey('sfp-sfpplus1'));
    expect(physicalConnectorKey('Ethernet 1/1')).toBe('eth:1/1');
    expect(physicalConnectorKey('Gi1/0/1')).toBe(physicalConnectorKey('GigabitEthernet1/0/1'));
    expect(physicalConnectorKey('100GE1/0/1')).toBe('100ge:1/0/1');
    expect(physicalConnectorKey('ge-0/0/0')).toBe('ge:0/0/0');
    expect(physicalConnectorKey('xe-0/0/1')).toBe('xe:0/0/1');
    expect(physicalConnectorKey('et-0/0/0')).toBe('et:0/0/0');
    expect(physicalConnectorKey('sfp28-1')).toBe('sfp28:1');
    expect(physicalConnectorKey('qsfp28-1')).toBe('qsfp28:1');
  });

  it('keeps 1G SFP, SFP+ and label patterns apart', () => {
    expect(physicalConnectorKey('sfp1')).toBe('sfp:1');
    expect(physicalConnectorKey('sfp-sfpplus1')).toBe('sfpplus:1');
    expect(physicalConnectorKey('SFP-SFPPLUS-2')).toBe('sfpplus:2');
    expect(physicalConnectorKey('qsfpplus1')).toBe('qsfpplus:1');
    expect(physicalConnectorKey('QSFP-DD-1')).toBe('qsfpdd:1');
    expect(physicalConnectorKey('QSFP-DD-400-2')).toBe('qsfpdd:2');
    expect(physicalConnectorKey('combo1')).toBe('combo:1');
    expect(physicalConnectorKey('PON-3')).toBe('pon:3');
    expect(physicalConnectorKey('GE-RJ45-2')).toBe('geRj45:2');
    expect(physicalConnectorKey('GE-SFP-4')).toBe('geSfp:4');
    expect(physicalConnectorKey('10GE-5')).toBe('xe:5');
    expect(physicalConnectorKey('10GbE-6')).toBe('xe:6');
    expect(physicalConnectorKey('25GE-7')).toBe('25ge:7');
    expect(physicalConnectorKey('XE-2/0/3')).toBe('xe:2/0/3');
  });

  it('exposes the cage name and lane of a breakout channel', () => {
    expect(breakoutLane('qsfp28-1-3')).toEqual({ cageKey: 'qsfp28:1', lane: 3 });
    expect(breakoutCageName('qsfp28-1-3')).toBe('qsfp28-1');
    expect(breakoutCageName('et-0/0/0:2')).toBe('et-0/0/0');
    expect(breakoutCageName('100GE1/0/1:1')).toBe('100GE1/0/1');
    expect(breakoutCageName('ether1')).toBeNull();
    expect(breakoutCageName('ge-0/0/0.100')).toBeNull();
  });
});

function classification(name: string) {
  return classifyPhysicalInterface(name).classification;
}
