import { describe, expect, it } from 'vitest';
import {
  estimateLabelWidth,
  resolveLinkV2LabelPlacements,
  type LinkV2LabelCandidate,
  type LinkV2NodeRect,
} from './map-visual-v2-labels';

function candidate(overrides: Partial<LinkV2LabelCandidate> & { id: string }): LinkV2LabelCandidate {
  return {
    anchor: { x: 200, y: 200 },
    normal: { x: 0, y: 1 },
    laneOffset: 0,
    priority: 0,
    text: '25G · 62%',
    compactText: '62%',
    ...overrides,
  };
}

describe('anticolisão de rótulos V2', () => {
  it('coloca no deslocamento base quando há espaço', () => {
    const placements = resolveLinkV2LabelPlacements([candidate({ id: 'a' })], []);
    expect(placements.get('a')).toEqual({ mode: 'full', dx: 0, dy: 0 });
  });

  it('sai de cima do nó quando a âncora cai dentro da caixa', () => {
    const node: LinkV2NodeRect = { x: 170, y: 170, width: 60, height: 60 };
    const placements = resolveLinkV2LabelPlacements([candidate({ id: 'a' })], [node]);
    const placement = placements.get('a');
    expect(placement?.mode).toBe('full');
    expect(placement?.dy).not.toBe(0);
    // O rótulo desloca para fora da caixa do nó, não para dentro dele.
    expect(placement?.dy).toBeGreaterThan(0);
  });

  it('dois rótulos no mesmo ponto não se sobrepõem', () => {
    const placements = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a' }), candidate({ id: 'b' })],
      [],
    );
    const first = placements.get('a');
    const second = placements.get('b');
    expect(first?.mode).toBe('full');
    expect(second?.mode).toBe('full');
    expect(second?.dy).not.toBe(first?.dy);
  });

  it('rótulo secundário bloqueado é ocultado; prioridade nunca é ocultada', () => {
    const wall: LinkV2NodeRect[] = [
      { x: -300, y: 130, width: 1000, height: 140 },
    ];
    const placements = resolveLinkV2LabelPlacements(
      [
        candidate({ id: 'secundario', priority: 0 }),
        candidate({ id: 'selecionado', priority: 3 }),
        candidate({ id: 'down', priority: 2 }),
      ],
      wall,
    );
    expect(placements.get('secundario')?.mode).toBe('hidden');
    expect(placements.get('selecionado')?.mode).toBe('compact');
    expect(placements.get('down')?.mode).toBe('compact');
  });

  it('irmãos paralelos mantêm deslocamentos distintos e determinísticos', () => {
    const candidates = [-36, -12, 12, 36].map((laneOffset, index) =>
      candidate({ id: `link-${index}`, laneOffset }),
    );
    const placements = resolveLinkV2LabelPlacements(candidates, []);
    const dys = candidates.map((entry) => placements.get(entry.id)?.dy ?? 0);
    expect(new Set(dys).size).toBe(4);
    expect(dys).toEqual([-36, -12, 12, 36]);

    // Determinismo: a ordem de entrada não muda o resultado.
    const shuffled = resolveLinkV2LabelPlacements([...candidates].reverse(), []);
    for (const entry of candidates) {
      expect(shuffled.get(entry.id)).toEqual(placements.get(entry.id));
    }
  });

  it('estima largura crescente com o texto', () => {
    expect(estimateLabelWidth('62%')).toBeLessThan(estimateLabelWidth('25G · 62% · parcial'));
  });

  it('com zoom reduzido (scale > 1) afasta mais o rótulo do nó', () => {
    const node: LinkV2NodeRect = { x: 170, y: 170, width: 60, height: 60 };
    const base = resolveLinkV2LabelPlacements([candidate({ id: 'a', laneOffset: 14 })], [node]);
    const scaled = resolveLinkV2LabelPlacements([candidate({ id: 'a', laneOffset: 14 })], [node], {
      scale: 2,
    });
    expect(base.get('a')?.mode).toBe('full');
    expect(scaled.get('a')?.mode).toBe('full');
    expect(Math.abs(scaled.get('a')?.dy ?? 0)).toBeGreaterThan(Math.abs(base.get('a')?.dy ?? 0));
  });

  it('Fase G: declara o tamanho real da plaqueta e evita compactar antes da hora', () => {
    // Caixa de nó logo abaixo do rótulo: com a geometria ANTIGA (fonte 11 e
    // altura 20) a plaqueta encosta nela e degrada; declarando a plaqueta real
    // (fonte 10, altura 17) o valor completo cabe e continua "full".
    const node: LinkV2NodeRect = { x: 150, y: 215, width: 100, height: 20 };
    const legacy = resolveLinkV2LabelPlacements([candidate({ id: 'a' })], [node], {
      fontSize: 11,
      height: 20,
      extraOffsets: [],
    });
    const pill = resolveLinkV2LabelPlacements([candidate({ id: 'a' })], [node], {
      fontSize: 10,
      height: 17,
      extraOffsets: [],
    });
    expect(legacy.get('a')?.mode).not.toBe('full');
    expect(pill.get('a')).toEqual({ mode: 'full', dx: 0, dy: 0 });
  });

  it('Fase G: a escadinha maior acha posição externa antes de compactar', () => {
    // Blocos perto da linha (faixa ±70) deixam livre apenas a pista distante:
    // a escadinha curta desiste, a escadinha da plaqueta acha o lugar.
    const wall: LinkV2NodeRect[] = [
      { x: 150, y: 140, width: 100, height: 40 },
      { x: 150, y: 190, width: 100, height: 20 },
      { x: 150, y: 220, width: 100, height: 40 },
    ];
    const narrow = resolveLinkV2LabelPlacements([candidate({ id: 'a', normal: { x: 0, y: -1 } })], wall, {
      extraOffsets: [18, -18, 36, -36, 56, -56],
    });
    const wide = resolveLinkV2LabelPlacements([candidate({ id: 'a', normal: { x: 0, y: -1 } })], wall, {
      extraOffsets: [18, -18, 36, -36, 56, -56, 84, -84],
    });
    expect(narrow.get('a')?.mode).not.toBe('full');
    expect(wide.get('a')?.mode).toBe('full');
    expect(Math.abs(wide.get('a')?.dy ?? 0)).toBeGreaterThanOrEqual(84);
  });
});
