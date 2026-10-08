import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import type { AlertCenterQuery } from './alert-center-repository';
import { buildAlarmWhere, buildOccurrenceWhere } from './prisma-alert-center-repository';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function query(patch: Partial<AlertCenterQuery> = {}): AlertCenterQuery {
  return { now: NOW, state: 'ACTIVE', fromMs: null, take: 50, ...patch };
}

describe('buildAlarmWhere (SQL do read model)', () => {
  it('ATIVOS: somente alarmes sem endedAt', () => {
    expect(buildAlarmWhere(query({ state: 'ACTIVE' }))).toMatchObject({ endedAt: null });
  });

  it('NAO RECONHECIDOS e RECONHECIDOS separam por ACK', () => {
    expect(buildAlarmWhere(query({ state: 'UNACKNOWLEDGED' }))).toMatchObject({
      endedAt: null,
      acknowledgedAt: null,
    });
    expect(buildAlarmWhere(query({ state: 'ACKNOWLEDGED' }))).toMatchObject({
      endedAt: null,
      acknowledgedAt: { not: null },
    });
  });

  it('RESOLVIDOS exclui os motivos de supressao; SUPRIMIDOS usa exatamente eles', () => {
    const resolved = buildAlarmWhere(query({ state: 'RESOLVED' }));
    const suppressed = buildAlarmWhere(query({ state: 'SUPPRESSED' }));
    const resolvedConditions = JSON.stringify(resolved.AND);
    const suppressedConditions = JSON.stringify(suppressed.AND);

    expect(resolvedConditions).toContain('"endedAt":{"not":null}');
    expect(resolvedConditions).toContain('"NOT"');
    for (const reason of ['MANUAL_SUPPRESSION', 'INTENTIONAL_SHUTDOWN', 'MAINTENANCE', 'FALSE_POSITIVE']) {
      expect(suppressedConditions).toContain(reason);
    }
    expect(suppressedConditions).not.toContain('"NOT"');
  });

  /**
   * Regressao F9.4.1: `NOT` sobre o path JSON descartava silenciosamente os
   * alarmes resolvidos com `metadata` NULL (o caso de LINK DOWN) ou sem a
   * chave `resolutionReason`, porque a comparacao vira NULL no SQL.
   */
  it('RESOLVIDOS e nulo-seguro para metadata NULL e chave ausente', () => {
    const where = buildAlarmWhere(query({ state: 'RESOLVED' }));
    const conditions = (where.AND ?? []) as Prisma.AlarmWhereInput[];
    const nullSafe = conditions.find((entry) => Array.isArray(entry.OR));
    expect(nullSafe).toBeDefined();
    const branches = (nullSafe?.OR ?? []) as Prisma.AlarmWhereInput[];
    expect(branches).toHaveLength(3);
    expect(branches[0]).toEqual({ metadata: { equals: Prisma.DbNull } });
    expect(branches[1]).toEqual({
      metadata: { path: ['resolutionReason'], equals: Prisma.AnyNull },
    });
    expect(branches[2]).toMatchObject({ NOT: { OR: expect.any(Array) } });
    // A negacao crua (sem os ramos nulos) nao pode voltar a ser usada sozinha.
    expect(conditions.some((entry) => entry.NOT !== undefined && entry.OR === undefined)).toBe(
      false,
    );
  });

  it('periodo preserva alarme ativo e corta apenas o historico', () => {
    const where = buildAlarmWhere(query({ fromMs: NOW.getTime() - HOUR }));
    const conditions = JSON.stringify(where.AND);
    expect(conditions).toContain('"endedAt":null');
    expect(conditions).toContain(`"gte":"${new Date(NOW.getTime() - HOUR).toISOString()}"`);
  });

  it('sem periodo nenhum corte temporal entra na consulta', () => {
    expect(JSON.stringify(buildAlarmWhere(query()))).not.toContain('gte');
  });

  it('aplica tipo, severidade, device e interface', () => {
    const where = buildAlarmWhere(
      query({
        alarmTypes: ['INTERFACE_CRC'],
        severities: ['MAJOR', 'WARNING'],
        deviceId: 'dev-1',
        interfaceId: 'iface-1',
      }),
    );
    expect(where).toMatchObject({
      type: { in: ['INTERFACE_CRC'] },
      severity: { in: ['MAJOR', 'WARNING'] },
      deviceId: 'dev-1',
      interfaceId: 'iface-1',
    });
  });

  it('busca cobre equipamento, interface e tipo do dominio', () => {
    const where = buildAlarmWhere(query({ search: 'crc' }));
    const conditions = JSON.stringify(where.AND);
    expect(conditions).toContain('device');
    expect(conditions).toContain('interface');
    expect(conditions).toContain('INTERFACE_CRC');
    expect(conditions).toContain('"mode":"insensitive"');
  });

  /**
   * Regressao F9.4.1: a busca cita tipos das DUAS entidades e o filtro de enum
   * do Prisma so aceita os valores do proprio modelo — `CRC_FCS` no alarme (ou
   * `INTERFACE_CRC` na ocorrencia) derrubava a consulta com 500.
   */
  it('busca por tipo nunca mistura o enum da outra entidade', () => {
    const alarmWhere = JSON.stringify(buildAlarmWhere(query({ search: 'crc' })).AND);
    expect(alarmWhere).toContain('INTERFACE_CRC');
    expect(alarmWhere).not.toContain('CRC_FCS');

    const occurrenceWhere = JSON.stringify(
      buildOccurrenceWhere(query({ state: 'ALL', search: 'crc' })).AND,
    );
    expect(occurrenceWhere).toContain('CRC_FCS');
    expect(occurrenceWhere).not.toContain('INTERFACE_CRC');

    const downWhere = JSON.stringify(buildOccurrenceWhere(query({ state: 'ALL', search: 'down' })).AND);
    expect(downWhere).not.toContain('INTERFACE_DOWN');
    const discardWhere = JSON.stringify(
      buildAlarmWhere(query({ search: 'discard' })).AND,
    );
    expect(discardWhere).toContain('INTERFACE_DISCARDS');
    expect(discardWhere).not.toContain('"DISCARDS"');
  });
});

