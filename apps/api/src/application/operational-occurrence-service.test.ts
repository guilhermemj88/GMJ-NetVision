import { describe, expect, it } from 'vitest';
import { OPERATIONAL_OCCURRENCE_QUIET_MS, type AuthUser } from '@gmj/shared';
import { DemoOperationalOccurrenceRepository } from '../infrastructure/alarms/demo-operational-occurrence-repository';
import type { OperationalOccurrenceRepository } from '../infrastructure/alarms/operational-occurrence-repository';
import { OperationalOccurrenceService } from './operational-occurrence-service';

const T0 = Date.parse('2026-10-12T12:00:00.000Z');
const USER: AuthUser = {
  id: 'user-1',
  username: 'qa-preview',
  email: 'qa@preview.local',
  name: 'QA Preview',
  role: 'ADMIN',
};

const INTERFACES: Record<string, { name: string; ifIndex: number }> = {
  'if-1': { name: 'GE0/0/1', ifIndex: 1 },
  'if-2': { name: '100GE0/0/2', ifIndex: 67502222 },
  'if-3': { name: 'GE0/0/3', ifIndex: 3 },
};

function setup(nowMs: number = T0 + 600_000) {
  const repository = new DemoOperationalOccurrenceRepository((interfaceId, deviceId) => ({
    deviceName: deviceId,
    interfaceName: INTERFACES[interfaceId]?.name ?? interfaceId,
    ifIndex: INTERFACES[interfaceId]?.ifIndex ?? 0,
  }));
  let now = nowMs;
  const service = new OperationalOccurrenceService(repository, { now: () => now });
  return {
    repository,
    service,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function sample(patch: {
  interfaceId?: string;
  timestampMs: number;
  fcs?: bigint | null;
  rx?: bigint;
  tx?: bigint;
  previousSampleTimestampMs?: number | null;
}) {
  return {
    interfaceId: patch.interfaceId ?? 'if-1',
    timestampMs: patch.timestampMs,
    fcsErrorsDelta: patch.fcs === undefined ? 0n : patch.fcs,
    inDiscardsDelta: patch.rx ?? 0n,
    outDiscardsDelta: patch.tx ?? 0n,
    previousSampleTimestampMs: patch.previousSampleTimestampMs ?? null,
  };
}

describe('OperationalOccurrenceService — CRC/FCS', () => {
  it('nao cria nada quando o delta e zero', async () => {
    const { service, repository } = setup();
    expect(
      await service.processSamples({
        deviceId: 'dev-1',
        samples: [sample({ timestampMs: T0, fcs: 0n })],
      }),
    ).toBe(0);
    expect((await repository.list({ now: new Date(T0), quietMs: 1, limit: 10, offset: 0 })).total).toBe(
      0,
    );
  });

  it('nao cria ocorrencia quando o contador de FCS nao e coletado (null)', async () => {
    const { service } = setup();
    const applied = await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: null, rx: 0n })],
    });
    expect(applied).toBe(0);
    expect((await service.list()).total).toBe(0);
  });

  it('cria um episodio e acumula as amostras seguintes no MESMO id', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 300_000, fcs: 2n, previousSampleTimestampMs: T0 })],
    });

    const { items } = await service.list({ active: true });
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({
      type: 'CRC_FCS',
      occurrenceCount: 2,
      crcDeltaTotal: 3,
      firstSeenAt: new Date(T0).toISOString(),
      lastSeenAt: new Date(T0 + 300_000).toISOString(),
    });
  });

  it('replay da MESMA amostra nao soma de novo nem cria episodio', async () => {
    const { service } = setup();
    const replayed = [sample({ timestampMs: T0, fcs: 1n })];
    await service.processSamples({ deviceId: 'dev-1', samples: replayed });
    expect(await service.processSamples({ deviceId: 'dev-1', samples: replayed })).toBe(0);
    expect(await service.processSamples({ deviceId: 'dev-1', samples: replayed })).toBe(0);

    const { items } = await service.list();
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({ occurrenceCount: 1, crcDeltaTotal: 1 });
  });

  it('delta negativo (reset de contador) nao cria episodio', async () => {
    const { service } = setup();
    expect(
      await service.processSamples({
        deviceId: 'dev-1',
        samples: [sample({ timestampMs: T0, fcs: -9n })],
      }),
    ).toBe(0);
    expect((await service.list()).total).toBe(0);
  });
});

