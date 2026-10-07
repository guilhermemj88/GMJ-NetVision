import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { alarmSuppressionFingerprint, type AuthUser } from '@gmj/shared';
import { registerAlertCenterRoutes } from './alert-center-routes';
import { AlertCenterService } from './application/alert-center-service';
import { OperationalOccurrenceService } from './application/operational-occurrence-service';
import { DemoAlarmRepository } from './infrastructure/alarms/demo-alarm-repository';
import { DemoAlarmSuppressionRepository } from './infrastructure/alarms/demo-alarm-suppression-repository';
import {
  DemoAlertCenterRepository,
  type AlertCenterIdentityLookup,
} from './infrastructure/alarms/demo-alert-center-repository';
import { DemoOperationalOccurrenceRepository } from './infrastructure/alarms/demo-operational-occurrence-repository';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ADMIN: AuthUser = {
  id: 'u1',
  username: 'qa-preview',
  email: 'qa@preview.local',
  name: 'QA',
  role: 'ADMIN',
};

/** Catalogo de interfaces dos testes (nomes reais de NOC). */
const INTERFACES: Record<
  string,
  { name: string; ifIndex: number; alias: string; deviceName: string; deviceHostname: string }
> = {
  'iface-1': {
    name: '100GE0/0/2',
    ifIndex: 67502222,
    alias: 'CLIENTE-ACME',
    deviceName: 'RNS-FLOR-6730-MPLS-01',
    deviceHostname: 'rns-flor-6730-mpls-01',
  },
  'iface-2': {
    name: 'XGE0/0/15',
    ifIndex: 1015,
    alias: 'SBA-GEN-UPLINK',
    deviceName: 'SBA-GEN-6730-MPLS-01',
    deviceHostname: 'sba-gen-6730-mpls-01',
  },
};

const identity: AlertCenterIdentityLookup = (interfaceId) => {
  const entry = INTERFACES[interfaceId];
  if (!entry) return undefined;
  return {
    deviceName: entry.deviceName,
    deviceHostname: entry.deviceHostname,
    site: 'RNS',
    interfaceName: entry.name,
    interfaceAlias: entry.alias,
    interfaceDescription: entry.alias,
    ifIndex: entry.ifIndex,
  };
};

let alarms: DemoAlarmRepository;
let occurrences: DemoOperationalOccurrenceRepository;
let suppressions: DemoAlarmSuppressionRepository;

/** 4 alarmes: 2 ativos (1 reconhecido), 1 resolvido, 1 encerrado por supressao. */
async function seedAlarms() {
  const [downAlarm] = await alarms.openInterfaceDownAlarms([
    {
      deviceId: 'dev-1',
      interfaceId: 'iface-1',
      ifIndex: 67502222,
      startedAt: new Date(NOW - 3 * HOUR),
    },
  ]);
  await alarms.openMetricAlarm({
    deviceId: 'dev-2',
    interfaceId: 'iface-2',
    ifIndex: 1015,
    ruleId: 'rule-crc',
    type: 'INTERFACE_CRC',
    severity: 'MAJOR',
    metricKey: 'FCS',
    currentValue: 12,
    thresholdValue: 1,
    unit: 'CRC/min',
    metadata: { ratePerMinute: 12, thresholdPerMinute: 1, delta: '17' },
    message: 'CRC acima do limite',
    startedAt: new Date(NOW - 2 * HOUR),
  });
  await alarms.acknowledge(downAlarm!.id, 'qa-preview', new Date(NOW - HOUR));
  await alarms.openMetricAlarm({
    deviceId: 'dev-1',
    interfaceId: 'iface-1',
    ifIndex: 67502222,
    ruleId: 'rule-err',
    type: 'INTERFACE_ERRORS',
    severity: 'WARNING',
    metricKey: 'RX',
    currentValue: 2,
    thresholdValue: 1,
    unit: 'erros/min',
    metadata: { ratePerMinute: 2, thresholdPerMinute: 1, direction: 'RX' },
    message: 'Erros acima do limite',
    startedAt: new Date(NOW - 10 * HOUR),
  });
  await alarms.resolveMetricAlarm('iface-1', 'INTERFACE_ERRORS', 'RX', new Date(NOW - 5 * HOUR));
  await alarms.openMetricAlarm({
    deviceId: 'dev-1',
    interfaceId: 'iface-2',
    ifIndex: 1015,
    ruleId: 'rule-disc',
    type: 'INTERFACE_DISCARDS',
    severity: 'WARNING',
    metricKey: 'TX',
    currentValue: 4,
    thresholdValue: 1,
    unit: 'discard/min',
    metadata: { ratePerMinute: 4, thresholdPerMinute: 1, direction: 'TX' },
    message: 'Discards acima do limite',
    startedAt: new Date(NOW - 6 * HOUR),
  });
  await alarms.closeOpenAlarmsForFingerprint(
    { interfaceId: 'iface-2', type: 'INTERFACE_DISCARDS', ruleId: 'rule-disc', metricKey: 'TX' },
    new Date(NOW - 4 * HOUR),
    'MAINTENANCE',
  );
  await suppressions.create({
    fingerprint: alarmSuppressionFingerprint({
      interfaceId: 'iface-2',
      type: 'INTERFACE_DISCARDS',
      ruleId: 'rule-disc',
      metricKey: 'TX',
    }),
    deviceId: 'dev-1',
    interfaceId: 'iface-2',
    type: 'INTERFACE_DISCARDS',
    ruleId: 'rule-disc',
    metricKey: 'TX',
    mode: 'UNTIL_CLEAR',
    reason: 'MAINTENANCE',
    note: 'janela do cliente',
    suppressedAt: new Date(NOW - 4 * HOUR),
    suppressedBy: 'qa-preview',
  });
}