describe('buildOccurrenceWhere (SQL do read model)', () => {
  it('ATIVO/NAO RECONHECIDO exige episodio aberto e janela de 24h', () => {
    const where = buildOccurrenceWhere(query({ state: 'ACTIVE' }));
    expect(where).toMatchObject({
      closedAt: null,
      acknowledgedAt: null,
      lastSeenAt: { gte: new Date(NOW.getTime() - 24 * HOUR) },
    });
  });

  it('RECONHECIDO ignora a janela de 24h mas pode usar o periodo', () => {
    const withoutPeriod = buildOccurrenceWhere(query({ state: 'ACKNOWLEDGED' }));
    expect(withoutPeriod).toMatchObject({ acknowledgedAt: { not: null } });
    expect(withoutPeriod.lastSeenAt).toBeUndefined();

    const withPeriod = buildOccurrenceWhere(
      query({ state: 'ACKNOWLEDGED', fromMs: NOW.getTime() - 7 * 24 * HOUR }),
    );
    expect(withPeriod.lastSeenAt).toEqual({ gte: new Date(NOW.getTime() - 7 * 24 * HOUR) });
  });

  it('periodo mais curto que 24h prevalece no estado vigente', () => {
    const where = buildOccurrenceWhere(
      query({ state: 'UNACKNOWLEDGED', fromMs: NOW.getTime() - HOUR }),
    );
    expect(where.lastSeenAt).toEqual({ gte: new Date(NOW.getTime() - HOUR) });
  });

  it('RESOLVIDO/SUPRIMIDO nunca casa com ocorrencia', () => {
    for (const state of ['RESOLVED', 'SUPPRESSED'] as const) {
      const where = buildOccurrenceWhere(query({ state }));
      expect(JSON.stringify(where.AND)).toContain('"in":[]');
    }
  });

  it('aplica tipo, device, interface e busca', () => {
    const where = buildOccurrenceWhere(
      query({
        state: 'ALL',
        occurrenceTypes: ['CRC_FCS'],
        deviceId: 'dev-1',
        interfaceId: 'iface-1',
        search: 'acme',
      }),
    );
    expect(where).toMatchObject({
      type: { in: ['CRC_FCS'] },
      deviceId: 'dev-1',
      interfaceId: 'iface-1',
    });
    expect(JSON.stringify(where.AND)).toContain('acme');
  });
});
