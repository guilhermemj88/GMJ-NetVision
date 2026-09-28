import { describe, expect, it } from 'vitest';
import { freeChannelX, gapYBetween, routeSameRackLldp } from './physical-lldp-route';

/**
 * Medidas reais da RACK 01 (Vista Alegre) em coordenadas do canvas: F1A 1U
 * acima, S6750 3U no meio e 6730 3U abaixo.
 */
const f1a = { top: 89, height: 104 };
const s6750 = { top: 225, height: 130 };
const k6730 = { top: 387, height: 130 };

const base = {
  local: { x: 528, y: 143.5 },
  remote: { x: 165, y: 281.3 },
  localBox: f1a,
  remoteBox: s6750,
  localPorts: [],
  remotePorts: [],
  otherChassisBoxes: [k6730],
  riserX: 924,
  rackLeft: 62,
  rackRight: 922,
} as const;

describe('gapYBetween', () => {
  it('usa o meio do vão quando o par é empilhado (remoto abaixo)', () => {
    expect(gapYBetween(f1a, s6750)).toBe((89 + 104 + 225) / 2);
  });

  it('usa o meio do vão quando o remoto está acima', () => {
    expect(gapYBetween(k6730, s6750)).toBe((355 + 387) / 2);
  });
});

describe('freeChannelX', () => {
  it('mantém o próprio x da porta quando a coluna está livre', () => {
    expect(freeChannelX(528, 143.5, 209, [{ x: 165, y: 200 }])).toBe(528);
  });

  it('desloca o canal para o meio-vão quando outra porta está na mesma coluna', () => {
    // Coluna única: o canal vai para a lateral do bloco (2× a folga).
    expect(freeChannelX(528, 143.5, 209, [{ x: 528, y: 160 }])).toBe(504);
  });

  it('ignora portas da própria fileira (mesmo y da saída)', () => {
    expect(freeChannelX(528, 143.5, 209, [{ x: 512, y: 143.5 }])).toBe(528);
  });

  it('usa o meio-vão entre colunas vizinhas (painel denso)', () => {
    // Colunas da S6750 (29.7px): a porta remota está na coluna 461 e existe
    // outra porta na mesma coluna, uma fileira acima.
    const ports = [
      { x: 431.36, y: 281.28 },
      { x: 461.13, y: 281.28 },
      { x: 490.89, y: 281.28 },
    ];
    const channel = freeChannelX(461.22, 297.8, 203, ports);
    expect(channel).toBeCloseTo((461.13 + 490.89) / 2, 5);
    // O desvio continua curto: menos de meia coluna.
    expect(Math.abs(channel - 461.22)).toBeLessThan(15);
  });

  it('respeita os limites do rack ao escolher o canal', () => {
    const ports = [{ x: 528, y: 160 }];
    expect(freeChannelX(528, 143.5, 209, ports, { left: 62, right: 922 })).toBe(504);
    expect(freeChannelX(100, 143.5, 209, [{ x: 100, y: 160 }], { left: 130, right: 922 })).toBe(100);
  });
});

describe('routeSameRackLldp', () => {
  it('same-rack adjacente: stub, corredor no vão e stub de entrada', () => {
    const route = routeSameRackLldp({ ...base });

    // Corredor no meio do vão entre os dois chassis (193 → 225).
    expect(route.corridorY).toBe(209);
    // Stub local curto e vertical, corredor horizontal no vão, sem voltar pela lane.
    expect(route.trunk).toBe('M 528 143.5 V 209 H 165');
    expect(route.entry).toBe('M 165 209 V 281.3');
    // Nenhum x entra na faixa da CABLE LANE (938+).
    expect(Math.max(528, 165)).toBeLessThan(938);
  });

  it('badge fica no vão, entre as duas portas (nunca no extremo do rack)', () => {
    const route = routeSameRackLldp({ ...base });

    expect(route.badgeY).toBeGreaterThan(89 + 104 - 1);
    expect(route.badgeY).toBeLessThan(225 + 1);
    expect(route.badgeX).toBeGreaterThan(165);
    expect(route.badgeX).toBeLessThan(528);
  });

  it('escolhe o canal livre quando outra porta fica abaixo da porta local', () => {
    const route = routeSameRackLldp({ ...base, localPorts: [{ x: 528, y: 160 }] });

    expect(route.trunk).toBe('M 528 143.5 H 504 V 209 H 165');
  });

  it('com chassis no meio, sai pelo corredor lateral e entra pelo vão do remoto', () => {
    const route = routeSameRackLldp({
      ...base,
      local: { x: 528, y: 143.5 },
      remote: { x: 825, y: 459.8 },
      remoteBox: k6730,
      otherChassisBoxes: [s6750],
    });

    // Sai pelo vão abaixo da F1A, corre fora do rack e entra pelo vão acima do 6730.
    expect(route.trunk).toBe('M 528 143.5 V 209 H 924 V 371 H 825');
    expect(route.entry).toBe('M 825 371 V 459.8');
  });

  it('respeita os limites do rack ao posicionar o badge', () => {
    const route = routeSameRackLldp({
      ...base,
      local: { x: 900, y: 143.5 },
      remote: { x: 880, y: 281.3 },
    });

    expect(route.badgeX).toBeLessThanOrEqual(922 - 26 - 6);
  });
});
