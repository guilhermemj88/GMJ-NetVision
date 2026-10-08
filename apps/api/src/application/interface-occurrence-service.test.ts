import { describe, expect, it, vi } from 'vitest';
import type {
  HostRepository,
  InterfaceOccurrenceRow,
} from '../infrastructure/persistence/host-repository';
import {
  collectInterfaceOccurrences,
  summarizeInterfaceOccurrences,
} from './interface-occurrence-service';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

function row(overrides: Partial<InterfaceOccurrenceRow> = {}): InterfaceOccurrenceRow {
  return {
    interfaceId: 'if-1',
    deviceId: 'dev-1',
    deviceName: 'BHE-VTA-S6750-MPLS-01',
    interfaceName: '100GE1/0/1',
    interfaceDescription: 'uplink core',
    interfaceAlias: 'TO-CORE-01',
    ifIndex: 12,
    timestamp: at(5),
    fcsErrorsDelta: null,
    inDiscardsDelta: 0n,
    outDiscardsDelta: 0n,
    ...overrides,
  };
}

describe('read model de ocorrencias recentes', () => {
  it('agrega CRC por interface e ignora intervalos sem ocorrencia', () => {
    const occurrences = summarizeInterfaceOccurrences(
      [
        row({ timestamp: at(10), fcsErrorsDelta: 3n }),
        row({ timestamp: at(5), fcsErrorsDelta: 1n }),
        row({ timestamp: at(0), fcsErrorsDelta: 0n }),
      ],
      { windowMinutes: 15 },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      kind: 'CRC',
      deviceId: 'dev-1',
      deviceName: 'BHE-VTA-S6750-MPLS-01',
      interfaceId: 'if-1',
      interfaceName: '100GE1/0/1',
      interfaceLabel: 'TO-CORE-01',
      ifIndex: 12,
      crcDelta: '4',
      rxDelta: '0',
      txDelta: '0',
      intervals: 2,
      windowMinutes: 15,
      lastOccurrenceAt: at(5).toISOString(),
    });
    // 4 CRC em 15 min = 0.27/min.
    expect(occurrences[0]?.ratePerMinute).toBe(0.27);
  });

  it('nao cria ocorrencia de CRC quando a metrica e nao suportada (delta null)', () => {
    expect(
      summarizeInterfaceOccurrences([row({ fcsErrorsDelta: null })], { windowMinutes: 15 }),
    ).toEqual([]);
  });

  it('separa discards RX/TX da mesma interface e usa o pior lado na taxa', () => {
    const occurrences = summarizeInterfaceOccurrences(
      [
        row({ timestamp: at(6), inDiscardsDelta: 20n, outDiscardsDelta: 2n }),
        row({ timestamp: at(1), inDiscardsDelta: 3n, outDiscardsDelta: 0n }),
      ],
      { windowMinutes: 10 },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      kind: 'DISCARDS',
      crcDelta: '0',
      rxDelta: '23',
      txDelta: '2',
      intervals: 2,
      lastOccurrenceAt: at(1).toISOString(),
    });
    // 23 discards RX em 10 min = 2.3/min.
    expect(occurrences[0]?.ratePerMinute).toBe(2.3);
  });

  it('devolve CRC e discards da mesma interface como itens independentes, mais recentes primeiro', () => {
    const occurrences = summarizeInterfaceOccurrences(
      [
        row({ timestamp: at(9), fcsErrorsDelta: 4n }),
        row({ timestamp: at(2), inDiscardsDelta: 7n }),
        row({ interfaceId: 'if-2', timestamp: at(4), fcsErrorsDelta: 1n }),
      ],
      { windowMinutes: 15, limit: 3 },
    );

    expect(occurrences.map((item) => item.kind)).toEqual(['DISCARDS', 'CRC', 'CRC']);
    expect(occurrences[0]?.interfaceId).toBe('if-1');
    expect(occurrences[1]?.interfaceId).toBe('if-2');
    expect(occurrences[2]?.interfaceId).toBe('if-1');
  });

  it('descarta amostra fora da janela (defesa extra alem do filtro do banco)', () => {
    const occurrences = summarizeInterfaceOccurrences(
      [
        row({ timestamp: at(40), fcsErrorsDelta: 9n }),
        row({ timestamp: at(3), fcsErrorsDelta: 2n }),
      ],
      { windowMinutes: 15, sinceMs: NOW.getTime() - 15 * 60_000 },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.crcDelta).toBe('2');
    expect(occurrences[0]?.lastOccurrenceAt).toBe(at(3).toISOString());
  });

  it('respeita o limite do painel', () => {
    const rows = [1, 2, 3, 4].map((index) =>
      row({ interfaceId: `if-${index}`, timestamp: at(index), inDiscardsDelta: 1n }),
    );
    expect(summarizeInterfaceOccurrences(rows, { windowMinutes: 15, limit: 2 })).toHaveLength(2);
  });

  it('consulta a janela persistida e devolve vazio quando nao ha intervalo com ocorrencia', async () => {
    const getRecentInterfaceOccurrenceRows = vi.fn().mockResolvedValue([]);
    const repository = { getRecentInterfaceOccurrenceRows } as unknown as HostRepository;

    const occurrences = await collectInterfaceOccurrences(repository, {
      windowMinutes: 15,
      now: () => NOW.getTime(),
    });

    expect(occurrences).toEqual([]);
    expect(getRecentInterfaceOccurrenceRows).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 15 * 60_000),
    );
  });
});
