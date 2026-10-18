import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fastResponseScenario, sleep } from '../../testing/fast-response-scenario';
import { loopbackSnmpAgent } from '../../testing/loopback-snmp-agent';
import { FAST_OIDS } from '../../infrastructure/snmp/fast-snmp-reader';

/** Opt-in: ~55 real seconds. UDP GETs on loopback, canonical command service, synthetic device. */
it.skipIf(process.env.FAST_REALTIME_TEST !== '1')(
  'real clock and real UDP: first abnormal observation to verified readback <=60s',
  async () => {
    const start = Date.now();
    const agent = await loopbackSnmpAgent({
      value: (oid) => {
        const root = oid.slice(0, oid.lastIndexOf('.'));
        if (oid === FAST_OIDS.uptime)
          return { type: 0x43, value: BigInt(100000 + Math.floor((Date.now() - start) / 10)) };
        if (root === FAST_OIDS.name) return { type: 4, value: 'Eth-Trunk1.1' };
        if (root === FAST_OIDS.out)
          return {
            type: 0x46,
            value: 1_000_000_000_000n + BigInt(Date.now() - start) * 19_500_000n,
          };
        if (root === FAST_OIDS.in) return { type: 0x46, value: 1_000_000_000_000n };
        if (root === FAST_OIDS.highSpeed) return { type: 0x42, value: 300000n };
        if (root === FAST_OIDS.oper || root === FAST_OIDS.admin) return { type: 2, value: 1n };
        return { type: 0x43, value: 0n };
      },
    });
    const h = await fastResponseScenario({
      startAt: start,
      attackAt: start,
      wirePort: agent.port,
      externalBridge: true,
    });
    try {
      h.start();
      while (Date.now() - start < 75000 && !h.decisions.some((d) => d.outcome === 'ACTIVATED'))
        await sleep(100);
      const d = h.decisions.find((d) => d.outcome === 'ACTIVATED');
      expect(d).toBeDefined();
      expect(d!.totalResponseMs).toBeLessThanOrEqual(60000);
      expect(d!.timingsMs!.preflight).toBeGreaterThanOrEqual(2900);
      const report = {
        syntheticDevice: true,
        realClock: true,
        transport: 'real SNMPv2c UDP on 127.0.0.1, GET-only fixture',
        realHuawei: false,
        externalBridge: true,
        wallMs: Date.now() - start,
        requests: agent.requests(),
        collectionMs: h.observations.map(
          (o) => o.collectedAt.getTime() - o.requestStartedAt.getTime(),
        ),
        intervalMs: h.observations.map((o) => o.intervalMs).filter((x) => x !== null),
        firstAbnormalAt: d!.firstAbnormalAt,
        confirmationMs: d!.confirmationMs,
        commandMs: d!.commandMs,
        timingsMs: d!.timingsMs,
        totalResponseMs: d!.totalResponseMs,
        responseDeadlineExceeded: d!.responseDeadlineExceeded,
      };
      const dir = resolve(process.cwd(), '../../.artifacts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'fast-real-clock.json'), JSON.stringify(report, null, 2));
    } finally {
      await h.stop();
      await agent.close();
    }
  },
  80000,
);