/** Uma ocorrencia vigente (reconhecida) e uma antiga de 30h (reconhecida). */
async function seedOccurrences() {
  const service = occurrenceService();
  await service.processSamples({
    deviceId: 'dev-3',
    samples: [
      {
        interfaceId: 'iface-1',
        timestampMs: NOW - HOUR,
        fcsErrorsDelta: 17n,
        inDiscardsDelta: 0n,
        outDiscardsDelta: 0n,
        previousSampleTimestampMs: NOW - 2 * HOUR,
      },
    ],
  });
  await service.processSamples({
    deviceId: 'dev-3',
    samples: [
      {
        interfaceId: 'iface-2',
        timestampMs: NOW - 30 * HOUR,
        fcsErrorsDelta: 5n,
        inDiscardsDelta: 0n,
        outDiscardsDelta: 0n,
        previousSampleTimestampMs: NOW - 31 * HOUR,
      },
    ],
  });
  const { items } = await service.list({ limit: 10 });
  const fresh = items.find((item) => item.interfaceId === 'iface-1')!;
  const stale = items.find((item) => item.interfaceId === 'iface-2')!;
  await service.acknowledge(fresh.id, ADMIN);
  return { fresh, stale, service };
}

function occurrenceService() {
  return new OperationalOccurrenceService(occurrences, { now: () => NOW });
}