describe('OperationalOccurrenceService — DISCARDS', () => {
  it('RX e TX na mesma amostra sao UM episodio com totais separados', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 0n, rx: 2n, tx: 3n })],
    });

    const { items } = await service.list();
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({
      type: 'DISCARDS',
      occurrenceCount: 1,
      rxDiscardDeltaTotal: 2,
      txDiscardDeltaTotal: 3,
      crcDeltaTotal: 0,
      fingerprint: 'if-1|DISCARDS',
    });
  });

  it('TX depois de RX continua no mesmo episodio', async () => {
    const { service } = setup();
    await service.processSamples({ deviceId: 'dev-1', samples: [sample({ timestampMs: T0, rx: 1n })] });
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 60_000, tx: 4n, previousSampleTimestampMs: T0 })],
    });

    const { items } = await service.list({ type: 'DISCARDS' });
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({
      occurrenceCount: 2,
      rxDiscardDeltaTotal: 1,
      txDiscardDeltaTotal: 4,
    });
  });

  it('replay do mesmo timestamp de discard nao duplica', async () => {
    const { service } = setup();
    const replayed = [sample({ timestampMs: T0, rx: 5n })];
    await service.processSamples({ deviceId: 'dev-1', samples: replayed });
    await service.processSamples({ deviceId: 'dev-1', samples: replayed });
    const { items } = await service.list();
    expect(items[0]!).toMatchObject({ occurrenceCount: 1, rxDiscardDeltaTotal: 5 });
  });

  it('CRC e DISCARD da MESMA amostra viram dois episodios independentes', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 7n, rx: 1n, tx: 1n })],
    });

    const { items } = await service.list();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.type).sort()).toEqual(['CRC_FCS', 'DISCARDS']);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.find((item) => item.type === 'CRC_FCS')?.crcDeltaTotal).toBe(7);
    expect(items.find((item) => item.type === 'DISCARDS')?.rxDiscardDeltaTotal).toBe(1);
  });
});

describe('OperationalOccurrenceService — janela de 24h', () => {
  it('23h59 continua vigente e 24h01 sai do painel mantendo historico', async () => {
    const { service, setNow } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });

    setNow(T0 + OPERATIONAL_OCCURRENCE_QUIET_MS - 60_000);
    expect((await service.list({ active: true })).items).toHaveLength(1);

    setNow(T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 60_000);
    expect((await service.list({ active: true })).items).toHaveLength(0);
    expect((await service.list()).total).toBe(1);
  });

  it('housekeeping encerra como QUIET_24H no fim real do episodio', async () => {
    const { service, setNow } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });

    const nowMs = T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 6 * 60_000;
    setNow(nowMs);
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: nowMs, fcs: 0n })],
    });

    const { items } = await service.list();
    expect(items[0]!).toMatchObject({
      closeReason: 'QUIET_24H',
      closeReasonLabel: 'sem novas ocorrências por 24h',
      closedAt: new Date(T0 + OPERATIONAL_OCCURRENCE_QUIET_MS).toISOString(),
    });
  });

  it('novo delta depois de 24h cria episodio NOVO (id diferente) no mesmo fingerprint', async () => {
    const { service, setNow } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });
    const first = (await service.list()).items[0]!;

    const laterMs = T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 60_000;
    setNow(laterMs);
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: laterMs, fcs: 1n, previousSampleTimestampMs: T0 })],
    });

    const { items } = await service.list({ active: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).not.toBe(first.id);
    expect(items[0]!.fingerprint).toBe(first.fingerprint);
    expect(items[0]!).toMatchObject({ occurrenceCount: 1, crcDeltaTotal: 1 });

    const history = await service.list();
    expect(history.total).toBe(2);
    expect(history.items.find((item) => item.id === first.id)?.closeReason).toBe('QUIET_24H');
  });
});

