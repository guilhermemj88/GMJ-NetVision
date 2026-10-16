import { describe, expect, it } from 'vitest';
import {
  LINK_V2_ATTENTION_PERCENT,
  LINK_V2_CAPACITY_TIERS,
  LINK_V2_CRITICAL_PERCENT,
  LINK_V2_STALE_AFTER_MS,
  LINK_V2_UNKNOWN_CAPACITY_WIDTH,
  formatCompactBps,
  linkV2CapacityTier,
  linkV2ShowsArrow,
  linkV2StateDescription,
  linkV2StrokeWidth,
  resolveLinkV2Visual,
  shouldShowLinkV2Label,
  type LinkV2Input,
  type LinkV2Visual,
} from './map-visual-v2';

const NOW = 1_800_000_000_000;

function input(overrides: Partial<LinkV2Input> = {}): LinkV2Input {
  return {
    operational: 'up',
    capacityBps: 40_000_000_000,
    aToB: { bps: 24_800_000_000, sampledAtMs: NOW - 30_000 },
    bToA: { bps: 9_600_000_000, sampledAtMs: NOW - 30_000 },
    ...overrides,
  };
}

function visual(overrides: Partial<LinkV2Input> = {}): LinkV2Visual {
  return resolveLinkV2Visual(input(overrides), { nowMs: NOW });
}

describe('faixas de utilização (V2)', () => {
  it('usa 50/80 como limites de atenção e crítico', () => {
    expect(LINK_V2_ATTENTION_PERCENT).toBe(50);
    expect(LINK_V2_CRITICAL_PERCENT).toBe(80);

    const below = resolveLinkV2Visual(
      input({
        capacityBps: 10_000_000_000,
        aToB: { bps: 4_900_000_000, sampledAtMs: NOW - 1_000 },
        bToA: { bps: 1_000_000_000, sampledAtMs: NOW - 1_000 },
      }),
      { nowMs: NOW },
    );
    expect(below.state).toBe('normal');
    expect(below.color).toBe('#43c59e');

    const atAttention = resolveLinkV2Visual(
      input({
        capacityBps: 10_000_000_000,
        aToB: { bps: 5_000_000_000, sampledAtMs: NOW - 1_000 },
        bToA: { bps: 1_000_000_000, sampledAtMs: NOW - 1_000 },
      }),
      { nowMs: NOW },
    );
    expect(atAttention.state).toBe('attention');
    expect(atAttention.color).toBe('#d9a24b');

    const atCritical = resolveLinkV2Visual(
      input({
        capacityBps: 10_000_000_000,
        aToB: { bps: 8_000_000_000, sampledAtMs: NOW - 1_000 },
        bToA: { bps: 1_000_000_000, sampledAtMs: NOW - 1_000 },
      }),
      { nowMs: NOW },
    );
    expect(atCritical.state).toBe('critical');
    expect(atCritical.color).toBe('#d25e61');
  });

  it('nunca soma os dois sentidos para classificar congestionamento', () => {
    // 45% + 45% = 90% se somados; cada sentido isolado fica abaixo de 50%.
    const result = visual({
      capacityBps: 10_000_000_000,
      aToB: { bps: 4_500_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 4_500_000_000, sampledAtMs: NOW - 1_000 },
    });
    expect(result.state).toBe('normal');
    expect(result.direction).toBe('balanced');
    expect(result.utilizationPercent).toBe(45);
  });
});

