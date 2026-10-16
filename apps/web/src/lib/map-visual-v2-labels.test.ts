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

/** Tamanhos reais da plaqueta da Fase L (mesmos números do canvas). */
const PILL_SIZES = {
  fontSize: 9,
  height: 15,
  fontSizeSmall: 8,
  heightSmall: 13,
  fontSizeCompact: 8,
  heightCompact: 13,
};

describe('anticolisão de rótulos V2', () => {
  it('coloca no deslocamento base quando há espaço', () => {
    const placements = resolveLinkV2LabelPlacements([candidate({ id: 'a' })], []);
    expect(placements.get('a')).toEqual({ mode: 'full', dx: 0, dy: 0 });
  });

  it('não foge da linha quando a âncora cai dentro da caixa do nó', () => {
    const node: LinkV2NodeRect = { x: 170, y: 170, width: 60, height: 60 };
    const placements = resolveLinkV2LabelPlacements([candidate({ id: 'a' })], [node]);
    // Fase L: o rótulo saudável sob o nó é ocultado — ele NÃO é empurrado para
    // longe do traço (era o comportamento antigo, que soltava a plaqueta).
    expect(placements.get('a')?.mode).toBe('hidden');
  });

  it('prioridade sob o nó fica compacta e continua colada no traço', () => {
    const node: LinkV2NodeRect = { x: 170, y: 170, width: 60, height: 60 };
    const placements = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', priority: 2 })],
      [node],
      PILL_SIZES,
    );
    const placement = placements.get('a');
    // Nunca é ocultada, e quando sai do eixo é só o deslocamento mínimo da Fase L.
    expect(placement?.mode).toBe('compact');
    expect(Math.abs(placement?.dy ?? 0)).toBeLessThanOrEqual(17);
  });

  it('dois rótulos no mesmo ponto não se sobrepõem', () => {
    const placements = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a' }), candidate({ id: 'b' })],
      [],
      PILL_SIZES,
    );
    const first = placements.get('a');
    const second = placements.get('b');
    expect(first).toEqual({ mode: 'full', dx: 0, dy: 0 });
    expect(second?.mode).toBe('compact');
    expect(second?.dy).not.toBe(first?.dy);
    expect(Math.abs(second?.dy ?? 0)).toBeLessThanOrEqual(17);
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

  it('com zoom reduzido (scale > 1) o deslocamento mínimo respeita a proporção', () => {
    const node: LinkV2NodeRect = { x: 170, y: 170, width: 60, height: 60 };
    const base = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', laneOffset: 14, priority: 2 })],
      [node],
      PILL_SIZES,
    );
    const scaled = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', laneOffset: 14, priority: 2 })],
      [node],
      { ...PILL_SIZES, scale: 2 },
    );
    expect(base.get('a')?.mode).toBe('compact');
    expect(scaled.get('a')?.mode).toBe('compact');
    // Mesmo com zoom reduzido a plaqueta não se solta do enlace.
    expect(Math.abs(base.get('a')?.dy ?? 0)).toBeLessThanOrEqual(17);
    expect(Math.abs(scaled.get('a')?.dy ?? 0)).toBeLessThanOrEqual(17 * 2);
  });

  it('Fase L: prefere deslizar AO LONGO do traço a sair da linha', () => {
    // Obstáculo pequeno bem no meio da plaqueta: sem deslizamento, a única saída
    // seria sair da linha (o que a Fase L evita).
    const obstacle: LinkV2NodeRect = { x: 190, y: 192, width: 20, height: 16 };
    const legacy = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', normal: { x: 0, y: 1 }, priority: 2 })],
      [obstacle],
      PILL_SIZES,
    );
    const sliding = resolveLinkV2LabelPlacements(
      [
        candidate({
          id: 'a',
          normal: { x: 0, y: 1 },
          priority: 2,
          tangent: { x: 1, y: 0 },
          tangentBudget: 60,
        }),
      ],
      [obstacle],
      PILL_SIZES,
    );

    // Sem tangente a plaqueta degrada o formato e continua colada na linha.
    expect(legacy.get('a')?.mode).toBe('compact');
    expect(Math.abs(legacy.get('a')?.dy ?? 0)).toBeLessThanOrEqual(17);

    // Com tangente ela continua EM CIMA da linha (dy = 0) e apenas desliza.
    expect(sliding.get('a')?.mode).toBe('full');
    expect(sliding.get('a')?.dy).toBe(0);
    expect(Math.abs(sliding.get('a')?.dx ?? 0)).toBeGreaterThan(0);
    // E o deslizamento respeita o orçamento informado.
    expect(Math.abs(sliding.get('a')?.dx ?? 0)).toBeLessThanOrEqual(60);
  });

  it('Fase J: sem tangente informada o comportamento antigo é preservado', () => {
    const obstacle: LinkV2NodeRect = { x: 190, y: 192, width: 20, height: 16 };
    const withBudgetOnly = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', normal: { x: 0, y: 1 }, tangentBudget: 60 })],
      [obstacle],
      { extraOffsets: [18, -18] },
    );
    const without = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', normal: { x: 0, y: 1 } })],
      [obstacle],
      { extraOffsets: [18, -18] },
    );
    expect(withBudgetOnly.get('a')).toEqual(without.get('a'));
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

  it('Fase L: a hierarquia degrada o TAMANHO antes de sair da linha', () => {
    // Blocos perto da linha deixam a faixa externa livre — a Fase L ignora essa
    // saída: prefere o formato menor SOBRE o traço.
    const wall: LinkV2NodeRect[] = [
      { x: 150, y: 140, width: 100, height: 40 },
      { x: 150, y: 190, width: 100, height: 20 },
      { x: 150, y: 220, width: 100, height: 40 },
    ];
    const placements = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', normal: { x: 0, y: -1 }, priority: 2 })],
      wall,
      PILL_SIZES,
    );
    const placement = placements.get('a');
    expect(placement?.mode).not.toBe('hidden');
    // No máximo o deslocamento mínimo (uma altura de plaqueta na tela).
    expect(Math.abs(placement?.dy ?? 0)).toBeLessThanOrEqual(17);
  });

  it('Fase L: nenhuma plaqueta fica longe do enlace em cenário denso', () => {
    const wall: LinkV2NodeRect[] = [
      { x: 100, y: 196, width: 240, height: 12 },
      { x: 100, y: 214, width: 240, height: 12 },
    ];
    const candidates = [0, 1, 2, 3].map((index) =>
      candidate({ id: `c${index}`, priority: 1, anchor: { x: 180 + index * 30, y: 200 } }),
    );
    const placements = resolveLinkV2LabelPlacements(candidates, wall, PILL_SIZES);
    for (const placement of placements.values()) {
      if (placement.mode === 'hidden') continue;
      // normal = (0,1): dy é exatamente o deslocamento perpendicular.
      expect(Math.abs(placement.dy)).toBeLessThanOrEqual(17);
    }
  });

  it('Fase L: o formato menor é o degrau intermediário e mantém o valor na linha', () => {
    // Diferença de largura entre `full` e `small` (mesmo texto, fonte menor).
    expect(estimateLabelWidth('25G · 62%', 8)).toBeLessThan(
      estimateLabelWidth('25G · 62%', 9),
    );
    // Nó encostando na plaqueta: prioridade continua SOBRE a linha, com o valor
    // preservado — degrada o formato em vez de sair do traço.
    const node: LinkV2NodeRect = { x: 190, y: 185, width: 22, height: 30 };
    const placements = resolveLinkV2LabelPlacements(
      [candidate({ id: 'a', priority: 2 })],
      [node],
      PILL_SIZES,
    );
    const placement = placements.get('a');
    expect(placement?.mode).not.toBe('hidden');
    expect(placement?.mode === 'small' || placement?.mode === 'compact').toBe(true);
    expect(placement?.dy).toBe(0);
  });
});