describe('OperationalOccurrenceService — ACK', () => {
  it('registra o operador, encerra o episodio e mantem o historico', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 2n })],
    });
    const target = (await service.list({ active: true })).items[0]!;

    const response = await service.acknowledge(target.id, USER);
    expect(response.acknowledged).toBe(true);
    expect(response.occurrence).toMatchObject({
      acknowledgedBy: 'qa-preview',
      closeReason: 'ACKNOWLEDGED',
      closeReasonLabel: 'reconhecida pelo operador',
    });
    expect((await service.list({ active: true })).items).toHaveLength(0);
    expect((await service.list({ unacknowledged: true })).items).toHaveLength(0);
    expect((await service.list()).total).toBe(1);
  });

  it('ACK repetido e idempotente e preserva o primeiro operador', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 2n })],
    });
    const target = (await service.list({ active: true })).items[0]!;

    await service.acknowledge(target.id, USER);
    const second = await service.acknowledge(target.id, { ...USER, username: 'outro' });
    expect(second.acknowledged).toBe(false);
    expect(second.occurrence.acknowledgedBy).toBe('qa-preview');
  });

  it('novo delta depois do ACK cria episodio novo e replay nao recria', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });
    const target = (await service.list({ active: true })).items[0]!;
    await service.acknowledge(target.id, USER);

    // Novo evento depois do ACK: episodio NOVO, com id diferente.
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 660_000, fcs: 3n, previousSampleTimestampMs: T0 })],
    });
    const active = (await service.list({ active: true })).items;
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(target.id);
    expect(active[0]!.crcDeltaTotal).toBe(3);

    // Reprocessar a amostra que o operador ja tinha visto nao reabre nem cria.
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });
    expect((await service.list()).total).toBe(2);
  });

  it('ACK de ocorrencia inexistente falha com erro de dominio', async () => {
    const { service } = setup();
    await expect(service.acknowledge('nao-existe', USER)).rejects.toMatchObject({
      code: 'OCCURRENCE_NOT_FOUND',
    });
  });
});

describe('OperationalOccurrenceService — taxa', () => {
  it('1 evento em 60s = 1/min e 1 evento em 120s = 0.5/min', async () => {
    const first = setup();
    await first.service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 60_000, fcs: 1n, previousSampleTimestampMs: T0 })],
    });
    expect((await first.service.list()).items[0]!).toMatchObject({
      currentRatePerMin: 1,
      peakRatePerMin: 1,
    });

    const second = setup();
    await second.service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 120_000, fcs: 1n, previousSampleTimestampMs: T0 })],
    });
    expect((await second.service.list()).items[0]!.currentRatePerMin).toBe(0.5);
  });

  it('guarda o pico e recalcula a taxa atual sem NaN/Infinity', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 60_000, fcs: 10n, previousSampleTimestampMs: T0 })],
    });
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [
        sample({ timestampMs: T0 + 180_000, fcs: 1n, previousSampleTimestampMs: T0 + 60_000 }),
      ],
    });

    const item = (await service.list()).items[0]!;
    expect(item.currentRatePerMin).toBe(0.5);
    expect(item.peakRatePerMin).toBe(10);
    expect(Number.isFinite(item.currentRatePerMin)).toBe(true);
  });

  it('sem base de intervalo a taxa nao vira NaN', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 2n })],
    });
    const item = (await service.list()).items[0]!;
    expect(item.currentRatePerMin).toBe(0);
    expect(item.crcDeltaTotal).toBe(2);
  });

  it('amostras do mesmo lote usam a amostra anterior como base', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 0n }), sample({ timestampMs: T0 + 120_000, fcs: 2n })],
    });
    expect((await service.list()).items[0]!.currentRatePerMin).toBe(1);
  });
});