describe('prioridade dos estados', () => {
  it('DOWN operacional vence telemetria e utilização', () => {
    const result = visual({
      operational: 'down',
      aToB: { bps: 39_000_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 39_000_000_000, sampledAtMs: NOW - 1_000 },
    });
    expect(result.state).toBe('down');
    expect(result.reason).toBe('operational-down');
    expect(result.strokeDasharray).toBe('7 5');
    expect(linkV2ShowsArrow(result)).toBe(false);
    expect(result.labelText).toBe('DOWN');
  });

  it('sem amostra nenhuma vira SEM DADOS (cinza tracejado, nunca verde)', () => {
    const result = visual({
      aToB: { bps: null, sampledAtMs: null },
      bToA: { bps: null, sampledAtMs: null },
    });
    expect(result.state).toBe('no-data');
    expect(result.reason).toBe('no-samples');
    expect(result.color).toBe('#718894');
    expect(result.strokeDasharray).toBe('2 7');
    expect(result.labelText).toBe('sem telemetria');
  });

  it('capacidade desconhecida não usa classe conhecida e não calcula utilização', () => {
    const result = visual({
      capacityBps: null,
      aToB: { bps: 300_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: null, sampledAtMs: null },
    });
    expect(result.state).toBe('no-data');
    expect(result.reason).toBe('capacity-unknown');
    expect(result.utilizationPercent).toBeNull();
    expect(result.labelText).toBe('sem capacidade');
    expect(linkV2StrokeWidth(null)).toBe(LINK_V2_UNKNOWN_CAPACITY_WIDTH);
    expect(LINK_V2_CAPACITY_TIERS.some((tier) => tier.width === LINK_V2_UNKNOWN_CAPACITY_WIDTH)).toBe(
      false,
    );
  });

  it('amostra só desatualizada vira STALE, com indicação de dados antigos', () => {
    const age = LINK_V2_STALE_AFTER_MS + 1;
    const result = visual({
      aToB: { bps: 24_800_000_000, sampledAtMs: NOW - age },
      bToA: { bps: 9_600_000_000, sampledAtMs: NOW - age },
    });
    expect(result.state).toBe('stale');
    expect(result.color).toBe('#8a9fb0');
    expect(result.labelText).toContain('antigo');
    expect(linkV2ShowsArrow(result)).toBe(false);
  });

  it('na borda de três ciclos a amostra ainda não é stale', () => {
    const result = visual({
      aToB: { bps: 24_800_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS },
      bToA: { bps: 9_600_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS },
    });
    expect(result.state).toBe('attention');
    expect(result.stale).toBe(false);
  });

  it('inconsistência declarada ou acima da capacidade não finge normalidade', () => {
    const declared = visual({ inconsistent: true });
    expect(declared.state).toBe('inconsistent');
    expect(declared.reason).toBe('declared-inconsistent');

    const overCapacity = resolveLinkV2Visual(
      input({
        capacityBps: 10_000_000_000,
        aToB: { bps: 12_000_000_000, sampledAtMs: NOW - 1_000 },
        bToA: { bps: null, sampledAtMs: null },
      }),
      { nowMs: NOW },
    );
    expect(overCapacity.state).toBe('inconsistent');
    expect(overCapacity.reason).toBe('over-capacity');
    expect(overCapacity.labelText).toContain('inconsistente');

    const unknownOperational = visual({ operational: 'unknown' });
    expect(unknownOperational.state).toBe('inconsistent');
    expect(unknownOperational.reason).toBe('operational-unknown');
    expect(unknownOperational.utilizationPercent).toBe(62);
    expect(unknownOperational.labelText).toContain('parcial');
  });
});

describe('sentido dominante e avaliação parcial', () => {
  it('aponta o sentido de maior utilização', () => {
    const aToB = visual();
    expect(aToB.direction).toBe('a2b');
    expect(aToB.dominantBps).toBe(24_800_000_000);
    expect(aToB.labelText).toBe('25G · 62%');
    expect(linkV2ShowsArrow(aToB)).toBe(true);

    const bToA = visual({
      aToB: { bps: 4_000_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 37_600_000_000, sampledAtMs: NOW - 1_000 },
    });
    expect(bToA.direction).toBe('b2a');
    expect(bToA.labelText).toBe('38G · 94%');
  });

  it('equilibrado dentro da tolerância não inventa direção', () => {
    const result = visual({
      aToB: { bps: 24_000_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 25_000_000_000, sampledAtMs: NOW - 1_000 },
    });
    expect(result.direction).toBe('balanced');
    expect(linkV2ShowsArrow(result)).toBe(false);
    expect(result.labelText).not.toContain('parcial');
  });

  it('um sentido sem dados marca avaliação parcial sem esconder a falha', () => {
    const result = visual({
      aToB: { bps: 24_800_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: null, sampledAtMs: null },
    });
    expect(result.partial).toBe(true);
    expect(result.state).toBe('attention');
    expect(result.direction).toBe('a2b');
    expect(result.labelText).toBe('25G · 62% · parcial');
    expect(linkV2ShowsArrow(result)).toBe(true);
  });

  it('um sentido desatualizado e outro fresco avalia pelo fresco, marcando parcial', () => {
    const result = visual({
      aToB: { bps: 24_800_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 9_600_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS - 60_000 },
    });
    expect(result.partial).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.state).toBe('attention');
    expect(result.labelText).toContain('parcial');
  });
});