async function buildApp(user: AuthUser | null = ADMIN): Promise<FastifyInstance> {
  const repository = new DemoAlertCenterRepository(alarms, occurrences, suppressions, identity);
  const service = new AlertCenterService(repository, { now: () => NOW });
  const app = Fastify();
  registerAlertCenterRoutes(app, { alertCenter: service, currentUser: async () => user });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

beforeEach(async () => {
  alarms = new DemoAlarmRepository();
  suppressions = new DemoAlarmSuppressionRepository();
  occurrences = new DemoOperationalOccurrenceRepository((interfaceId, deviceId) => ({
    deviceName: deviceId,
    interfaceName: INTERFACES[interfaceId]?.name ?? interfaceId,
    ifIndex: INTERFACES[interfaceId]?.ifIndex ?? 0,
  }));
  await seedAlarms();
});

describe('API da Central de Alertas (F9.3)', () => {
  it('exige sessao', async () => {
    const app = await buildApp(null);
    expect((await app.inject({ method: 'GET', url: '/api/alert-center' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/alert-center/summary' })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('default operacional: alarmes ativos, sem ocorrencias ja reconhecidas', async () => {
    const seeded = await seedOccurrences();
    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/api/alert-center' })).json();

    expect(body.state).toBe('ACTIVE');
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item: { category: string }) => item.category === 'ALARM')).toBe(true);
    expect(body.items.some((item: { id: string }) => item.id === seeded.fresh.id)).toBe(false);
    expect(body.items.some((item: { id: string }) => item.id === seeded.stale.id)).toBe(false);
    await app.close();
  });

  it('ocorrencia nao reconhecida entra no default e sai depois do ACK', async () => {
    const service = occurrenceService();
    await service.processSamples({
      deviceId: 'dev-3',
      samples: [
        {
          interfaceId: 'iface-1',
          timestampMs: NOW - HOUR,
          fcsErrorsDelta: 7n,
          inDiscardsDelta: 0n,
          outDiscardsDelta: 0n,
          previousSampleTimestampMs: NOW - 2 * HOUR,
        },
      ],
    });
    const app = await buildApp();
    const before = (await app.inject({ method: 'GET', url: '/api/alert-center' })).json();
    const occurrence = before.items.find(
      (item: { category: string }) => item.category === 'OCCURRENCE',
    );
    expect(occurrence).toMatchObject({
      state: 'UNACKNOWLEDGED',
      severity: null,
      typeLabel: 'CRC/FCS',
      interfaceName: '100GE0/0/2',
      deviceName: 'RNS-FLOR-6730-MPLS-01',
    });

    await service.acknowledge(occurrence.id, ADMIN);
    const after = (await app.inject({ method: 'GET', url: '/api/alert-center' })).json();
    expect(after.items.some((item: { category: string }) => item.category === 'OCCURRENCE')).toBe(
      false,
    );
    const history = (
      await app.inject({
        method: 'GET',
        url: '/api/alert-center?state=ACKNOWLEDGED&category=OCCURRENCE',
      })
    ).json();
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ state: 'ACKNOWLEDGED' });
    expect(history.items[0].occurrence).toMatchObject({ crcDeltaTotal: 7, mediaAvailable: false });
    await app.close();
  });

  it('lista alarmes ativos, reconhecidos, resolvidos e suprimidos', async () => {
    const app = await buildApp();
    const get = async (query: string) =>
      (await app.inject({ method: 'GET', url: `/api/alert-center?${query}` })).json();

    const active = await get('state=ACTIVE');
    expect(active.items).toHaveLength(2);

    const acked = await get('state=ACKNOWLEDGED');
    expect(acked.items).toHaveLength(1);
    expect(acked.items[0]).toMatchObject({ category: 'ALARM', state: 'ACTIVE_ACKNOWLEDGED' });

    const unacked = await get('state=UNACKNOWLEDGED');
    expect(unacked.items).toHaveLength(1);
    expect(unacked.items[0]).toMatchObject({ state: 'ACTIVE_UNACKNOWLEDGED' });

    const resolved = await get('state=RESOLVED');
    expect(resolved.items).toHaveLength(1);
    expect(resolved.items[0]).toMatchObject({ type: 'INTERFACE_ERRORS', state: 'RESOLVED' });

    const suppressed = await get('state=SUPPRESSED');
    expect(suppressed.items).toHaveLength(1);
    expect(suppressed.items[0]).toMatchObject({ type: 'INTERFACE_DISCARDS', state: 'SUPPRESSED' });
    expect(suppressed.items[0].alarm.suppression).toMatchObject({
      reason: 'MAINTENANCE',
      note: 'janela do cliente',
      suppressedBy: 'qa-preview',
    });
    expect(suppressed.items[0].alarm.resolutionReason).toBe('MAINTENANCE');

    expect((await get('state=ALL')).items).toHaveLength(4);
    await app.close();
  });

  it('expõe o detalhe do alarme com regra, metrica e direcao', async () => {
    const app = await buildApp();
    const body = (
      await app.inject({ method: 'GET', url: '/api/alert-center?state=ALL&type=INTERFACE_CRC' })
    ).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].alarm).toMatchObject({
      ruleId: 'rule-crc',
      metricKey: 'FCS',
      currentValue: 12,
      thresholdValue: 1,
      unit: 'CRC/min',
    });
    expect(body.items[0].valueSummary).toContain('12/min');

    const errors = (
      await app.inject({ method: 'GET', url: '/api/alert-center?state=ALL&type=INTERFACE_ERRORS' })
    ).json();
    expect(errors.items[0].alarm.direction).toBe('RX');
    await app.close();
  });

  it('filtra por categoria, tipo, severidade, device, interface e busca', async () => {
    const app = await buildApp();
    const query = async (search: string) =>
      (await app.inject({ method: 'GET', url: `/api/alert-center?state=ALL&${search}` })).json();

    expect((await query('category=ALARM')).items).toHaveLength(4);
    expect((await query('category=OCCURRENCE')).items).toHaveLength(0);
    expect((await query('type=INTERFACE_CRC')).items).toHaveLength(1);
    expect((await query('type=INTERFACE_DOWN&type=INTERFACE_CRC')).items).toHaveLength(2);
    expect((await query('severity=MAJOR')).items).toHaveLength(1);
    expect((await query('severity=MAJOR&severity=WARNING')).items).toHaveLength(3);
    expect((await query('deviceId=dev-1')).items).toHaveLength(3);
    expect((await query('interfaceId=iface-2')).items).toHaveLength(2);
    // Busca por equipamento, hostname, interface, alias e tipo.
    expect((await query('search=rns-flor-6730')).items).toHaveLength(2);
    expect((await query('search=100ge0/0/2')).items).toHaveLength(2);
    expect((await query('search=SBA-GEN-UPLINK')).items).toHaveLength(2);
    expect((await query('search=crc')).items).toHaveLength(1);
    expect((await query('search=link down')).items).toHaveLength(1);
    await app.close();
  });

  it('rejeita tipo inexistente com 400 (nenhum tipo inventado)', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/alert-center?type=BGP_DOWN' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('periodo nao esconde alarme ativo antigo', async () => {
    const app = await buildApp();
    const active = (await app.inject({ method: 'GET', url: '/api/alert-center?period=1h' })).json();
    // O alarme de CRC comeca ha 2h e continua ativo: o corte de 1h nao o esconde.
    expect(active.items).toHaveLength(2);

    const resolvedShort = (
      await app.inject({ method: 'GET', url: '/api/alert-center?state=RESOLVED&period=1h' })
    ).json();
    expect(resolvedShort.items).toHaveLength(0);
    const resolvedLong = (
      await app.inject({ method: 'GET', url: '/api/alert-center?state=RESOLVED&period=24h' })
    ).json();
    expect(resolvedLong.items).toHaveLength(1);
    await app.close();
  });

  it('ocorrencia antiga (>24h) so aparece em TODOS', async () => {
    const seeded = await seedOccurrences();
    const app = await buildApp();
    const all = (
      await app.inject({
        method: 'GET',
        url: '/api/alert-center?state=ALL&category=OCCURRENCE',
      })
    ).json();
    expect(all.items).toHaveLength(2);
    const old = all.items.find((item: { id: string }) => item.id === seeded.stale.id);
    // Episodio de 30h atras: nao reconhecido, mas FORA da janela de vigencia.
    expect(old).toMatchObject({ state: 'UNACKNOWLEDGED', category: 'OCCURRENCE' });
    expect(old.startedAt).toBe(new Date(NOW - 30 * HOUR).toISOString());
    expect(
      (await app.inject({ method: 'GET', url: '/api/alert-center' })).json().items,
    ).toHaveLength(2);
    await app.close();
  });

  it('pagina com limit/offset, total e hasMore', async () => {
    const app = await buildApp();
    const first = (
      await app.inject({ method: 'GET', url: '/api/alert-center?state=ALL&limit=2&offset=0' })
    ).json();
    expect(first).toMatchObject({ total: 4, limit: 2, offset: 0, hasMore: true });
    expect(first.items).toHaveLength(2);

    const second = (
      await app.inject({ method: 'GET', url: '/api/alert-center?state=ALL&limit=2&offset=2' })
    ).json();
    expect(second.items).toHaveLength(2);
    expect(second.hasMore).toBe(false);

    const ids = new Set([
      ...first.items.map((item: { id: string }) => item.id),
      ...second.items.map((item: { id: string }) => item.id),
    ]);
    expect(ids.size).toBe(4);
    await app.close();
  });

  it('ordena por atencao e mantem a ordem estavel entre leituras', async () => {
    const app = await buildApp();
    const url = '/api/alert-center?state=ACTIVE';
    const body = (await app.inject({ method: 'GET', url })).json();
    expect(body.items[0].state).toBe('ACTIVE_UNACKNOWLEDGED');
    expect(body.items.at(-1).state).toBe('ACTIVE_ACKNOWLEDGED');

    const again = (await app.inject({ method: 'GET', url })).json();
    expect(again.items.map((item: { id: string }) => item.id)).toEqual(
      body.items.map((item: { id: string }) => item.id),
    );
    await app.close();
  });

  it('resumo operacional separa alarmes e ocorrencias', async () => {
    await seedOccurrences();
    const app = await buildApp();
    const { summary } = (
      await app.inject({ method: 'GET', url: '/api/alert-center/summary' })
    ).json();
    expect(summary).toMatchObject({
      alarmsActive: 2,
      alarmsActiveCritical: 1,
      alarmsActiveMajor: 1,
      alarmsActiveWarning: 0,
      alarmsActiveAcknowledged: 1,
      alarmsActiveUnacknowledged: 1,
      occurrencesUnacknowledged: 0,
      occurrencesAcknowledged: 1,
      occurrencesQuiet24h: 0,
    });
    await app.close();
  });

  it('nao vaza campo sensivel nem BigInt cru', async () => {
    await seedOccurrences();
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/alert-center?state=ALL' });
    expect(response.statusCode).toBe(200);
    for (const forbidden of ['community', 'password', 'token', 'secret']) {
      expect(response.body.toLowerCase()).not.toContain(forbidden);
    }
    const occurrence = response
      .json()
      .items.find((item: { category: string }) => item.category === 'OCCURRENCE');
    expect(typeof occurrence.occurrence.crcDeltaTotal).toBe('number');
    await app.close();
  });
});