describe('OperationalOccurrenceService — amostras fora de ordem', () => {
  it('amostra atrasada soma o evento sem reduzir lastSeenAt nem substituir a taxa', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 4n, previousSampleTimestampMs: T0 - 60_000 })],
    });
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 300_000, fcs: 1n, previousSampleTimestampMs: T0 })],
    });

    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 60_000, fcs: 1n, previousSampleTimestampMs: T0 })],
    });

    const item = (await service.list()).items[0]!;
    expect(item).toMatchObject({
      occurrenceCount: 3,
      crcDeltaTotal: 6,
      currentRatePerMin: 0.2,
      peakRatePerMin: 4,
      lastSeenAt: new Date(T0 + 300_000).toISOString(),
      firstSeenAt: new Date(T0).toISOString(),
    });
  });

  it('amostra antiga de um episodio ja encerrado nao reabre nem cria card antigo', async () => {
    const { service, setNow } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });
    const original = (await service.list()).items[0]!;

    const laterMs = T0 + OPERATIONAL_OCCURRENCE_QUIET_MS + 120_000;
    setNow(laterMs + 10_000);
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: laterMs, fcs: 1n, previousSampleTimestampMs: T0 })],
    });

    // Amostra de um instante que o fluxo ja processou (poller reiniciado/atrasado).
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0 + 180_000, fcs: 5n })],
    });

    const history = await service.list();
    expect(history.total).toBe(2);
    expect(history.items.find((item) => item.id === original.id)).toMatchObject({
      occurrenceCount: 1,
      crcDeltaTotal: 1,
      lastSeenAt: original.lastSeenAt,
    });
  });
});

describe('OperationalOccurrenceService — resiliencia e compatibilidade', () => {
  it('falha do repositorio propaga para o chamador decidir (hook do poll e fail-safe)', async () => {
    const failing = {
      findLatestByFingerprint: () => Promise.reject(new Error('banco fora')),
    } as unknown as OperationalOccurrenceRepository;
    const service = new OperationalOccurrenceService(failing);
    await expect(
      service.processSamples({ deviceId: 'dev-1', samples: [sample({ timestampMs: T0, fcs: 1n })] }),
    ).rejects.toThrow('banco fora');
  });

  it('listInterfaceOccurrences mantem o contrato do painel de ocorrencias', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ interfaceId: 'if-2', timestampMs: T0, fcs: 3n, rx: 1n })],
    });

    const occurrences = await service.listInterfaceOccurrences(15, 12);
    expect(occurrences).toHaveLength(2);
    const crc = occurrences.find((item) => item.kind === 'CRC');
    expect(crc).toMatchObject({
      kind: 'CRC',
      interfaceId: 'if-2',
      interfaceName: '100GE0/0/2',
      ifIndex: 67502222,
      crcDelta: '3',
      ratePerMinute: 0,
      intervals: 1,
      windowMinutes: 15,
    });
    expect(crc?.lastOccurrenceAt).toBe(new Date(T0).toISOString());
    expect(occurrences.find((item) => item.kind === 'DISCARDS')).toMatchObject({
      rxDelta: '1',
      txDelta: '0',
    });
  });

  it('ocorrencia fora da janela pedida nao aparece no painel de ocorrencias', async () => {
    const { service, setNow } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [sample({ timestampMs: T0, fcs: 1n })],
    });
    setNow(T0 + 60 * 60_000);
    expect(await service.listInterfaceOccurrences(15, 12)).toHaveLength(0);
  });

  it('filtros de device/interface/tipo combinam com a janela de 24h', async () => {
    const { service } = setup();
    await service.processSamples({
      deviceId: 'dev-1',
      samples: [
        sample({ timestampMs: T0, fcs: 1n }),
        sample({ interfaceId: 'if-2', timestampMs: T0, rx: 1n }),
      ],
    });
    await service.processSamples({
      deviceId: 'dev-2',
      samples: [sample({ interfaceId: 'if-3', timestampMs: T0 + 60_000, fcs: 1n })],
    });

    expect((await service.list({ deviceId: 'dev-2' })).total).toBe(1);
    expect((await service.list({ interfaceId: 'if-2' })).total).toBe(1);
    expect((await service.list({ type: 'CRC_FCS' })).total).toBe(2);
    expect((await service.list({ from: new Date(T0 + 30_000) })).total).toBe(1);
    expect((await service.list({ to: new Date(T0 + 30_000) })).total).toBe(2);
    expect((await service.list({ limit: 1, offset: 0 })).hasMore).toBe(true);
    expect((await service.list({ limit: 1, offset: 2 })).hasMore).toBe(false);
  });
});