describe('espessura por capacidade', () => {
  it('usa os degraus 1.2 / 2.0 / 3.0 / 4.5', () => {
    expect(linkV2StrokeWidth(1_000_000_000)).toBe(1.2);
    expect(linkV2StrokeWidth(10_000_000_000)).toBe(2.0);
    expect(linkV2StrokeWidth(25_000_000_000)).toBe(3.0);
    expect(linkV2StrokeWidth(40_000_000_000)).toBe(3.0);
    expect(linkV2StrokeWidth(100_000_000_000)).toBe(4.5);
  });

  it('rotula a faixa para o detalhe/tooltip', () => {
    expect(linkV2CapacityTier(1_000_000_000)?.label).toBe('até 1 Gbps');
    expect(linkV2CapacityTier(10_000_000_000)?.label).toBe('1–10 Gbps');
    expect(linkV2CapacityTier(40_000_000_000)?.label).toBe('10–40 Gbps');
    expect(linkV2CapacityTier(100_000_000_000)?.label).toBe('acima de 40 Gbps');
    expect(linkV2CapacityTier(null)).toBeNull();
  });
});

describe('formato compacto do rótulo', () => {
  it('imprime 25G / 94G / 1.5G / 620M', () => {
    expect(formatCompactBps(25_000_000_000)).toBe('25G');
    expect(formatCompactBps(94_000_000_000)).toBe('94G');
    expect(formatCompactBps(1_500_000_000)).toBe('1.5G');
    expect(formatCompactBps(620_000_000)).toBe('620M');
    expect(formatCompactBps(0)).toBe('0');
    expect(formatCompactBps(null)).toBe('—');
  });
});

describe('política de rótulo inteligente', () => {
  const hiddenContext = {
    showAll: false,
    selected: false,
    hovered: false,
    adjacentToSelectedNode: false,
  };

  it('esconde enlace saudável abaixo de 50%', () => {
    const result = visual({
      capacityBps: 10_000_000_000,
      aToB: { bps: 1_000_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 500_000_000, sampledAtMs: NOW - 1_000 },
    });
    expect(result.state).toBe('normal');
    expect(shouldShowLinkV2Label(result, hiddenContext)).toBe(false);
  });

  it('mostra em >=50%, DOWN, sem telemetria, stale e alarme', () => {
    expect(shouldShowLinkV2Label(visual(), hiddenContext)).toBe(true);
    expect(
      shouldShowLinkV2Label(
        visual({ operational: 'down', aToB: { bps: null, sampledAtMs: null }, bToA: { bps: null, sampledAtMs: null } }),
        hiddenContext,
      ),
    ).toBe(true);
    expect(
      shouldShowLinkV2Label(
        visual({ aToB: { bps: null, sampledAtMs: null }, bToA: { bps: null, sampledAtMs: null } }),
        hiddenContext,
      ),
    ).toBe(true);
    expect(
      shouldShowLinkV2Label(
        visual({
          aToB: { bps: 1_000_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS - 1 },
          bToA: { bps: 500_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS - 1 },
        }),
        hiddenContext,
      ),
    ).toBe(true);
    expect(
      shouldShowLinkV2Label(
        visual({
          capacityBps: 10_000_000_000,
          aToB: { bps: 1_000_000_000, sampledAtMs: NOW - 1_000 },
          bToA: { bps: 500_000_000, sampledAtMs: NOW - 1_000 },
          alarms: 1,
        }),
        hiddenContext,
      ),
    ).toBe(true);
  });

  it('seleção, hover, nó selecionado e "todos os rótulos" forçam exibição', () => {
    const healthy = visual({
      capacityBps: 10_000_000_000,
      aToB: { bps: 1_000_000_000, sampledAtMs: NOW - 1_000 },
      bToA: { bps: 500_000_000, sampledAtMs: NOW - 1_000 },
    });
    expect(shouldShowLinkV2Label(healthy, { ...hiddenContext, selected: true })).toBe(true);
    expect(shouldShowLinkV2Label(healthy, { ...hiddenContext, hovered: true })).toBe(true);
    expect(shouldShowLinkV2Label(healthy, { ...hiddenContext, adjacentToSelectedNode: true })).toBe(
      true,
    );
    expect(shouldShowLinkV2Label(healthy, { ...hiddenContext, showAll: true })).toBe(true);
  });
});

describe('descrição do estado (tooltip)', () => {
  it('explica cada família de estado', () => {
    expect(linkV2StateDescription(visual())).toContain('Utilização válida');
    expect(linkV2StateDescription(visual({ operational: 'down' }))).toContain('DOWN');
    expect(
      linkV2StateDescription(visual({ aToB: { bps: null, sampledAtMs: null }, bToA: { bps: null, sampledAtMs: null } })),
    ).toContain('Sem telemetria');
    expect(linkV2StateDescription(visual({ capacityBps: null }))).toContain('Capacidade não declarada');
    expect(
      linkV2StateDescription(
        visual({
          aToB: { bps: 24_800_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS - 1 },
          bToA: { bps: 9_600_000_000, sampledAtMs: NOW - LINK_V2_STALE_AFTER_MS - 1 },
        }),
      ),
    ).toContain('desatualizada');
  });
});
