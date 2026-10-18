import { describe, expect, it } from 'vitest';
import { SnmpClientImpl } from './snmp-client-impl';
import { loopbackSnmpAgent } from '../../testing/loopback-snmp-agent';
import { snmpUnsigned } from './fast-snmp-reader';

describe('real SNMP packets, synthetic loopback agent', () => {
  it('decodes a full unsigned Counter64 and ignores a duplicated response', async () => {
    const agent = await loopbackSnmpAgent({
      value: () => ({ type: 0x46, value: 18446744073709551615n }),
      duplicate: true,
    });
    try {
      const rows = await new SnmpClientImpl(100, 0).get(
        '127.0.0.1',
        ['1.3.6.1.2.1.31.1.1.1.10.200'],
        { community: 'synthetic-only', port: agent.port },
      );
      expect(snmpUnsigned(rows[0]!.value)).toBe(18446744073709551615n);
      expect(agent.requests()).toBe(1);
    } finally {
      await agent.close();
    }
  });
  it('one configured retry recovers a dropped first packet', async () => {
    const agent = await loopbackSnmpAgent({
      value: () => ({ type: 0x43, value: 10000n }),
      dropFirst: true,
    });
    try {
      const rows = await new SnmpClientImpl(50, 1).get('127.0.0.1', ['1.3.6.1.2.1.1.3.0'], {
        community: 'synthetic-only',
        port: agent.port,
      });
      expect(rows).toHaveLength(1);
      expect(agent.requests()).toBe(2);
    } finally {
      await agent.close();
    }
  });
  it('timeout produces an error and no zero or fabricated observation', async () => {
    const agent = await loopbackSnmpAgent({
      value: () => ({ type: 0x43, value: 10000n }),
      dropAll: true,
    });
    try {
      await expect(
        new SnmpClientImpl(30, 0).get('127.0.0.1', ['1.3.6.1.2.1.1.3.0'], {
          community: 'synthetic-only',
          port: agent.port,
        }),
      ).rejects.toThrow();
      expect(agent.requests()).toBe(1);
    } finally {
      await agent.close();
    }
  });
  it('late datagram cannot turn a completed timeout into success', async () => {
    const agent = await loopbackSnmpAgent({
      value: () => ({ type: 0x43, value: 10000n }),
      delayMs: 100,
    });
    try {
      await expect(
        new SnmpClientImpl(20, 0).get('127.0.0.1', ['1.3.6.1.2.1.1.3.0'], {
          community: 'synthetic-only',
          port: agent.port,
        }),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 130));
    } finally {
      await agent.close();
    }
  });
});
